# IHM Tracker

An [Obsidian](https://obsidian.md) plugin for [IHateMoney](https://ihatemoney.org) — view and
edit shared-expense bills, auto-categorize them, and get statistics/exports, without leaving your
vault.

IHateMoney itself has no category field for bills (this has been an
[open upstream request since 2011](https://github.com/spiral-project/ihatemoney/issues/55)). This
plugin solves that client-side: it classifies bills automatically from their title (keyword/fuzzy
matching, trainable), and stores the category mapping as a plain JSON file inside your vault —
which means it syncs across your devices for free, using whatever sync you already use for
Obsidian (Obsidian Sync, iCloud, Syncthing, Git, ...). No account, no extra server.

> **Beta.** Expect bugs. Please report them via [GitHub Issues](../../issues). Provided as-is,
> without warranty or liability.

## Features

- **Bills** — list, create, edit, delete bills against any IHateMoney project (or a
  self-hosted [Nextcloud Cospend](https://apps.nextcloud.com/apps/cospend) project, or a fully
  local vault-only project with no server at all)
- **Auto-categorization** — classifies bills from their title, learns from your corrections,
  fully custom categories (label + emoji) per project. The built-in keyword list is tuned for
  German-speaking households (shop names) plus generic English terms; training from your own
  corrections works for any language
- **Cross-device category sync** — the category mapping lives in your vault, not in
  `.obsidian/`'s plugin storage, so it rides along with your normal Obsidian sync
- **Statistics** — overview (totals/trend/monthly), by category, by person (paid vs. share vs.
  net balance), a person × month pivot table, and a settle-up view (who owes whom, ported from
  IHateMoney's own internal debt-settling algorithm)
- **Export** — PDF and Excel export, filtered or full, saved into your vault
- **Responsive UI** — single-column on phones, master-detail split on tablets/desktop panes
- **Home screen shortcut** — register an `obsidian://ihm-tracker-open?...` deep link to jump
  straight into a project from an iOS Shortcut / Android shortcut icon
- Works on desktop **and mobile** (`isDesktopOnly: false`) — no Node-only APIs, all network
  access goes through Obsidian's own `requestUrl()`
- UI in English; numbers, currency and dates follow your system locale

## Installing

Install via Obsidian Community Plugins, or manually:

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](../../releases/latest)
2. Create a folder `<your-vault>/.obsidian/plugins/ihm-tracker/` and put the three files in it
3. Reload Obsidian and enable "IHM Tracker" in Settings → Community plugins

## Getting started

1. Open Settings → IHM Tracker → add a project
2. Pick a backend:
   - **IHateMoney** — server URL, project slug, project password (the same ones you'd use to log
     into the IHateMoney web UI)
   - **Cospend** — log in to your Nextcloud via the in-app browser flow, then pick/create a
     Cospend project
   - **Local** — no server; bills and members live entirely in a vault file
3. Open the IHM Tracker view (ribbon icon or command palette) and hit sync

Categories are inferred automatically from bill titles; correcting one trains the classifier for
next time. Nothing here is sent anywhere except your configured backend.

## Server fork (optional)

IHateMoney's stock server has no native category field at all — this plugin's vault-file sync
(above) works fully without it. If you self-host IHateMoney, there's an optional server patch
that adds a native `categoryid` field, wire-compatible with what MoneyBuster/Cospend clients
already send: your category then also shows up in IHateMoney's own web UI and in other IHM
clients, not just this plugin.

See [`server-patch/`](server-patch/) for the patch, a Dockerfile, and full verification notes.
An applied branch (patched against a pinned upstream commit, full upstream test suite still
green) is published at
[modularidea/ihatemoney-cat, branch `feat/categoryid`](https://github.com/modularidea/ihatemoney-cat/tree/feat/categoryid).

## Development

```bash
npm install
npm run dev      # esbuild watch
npm run build    # typecheck + production build
npm test         # vitest
```

Symlink this folder into a test vault's `.obsidian/plugins/ihm-tracker/`, run `npm run dev`, and
reload the plugin in Obsidian (Cmd+R or the plugin-reload command) to see changes live.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the project structure and module ownership rules.

## License

[0BSD](LICENSE) — do whatever you want with it.
