// Test-only stand-in for the 'obsidian' package (types only, no runtime).
// Covers just `requestUrl()` — only Obsidian-free modules have unit tests.
// Aliased in vitest.config.ts, never bundled.
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

	if (!res.ok && shouldThrow) throw new Error(`Request failed, status ${res.status}`);

	const text = new TextDecoder('utf-8').decode(arrayBuffer);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}

	return { status: res.status, headers, arrayBuffer, json, text };
}
