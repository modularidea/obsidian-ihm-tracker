import { describe, expect, it } from 'vitest';
import {
	containsTokenSequence,
	normalizeText,
	overlapCoefficient,
	stripNumericTokens,
	tokenize,
} from './text-match-utils';

describe('normalizeText', () => {
	it('faltet Umlaute/ß auf ASCII', () => {
		expect(normalizeText('Übernachtung Müller Straße')).toBe('uebernachtung mueller strasse');
	});

	it('matched native Umlaute und ASCII-getippte Schreibung gleich', () => {
		expect(normalizeText('Übernachtung')).toBe(normalizeText('Uebernachtung'));
	});
});

describe('stripNumericTokens', () => {
	it('entfernt reine Zahlen-Tokens, lässt Text-Tokens stehen', () => {
		expect(stripNumericTokens(['rewe', '12', '90210'])).toEqual(['rewe']);
	});
});

describe('containsTokenSequence', () => {
	it('findet zusammenhängende Wortfolge an beliebiger Position', () => {
		expect(containsTokenSequence(tokenize('Burger King Hauptbahnhof'), tokenize('burger king'))).toBe(true);
	});

	it('matched NICHT als Teilwort (Wortgrenzen-sicher)', () => {
		expect(containsTokenSequence(tokenize('Gaststätte'), tokenize('gas'))).toBe(false);
	});
});

describe('overlapCoefficient', () => {
	it('ignoriert die Gesamtlänge, zählt nur den Anteil an der kleineren Menge', () => {
		const a = tokenize('Weinladen Predelli');
		const b = tokenize('Weinladen Rossi');
		expect(overlapCoefficient(a, b)).toBe(0.5); // 1 gemeinsames Token / kleinere Menge (2)
	});

	it('liefert 0 bei leerer Eingabe', () => {
		expect(overlapCoefficient([], ['x'])).toBe(0);
	});
});
