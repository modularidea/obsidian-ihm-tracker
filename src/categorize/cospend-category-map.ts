// Mapping zwischen den lokalen Plugin-Kategorien (default-categories.ts) und
// Nextcloud Cospends fest verdrahteten globalen Standardkategorien —
// verifiziert gegen cospend-nc-Quellcode
// (lib/Migration/Version000406Date20200426154317.php, julien-nc/cospend-nc,
// Stand 2026-09). MoneyBuster (Android-Client für Cospend UND IHateMoney)
// kennt Name+Icon dieser negativen IDs fest im Client — kein Categories-
// Endpoint auf Server-Seite nötig, damit MoneyBuster sie korrekt anzeigt.
//
// Nur für den WRITE-Pfad zum Server-Fork gedacht (server-patch/, Feld
// `categoryid`). Die Vault-Kategorie-Zuordnung (sync/category-store.ts)
// bleibt die primäre Quelle für dieses Plugin selbst — dieses Mapping ist
// reine Kompatibilitäts-Brücke zu anderen Clients (MoneyBuster, Cospend-Web).

export interface CospendCategory {
	id: number;
	label: string;
	emoji: string;
	color: string;
}

export const COSPEND_GLOBAL_CATEGORIES: CospendCategory[] = [
	{ id: -1, label: 'Grocery', emoji: '🛒', color: '#ffaa00' },
	{ id: -2, label: 'Bar/Party', emoji: '🎉', color: '#aa55ff' },
	{ id: -3, label: 'Rent', emoji: '🏠', color: '#da8733' },
	{ id: -4, label: 'Bill', emoji: '🌩', color: '#4aa6b0' },
	{ id: -5, label: 'Excursion/Culture', emoji: '🚸', color: '#0055ff' },
	{ id: -6, label: 'Health', emoji: '💚', color: '#bf090c' },
	{ id: -10, label: 'Shopping', emoji: '🛍', color: '#e167d1' },
	// -11 (Reimbursement) bewusst ausgelassen — das ist bei IHM schon
	// `bill_type`, kein Kategorie-Konzept.
	{ id: -12, label: 'Restaurant', emoji: '🍴', color: '#d0d5e1' },
	{ id: -13, label: 'Accommodation', emoji: '🛌', color: '#5de1a3' },
	{ id: -14, label: 'Transport', emoji: '🚌', color: '#6f2ee1' },
	{ id: -15, label: 'Sport', emoji: '🎾', color: '#69e177' },
];

/** Lokale Plugin-Kategorie-id (default-categories.ts) -> nächstliegende
 * Cospend-Global-id, oder `null` wenn es keine sinnvolle Entsprechung gibt
 * (z.B. "Sonstiges"/"other" — Cospend hat keine "unklassifiziert"-Kategorie,
 * NULL im `categoryid`-Feld übernimmt exakt diese Bedeutung bereits). */
export const LOCAL_TO_COSPEND_ID: Record<string, number | null> = {
	groceries: -1,
	restaurant: -12,
	transport: -14,
	housing: -3,
	leisure: -5,
	health: -6,
	purchases: -10,
	other: null,
};

/** Rückrichtung, für ein Best-Effort-Label/Icon wenn ein Bill nur ein
 * natives `categoryid` trägt (z.B. eine Bill, die ein anderer Client wie
 * MoneyBuster/Cospend-Web angelegt hat und die der lokale Klassifikator noch
 * nie gesehen hat). */
export function cospendCategoryLabel(id: number): CospendCategory | undefined {
	return COSPEND_GLOBAL_CATEGORIES.find((c) => c.id === id);
}

export function localCategoryToCospendId(localCategoryId: string): number | null {
	return LOCAL_TO_COSPEND_ID[localCategoryId] ?? null;
}

/** Rückrichtung fürs Anzeigen: liefert die lokale Plugin-Kategorie-id, deren
 * Mapping exakt auf `cospendId` zeigt — oder `null`, wenn keine lokale
 * Default-Kategorie diese Cospend-id beansprucht (z.B. -11 Reimbursement,
 * oder eine id, die nur Cospend/MoneyBuster selbst kennt). Nur als
 * Best-Effort-Fallback gedacht, wenn eine Bill (noch) keinen
 * Vault-Kategorie-Eintrag hat — siehe stats/aggregate.ts `categoryOf`. */
export function cospendIdToLocalCategoryId(cospendId: number): string | null {
	for (const [localId, mapped] of Object.entries(LOCAL_TO_COSPEND_ID)) {
		if (mapped === cospendId) return localId;
	}
	return null;
}
