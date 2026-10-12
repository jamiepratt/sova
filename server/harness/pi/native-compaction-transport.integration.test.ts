import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { until } from '../../test-wait.ts';
import { test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { loadPi } from './testing/load-pi.ts';
import { callNativeCompaction } from './native-compaction-call.ts';
import { latestNativeCompaction, replayNativePrefix, type NativeCompactionState } from './native-compaction-state.ts';
import { createNativeCompactionExtension, installNativeCompactionHooks } from './native-compaction-extension.ts';

const pi = await loadPi();
const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'transport-fixture' } })).toString('base64')}.unsigned`;
const opaque = { type: 'compaction', id: 'cmp_transport', encrypted_content: 'synthetic-opaque-only', future: { unchanged: true } };
const usage = { input_tokens: 29, output_tokens: 3, total_tokens: 32 };
const summary = 'Portable prefix summary';
const summaryItem = { role: 'user', content: [{ type: 'input_text', text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>` }] };
function events(id: string, compact = false, artifact = opaque): Record<string, unknown>[] {
  const item = compact ? artifact : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Answer ${id}`, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: compact ? item : { ...item, content: [] } },
    ...(!compact ? [
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: `Answer ${id}` },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text: `Answer ${id}` },
    ] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage } },
  ];
}
async function fixture(uniqueArtifacts = false, dispatch?: 'threshold' | 'overflow') {
  const root = mkdtempSync(join(tmpdir(), 'native-transport-'));
  const authPath = join(root, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'unused', expires: Number.MAX_SAFE_INTEGER } }), { mode: 0o600 });
  const runtime = await pi.agent.ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await runtime.refresh({ providers: ['openai-codex'], allowNetwork: false });
  const registry = new pi.agent.ModelRegistry(runtime);
  const catalog = registry.getAll().find(m => m.provider === 'openai-codex' && m.api === 'openai-codex-responses');
  assert.ok(catalog);
  const model = { ...catalog, compat: { ...catalog.compat, supportsMidConvoSystemMessages: false, supportsAdditionalTools: false, supportsToolSearch: false } };
  const bodies: any[] = [];
  let serial = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    // Pi 1.0.3 compresses SSE bodies as zstd when the runtime supports it.
    // Decode exactly the advertised wire encoding, not the compressed bytes as UTF-8.
    const encoding = req.headers['content-encoding'];
    assert.ok(encoding === undefined || encoding === 'zstd', `unexpected encoding: ${encoding}`);
    const body = JSON.parse((encoding === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8'));
    bodies.push(body);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers['chatgpt-account-id'], 'transport-fixture');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `http_${++serial}`;
    const responseEvents = dispatch === 'overflow' && serial === 1
      ? [{ type: 'response.failed', response: { id, status: 'failed', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } }]
      : events(id, body.input.some((i: any) => i.type === 'compaction_trigger'), uniqueArtifacts ? { ...opaque, id: `cmp_${id}`, encrypted_content: `synthetic-${id}` } : opaque);
    if (dispatch === 'threshold' && serial === 1) {
      const completed = responseEvents.at(-1) as any;
      completed.response.usage = { input_tokens: model.contextWindow - 64, output_tokens: 3, total_tokens: model.contextWindow - 61 };
    }
    for (const event of responseEvents) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (let i = 0; i < frame.length; i += 17) res.write(frame.slice(i, i + 17));
    }
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => socket.on('message', data => {
    const body = JSON.parse(String(data));
    bodies.push(body);
    for (const event of events(`ws_${++serial}`)) socket.send(JSON.stringify(event));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/backend-api`;
  const fetchLocal: typeof fetch = ((input: any, init?: RequestInit) => {
    // The provider still generates its normal service URL and request-time OAuth headers;
    // only this request-local public seam redirects bytes to a synthetic fixture.
    assert.ok(String(input).startsWith('https://chatgpt.com/'));
    return fetch(`${url}/codex/responses`, init);
  }) as typeof fetch;
  return { root, runtime, registry, model, bodies, url, fetchLocal, async close() {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  } };
}
async function result(stream: any) {
  for await (const _event of stream) { /* consume the actual pinned parser */ }
  const answer = await stream.result();
  assert.equal(answer.stopReason, 'stop', answer.errorMessage);
  return answer;
}
function checkpoint(model: any, replacementHistory: Record<string, unknown>[]): NativeCompactionState {
  return { v: 1, protocol: 'codex-responses-v2', provider: 'openai-codex', api: 'openai-codex-responses', modelId: model.id, endpointOrigin: 'https://chatgpt.com', accountFingerprint: 'a'.repeat(64), boundary: { kind: 'pi-old-prefix', firstKeptEntryId: 'kept' }, replacementHistory, responseId: 'native-fixture-response' };
}

