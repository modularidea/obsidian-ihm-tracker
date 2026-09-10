// Domain model shared by all backends and the UI.

export type IhmBillType = 'expense' | 'reimbursement';

export interface IhmBill {
	ihmId: number;
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string; // ISO yyyy-mm-dd
	billType: IhmBillType;
	externalLink?: string;
	/** Plugin-side category (vault-synced, see sync/category-store.ts). */
	categoryId?: string;
	/** Server-side category where the backend has one (IHM fork / Cospend).
	 * Integer, wire-compatible with Cospend/MoneyBuster (negative ids = their
	 * built-in global categories). `null` = server has the field but the bill
	 * is unclassified; `undefined` = server has no such field (stock IHM). */
	nativeCategoryId?: number | null;
	/** Cospend only — id from the project's own payment-mode set. */
	paymentModeId?: number;
}

export interface BillCategoryDef {
	id: string;
	label: string;
	emoji: string;
	keywords: string[];
	/** Server-side id for backends with a native category field. IHM fork: one
	 * of the fixed COSPEND_GLOBAL_CATEGORIES (chosen in settings). Cospend: set
	 * automatically once the category has been pushed to the project. */
	nativeCategoryId?: number | null;
}

export const OTHER_CATEGORY_ID = 'other';

/** One learned title → category assignment. `updatedAt` drives the
 * multi-device merge in CategoryStore. */
export interface TrainingDoc {
	text: string;
	categoryId: string;
	updatedAt: string; // ISO timestamp
	device?: string;
}

/** Persisted category data for one project (a vault file). */
export interface ProjectCategoryData {
	schemaVersion: 1;
	categories: BillCategoryDef[];
	trainingDocs: TrainingDoc[];
	/** bill id (string key) → explicit override that beats the classifier */
	billOverrides: Record<string, { categoryId: string; updatedAt: string }>;
	/** category id → ISO deletedAt. Needed because merge() unions categories
	 * from both sides — without a tombstone a deleted category would come back
	 * from the other device's copy. */
	deletedCategoryIds?: Record<string, string>;
}

export type ProjectBackendType = 'ihatemoney' | 'cospend' | 'local';

export interface IhmProjectConfig {
	id: string; // local UUID
	name: string;
	emoji: string;
	/** Missing on projects created before the backend abstraction existed —
	 * migrated to 'ihatemoney' in main.ts loadSettings(). */
	backendType: ProjectBackendType;
	/** IHM: server URL. Cospend: Nextcloud base URL. Local: unused. */
	serverUrl: string;
	/** IHM project slug or Cospend project id. */
	projectId: string;
	/** IHM only. Lives in data.json, never in the vault category file. */
	password: string;
	/** Server exposes a native category field. Detected from fetched bills in
	 * IhmView.sync(), or set explicitly for Cospend. */
	nativeCategorySupport?: boolean;
	/** Cospend only — result of Nextcloud Login Flow v2 (an app password, never
	 * the account password). */
	cospendLoginName?: string;
	cospendAppPassword?: string;
	/** Last chosen payer, pre-selected for the next new bill. */
	lastPayerIhmId?: number;
}
