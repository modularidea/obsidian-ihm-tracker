import { App, normalizePath } from 'obsidian';
import { BillCategoryDef, OTHER_CATEGORY_ID, ProjectCategoryData, TrainingDoc } from '../types';
import { DEFAULT_CATEGORIES } from '../categorize/default-categories';

// Category data lives as one JSON file per project INSIDE the vault, so it
// rides along with whatever sync the user already runs (Obsidian Sync,
// iCloud, Syncthing, git). Those tools replace files wholesale (last write
// wins), so every save goes through mergeAndSave(): re-read disk, merge
// field-wise by updatedAt, then write. Passwords never go in here.
//
// All I/O uses `vault.adapter`, not the TFile API: Obsidian's file index lags
// behind disk, which produced both "File already exists" on create and stale
// reads right after our own writes.

export class CategoryStore {
	/** JSON as last seen on disk by THIS instance, per project. A fresh read
	 * that differs from it means another device wrote in between — a real
	 * conflict indicator, unlike a local-vs-disk diff (that fires on every
	 * own edit). */
	private lastKnownDisk = new Map<string, string>();

	constructor(
		private app: App,
		private folder: string,
	) {}

	setFolder(folder: string): void {
		if (folder === this.folder) return;
		this.folder = folder;
		this.lastKnownDisk.clear();
	}

	private pathFor(projectId: string): string {
		return normalizePath(`${this.folder}/ihm-categories-${projectId}.json`);
	}

	private emptyData(isForkCompatible: boolean): ProjectCategoryData {
		return {
			schemaVersion: 1,
			categories: DEFAULT_CATEGORIES.map((c) => sanitizeNativeId(c, isForkCompatible)),
			trainingDocs: [],
			billOverrides: {},
			deletedCategoryIds: {},
		};
	}

	/** `isForkCompatible` is true only for IHM projects: the seeded defaults
	 * carry negative fork/MoneyBuster ids, which are wrong for a real Cospend
	 * project (positive, project-owned ids) and get nulled there. */
	async load(projectId: string, isForkCompatible = true): Promise<ProjectCategoryData> {
		const path = this.pathFor(projectId);
		let data: ProjectCategoryData;
		try {
			if (!(await this.app.vault.adapter.exists(path))) {
				data = this.emptyData(isForkCompatible);
			} else {
				const raw = await this.app.vault.adapter.read(path);
				data = this.normalizeLoaded(JSON.parse(raw) as Partial<ProjectCategoryData>, isForkCompatible);
				if (isForkCompatible) {
					// Self-heal old files (see healDefaultMappings) and persist right
					// away so the duplicate disappears from disk, not only in memory.
					const healed = healDefaultMappings(data);
					if (JSON.stringify(healed) !== JSON.stringify(data)) {
						data = healed;
						await this.save(projectId, data);
					}
				}
			}
		} catch (e) {
			console.error('ihm-tracker: could not read category store', path, e);
			data = this.emptyData(isForkCompatible);
		}
		this.lastKnownDisk.set(projectId, JSON.stringify(data));
		return data;
	}

	/** Tolerates missing/broken fields from old or hand-edited files. */
	private normalizeLoaded(parsed: Partial<ProjectCategoryData>, isForkCompatible: boolean): ProjectCategoryData {
		const deletedCategoryIds = parsed.deletedCategoryIds ?? {};
		const categories = (
			Array.isArray(parsed.categories) && parsed.categories.length > 0
				? parsed.categories
				: DEFAULT_CATEGORIES.map((c) => ({ ...c }))
		)
			.map((c) => sanitizeNativeId(c, isForkCompatible))
			.filter((c) => !(c.id in deletedCategoryIds));
		if (!categories.some((c) => c.id === OTHER_CATEGORY_ID)) {
			categories.push({ id: OTHER_CATEGORY_ID, label: 'Other', emoji: '📦', keywords: [], nativeCategoryId: null });
		}
		const data: ProjectCategoryData = {
			schemaVersion: 1,
			categories,
			trainingDocs: Array.isArray(parsed.trainingDocs) ? parsed.trainingDocs : [],
			billOverrides: parsed.billOverrides ?? {},
			deletedCategoryIds,
		};
		return data;
	}

	/** Merges `local` (in-memory working state) with the current disk state and
	 * writes the result. Always use this instead of a direct write. `diverged`
	 * = the file changed on disk since this instance last saw it (another
	 * device) — merged silently, reported so the UI can mention it. */
	async mergeAndSave(
		projectId: string,
		local: ProjectCategoryData,
		isForkCompatible = true,
	): Promise<{ data: ProjectCategoryData; diverged: boolean }> {
		const previousKnown = this.lastKnownDisk.get(projectId);
		const onDisk = await this.load(projectId, isForkCompatible);
		const diverged = previousKnown !== undefined && previousKnown !== JSON.stringify(onDisk);
		const merged = this.merge(onDisk, local);
		await this.save(projectId, merged);
		this.lastKnownDisk.set(projectId, JSON.stringify(merged));
		return { data: merged, diverged };
	}

