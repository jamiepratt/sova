import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeProviderLimits } from "./gate.ts";
import { applyGates, CLAUDE_PI_PROVIDER } from "./index.ts";

const tmpAgent = () => fs.mkdtempSync(path.join(os.tmpdir(), "provider-limits-index-"));
const model = (provider: string, api: string) => ({ id: "m", provider, api }) as any;
const slots = (dir: string, key: string) => {
	try {
		return fs.readdirSync(path.join(dir, "provider-limits", key, "slots")).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
};

function fakePi() {
	const configs = new Map<string, any>();
	const native = new Map<string, any>();
	const providers = new Map<string, any>();
	const registered: string[] = [];
	return {
		configs,
		registered,
		native,
		providers,
		pi: {
			registerProvider(name: any, config?: any) {
				if (typeof name !== "string") {
					registered.push(name.id);
					native.set(name.id, name);
					providers.set(name.id, name);
					configs.delete(name.id);
					return;
				}
				registered.push(name);
				native.delete(name);
				configs.set(name, { ...configs.get(name), ...config });
			},
		},
		registry: (models: any[]) => ({
			getAll: () => models,
			getRegisteredProviderConfig: (p: string) => configs.get(p),
			getRegisteredNativeProvider: (p: string) => native.get(p),
			getProvider: (p: string) => providers.get(p) ?? (models.some(m => m.provider === p) ? {
				streamSimple: configs.get(p)?.streamSimple ?? (() => { throw new Error("unused fixture stream"); }),
			} : undefined),
		}),
	};
}

test("each limited provider this runtime has is re-registered once, gated; others are left alone", () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { zai: 5, "ollama-cloud": 10, absent: 2 } });
	const f = fakePi();
	const reg = f.registry([model("zai", "openai-completions"), model("ollama-cloud", "openai-completions"), model("openai-codex", "openai-codex-responses")]);
	assert.deepEqual(applyGates(f.pi, reg, () => dir).sort(), ["ollama-cloud", "zai"], "no models here: not registered; no limit: untouched");
	assert.equal(f.configs.get("zai")!.api, "openai-completions");
	assert.deepEqual(applyGates(f.pi, reg, () => dir), [], "already gated: nothing re-registered");
});

test("the claude-code limit wraps the stream the claude-code extension registered, counting under `claude-code`", async () => {
	const dir = tmpAgent();
	writeProviderLimits(dir, { version: 1, limits: { "claude-code": 1 } });
	const f = fakePi();
	let during = -1;
	const original = (m: any) => {
		during = slots(dir, "claude-code");
		const s = createAssistantMessageEventStream();
		queueMicrotask(() => {
			// A non-HTTP error that mentions a rate limit: the claude-code stream is never retried here.
			s.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id, usage: {} as any, stopReason: "error", errorMessage: "rate limit", timestamp: 0 } });
			s.end();
		});
		return s;
	};
	f.configs.set(CLAUDE_PI_PROVIDER, { api: CLAUDE_PI_PROVIDER, streamSimple: original });
	const reg = f.registry([model(CLAUDE_PI_PROVIDER, CLAUDE_PI_PROVIDER)]);
	assert.deepEqual(applyGates(f.pi, reg, () => dir), [CLAUDE_PI_PROVIDER]);
	const gated = f.configs.get(CLAUDE_PI_PROVIDER)!.streamSimple;
	assert.notEqual(gated, original);
	const events = [];
	for await (const e of gated(model(CLAUDE_PI_PROVIDER, CLAUDE_PI_PROVIDER), { messages: [] })) events.push(e);
	assert.equal(during, 1, "the original stream ran holding one claude-code slot");
	assert.deepEqual(events.map((e: any) => e.type), ["error"], "passed through once, not re-queued");
	assert.equal(slots(dir, "claude-code"), 0);
	assert.deepEqual(applyGates(f.pi, reg, () => dir), [], "its own gated stream is never wrapped twice");
});

