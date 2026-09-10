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

/** Export-Bildschirm inline statt Modal (Nutzer-Feedback 2026-09-09: "da eh
 * nochmal ein Screen kommt" — ein "Exportieren"-Eintrag im Options-Menü statt
 * getrennter "Als PDF"/"Als Excel"-Einträge, Dateiformat wird hier gewählt).
 * Kein natives OS-Save-Dialog — siehe export/export-utils.ts, warum
 * Vault-Speichern der einzige auf iOS/Android zuverlässige Weg ist; der
 * Ordner bleibt aber frei wählbar statt fest aus den Settings. */
export function renderExportPanel(app: App, container: HTMLElement, opts: ExportPanelOptions): void {
	let format: ExportFormat = 'pdf';
	let scope: ExportScope = 'filtered';
	let folder = opts.defaultFolder;

	container.createEl('h3', { text: 'Exportieren' });

	new Setting(container).setName('Format').addDropdown((dd) => {
		dd.addOption('pdf', 'PDF');
		dd.addOption('excel', 'Excel');
		dd.setValue(format).onChange((v) => (format = v as ExportFormat));
	});

	new Setting(container)
		.setName('Belege')
		.setDesc(`Gefiltert: ${opts.filterSummary}`)
		.addDropdown((dd) => {
			dd.addOption('filtered', 'Aktuelle Filterung');
			dd.addOption('all', 'Alle Belege');
			dd.setValue(scope).onChange((v) => (scope = v as ExportScope));
		});

	const datalistId = 'ihm-export-folder-options';
	new Setting(container).setName('Ordner im Vault').addText((text) => {
		text.inputEl.setAttribute('list', datalistId);
		text.setValue(folder).onChange((v) => (folder = v));
	});
	const datalist = container.createEl('datalist', { attr: { id: datalistId } });
	for (const path of vaultFolderPaths(app)) datalist.createEl('option', { value: path });

	const buttons = container.createDiv({ cls: 'ihm-modal-buttons' });
	buttons.createEl('button', { text: 'Abbrechen' }).onclick = () => opts.onCancel();
	buttons.createEl('button', { text: 'Exportieren', cls: 'mod-cta' }).onclick = () => {
		opts.onSubmit({ format, scope, folder: folder.trim() || opts.defaultFolder });
	};
}
