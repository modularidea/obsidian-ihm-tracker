import { describe, expect, it } from 'vitest';
import { healDefaultMappings } from './category-store';
import { ProjectCategoryData } from '../types';

function data(partial: Partial<ProjectCategoryData>): ProjectCategoryData {
	return { schemaVersion: 1, categories: [], trainingDocs: [], billOverrides: {}, deletedCategoryIds: {}, ...partial };
}

describe('healDefaultMappings', () => {
	it('restores a nulled default mapping', () => {
		const healed = healDefaultMappings(data({ categories: [{ id: 'groceries', label: 'Lebensmittel', emoji: '🛒', keywords: [], nativeCategoryId: null }] }));
		expect(healed.categories[0]?.nativeCategoryId).toBe(-1);
	});

	it('folds an auto-imported duplicate into the default and re-points references', () => {
		const healed = healDefaultMappings(
			data({
				categories: [
					{ id: 'groceries', label: 'Lebensmittel', emoji: '🛒', keywords: [], nativeCategoryId: null },
					{ id: 'native--1', label: 'Grocery', emoji: '🛒', keywords: [], nativeCategoryId: -1 },
				],
				billOverrides: { '7': { categoryId: 'native--1', updatedAt: '2026-01-01T00:00:00Z' } },
				trainingDocs: [{ text: 'Rewe', categoryId: 'native--1', updatedAt: '2026-01-01T00:00:00Z' }],
			}),
		);
		expect(healed.categories.map((c) => c.id)).toEqual(['groceries']);
		expect(healed.categories[0]?.nativeCategoryId).toBe(-1);
		expect(healed.billOverrides['7']?.categoryId).toBe('groceries');
		expect(healed.trainingDocs[0]?.categoryId).toBe('groceries');
		expect(Object.keys(healed.deletedCategoryIds ?? {})).toEqual(['native--1']);
	});

	it('resets a default that points at a server-side (positive) duplicate', () => {
		const healed = healDefaultMappings(data({ categories: [{ id: 'groceries', label: 'Lebensmittel', emoji: '🛒', keywords: [], nativeCategoryId: 7 }] }));
		expect(healed.categories[0]?.nativeCategoryId).toBe(-1);
	});

	it('leaves a default that was deliberately remapped to another global id alone', () => {
		const healed = healDefaultMappings(data({ categories: [{ id: 'groceries', label: 'Lebensmittel', emoji: '🛒', keywords: [], nativeCategoryId: -10 }] }));
		expect(healed.categories[0]?.nativeCategoryId).toBe(-10);
	});
});
