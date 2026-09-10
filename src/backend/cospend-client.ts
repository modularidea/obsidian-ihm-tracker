import { requestUrl } from 'obsidian';
import { IhmBill, IhmBillType, BillCategoryDef } from '../types';
import { IhmMemberRaw, IhmBillCreate, IhmApiError } from '../ihm-api/client';
import type { SettlementTransaction } from '../stats/aggregate';
import type { ExpenseClient, PaymentMode } from './expense-client';

// Nextcloud-Cospend-Client — komplett gegen einen echten lokalen
// Nextcloud+Cospend-Docker-Server verifiziert (2026-09-10, siehe
// docker-compose.yml Service `nextcloud` + docs/ideas.md für alle Befunde).
// Nutzt die AUTHENTIFIZIERTEN `api-priv`-Routen (Basic-Auth mit
// Login-Flow-v2-Zugangsdaten, siehe backend/cospend-login.ts), NICHT die
// anonymen Public-Share-Routen (`/api/projects/<token>/<passwort>/...`) —
// letztere bräuchten einen zusätzlichen manuellen Setup-Schritt (Public-Share
// in der Cospend-Weboberfläche anlegen) und wurden bewusst verworfen, siehe
// docs/ideas.md "Cospend-Support".
//
// Zentrale Deltas zu IHM (alle verifiziert, nicht nur aus Doku übernommen):
// - Auth: Basic-Auth mit `loginName`/`appPassword` (aus Login Flow v2),
//   NICHT Projekt-Slug/Passwort.
// - Bills-Response ist gewrappt (`{bills:[...], allBillIds:[...]}`), nicht
//   ein rohes Array wie bei IHM.
// - `payed_for` beim Anlegen/Ändern als Comma-separated String, nicht
//   wiederholtes Feld.
// - Kein `bill_type`-Feld — Reimbursement/Ausgleichszahlung läuft über den
//   Sentinel-Wert `categoryid: -11` (`Application::CATEGORY_REIMBURSEMENT`
//   im Cospend-Quellcode).
// - `/statistics` hat eine ANDERE Form als IHM (`{stats:[...], ...}`
//   Wrapper statt direktem Array).
// - Kategorien sind echte, freie Projekt-Ressourcen (positive IDs, per API
//   anlegbar) — siehe `pushCategory()`.
// - Nativer Ausgleich-Endpoint (`/settle`) — siehe `fetchSettlement()`.

const REIMBURSEMENT_CATEGORY_ID = -11;

// Wire-Format-Typen für `res.json` (Obsidian typisiert `RequestUrlResponse.json`
// als `any` — diese Interfaces geben dem Response-Body einmal einen Typ, statt
// bei jedem einzelnen Property-Zugriff unten `as X` zu casten.
interface CospendProjectInfoJson {
	currencyname?: string;
	paymentmodes?: Record<string, { id: number; name: string; icon: string }>;
	categories?: Record<string, { id: number; name: string; icon: string }>;
}

interface CospendMemberJson {
	id: number;
	name: string;
	weight?: number;
}

interface CospendStatsJson {
	stats?: { member: { id: number }; balance: number }[];
}

interface CospendBillOwerJson {
	id: number;
	weight?: number;
}

interface CospendBillJson {
	id: number;
	what: string;
	payer_id: number;
	owers?: (CospendBillOwerJson | number)[];
	amount: number;
	date: string;
	categoryid?: number;
	paymentmodeid?: number;
}

interface CospendBillsResponseJson {
	bills?: CospendBillJson[];
}

interface CospendSettleResponseJson {
	transactions?: { from: number; to: number; amount: number }[];
}

export class CospendClient implements ExpenseClient {
	constructor(
		private serverUrl: string,
		private projectId: string,
		private loginName: string,
		private appPassword: string,
	) {}

	private headers(): Record<string, string> {
		return {
			Authorization: `Basic ${btoa(`${this.loginName}:${this.appPassword}`)}`,
			'OCS-APIRequest': 'true',
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		};
	}

	private base(): string {
		const b = this.serverUrl.endsWith('/') ? this.serverUrl.slice(0, -1) : this.serverUrl;
		return `${b}/index.php/apps/cospend/api-priv/projects/${encodeURIComponent(this.projectId)}`;
	}

