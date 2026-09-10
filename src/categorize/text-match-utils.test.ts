import { describe, expect, it } from 'vitest';
import { containsTokenSequence, normalizeText, overlapCoefficient, stripNumericTokens, tokenize } from './text-match-utils';

describe('normalizeText', () => {
	it('folds umlauts/ß to ASCII', () => {
		expect(normalizeText('Übernachtung Müller Straße')).toBe('uebernachtung mueller strasse');
	});

	it('treats native umlauts and ASCII spelling the same', () => {
		expect(normalizeText('Übernachtung')).toBe(normalizeText('Uebernachtung'));
	});
});

describe('stripNumericTokens', () => {
	it('drops pure digit tokens, keeps text tokens', () => {
		expect(stripNumericTokens(['rewe', '12', '90210'])).toEqual(['rewe']);
	});
});

describe('containsTokenSequence', () => {
	it('finds a contiguous phrase at any position', () => {
		expect(containsTokenSequence(tokenize('Burger King Hauptbahnhof'), tokenize('burger king'))).toBe(true);
	});

	it('does not match inside a word', () => {
		expect(containsTokenSequence(tokenize('Gaststätte'), tokenize('gas'))).toBe(false);
	});
});

describe('overlapCoefficient', () => {
	it('measures against the smaller set, not the union', () => {
		expect(overlapCoefficient(tokenize('Weinladen Predelli'), tokenize('Weinladen Rossi'))).toBe(0.5);
	});

	it('returns 0 for empty input', () => {
		expect(overlapCoefficient([], ['x'])).toBe(0);
	});
});
