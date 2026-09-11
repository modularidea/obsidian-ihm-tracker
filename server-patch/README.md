# Server fork: IHateMoney with categories, payment methods and repeating bills

Optional. The plugin works fully without it (categories live in a vault file). With the fork,
categories, payment methods and repeating bills are stored on the server and shared with every
client of the project — this plugin on all devices, the IHM web UI, MoneyBuster.

The fork lives at **[modularidea/ihatemoney-cat, branch `feat/categoryid`](https://github.com/modularidea/ihatemoney-cat/tree/feat/categoryid)**
— that repo is the source of truth (models, migrations, API, web UI, tests). Its README lists
every endpoint and field.

## What the plugin uses

| Fork feature | Plugin |
|---|---|
| `categoryid` on bills (negative = Cospend global ids, positive = project categories) | category push/pull on every sync; a category set by another user becomes training data locally |
| `/categories` CRUD | custom categories are created on the server automatically on first use |
| `paymentmodeid` + `/paymentmodes` | "Payment method" field in the bill form (manage the list in the fork's web UI) |
| `repeat*` fields | "Repeat" rule in the bill form; the server creates the copies |
| `features` in the project info | detection — nothing to configure, the plugin adapts after the first sync |
| `/settle` | available in the client, the settle tab still uses the local port of the same algorithm |

## Running it

- **Docker (this repo)**: `docker-compose.yml` builds the `ihm-fork` service from a sibling
  checkout at `../../ihatemoney-cat` (developer setup, port 18001).
- **Docker without a checkout**: `Dockerfile` in this folder clones the fork branch and builds
  it like the official `ihatemoney/Dockerfile`:
  `docker build -t ihatemoney-cat server-patch/` then run it with the usual IHM environment
  variables (see the fork's `docker-compose.fork.yml`).
- Migrations run automatically on container start; an existing IHateMoney database is upgraded
  in place.

## Limits

- MoneyBuster shows the negative (global) category ids for IHM projects, not the project's own
  positive ones — those are visible in the plugin and the web UI only.
- Repeating bills are materialized when bills are listed (API or web UI). Run
  `flask --app ihatemoney.wsgi repeat-bills` from cron if nobody opens the project for a while.
- IHateMoney upstream is in maintenance mode; rebasing the fork on a newer upstream is manual
  work (see the fork README).
