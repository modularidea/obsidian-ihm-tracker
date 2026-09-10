import { Plugin, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, IhmTrackerSettings, IhmTrackerSettingTab } from './settings';
import { CategoryStore } from './sync/category-store';
import { IHM_VIEW_TYPE, IhmView, MainTab } from './view/ihm-view';

export default class IhmTrackerPlugin extends Plugin {
	settings!: IhmTrackerSettings;
	categoryStore!: CategoryStore;

	async onload() {
		await this.loadSettings();
		this.categoryStore = new CategoryStore(this.app, this.settings.categoryStoreFolder);

		this.registerView(IHM_VIEW_TYPE, (leaf) => new IhmView(leaf, this));

		this.addRibbonIcon('euro', 'IHM Tracker öffnen', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open',
			name: 'Öffnen',
			callback: () => {
				void this.activateView();
			},
		});

		this.addSettingTab(new IhmTrackerSettingTab(this.app, this));

		// Home-Screen-Icon per Deeplink (Nutzerwunsch 2026-09-10): Obsidian-
		// Plugins können selbst kein eigenes Homescreen-Icon auf iOS/Android
		// erzeugen (kein API-Zugriff auf den Homescreen aus der Sandbox) — aber
		// eine vom Nutzer selbst angelegte Verknüpfung (iOS Kurzbefehle-App
		// "URL öffnen" + "Zum Home-Bildschirm", Android z.B. über eine
		// Shortcut-App) mit eigenem Icon KANN diese URI aufrufen und damit
		// direkt in ein bestimmtes IHM-Projekt springen:
		// `obsidian://ihm-tracker-open?vault=<Vault>&project=<Slug-oder-Name>&tab=bills|stats`
		// `project`/`tab` sind optional — ohne sie öffnet sich nur die View wie
		// über Ribbon-Icon/Command.
		this.registerObsidianProtocolHandler('ihm-tracker-open', async (params) => {
			const view = await this.activateView();
			if (!view) return;
			const tab: MainTab | undefined = params.tab === 'stats' || params.tab === 'bills' ? params.tab : undefined;
			if (params.project) view.openProjectBySlug(params.project, tab);
		});
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<IhmTrackerSettings>);

		// Migration: Projekte von VOR Phase 20 (2026-09-10, Backend-Abstraktion)
		// haben kein `backendType`-Feld (existierte damals noch nicht). Kritischer
		// Bug, gemeldet 2026-09-10 — `backendType` ist ein REQUIRED Feld
		// (`IhmProjectConfig.backendType: ProjectBackendType`), aber `=== 'ihatemoney'`-
		// Vergleiche an mehreren Stellen (settings.ts UI-Anzeige,
		// `sync/category-store.ts`s `isForkCompatible`-Parameter, `resolveNativeCategoryId()`)
		// werten `undefined` als FALSE — mit einer Kaskade an Folgefehlern: Settings
		// zeigte ein bestehendes IHM-Fork-Projekt fälschlich als "Lokal" an (nur
		// `createExpenseClient()`s `default:`-Fall rettete den eigentlichen
		// Sync — Titel-/Beleg-Sync lief deshalb trotzdem), UND `CategoryStore.load()`
		// sanitisierte (nullte) die negativen Default-`nativeCategoryId`-Werte für
		// diese Projekte bei JEDEM Laden, weil `isForkCompatible` fälschlich `false`
		// war — dadurch fand weder der Kategorie-Pull (Server→Plugin) noch der Push
		// (Plugin→Server) mehr eine gültige Zuordnung. Fix: alte Projekte ohne
		// `backendType` bekommen jetzt explizit `'ihatemoney'` (die einzige Option
		// vor Phase 20) EINMALIG beim Laden nachgetragen und sofort persistiert.
		let migrated = false;
		for (const project of this.settings.projects) {
			if (!project.backendType) {
				project.backendType = 'ihatemoney';
				migrated = true;
			}
		}
		if (migrated) await this.saveData(this.settings);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// categoryStoreFolder kann sich geändert haben -> Store neu binden,
		// damit ein bereits offener View sofort den neuen Pfad nutzt.
		this.categoryStore = new CategoryStore(this.app, this.settings.categoryStoreFolder);
	}

	private async activateView(): Promise<IhmView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(IHM_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			// `'tab'` (Settings, Nutzerwunsch 2026-09-10): vollwertiger Tab im
			// Hauptbereich statt der rechten Seitenleiste, die auf dem Handy nur
			// als schmales Slide-in-Panel öffnet.
			leaf = this.settings.openLocation === 'tab' ? workspace.getLeaf(true) : workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: IHM_VIEW_TYPE, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
		return leaf?.view instanceof IhmView ? leaf.view : null;
	}
}
