import type { IhmBill, BillCategoryDef } from '../types';
import type { IhmMemberRaw, IhmBillCreate } from '../ihm-api/client';
import type { SettlementTransaction } from '../stats/aggregate';

/** Optional server capabilities. IHM fork advertises them in the project
 * info (`features`), Cospend has all of them, stock IHM none. */
export type ServerFeature = 'categoryid' | 'categories' | 'paymentmodes' | 'settle' | 'repeat';

// Common interface for the three backends (IHateMoney, Cospend, local).
// Optional members exist only where the backend has a real server-side
// counterpart; callers check `client.x?.()`.
export interface ExpenseClient {
	testConnection(): Promise<boolean>;
	fetchCurrency(): Promise<string>;
	probeNativeCategorySupport(): Promise<boolean>;
	fetchMembers(): Promise<IhmMemberRaw[]>;
	fetchBills(): Promise<IhmBill[]>;
	createBill(bill: IhmBillCreate): Promise<number>;
	updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void>;
	deleteBill(ihmBillId: number): Promise<void>;
	createMember(name: string): Promise<number>;
	updateMember(ihmMemberId: number, name: string): Promise<void>;
	deleteMember(ihmMemberId: number): Promise<void>;
	/** Server capabilities; missing = none. */
	fetchFeatures?(): Promise<Set<ServerFeature>>;
	/** Server-side settlement plan (Cospend `/settle`, IHM fork). Not wired
	 * into the settle tab yet — all backends use stats/aggregate.ts settleBalances(). */
	fetchSettlement?(): Promise<SettlementTransaction[]>;
	/** Creates `cat` as a native project category and returns its id, or null
	 * when unsupported/failed. Caller stores it in BillCategoryDef.nativeCategoryId. */
	pushCategory?(cat: BillCategoryDef): Promise<number | null>;
	/** Project payment modes. The bill form hides the field when empty. */
	fetchPaymentModes?(): Promise<PaymentMode[]>;
	/** Native category catalog (Cospend: project categories incl. its seeded
	 * defaults; IHM fork: global list + project categories). Lets sync()
	 * import a category that was set directly on the server by another client. */
	fetchNativeCategories?(): Promise<{ id: number; label: string; emoji: string }[]>;
}

export interface PaymentMode {
	id: number;
	name: string;
	icon: string;
}
