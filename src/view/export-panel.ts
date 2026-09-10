import { App, Setting, TFolder } from 'obsidian';

export type ExportScope = 'filtered' | 'all';
export type ExportFormat = 'pdf' | 'excel';

export interface ExportOptionsResult {
	format: ExportFormat;
	scope: ExportScope;
	folder: string;
}

export interface ExportPanelOptions {
	defaultFolder: string;
	filterSummary: string;
	onSubmit: (result: ExportOptionsResult) => void;
	onCancel: () => void;
}

function vaultFolderPaths(app: App): string[] {
	const paths = app.vault
		.getAllLoadedFiles()
		.filter((f): f is TFolder => f instanceof TFolder)
		.map((f) => (f.path === '' ? '/' : f.path));
	return ['/', ...new Set(paths)].sort();
}

/** Inline export screen (format, scope, target folder inside the vault). No
 * native save dialog — see export/export-utils.ts. */
export function renderExportPanel(app: App, container: HTMLElement, opts: ExportPanelOptions): void {
	let format: ExportFormat = 'pdf';
	let scope: ExportScope = 'filtered';
	let folder = opts.defaultFolder;

	container.createEl('h3', { text: 'Export' });

	new Setting(container).setName('Format').addDropdown((dd) => {
		dd.addOption('pdf', 'PDF');
		dd.addOption('excel', 'Excel');
		dd.setValue(format).onChange((v) => (format = v as ExportFormat));
	});

	new Setting(container)
		.setName('Bills')
		.setDesc(`Filtered: ${opts.filterSummary}`)
		.addDropdown((dd) => {
			dd.addOption('filtered', 'Current filter');
			dd.addOption('all', 'All bills');
			dd.setValue(scope).onChange((v) => (scope = v as ExportScope));
		});

	const datalistId = 'ihm-export-folder-options';
	new Setting(container).setName('Folder in vault').addText((text) => {
		text.inputEl.setAttribute('list', datalistId);
		text.setValue(folder).onChange((v) => (folder = v));
	});
	const datalist = container.createEl('datalist', { attr: { id: datalistId } });
	for (const path of vaultFolderPaths(app)) datalist.createEl('option', { value: path });

	const buttons = container.createDiv({ cls: 'ihm-modal-buttons' });
	buttons.createEl('button', { text: 'Cancel' }).onclick = () => opts.onCancel();
	buttons.createEl('button', { text: 'Export', cls: 'mod-cta' }).onclick = () => {
		opts.onSubmit({ format, scope, folder: folder.trim() || opts.defaultFolder });
	};
}