	private merge(a: ProjectCategoryData, b: ProjectCategoryData): ProjectCategoryData {
		// trainingDocs: union, deduplicated on (text, category, updatedAt);
		// conflicting corrections for the same text all stay, classify()
		// resolves by max(updatedAt).
		const seen = new Set<string>();
		const trainingDocs: TrainingDoc[] = [];
		for (const d of [...a.trainingDocs, ...b.trainingDocs]) {
			const key = `${d.text} ${d.categoryId} ${d.updatedAt}`;
			if (seen.has(key)) continue;
			seen.add(key);
			trainingDocs.push(d);
		}

		const billOverrides: ProjectCategoryData['billOverrides'] = { ...a.billOverrides };
		for (const [id, entry] of Object.entries(b.billOverrides)) {
			const existing = billOverrides[id];
			if (!existing || entry.updatedAt > existing.updatedAt) billOverrides[id] = entry;
		}

		const deletedCategoryIds: Record<string, string> = { ...(a.deletedCategoryIds ?? {}) };
		for (const [id, at] of Object.entries(b.deletedCategoryIds ?? {})) {
			const existing = deletedCategoryIds[id];
			if (!existing || at > existing) deletedCategoryIds[id] = at;
		}
		delete deletedCategoryIds[OTHER_CATEGORY_ID];

		// categories: union by id, `b` (fresher working state) wins on conflict,
		// tombstoned ids drop out.
		const byId = new Map<string, BillCategoryDef>();
		for (const c of a.categories) byId.set(c.id, c);
		for (const c of b.categories) byId.set(c.id, c);
		const categories = [...byId.values()].filter((c) => !(c.id in deletedCategoryIds));

		return { schemaVersion: 1, categories, trainingDocs, billOverrides, deletedCategoryIds };
	}

	private async save(projectId: string, data: ProjectCategoryData): Promise<void> {
		await this.ensureFolder();
		await this.app.vault.adapter.write(this.pathFor(projectId), JSON.stringify(data, null, '\t'));
	}

	private async ensureFolder(): Promise<void> {
		const path = normalizePath(this.folder);
		if (await this.app.vault.adapter.exists(path)) return;
		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			// Lost a race with a parallel export into the same folder.
			if (!(await this.app.vault.adapter.exists(path))) throw e;
		}
	}
}

function sanitizeNativeId(cat: BillCategoryDef, isForkCompatible: boolean): BillCategoryDef {
	if (!isForkCompatible && cat.nativeCategoryId != null && cat.nativeCategoryId < 0) {
		return { ...cat, nativeCategoryId: null };
	}
	return cat;
}

/** Fork/MoneyBuster projects: a default category that lost its global id
 * (an older bug nulled them) gets it back, and an auto-imported duplicate
 * (`native-<id>`, created while the mapping was missing) is folded into the
 * default — overrides and training docs re-pointed, the duplicate
 * tombstoned. Idempotent; persisted by the next mergeAndSave(). */
export function healDefaultMappings(data: ProjectCategoryData): ProjectCategoryData {
	const categories = data.categories.map((c) => ({ ...c }));
	const deletedCategoryIds = { ...(data.deletedCategoryIds ?? {}) };
	const remap = new Map<string, string>();
	for (const def of DEFAULT_CATEGORIES) {
		if (def.nativeCategoryId == null) continue;
		const local = categories.find((c) => c.id === def.id);
		if (!local) continue;
		// null = lost mapping; positive = a server-side duplicate created while
		// the mapping was lost. A deliberate remap to another GLOBAL id stays.
		if (local.nativeCategoryId == null || local.nativeCategoryId > 0) local.nativeCategoryId = def.nativeCategoryId;
		const duplicate = categories.find((c) => c.id === `native-${def.nativeCategoryId}`);
		if (duplicate && local.nativeCategoryId === def.nativeCategoryId) {
			remap.set(duplicate.id, local.id);
			deletedCategoryIds[duplicate.id] = new Date().toISOString();
		}
	}
	if (remap.size === 0) return { ...data, categories, deletedCategoryIds };
	const billOverrides: ProjectCategoryData['billOverrides'] = {};
	for (const [id, entry] of Object.entries(data.billOverrides)) {
		billOverrides[id] = { ...entry, categoryId: remap.get(entry.categoryId) ?? entry.categoryId };
	}
	const trainingDocs = data.trainingDocs.map((d) => ({ ...d, categoryId: remap.get(d.categoryId) ?? d.categoryId }));
	return {
		schemaVersion: 1,
		categories: categories.filter((c) => !remap.has(c.id)),
		trainingDocs,
		billOverrides,
		deletedCategoryIds,
	};
}
