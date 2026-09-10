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

		this.addRibbonIcon('euro', 'Open IHM Tracker', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open',
			name: 'Open',
			callback: () => {
				void this.activateView();
			},
		});

		this.addSettingTab(new IhmTrackerSettingTab(this.app, this));

		// Home-screen shortcut: plugins cannot create a home-screen icon, but a
		// user-made iOS Shortcut / Android shortcut can open
		// `obsidian://ihm-tracker-open?vault=<Vault>&project=<slug|name>&tab=bills|stats`.
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

		// Projects created before the backend abstraction have no
		// `backendType`; several `=== 'ihatemoney'` checks would treat
		// undefined as "not IHM" (wrong category-id sanitizing, wrong UI).
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
		this.categoryStore.setFolder(this.settings.categoryStoreFolder);
	}

	private async activateView(): Promise<IhmView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(IHM_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = this.settings.openLocation === 'tab' ? workspace.getLeaf(true) : workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: IHM_VIEW_TYPE, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
		return leaf?.view instanceof IhmView ? leaf.view : null;
	}
}
