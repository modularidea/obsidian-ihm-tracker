import { describe, expect, it } from 'vitest';
import { byCategory, byMonth, computeShares, isExpense, memberStats, pivotByPersonMonth, settleBalances } from './aggregate';
import { IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';

const members: IhmMemberRaw[] = [
	{ ihmId: 1, name: 'Anna', weight: 1, balance: 0, activated: true },
	{ ihmId: 2, name: 'Ben', weight: 1, balance: 0, activated: true },
];

function bill(partial: Partial<IhmBill>): IhmBill {
	return {
		ihmId: 1,
		what: 'Test',
		payerIhmId: 1,
		owerIhmIds: [1, 2],
		amount: 100,
		date: '2026-01-15',
		billType: 'expense',
		categoryId: 'groceries',
		...partial,
	};
}

describe('isExpense', () => {
	it('excludes reimbursements', () => {
		expect(isExpense(bill({ billType: 'expense' }))).toBe(true);
		expect(isExpense(bill({ billType: 'reimbursement' }))).toBe(false);
	});
});

describe('byMonth / byCategory', () => {
	it('groups by yyyy-mm / category and sums amounts', () => {
		const bills = [bill({ date: '2026-01-05', amount: 30 }), bill({ date: '2026-01-20', amount: 20 }), bill({ date: '2026-02-01', amount: 10 })];
		expect(byMonth(bills)).toEqual(new Map([['2026-01', 50], ['2026-02', 10]]));
		expect(byCategory(bills)).toEqual(new Map([['groceries', 60]]));
	});
});

describe('computeShares', () => {
	it('splits evenly with equal weights', () => {
		const shares = computeShares(bill({ amount: 100, owerIhmIds: [1, 2] }), () => 1);
		expect(shares.get(1)).toBe(50);
		expect(shares.get(2)).toBe(50);
	});

	it('splits proportionally to member weight', () => {
		const shares = computeShares(bill({ amount: 90, owerIhmIds: [1, 2] }), (id) => (id === 1 ? 2 : 1));
		expect(shares.get(1)).toBe(60);
		expect(shares.get(2)).toBe(30);
	});

	it('returns an empty map for no owers', () => {
		expect(computeShares(bill({ owerIhmIds: [] }), () => 1).size).toBe(0);
	});
});

describe('memberStats', () => {
	it('paid = sum as payer, share = weighted consumption', () => {
		const stats = memberStats([bill({ payerIhmId: 1, amount: 100, owerIhmIds: [1, 2] })], members);
		expect(stats.paid.get(1)).toBe(100);
		expect(stats.share.get(1)).toBe(50);
		expect(stats.share.get(2)).toBe(50);
	});
});

describe('pivotByPersonMonth', () => {
	it('metric "paid": only the payer gets the full amount', () => {
		const pivot = pivotByPersonMonth([bill({ date: '2026-01-10', payerIhmId: 1, amount: 40 })], members, { metric: 'paid' });
		expect(pivot.get('2026-01')?.get(1)).toBe(40);
		expect(pivot.get('2026-01')?.get(2)).toBeUndefined();
	});

	it('categoryId filter drops other bills', () => {
		const bills = [bill({ categoryId: 'groceries', amount: 10 }), bill({ categoryId: 'restaurant', amount: 20 })];
		const pivot = pivotByPersonMonth(bills, members, { metric: 'share', categoryId: 'restaurant' });
		expect(pivot.get('2026-01')?.get(1)).toBe(10);
	});
});

describe('settleBalances', () => {
	it('two debtors, one creditor: minimal transactions matching the balances', () => {
		const tx = settleBalances([
			{ ihmId: 1, balance: -30 },
			{ ihmId: 2, balance: -20 },
			{ ihmId: 3, balance: 50 },
		]);
		expect(tx).toEqual([
			{ fromIhmId: 2, toIhmId: 3, amount: 20 },
			{ fromIhmId: 1, toIhmId: 3, amount: 30 },
		]);
	});

	it('already settled balances produce no transactions', () => {
		expect(settleBalances([{ ihmId: 1, balance: 0 }, { ihmId: 2, balance: 0 }])).toEqual([]);
	});

	it('balances that do not sum to zero yield an empty array instead of throwing', () => {
		expect(settleBalances([{ ihmId: 1, balance: -10 }, { ihmId: 2, balance: 5 }])).toEqual([]);
	});
});
