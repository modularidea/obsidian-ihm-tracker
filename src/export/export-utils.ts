import { App, normalizePath } from 'obsidian';

// Exports are saved INTO the vault: Obsidian Mobile has no reliable browser
// download, a vault file can be opened/shared on every platform.

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const path = normalizePath(folder);
	if (await app.vault.adapter.exists(path)) return;
	try {
		await app.vault.createFolder(path);
	} catch (e) {
		// Lost a race with a parallel save into the same folder.
		if (!(await app.vault.adapter.exists(path))) throw e;
	}
}

/** Appends " (2)", " (3)", … so a second export on the same day does not
 * overwrite the first (file names only carry a date). */
async function uniqueFilePath(app: App, folder: string, filename: string): Promise<string> {
	const dot = filename.lastIndexOf('.');
	const stem = dot === -1 ? filename : filename.slice(0, dot);
	const ext = dot === -1 ? '' : filename.slice(dot);
	let candidate = normalizePath(`${folder}/${filename}`);
	let n = 2;
	while (await app.vault.adapter.exists(candidate)) {
		candidate = normalizePath(`${folder}/${stem} (${n})${ext}`);
		n++;
	}
	return candidate;
}

export async function saveBinaryToVault(app: App, folder: string, filename: string, data: ArrayBuffer): Promise<string> {
	await ensureFolder(app, folder);
	const path = await uniqueFilePath(app, folder, filename);
	// adapter-level write: no race with Obsidian's lagging file index.
	await app.vault.adapter.writeBinary(path, data);
	return path;
}

export function timestampSlug(): string {
	return new Date().toISOString().slice(0, 10);
}