test('pinned SSE carries raw opaque compaction into the first ordinary request, without a trigger or service continuation', async () => {
  const f = await fixture();
  try {
    const native = await callNativeCompaction({ registry: f.registry, model: f.model, context: { messages: [{ role: 'user', content: 'Old prefix fact', timestamp: 1 }] }, options: { fetch: f.fetchLocal } });
    assert.deepEqual(native.item, opaque);
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(f.bodies[0].input.at(-1), { type: 'compaction_trigger' });
    const state = checkpoint(f.model, native.replacementHistory);
    const sm = pi.agent.SessionManager.inMemory(f.root);
    sm.appendMessage({ role: 'user', content: 'Old prefix fact', timestamp: 1 });
    const kept = sm.appendMessage({ role: 'user', content: 'Retained tail must survive', timestamp: 2 });
    sm.appendCompaction(summary, kept, 100);
    const context = { messages: pi.agent.convertToLlm(sm.buildSessionProjection().messages) };
    await result(f.registry.streamSimple(f.model, context, { transport: 'sse', maxRetries: 0, fetch: f.fetchLocal,
      onPayload: body => replayNativePrefix(body, summaryItem, state, { summaryPresent: true }) as any,
    }));
    const ordinary = f.bodies[1];
    assert.deepEqual(ordinary.input.filter((i: any) => i.type === 'compaction'), [opaque]);
    assert.ok(JSON.stringify(ordinary.input).includes('Retained tail must survive'));
    assert.ok(!JSON.stringify(ordinary.input).includes(summary));
    assert.equal(ordinary.previous_response_id, undefined);
    assert.equal(ordinary.context_management, undefined);
    assert.equal(ordinary.store, false);
    assert.ok(!ordinary.input.some((i: any) => i.type === 'compaction_trigger'));
  } finally { await f.close(); }
});

