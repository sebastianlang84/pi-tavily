import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";
const MAX_RESULTS_LIMIT = 10;
const MAX_EXTRACT_URLS = 5;
const SNIPPET_MAX_BYTES = 1200;
const EXTRACT_MAX_BYTES_PER_URL = 8000;
const REQUEST_TIMEOUT_MS = 20_000;

const SearchDepth = StringEnum(["basic", "advanced"] as const, {
	description: "Tavily search depth. Use 'advanced' only when higher recall is worth extra latency/credits. Default 'basic'.",
	default: "basic",
});

const ExtractDepth = StringEnum(["basic", "advanced"] as const, {
	description: "Tavily extraction depth. Use 'advanced' only for pages that need deeper parsing. Default 'basic'.",
	default: "basic",
});

const ExtractFormat = StringEnum(["markdown", "text"] as const, {
	description: "Extracted content format. Default 'markdown'.",
	default: "markdown",
});

const TavilySearchParams = Type.Object({
	query: Type.String({ description: "Web search query to send to Tavily. Do not include secrets or sensitive private data.", minLength: 1 }),
	max_results: Type.Optional(
		Type.Integer({
			description: "Maximum number of search results to return. Default 5, max 10.",
			minimum: 1,
			maximum: MAX_RESULTS_LIMIT,
			default: 5,
		}),
	),
	search_depth: Type.Optional(SearchDepth),
	topic: Type.Optional(
		StringEnum(["general", "news"] as const, {
			description: "Search topic. Use 'news' for recent news/current events. Default 'general'.",
			default: "general",
		}),
	),
	include_answer: Type.Optional(
		Type.Boolean({
			description: "Ask Tavily to include its generated short answer. Default false; source results are always returned.",
			default: false,
		}),
	),
});

const TavilyExtractParams = Type.Object({
	urls: Type.Array(Type.String({ description: "Public http(s) URL to extract. Do not include signed/private URLs or URLs containing tokens." }), {
		description: "URLs to extract. Usually use URLs returned by tavily_search. Max 5.",
		minItems: 1,
		maxItems: MAX_EXTRACT_URLS,
	}),
	extract_depth: Type.Optional(ExtractDepth),
	format: Type.Optional(ExtractFormat),
	include_images: Type.Optional(Type.Boolean({ description: "Include image URLs in details. Default false.", default: false })),
});

const TavilySearchExtractParams = Type.Object({
	query: Type.String({ description: "Web search query. The tool searches first, then extracts the top result URLs. Do not include secrets or sensitive private data.", minLength: 1 }),
	search_max_results: Type.Optional(
		Type.Integer({ description: "Number of search results to inspect before extraction. Default 5, max 10.", minimum: 1, maximum: MAX_RESULTS_LIMIT, default: 5 }),
	),
	extract_top_results: Type.Optional(
		Type.Integer({ description: "How many top search result URLs to extract. Default 3, max 5.", minimum: 1, maximum: MAX_EXTRACT_URLS, default: 3 }),
	),
	search_depth: Type.Optional(SearchDepth),
	topic: Type.Optional(
		StringEnum(["general", "news"] as const, {
			description: "Search topic. Use 'news' for recent news/current events. Default 'general'.",
			default: "general",
		}),
	),
	extract_depth: Type.Optional(ExtractDepth),
	format: Type.Optional(ExtractFormat),
});

type TavilyResult = {
	title?: unknown;
	url?: unknown;
	content?: unknown;
	score?: unknown;
};

type TavilySearchResponse = {
	query?: unknown;
	answer?: unknown;
	results?: unknown;
	response_time?: unknown;
	request_id?: unknown;
	usage?: unknown;
};

type TavilyExtractResult = {
	url?: unknown;
	raw_content?: unknown;
	content?: unknown;
	images?: unknown;
	favicon?: unknown;
};

type TavilyExtractResponse = {
	results?: unknown;
	failed_results?: unknown;
	response_time?: unknown;
	request_id?: unknown;
	usage?: unknown;
};

