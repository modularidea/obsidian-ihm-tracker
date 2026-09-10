import { requestUrl } from 'obsidian';
import { IhmBill, IhmBillType, IhmMemberBalance } from '../types';
import type { ExpenseClient } from '../backend/expense-client';
import { COSPEND_GLOBAL_CATEGORIES } from '../categorize/cospend-category-map';

// IHateMoney REST-Client. Port der Kernlogik aus
// haushalt_app/haushub/lib/services/ihatemoney_service.dart, aber auf
// Obsidians `requestUrl()` statt `package:http` — DAS ist der entscheidende
// Unterschied zum bestehenden ihatemoney-dashboard-Tool (reines Browser-JS):
// `requestUrl()` läuft in Obsidian Desktop über Electron/Node und auf
// Mobile über die native Plattform-HTTP-Schicht, NICHT über
// `fetch()`/`XMLHttpRequest` — CORS-Header des IHM-Servers spielen daher
// keine Rolle. Der im Dashboard nötige Workaround (Klick-Link-Fallback für
// Server ohne `Access-Control-Allow-Origin`) entfällt hier komplett, auch
// für selbstgehostete NAS-Instanzen ohne CORS-Konfiguration.
//
// API-Doku: https://github.com/spiral-project/ihatemoney/blob/main/docs/api.md
// Feldnamen für POST/PUT bills folgen dem WTForms-Schema (`payer`,
// `payed_for`) — asymmetrisch zum GET-Response-Schema (`payer_id`, `owers`),
// verifiziert im haushub-Projekt gegen die echte API (siehe dortiger
// Kommentar in ihatemoney_service.dart `_billBody`).

export interface IhmMemberRaw {
	ihmId: number;
	name: string;
	weight: number;
	balance: number;
}

export interface IhmBillCreate {
	what: string;
	payerIhmId: number;
	owerIhmIds: number[];
	amount: number;
	date: string; // yyyy-mm-dd
	externalLink?: string;
	/** Wire-Feld `categoryid` (siehe server-patch/) — nur senden, wenn der
	 * verbundene Server das Feld unterstützt (Project.nativeCategorySupport);
	 * bei `undefined` wird der Key im Body komplett weggelassen (stock-IHM
	 * ignoriert unbekannte Formularfelder klaglos, das Weglassen ist trotzdem
	 * sauberer als ein Feld zu senden, das nie ankommt). */
	nativeCategoryId?: number | null;
	/** Fehlt → Server-Default `Expense` (WTForms `BillForm.bill_type`,
	 * `default=BillType.EXPENSE`). Für Ausgleichszahlungen aus dem Ausgleich-
	 * Tab explizit `'reimbursement'` setzen (siehe `ihm-view.ts`
	 * `createSettlementBill()`). */
	billType?: IhmBillType;
	/** Nur Cospend (siehe backend/cospend-client.ts) — IHM ignoriert dieses
	 * Feld (kein Wire-Feld in `billBody()` dort). */
	paymentModeId?: number;
}

export class IhmApiError extends Error {
	constructor(
		public status: number,
		public body: string,
	) {
		super(`IHM API ${status}: ${body}`);
	}
}

export class IhateMoneyClient implements ExpenseClient {
	constructor(
		private serverUrl: string,
		private projectId: string,
		private password: string,
	) {}

	private auth(): string {
		// btoa läuft in Obsidian sowohl Desktop (Electron/Chromium) als auch
		// Mobile (WebView) — kein Node-`Buffer` nötig, daher iOS-sicher.
		return btoa(`${this.projectId}:${this.password}`);
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Basic ${this.auth()}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
	}

	private url(path: string): string {
		const base = this.serverUrl.endsWith('/') ? this.serverUrl.slice(0, -1) : this.serverUrl;
		return `${base}/api/projects/${this.projectId}${path}`;
	}