test('production extension compacts twice through the SDK hook, replacing prior artifact plus only the newly old prefix', async () => {
  const f = await fixture(true);
  let session: Awaited<ReturnType<typeof pi.agent.createAgentSession>>['session'] | undefined;
  try {
    const sm = pi.agent.SessionManager.inMemory(f.root);
    const old = 'ORIGINAL OLD FACT '.repeat(80);
    const formerlyKept = 'FORMERLY KEPT FACT '.repeat(80);
    const newestKept = 'NEWEST KEPT FACT '.repeat(80);
    sm.appendMessage({ role: 'user', content: 'OLDER INPUT RETAINED BY NATIVE PROTOCOL', timestamp: 1 });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: old }], provider: f.model.provider, api: f.model.api, model: f.model.id, stopReason: 'stop', timestamp: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const firstKept = sm.appendMessage({ role: 'user', content: formerlyKept, timestamp: 2 });
    const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
    const native = createNativeCompactionExtension({ host: () => ({ memoryOn: () => false, assertOwned() {} }), enabled: () => true, streamOptions: { fetch: f.fetchLocal, transport: 'sse' } });
    const preparations: Array<{ firstKept: string; prefix: string; kept: string; leaf: string | null }> = [];
    const tools = (api: any) => {
      api.on('session_before_compact', (event: any, ctx: any) => {
        const projection = ctx.sessionManager.buildSessionProjection();
        const cut = projection.entries.findIndex((entry: any) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
        preparations.push({ firstKept: event.preparation.firstKeptEntryId,
          prefix: JSON.stringify(projection.entries.slice(0, cut).flatMap((entry: any) => entry.messages)),
          kept: JSON.stringify(projection.entries.slice(cut).flatMap((entry: any) => entry.messages)), leaf: ctx.sessionManager.getLeafId() });
      });
      pi.agent.createCodemodeExtension({ mode: 'only' })(api);
      api.registerTool({ name: 'echo_fixture', label: 'Echo', description: 'Echo a fixture word.',
        namespace: { name: 'fixture_namespace', description: 'Synthetic namespace only' },
        parameters: pi.typebox.Type.Object({ word: pi.typebox.Type.String() }),
        execute: async () => ({ content: [], details: {} }) });
      api.registerTool({ name: 'hidden_fixture', label: 'Hidden', description: 'HIDDEN DECLARATION MUST NOT LEAK', exposure: 'hidden',
        parameters: pi.typebox.Type.Object({}), execute: async () => ({ content: [], details: {} }) });
    };
    const loader = new pi.agent.DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      systemPromptOverride: () => 'Effective synthetic instructions', appendSystemPromptOverride: () => [],
      extensionFactories: [native, tools],
    });
    await loader.reload();
    ({ session } = await pi.agent.createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime: f.runtime, model: f.model,
      sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: 'builtin' }));
    // Public stream seam redirects ordinary requests too, before the production replay wrapper.
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => stream(model, context, { ...options, fetch: f.fetchLocal, transport: 'sse', maxRetries: 0 });
    await session.bindExtensions({});
    installNativeCompactionHooks(session);
    session.setActiveToolsByName(['echo_fixture', 'codemode']);
    await session.compact('Preserve exact facts');
    const firstState = latestNativeCompaction(sm.getBranch());
    assert.ok(firstState, 'first checkpoint must be created by the production hook');
    assert.equal(preparations.length, 1);
    assert.equal(preparations[0]!.firstKept, firstKept, JSON.stringify(preparations));
    assert.equal(firstState.boundary.firstKeptEntryId, preparations[0]!.firstKept);
    assert.equal(f.bodies.length, 2, 'one real portable call and one native call per compaction');
    const firstNative = f.bodies[1];
    assert.ok(JSON.stringify(firstNative.input).includes(old));
    assert.ok(!JSON.stringify(firstNative.input).includes(formerlyKept));
    assert.ok(JSON.stringify(f.bodies[0].input).includes('Preserve exact facts'));
    await session.prompt('Ordinary turn after first checkpoint');
    assert.equal(f.bodies.length, 3);
    const firstOrdinary = f.bodies[2];
    assert.deepEqual(firstNative.tools, firstOrdinary.tools, 'pending codemode-only loadout matches the actual ordinary serializer');
    assert.equal(firstNative.instructions, firstOrdinary.instructions);
    assert.deepEqual(firstNative.tools.map((tool: any) => tool.name), ['codemode']);
    assert.equal(firstNative.tools[0].type, 'custom', 'positive grammar control: codemode uses raw JavaScript grammar, not a JSON function');
    assert.equal(firstNative.tools[0].format.type, 'grammar');
    assert.ok(firstNative.tools[0].description.includes('fixture_namespace'), 'namespace grouping survives in the effective codemode declaration');
    assert.ok(!JSON.stringify(firstNative.tools).includes('HIDDEN DECLARATION MUST NOT LEAK'));
    // Pending declarations must be taken from the new effective loadout, not the
    // prior checkpoint's system record or the registered-tools list.
    session.setActiveToolsByName(['echo_fixture']);
    const secondKept = sm.appendMessage({ role: 'user', content: newestKept, timestamp: 3 });
    session.refreshContext();
    await session.compact();
    const secondState = latestNativeCompaction(sm.getBranch());
    assert.ok(secondState, 'second checkpoint must be created by the production hook');
    assert.equal(preparations.length, 2, JSON.stringify(preparations));
    assert.equal(preparations[1]!.firstKept, secondKept, JSON.stringify(preparations));
    assert.equal(secondState.boundary.firstKeptEntryId, preparations[1]!.firstKept, 'native metadata must record the boundary actually selected by Pi');
    assert.ok(preparations[1]!.prefix.includes(formerlyKept));
    assert.ok(!preparations[1]!.prefix.includes(newestKept));
    assert.ok(preparations[1]!.kept.includes(newestKept));
    assert.notDeepEqual(secondState.replacementHistory, firstState.replacementHistory);
    assert.equal(f.bodies.length, 5);
    const secondNative = f.bodies[4];
    assert.deepEqual(secondNative.input.filter((item: any) => item.type === 'compaction'), firstState.replacementHistory.filter(item => item.type === 'compaction'));
    assert.equal(secondNative.input.filter((item: any) => JSON.stringify(item).includes(formerlyKept)).length, 1);
    assert.ok(!JSON.stringify(secondNative.input).includes(old));
    assert.ok(!JSON.stringify(secondNative.input).includes(newestKept));
    assert.deepEqual(secondNative.input.at(-1), { type: 'compaction_trigger' });
    await session.prompt('Ordinary turn after two checkpoints');
    assert.equal(f.bodies.length, 6);
    const ordinary = f.bodies[5];
    assert.deepEqual(ordinary.input.filter((item: any) => item.type === 'compaction'), secondState.replacementHistory.filter(item => item.type === 'compaction'));
    assert.ok(JSON.stringify(ordinary.input).includes(newestKept));
    // User inputs carried by the native replacement remain once, not a duplicate tail.
    assert.equal(ordinary.input.filter((item: any) => JSON.stringify(item).includes(formerlyKept)).length, 1);
    assert.ok(!JSON.stringify(ordinary.input).includes(old));
    assert.ok(!ordinary.input.some((item: any) => item.type === 'compaction_trigger'));
    assert.equal(ordinary.previous_response_id, undefined);
    assert.equal(ordinary.store, false);
    assert.equal(secondNative.instructions, ordinary.instructions);
    assert.deepEqual(secondNative.tools, ordinary.tools);
    assert.deepEqual(secondNative.tools.map((tool: any) => tool.name), ['echo_fixture']);
    assert.equal(secondNative.tools[0].type, 'function');
    assert.notDeepEqual(secondNative.tools, firstNative.tools, 'positive control: the effective loadout actually changed');
    assert.equal(sm.getBranch().filter(entry => entry.type === 'compaction').length, 2);
    assert.equal(sm.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').length, 3, 'nested portable/native responses never become transcript assistant turns');
  } finally { session?.dispose(); await f.close(); }
});

