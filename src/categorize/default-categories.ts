import { BillCategoryDef, OTHER_CATEGORY_ID } from '../types';

// Seed categories for a new project. ids are stable (CSV round-trips with the
// haushub app rely on them); labels can be renamed in settings. The keyword
// lists are tuned for German-speaking households (shop names) plus generic
// English terms. `nativeCategoryId` = matching Cospend/MoneyBuster global id.

export const DEFAULT_CATEGORIES: BillCategoryDef[] = [
	{
		id: 'groceries',
		nativeCategoryId: -1,
		label: 'Groceries',
		emoji: '🛒',
		keywords: [
			'supermarkt', 'supermarket', 'groceries', 'markt', 'rewe', 'edeka', 'aldi', 'lidl', 'netto',
			'kaufland', 'penny', 'dm', 'rossmann', 'real', 'tegut', 'denns',
			'alnatura', 'spar', 'billa', 'hofer', 'migros', 'coop', 'norma',
			'nahkauf', 'wochenmarkt',
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
		nativeCategoryId: -12,
		label: 'Restaurant',
		emoji: '🍽️',
		keywords: [
			'restaurant', 'café', 'cafe', 'imbiss', 'pizza', 'pizzeria', 'burger',
			'sushi', 'bar', 'kneipe', 'döner', 'bistro', 'bäckerei', 'takeaway', 'delivery',
			'lieferando', 'wolt', 'uber eats', 'mcdonalds', 'burger king',
		],
	},
	{
		id: 'transport',
		nativeCategoryId: -14,
		label: 'Transport',
		emoji: '🚗',
		keywords: [
			'bahn', 'db', 'uber', 'taxi', 'bus', 'tram', 'u-bahn', 's-bahn', 'train', 'fuel',
			'sprit', 'tanken', 'benzin', 'diesel', 'parken', 'parking', 'flixbus',
			'fahrkarte', 'ticket', 'sixt', 'nextbike', 'öbb', 'oebb', 'sbb',
		],
	},
	{
		id: 'housing',
		nativeCategoryId: -3,
		label: 'Housing',
		emoji: '🏠',
		keywords: [
			'miete', 'rent', 'nebenkosten', 'kaution', 'strom', 'electricity', 'stadtwerke', 'gas',
			'internet', 'telekom', 'vodafone', 'o2', 'congstar', 'möbel',
			'ikea', 'rundfunkbeitrag',
		],
	},
	{
		id: 'leisure',
		nativeCategoryId: -5,
		label: 'Leisure',
		emoji: '🎉',
		keywords: [
			'kino', 'cinema', 'konzert', 'concert', 'event', 'party', 'spiel', 'steam', 'netflix',
			'spotify', 'disney+', 'amazon prime', 'hobby', 'sport', 'fitness',
			'gym', 'fitx', 'mcfit', 'schwimmbad',
		],
	},
	{
		id: 'health',
		nativeCategoryId: -6,
		label: 'Health',
		emoji: '💊',
		keywords: [
			'arzt', 'doctor', 'apotheke', 'pharmacy', 'medikament', 'zahnarzt', 'dentist', 'versicherung',
			'krankenkasse', 'physiotherapie',
		],
	},
	{
		id: 'purchases',
		nativeCategoryId: -10,
		label: 'Purchases',
		emoji: '🛍️',
		keywords: ['anschaffung', 'gerät', 'elektronik', 'electronics', 'saturn', 'mediamarkt'],
	},
	{ id: OTHER_CATEGORY_ID, label: 'Other', emoji: '📦', keywords: [] },
];

/** Collision-free category id from a label (settings "add category"). Lives
 * here rather than in settings.ts so view/ can import it without a cycle. */
export function newCategoryId(label: string): string {
	const stripped = label
		.toLowerCase()
		.normalize('NFKD')
		.split('')
		.filter((ch) => ch.codePointAt(0)! < 0x0300 || ch.codePointAt(0)! > 0x036f)
		.join('');
	const slug = stripped.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
	return `${slug || 'category'}_${Date.now().toString(36)}`;
}
