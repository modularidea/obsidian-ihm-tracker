import { App, normalizePath } from 'obsidian';

// Gemeinsame "in-Vault-speichern"-Logik für PDF- und Excel-Export.
//
// Warum in den Vault statt ein Browser-Download? Obsidian Mobile hat kein
// `<a download>`/Blob-Save wie ein normaler Browser-Tab — Downloads aus einer
// WebView heraus sind auf iOS/Android unzuverlässig bis gar nicht verfügbar.
// Der plattformübergreifend zuverlässige Weg ist `vault.createBinary()`: die
// Datei landet als normale Vault-Datei, die der Nutzer über den
// Datei-Explorer öffnen/teilen/exportieren kann (Rechtsklick → "Reveal in
// Finder"/"Share" — Obsidian-natives Verhalten, auf allen Plattformen gleich).

export async function ensureFolder(app: App, folder: string): Promise<void> {
	const path = normalizePath(folder);
	if (await app.vault.adapter.exists(path)) return;
	try {
		await app.vault.createFolder(path);
	} catch (e) {
		// Race mit einem parallelen Save in denselben Ordner (z.B.
		// CategoryStore, siehe sync/category-store.ts ensureFolder) — Ordner
		// existiert jetzt, kein echter Fehler.
		if (!(await app.vault.adapter.exists(path))) throw e;
	}
}

/** Hängt " (2)", " (3)", ... vor die Dateiendung an, falls der Name schon
 * existiert — verhindert stilles Überschreiben bei zweitem Export am selben
 * Tag (Dateiname enthält nur ein Datum, kein Uhrzeit-Suffix). */
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
	// `adapter.writeBinary()` statt `vault.createBinary()` — idempotent auf
	// Dateisystemebene, kein Race mit Obsidians (ggf. hinterherhinkendem)
	// Vault-Index (siehe sync/category-store.ts `save()` für den Bug, den
	// genau dieses Muster verursacht hat).
	await app.vault.adapter.writeBinary(path, data);
	return path;
}

export function timestampSlug(): string {
	return new Date().toISOString().slice(0, 10);
}
