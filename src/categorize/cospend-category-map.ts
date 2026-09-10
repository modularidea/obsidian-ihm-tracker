import { DEFAULT_CATEGORIES } from './default-categories';

// Nextcloud Cospend's built-in global categories (negative ids, hard-wired in
// Cospend and MoneyBuster). The IHM server fork accepts exactly these ids in
// its `categoryid` field, so other clients show name+icon without any
// categories endpoint. -11 (Reimbursement) is deliberately absent: for IHM
// that is `bill_type`, not a category.

export interface CospendCategory {
	id: number;
	label: string;
	emoji: string;
	color: string;
}

export const COSPEND_GLOBAL_CATEGORIES: CospendCategory[] = [
	{ id: -1, label: 'Grocery', emoji: '🛒', color: '#ffaa00' },
	{ id: -2, label: 'Bar/Party', emoji: '🎉', color: '#aa55ff' },
	{ id: -3, label: 'Rent', emoji: '🏠', color: '#da8733' },
	{ id: -4, label: 'Bill', emoji: '🌩', color: '#4aa6b0' },
	{ id: -5, label: 'Excursion/Culture', emoji: '🚸', color: '#0055ff' },
	{ id: -6, label: 'Health', emoji: '💚', color: '#bf090c' },
	{ id: -10, label: 'Shopping', emoji: '🛍', color: '#e167d1' },
	{ id: -12, label: 'Restaurant', emoji: '🍴', color: '#d0d5e1' },
	{ id: -13, label: 'Accommodation', emoji: '🛌', color: '#5de1a3' },
	{ id: -14, label: 'Transport', emoji: '🚌', color: '#6f2ee1' },
	{ id: -15, label: 'Sport', emoji: '🎾', color: '#69e177' },
];

/** Default category whose seed mapping points at `cospendId`, or null.
 * Display fallback only (see stats/aggregate.ts categoryOf). */
export function cospendIdToLocalCategoryId(cospendId: number): string | null {
	return DEFAULT_CATEGORIES.find((c) => c.nativeCategoryId === cospendId)?.id ?? null;
}