	private form(params: Record<string, string | number | undefined>): string {
		const usp = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined) usp.set(k, String(v));
		return usp.toString();
	}

	async testConnection(): Promise<boolean> {
		try {
			const res = await requestUrl({ url: this.base(), headers: this.headers(), throw: false });
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** Cospends `currencyname` ist ein Freitext-Projektwährungsname (eigenes
	 * Multi-Währungs-/Umrechnungskurs-Konzept), KEIN garantierter ISO-4217-Code
	 * wie IHMs `default_currency` — `Intl.NumberFormat` braucht aber einen
	 * echten Code. Nur übernehmen, wenn es wie ein ISO-Code aussieht (3
	 * Großbuchstaben), sonst EUR-Fallback statt eines Formatierungsfehlers. */
	async fetchCurrency(): Promise<string> {
		try {
			const res = await requestUrl({ url: this.base(), headers: this.headers(), throw: false });
			if (res.status !== 200) return 'EUR';
			const name = (res.json as CospendProjectInfoJson | undefined)?.currencyname;
			return name && /^[A-Z]{3}$/.test(name) ? name : 'EUR';
		} catch {
			return 'EUR';
		}
	}

	/** Cospend hat strukturell IMMER echte, freie Projekt-Kategorien — keine
	 * Probe nötig (anders als beim optionalen IHM-Server-Fork). */
	async probeNativeCategorySupport(): Promise<boolean> {
		return true;
	}

	async fetchMembers(): Promise<IhmMemberRaw[]> {
		const [membersRes, statsRes] = await Promise.all([
			requestUrl({ url: `${this.base()}/members`, headers: this.headers(), throw: false }),
			requestUrl({ url: `${this.base()}/statistics`, headers: this.headers(), throw: false }),
		]);
		if (membersRes.status !== 200) throw new IhmApiError(membersRes.status, membersRes.text);
		const balanceByMemberId = new Map<number, number>();
		if (statsRes.status === 200) {
			const stats = (statsRes.json as CospendStatsJson | undefined)?.stats ?? [];
			for (const s of stats) balanceByMemberId.set(s.member.id, s.balance);
		}
		return (membersRes.json as CospendMemberJson[]).map((m) => ({
			ihmId: m.id,
			name: m.name,
			weight: m.weight ?? 1.0,
			balance: balanceByMemberId.get(m.id) ?? 0,
		}));
	}

	async fetchBills(): Promise<IhmBill[]> {
		const res = await requestUrl({ url: `${this.base()}/bills`, headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		const list = (res.json as CospendBillsResponseJson | undefined)?.bills ?? [];
		return list.map((b) => {
			const owersRaw = b.owers ?? [];
			const categoryId = b.categoryid;
			const billType: IhmBillType = categoryId === REIMBURSEMENT_CATEGORY_ID ? 'reimbursement' : 'expense';
			return {
				ihmId: b.id,
				what: b.what,
				payerIhmId: b.payer_id,
				owerIhmIds: owersRaw.map((o) => (typeof o === 'object' ? o.id : o)),
				amount: Number(b.amount),
				date: b.date,
				billType,
				// 0 = "keine Kategorie" bei Cospend, -11 ist der reine
				// Reimbursement-Sentinel (kein echtes Kategorie-Konzept, siehe
				// billType oben) — beide auf `null` normalisiert, damit
				// `nativeCategoryId` hier dieselbe Bedeutung hat wie bei IHM.
				nativeCategoryId: categoryId && categoryId !== REIMBURSEMENT_CATEGORY_ID ? categoryId : null,
				paymentModeId: b.paymentmodeid || undefined,
			} satisfies IhmBill;
		});
	}

	private billBody(bill: IhmBillCreate): string {
		const categoryId = bill.billType === 'reimbursement' ? REIMBURSEMENT_CATEGORY_ID : bill.nativeCategoryId;
		return this.form({
			what: bill.what,
			payer: bill.payerIhmId,
			payed_for: bill.owerIhmIds.join(','),
			amount: bill.amount,
			date: bill.date,
			...(categoryId != null ? { categoryid: categoryId } : {}),
			...(bill.paymentModeId != null ? { paymentmodeid: bill.paymentModeId } : {}),
		});
	}

	/** Zahlungsmittel sind ein Set PRO Projekt (per Default 5 vorbelegt, siehe
	 * `apiPrivCreateProject`-Quellcode: Credit card/Cash/Check/Transfer/Online
	 * service) — kein fixer globaler Katalog wie bei Kategorien, daher hier
	 * direkt aus der Projekt-Info gelesen statt eines eigenen Endpoints. */
	async fetchPaymentModes(): Promise<PaymentMode[]> {
		const res = await requestUrl({ url: this.base(), headers: this.headers(), throw: false });
		if (res.status !== 200) return [];
		const modes = (res.json as CospendProjectInfoJson | undefined)?.paymentmodes ?? {};
		return Object.values(modes).map((m) => ({ id: m.id, name: m.name, icon: m.icon }));
	}

	private parseIdResponse(body: string): number {
		const asInt = Number(body.trim());
		if (!Number.isNaN(asInt)) return asInt;
		throw new Error('Cospend-Response enthielt keine parsbare id — Push-Ergebnis unsicher, breche ab statt zu raten.');
	}

	async createBill(bill: IhmBillCreate): Promise<number> {
		const res = await requestUrl({
			url: `${this.base()}/bills`,
			method: 'POST',
			headers: this.headers(),
			body: this.billBody(bill),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/bills/${ihmBillId}`,
			method: 'PUT',
			headers: this.headers(),
			body: this.billBody(bill),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	async deleteBill(ihmBillId: number): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/bills/${ihmBillId}`,
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}

	async createMember(name: string): Promise<number> {
		const res = await requestUrl({
			url: `${this.base()}/members`,
			method: 'POST',
			headers: this.headers(),
			body: this.form({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateMember(ihmMemberId: number, name: string): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/members/${ihmMemberId}`,
			method: 'PUT',
			headers: this.headers(),
			body: this.form({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	async deleteMember(ihmMemberId: number): Promise<void> {
		const res = await requestUrl({
			url: `${this.base()}/members/${ihmMemberId}`,
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}

	/** Cospends eigener Ausgleich-Endpoint — ersetzt `settleBalances()`
	 * (stats/aggregate.ts) für dieses Backend, siehe ExpenseClient-Kommentar. */
	async fetchSettlement(): Promise<SettlementTransaction[]> {
		const res = await requestUrl({ url: `${this.base()}/settle`, headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		const transactions = (res.json as CospendSettleResponseJson | undefined)?.transactions ?? [];
		return transactions.map((t) => ({ fromIhmId: t.from, toIhmId: t.to, amount: t.amount }));
	}

	/** Legt `cat` als echte, freie Cospend-Projekt-Kategorie an (Farbe: kein
	 * Feld in `BillCategoryDef`, daher aus der id deterministisch abgeleitet
	 * statt eines für alle Kategorien gleichen Fixwerts — rein kosmetisch für
	 * Cospends eigene Web-Oberfläche, unser Plugin nutzt die Farbe nirgends). */
	/** Voller Kategorie-Katalog des Projekts — inklusive der automatisch beim
	 * Anlegen geseedeten Defaults (Grocery/Restaurant/Transport/...), die
	 * dieses Plugin nie selbst gepusht hat und deshalb sonst nicht per
	 * `nativeCategoryId` zurückmappen könnte (siehe `ExpenseClient`-
	 * Kommentar). Gleicher Endpoint wie `fetchCurrency()`/`fetchPaymentModes()`
	 * (Projekt-Info-GET liefert `categories` schon mit). */
	async fetchNativeCategories(): Promise<{ id: number; label: string; emoji: string }[]> {
		const res = await requestUrl({ url: this.base(), headers: this.headers(), throw: false });
		if (res.status !== 200) return [];
		const categories = (res.json as CospendProjectInfoJson | undefined)?.categories ?? {};
		return Object.values(categories).map((c) => ({ id: c.id, label: c.name, emoji: c.icon }));
	}

	async pushCategory(cat: BillCategoryDef): Promise<number | null> {
		try {
			// ERST prüfen, ob das Projekt schon eine gleichnamige Kategorie hat
			// (z.B. die 10 beim Anlegen automatisch geseedeten Cospend-Defaults,
			// siehe docs/ideas.md) — sonst legt jeder Push eine Dublette an, statt
			// die schon vorhandene Kategorie zu treffen (Nutzer-Feedback
			// 2026-09-10: "Kategoriesync geht noch nicht wirklich"). Name-Match
			// statt id-Match, da Cospends eigene Default-ids nichts mit unseren
			// lokalen ids zu tun haben.
			const existing = await this.findCategoryByName(cat.label);
			if (existing != null) return existing;

			const res = await requestUrl({
				url: `${this.base()}/category`,
				method: 'POST',
				headers: this.headers(),
				body: this.form({ name: cat.label, icon: cat.emoji, color: hashColor(cat.id) }),
				throw: false,
			});
			if (res.status !== 200 && res.status !== 201) return null;
			return this.parseIdResponse(res.text);
		} catch {
			return null;
		}
	}

	private async findCategoryByName(name: string): Promise<number | null> {
		const res = await requestUrl({ url: this.base(), headers: this.headers(), throw: false });
		if (res.status !== 200) return null;
		const categories = (res.json as CospendProjectInfoJson | undefined)?.categories ?? {};
		const needle = name.trim().toLowerCase();
		const match = Object.values(categories).find((c) => c.name.trim().toLowerCase() === needle);
		return match?.id ?? null;
	}
}

function hashColor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
	return `#${(hash & 0xffffff).toString(16).padStart(6, '0')}`;
}
