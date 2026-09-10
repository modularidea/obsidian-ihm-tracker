import { requestUrl } from 'obsidian';

// Nextcloud Login Flow v2 (docs.nextcloud.com/server/stable/developer_manual/
// client_apis/LoginFlow/) — verifiziert 2026-09-10 gegen einen echten
// lokalen Nextcloud-Server (siehe docker-compose.yml). Nur für den
// EINMALIGEN Verbindungsaufbau in den Settings gedacht (settings.ts) — der
// laufende Betrieb nutzt danach nur noch `CospendClient` mit den hier
// gewonnenen `loginName`/`appPassword`. Bewusst NICHT Teil von
// `ExpenseClient` (kein Projekt-Bezug, läuft VOR der Projekt-Auswahl).

export interface LoginFlowInit {
	login: string; // im System-Browser zu öffnende URL, NICHT im Webview (Nextcloud-Vorgabe)
	poll: { token: string; endpoint: string };
}

export interface LoginFlowResult {
	server: string;
	loginName: string;
	appPassword: string;
}

export interface CospendProjectSummary {
	id: string;
	name: string;
}

function base(serverUrl: string): string {
	return serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
}

export async function startLoginFlow(serverUrl: string): Promise<LoginFlowInit> {
	const res = await requestUrl({
		url: `${base(serverUrl)}/index.php/login/v2`,
		method: 'POST',
		headers: { 'OCS-APIRequest': 'true' },
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Login-Flow konnte nicht gestartet werden (${res.status}) — Server-URL prüfen`);
	return res.json as LoginFlowInit;
}

/** Ein Poll-Versuch — `null` solange der Nutzer den Login im Browser noch
 * nicht abgeschlossen hat (Server antwortet mit 404, siehe Login-Flow-v2-
 * Doku). Aufrufer (settings.ts) ruft das in einer Schleife mit Intervall auf,
 * bis ein Ergebnis kommt oder der Nutzer abbricht — KEIN eingebautes Timeout
 * hier, das ist UI-Zustand, kein Protokoll-Detail. */
export async function pollLoginFlow(poll: LoginFlowInit['poll']): Promise<LoginFlowResult | null> {
	const res = await requestUrl({
		url: poll.endpoint,
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'OCS-APIRequest': 'true' },
		body: `token=${encodeURIComponent(poll.token)}`,
		throw: false,
	});
	if (res.status === 200) return res.json as LoginFlowResult;
	return null;
}

function headers(loginName: string, appPassword: string): Record<string, string> {
	return {
		Authorization: `Basic ${btoa(`${loginName}:${appPassword}`)}`,
		'OCS-APIRequest': 'true',
		Accept: 'application/json',
	};
}

/** Listet die Cospend-Projekte des per Login Flow v2 verbundenen Nutzers —
 * ermöglicht einen Projekt-Picker statt manueller id-Eingabe (Nutzerwunsch
 * 2026-09-10, analog MoneyBusters "Projekte automatisch hinzufügen"). */
export async function fetchCospendProjects(serverUrl: string, loginName: string, appPassword: string): Promise<CospendProjectSummary[]> {
	const res = await requestUrl({
		url: `${base(serverUrl)}/index.php/apps/cospend/api-priv/projects`,
		headers: headers(loginName, appPassword),
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Projekte konnten nicht geladen werden (${res.status})`);
	return (res.json as any[]).map((p) => ({ id: p.id as string, name: p.name as string }));
}

/** Legt ein neues Cospend-Projekt für den verbundenen Nutzer an (Nutzerwunsch
 * 2026-09-10: "auch neues Projekt anlegen"). `id` ist der spätere
 * `IhmProjectConfig.projectId` — Cospend erlaubt hier freie Wahl, nicht
 * serverseitig generiert (siehe `apiPrivCreateProject`-Signatur im
 * Cospend-Quellcode: `name`+`id`, kein Passwort — das Projekt gehört direkt
 * dem eingeloggten Nutzer, kein Public-Share nötig). */
export async function createCospendProject(serverUrl: string, loginName: string, appPassword: string, name: string, id: string): Promise<void> {
	const res = await requestUrl({
		url: `${base(serverUrl)}/index.php/apps/cospend/api-priv/projects`,
		method: 'POST',
		headers: { ...headers(loginName, appPassword), 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`,
		throw: false,
	});
	if (res.status !== 200) {
		const message = (res.json as any)?.[0] ?? res.text;
		throw new Error(`Projekt konnte nicht angelegt werden — ${message}`);
	}
}
