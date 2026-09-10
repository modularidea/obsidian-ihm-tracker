import { IhmBill } from '../types';
import { IhmMemberRaw } from '../ihm-api/client';
import { cospendIdToLocalCategoryId } from '../categorize/cospend-category-map';

// Reine Aggregations-Helfer, kein DOM/Obsidian-Bezug — leicht testbar.
// Referenz: haushalt_app/haushub/lib/screens/kasse/stats_screen.dart
// (_byMonth/_byCategory/_memberStats) + die Pivot-Logik aus dem
// ihatemoney-dashboard-Vorbild (Person × Monat × Kategorie).
//
// WICHTIG: IHM kennt — anders als haushub — keine Bill-Entries mit
// unterschiedlichen SplitTypes. Ein Bill wird serverseitig immer gleichmäßig
// (gewichtet nach `Member.weight`) auf die `owers` verteilt. `computeShares`
// bildet exakt das nach.

/** Reimbursement-Bills (interne Ausgleichszahlungen) fließen NICHT in
 * Ausgaben-Statistiken ein, wohl aber in Salden — siehe
 * ihatemoney-dashboard docs/README.md "Datenfluss". Beim Aufrufer filtern:
 * `bills.filter(isExpense)` vor byMonth/byCategory/memberStats. */
export function isExpense(bill: IhmBill): boolean {
	return bill.billType === 'expense';
}

export function categoryOf(bill: IhmBill): string {
	if (bill.categoryId) return bill.categoryId;
	// Vault-Mapping ist primär (siehe konzept.md Abschnitt 4.4) — nativeCategoryId
	// ist nur ein Best-Effort-Fallback für Bills, die der lokale Klassifikator
	// noch nie klassifiziert hat (z.B. gerade erst von MoneyBuster/Cospend-Web
	// mit einer Kategorie angelegt, lokal aber frisch importiert).
	if (bill.nativeCategoryId != null) {
		return cospendIdToLocalCategoryId(bill.nativeCategoryId) ?? 'other';
	}
	return 'other';
}

export function byMonth(bills: IhmBill[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const b of bills) {
		const key = b.date.slice(0, 7); // yyyy-mm
		m.set(key, (m.get(key) ?? 0) + b.amount);
	}
	return m;
}

export function byCategory(bills: IhmBill[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const b of bills) {
		const cat = categoryOf(b);
		m.set(cat, (m.get(cat) ?? 0) + b.amount);
	}
	return m;
}

/** Anteiliger Betrag jedes owers an `bill`, gewichtet nach `weightOf(ihmId)`.
 * Nimmt bewusst nur `{amount, owerIhmIds}` statt eines vollen `IhmBill` —
 * `view/bill-form.ts` ruft das live während der Bearbeitung mit einem noch
 * nicht gespeicherten Entwurf auf (siehe dort). */
export function computeShares(bill: Pick<IhmBill, 'amount' | 'owerIhmIds'>, weightOf: (ihmId: number) => number): Map<number, number> {
	const shares = new Map<number, number>();
	const totalWeight = bill.owerIhmIds.reduce((s, id) => s + weightOf(id), 0);
	if (totalWeight === 0) return shares;
	for (const id of bill.owerIhmIds) {
		shares.set(id, (bill.amount * weightOf(id)) / totalWeight);
	}
	return shares;
}

export interface MemberStats {
	paid: Map<number, number>; // ausgelegt
	share: Map<number, number>; // Anteil (verursacht)
}

export function memberStats(bills: IhmBill[], members: IhmMemberRaw[]): MemberStats {
	const weightOf = (id: number) => members.find((m) => m.ihmId === id)?.weight ?? 1;
	const paid = new Map<number, number>();
	const share = new Map<number, number>();
	for (const b of bills) {
		paid.set(b.payerIhmId, (paid.get(b.payerIhmId) ?? 0) + b.amount);
		for (const [id, val] of computeShares(b, weightOf)) {
			share.set(id, (share.get(id) ?? 0) + val);
		}
	}
	return { paid, share };
}

/** Person × Monat Pivot, optional auf eine Kategorie gefiltert.
 * `metric: 'share'` = Anteil (verursacht), `metric: 'paid'` = Ausgelegt (bezahlt). */
