import type { IhmBill, BillCategoryDef } from '../types';
import type { IhmMemberRaw, IhmBillCreate } from '../ihm-api/client';
import type { SettlementTransaction } from '../stats/aggregate';

// Gemeinsames Interface für alle drei Backends (IHateMoney, Cospend, Local —
// siehe types.ts ProjectBackendType). `IhmMemberRaw`/`IhmBillCreate` leben
// bewusst weiter in `ihm-api/client.ts` (Namensgeber IHM, aber generisch
// genug als gemeinsame DTO-Form aller drei Implementierungen — kein Grund,
// sie zu duplizieren oder umzubenennen).
//
// `fetchSettlement`/`pushCategory` sind OPTIONAL: nur Backends mit einer
// echten serverseitigen Entsprechung (Cospend) implementieren sie. Aufrufer
// prüfen `client.fetchSettlement?.(...)` statt sich auf ein Backend zu
// verlassen, das es nicht gibt (IHM hat keinen Ausgleich-Endpoint, siehe
// stats/aggregate.ts `settleBalances()`-Fallback).
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
	/** Nativer Ausgleichsplan des Servers (Cospend `/settle`) — wenn
	 * vorhanden, nutzt der Ausgleich-Tab DAS statt `settleBalances()`
	 * (stats/aggregate.ts, unser eigener Port für Backends ohne so einen
	 * Endpunkt). */
	fetchSettlement?(): Promise<SettlementTransaction[]>;
	/** Legt `cat` nativ auf dem Server an (Cospend: echte, freie
	 * Projekt-Kategorie) und liefert die neue native id — oder `null`, wenn
	 * das Backend das nicht unterstützt/fehlschlägt. Aufrufer speichert den
	 * Rückgabewert in `BillCategoryDef.nativeCategoryId` (types.ts). */
	pushCategory?(cat: BillCategoryDef): Promise<number | null>;
	/** Verfügbare Zahlungsmittel des Projekts (Cospend: Bar/Karte/Überweisung/
	 * ... — projekteigenes Set, siehe backend/cospend-client.ts). Nur
	 * implementiert, wo das Konzept existiert — Aufrufer (bill-form.ts)
	 * blenden das Feld aus, wenn `undefined`/leeres Array zurückkommt. */
	fetchPaymentModes?(): Promise<PaymentMode[]>;
	/** Katalog der nativen Kategorien des Servers/Projekts (Cospend: echte
	 * projekteigene Kategorien inkl. der automatisch geseedeten Defaults wie
	 * "Grocery"/"Restaurant"; IHM-Fork: die 10 festen
	 * `COSPEND_GLOBAL_CATEGORIES`). Rückkanal für `sync()` (view/ihm-view.ts):
	 * eine Kategorie, die direkt am Server gesetzt wurde (Cospend-
	 * Weboberfläche/MoneyBuster, nicht über dieses Plugin) und deren
	 * `nativeCategoryId` noch keiner lokalen `BillCategoryDef` entspricht,
	 * wird darüber als NEUE lokale Kategorie importiert statt vom
	 * Auto-Klassifikator überschrieben zu werden (Bug, gemeldet 2026-09-10,
	 * siehe docs/bugs.md). */
	fetchNativeCategories?(): Promise<{ id: number; label: string; emoji: string }[]>;
}

export interface PaymentMode {
	id: number;
	name: string;
	icon: string;
}
