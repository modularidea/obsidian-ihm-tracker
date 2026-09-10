# Server fork: native `categoryid` field for IHateMoney

Optional. The plugin works fully without it (categories live in a vault file, see the main
README). With the patched server the category also becomes visible to other IHM clients
(MoneyBuster, Cospend web) and editable in IHateMoney's own web UI.

An applied branch is published at
[modularidea/ihatemoney-cat, branch `feat/categoryid`](https://github.com/modularidea/ihatemoney-cat/tree/feat/categoryid).

## Files

- `ihm-categoryid.patch` — unified diff against upstream commit
  `e66a7672e8e5c41549bf53c4a824c72c43ab9079` ("Back to development: 7.2.2"). Touches
  `ihatemoney/models.py`, `ihatemoney/forms.py`, `ihatemoney/templates/forms.html`,
  `ihatemoney/templates/list_bills.html`, `ihatemoney/tests/api_test.py` and adds the Alembic
  migration `migrations/versions/a1c0bd2e3f77_add_bill_category_id.py`.
- `Dockerfile` — clones the pinned upstream commit, applies the patch, builds like the official
  `ihatemoney/Dockerfile`.
- `../docker-compose.yml` — runs stock IHM (port 18000) and the fork (18001) side by side.

## Why `categoryid` (integer, not a `category` string)

MoneyBuster already sends the form fields `categoryid` and `paymentmodeid` on every bill
create/update, for Cospend and IHM projects alike (see `VersatileProjectSyncClient.java`). Stock
IHM silently ignores unknown fields; the fork accepts them. So the field name and type are
dictated by the existing Android client, not chosen freely:

- **Negative ids** = Cospend's built-in global categories (hard-wired in Cospend and MoneyBuster,
  see cospend-nc migration `Version000406Date20200426154317.php`): `-1` Grocery, `-2` Bar/Party,
  `-3` Rent, `-4` Bill, `-5` Excursion/Culture, `-6` Health, `-10` Shopping, `-12` Restaurant,
  `-13` Accommodation, `-14` Transport, `-15` Sport. MoneyBuster shows name+icon for these
  without any categories endpoint.
- **Positive ids** are reserved for project-owned categories; this patch adds no categories
  endpoint for them. The plugin's vault mapping stays the primary source, `categoryid` is the
  compatibility export (`src/categorize/cospend-category-map.ts`).
- **`null`** = server supports the field, bill is unclassified.

## What the patch changes

1. **Migration**: `bill.category_id` and `bill_version.category_id` (SQLAlchemy-Continuum shadow
   table), both `INTEGER NULL`. Runs automatically on container start (`run.py` calls
   `upgrade()` on boot).
2. **Model**: `Bill.category_id` column + constructor parameter; serialized under the JSON key
   `categoryid` (the wire name, no underscore).
3. **Form** (`BillForm`): `categoryid = SelectField(...)` with the 10 global categories plus an
   empty "Unclassified" option (`""` → `None`), wired into `export()`/`save()`/`fill()`. The
   attribute name equals the form key so `request.form["categoryid"]` / a JSON body key
   `categoryid` arrive without renaming.
4. **Web UI**: category dropdown in the add/edit bill form (right after "For whom?") and an
   icon+name column in the bill list.

## Verification

- Full upstream test suite green against the patch: 146 passed, 5 skipped (same as unpatched).
- Migration run via `upgrade()` (not `create_all()`) against a fresh SQLite DB — column lands in
  `bill` and `bill_version`.
- JSON create with `categoryid: -1` → 201, `GET /bills/<id>` returns `"categoryid": -1`; create
  without the field → 201, `categoryid` is `null`.
- Web UI end-to-end against the running `ihm-fork` container: bill created through the real
  form with `categoryid=-3`, list shows "🏠 Rent", edit form pre-selects `-3`.

## Plugin side

- `probeNativeCategorySupport()` checks key **presence** (`'categoryid' in bill`), not the
  value — `null` is valid on a fork server.
- `fetchBills()` fills `IhmBill.nativeCategoryId` (`undefined` when the server lacks the field).
- `createBill()`/`updateBill()` only send `categoryid` when the caller sets `nativeCategoryId`
  (including `null` to clear).
- The view pushes an `updateBill()` with the mapped `categoryid` after each local category
  change when `nativeCategorySupport` is set (best effort; the vault mapping stays primary).

## Rebasing onto a newer upstream

1. Set `IHATEMONEY_REF` in the `Dockerfile` to the new target commit.
2. `git apply --check ihm-categoryid.patch` against the new checkout.
3. On conflict: re-apply the four change sites by hand, run the upstream test suite, re-export
   the diff, replace `ihm-categoryid.patch`.

IHateMoney is in maintenance mode; every upstream update means re-patching by hand.
