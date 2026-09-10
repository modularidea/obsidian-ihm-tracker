import { describe, expect, it } from 'vitest';
import { classify } from './classifier';
import { DEFAULT_CATEGORIES } from './default-categories';
import { TrainingDoc } from '../types';

describe('classify', () => {
	it('fällt ohne Trainingsdaten auf Keyword-Regeln zurück', () => {
		expect(classify('Rewe München', [], DEFAULT_CATEGORIES)).toBe('groceries');
		expect(classify('Burger King Hauptbahnhof', [], DEFAULT_CATEGORIES)).toBe('restaurant');
	});

	it('matched Keywords wortgrenzen-sicher, nicht als Substring', () => {
		// "gas" ist Keyword für "housing" — darf NICHT in "Gaststätte" matchen
		// (reiner Substring-Vergleich würde hier fälschlich "housing" liefern).
		// Kein anderes Default-Keyword passt auf "Gaststätte Zum Löwen" -> "other".
		expect(classify('Gaststätte Zum Löwen', [], DEFAULT_CATEGORIES)).toBe('other');
		// Als eigenständiges Wort matcht "gas" dagegen korrekt.
		expect(classify('Stadtwerke Gas Rechnung', [], DEFAULT_CATEGORIES)).toBe('housing');
	});

	it('bevorzugt längere Keyword-Wortfolgen vor kürzeren', () => {
		expect(classify('Burger King', [], DEFAULT_CATEGORIES)).toBe('restaurant');
	});

	it('fällt ohne jeden Treffer auf "other" zurück', () => {
		expect(classify('xyzabc123', [], DEFAULT_CATEGORIES)).toBe('other');
	});

	it('leerer Titel -> other, ohne Crash', () => {
		expect(classify('   ', [], DEFAULT_CATEGORIES)).toBe('other');
	});

	it('exakter gelernter Match schlägt Keyword-Regel', () => {
		const docs: TrainingDoc[] = [{ text: 'Rewe München', categoryId: 'purchases', updatedAt: '2026-01-01T00:00:00Z' }];
		expect(classify('Rewe München', docs, DEFAULT_CATEGORIES)).toBe('purchases');
	});

	it('bei mehreren exakten Matches gewinnt der mit dem neueren updatedAt (nicht Array-Position)', () => {
		const docs: TrainingDoc[] = [
			{ text: 'Netflix', categoryId: 'leisure', updatedAt: '2026-02-01T00:00:00Z' },
			{ text: 'Netflix', categoryId: 'purchases', updatedAt: '2026-01-01T00:00:00Z' },
		];
		// Der ältere Eintrag steht zufällig zuerst im Array -> reine Array-Reihenfolge
		// würde hier "purchases" liefern, wenn man rückwärts iteriert; korrekt ist die
		// neuere Korrektur "leisure" (2026-02 > 2026-01), unabhängig von der Position.
		expect(classify('Netflix', docs, DEFAULT_CATEGORIES)).toBe('leisure');
	});

	it('fuzzy learned match verzeiht abweichenden Zusatz im Titel', () => {
		const docs: TrainingDoc[] = [
			{ text: 'Weinladen Predelli', categoryId: 'purchases', updatedAt: '2026-01-01T00:00:00Z' },
		];
		expect(classify('Weinladen Rossi', docs, DEFAULT_CATEGORIES)).toBe('purchases');
	});
});
