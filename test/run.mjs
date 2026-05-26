#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(__dirname, "../src/index.ts");

function findPiRoot() {
	const candidates = [];
	if (process.env.PI_CODING_AGENT_ROOT) candidates.push(process.env.PI_CODING_AGENT_ROOT);
	const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 3000 });
	if (npmRoot.status === 0) candidates.push(join(npmRoot.stdout.trim(), "@earendil-works/pi-coding-agent"));
	candidates.push("/home/wasti/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent");

	for (const candidate of candidates) {
		if (candidate && existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
	}
	throw new Error("Could not locate @earendil-works/pi-coding-agent. Set PI_CODING_AGENT_ROOT.");
}

async function loadTools() {
	const piRoot = findPiRoot();
	const require = createRequire(join(piRoot, "package.json"));
	const { createJiti } = require("jiti");
	const alias = {
		"@earendil-works/pi-ai": join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
		"@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
		typebox: join(piRoot, "node_modules/typebox/build/index.mjs"),
	};
	const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true, alias });
	const mod = await jiti.import(extensionPath);
	const registerToolCalls = [];
	const pi = {
		registerTool(tool) {
			registerToolCalls.push(tool);
		},
	};
	(mod.default ?? mod)(pi);
	return new Map(registerToolCalls.map((tool) => [tool.name, tool]));
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.TAVILY_API_KEY;

function installFetch(responseFactory) {
	const calls = [];
	globalThis.fetch = async (url, options = {}) => {
		const body = options.body ? JSON.parse(String(options.body)) : undefined;
		const call = { url: String(url), options, body };
		calls.push(call);
		const response = await responseFactory(call, calls.length);
		return new Response(JSON.stringify(response.body ?? response), {
			status: response.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return calls;
}

function restoreGlobals() {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
	else process.env.TAVILY_API_KEY = originalKey;
}

async function execute(tool, params, { signal, cwd = process.cwd() } = {}) {
	return tool.execute("test-call", params, signal, undefined, { cwd });
}

async function rejectsWith(promise, pattern) {
	await assert.rejects(promise, (error) => {
		assert.match(String(error?.message ?? error), pattern);
		return true;
	});
}

async function catchError(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected promise to reject.");
}

async function withTempDir(callback) {
	const dir = await mkdtemp(join(tmpdir(), "tavily-extension-test-"));
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function initGit(dir) {
	const git = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8", timeout: 3000 });
	assert.equal(git.status, 0, git.stderr);
}

async function withTempGitRepo(callback) {
	await withTempDir(async (dir) => {
		initGit(dir);
		await writeFile(join(dir, ".gitignore"), ".env\n", "utf8");
		await writeFile(join(dir, ".env"), "TAVILY_API_KEY=root-env-key\n", "utf8");
		await mkdir(join(dir, "nested"));
		await callback(dir, join(dir, "nested"));
	});
}

async function test(name, fn) {
	try {
		await fn();
		console.log(`ok - ${name}`);
	} finally {
		restoreGlobals();
	}
}

const tools = await loadTools();
const search = tools.get("tavily_search");
const extract = tools.get("tavily_extract");
const searchExtract = tools.get("tavily_search_extract");
assert(search, "tavily_search should register");
assert(extract, "tavily_extract should register");
assert(searchExtract, "tavily_search_extract should register");

await test("rejects trailing-dot localhost/private hosts before fetch", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	const calls = installFetch(() => {
		throw new Error("fetch must not be called");
	});
	for (const url of ["http://localhost./", "https://printer.local./", "https://box.lan./", "https://host.internal./"]) {
		await rejectsWith(execute(extract, { urls: [url] }), /refuses non-public|localhost|private-network/i);
	}
	assert.equal(calls.length, 0);
});

await test("blank queries reject before API-key lookup or fetch", async () => {
	delete process.env.TAVILY_API_KEY;
	const calls = installFetch(() => {
		throw new Error("fetch must not be called");
	});
	await rejectsWith(execute(search, { query: "   " }), /query must not be blank/i);
	await rejectsWith(execute(searchExtract, { query: "\t" }), /query must not be blank/i);
	assert.equal(calls.length, 0);
});

await test("honors already-aborted parent signal before fetch", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	const calls = installFetch(() => ({ results: [] }));
	const controller = new AbortController();
	controller.abort("caller stopped");
	await rejectsWith(execute(search, { query: "current news" }, { signal: controller.signal }), /caller stopped|aborted/i);
	assert.equal(calls.length, 0);
});

await test("search request clamps max_results and disables raw/images", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	const calls = installFetch(() => ({ query: "q", results: [] }));
	await execute(search, { query: "q", max_results: 999, include_answer: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].body.max_results, 10);
	assert.equal(calls[0].body.include_raw_content, false);
	assert.equal(calls[0].body.include_images, false);
});

await test("long one-line snippets are non-empty and marked truncated", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	const long = "alpha ".repeat(600);
	installFetch(() => ({
		query: "q",
		answer: long,
		results: [null, "bad", { title: "Result", url: "https://example.com/a", content: long, score: 0.9 }],
	}));
	const result = await execute(search, { query: "q", include_answer: true });
	const text = result.content[0].text;
	const answerLine = text.split("\n")[0];
	assert.match(answerLine, /^Answer: alpha/);
	assert.match(answerLine, /…\[truncated\]$/);
	assert(answerLine.length > "Answer: …[truncated]".length);
	assert.match(text, /1\. Result/);
});

