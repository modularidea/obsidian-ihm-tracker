import { requestUrl } from 'obsidian';
import { BillCategoryDef, BillRepeat, BillRepeatSettings, IhmBill, IhmBillType, NO_REPEAT } from '../types';
import type { ExpenseClient, PaymentMode, ServerFeature } from '../backend/expense-client';
import type { SettlementTransaction } from '../stats/aggregate';
import { categoryColor, COSPEND_GLOBAL_CATEGORIES } from '../categorize/cospend-category-map';

// IHateMoney REST client on top of Obsidian's requestUrl() (native HTTP on
// desktop and mobile, so server CORS headers don't matter).
// API: https://github.com/spiral-project/ihatemoney/blob/main/docs/api.md
// POST/PUT bodies use the WTForms field names (`payer`, `payed_for`), GET
// responses use `payer_id`/`owers`. The IHM Tracker server fork
// (github.com/modularidea/ihatemoney-cat) adds `categoryid`, project
// categories/payment modes, `/settle`, repeating bills and advertises them
// as `features` in the project info; everything below degrades to stock IHM.

/** Member DTO shared by all backends. `activated: false` = removed while
 * still referenced by bills (IHM/Cospend keep such members around). */
export interface IhmMemberRaw {
	ihmId: number;
	name: string;
	weight: number;
	balance: number;
	activated: boolean;
}

interface IhmMemberJson {
	id: number;
	name: string;
	weight?: number;
	activated?: boolean;
}

interface IhmStatsEntryJson {
	member: { id: number };
	balance: number;
}

interface IhmBillOwerJson {
	id: number;
	weight?: number;
}

interface IhmBillJson {
	id: number;
	what: string;
	payer_id: number;
	owers?: (IhmBillOwerJson | number)[];
	amount: number;
	converted_amount?: number;
	date: string;
	bill_type?: string;
	external_link?: string;
	categoryid?: number | null;
	paymentmodeid?: number | null;
	repeat?: string;
	repeatfreq?: number;
	repeatuntil?: string | null;
	repeatallactive?: boolean;
}

interface IhmItemJson {
	id: number;
	name: string;
	icon?: string;
	color?: string;
}

interface IhmProjectJson {
	default_currency?: string;
	features?: string[];
	categories?: IhmItemJson[];
	paymentmodes?: IhmItemJson[];
}

interface IhmSettleEntryJson {
	ower: number;
	receiver: number;
	amount: number;
}

export interface IhmBillCreate {
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string; // yyyy-mm-dd
	externalLink?: string;
	/** Wire field `categoryid` (server fork / Cospend). `undefined` omits the
	 * key entirely; `null` explicitly clears the category. */
	nativeCategoryId?: number | null;
	/** Omitted → server default "Expense". Must be passed on every update of
	 * a reimbursement bill, otherwise IHM resets it to Expense. */
	billType?: IhmBillType;
	paymentModeId?: number;
	/** Same rule as billType: omit on update and the fork resets to "n". */
	repeatSettings?: BillRepeatSettings;
}

export class IhmApiError extends Error {
	constructor(
		public status: number,
		public body: string,
	) {
		super(`IHM API ${status}: ${body}`);
	}
}

const REPEAT_CODES: BillRepeat[] = ['n', 'd', 'w', 'b', 's', 'm', 'y'];

/** Repeat fields from a wire object; undefined when the server has none. */
export function parseRepeat(b: { repeat?: string; repeatfreq?: number; repeatuntil?: string | null; repeatallactive?: boolean }): BillRepeatSettings | undefined {
	if (b.repeat === undefined) return undefined;
	const repeat = REPEAT_CODES.includes(b.repeat as BillRepeat) ? (b.repeat as BillRepeat) : 'n';
	return {
		repeat,
		repeatFreq: Math.max(1, Number(b.repeatfreq) || 1),
		repeatUntil: b.repeatuntil || null,
		repeatAllActive: !!b.repeatallactive,
	};
}

export function repeatWire(settings: BillRepeatSettings | undefined): Record<string, unknown> {
	if (!settings) return {};
	return {
		repeat: settings.repeat,
		repeatfreq: settings.repeatFreq,
		...(settings.repeatUntil ? { repeatuntil: settings.repeatUntil } : {}),
		repeatallactive: settings.repeatAllActive,
	};
}

export class IhateMoneyClient implements ExpenseClient {
	private projectInfoCache?: Promise<IhmProjectJson | null>;