async function readApiKey(cwd: string): Promise<string | undefined> {
	const envKey = process.env.TAVILY_API_KEY?.trim();
	if (envKey) return envKey;

	const envPath = safeRepoRootEnvPath(cwd);
	if (!envPath) return undefined;

	try {
		const envText = await readFile(envPath, "utf8");
		for (const line of envText.split(/\r?\n/)) {
			const match = line.match(/^\s*TAVILY_API_KEY\s*=\s*(.*)\s*$/);
			if (!match) continue;
			const value = stripEnvQuotes(match[1] ?? "").trim();
			if (value) return value;
		}
	} catch {
		// Repo-root .env is optional; missing/unreadable files just mean no fallback key.
	}

	return undefined;
}

function stripEnvQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function safeRepoRootEnvPath(cwd: string): string | undefined {
	const repoRoot = gitRepoRoot(cwd);
	if (!repoRoot) return undefined;

	const tracked = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", ".env"], {
		stdio: "ignore",
		timeout: 1000,
	});
	if (tracked.status === 0) return undefined;

	const ignored = spawnSync("git", ["-C", repoRoot, "check-ignore", "-q", ".env"], {
		stdio: "ignore",
		timeout: 1000,
	});
	if (ignored.status !== 0) return undefined;

	return join(repoRoot, ".env");
}

function gitRepoRoot(cwd: string): string | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		timeout: 1000,
	});
	if (result.status !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

function clampInteger(value: number | undefined, defaultValue: number, max: number): number {
	if (!Number.isFinite(value)) return defaultValue;
	return Math.max(1, Math.min(max, Math.trunc(value)));
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectEntries<T extends object>(value: unknown): T[] {
	return Array.isArray(value) ? value.filter((entry): entry is T => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function imageUrlStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(asString).filter((image): image is string => Boolean(image)) : [];
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function compactSnippet(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return truncateUtf8WithMarker(compact, SNIPPET_MAX_BYTES, " …[truncated]");
}

function truncateUtf8WithMarker(text: string, maxBytes: number, marker: string): string {
	if (byteLength(text) <= maxBytes) return text;

	const markerBytes = byteLength(marker);
	const contentBudget = Math.max(0, maxBytes - markerBytes);
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (byteLength(text.slice(0, mid)) <= contentBudget) low = mid;
		else high = mid - 1;
	}

	return `${text.slice(0, low).trimEnd()}${marker}`;
}

function compactExtract(text: string): { content: string; truncated: boolean } {
	const truncation = truncateHead(text.trim(), { maxBytes: EXTRACT_MAX_BYTES_PER_URL, maxLines: 160 });
	return { content: truncation.content, truncated: truncation.truncated };
}

function redact(text: string, apiKey: string): string {
	return text.split(apiKey).join("[REDACTED_TAVILY_API_KEY]");
}

function normalizePublicUrls(urls: string[]): string[] {
	const normalized: string[] = [];
	for (const raw of urls) {
		const url = normalizePublicUrl(raw);
		if (!normalized.includes(url)) normalized.push(url);
	}

	if (normalized.length === 0) throw new Error("tavily_extract requires at least one URL.");
	if (normalized.length > MAX_EXTRACT_URLS) throw new Error(`tavily_extract accepts at most ${MAX_EXTRACT_URLS} URLs.`);
	return normalized;
}

function filterPublicUrls(urls: string[], maxUrls: number): string[] {
	const normalized: string[] = [];
	for (const raw of urls) {
		try {
			const url = normalizePublicUrl(raw);
			if (!normalized.includes(url)) normalized.push(url);
		} catch {
			// Search results can occasionally contain unsupported URLs; skip them for search+extract.
		}
		if (normalized.length >= maxUrls) break;
	}
	return normalized;
}

function normalizePublicUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("tavily_extract requires non-empty URLs.");

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("Invalid URL for tavily_extract.");
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("tavily_extract only accepts public http(s) URLs.");
	}
	if (parsed.username || parsed.password) {
		throw new Error("tavily_extract refuses credential-bearing URLs.");
	}

	const host = canonicalHostname(parsed.hostname);
	if (!isPublicHost(host)) {
		throw new Error("tavily_extract refuses non-public, localhost, or private-network URLs.");
	}
	parsed.hostname = host;

	if (trimmed.includes("#")) {
		throw new Error("tavily_extract refuses URLs with fragments.");
	}
	for (const key of parsed.searchParams.keys()) {
		if (isSensitiveUrlName(key)) {
			throw new Error(`tavily_extract refuses URLs with sensitive-looking query parameters: ${key}`);
		}
	}

	return parsed.toString();
}

function canonicalHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
}