	async testConnection(): Promise<boolean> {
		try {
			const res = await requestUrl({ url: this.url(''), headers: this.headers(), throw: false });
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** Liest die Projekt-Währung für die Betrag-Formatierung im Beleg-
	 * Formular (Nutzer-Feedback 2026-09-09). `default_currency` ist bei
	 * Projekten ohne explizite Einstellung oft `"XXX"` (ISO-4217-Reserve-Code
	 * für "keine Währung") — dann und bei jedem sonstigen unbrauchbaren Wert
	 * auf EUR zurückfallen, statt "XXX" anzuzeigen. */
	async fetchCurrency(): Promise<string> {
		try {
			const res = await requestUrl({ url: this.url(''), headers: this.headers(), throw: false });
			if (res.status !== 200) return 'EUR';
			const currency = res.json?.default_currency as string | undefined;
			return currency && currency !== 'XXX' ? currency : 'EUR';
		} catch {
			return 'EUR';
		}
	}

	/** Probe, ob der Server (z.B. ein NAS-Fork mit Server-Patch, siehe
	 * server-patch/README.md) ein natives `categoryid`-Feld unterstützt.
	 * Erkennung: GET auf /bills, Prüfung ob das erste zurückgegebene
	 * Bill-Objekt den Key `categoryid` TRÄGT (nicht: ob er einen Wert hat —
	 * `null` ist ein gültiger "unklassifiziert"-Wert auf einem Fork-Server,
	 * ein reiner Typ-Check auf den Wert würde das fälschlich als "nicht
	 * unterstützt" werten, siehe server-patch/ Verifikation). Konservativ —
	 * bei leerem Projekt (keine Bills) liefert die Probe `false`, auch wenn
	 * der Server den Patch hat; das ist ok, die Probe läuft bei jedem Sync neu. */
	async probeNativeCategorySupport(): Promise<boolean> {
		try {
			const res = await requestUrl({ url: this.url('/bills'), headers: this.headers(), throw: false });
			if (res.status !== 200) return false;
			const decoded = res.json;
			const list = Array.isArray(decoded) ? decoded : decoded?.bills;
			return Array.isArray(list) && list.length > 0 && Object.prototype.hasOwnProperty.call(list[0], 'categoryid');
		} catch {
			return false;
		}
	}

	/** Kein Server-Call nötig — der Fork kennt nur die 10 festen
	 * `COSPEND_GLOBAL_CATEGORIES` (statisch, siehe categorize/
	 * cospend-category-map.ts), keine dynamisch anlegbaren Projekt-Kategorien
	 * wie echtes Cospend. */
	async fetchNativeCategories(): Promise<{ id: number; label: string; emoji: string }[]> {
		return COSPEND_GLOBAL_CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji }));
	}

	async fetchMembers(): Promise<IhmMemberRaw[]> {
		// `/members` liefert KEIN `balance`-Feld (verifiziert gegen den
		// IHM-Upstream `models.py` `Person._to_serialize` — nur id/name/weight/
		// activated). Echte Salden kommen ausschließlich über `/statistics`
		// (`Project.members_stats`, verschachteltes `member`-Objekt). Bug
		// 2026-09-09: `balance` blieb dadurch immer 0 → Personen-/Ausgleich-Tab
		// zeigten fälschlich "ausgeglichen" trotz klar unausgeglichener Konten.
		const [membersRes, statsRes] = await Promise.all([
			requestUrl({ url: this.url('/members'), headers: this.headers(), throw: false }),
			requestUrl({ url: this.url('/statistics'), headers: this.headers(), throw: false }),
		]);
		if (membersRes.status !== 200) throw new IhmApiError(membersRes.status, membersRes.text);
		const list = membersRes.json as any[];
		const balanceByMemberId = new Map<number, number>();
		if (statsRes.status === 200) {
			for (const s of statsRes.json as any[]) balanceByMemberId.set(s.member.id as number, s.balance as number);
		}
		return list.map((m) => ({
			ihmId: m.id as number,
			name: m.name as string,
			weight: (m.weight as number | undefined) ?? 1.0,
			balance: balanceByMemberId.get(m.id as number) ?? 0,
		}));
	}

	async fetchBalances(): Promise<IhmMemberBalance[]> {
		const members = await this.fetchMembers();
		return members.map((m) => ({ ihmId: m.ihmId, name: m.name, weight: m.weight, balance: m.balance }));
	}

	async fetchBills(): Promise<IhmBill[]> {
		const res = await requestUrl({ url: this.url('/bills'), headers: this.headers(), throw: false });
		if (res.status !== 200) throw new IhmApiError(res.status, res.text);
		const decoded = res.json;
		const list: any[] = Array.isArray(decoded) ? decoded : decoded.bills;
		return list.map((b) => {
			const owersRaw: any[] = b.owers ?? [];
			const billType: IhmBillType = b.bill_type === 'Reimbursement' ? 'reimbursement' : 'expense';
			return {
				ihmId: b.id as number,
				what: b.what as string,
				payerIhmId: b.payer_id as number,
				owerIhmIds: owersRaw.map((o) => (typeof o === 'object' ? o.id : o) as number),
				amount: Number(b.converted_amount ?? b.amount),
				date: b.date as string,
				billType,
				externalLink: b.external_link || undefined,
				// 'categoryid' in b: unterscheidet "Server liefert das Feld,
				// Wert ist null" (Fork, unklassifiziert) von "Server kennt das
				// Feld gar nicht" (stock-IHM) — reines `b.categoryid ?? null`
				// würde beide Fälle auf null zusammenfallen lassen und damit
				// nativeCategorySupport implizit falsch signalisieren.
				nativeCategoryId: 'categoryid' in b ? ((b.categoryid as number | null) ?? null) : undefined,
			} satisfies IhmBill;
		});
	}

	private billBody(bill: IhmBillCreate): Record<string, unknown> {
		return {
			what: bill.what,
			payer: bill.payerIhmId,
			payed_for: bill.owerIhmIds,
			amount: bill.amount,
			date: bill.date,
			...(bill.externalLink ? { external_link: bill.externalLink } : {}),
			// Nur senden, wenn der Aufrufer explizit einen Wert (inkl. `null`
			// zum Zurücksetzen) mitgibt — siehe IhmBillCreate.nativeCategoryId.
			...(bill.nativeCategoryId !== undefined ? { categoryid: bill.nativeCategoryId } : {}),
			// Wire-Wert exakt `BillType.value` im Upstream-Enum (models.py) —
			// "Expense"/"Reimbursement", nicht die lokalen kleingeschriebenen IDs.
			...(bill.billType ? { bill_type: bill.billType === 'reimbursement' ? 'Reimbursement' : 'Expense' } : {}),
		};
	}

	async createBill(bill: IhmBillCreate): Promise<number> {
		const res = await requestUrl({
			url: this.url('/bills'),
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify(this.billBody(bill)),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateBill(ihmBillId: number, bill: IhmBillCreate): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/bills/${ihmBillId}`),
			method: 'PUT',
			headers: this.headers(),
			body: JSON.stringify(this.billBody(bill)),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	async deleteBill(ihmBillId: number): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/bills/${ihmBillId}`),
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		// 404 zählt als Erfolg — Ziel (Bill existiert serverseitig nicht mehr)
		// ist bereits erreicht (siehe haushub docs/bugs.md BUG-56, gleiche Logik
		// hier übernommen).
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}

	/** Manche IHM-Endpunkte (Bill/Member anlegen) antworten mit der reinen
	 * Zahl als Text, andere mit `{"id": ...}` — beide Formen abfangen statt
	 * eins zu unterstellen. */
	private parseIdResponse(body: string): number {
		const asInt = Number(body.trim());
		if (!Number.isNaN(asInt)) return asInt;
		try {
			const j = JSON.parse(body);
			if (j?.id != null) return Number(j.id);
		} catch {
			/* fällt durch zu Error unten */
		}
		throw new Error('IHM-Response enthielt keine parsbare id — Push-Ergebnis unsicher, breche ab statt zu raten.');
	}

	/** Mitglieder-CRUD (Nutzerwunsch 2026-09-09: Mitgliederverwaltung direkt
	 * im Plugin, siehe settings.ts) — laut offizieller API-Doku
	 * (github.com/spiral-project/ihatemoney/blob/main/docs/api.md) vorhanden:
	 * POST/PUT/DELETE auf `/members`. */
	async createMember(name: string): Promise<number> {
		const res = await requestUrl({
			url: this.url('/members'),
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
		return this.parseIdResponse(res.text);
	}

	async updateMember(ihmMemberId: number, name: string): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/members/${ihmMemberId}`),
			method: 'PUT',
			headers: this.headers(),
			body: JSON.stringify({ name }),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 201) throw new IhmApiError(res.status, res.text);
	}

	async deleteMember(ihmMemberId: number): Promise<void> {
		const res = await requestUrl({
			url: this.url(`/members/${ihmMemberId}`),
			method: 'DELETE',
			headers: this.headers(),
			throw: false,
		});
		if (res.status !== 200 && res.status !== 404) throw new IhmApiError(res.status, res.text);
	}
}
