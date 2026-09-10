# Server-Fork: `categoryid`-Feld für IHateMoney

**Umgesetzt und verifiziert** (2026-09-08) — nicht mehr nur Spezifikation. Optionale Ausbaustufe:
das Plugin funktioniert vollständig ohne diesen Fork (Vault-Datei-Sync, siehe `docs/konzept.md`
Abschnitt 4); der Fork bringt einen zusätzlichen Nutzen: die Kategorie wird für ANDERE IHM-Clients
sichtbar (MoneyBuster, Cospend-Web) UND direkt im IHM-eigenen Web-UI anzeig-/editierbar
(Beleg-Formular-Dropdown + Spalte in der Belegliste), nicht nur für dieses Plugin.

## Dateien hier

- `ihm-categoryid.patch` — Unified Diff gegen den IHateMoney-Upstream-Commit
  `e66a7672e8e5c41549bf53c4a824c72c43ab9079` (main-Branch, "Back to development: 7.2.2").
  Ändert `ihatemoney/models.py`, `ihatemoney/forms.py`, `ihatemoney/templates/forms.html`,
  `ihatemoney/templates/list_bills.html`, `ihatemoney/tests/api_test.py` (bestehende Tests an das
  neue Feld angepasst) und legt eine neue Alembic-Migration an
  (`migrations/versions/a1c0bd2e3f77_add_bill_category_id.py`).
- `Dockerfile` — klont den gepinnten Upstream-Commit, wendet den Patch an, baut danach identisch
  zum offiziellen `ihatemoney/Dockerfile`.
- `docker-compose.yml` (im Plugin-Root, nicht hier) — startet Stock-IHM UND Fork-IHM parallel für
  lokale Tests, siehe `docs/todos.md`.

## Warum `categoryid` (Integer, kein `category`-String)

Verifiziert gegen den MoneyBuster-Quellcode
(`VersatileProjectSyncClient.java`, `createRemoteBill`/`editRemoteBill`): MoneyBuster sendet beim
Anlegen/Ändern EINER Bill — unabhängig ob Cospend- oder IHM-Projekt — bereits heute die Formularfelder
`categoryid` und `paymentmodeid` (lowercase, kein CamelCase — das ist nur für Cospend-Instanzen
≥1.6.1 anders). Stock-IHM ignoriert diese unbekannten Felder klaglos; der Fork nimmt sie entgegen.
Feldname und Datentyp sind also nicht frei gewählt, sondern exakt das, was der real existierende
Android-Client bereits über den Wire schickt — daher **Integer**, nicht String:

- **Negative IDs** = Nextcloud Cospends fest im Client verdrahtete globale Standardkategorien,
  verifiziert gegen `cospend-nc` Migration `Version000406Date20200426154317.php`:
  `-1` Grocery 🛒, `-2` Bar/Party 🎉, `-3` Rent 🏠, `-4` Bill 🌩, `-5` Excursion/Culture 🚸,
  `-6` Health 💚, `-10` Shopping 🛍, `-12` Restaurant 🍴, `-13` Accommodation 🛌, `-14` Transport 🚌,
  `-15` Sport 🎾. MoneyBuster zeigt für diese IDs Icon+Name **ohne** eigenen Categories-Endpoint auf
  IHM-Seite — kostenlose Kompatibilität.
- **Positive IDs** sind für künftige projekteigene Kategorien reserviert. Dieser Patch legt dafür
  (noch) keinen Categories-Endpoint an — der Klassifikator/das Kategorie-Mapping dieses Plugins
  bleibt die primäre Quelle (`sync/category-store.ts`), `categoryid` ist der Kompatibilitäts-Export
  davon (siehe `src/categorize/cospend-category-map.ts` fürs Mapping lokale Kategorie ↔ Cospend-id).
- **`null`** = Server unterstützt das Feld, Bill ist (noch) unklassifiziert.

## Was genau geändert wurde

1. **Migration** `a1c0bd2e3f77_add_bill_category_id.py`: `bill.category_id` + `bill_version.category_id`
   (SQLAlchemy-Continuum-Schattentabelle), beide `INTEGER NULL`. Läuft automatisch beim
   Container-Start (`ihatemoney/run.py` ruft `upgrade(migrations_path)` bei jedem App-Boot auf —
   kein manueller `flask db upgrade`-Schritt nötig).
2. **Model** (`models.py`): `Bill.category_id` Spalte + Konstruktor-Parameter; `_to_serialize` liefert
   den Wert unter dem JSON-Key **`categoryid`** (bewusst ohne Unterstrich — das ist der Wire-Name).
3. **Form** (`forms.py`, `BillForm`): neues Feld `categoryid = SelectField(..., choices=CATEGORYID_CHOICES,
   coerce=lambda v: int(v) if v not in (None, "") else None, validators=[Optional()])` — der
   Python-Attributname ist absichtlich identisch zum WTForms-Formular-Key, damit
   `request.form["categoryid"]`/JSON-Body-Key `categoryid` ohne Umbenennung ankommt. In `export()`/
   `save()`/`fill()` verdrahtet. `CATEGORYID_CHOICES` sind die 10 negativen Cospend-Global-IDs (siehe
   unten) + eine Leer-Option "Unclassified" (`""` → `None`) — gehalten synchron mit
   `src/categorize/cospend-category-map.ts`.
