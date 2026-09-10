import { BillCategoryDef, OTHER_CATEGORY_ID, TrainingDoc } from '../types';
import {
	containsTokenSequence,
	normalizeText,
	overlapCoefficient,
	stripNumericTokens,
	tokenize,
} from './text-match-utils';

// Port von haushalt_app/haushub/lib/services/bill_category_service.dart
// (classify()). Pipeline, erster Treffer gewinnt:
//   1. Exakter gelernter Match (neueste Korrektur zuerst)
//   2. Fuzzy gelernter Match (Overlap-Koeffizient >= 0.5)
//   3. Keyword-Regeln (längste Keyword-Wortfolge zuerst, wortgrenzen-sicher)
//   4. Fallback: "Sonstiges"
//
// Naive-Bayes-Stufe aus dem ihatemoney-dashboard-Vorbild (JS) bewusst NICHT
// übernommen für v0.1 — bei kleinem, unausgewogenem Trainingsset laut dessen
// eigener Doku (docs/README.md "Bekannte Grenze") mehr Fallstrick als Nutzen;
// kann in Phase 2 ergänzt werden, siehe docs/ideas.md.

export function classify(
	title: string,
	trainingDocs: TrainingDoc[],
	categories: BillCategoryDef[],
): string {
	const key = normalizeText(title);
	if (key === '') return OTHER_CATEGORY_ID;

	// 1. Exact learned match — neueste Korrektur gewinnt. Auswahl über
	// `updatedAt` statt Array-Position: nach einem Merge zweier Geräte-Stände
	// (siehe sync/category-store.ts) sagt die Reihenfolge im Array nichts mehr
	// darüber aus, welcher Eintrag zuletzt bearbeitet wurde.
	let exactMatch: TrainingDoc | null = null;
	for (const d of trainingDocs) {
		if (normalizeText(d.text) !== key) continue;
		if (exactMatch === null || d.updatedAt > exactMatch.updatedAt) exactMatch = d;
	}
	if (exactMatch !== null) return exactMatch.categoryId;

	// 2. Fuzzy learned match.
	const toks = stripNumericTokens(tokenize(title));
	let bestLabel: string | null = null;
	let bestScore = 0.5;
	for (const d of trainingDocs) {
		const s = overlapCoefficient(toks, stripNumericTokens(tokenize(d.text)));
		if (s >= bestScore) {
			bestScore = s;
			bestLabel = d.categoryId;
		}
	}
	if (bestLabel !== null) return bestLabel;

	// 3. Keyword-Regeln — längste Keyword-Wortfolge zuerst (z.B. "burger king"
	// vor "burger"), Wortgrenzen-sicherer Vergleich statt rohem Substring.
	const titleTokens = tokenize(title);
	const index: { kwToks: string[]; catId: string }[] = [];
	for (const cat of categories) {
		if (cat.id === OTHER_CATEGORY_ID) continue;
		for (const kw of cat.keywords) {
			const kwToks = tokenize(kw);
			if (kwToks.length > 0) index.push({ kwToks, catId: cat.id });
		}
	}
	index.sort((a, b) => b.kwToks.length - a.kwToks.length);
	for (const entry of index) {
		if (containsTokenSequence(titleTokens, entry.kwToks)) return entry.catId;
	}

	return OTHER_CATEGORY_ID;
}