function isPublicHost(hostname: string): boolean {
	const host = canonicalHostname(hostname);
	if (!host) return false;
	if (host === "localhost" || host.endsWith(".localhost")) return false;
	if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home") || host.endsWith(".internal")) return false;
	if (host.endsWith(".test") || host.endsWith(".example") || host.endsWith(".invalid")) return false;

	// Keep this lightweight and conservative: reject all IP literals rather than trying to
	// perfectly classify every private, mapped, multicast, or reserved IP range.
	if (isIP(host) !== 0) return false;

	// Single-label names are usually intranet hosts, not public web origins.
	if (!host.includes(".")) return false;

	return true;
}

function isSensitiveUrlName(name: string): boolean {
	return /token|secret|key|credential|signature|access|auth|session|password|passwd/i.test(name) || /^sig$/i.test(name);
}

async function tavilyRequest<T>(endpoint: string, apiKey: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<T> {
	if (signal?.aborted) {
		const reason = signal.reason;
		throw reason instanceof Error ? reason : new Error(reason ? String(reason) : "Tavily request aborted.");
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abortFromParent = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abortFromParent, { once: true });

	let response: Response;
	let responseText: string;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		responseText = await response.text();
	} catch (error) {
		if (controller.signal.aborted && !signal?.aborted) {
			throw new Error(`Tavily request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortFromParent);
	}

	if (!response.ok) {
		throw new Error(`Tavily request failed (HTTP ${response.status}): ${redact(responseText.slice(0, 500), apiKey)}`);
	}

	try {
		return JSON.parse(responseText) as T;
	} catch {
		throw new Error("Tavily returned non-JSON response.");
	}
}

function formatSearchResults(data: TavilySearchResponse, maxResults: number): string {
	const lines: string[] = [];
	const answer = asString(data.answer);
	if (answer) {
		lines.push(`Answer: ${compactSnippet(answer)}`, "");
	}

	const results = objectEntries<TavilyResult>(data.results).slice(0, maxResults);

	if (results.length === 0) {
		lines.push("No Tavily results returned.");
		return lines.join("\n");
	}

	lines.push(`Tavily results (${results.length}):`);
	results.forEach((result, index) => {
		const title = asString(result.title) ?? "Untitled";
		const url = asString(result.url) ?? "";
		const content = asString(result.content) ?? "";
		const score = typeof result.score === "number" ? ` score=${result.score.toFixed(3)}` : "";
		lines.push(`${index + 1}. ${title}${score}`);
		if (url) lines.push(`   ${url}`);
		if (content) lines.push(`   ${compactSnippet(content)}`);
	});

	return lines.join("\n");
}

function formatExtractResults(data: TavilyExtractResponse): string {
	const lines: string[] = [];
	const results = objectEntries<TavilyExtractResult>(data.results);

	if (results.length === 0) {
		lines.push("No Tavily extract results returned.");
	} else {
		lines.push(`Tavily extracted content (${results.length}):`);
	}

	results.forEach((result, index) => {
		const url = asString(result.url) ?? `result-${index + 1}`;
		const content = asString(result.raw_content) ?? asString(result.content) ?? "";
		const compact = content ? compactExtract(content) : { content: "[No extractable text returned]", truncated: false };
		lines.push("", `${index + 1}. ${url}${compact.truncated ? " [truncated]" : ""}`, compact.content);
	});

	const failed = objectEntries<Record<string, unknown>>(data.failed_results);
	if (failed.length > 0) {
		lines.push("", `Failed extractions: ${failed.length}`, JSON.stringify(failed).slice(0, 1000));
	}

	return lines.join("\n");
}

function searchResultSummaries(data: TavilySearchResponse, maxResults: number) {
	return objectEntries<TavilyResult>(data.results)
		.slice(0, maxResults)
		.map((result) => ({
			title: result.title,
			url: result.url,
			score: result.score,
		}));
}

function extractResultSummaries(data: TavilyExtractResponse, includeImages = false) {
	return objectEntries<TavilyExtractResult>(data.results).map((result) => {
		const images = imageUrlStrings(result.images);
		const summary: { url: unknown; contentBytes: number; imageCount?: number; images?: string[] } = {
			url: result.url,
			contentBytes: byteLength(asString(result.raw_content) ?? asString(result.content) ?? ""),
		};
		if (Array.isArray(result.images)) summary.imageCount = images.length;
		if (includeImages) summary.images = images;
		return summary;
	});
}

function failedResultSummaries(data: TavilyExtractResponse) {
	return objectEntries<{ url?: unknown; error?: unknown }>(data.failed_results)
		.slice(0, 10)
		.map((item) => ({
			url: asString(item.url),
			error: asString(item.error)?.slice(0, 300),
		}));
}

async function getApiKeyOrThrow(cwd: string): Promise<string> {
	const apiKey = await readApiKey(cwd);
	if (!apiKey) {
		throw new Error("TAVILY_API_KEY is missing. Export it before starting pi, or add it to the Git repo root .env only when that .env is gitignored and untracked.");
	}
	return apiKey;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "tavily_search",
		label: "Tavily Search",
		description:
			"Search the public internet via Tavily. Requires TAVILY_API_KEY in the environment, or in the Git repo root .env only when that .env is gitignored and untracked. Output is compacted and capped at 10 results.",
		promptSnippet: "Search the public internet via Tavily and return compact cited results.",
		promptGuidelines: [
			"Use tavily_search when the user asks for current web information, external documentation, news, or internet research that is not available from local files.",
			"Do not send secrets, credentials, .env values, private source code, unpublished business data, or sensitive user data in tavily_search queries.",
			"Prefer tavily_search results as leads; verify important claims against primary sources when decisions depend on them.",
		],
		parameters: TavilySearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("tavily_search query must not be blank.");
			const apiKey = await getApiKeyOrThrow(ctx.cwd);

			const maxResults = clampInteger(params.max_results, 5, MAX_RESULTS_LIMIT);
			const data = await tavilyRequest<TavilySearchResponse>(
				TAVILY_SEARCH_ENDPOINT,
				apiKey,
				{
					query,
					max_results: maxResults,
					search_depth: params.search_depth ?? "basic",
					topic: params.topic ?? "general",
					include_answer: params.include_answer ?? false,
					include_raw_content: false,
					include_images: false,
				},
				signal,
			);

			return {
				content: [{ type: "text", text: formatSearchResults(data, maxResults) }],
				details: {
					provider: "tavily",
					operation: "search",
					query: data.query ?? query,
					resultCount: searchResultSummaries(data, maxResults).length,
					responseTime: data.response_time,
					requestId: data.request_id,
					usage: data.usage,
					results: searchResultSummaries(data, maxResults),
				},
			};
		},
	});

	pi.registerTool({
		name: "tavily_extract",
		label: "Tavily Extract",
		description:
			"Extract compact page content from public URLs via Tavily. Use URLs supplied by the user or URLs returned by tavily_search. Max 5 URLs; output is truncated per URL.",
		promptSnippet: "Extract readable content from public URLs via Tavily.",
		promptGuidelines: [
			"Use tavily_extract after tavily_search when a search result snippet is not enough and the page content is needed.",
			"Do not use tavily_extract on private, localhost, intranet, signed, tokenized, or credential-bearing URLs.",
		],
		parameters: TavilyExtractParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await getApiKeyOrThrow(ctx.cwd);
			const urls = normalizePublicUrls(params.urls);
			const data = await tavilyRequest<TavilyExtractResponse>(
				TAVILY_EXTRACT_ENDPOINT,
				apiKey,
				{
					urls,
					extract_depth: params.extract_depth ?? "basic",
					format: params.format ?? "markdown",
					include_images: params.include_images ?? false,
				},
				signal,
			);

			return {
				content: [{ type: "text", text: formatExtractResults(data) }],
				details: {
					provider: "tavily",
					operation: "extract",
					urlCount: urls.length,
					responseTime: data.response_time,
					requestId: data.request_id,
					usage: data.usage,
					results: extractResultSummaries(data, params.include_images ?? false),
					failedResults: failedResultSummaries(data),
				},
			};
		},
	});

	pi.registerTool({
		name: "tavily_search_extract",
		label: "Tavily Search + Extract",
		description:
			"Search Tavily, then extract compact content from the top public result URLs. Use when the user has no URL but needs more than snippets. Defaults: search 5, extract top 3; max extract 5.",
		promptSnippet: "Search the web with Tavily, then extract the top result pages.",
		promptGuidelines: [
			"Use tavily_search_extract when the user has no URL but asks for deeper internet research or source content beyond search snippets.",
			"Avoid tavily_search_extract for quick fact lookup; use tavily_search first because extraction spends more credits and context.",
			"Do not send secrets, private source code, unpublished business data, or sensitive user data in tavily_search_extract queries.",
		],
		parameters: TavilySearchExtractParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) throw new Error("tavily_search_extract query must not be blank.");
			const apiKey = await getApiKeyOrThrow(ctx.cwd);

			const searchMaxResults = clampInteger(params.search_max_results, 5, MAX_RESULTS_LIMIT);
			const extractTopResults = clampInteger(params.extract_top_results, 3, MAX_EXTRACT_URLS);
			const searchData = await tavilyRequest<TavilySearchResponse>(
				TAVILY_SEARCH_ENDPOINT,
				apiKey,
				{
					query,
					max_results: searchMaxResults,
					search_depth: params.search_depth ?? "basic",
					topic: params.topic ?? "general",
					include_answer: false,
					include_raw_content: false,
					include_images: false,
				},
				signal,
			);

			const searchResults = objectEntries<TavilyResult>(searchData.results);
			const candidateUrls = searchResults.map((result) => asString(result.url)).filter((url): url is string => Boolean(url));
			const urls = filterPublicUrls(candidateUrls, extractTopResults);
			if (urls.length === 0) {
				return {
					content: [{ type: "text", text: `Search summary:\n${formatSearchResults(searchData, searchMaxResults)}\n\nNo extractable public URLs found in the top Tavily results.` }],
					details: {
						provider: "tavily",
						operation: "search_extract",
						query: searchData.query ?? query,
						searchResultCount: searchResultSummaries(searchData, searchMaxResults).length,
						extractedUrls: [],
						searchRequestId: searchData.request_id,
						searchUsage: searchData.usage,
						searchResults: searchResultSummaries(searchData, searchMaxResults),
					},
				};
			}
			const extractData = await tavilyRequest<TavilyExtractResponse>(
				TAVILY_EXTRACT_ENDPOINT,
				apiKey,
				{
					urls,
					extract_depth: params.extract_depth ?? "basic",
					format: params.format ?? "markdown",
					include_images: false,
				},
				signal,
			);

			const text = [`Search summary:\n${formatSearchResults(searchData, searchMaxResults)}`, "", formatExtractResults(extractData)].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					provider: "tavily",
					operation: "search_extract",
					query: searchData.query ?? query,
					searchResultCount: searchResultSummaries(searchData, searchMaxResults).length,
					extractedUrls: urls,
					searchRequestId: searchData.request_id,
					extractRequestId: extractData.request_id,
					searchUsage: searchData.usage,
					extractUsage: extractData.usage,
					searchResults: searchResultSummaries(searchData, searchMaxResults),
					extractResults: extractResultSummaries(extractData),
					failedResults: failedResultSummaries(extractData),
				},
			};
		},
	});
}
