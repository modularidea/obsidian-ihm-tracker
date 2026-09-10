// Locale-aware formatting. The UI language is English; numbers and dates
// follow the system locale (like any desktop app).

/** Falls back to EUR when `currency` is not a valid ISO-4217 code (Cospend's
 * currency name is free text). */
export function formatCurrency(value: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
	} catch {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(value);
	}
}

/** Decimal separator of the system locale ("," or "."). */
export function decimalSeparator(): string {
	return new Intl.NumberFormat(undefined).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';
}

/** "September 2026" / "Sep 2026" for a yyyy-mm key. */
export function monthLabel(key: string, style: 'long' | 'short'): string {
	const [y, m] = key.split('-');
	return new Intl.DateTimeFormat(undefined, { month: style, year: 'numeric' }).format(new Date(Number(y), Number(m) - 1, 1));
}

/** Medium date ("Sep 9, 2026" / "09.09.2026") for an ISO yyyy-mm-dd string. */
export function formatDate(isoDate: string): string {
	const [y, m, d] = isoDate.split('-').map(Number);
	if (!y || !m || !d) return isoDate;
	return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(y, m - 1, d));
}