for (const declarationMode of ['additional_tools', 'tool_search_output'] as const) {
  test(`production native hook preserves positive ${declarationMode} declarations through the pinned serializer and replay`, async () => {
    const f = await fixture();
    let session: Awaited<ReturnType<typeof pi.agent.createAgentSession>>['session'] | undefined;
    try {
      const model = { ...f.model, compat: { ...f.model.compat, supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: declarationMode === 'additional_tools', supportsToolSearch: declarationMode === 'tool_search_output' } };
      const sm = pi.agent.SessionManager.inMemory(f.root);
      sm.appendMessage({ role: 'user', content: 'DECLARATION OLD INPUT', timestamp: 1 });
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'DECLARATION OLD ASSISTANT '.repeat(80) }],
        provider: model.provider, api: model.api, model: model.id, stopReason: 'stop', timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      sm.appendMessage({ role: 'user', content: 'DECLARATION KEPT TAIL '.repeat(80), timestamp: 3 });
      const typeboxSchema = pi.typebox.Type.Object({ query: pi.typebox.Type.String() });
      const declaration = { name: 'late_context_tool', description: 'POSITIVE CONTEXT DECLARATION',
        // A context hook adds an already-serialized declaration, not a registered
        // executable tool. Match Pi's toToolDeclaration JSON round-trip without
        // assuming this pinned schema builder carries symbols or a special prototype.
        parameters: JSON.parse(JSON.stringify(typeboxSchema)) };
      // An additive final context declaration forces the serializer's real supported
      // branch. Merely toggling compat while all declarations live at the head would
      // leave both additional_tools and tool_search unexercised.
      const contextTools = (api: any) => api.on('context', (event: any) => ({ messages: [...event.messages,
        { role: 'system', content: '', timestamp: 4, toolsAdded: [declaration] }] }));
      const payloadShapes: unknown[] = [];
      const unsafeJson = (value: unknown): string[] => {
        const reasons: string[] = [];
        const ancestors = new Set<object>();
        const inspect = (node: unknown, path: string, allowUndefined = false) => {
          if (node === undefined && allowUndefined) return;
          if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
          if (typeof node === 'number') { if (!Number.isFinite(node)) reasons.push(`${path}:nonfinite`); return; }
          if (typeof node !== 'object') { reasons.push(`${path}:${typeof node}`); return; }
          if (ancestors.has(node)) { reasons.push(`${path}:cycle`); return; }
          if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
            reasons.push(`${path}:nonplain-prototype`);
          }
          ancestors.add(node);
          for (const key of Reflect.ownKeys(node)) {
            if (Array.isArray(node) && key === 'length') continue;
            if (typeof key !== 'string') { reasons.push(`${path}:symbol-key`); continue; }
            const desc = Object.getOwnPropertyDescriptor(node, key)!;
            // Paths describe generated structure only; no property values or symbol
            // descriptions are retained, and accessors are inspected, never called.
            const childPath = `${path}.${key}`;
            if (!desc.enumerable) reasons.push(`${childPath}:nonenumerable`);
            if (!('value' in desc)) { reasons.push(`${childPath}:accessor`); continue; }
            inspect(desc.value, childPath, !Array.isArray(node));
          }
          ancestors.delete(node);
        };
        inspect(value, '$');
        return reasons;
      };
      const native = createNativeCompactionExtension({ enabled: () => true,
        host: () => ({ memoryOn: () => false, assertOwned() {} }), streamOptions: { fetch: f.fetchLocal, transport: 'sse',
          onPayload(body: any) {
            // Leak-safe observability before native validation: structure only, never
            // OAuth headers, tool schemas, input text or opaque artifact contents.
            payloadShapes.push({ rawSchemaUnsafe: unsafeJson(typeboxSchema), unsafeJson: unsafeJson(body), input: body.input?.map((item: any) => ({ type: item.type, role: item.role,
              contentKind: Array.isArray(item.content) ? 'array' : typeof item.content, toolCount: item.tools?.length,
              parameterSymbolCounts: item.tools?.map((tool: any) => Object.getOwnPropertySymbols(tool.parameters ?? {}).length) })),
              toolCount: body.tools?.length });
          } } });
      const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false },
        compaction: { enabled: false, keepRecentTokens: 1 } });
      const loader = new pi.agent.DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [contextTools, native],
        systemPromptOverride: () => 'Positive declaration parity instructions', appendSystemPromptOverride: () => [] });
      await loader.reload();
      ({ session } = await pi.agent.createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime: f.runtime,
        model, sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: 'all' }));
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (m, context, options) => stream(m, context, { ...options, fetch: f.fetchLocal, transport: 'sse', maxRetries: 0 });
      await session.bindExtensions({});
      installNativeCompactionHooks(session);
      await session.compact();
      assert.ok(latestNativeCompaction(sm.getBranch()), `a real hook must persist native metadata rather than silently falling back; requests=${f.bodies.length}; payloadShapes=${JSON.stringify(payloadShapes)}`);
      assert.equal(f.bodies.length, 2);
      const nativeRequest = f.bodies[1];
      await session.prompt('ORDINARY POSITIVE DECLARATION REPLAY');
      assert.equal(f.bodies.length, 3);
      const ordinary = f.bodies[2];
      const declarations = (body: any) => body.input.filter((item: any) => item.type === declarationMode);
      assert.equal(declarations(nativeRequest).length, 1, 'positive control: native request contains the supported declaration form');
      assert.equal(declarations(ordinary).length, 1, 'positive control: replay contains the supported declaration form');
      const nativeTools = declarations(nativeRequest)[0].tools;
      assert.equal(nativeTools.length, 1);
      assert.equal(nativeTools[0].name, declaration.name);
      assert.equal(nativeTools[0].description, declaration.description);
      assert.deepEqual(declarations(ordinary)[0].tools, nativeTools);
      if (declarationMode === 'tool_search_output') {
        for (const body of [nativeRequest, ordinary]) {
          const calls = body.input.filter((item: any) => item.type === 'tool_search_call');
          assert.equal(calls.length, 1);
          assert.equal(calls[0].call_id, declarations(body)[0].call_id, 'the declaration keeps its real serializer-generated call pairing');
          assert.equal(calls[0].execution, 'client');
        }
      }
      assert.deepEqual(nativeRequest.tools, ordinary.tools);
      assert.equal(nativeRequest.instructions, ordinary.instructions);
      assert.equal(ordinary.input.filter((item: any) => item.type === 'compaction').length, 1);
      assert.ok(JSON.stringify(ordinary.input).includes('DECLARATION KEPT TAIL'));
      assert.ok(!JSON.stringify(ordinary.input).includes('DECLARATION OLD ASSISTANT'));
      assert.ok(!ordinary.input.some((item: any) => item.type === 'compaction_trigger'));
      assert.equal(ordinary.store, false);
    } finally { session?.dispose(); await f.close(); }
  });
}

