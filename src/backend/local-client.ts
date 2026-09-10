import { App, normalizePath } from 'obsidian';
import { IhmBill } from '../types';
import { IhmMemberRaw, IhmBillCreate } from '../ihm-api/client';
import type { ExpenseClient } from './expense-client';
import { memberStats } from '../stats/aggregate';

// "Lokale Projekte" (Nutzerwunsch 2026-09-10, docs/ideas.md Variante B):
// KEIN Server — Belege/Mitglieder leben in genau EINER Vault-JSON-Datei,
// analog `sync/category-store.ts`. Implementiert `ExpenseClient` wie die
// echten Backends, damit `view/ihm-view.ts`/`view/stats-tabs.ts` etc.
// UNVERÄNDERT bleiben (die kennen nur `IhmBill`/`IhmMemberRaw`, keinen
// Unterschied ob die Daten vom Server oder aus einer lokalen Datei kommen).
//
// `vault.adapter.write()` statt `vault.create()`/`vault.modify()` — gleicher
// Grund wie in `sync/category-store.ts` `save()`: umgeht das TOCTOU-Race über
// Obsidians (verzögerten) Vault-Datei-Index (siehe dortiger Kommentar,
// Bug-Historie in docs/bugs.md).

interface LocalMemberEntry {
	ihmId: number;
	name: string;
	weight: number;
}

interface LocalBillEntry {
	ihmId: number;
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string;
	billType: 'expense' | 'reimbursement';
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

	private async load(): Promise<LocalProjectData> {
		try {
			const raw = await this.app.vault.adapter.read(this.path());
			return JSON.parse(raw) as LocalProjectData;
		} catch {
			return emptyData(this.defaultCurrency);
		}
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

	/** Kein Wire-Format, kein anderer Client liest diese Datei — die Frage
	 * "natives Kategorie-Feld?" stellt sich für ein rein lokales Projekt
	 * nicht. */
	async probeNativeCategorySupport(): Promise<boolean> {
		return false;
	}

	async fetchMembers(): Promise<IhmMemberRaw[]> {
		const data = await this.load();
		const bills: IhmBill[] = data.bills.map(toIhmBill);
		const { paid, share } = memberStats(bills, data.members.map((m) => ({ ihmId: m.ihmId, name: m.name, weight: m.weight, balance: 0 })));
		return data.members.map((m) => ({
			ihmId: m.ihmId,
			name: m.name,
			weight: m.weight,
			balance: (paid.get(m.ihmId) ?? 0) - (share.get(m.ihmId) ?? 0),
		}));
	}

	async fetchBills(): Promise<IhmBill[]> {
		return (await this.load()).bills.map(toIhmBill);
	}

	async createBill(bill: IhmBillCreate): Promise<number> {
		const data = await this.load();
		const id = data.nextBillId++;
		data.bills.push({
			ihmId: id,
			what: bill.what,
			payerIhmId: bill.payerIhmId,
			owerIhmIds: bill.owerIhmIds,
			amount: bill.amount,
			date: bill.date,
			billType: bill.billType ?? 'expense',
		});
		await this.save(data);
		return id;
	}

	async updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void> {
		const data = await this.load();
		const idx = data.bills.findIndex((b) => b.ihmId === ihmBillId);
		if (idx === -1) return;
		data.bills[idx] = {
			ihmId: ihmBillId,
			what: bill.what,
			payerIhmId: bill.payerIhmId,
			owerIhmIds: bill.owerIhmIds,
			amount: bill.amount,
			date: bill.date,
			billType: bill.billType ?? 'expense',
		};
		await this.save(data);
	}

	async deleteBill(ihmBillId: number): Promise<void> {
		const data = await this.load();
		data.bills = data.bills.filter((b) => b.ihmId !== ihmBillId);
		await this.save(data);
	}

	async createMember(name: string): Promise<number> {
		const data = await this.load();
		const id = data.nextMemberId++;
		data.members.push({ ihmId: id, name, weight: 1 });
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
		data.members = data.members.filter((m) => m.ihmId !== ihmMemberId);
		await this.save(data);
	}
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
	};
}
