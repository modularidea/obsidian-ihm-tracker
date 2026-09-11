import { requestUrl } from 'obsidian';
import { IhmBill, IhmBillType, BillCategoryDef } from '../types';
import { IhmMemberRaw, IhmBillCreate, IhmApiError, parseRepeat, repeatWire } from '../ihm-api/client';
import type { SettlementTransaction } from '../stats/aggregate';
import type { ExpenseClient, PaymentMode, ServerFeature } from './expense-client';
import { categoryColor } from '../categorize/cospend-category-map';

// Nextcloud Cospend client using the authenticated `api-priv` routes (Basic
// auth with Login-Flow-v2 credentials, see cospend-login.ts). Verified
// against a real server. Differences from IHM:
// - bills response is wrapped (`{bills: [...]}`)
// - `payed_for` is a comma-separated string
// - no `bill_type`: reimbursements are the sentinel `categoryid: -11`
// - `/statistics` is wrapped (`{stats: [...]}`)
// - categories are real, free project resources (positive ids)

const REIMBURSEMENT_CATEGORY_ID = -11;

interface CospendProjectInfoJson {
	currencyname?: string;
	paymentmodes?: Record<string, { id: number; name: string; icon: string }>;
	categories?: Record<string, { id: number; name: string; icon: string }>;
}

interface CospendMemberJson {
	id: number;
	name: string;
	weight?: number;
	activated?: boolean;
}

interface CospendStatsJson {
	stats?: { member: { id: number }; balance: number }[];
}

interface CospendBillOwerJson {
	id: number;
	weight?: number;
}

interface CospendBillJson {
	id: number;
	what: string;
	payer_id: number;
	owers?: (CospendBillOwerJson | number)[];
	amount: number;
	date: string;
	categoryid?: number;
	paymentmodeid?: number;
	repeat?: string;
	repeatfreq?: number;
	repeatuntil?: string | null;
	repeatallactive?: boolean;
}

interface CospendBillsResponseJson {
	bills?: CospendBillJson[];
}

interface CospendSettleResponseJson {
	transactions?: { from: number; to: number; amount: number }[];
}

export class CospendClient implements ExpenseClient {
	constructor(
		private serverUrl: string,
		private projectId: string,
		private loginName: string,
		private appPassword: string,
	) {}

	private headers(): Record<string, string> {
		return {
			Authorization: `Basic ${btoa(`${this.loginName}:${this.appPassword}`)}`,
			'OCS-APIRequest': 'true',
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		};
	}

	private base(): string {
		const b = this.serverUrl.endsWith('/') ? this.serverUrl.slice(0, -1) : this.serverUrl;
		return `${b}/index.php/apps/cospend/api-priv/projects/${encodeURIComponent(this.projectId)}`;
	}