for (const reason of ['threshold', 'overflow'] as const) {
  test(`real SDK ${reason} dispatch produces one canonical native checkpoint and replays through the ordinary subscription serializer`, async () => {
    const f = await fixture(true, reason);
    let session: Awaited<ReturnType<typeof pi.agent.createAgentSession>>['session'] | undefined;
    try {
      const sm = pi.agent.SessionManager.create(f.root, f.root);
      sm.appendMessage({ role: 'user', content: 'AUTOMATIC OLD INPUT', timestamp: 1 });
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'AUTOMATIC OLD ASSISTANT '.repeat(80) }],
        provider: f.model.provider, api: f.model.api, model: f.model.id, stopReason: 'stop', timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      sm.appendMessage({ role: 'user', content: 'AUTOMATIC INTERMEDIATE TAIL '.repeat(80), timestamp: 3 });
      const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false },
        compaction: { enabled: true, keepRecentTokens: 64, reserveTokens: 128 } });
      const preparations: Array<{ reason: string; retry: boolean; boundary: string; old: string; kept: string }> = [];
      const observer = (api: any) => api.on('session_before_compact', (event: any, ctx: any) => {
        const entries = ctx.sessionManager.buildSessionProjection().entries;
        const cut = entries.findIndex((entry: any) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
        assert.ok(cut > 0, 'the SDK must choose a real old-prefix cut');
        preparations.push({ reason: event.reason, retry: event.willRetry, boundary: event.preparation.firstKeptEntryId,
          old: JSON.stringify(entries.slice(0, cut).flatMap((entry: any) => entry.messages)),
          kept: JSON.stringify(entries.slice(cut).flatMap((entry: any) => entry.messages)) });
      });
      const native = createNativeCompactionExtension({ enabled: () => true,
        host: () => ({ memoryOn: () => false, assertOwned() {} }), streamOptions: { fetch: f.fetchLocal, transport: 'sse' } });
      const loader = new pi.agent.DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [observer, native],
        systemPromptOverride: () => 'Automatic dispatch synthetic instructions', appendSystemPromptOverride: () => [] });
      await loader.reload();
      ({ session } = await pi.agent.createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime: f.runtime,
        model: f.model, sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: 'all' }));
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (model, context, options) => stream(model, context, { ...options, fetch: f.fetchLocal, transport: 'sse', maxRetries: 0 });
      await session.bindExtensions({});
      installNativeCompactionHooks(session);
      const completed: any[] = [];
      session.subscribe(event => { if (event.type === 'compaction_end') completed.push(event); });
      // No compact(), private dispatch call or manually emitted compaction event: the
      // real provider response drives the SDK's threshold/overflow decision and retry.
      await session.prompt('AUTOMATIC LATEST USER');
      assert.equal(preparations.length, 1);
      assert.equal(preparations[0]!.reason, reason);
      assert.equal(preparations[0]!.retry, reason === 'overflow');
      assert.equal(completed.length, 1);
      assert.ok(completed[0].result, JSON.stringify(completed));
      assert.equal(completed[0].reason, reason);
      const state = latestNativeCompaction(sm.getBranch());
      assert.ok(state);
      assert.equal(state.boundary.firstKeptEntryId, preparations[0]!.boundary);
      assert.equal(sm.getBranch().filter(entry => entry.type === 'compaction').length, 1);
      assert.equal(f.bodies.filter(body => body.input.some((item: any) => item.type === 'compaction_trigger')).length, 1);
      const nativeRequest = f.bodies[2];
      assert.ok(JSON.stringify(nativeRequest.input).includes('AUTOMATIC OLD ASSISTANT'));
      assert.ok(!JSON.stringify(nativeRequest.input).includes('AUTOMATIC LATEST USER'), 'the SDK-selected latest tail stays outside native compaction');
      if (reason === 'overflow') {
        assert.equal(f.bodies.length, 4, 'one failed ordinary call, portable and native calls, then actual recovery retry');
        assert.ok(sm.getBranch().some(entry => entry.type === 'context_edit'), 'positive control: real overflow recovery omitted its failed attempt');
        assert.equal(f.bodies[3].input.filter((item: any) => item.type === 'compaction').length, 1);
        assert.ok(JSON.stringify(f.bodies[3].input).includes('AUTOMATIC LATEST USER'));
      } else {
        assert.equal(f.bodies.length, 3, 'threshold compaction must not retry the successful response');
      }
      await session.prompt('ORDINARY AFTER AUTOMATIC CHECKPOINT');
      const replay = f.bodies.at(-1);
      assert.equal(replay.input.filter((item: any) => item.type === 'compaction').length, 1);
      assert.ok(JSON.stringify(replay.input).includes('AUTOMATIC LATEST USER'));
      assert.ok(JSON.stringify(replay.input).includes('ORDINARY AFTER AUTOMATIC CHECKPOINT'));
      assert.ok(!JSON.stringify(replay.input).includes('AUTOMATIC OLD ASSISTANT'));
      assert.deepEqual(replay.tools, nativeRequest.tools);
      assert.equal(replay.instructions, nativeRequest.instructions);
      assert.equal(replay.store, false);
      assert.equal(preparations.length, 1, 'post-checkpoint low usage must not retrigger automatic compaction');
    } finally { session?.dispose(); await f.close(); }
  });
}

