import { describe, expect, it } from 'vitest';
import { cospendIdToLocalCategoryId, localCategoryToCospendId } from './cospend-category-map';

describe('localCategoryToCospendId', () => {
	it('mapped bekannte Default-Kategorien auf Cospend-Global-IDs', () => {
		expect(localCategoryToCospendId('groceries')).toBe(-1);
		expect(localCategoryToCospendId('restaurant')).toBe(-12);
	});

	it('"other" und unbekannte ids -> null (keine Cospend-Entsprechung)', () => {
		expect(localCategoryToCospendId('other')).toBeNull();
		expect(localCategoryToCospendId('does-not-exist')).toBeNull();
	});
});

describe('cospendIdToLocalCategoryId (Rückrichtung)', () => {
	it('findet die lokale Kategorie für eine bekannte Cospend-id', () => {
		expect(cospendIdToLocalCategoryId(-1)).toBe('groceries');
		expect(cospendIdToLocalCategoryId(-14)).toBe('transport');
	});

	it('unbekannte/nicht gemappte ids (z.B. -11 Reimbursement) -> null', () => {
		expect(cospendIdToLocalCategoryId(-11)).toBeNull();
		expect(cospendIdToLocalCategoryId(999)).toBeNull();
	});
});