export function pivotByPersonMonth(
	bills: IhmBill[],
	members: IhmMemberRaw[],
	opts: { categoryId?: string; metric: 'share' | 'paid' },
): Map<string, Map<number, number>> {
	const weightOf = (id: number) => members.find((m) => m.ihmId === id)?.weight ?? 1;
	const filtered = opts.categoryId ? bills.filter((b) => categoryOf(b) === opts.categoryId) : bills;
	const result = new Map<string, Map<number, number>>();
	for (const b of filtered) {
		const monthKey = b.date.slice(0, 7);
		if (!result.has(monthKey)) result.set(monthKey, new Map());
		const row = result.get(monthKey)!;
		if (opts.metric === 'paid') {
			row.set(b.payerIhmId, (row.get(b.payerIhmId) ?? 0) + b.amount);
		} else {
			for (const [id, val] of computeShares(b, weightOf)) {
				row.set(id, (row.get(id) ?? 0) + val);
			}
		}
	}
	return result;
}

/** Nettosaldo je Member über `bills` (positiv = bekommt Geld — analog IHM
 * eigener `balance`-Semantik, NICHT identisch zur haushub-Konvention, die es
 * umgekehrt hält; hier bewusst an der IHM-API-Semantik ausgerichtet, weil
 * `balance` direkt vom Server kommt statt lokal berechnet zu werden, siehe
 * ihm-api/client.ts fetchBalances). */
export function totalExpenses(bills: IhmBill[]): number {
	return bills.filter(isExpense).reduce((s, b) => s + b.amount, 0);
}

export interface SettlementTransaction {
	fromIhmId: number; // zahlt
	toIhmId: number; // bekommt
	amount: number;
}

/** Rundet HALF DOWN statt HALF UP (Python `decimal.ROUND_HALF_DOWN`) — nur
 * bei exakten Cent-Hälften relevant, praktisch nie bei echten Geldbeträgen,
 * aber Teil des 1:1-Ports (siehe `settleBalances`). */
function roundHalfDown(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	const scaled = value * factor;
	const floor = Math.floor(scaled);
	const remainder = scaled - floor;
	return (remainder > 0.5 + 1e-9 ? floor + 1 : floor) / factor;
}

/** Ausgleichsplan (minimale Anzahl Transaktionen, um alle Salden auf 0 zu
 * bringen) — 1:1 portiert aus dem `debts`-Python-Paket
 * (framagit.org/almet/debts, `solver.py` `settle()`/`reduce_balance()`),
 * das IHateMoney selbst intern für seinen Ausgleichsplan nutzt
 * (`Project.get_transactions_to_settle_bill()` in models.py). Kein IHM-API-
 * Endpunkt dafür vorhanden (gegen die offizielle API-Doku verifiziert,
 * 2026-09-09) — lässt sich aber rein aus den ohnehin schon abgerufenen
 * Mitglieder-Salden (`IhmMemberRaw.balance`) berechnen, kein zusätzlicher
 * Server-Call nötig. Gibt bei praktisch (< 1 Cent) ausgeglichenen Salden ein
 * leeres Array zurück statt zu werfen. */
export function settleBalances(members: { ihmId: number; balance: number }[]): SettlementTransaction[] {
	type Entry = [number, number];
	const debiters: Entry[] = [];
	const crediters: Entry[] = [];
	for (const m of members) {
		if (Math.abs(m.balance) < 0.005) continue;
		if (m.balance > 0) crediters.push([m.ihmId, m.balance]);
		else debiters.push([m.ihmId, m.balance]);
	}

	const sumAbs = (list: Entry[]) => list.reduce((s, [, v]) => s + Math.abs(v), 0);
	if (Math.abs(sumAbs(crediters) - sumAbs(debiters)) >= 0.01) {
		console.error('ihm-tracker: Salden unausgeglichen, kein Ausgleichsplan berechnet');
		return [];
	}

	const results: SettlementTransaction[] = [];
	while (debiters.length > 0 && crediters.length > 0) {
		debiters.sort((a, b) => a[1] - b[1]);
		crediters.sort((a, b) => b[1] - a[1]);

		const [debiterId, debiterBalance] = debiters.pop()!;
		const [crediterId, crediterBalance] = crediters.pop()!;

		const amount = Math.abs(debiterBalance) > Math.abs(crediterBalance) ? Math.abs(crediterBalance) : Math.abs(debiterBalance);
		const dueAmount = roundHalfDown(amount, 2);
		if (dueAmount >= 0.01) results.push({ fromIhmId: debiterId, toIhmId: crediterId, amount: dueAmount });

		const newDebiterBalance = debiterBalance + amount;
		if (newDebiterBalance < 0) debiters.push([debiterId, newDebiterBalance]);

		const newCrediterBalance = crediterBalance - amount;
		if (newCrediterBalance > 0) crediters.push([crediterId, newCrediterBalance]);
	}
	return results;
}