	constructor(
		private serverUrl: string,
		private projectId: string,
		private password: string,
	) {}

	private headers(): Record<string, string> {
		return {
			Authorization: `Basic ${btoa(`${this.projectId}:${this.password}`)}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
	}

	private url(path: string): string {
		const base = this.serverUrl.endsWith('/') ? this.serverUrl.slice(0, -1) : this.serverUrl;
		return `${base}/api/projects/${this.projectId}${path}`;
	}

	/** One project-info request per client instance (sync() creates a fresh
	 * client, so this never goes stale across syncs). */
	private projectInfo(): Promise<IhmProjectJson | null> {
		this.projectInfoCache ??= (async () => {
			try {
				const res = await requestUrl({ url: this.url(''), headers: this.headers(), throw: false });
				return res.status === 200 ? ((res.json as IhmProjectJson | undefined) ?? null) : null;
			} catch {
				return null;
			}
		})();
		return this.projectInfoCache;
	}

	private async features(): Promise<Set<ServerFeature>> {
		return new Set(((await this.projectInfo())?.features ?? []) as ServerFeature[]);
	}

	async fetchFeatures(): Promise<Set<ServerFeature>> {
		return this.features();
	}

	async testConnection(): Promise<boolean> {
		return (await this.projectInfo()) !== null;
	}

	/** "XXX" is IHM's "no currency" placeholder → EUR. */
	async fetchCurrency(): Promise<string> {
		const currency = (await this.projectInfo())?.default_currency;
		return currency && currency !== 'XXX' ? currency : 'EUR';
	}

	/** Fork: advertised feature. Older fork builds: key presence on the first
	 * bill (`null` is a valid "unclassified" value). Empty project → false. */
	async probeNativeCategorySupport(): Promise<boolean> {
		if ((await this.features()).has('categoryid')) return true;
		try {
			const res = await requestUrl({ url: this.url('/bills'), headers: this.headers(), throw: false });
			if (res.status !== 200) return false;
			const decoded = res.json as IhmBillJson[] | { bills: IhmBillJson[] };
			const list = Array.isArray(decoded) ? decoded : decoded?.bills;
			return Array.isArray(list) && list.length > 0 && Object.prototype.hasOwnProperty.call(list[0], 'categoryid');
		} catch {
			return false;
		}
	}

	/** Global Cospend categories (negative ids, known to MoneyBuster) plus
	 * the project's own (positive ids, fork feature "categories"). */
	async fetchNativeCategories(): Promise<{ id: number; label: string; emoji: string }[]> {
		const global = COSPEND_GLOBAL_CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji }));
		const own = ((await this.projectInfo())?.categories ?? []).map((c) => ({ id: c.id, label: c.name, emoji: c.icon ?? '' }));
		return [...global, ...own];
	}

	/** Reuses a same-named project category, else creates one. `null` when
	 * the server has no project categories (stock IHM / old fork). */
	async pushCategory(cat: BillCategoryDef): Promise<number | null> {
		try {
			const info = await this.projectInfo();
			if (!info?.features?.includes('categories')) return null;
			const needle = cat.label.trim().toLowerCase();
			const existing = (info.categories ?? []).find((c) => c.name.trim().toLowerCase() === needle);
			if (existing) return existing.id;
			const res = await requestUrl({
				url: this.url('/categories'),
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({ name: cat.label, icon: cat.emoji, color: categoryColor(cat.id) }),
				throw: false,
			});
			if (res.status !== 200 && res.status !== 201) return null;
			const id = this.parseIdResponse(res.text);
			info.categories = [...(info.categories ?? []), { id, name: cat.label, icon: cat.emoji }];
			return id;
		} catch {
			return null;
		}
	}

	async deleteNativeCategory(nativeId: number): Promise<void> {
		const res = await requestUrl({ url: this.url(`/categories/${nativeId}`), method: 'DELETE', headers: this.headers(), throw: false });
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
		const info = await this.projectInfo();
		if (info?.categories) info.categories = info.categories.filter((c) => c.id !== nativeId);
	}

	async fetchPaymentModes(): Promise<PaymentMode[]> {
		return ((await this.projectInfo())?.paymentmodes ?? []).map((p) => ({ id: p.id, name: p.name, icon: p.icon ?? '' }));
	}

	async fetchSettlement(): Promise<SettlementTransaction[]> {
		const res = await requestUrl({ url: this.url('/settle'), headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		return (res.json as IhmSettleEntryJson[]).map((t) => ({ fromIhmId: t.ower, toIhmId: t.receiver, amount: t.amount }));
	}

	/** `/members` has no balance field; balances only come from `/statistics`. */
	async fetchMembers(): Promise<IhmMemberRaw[]> {
		const [membersRes, statsRes] = await Promise.all([
			requestUrl({ url: this.url('/members'), headers: this.headers(), throw: false }),
			requestUrl({ url: this.url('/statistics'), headers: this.headers(), throw: false }),
		]);
		if (membersRes.status !== 200) throw new IhmApiError(membersRes.status, membersRes.text);
		const balanceByMemberId = new Map<number, number>();
		if (statsRes.status === 200) {
			for (const s of statsRes.json as IhmStatsEntryJson[]) balanceByMemberId.set(s.member.id, s.balance);
		}
		return (membersRes.json as IhmMemberJson[]).map((m) => ({
			ihmId: m.id,
			name: m.name,
			weight: m.weight ?? 1.0,
			balance: balanceByMemberId.get(m.id) ?? 0,
			activated: m.activated ?? true,
		}));
	}

	async fetchBills(): Promise<IhmBill[]> {
		const res = await requestUrl({ url: this.url('/bills'), headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		const decoded = res.json as IhmBillJson[] | { bills: IhmBillJson[] };
		const list: IhmBillJson[] = Array.isArray(decoded) ? decoded : decoded.bills;
		return list.map((b) => {
			const billType: IhmBillType = b.bill_type === 'Reimbursement' ? 'reimbursement' : 'expense';
			return {
				ihmId: b.id,
				what: b.what,
				payerIhmId: b.payer_id,
				owerIhmIds: (b.owers ?? []).map((o) => (typeof o === 'object' ? o.id : o)),
				amount: Number(b.converted_amount ?? b.amount),
				date: b.date,
				billType,
				externalLink: b.external_link || undefined,
				// Key presence distinguishes "fork, unclassified" (null) from
				// "stock IHM, no such field" (undefined).
				nativeCategoryId: 'categoryid' in b ? (b.categoryid ?? null) : undefined,
				paymentModeId: b.paymentmodeid ?? undefined,
				repeatSettings: parseRepeat(b),
			} satisfies IhmBill;
		});
	}

	private billBody(bill: IhmBillCreate): Record<string, unknown> {
		return {
			what: bill.what,
			payer: bill.payerIhmId,
			payed_for: bill.owerIhmIds,
			amount: bill.amount,
			date: bill.date,
			...(bill.externalLink ? { external_link: bill.externalLink } : {}),
			...(bill.nativeCategoryId !== undefined ? { categoryid: bill.nativeCategoryId } : {}),
			...(bill.paymentModeId != null ? { paymentmodeid: bill.paymentModeId } : {}),
			// Wire value = upstream BillType enum value ("Expense"/"Reimbursement").
			...(bill.billType ? { bill_type: bill.billType === 'reimbursement' ? 'Reimbursement' : 'Expense' } : {}),
			...repeatWire(bill.repeatSettings),
		};
	}

	async createBill(bill: IhmBillCreate): Promise<number> {
		const res = await requestUrl({
			url: this.url('/bills'),
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(this.billBody(bill)),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/bills/${ihmBillId}`),
			method: 'PUT',
			headers: this.headers(),
			body: JSON.stringify(this.billBody(bill)),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	/** 404 counts as success — the bill is gone either way. */
	async deleteBill(ihmBillId: number): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/bills/${ihmBillId}`),
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}

	/** Create endpoints answer either with a bare number or `{"id": ...}`. */
	private parseIdResponse(body: string): number {
		const asInt = Number(body.trim());
		if (!Number.isNaN(asInt)) return asInt;
		try {
			const j = JSON.parse(body) as { id?: number | string };
			if (j.id != null) return Number(j.id);
		} catch {
			/* fall through */
		}
		throw new Error('Server response contained no parsable id — aborting instead of guessing.');
	}

	async createMember(name: string): Promise<number> {
		const res = await requestUrl({
			url: this.url('/members'),
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateMember(ihmMemberId: number, name: string): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/members/${ihmMemberId}`),
			method: 'PUT',
			headers: this.headers(),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	/** IHM only deactivates a member that still has bills (see `activated`). */
	async deleteMember(ihmMemberId: number): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/members/${ihmMemberId}`),
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}
}

export { NO_REPEAT };
