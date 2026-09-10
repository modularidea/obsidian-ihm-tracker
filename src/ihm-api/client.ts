import { requestUrl } from 'obsidian';
import { IhmBill, IhmBillType } from '../types';
import type { ExpenseClient } from '../backend/expense-client';
import { COSPEND_GLOBAL_CATEGORIES } from '../categorize/cospend-category-map';

// IHateMoney REST client on top of Obsidian's requestUrl() (native HTTP on
// desktop and mobile, so server CORS headers don't matter).
// API: https://github.com/spiral-project/ihatemoney/blob/main/docs/api.md
// POST/PUT bodies use the WTForms field names (`payer`, `payed_for`), GET
// responses use `payer_id`/`owers`.

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
	/** Cospend only. */
	paymentModeId?: number;
}

export class IhmApiError extends Error {
	constructor(
		public status: number,
		public body: string,
	) {
		super(`IHM API ${status}: ${body}`);
	}
}

export class IhateMoneyClient implements ExpenseClient {
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

	async testConnection(): Promise<boolean> {
		try {
			const res = await requestUrl({ url: this.url(''), headers: this.headers(), throw: false });
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** "XXX" is IHM's "no currency" placeholder → EUR. */
	async fetchCurrency(): Promise<string> {
		try {
			const res = await requestUrl({ url: this.url(''), headers: this.headers(), throw: false });
			if (res.status !== 200) return 'EUR';
			const currency = (res.json as { default_currency?: string } | undefined)?.default_currency;
			return currency && currency !== 'XXX' ? currency : 'EUR';
		} catch {
			return 'EUR';
		}
	}

	/** Checks key PRESENCE on the first bill (`null` is a valid "unclassified"
	 * value on a fork server). Empty project → false; sync() re-derives the
	 * flag from fetched bills anyway. */
	async probeNativeCategorySupport(): Promise<boolean> {
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

	/** The fork only knows the fixed Cospend global categories. */
	async fetchNativeCategories(): Promise<{ id: number; label: string; emoji: string }[]> {
		return COSPEND_GLOBAL_CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji }));
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
			// Wire value = upstream BillType enum value ("Expense"/"Reimbursement").
			...(bill.billType ? { bill_type: bill.billType === 'reimbursement' ? 'Reimbursement' : 'Expense' } : {}),
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
