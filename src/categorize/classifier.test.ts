import { describe, expect, it } from 'vitest';
import { classify } from './classifier';
import { DEFAULT_CATEGORIES } from './default-categories';
import { TrainingDoc } from '../types';

describe('classify', () => {
	it('falls back to keyword rules without training data', () => {
		expect(classify('Rewe München', [], DEFAULT_CATEGORIES)).toBe('groceries');
		expect(classify('Burger King Hauptbahnhof', [], DEFAULT_CATEGORIES)).toBe('restaurant');
	});

	it('matches keywords on word boundaries, not as substrings', () => {
		// "gas" (housing) must not match inside "Gaststätte".
		expect(classify('Gaststätte Zum Löwen', [], DEFAULT_CATEGORIES)).toBe('other');
		expect(classify('Stadtwerke Gas Rechnung', [], DEFAULT_CATEGORIES)).toBe('housing');
	});

	it('prefers longer keyword phrases', () => {
		expect(classify('Burger King', [], DEFAULT_CATEGORIES)).toBe('restaurant');
	});

	it('returns "other" when nothing matches', () => {
		expect(classify('xyzabc123', [], DEFAULT_CATEGORIES)).toBe('other');
	});

	it('handles an empty title', () => {
		expect(classify('   ', [], DEFAULT_CATEGORIES)).toBe('other');
	});

	it('exact learned match beats keyword rules', () => {
		const docs: TrainingDoc[] = [{ text: 'Rewe München', categoryId: 'purchases', updatedAt: '2026-01-01T00:00:00Z' }];
		expect(classify('Rewe München', docs, DEFAULT_CATEGORIES)).toBe('purchases');
	});

	it('newest updatedAt wins among exact matches, regardless of array order', () => {
		const docs: TrainingDoc[] = [
			{ text: 'Netflix', categoryId: 'leisure', updatedAt: '2026-02-01T00:00:00Z' },
			{ text: 'Netflix', categoryId: 'purchases', updatedAt: '2026-01-01T00:00:00Z' },
		];
		expect(classify('Netflix', docs, DEFAULT_CATEGORIES)).toBe('leisure');
	});

	it('fuzzy learned match tolerates a different suffix', () => {
		const docs: TrainingDoc[] = [{ text: 'Weinladen Predelli', categoryId: 'purchases', updatedAt: '2026-01-01T00:00:00Z' }];
		expect(classify('Weinladen Rossi', docs, DEFAULT_CATEGORIES)).toBe('purchases');
	});
});
