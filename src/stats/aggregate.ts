import { IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { cospendIdToLocalCategoryId } from '../categorize/cospend-category-map';

// Pure aggregation helpers, no DOM. IHM splits every bill evenly (weighted by
// Member.weight) across its owers — computeShares() mirrors exactly that,
// there is no other split model.

/** Reimbursements count towards balances but not towards expense stats. */
export function isExpense(bill: IhmBill): boolean {
	return bill.billType === 'expense';
}

export function categoryOf(bill: IhmBill): string {
	if (bill.categoryId) return bill.categoryId;
	// Display fallback for bills sync() has not classified (should not happen
	// in practice; kept for exports of raw data).
	if (bill.nativeCategoryId != null) return cospendIdToLocalCategoryId(bill.nativeCategoryId) ?? 'other';
	return 'other';
}

export function byMonth(bills: IhmBill[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const b of bills) {
		const key = b.date.slice(0, 7);
		m.set(key, (m.get(key) ?? 0) + b.amount);
	}
	return m;
}

export function byCategory(bills: IhmBill[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const b of bills) {
		const cat = categoryOf(b);
		m.set(cat, (m.get(cat) ?? 0) + b.amount);
	}
	return m;
}

/** Each ower's share of `bill`, weighted by `weightOf`. Takes a partial bill
 * so the form can call it with an unsaved draft. */
export function computeShares(bill: Pick<IhmBill, 'amount' | 'owerIhmIds'>, weightOf: (ihmId: number) => number): Map<number, number> {
	const shares = new Map<number, number>();
	const totalWeight = bill.owerIhmIds.reduce((s, id) => s + weightOf(id), 0);
	if (totalWeight === 0) return shares;
	for (const id of bill.owerIhmIds) shares.set(id, (bill.amount * weightOf(id)) / totalWeight);
	return shares;
}

export interface MemberStats {
	paid: Map<number, number>;
	share: Map<number, number>;
}

export function memberStats(bills: IhmBill[], members: IhmMemberRaw[]): MemberStats {
	const weightOf = (id: number) => members.find((m) => m.ihmId === id)?.weight ?? 1;
	const paid = new Map<number, number>();
	const share = new Map<number, number>();
	for (const b of bills) {
		paid.set(b.payerIhmId, (paid.get(b.payerIhmId) ?? 0) + b.amount);
		for (const [id, val] of computeShares(b, weightOf)) share.set(id, (share.get(id) ?? 0) + val);
	}
	return { paid, share };
}

/** Person × month pivot. `share` = caused, `paid` = paid out. */
export function pivotByPersonMonth(
	bills: IhmBill[],
	members: IhmMemberRaw[],
	opts: { categoryId?: string; metric: 'share' | 'paid' },
): Map<string, Map<number, number>> {
	const weightOf = (id: number) => members.find((m) => m.ihmId === id)?.weight ?? 1;
	const filtered = opts.categoryId ? bills.filter((b) => categoryOf(b) === opts.categoryId) : bills;
	const result = new Map<string, Map<number, number>>();
	for (const b of filtered) {
		const monthKey = b.date.slice(0, 7);
		if (!result.has(monthKey)) result.set(monthKey, new Map());
		const row = result.get(monthKey)!;
		if (opts.metric === 'paid') {
			row.set(b.payerIhmId, (row.get(b.payerIhmId) ?? 0) + b.amount);
		} else {
			for (const [id, val] of computeShares(b, weightOf)) row.set(id, (row.get(id) ?? 0) + val);
		}
	}
	return result;
}

export function totalExpenses(bills: IhmBill[]): number {
	return bills.filter(isExpense).reduce((s, b) => s + b.amount, 0);
}

export interface SettlementTransaction {
	fromIhmId: number; // pays
	toIhmId: number; // receives
	amount: number;
}

/** Python `decimal.ROUND_HALF_DOWN`, part of the 1:1 port below. */
function roundHalfDown(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	const scaled = value * factor;
	const floor = Math.floor(scaled);
	return (scaled - floor > 0.5 + 1e-9 ? floor + 1 : floor) / factor;
}

/** Minimal transaction set that zeroes all balances. 1:1 port of the `debts`
 * Python package (framagit.org/almet/debts, solver.py) that IHM uses
 * internally — IHM has no API endpoint for it. Positive balance = is owed. */
export function settleBalances(members: { ihmId: number; balance: number }[]): SettlementTransaction[] {
	type Entry = [number, number];
	const debiters: Entry[] = [];
	const crediters: Entry[] = [];
	for (const m of members) {
		if (Math.abs(m.balance) < 0.005) continue;
		if (m.balance > 0) crediters.push([m.ihmId, m.balance]);
		else debiters.push([m.ihmId, m.balance]);
	}

	const sumAbs = (list: Entry[]) => list.reduce((s, [, v]) => s + Math.abs(v), 0);
	if (Math.abs(sumAbs(crediters) - sumAbs(debiters)) >= 0.01) {
		console.error('ihm-tracker: balances do not sum to zero, no settlement computed');
		return [];
	}

	const results: SettlementTransaction[] = [];
	while (debiters.length > 0 && crediters.length > 0) {
		debiters.sort((a, b) => a[1] - b[1]);
		crediters.sort((a, b) => b[1] - a[1]);

		const [debiterId, debiterBalance] = debiters.pop()!;
		const [crediterId, crediterBalance] = crediters.pop()!;

		const amount = Math.min(Math.abs(debiterBalance), Math.abs(crediterBalance));
		const dueAmount = roundHalfDown(amount, 2);
		if (dueAmount >= 0.01) results.push({ fromIhmId: debiterId, toIhmId: crediterId, amount: dueAmount });

		const newDebiterBalance = debiterBalance + amount;
		if (newDebiterBalance < 0) debiters.push([debiterId, newDebiterBalance]);

		const newCrediterBalance = crediterBalance - amount;
		if (newCrediterBalance > 0) crediters.push([crediterId, newCrediterBalance]);
	}
	return results;
}
