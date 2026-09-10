import { BillCategoryDef, OTHER_CATEGORY_ID, TrainingDoc } from '../types';
import { containsTokenSequence, normalizeText, overlapCoefficient, stripNumericTokens, tokenize } from './text-match-utils';

// Title → category. Port of haushub's bill_category_service.dart so both
// apps suggest the same category for the same title. First hit wins:
//   1. exact learned match (newest correction wins)
//   2. fuzzy learned match (overlap coefficient >= 0.5)
//   3. keyword rules (longest keyword phrase first, word-boundary safe)
//   4. "other"

export function classify(title: string, trainingDocs: TrainingDoc[], categories: BillCategoryDef[]): string {
	const key = normalizeText(title);
	if (key === '') return OTHER_CATEGORY_ID;

	// Pick by updatedAt, not array position: after a multi-device merge the
	// array order says nothing about recency.
	let exactMatch: TrainingDoc | null = null;
	for (const d of trainingDocs) {
		if (normalizeText(d.text) !== key) continue;
		if (exactMatch === null || d.updatedAt > exactMatch.updatedAt) exactMatch = d;
	}
	if (exactMatch !== null) return exactMatch.categoryId;

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
