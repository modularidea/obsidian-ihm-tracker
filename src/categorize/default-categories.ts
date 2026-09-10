import { BillCategoryDef, OTHER_CATEGORY_ID } from '../types';

// Port von haushalt_app/haushub/lib/models/bill_category.dart
// (kDefaultBillCategories) — gleiche ids/labels/keywords, damit ein
// CSV-Export aus der Flutter-App 1:1 in dieses Plugin importierbar ist (und
// umgekehrt), siehe docs/konzept.md "CSV-Kompatibilität".

export const DEFAULT_CATEGORIES: BillCategoryDef[] = [
	{
		id: 'groceries',
		nativeCategoryId: -1, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Lebensmittel',
		emoji: '🛒',
		keywords: [
			'supermarkt', 'markt', 'rewe', 'edeka', 'aldi', 'lidl', 'netto',
			'kaufland', 'penny', 'dm', 'rossmann', 'real', 'tegut', 'denns',
			'alnatura', 'spar', 'billa', 'hofer', 'migros', 'coop', 'norma',
			'nahkauf', 'wochenmarkt',
			// Lebensmittel-Oberbegriffe/Produkte — ergänzt zu den reinen
			// Ladennamen oben, da Belegtitel oft den Einkaufsinhalt statt/
			// zusätzlich zum Laden nennen (z.B. "Karotten" statt "Rewe").
			'gemüse', 'obst', 'frisches obst', 'salat', 'karotte', 'karotten',
			'tomate', 'tomaten', 'kartoffel', 'kartoffeln', 'zwiebel', 'zwiebeln',
			'gurke', 'paprika', 'brokkoli', 'zucchini', 'apfel', 'äpfel',
			'banane', 'bananen', 'orange', 'orangen', 'beeren', 'zitrone',
			'brot', 'brötchen', 'backwaren', 'milch', 'käse', 'joghurt',
			'butter', 'eier', 'wurst', 'fleisch', 'hähnchen', 'fisch',
			'nudeln', 'pasta', 'reis', 'mehl', 'zucker', 'gewürze',
			'getränke', 'wasser', 'saft', 'kaffee', 'tee', 'einkauf',
			'lebensmittel', 'wocheneinkauf',
		],
	},
	{
		id: 'restaurant',
		nativeCategoryId: -12, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Restaurant',
		emoji: '🍽️',
		keywords: [
			'restaurant', 'café', 'imbiss', 'pizza', 'pizzeria', 'burger',
			'sushi', 'bar', 'kneipe', 'döner', 'bistro', 'bäckerei',
			'lieferando', 'wolt', 'uber eats', 'mcdonalds', 'burger king',
		],
	},
	{
		id: 'transport',
		nativeCategoryId: -14, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Transport',
		emoji: '🚗',
		keywords: [
			'bahn', 'db', 'uber', 'taxi', 'bus', 'tram', 'u-bahn', 's-bahn',
			'sprit', 'tanken', 'benzin', 'diesel', 'parken', 'flixbus',
			'fahrkarte', 'ticket', 'sixt', 'nextbike', 'öbb', 'oebb', 'sbb',
		],
	},
	{
		id: 'housing',
		nativeCategoryId: -3, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Haushalt',
		emoji: '🏠',
		keywords: [
			'miete', 'nebenkosten', 'kaution', 'strom', 'stadtwerke', 'gas',
			'internet', 'telekom', 'vodafone', 'o2', 'congstar', 'möbel',
			'ikea', 'rundfunkbeitrag',
		],
	},
	{
		id: 'leisure',
		nativeCategoryId: -5, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Freizeit',
		emoji: '🎉',
		keywords: [
			'kino', 'konzert', 'event', 'party', 'spiel', 'steam', 'netflix',
			'spotify', 'disney+', 'amazon prime', 'hobby', 'sport', 'fitness',
			'gym', 'fitx', 'mcfit', 'schwimmbad',
		],
	},
	{
		id: 'health',
		nativeCategoryId: -6, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Gesundheit',
		emoji: '💊',
		keywords: [
			'arzt', 'apotheke', 'medikament', 'zahnarzt', 'versicherung',
			'krankenkasse', 'physiotherapie',
		],
	},
	{
		id: 'purchases',
		nativeCategoryId: -10, // Cospend-Global-Kategorie (siehe categorize/cospend-category-map.ts)
		label: 'Anschaffungen',
		emoji: '🛍️',
		keywords: ['anschaffung', 'gerät', 'elektronik', 'saturn', 'mediamarkt'],
	},
	{ id: OTHER_CATEGORY_ID, label: 'Sonstiges', emoji: '📦', keywords: [] },
];

/** Erzeugt eine neue, kollisionsfreie Kategorie-id aus einem Label — genutzt
 * beim manuellen Anlegen in den Settings UND beim Auto-Import einer nativ
 * (Cospend-Weboberfläche/MoneyBuster) gesetzten Kategorie in `view/ihm-view.ts`
 * `sync()`. Hier statt in `settings.ts`, damit `view/` es importieren kann
 * ohne einen Zirkel-Import zu `settings.ts` (das seinerseits `IhmView`
 * importiert) aufzumachen. */
export function newCategoryId(label: string): string {
	const stripped = label
		.toLowerCase()
		.normalize('NFKD')
		.split('')
		.filter((ch) => ch.codePointAt(0)! < 0x0300 || ch.codePointAt(0)! > 0x036f)
		.join('');
	const slug = stripped.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
	return `${slug || 'kategorie'}_${Date.now().toString(36)}`;
}
