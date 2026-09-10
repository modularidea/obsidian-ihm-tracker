import { requestUrl } from 'obsidian';

// Nextcloud Login Flow v2 (docs.nextcloud.com → client APIs → LoginFlow).
// Used once from the settings to obtain an app password; the running client
// (CospendClient) only uses the resulting loginName/appPassword.

export interface LoginFlowInit {
	login: string; // must be opened in the system browser, not a webview
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

interface CospendProjectJson {
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
	if (res.status !== 200) throw new Error(`Login flow could not be started (${res.status}) — check the server URL`);
	return res.json as LoginFlowInit;
}

/** One poll attempt; null (server answers 404) until the user finished the
 * browser login. The caller loops with an interval and its own timeout. */
export async function pollLoginFlow(poll: LoginFlowInit['poll']): Promise<LoginFlowResult | null> {
	const res = await requestUrl({
		url: poll.endpoint,
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'OCS-APIRequest': 'true' },
		body: `token=${encodeURIComponent(poll.token)}`,
		throw: false,
	});
	return res.status === 200 ? (res.json as LoginFlowResult) : null;
}

function headers(loginName: string, appPassword: string): Record<string, string> {
	return {
		Authorization: `Basic ${btoa(`${loginName}:${appPassword}`)}`,
		'OCS-APIRequest': 'true',
		Accept: 'application/json',
	};
}

export async function fetchCospendProjects(serverUrl: string, loginName: string, appPassword: string): Promise<CospendProjectSummary[]> {
	const res = await requestUrl({
		url: `${base(serverUrl)}/index.php/apps/cospend/api-priv/projects`,
		headers: headers(loginName, appPassword),
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Projects could not be loaded (${res.status})`);
	return (res.json as CospendProjectJson[]).map((p) => ({ id: p.id, name: p.name }));
}

/** `id` is user-chosen (Cospend allows free ids); the project belongs to the
 * logged-in user, no public share needed. */
export async function createCospendProject(serverUrl: string, loginName: string, appPassword: string, name: string, id: string): Promise<void> {
	const res = await requestUrl({
		url: `${base(serverUrl)}/index.php/apps/cospend/api-priv/projects`,
		method: 'POST',
		headers: { ...headers(loginName, appPassword), 'Content-Type': 'application/x-www-form-urlencoded' },
		body: `name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`,
		throw: false,
	});
	if (res.status !== 200) {
		const message = (res.json as string[] | undefined)?.[0] ?? res.text;
		throw new Error(`Project could not be created — ${message}`);
	}
}
