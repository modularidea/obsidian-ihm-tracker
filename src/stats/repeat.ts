import { BillRepeat } from '../types';

// Repeat-date arithmetic shared by the local backend and the UI preview.
// Mirrors the server fork (`next_repeat_date` in models.py): d/w/b step by
// days/weeks, s = 1st and 15th, m/y clamp to the last day of a shorter month.

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string {
	return `${y}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(y: number, m: number): number {
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	const t = new Date(Date.UTC(y, m - 1, d + days));
	return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function addMonths(date: string, months: number): string {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	const total = y * 12 + (m - 1) + months;
	const ny = Math.floor(total / 12);
	const nm = (total % 12) + 1;
	return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Next occurrence after `date` (yyyy-mm-dd) for a Cospend repeat code. */
export function nextRepeatDate(date: string, repeat: BillRepeat, freq = 1): string {
	const n = Math.max(1, Math.floor(freq) || 1);
	switch (repeat) {
		case 'd':
			return addDays(date, n);
		case 'w':
			return addDays(date, 7 * n);
		case 'b':
			return addDays(date, 14 * n);
		case 's': {
			const [y, m, d] = date.split('-').map(Number) as [number, number, number];
			return d < 15 ? iso(y, m, 15) : addMonths(iso(y, m, 1), 1);
		}
		case 'm':
			return addMonths(date, n);
		case 'y':
			return addMonths(date, 12 * n);
		default:
			throw new Error(`unknown repeat code ${repeat}`);
	}
}