test('real compact-handoff defers, vetoes a last-instant input, then preserves its hidden note through native replay and later compaction', async () => {
  const f = await fixture(true);
  let session: Awaited<ReturnType<typeof pi.agent.createAgentSession>>['session'] | undefined;
  const key = `native-handoff-${crypto.randomUUID()}`;
  let settleFork: ((result: any) => void) | undefined;
  let copiedForWriter = '';
  let veto = true;
  let failed = 0;
  let successes = 0;
  let releaseTurn: (() => void) | undefined;
  let blockTurn = false;
  const note = 'HANDOFF EXACT DISTINCTION: the rejected option loses user wording.';
  const writerOnly = `PRIVATE WRITER REASONING ${crypto.randomUUID()}`;
  const writerReply = `${writerOnly}\n<handoff>${note}</handoff>`;
  const assertWriterIsolated = () => {
    assert.ok(!JSON.stringify(sm.getBranch()).includes(writerOnly), 'the writer reply outside its extracted note never enters the parent session');
    assert.ok(!JSON.stringify(f.bodies).includes(writerOnly), 'neither portable/native calls nor ordinary replay may carry private writer reasoning');
  };
  const sm = pi.agent.SessionManager.create(f.root, f.root);
  try {
    sm.appendMessage({ role: 'user', content: 'Old input', timestamp: 1 });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'OLD ASSISTANT HISTORY '.repeat(80) }],
      provider: f.model.provider, api: f.model.api, model: f.model.id, stopReason: 'stop', timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    sm.appendMessage({ role: 'user', content: 'Kept handoff tail '.repeat(80), timestamp: 3 });
    // SDK's own extension loader resolves the extension's pi/tui imports. Only the
    // background process launcher is injected; command, scheduling, veto and notes are real.
    (globalThis as any)[key] = {
      options: { agentDir: () => f.root, claudeForkPoint: () => undefined,
        start(spec: any, handlers: any) {
          copiedForWriter = spec.forkSession;
          settleFork = handlers.onSettled;
          return { stop: async () => {} };
        } },
      async race() {
        if (veto) {
          veto = false;
          await session!.extensionRunner.emitInput('Synthetic input arrived after compact began', undefined, 'interactive');
        }
      },
    };
    const wrapper = join(f.root, 'handoff-fixture.ts');
    writeFileSync(wrapper, `import handoff from ${JSON.stringify(resolve('pi-config/extensions/compact-handoff/index.ts'))};\nexport default function(api) { const fixture = globalThis[${JSON.stringify(key)}]; api.on('session_before_compact', fixture.race); handoff(api, fixture.options); }\n`);
    const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false },
      compaction: { enabled: false, keepRecentTokens: 1 } });
    const native = createNativeCompactionExtension({ enabled: () => true,
      host: () => ({ memoryOn: () => false, assertOwned() {} }), streamOptions: { fetch: f.fetchLocal, transport: 'sse' } });
    const loader = new pi.agent.DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [wrapper],
      systemPromptOverride: () => 'Synthetic handoff instructions', appendSystemPromptOverride: () => [], extensionFactories: [native] });
    await loader.reload();
    ({ session } = await pi.agent.createAgentSession({ cwd: f.root, agentDir: f.root, modelRuntime: f.runtime,
      model: f.model, sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: 'all' }));
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => stream(model, context, { ...options, transport: 'sse', maxRetries: 0,
      fetch: (async (input: any, init?: RequestInit) => {
        if (blockTurn) { blockTurn = false; await new Promise<void>(resolve => { releaseTurn = resolve; }); }
        return f.fetchLocal(input, init);
      }) as typeof fetch });
    await session.bindExtensions({});
    installNativeCompactionHooks(session);
    session.subscribe(event => {
      if (event.type === 'compaction_end') {
        if (event.result) successes++; else failed++;
      }
    });
    await session.prompt('/compact-handoff preserve wording');
    assert.ok(settleFork, 'real command must launch the background fork seam');
    assert.ok(copiedForWriter.endsWith('copy.jsonl'));
    blockTurn = true;
    const turn = session.prompt('A real turn starts while the handoff writer works');
    await until(() => !!releaseTurn);
    assert.ok(writerReply.includes(writerOnly) && writerReply.includes(`<handoff>${note}</handoff>`), 'positive control: writer reply contains both private reasoning and the public note');
    settleFork!({ outcome: 'success', finalOutput: writerReply });
    assertWriterIsolated();
    assert.equal(successes, 0);
    assert.equal(sm.getBranch().filter(entry => entry.type === 'compaction').length, 0);
    assert.ok(sm.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'compact-handoff'), 'note is saved before deferred compaction');
    releaseTurn!();
    await turn;
    await until(() => failed === 1);
    assert.equal(successes, 0, 'the real handoff hook vetoes the input race');
    assert.equal(f.bodies.length, 1, 'veto precedes native and portable feature-owned calls');
    assert.equal(sm.getBranch().filter(entry => entry.type === 'compaction').length, 0);
    await session.prompt('Next real turn gives the deferred compaction another idle boundary');
    await until(() => successes === 1 && !session!.isCompacting);
    const first = latestNativeCompaction(sm.getBranch());
    assert.ok(first);
    const hidden = sm.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'compact-handoff-note');
    assert.equal(hidden.length, 1);
    assert.equal((hidden[0] as any).display, false);
    assert.ok(JSON.stringify(hidden).includes(note));
    await session.prompt('Use the checkpoint with its hidden handoff note');
    const replay = f.bodies.at(-1);
    assert.equal(replay.input.filter((item: any) => item.type === 'compaction').length, 1);
    assert.ok(JSON.stringify(replay.input).includes(note));
    assert.ok(JSON.stringify(replay.input).includes('<handoff>'), 'the legitimate hidden note retains its required wrapper');
    assertWriterIsolated();
    sm.appendMessage({ role: 'user', content: 'Newest retained tail '.repeat(100), timestamp: 4 });
    session.refreshContext();
    await session.compact();
    assert.equal(successes, 2);
    assert.ok(latestNativeCompaction(sm.getBranch()));
    await session.prompt('Use the second checkpoint with the note restored');
    const later = f.bodies.at(-1);
    assert.equal(later.input.filter((item: any) => item.type === 'compaction').length, 1);
    assert.ok(JSON.stringify(later.input).includes(note), 'hidden note remains available after a later native compaction');
    assert.ok(JSON.stringify(later.input).includes('<handoff>'), 'restoring the note is distinct from leaking the writer turn');
    assertWriterIsolated();
  } finally {
    session?.dispose();
    delete (globalThis as any)[key];
    await f.close();
  }
});

