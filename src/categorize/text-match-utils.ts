// Text-matching helpers, kept identical to haushub's text_match_utils.dart so
// both classifiers behave the same.

/** Folds ä/ö/ü/ß to ae/oe/ue/ss so ASCII-typed and native spellings match. */
export function normalizeText(s: string): string {
	let t = s.toLowerCase().replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue').replaceAll('ß', 'ss');
	t = t.replace(/[^a-z0-9]+/g, ' ').trim();
	return t.replace(/\s+/g, ' ');
}

export function tokenize(s: string): string[] {
	const n = normalizeText(s);
	return n === '' ? [] : n.split(' ');
}

/** Intersection / smaller set (Szymkiewicz–Simpson). Unlike Jaccard, one
 * shared core token ("same shop, different suffix") is enough. */
export function overlapCoefficient(a: string[], b: string[]): number {
	const sa = new Set(a);
	const sb = new Set(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	const inter = [...sa].filter((x) => sb.has(x)).length;
	return inter / Math.min(sa.size, sb.size);
}

/** Pure digit tokens (amounts, dates) carry no category signal but dilute
 * the overlap — drop them before fuzzy matching. */
export function stripNumericTokens(tokens: string[]): string[] {
	return tokens.filter((t) => !/^[0-9]+$/.test(t));
}

/** Word-boundary-safe phrase containment (a raw substring check would match
 * keyword "gas" inside "Gaststätte"). */
export function containsTokenSequence(haystack: string[], needle: string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}
