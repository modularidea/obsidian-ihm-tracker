/**
 * Test-only Ersatz für das 'obsidian'-Paket (liefert nur Typen, keine
 * Runtime — main ist ""). Deckt aktuell nur `requestUrl()` ab, weil nur
 * obsidian-freie Module (categorize/, stats/) Tests haben — siehe
 * docs/todos.md Phase 1 "Vitest-Setup für sync/category-store.ts-Merge":
 * sobald dafür Tests entstehen, hier App/TFile/normalizePath-Stubs ergänzen,
 * nicht vorab spekulativ bauen. Aliased in vitest.config.ts, nie gebundelt
 * (esbuild.config.mjs markiert 'obsidian' wie üblich als external).
 */
export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text: string;
}

export async function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse> {
	const params = typeof request === 'string' ? { url: request } : request;
	const shouldThrow = params.throw ?? true;

	const res = await fetch(params.url, {
		method: params.method ?? 'GET',
		headers: {
			...(params.contentType ? { 'Content-Type': params.contentType } : {}),
			...(params.headers ?? {}),
		},
		body: params.body,
	});

	const arrayBuffer = await res.arrayBuffer();
	const headers: Record<string, string> = {};
	res.headers.forEach((value, key) => (headers[key] = value));

	if (!res.ok && shouldThrow) {
		throw new Error(`Request failed, status ${res.status}`);
	}

	const decoder = new TextDecoder('utf-8');
	const text = decoder.decode(arrayBuffer);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}

	return { status: res.status, headers, arrayBuffer, json, text };
}