	private form(params: Record<string, unknown>): string {
		const usp = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) usp.set(k, String(v));
		return usp.toString();
	}

	private async projectInfo(): Promise<CospendProjectInfoJson | null> {
		const res = await requestUrl({ url: this.base(), headers: this.headers(), throw: false });
		return res.status === 200 ? ((res.json as CospendProjectInfoJson | undefined) ?? null) : null;
	}

	async testConnection(): Promise<boolean> {
		try {
			return (await this.projectInfo()) !== null;
		} catch {
			return false;
		}
	}

	/** `currencyname` is free text, not necessarily ISO-4217 — only accept a
	 * 3-letter code, else EUR. */
	async fetchCurrency(): Promise<string> {
		try {
			const name = (await this.projectInfo())?.currencyname;
			return name && /^[A-Z]{3}$/.test(name) ? name : 'EUR';
		} catch {
			return 'EUR';
		}
	}

	async probeNativeCategorySupport(): Promise<boolean> {
		return true;
	}

	async fetchFeatures(): Promise<Set<ServerFeature>> {
		return new Set<ServerFeature>(['categoryid', 'categories', 'paymentmodes', 'settle', 'repeat']);
	}

	async fetchMembers(): Promise<IhmMemberRaw[]> {
		const [membersRes, statsRes] = await Promise.all([
			requestUrl({ url: `${this.base()}/members`, headers: this.headers(), throw: false }),
			requestUrl({ url: `${this.base()}/statistics`, headers: this.headers(), throw: false }),
		]);
		if (membersRes.status !== 200) throw new IhmApiError(membersRes.status, membersRes.text);
		const balanceByMemberId = new Map<number, number>();
		if (statsRes.status === 200) {
			for (const s of (statsRes.json as CospendStatsJson | undefined)?.stats ?? []) balanceByMemberId.set(s.member.id, s.balance);
		}
		return (membersRes.json as CospendMemberJson[]).map((m) => ({
			ihmId: m.id,
			name: m.name,
			weight: m.weight ?? 1.0,
			balance: balanceByMemberId.get(m.id) ?? 0,
			activated: m.activated ?? true,
		}));
	}

	async fetchBills(): Promise<IhmBill[]> {
		const res = await requestUrl({ url: `${this.base()}/bills`, headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		const list = (res.json as CospendBillsResponseJson | undefined)?.bills ?? [];
		return list.map((b) => {
			const categoryId = b.categoryid;
			const billType: IhmBillType = categoryId === REIMBURSEMENT_CATEGORY_ID ? 'reimbursement' : 'expense';
			return {
				ihmId: b.id,
				what: b.what,
				payerIhmId: b.payer_id,
				owerIhmIds: (b.owers ?? []).map((o) => (typeof o === 'object' ? o.id : o)),
				amount: Number(b.amount),
				date: b.date,
				billType,
				// 0 = no category, -11 = reimbursement sentinel → both null.
				nativeCategoryId: categoryId && categoryId !== REIMBURSEMENT_CATEGORY_ID ? categoryId : null,
				paymentModeId: b.paymentmodeid || undefined,
				repeatSettings: parseRepeat(b),
			} satisfies IhmBill;
		});
	}

	private billBody(bill: IhmBillCreate): string {
		const categoryId = bill.billType === 'reimbursement' ? REIMBURSEMENT_CATEGORY_ID : bill.nativeCategoryId;
		return this.form({
			what: bill.what,
			payer: bill.payerIhmId,
			payed_for: bill.owerIhmIds.join(','),
			amount: bill.amount,
			date: bill.date,
			...(categoryId != null ? { categoryid: categoryId } : {}),
			...(bill.paymentModeId != null ? { paymentmodeid: bill.paymentModeId } : {}),
			...repeatWire(bill.repeatSettings),
		});
	}

	async fetchPaymentModes(): Promise<PaymentMode[]> {
		const modes = (await this.projectInfo())?.paymentmodes ?? {};
		return Object.values(modes).map((m) => ({ id: m.id, name: m.name, icon: m.icon }));
	}

	private parseIdResponse(body: string): number {
		const asInt = Number(body.trim());
		if (!Number.isNaN(asInt)) return asInt;
		throw new Error('Server response contained no parsable id — aborting instead of guessing.');
	}

	async createBill(bill: IhmBillCreate): Promise<number> {
		const res = await requestUrl({
			url: `${this.base()}/bills`,
			method: 'POST',
			headers: this.headers(),
			body: this.billBody(bill),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/bills/${ihmBillId}`,
			method: 'PUT',
			headers: this.headers(),
			body: this.billBody(bill),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	async deleteBill(ihmBillId: number): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/bills/${ihmBillId}`,
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}

	async createMember(name: string): Promise<number> {
		const res = await requestUrl({
			url: `${this.base()}/members`,
			method: 'POST',
			headers: this.headers(),
			body: this.form({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateMember(ihmMemberId: number, name: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/members/${ihmMemberId}`,
			method: 'PUT',
			headers: this.headers(),
			body: this.form({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	async deleteMember(ihmMemberId: number): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/members/${ihmMemberId}`,
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}

	async fetchSettlement(): Promise<SettlementTransaction[]> {
		const res = await requestUrl({ url: `${this.base()}/settle`, headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		const transactions = (res.json as CospendSettleResponseJson | undefined)?.transactions ?? [];
		return transactions.map((t) => ({ fromIhmId: t.from, toIhmId: t.to, amount: t.amount }));
	}

	async fetchNativeCategories(): Promise<{ id: number; label: string; emoji: string }[]> {
		const categories = (await this.projectInfo())?.categories ?? {};
		return Object.values(categories).map((c) => ({ id: c.id, label: c.name, emoji: c.icon }));
	}

	/** Reuses an existing category with the same name (Cospend seeds ~10
	 * defaults per project) instead of creating a duplicate. */
	async pushCategory(cat: BillCategoryDef): Promise<number | null> {
		try {
			const needle = cat.label.trim().toLowerCase();
			const existing = Object.values((await this.projectInfo())?.categories ?? {}).find((c) => c.name.trim().toLowerCase() === needle);
			if (existing) return existing.id;

			const res = await requestUrl({
				url: `${this.base()}/category`,
				method: 'POST',
				headers: this.headers(),
				body: this.form({ name: cat.label, icon: cat.emoji, color: categoryColor(cat.id) }),
				throw: false,
			});
			if (res.status !== 200 && res.status !== 201) return null;
			return this.parseIdResponse(res.text);
		} catch {
			return null;
		}
	}
}
