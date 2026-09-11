import { describe, expect, it } from 'vitest';
import { nextRepeatDate } from './repeat';

describe('nextRepeatDate', () => {
	it('steps days, weeks and bi-weekly', () => {
		expect(nextRepeatDate('2026-01-30', 'd', 3)).toBe('2026-02-02');
		expect(nextRepeatDate('2026-01-01', 'w')).toBe('2026-01-08');
		expect(nextRepeatDate('2026-01-01', 'b')).toBe('2026-01-15');
	});

	it('clamps month/year steps to the last day of a shorter month', () => {
		expect(nextRepeatDate('2026-01-31', 'm')).toBe('2026-02-28');
		expect(nextRepeatDate('2026-11-30', 'm', 3)).toBe('2027-02-28');
		expect(nextRepeatDate('2024-02-29', 'y')).toBe('2025-02-28');
	});

	it('semi-monthly alternates between the 1st and the 15th', () => {
		expect(nextRepeatDate('2026-03-03', 's')).toBe('2026-03-15');
		expect(nextRepeatDate('2026-03-15', 's')).toBe('2026-04-01');
		expect(nextRepeatDate('2026-12-20', 's')).toBe('2027-01-01');
	});
});
