// Domänenfreie Text-Matching-Helfer — 1:1-Port von
// haushalt_app/haushub/lib/services/text_match_utils.dart (siehe dort für
// Herleitung/Begründung jeder Funktion). Bewusst identisch gehalten, damit
// beide Klassifikatoren (Flutter-App, dieses Plugin) bei gleichem Titel
// dieselbe Kategorie vorschlagen.

/** Faltet ä/ö/ü/ß auf ae/oe/ue/ss, damit z.B. CSV-Importe mit ASCII-Schreibung
 * auf dieselbe Normalform treffen wie native Umlaute. */
export function normalizeText(s: string): string {
	let t = s
		.toLowerCase()
		.replaceAll('ä', 'ae')
		.replaceAll('ö', 'oe')
		.replaceAll('ü', 'ue')
		.replaceAll('ß', 'ss');
	t = t.replace(/[^a-z0-9]+/g, ' ').trim();
	return t.replace(/\s+/g, ' ');
}

export function tokenize(s: string): string[] {
	const n = normalizeText(s);
	return n === '' ? [] : n.split(' ');
}

export function jaccard(a: string[], b: string[]): number {
	const sa = new Set(a);
	const sb = new Set(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	const inter = [...sa].filter((x) => sb.has(x)).length;
	const union = new Set([...sa, ...sb]).size;
	return union === 0 ? 0 : inter / union;
}

/** Schnittmenge / kleinere Menge (Szymkiewicz–Simpson) statt Jaccard — verzeiht
 * "gleicher Laden, anderer Zusatz" viel besser: ein einzelnes gemeinsames
 * Kern-Token reicht, statt an der Gesamtlänge beider Titel verwässert zu
 * werden. */
export function overlapCoefficient(a: string[], b: string[]): number {
	const sa = new Set(a);
	const sb = new Set(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	const inter = [...sa].filter((x) => sb.has(x)).length;
	const smaller = Math.min(sa.size, sb.size);
	return smaller === 0 ? 0 : inter / smaller;
}

/** Reine Ziffern-Tokens tragen kein Kategorie-Signal (Beträge/Daten im Titel),
 * verwässern aber den Token-Overlap — vor Fuzzy-Vergleichen raus. */
export function stripNumericTokens(tokens: string[]): string[] {
	return tokens.filter((t) => !/^[0-9]+$/.test(t));
}

/** Prüft, ob `needle` als zusammenhängende Wortfolge in `haystack` vorkommt —
 * Wortgrenzen-sicher, im Gegensatz zu rohem String-Substring (das würde z.B.
 * Keyword "gas" fälschlich in "Gaststätte" matchen). */
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
