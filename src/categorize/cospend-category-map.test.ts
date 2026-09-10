import { describe, expect, it } from 'vitest';
import { cospendIdToLocalCategoryId } from './cospend-category-map';

describe('cospendIdToLocalCategoryId', () => {
	it('maps a known Cospend global id to the seeded default category', () => {
		expect(cospendIdToLocalCategoryId(-1)).toBe('groceries');
		expect(cospendIdToLocalCategoryId(-14)).toBe('transport');
	});

	it('returns null for unmapped ids (e.g. -11 reimbursement)', () => {
		expect(cospendIdToLocalCategoryId(-11)).toBeNull();
		expect(cospendIdToLocalCategoryId(999)).toBeNull();
	});
});