await test("tavily_extract details and request body include image URLs only when requested", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	const calls = installFetch(() => ({
		results: [{ url: "https://example.com/a", raw_content: "€", images: ["https://img.example/a.png", " ", 42, " https://img.example/b.png "] }],
	}));
	const withImages = await execute(extract, { urls: ["https://example.com/a"], include_images: true });
	assert.equal(calls[0].body.include_images, true);
	assert.equal(withImages.details.results[0].contentBytes, 3);
	assert.equal(withImages.details.results[0].imageCount, 2);
	assert.deepEqual(withImages.details.results[0].images, ["https://img.example/a.png", "https://img.example/b.png"]);

	const withoutImages = await execute(extract, { urls: ["https://example.com/a"], include_images: false });
	assert.equal(calls[1].body.include_images, false);
	assert.equal(withoutImages.details.results[0].imageCount, 2);
	assert.equal(Object.hasOwn(withoutImages.details.results[0], "images"), false);
});

await test("HTTP error messages redact the Tavily API key", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	installFetch(() => ({ status: 401, body: { error: "bad key test-key" } }));
	const error = await catchError(execute(search, { query: "q" }));
	const message = String(error.message);
	assert.match(message, /\[REDACTED_TAVILY_API_KEY\]/);
	assert.doesNotMatch(message, /test-key/);
});

await test("tavily_extract rejects sensitive or over-limit URLs before API-key lookup or fetch", async () => {
	delete process.env.TAVILY_API_KEY;
	const calls = installFetch(() => {
		throw new Error("fetch must not be called");
	});
	for (const url of [
		"https://user:pass@example.com/x",
		"https://192.168.0.1/x",
		"https://example.com/?token=x",
		"https://example.com/#",
		"https://example.com/#section",
		"https://example.com/#access_token=x",
	]) {
		await rejectsWith(execute(extract, { urls: [url] }), /refuses|only accepts|sensitive|credential|non-public/i);
	}
	await rejectsWith(
		execute(extract, { urls: ["https://a.com/1", "https://b.com/2", "https://c.com/3", "https://d.com/4", "https://e.com/5", "https://f.com/6"] }),
		/at most 5 URLs/i,
	);
	assert.equal(calls.length, 0);
});

