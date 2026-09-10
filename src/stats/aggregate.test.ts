import { describe, expect, it } from 'vitest';
import { byCategory, byMonth, computeShares, isExpense, memberStats, pivotByPersonMonth, settleBalances } from './aggregate';
import { IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';

const members: IhmMemberRaw[] = [
	{ ihmId: 1, name: 'Anna', weight: 1, balance: 0 },
	{ ihmId: 2, name: 'Ben', weight: 1, balance: 0 },
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
	it('filtert Reimbursement-Bills raus', () => {
		expect(isExpense(bill({ billType: 'expense' }))).toBe(true);
		expect(isExpense(bill({ billType: 'reimbursement' }))).toBe(false);
	});
});

describe('byMonth / byCategory', () => {
	it('gruppiert nach yyyy-mm bzw. Kategorie und summiert Beträge', () => {
		const bills = [bill({ date: '2026-01-05', amount: 30 }), bill({ date: '2026-01-20', amount: 20 }), bill({ date: '2026-02-01', amount: 10 })];
		expect(byMonth(bills)).toEqual(new Map([['2026-01', 50], ['2026-02', 10]]));
		expect(byCategory(bills)).toEqual(new Map([['groceries', 60]]));
	});
});

describe('computeShares', () => {
	it('teilt gleichmäßig unter owers bei gleichem Gewicht', () => {
		const b = bill({ amount: 100, owerIhmIds: [1, 2] });
		const shares = computeShares(b, () => 1);
		expect(shares.get(1)).toBe(50);
		expect(shares.get(2)).toBe(50);
	});

	it('gewichtet proportional bei unterschiedlichem Member.weight', () => {
		const b = bill({ amount: 90, owerIhmIds: [1, 2] });
		const weightOf = (id: number) => (id === 1 ? 2 : 1); // Anna zählt doppelt
		const shares = computeShares(b, weightOf);
		expect(shares.get(1)).toBe(60);
		expect(shares.get(2)).toBe(30);
	});

	it('leere owers -> leere Map, kein Crash durch Division durch 0', () => {
		const b = bill({ owerIhmIds: [] });
		expect(computeShares(b, () => 1).size).toBe(0);
	});
});

describe('memberStats', () => {
	it('paid = Summe der als payer bezahlten Bills, share = anteiliger Verbrauch', () => {
		const bills = [bill({ payerIhmId: 1, amount: 100, owerIhmIds: [1, 2] })];
		const stats = memberStats(bills, members);
		expect(stats.paid.get(1)).toBe(100);
		expect(stats.share.get(1)).toBe(50);
		expect(stats.share.get(2)).toBe(50);
	});
});

describe('pivotByPersonMonth', () => {
	it('metric "paid": nur der Zahler bekommt den vollen Betrag im jeweiligen Monat', () => {
		const bills = [bill({ date: '2026-01-10', payerIhmId: 1, amount: 40 })];
		const pivot = pivotByPersonMonth(bills, members, { metric: 'paid' });
		expect(pivot.get('2026-01')?.get(1)).toBe(40);
		expect(pivot.get('2026-01')?.get(2)).toBeUndefined();
	});

	it('categoryId-Filter lässt nicht passende Bills weg', () => {
		const bills = [bill({ categoryId: 'groceries', amount: 10 }), bill({ categoryId: 'restaurant', amount: 20 })];
		const pivot = pivotByPersonMonth(bills, members, { metric: 'share', categoryId: 'restaurant' });
		expect(pivot.get('2026-01')?.get(1)).toBe(10); // 20 / 2 owers
	});
});

describe('settleBalances', () => {
	it('zwei Schuldner, ein Gläubiger: minimale Transaktionen, Beträge stimmen mit Salden überein', () => {
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

	it('bereits ausgeglichene Salden (0) ergeben keine Transaktionen', () => {
		expect(settleBalances([{ ihmId: 1, balance: 0 }, { ihmId: 2, balance: 0 }])).toEqual([]);
	});

	it('unausgeglichene Salden (Rundungsfehler > 1 Cent) -> leeres Array statt Crash', () => {
		const tx = settleBalances([
			{ ihmId: 1, balance: -10 },
			{ ihmId: 2, balance: 5 },
		]);
		expect(tx).toEqual([]);
	});
});