for (const reason of ["stop", "error", "aborted"] as const) {
	test(`configured provider runs under one slot and releases on ${reason}`, async () => {
		const dir = tmpAgent();
		try {
			writeProviderLimits(dir, { version: 1, limits: { fixture: 1 } });
			const f = fakePi();
			let calls = 0;
			const source = { streamSimple(m: any, _context: any, options: any) {
				assert.equal(this, source, "captured provider retains its receiver");
				assert.equal(options.apiKey, "offline-key");
				assert.equal(slots(dir, "fixture"), 1);
				calls++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = { role: "assistant", content: [], api: m.api, provider: m.provider,
						model: m.id, usage: {} as any, stopReason: reason, timestamp: 0 } as any;
					stream.push(reason === "stop" ? { type: "done", reason, message } : { type: "error", reason, error: message });
					stream.end();
				});
				return stream;
			} };
			f.providers.set("fixture", source);
			const reg = f.registry([model("fixture", "openai-completions")]);
			assert.deepEqual(applyGates(f.pi, reg, () => dir), ["fixture"]);
			assert.deepEqual(applyGates(f.pi, reg, () => dir), []);
			for await (const _event of f.configs.get("fixture").streamSimple(model("fixture", "openai-completions"), { messages: [] }, { apiKey: "offline-key" })) { /* consume */ }
			assert.equal(calls, 1);
			assert.equal(slots(dir, "fixture"), 0);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
}

test("legacy registration retains name, endpoint, auth and models, and its stream receiver", async () => {
	const dir = tmpAgent();
	try {
		writeProviderLimits(dir, { version: 1, limits: { fixture: 1 } });
		const f = fakePi();
		const config = { api: "openai-completions", name: "Fixture", baseUrl: "https://example.invalid", apiKey: "offline-key",
			models: [model("fixture", "openai-completions")],
			streamSimple(this: any, m: any) {
				assert.equal(this, config);
				assert.equal(slots(dir, "fixture"), 1);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => { stream.push({ type: "error", reason: "aborted", error: {
					role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id,
					usage: {} as any, stopReason: "aborted", timestamp: 0,
				} }); stream.end(); });
				return stream;
			} };
		f.configs.set("fixture", config);
		applyGates(f.pi, f.registry(config.models), () => dir);
		const gated = f.configs.get("fixture");
		for (const key of ["name", "baseUrl", "apiKey", "models"]) assert.equal(gated[key], (config as any)[key]);
		for await (const _event of gated.streamSimple(config.models[0], { messages: [] })) { /* consume */ }
		assert.equal(slots(dir, "fixture"), 0);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("native overload retains frozen class provider catalog, auth and all method receivers", async () => {
	const dir = tmpAgent();
	try {
		writeProviderLimits(dir, { version: 1, limits: { fixture: 1 } });
		const f = fakePi();
		class Native {
			#models = [model("fixture", "openai-completions")];
			id = "fixture";
			auth = { apiKey: { resolve: () => ({ apiKey: "offline-key" }) } };
			get name() { return this.#models[0].provider; }
			getModels() { return this.#models; }
			getAllModels() { return this.#models; }
			filterModels() { return this.#models; }
			stream() { return this.#models; }
			cancelDeferred() { return this.#models; }
			streamSimple = (m: any) => {
				assert.equal(slots(dir, "fixture"), 1);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => { stream.push({ type: "error", reason: "aborted", error: {
					role: "assistant", content: [], api: m.api, provider: m.provider, model: m.id,
					usage: {} as any, stopReason: "aborted", timestamp: 0,
				} }); stream.end(); });
				return stream;
			};
		}
		const original = Object.freeze(new Native());
		f.native.set("fixture", original); f.providers.set("fixture", original);
		const reg = f.registry(original.getModels());
		assert.deepEqual(applyGates(f.pi, reg, () => dir), ["fixture"]);
		const wrapped = f.native.get("fixture");
		assert.ok(wrapped, "config overload would delete the native provider");
		assert.equal(wrapped.name, original.name); assert.equal(wrapped.auth, original.auth);
		for (const method of ["getModels", "getAllModels", "filterModels", "stream", "cancelDeferred"]) {
			assert.equal(wrapped[method](), original.getModels(), `${method} keeps private receiver`);
		}
		assert.deepEqual(applyGates(f.pi, reg, () => dir), []);
		for await (const _event of wrapped.streamSimple(original.getModels()[0], { messages: [] })) { /* consume */ }
		assert.equal(slots(dir, "fixture"), 0);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
