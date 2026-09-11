import { App, normalizePath } from 'obsidian';
import { BillRepeatSettings, IhmBill } from '../types';
import { IhmMemberRaw, IhmBillCreate } from '../ihm-api/client';
import type { ExpenseClient, ServerFeature } from './expense-client';
import { nextRepeatDate } from '../stats/repeat';
import { memberStats } from '../stats/aggregate';

// Server-less project: bills and members live in one vault JSON file next to
// the category store. Implements ExpenseClient so the UI needs no special
// case. Uses `vault.adapter` for the same index-lag reasons as CategoryStore.

interface LocalMemberEntry {
	ihmId: number;
	name: string;
	weight: number;
	/** Mirrors IHM: a member with bills is deactivated, not deleted. */
	activated?: boolean;
}

interface LocalBillEntry {
	ihmId: number;
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string;
	billType: 'expense' | 'reimbursement';
	repeat?: BillRepeatSettings;
}

interface LocalProjectData {
	schemaVersion: 1;
	currency: string;
	nextMemberId: number;
	nextBillId: number;
	members: LocalMemberEntry[];
	bills: LocalBillEntry[];
}

function emptyData(currency: string): LocalProjectData {
	return { schemaVersion: 1, currency, nextMemberId: 1, nextBillId: 1, members: [], bills: [] };
}

export class LocalClient implements ExpenseClient {
	constructor(
		private app: App,
		private folder: string,
		private projectId: string,
		private defaultCurrency: string,
	) {}

	private path(): string {
		return normalizePath(`${this.folder}/local-project-${this.projectId}.json`);
	}

	/** A missing file is a fresh project; a corrupt file throws so the next
	 * save cannot silently overwrite it. */
	private async load(): Promise<LocalProjectData> {
		const path = this.path();
		if (!(await this.app.vault.adapter.exists(path))) return emptyData(this.defaultCurrency);
		return JSON.parse(await this.app.vault.adapter.read(path)) as LocalProjectData;
	}

	private async ensureFolder(): Promise<void> {
		const path = normalizePath(this.folder);
		if (await this.app.vault.adapter.exists(path)) return;
		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			if (!(await this.app.vault.adapter.exists(path))) throw e;
		}
	}

	private async save(data: LocalProjectData): Promise<void> {
		await this.ensureFolder();
		await this.app.vault.adapter.write(this.path(), JSON.stringify(data, null, '\t'));
	}

	async testConnection(): Promise<boolean> {
		return true;
	}

	async fetchCurrency(): Promise<string> {
		return (await this.load()).currency || this.defaultCurrency;
	}

	async probeNativeCategorySupport(): Promise<boolean> {
		return false;
	}

	async fetchFeatures(): Promise<Set<ServerFeature>> {
		return new Set<ServerFeature>(['repeat']);
	}

	async fetchMembers(): Promise<IhmMemberRaw[]> {
		const data = await this.load();
		const members = data.members.map((m) => ({ ihmId: m.ihmId, name: m.name, weight: m.weight, balance: 0, activated: m.activated ?? true }));
		const { paid, share } = memberStats(data.bills.map(toIhmBill), members);
		return members.map((m) => ({ ...m, balance: (paid.get(m.ihmId) ?? 0) - (share.get(m.ihmId) ?? 0) }));
	}

	/** Lazily materializes due copies of repeating bills (Cospend semantics:
	 * the copy inherits the rule, the source stops repeating). */
	async fetchBills(): Promise<IhmBill[]> {
		const data = await this.load();
		const today = new Date().toISOString().slice(0, 10);
		let created = false;
		for (const source of data.bills.filter((b) => b.repeat && b.repeat.repeat !== 'n')) {
			let current = source;
			for (;;) {
				const rule = current.repeat!;
				const next = nextRepeatDate(current.date, rule.repeat, rule.repeatFreq);
				if (next > today) break;
				if (rule.repeatUntil && next > rule.repeatUntil) {
					current.repeat = { ...rule, repeat: 'n' };
					break;
				}
				const activeIds = data.members.filter((m) => m.activated !== false).map((m) => m.ihmId);
				const copy: LocalBillEntry = {
					...current,
					ihmId: data.nextBillId++,
					date: next,
					owerIhmIds: rule.repeatAllActive ? activeIds : [...current.owerIhmIds],
					repeat: { ...rule },
				};
				current.repeat = { ...rule, repeat: 'n' };
				data.bills.push(copy);
				created = true;
				current = copy;
			}
		}
		if (created) await this.save(data);
		return data.bills.map(toIhmBill);
	}

	async createBill(bill: IhmBillCreate): Promise<number> {
		const data = await this.load();
		const id = data.nextBillId++;
		data.bills.push(toEntry(id, bill));
		await this.save(data);
		return id;
	}

	async updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void> {
		const data = await this.load();
		const idx = data.bills.findIndex((b) => b.ihmId === ihmBillId);
		if (idx === -1) return;
		data.bills[idx] = toEntry(ihmBillId, bill);
		await this.save(data);
	}

	async deleteBill(ihmBillId: number): Promise<void> {
		const data = await this.load();
		data.bills = data.bills.filter((b) => b.ihmId !== ihmBillId);
		await this.save(data);
	}

	/** Re-adding the name of a deactivated member reactivates it (like IHM). */
	async createMember(name: string): Promise<number> {
		const data = await this.load();
		const inactive = data.members.find((m) => m.activated === false && m.name === name);
		if (inactive) {
			inactive.activated = true;
			await this.save(data);
			return inactive.ihmId;
		}
		const id = data.nextMemberId++;
		data.members.push({ ihmId: id, name, weight: 1, activated: true });
		await this.save(data);
		return id;
	}

	async updateMember(ihmMemberId: number, name: string): Promise<void> {
		const data = await this.load();
		const member = data.members.find((m) => m.ihmId === ihmMemberId);
		if (member) member.name = name;
		await this.save(data);
	}

	async deleteMember(ihmMemberId: number): Promise<void> {
		const data = await this.load();
		const referenced = data.bills.some((b) => b.payerIhmId === ihmMemberId || b.owerIhmIds.includes(ihmMemberId));
		if (referenced) {
			const member = data.members.find((m) => m.ihmId === ihmMemberId);
			if (member) member.activated = false;
		} else {
			data.members = data.members.filter((m) => m.ihmId !== ihmMemberId);
		}
		await this.save(data);
	}
}

function toEntry(ihmId: number, bill: IhmBillCreate): LocalBillEntry {
	return {
		ihmId,
		what: bill.what,
		payerIhmId: bill.payerIhmId,
		owerIhmIds: bill.owerIhmIds,
		amount: bill.amount,
		date: bill.date,
		billType: bill.billType ?? 'expense',
		...(bill.repeatSettings ? { repeat: bill.repeatSettings } : {}),
	};
}

function toIhmBill(b: LocalBillEntry): IhmBill {
	return {
		ihmId: b.ihmId,
		what: b.what,
		payerIhmId: b.payerIhmId,
		owerIhmIds: b.owerIhmIds,
		amount: b.amount,
		date: b.date,
		billType: b.billType,
		repeatSettings: b.repeat ?? { repeat: 'n', repeatFreq: 1, repeatUntil: null, repeatAllActive: false },
	};
}