await test("repo-root .env fallback works from nested cwd when ignored and untracked", async () => {
	delete process.env.TAVILY_API_KEY;
	await withTempGitRepo(async (_root, nested) => {
		const calls = installFetch(() => ({ query: "q", results: [] }));
		await execute(search, { query: "q" }, { cwd: nested });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.headers.Authorization, "Bearer root-env-key");
	});
});

await test("repo-root .env fallback refuses tracked or not-gitignored .env", async () => {
	delete process.env.TAVILY_API_KEY;
	await withTempDir(async (dir) => {
		initGit(dir);
		await writeFile(join(dir, ".env"), "TAVILY_API_KEY=tracked-key\n", "utf8");
		const add = spawnSync("git", ["add", ".env"], { cwd: dir, encoding: "utf8", timeout: 3000 });
		assert.equal(add.status, 0, add.stderr);
		const calls = installFetch(() => ({ query: "q", results: [] }));
		await rejectsWith(execute(search, { query: "q" }, { cwd: dir }), /TAVILY_API_KEY is missing/i);
		assert.equal(calls.length, 0);
	});

	await withTempDir(async (dir) => {
		initGit(dir);
		await writeFile(join(dir, ".env"), "TAVILY_API_KEY=not-ignored-key\n", "utf8");
		const calls = installFetch(() => ({ query: "q", results: [] }));
		await rejectsWith(execute(search, { query: "q" }, { cwd: dir }), /TAVILY_API_KEY is missing/i);
		assert.equal(calls.length, 0);
	});
});

await test("search_extract searches, selects safe result URLs, then extracts combined content", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	const calls = installFetch((_call, index) => {
		if (index === 1) {
			return {
				query: "q",
				request_id: "search-request",
				results: [
					{ title: "Local", url: "http://localhost./x", content: "skip" },
					{ title: "Guide", url: "https://docs.tavily.com/guides/search", content: "search guide", score: 0.9 },
					{ title: "Duplicate", url: "https://docs.tavily.com/guides/search", content: "duplicate" },
					{ title: "API", url: "https://api.tavily.com/docs", content: "api docs", score: 0.8 },
					{ title: "Extra", url: "https://www.tavily.com/blog", content: "extra" },
				],
			};
		}
		return {
			request_id: "extract-request",
			results: [
				{ url: "https://docs.tavily.com/guides/search", raw_content: "Guide body" },
				{ url: "https://api.tavily.com/docs", raw_content: "API body" },
			],
		};
	});

	const result = await execute(searchExtract, { query: "q", extract_top_results: 2 });

	assert.equal(calls.length, 2);
	assert.match(calls[0].url, /\/search$/);
	assert.equal(calls[0].body.query, "q");
	assert.equal(calls[0].body.max_results, 5);
	assert.match(calls[1].url, /\/extract$/);
	assert.deepEqual(calls[1].body.urls, ["https://docs.tavily.com/guides/search", "https://api.tavily.com/docs"]);
	assert.equal(calls[1].body.include_images, false);
	assert.deepEqual(result.details.extractedUrls, ["https://docs.tavily.com/guides/search", "https://api.tavily.com/docs"]);
	assert.equal(result.details.searchRequestId, "search-request");
	assert.equal(result.details.extractRequestId, "extract-request");
	assert.match(result.content[0].text, /Search summary:/);
	assert.match(result.content[0].text, /2\. Guide/);
	assert.match(result.content[0].text, /Tavily extracted content \(2\):/);
	assert.match(result.content[0].text, /Guide body/);
	assert.match(result.content[0].text, /API body/);
});

await test("search_extract skips unsafe result URLs instead of throwing", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	installFetch(() => ({
		query: "q",
		results: [
			{ title: "Local", url: "http://localhost./x", content: "skip" },
			{ title: "Token", url: "https://example.com/?token=secret", content: "skip" },
		],
	}));
	const result = await execute(searchExtract, { query: "q" });
	assert.deepEqual(result.details.extractedUrls, []);
	assert.match(result.content[0].text, /No extractable public URLs/);
});

console.log("all tavily-search extension tests passed");
