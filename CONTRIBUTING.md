# Contributing

## Project structure

```
src/
  main.ts               entry point (onload/onunload, view registration)
  settings.ts            settings tab, project list, data.json schema
  types.ts               domain model (IhmBill, BillCategoryDef, ProjectCategoryData, ...)
  ihm-api/client.ts      IHateMoney REST client (requestUrl-based, implements ExpenseClient)
  backend/               ExpenseClient interface + IHateMoney/Cospend/local implementations + factory
  categorize/            title -> category classifier (exact/fuzzy/keyword matching)
  sync/category-store.ts vault-file persistence + merge (the multi-device sync strategy)
  stats/aggregate.ts     pure aggregation helpers (byMonth/byCategory/pivot/computeShares)
  export/                PDF/Excel export, saved into the vault
  view/                  UI (ItemView, tabs, bill form, stats tabs, export panel)
server-patch/            optional IHateMoney server fork (native category field) — patch +
                          Dockerfile + verification notes, not required to use the plugin
```

## Module ownership

- `src/ihm-api/` — the IHateMoney REST client only (implements `ExpenseClient`), no UI code
- `src/backend/` — backend abstraction: `expense-client.ts` (interface), `create-client.ts`
  (factory keyed on `IhmProjectConfig.backendType`), `cospend-client.ts`/`cospend-login.ts`,
  `local-client.ts`. Callers use `createExpenseClient()` only — never instantiate a concrete
  client directly (the integration test is the deliberate exception)
- `src/categorize/` — pure text classification, no Obsidian API dependency
- `src/sync/` — vault-file persistence + merge logic
- `src/stats/` — pure aggregation functions, no DOM
- `src/export/` — PDF/Excel, no Obsidian view code
- `src/view/` — UI/DOM, calls into the other modules, contains no domain logic itself

## Conventions

- TypeScript strict mode, no `any`
- No Node-only APIs (`fs`, `path`, `Buffer`, ...) — only the Obsidian vault API and
  `requestUrl()`; the plugin is `isDesktopOnly: false` and must run on iOS/Android
- Comments explain *why*, not *what*
- Tests for pure-logic modules (`categorize/`, `stats/`, `sync/category-store.ts` merge logic) —
  no Obsidian mocking needed there
- Never log or persist a project's server URL/password outside `settings.ts`/`data.json`;
  `sync/category-store.ts` files are vault files meant to be shared/synced/versioned and must
  never contain credentials

## Workflow

```bash
npm install
npm run dev      # esbuild watch
npm run build    # tsc -noEmit + esbuild production
npm test         # vitest run
```

Before opening a PR: `npm run build` and `npm test` must be green. For UI changes, please
describe what you tested manually (screenshots/GIFs appreciated) — there's no automated UI test
harness here.

## Server fork

`server-patch/` is a patch against IHateMoney upstream (not a submodule/subtree) that adds a
native `categoryid` field. If you want to change it, edit the four touched files against a fresh
upstream checkout, re-run IHateMoney's own test suite, and re-export the diff — see
`server-patch/README.md` for the exact rebase steps.
