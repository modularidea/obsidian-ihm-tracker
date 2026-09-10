// Zentrales Domänenmodell — Struktur an haushub/lib/models/{bill,member,project,bill_category}.dart
// angelehnt (bewährtes Schema, identische Feldnamen wo sinnvoll), aber ohne
// Flutter-Spezifika (kein copyWith-Boilerplate, kein const-Konstruktor-Zwang).

export interface IhmMember {
	/** IHateMoney-seitige numerische id */
	ihmId: number;
	name: string;
	weight: number;
}

export type IhmBillType = 'expense' | 'reimbursement';

/** Eine IHateMoney-Bill, angereichert um das lokal/gesynct verwaltete Feld
 * `categoryId` (siehe sync/category-store.ts) und optional `nativeCategory`
 * (nur gesetzt wenn Server-Fork mit echtem Feld läuft, siehe docs/konzept.md
 * "Hybrid-Strategie"). */
export interface IhmBill {
	ihmId: number;
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string; // ISO yyyy-mm-dd
	billType: IhmBillType;
	externalLink?: string;
	/** Lokal/vault-gesynctes Kategorie-Mapping — siehe CategoryStore. */
	categoryId?: string;
	/** Rohwert von `categoryid` aus der IHM-API — nur gesetzt, wenn der
	 * verbundene Server das Feld liefert (Fork, siehe server-patch/). Integer,
	 * NICHT String: Wire-Format 1:1 kompatibel zu Nextcloud Cospend/
	 * MoneyBuster (negative IDs = deren fest verdrahtete Standardkategorien,
	 * siehe categorize/cospend-category-map.ts). `null` = Server unterstützt
	 * das Feld, Bill ist aber (noch) unklassifiziert; `undefined` = Server
	 * liefert das Feld gar nicht (Stock-IHM). */
	nativeCategoryId?: number | null;
	/** Nur `backendType === 'cospend'` (Nutzerwunsch 2026-09-10) — referenziert
	 * eine Zeile aus dem projekteigenen `paymentmodes`-Set (Bar/Karte/
	 * Überweisung/...). IHM/lokale Projekte kennen dieses Konzept nicht,
	 * bleibt dort ungenutzt. */
	paymentModeId?: number;
}

export interface BillCategoryDef {
	id: string;
	label: string;
	emoji: string;
	keywords: string[];
	/** Native Kategorie-id für Server, die ein echtes `categoryid`-Feld kennen
	 * (IHM-Server-Fork ODER Nextcloud Cospend, siehe backend/cospend-client.ts
	 * + server-patch/) — EIN Feld für beide statt der alten statischen
	 * `LOCAL_TO_COSPEND_ID`-Tabelle (categorize/cospend-category-map.ts), die
	 * nur die 8 Default-Kategorien kannte und jede selbst angelegte Kategorie
	 * beim Push zu "Unclassified" degradierte (Bug, gefunden 2026-09-10, siehe
	 * docs/bugs.md). Beim Fork: eine der 10 festen `COSPEND_GLOBAL_CATEGORIES`
	 * (vom Nutzer in den Settings gewählt). Bei echtem Cospend: automatisch
	 * gesetzt, sobald die Kategorie einmal nativ gepusht wurde (echte,
	 * projekteigene positive id, siehe `CospendClient.pushCategory()`). */
	nativeCategoryId?: number | null;
}

export const OTHER_CATEGORY_ID = 'other';

/** Eine gelernte Titel→Kategorie-Zuordnung (manuelle Korrektur oder CSV-Import).
 * `updatedAt` ist die Grundlage für die Multi-Client-Merge-Strategie in
 * CategoryStore (siehe docs/konzept.md, Abschnitt "Konfliktauflösung"). */
export interface TrainingDoc {
	text: string;
	categoryId: string;
	updatedAt: string; // ISO-Timestamp
	/** Kurze, stabile Geräte-Kennung — nur für Debug/Konflikt-Log, keine Logik hängt daran. */
	device?: string;
}

/** Persistiertes Kategorie-Mapping für EIN IHM-Projekt: gelernte Zuordnungen
 * + Kategorie-Definitionen + explizite Bill→Kategorie-Overrides (falls die
 * gelernte Klassifikation für eine einzelne Bill manuell übersteuert wurde,
 * ohne dass das den Titel-Klassifikator umtrainieren soll — selten, aber z.B.
 * bei einmaligen Sonderfällen sinnvoll). */
export interface ProjectCategoryData {
	schemaVersion: 1;
	categories: BillCategoryDef[];
	trainingDocs: TrainingDoc[];
	/** ihmBillId (als String-Key) -> { categoryId, updatedAt } */
	billOverrides: Record<string, { categoryId: string; updatedAt: string }>;
}

/** Welches Backend dieses Projekt bedient — steuert, welcher `ExpenseClient`
 * (siehe backend/client.ts) instanziiert wird. Fehlt das Feld (Alt-Daten vor
 * 2026-09-10), gilt `'ihatemoney'` (siehe `normalizeProject()` in settings.ts). */
export type ProjectBackendType = 'ihatemoney' | 'cospend' | 'local';

export interface IhmProjectConfig {
	id: string; // lokale UUID
	name: string;
	emoji: string;
	backendType: ProjectBackendType;
	/** Nur `backendType === 'ihatemoney'`: Server-URL. Nur `'cospend'`:
	 * Nextcloud-Basis-URL (ohne `/index.php/apps/cospend/...`-Suffix). Bei
	 * `'local'` ungenutzt. */
	serverUrl: string;
	projectId: string; // IHM-Projekt-Slug ODER Cospend-Projekt-id (echte id, kein Share-Token)
	password: string; // NIE in ProjectCategoryData/Vault-Datei — nur hier, in data.json. Nur IHM.
	/** Wird per Capability-Probe gesetzt (GET /api/projects/<id> auf gepatchtem
	 * IHM-Server liefert ein zusätzliches Feld) — steuert ob der Client das
	 * native Kategorie-Feld nutzt. Für `backendType === 'cospend'` immer
	 * `true` (echte Server-Kategorien existieren dort strukturell). */
	nativeCategorySupport?: boolean;
	/** Nur `backendType === 'cospend'` — Ergebnis von Nextcloud Login Flow v2
	 * (`docs.nextcloud.com/.../LoginFlow`), NICHT das Nutzer-Passwort selbst
	 * (das sieht das Plugin nie). `loginName`+`appPassword` = Basic-Auth gegen
	 * die `api-priv`-Routen (verifiziert 2026-09-10 gegen echten Server,
	 * siehe docs/ideas.md). */
	cospendLoginName?: string;
	cospendAppPassword?: string;
	/** Zuletzt gewählte "Bezahlt von"-Person — Default-Vorschlag beim
	 * nächsten Anlegen (Nutzer-Feedback 2026-09-09: meist zahlt dieselbe
	 * Person mehrmals hintereinander). */
	lastPayerIhmId?: number;
}

export interface IhmMemberBalance {
	ihmId: number;
	name: string;
	weight: number;
	balance: number;
}