test('pinned cached WebSocket first proves delta reuse, then sends a full opaque replay and clears stale continuation after compaction', async () => {
  const f = await fixture();
  const sessionId = `transport_${crypto.randomUUID()}`;
  try {
    // Fixture-only endpoint, same built-in provider and serializer. No global transport or provider replacement.
    const model = { ...f.model, baseUrl: f.url };
    const messages: any[] = [{ role: 'user', content: 'Old prefix fact', timestamp: 1 }];
    const opts = { transport: 'websocket-cached' as const, sessionId, maxRetries: 0 };
    const first = await result(f.registry.streamSimple(model, { messages }, opts));
    messages.push(first, { role: 'user', content: 'Before compaction tail', timestamp: 2 });
    await result(f.registry.streamSimple(model, { messages }, opts));
    assert.equal(f.bodies[0].previous_response_id, undefined);
    assert.equal(f.bodies[1].previous_response_id, first.responseId, 'negative control: cache must actually be used before testing reset');
    assert.equal(f.bodies[1].input.length, 1);
    const state = checkpoint(model, [opaque]);
    const after = [{ role: 'user' as const, content: summaryItem.content.map(p => ({ type: 'text' as const, text: p.text })), timestamp: 3 }, { role: 'user' as const, content: 'Retained tail must survive', timestamp: 4 }];
    const third = await result(f.registry.streamSimple(model, { messages: after }, { ...opts,
      onPayload: body => replayNativePrefix(body, summaryItem, state, { summaryPresent: true }) as any,
    }));
    const replay = f.bodies[2];
    assert.equal(replay.previous_response_id, undefined, 'compacted prefix cannot continue from the prior uncompressed response');
    assert.deepEqual(replay.input.filter((i: any) => i.type === 'compaction'), [opaque]);
    assert.ok(JSON.stringify(replay.input).includes('Retained tail must survive'));
    assert.ok(!JSON.stringify(replay.input).includes('Old prefix fact'));
    assert.equal(replay.store, false);
    await result(f.registry.streamSimple(model, { messages: [...after, third, { role: 'user', content: 'Next ordinary turn', timestamp: 5 }] }, { ...opts,
      onPayload: body => replayNativePrefix(body, summaryItem, state, { summaryPresent: true }) as any,
    }));
    assert.equal(f.bodies[3].previous_response_id, third.responseId, 'new continuation is based on the opaque replay, not the abandoned uncompressed prefix');
    assert.equal(f.bodies[3].input.length, 1);
    assert.ok(JSON.stringify(f.bodies[3].input).includes('Next ordinary turn'));
  } finally {
    pi.ai.releaseSessionResources?.(sessionId);
    await f.close();
  }
});