4. **Web-UI** (`templates/forms.html`, `templates/list_bills.html`): das Feld ist jetzt auch als
   sichtbares Dropdown im Beleg-Anlegen/Bearbeiten-Formular nutzbar (`add_bill`-Makro, direkt nach
   dem "Für wen?"-Block, nicht unter "More options" versteckt — soll leicht auffindbar sein) und die
   Belegliste zeigt Icon+Name der gewählten Kategorie als eigene Spalte (`list_bills.html`, Lookup
   über ein templateeigenes `COSPEND_CATEGORIES`-Dict, kein Python-Helper/Endpoint nötig für reines
   Anzeigen). Damit ist das Feld über drei Wege nutzbar: JSON-API (dieses Plugin), Web-UI (Browser),
   und implizit MoneyBuster/Cospend-Web (die senden `categoryid` bereits ungefragt).

## Verifikation (2026-09-08, gegen echten Flask-Stack, nicht nur Unit-Tests)

- Vollständige Upstream-Testsuite läuft grün gegen den Patch: **146 passed, 5 skipped** (identisch
  zum unveränderten Stand, keine Regression).
- Migration real via `upgrade()` (nicht `create_all()`) gegen frische SQLite-DB gefahren — Spalte
  landet korrekt in `bill` UND `bill_version`.
- Bill-Erstellung per JSON-Body (`Content-Type: application/json`, wie `IhateMoneyClient` in diesem
  Plugin sendet) inkl. `categoryid: -1` gegen den echten Flask-Request-Stack getestet: Server
  antwortet 201, `GET /bills/<id>` liefert `"categoryid": -1` zurück. Bill ohne `categoryid`-Feld im
  Body → Server antwortet 201, `categoryid` ist `null` (kein Pflichtfeld, kein Crash).
- Web-UI zweifach verifiziert (2026-09-08):
  1. Vier Ad-hoc-Funktionstests gegen den Flask-Test-Client (nicht Teil der dauerhaften Testsuite,
     redundant zur `api_test.py`-Abdeckung oben — nur zum Nachweis, dass die Template-Änderung nicht
     bricht): `/raclette/add` rendert das `categoryid`-`<select>` inkl. "🛒 Grocery"-Option · Beleg mit
     `categoryid=-1` über das Web-Formular angelegt → `Bill.category_id == -1` UND die Belegliste zeigt
     "🛒 Grocery" in der neuen Kategorie-Spalte · Beleg ohne Kategorie → `category_id is None` · `edit`
     preselektiert die Kategorie im Dropdown.
  2. Zusätzlich end-to-end gegen den echten, per `docker-compose.yml` laufenden `ihm-fork`-Container
     (Port 18001, Image neu gebaut nach diesem Patch-Update): Login-Session per Curl (CSRF-Token aus
     der Login-Seite, dann aus der Add-Bill-Seite, jeweils frisch geholt — Flask-WTF-CSRF ist an die
     Session gebunden), Beleg über das echte `POST /smoketest/add`-Formular mit `categoryid=-3`
     angelegt → 302-Redirect (Erfolg), Belegliste zeigt die neue Zeile mit Spalte "🏠 Rent",
     `/smoketest/edit/<id>` zeigt `<option selected value="-3">`. Test-Projekt danach wieder gelöscht.

## Client-seitige Anbindung — implementiert

- `IhateMoneyClient.probeNativeCategorySupport()` prüft Key-**Präsenz** (`'categoryid' in bill`),
  nicht Werttyp — sonst würde ein erster Bill mit `categoryid: null` fälschlich als
  "nicht unterstützt" gewertet.
- `fetchBills()` befüllt `IhmBill.nativeCategoryId` (`number | null | undefined` — `undefined` wenn
  der Server das Feld gar nicht liefert).
- `createBill()`/`updateBill()` senden `categoryid` nur, wenn der Aufrufer `nativeCategoryId`
  explizit setzt (inkl. `null` zum Zurücksetzen) — sonst wird der Key ganz weggelassen.
- `view/ihm-view.ts` `correctCategory()`: bei `project.nativeCategorySupport` wird nach dem
  lokalen Vault-Save zusätzlich ein `updateBill()` mit dem via
  `categorize/cospend-category-map.ts` gemappten `categoryid` gepusht (best effort, Fehler dabei
  blockiert die UI nicht — das Vault-Mapping bleibt so oder so die primäre, verlässliche Quelle).

## Rebase auf neueres IHM-Upstream

1. `IHATEMONEY_REF` im `Dockerfile` auf den neuen Ziel-Commit setzen.
2. `git apply --check ihm-categoryid.patch` gegen den neuen Checkout probieren.
3. Bei Konflikt: Patch manuell nachziehen (die vier Änderungsorte oben), Testsuite laufen lassen,
   neuen Diff exportieren, `ihm-categoryid.patch` ersetzen.

## Maintenance-Warnung

IHateMoney ist laut Maintainern im "Maintenance Mode". Ein Fork muss bei jedem Upstream-Update
manuell neu gepatcht werden (Migration-Kette, Model-Drift). Kein CI/Automatismus dafür in diesem
Repo — reine Handarbeit bei Bedarf, siehe Rebase-Schritte oben.
