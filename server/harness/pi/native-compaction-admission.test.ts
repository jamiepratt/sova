import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { acquireSlot, registerSession, unregisterSession } from '../../../pi-config/extensions/provider-limits/gate.ts';
import { callNativeCompaction } from './native-compaction-call';
import { loadPi } from './testing/load-pi.ts';

const pi = await loadPi();
const provider = 'openai-codex';
const extensionPath = resolve(import.meta.dirname, '../../../pi-config/extensions/provider-limits/index.ts');
const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-admission' } })).toString('base64')}.unsigned`;
const artifact = { type: 'compaction', id: 'cmp_admission', encrypted_content: 'opaque-admission' };
const events = [
  { type: 'response.created', response: { id: 'resp_admission', status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: 0, item: artifact },
  { type: 'response.completed', response: { id: 'resp_admission', status: 'completed', output: [artifact],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
];

async function fixture(t: TestContext, registration: 'builtin' | 'legacy' | 'native' | 'native-overlay' = 'builtin') {
  const root = mkdtempSync(join(tmpdir(), 'sova-native-admission-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'auth.json'), JSON.stringify({ [provider]: {
    type: 'oauth', access: token, refresh: 'unused', expires: Number.MAX_SAFE_INTEGER,
  } }), { mode: 0o600 });
  writeFileSync(join(root, 'provider-limits.json'), JSON.stringify({ version: 1, limits: { [provider]: 1 } }));
  const modelsPath = join(root, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
  const runtime = await pi.agent.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath, refreshOnCreate: false });
  await runtime.refresh({ providers: [provider], allowNetwork: false });
  const registry = new pi.agent.ModelRegistry(runtime);
  let model = registry.getAll().find(m => m.provider === provider && m.api === 'openai-codex-responses');
  assert.ok(model);
  const original = registry.getProvider(provider);
  assert.ok(original);
  let customCalls = 0;
  let native: typeof original | undefined;
  if (registration === 'legacy') {
    registry.registerProvider(provider, { api: model.api, name: 'Offline configured Codex',
      baseUrl: 'https://example.invalid', models: [{ ...model }],
      streamSimple(m, context, options) { customCalls++; return original.streamSimple(m, context, options); } });
  } else if (registration === 'native' || registration === 'native-overlay') {
    native = Object.freeze({ ...original, name: 'Offline native Codex',
      getModels() { assert.equal(this, native, 'native catalog retains receiver'); return original.getModels(); },
      streamSimple(m: NonNullable<typeof model>, context: any, options: any) {
        assert.equal(this, native, 'native stream retains receiver'); customCalls++;
        return original.streamSimple(m, context, options);
      },
    });
    registry.registerProvider(native);
  }
  const overlayToken = `${token}-overlay`;
  if (registration === 'native-overlay') {
    // Native and legacy extension registrations are mutually exclusive in this SDK. The
    // models.json overlay is independent and must survive re-registering a full native Provider.
    writeFileSync(modelsPath, JSON.stringify({ providers: { [provider]: {
      name: 'Offline overlay Codex', baseUrl: 'https://overlay.example.invalid', apiKey: overlayToken,
      modelOverrides: { [model.id]: { name: 'Offline overlay model', contextWindow: 123456 } },
    } } }));
    await registry.refresh({ providers: [provider], allowNetwork: false });
    model = registry.find(provider, model.id);
    assert.ok(model);
  }
  const settingsManager = pi.agent.SettingsManager.inMemory({ cacheWarming: { enabled: false } } as any);
  // Load the real file via the SDK's public resource loader, with its package aliases. There is
  // no surrogate admission wrapper, direct factory call, global provider override or live auth.
  const resourceLoader = new pi.agent.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], 'the configured gate extension must actually load');
  assert.equal(loaded.extensions.length, 1);
  const { session } = await pi.agent.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model, settingsManager, sessionManager: pi.agent.SessionManager.inMemory(root), resourceLoader, tools: [] });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: 'print', onError: error => assert.fail(String(error)) });
  const slotDir = join(root, 'provider-limits', provider, 'slots');
  const slots = () => {
    try { return readdirSync(slotDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(slotDir, f), 'utf8'))); }
    catch { return []; }
  };
  return { root, registry, runtime, model, slots, session, customCalls: () => customCalls, native, overlayToken };
}

for (const registration of ['builtin', 'legacy', 'native', 'native-overlay'] as const) {
  test(`actual session_start gate admits configured ${registration} portable/native calls once`, async t => {
    const f = await fixture(t, registration);
    if (registration === 'legacy') {
      const config = f.registry.getRegisteredProviderConfig(provider);
      assert.equal(config?.name, 'Offline configured Codex');
      assert.equal(config?.baseUrl, 'https://example.invalid');
      assert.equal(config?.models?.[0]?.id, f.model.id);
    }
    if (registration === 'native' || registration === 'native-overlay') {
      const gated = f.registry.getRegisteredNativeProvider(provider);
      assert.ok(gated, 'name/config re-registration must not erase the native provider');
      assert.equal(gated.auth, f.native!.auth);
      assert.equal(gated.name, 'Offline native Codex');
    }
    if (registration === 'native-overlay') {
      const configured = f.registry.getProvider(provider);
      assert.equal(configured?.name, 'Offline overlay Codex');
      assert.equal(configured?.baseUrl, 'https://overlay.example.invalid');
      const configuredModel = f.registry.find(provider, f.model.id);
      assert.equal(configuredModel?.name, 'Offline overlay model');
      assert.equal(configuredModel?.contextWindow, 123456);
      assert.equal(f.registry.getRegisteredProviderConfig(provider), undefined, 'native registration remains native, not legacy');
    }
    let requests = 0;
    let expectedToken = token;
    let expectedSession = 'admission-portable';
    const fetchAssertions: unknown[] = [];
    const fetch = (async (input: unknown, init?: RequestInit) => {
      requests++;
      try {
        const request = input instanceof Request ? input : undefined;
        const headers = new Headers(init?.headers ?? request?.headers);
        assert.equal(headers.get('authorization'), `Bearer ${expectedToken}`, 'request-time auth survives registration');
        const slots = f.slots();
        assert.equal(slots.length, 1, 'real configured provider entered with exactly one slot');
        assert.equal(slots[0].sessionId, expectedSession);
        if (registration === 'native-overlay') {
          const shape = {
            input: request ? 'Request' : typeof input,
            initBody: init?.body === undefined ? 'absent' : typeof init.body === 'string' ? 'string' : init.body?.constructor.name,
            contentEncoding: headers.get('content-encoding'),
          };
          t.diagnostic(`offline SDK fetch argument shape: ${JSON.stringify(shape)}`);
          assert.equal(request?.url ?? String(input), 'https://overlay.example.invalid/codex/responses', 'configured endpoint survives gating');
          assert.equal(init?.method ?? request?.method, 'POST', 'configured request method survives gating');
          assert.ok(init?.body != null || request, `SDK fetch body must be present: ${JSON.stringify(shape)}`);
          // The pinned Codex SSE transport may send zstd bytes, not a JSON string. Read
          // the actual wire body; a Request's clone also keeps the observed body unconsumed.
          const body = init?.body != null ? new Response(init.body) : request!.clone();
          const bodyText = headers.get('content-encoding') === 'zstd'
            ? zstdDecompressSync(Buffer.from(await body.arrayBuffer())).toString('utf8')
            : await body.text();
          assert.equal(JSON.parse(bodyText).model, f.model.id, 'configured request model survives gating');
        }
      } catch (error) {
        // Provider streams normalize thrown fetch errors. Retain the actual assertion so
        // missing-completion/stopReason:error can never conceal a failed transport witness.
        fetchAssertions.push(error);
        throw error;
      }
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    async function checked<T>(call: () => Promise<T>): Promise<T> {
      try { return await call(); }
      finally { if (fetchAssertions.length) throw fetchAssertions[0]; }
    }
    const context = { messages: [{ role: 'user' as const, content: 'Offline prefix', timestamp: 1 }] };
    const portable = await checked(() => f.registry.streamSimple(f.model, context,
      { fetch, transport: 'sse', maxRetries: 0, sessionId: expectedSession }).result());
    assert.equal(portable.stopReason, 'stop');
    assert.deepEqual(f.slots(), []);
    if (registration === 'native-overlay') {
      assert.equal((await f.runtime.getAuth(f.model))?.auth.apiKey, token, 'stored OAuth takes precedence over the configured fallback');
      await f.runtime.logout(provider);
      assert.equal((await f.runtime.getAuth(f.model))?.auth.apiKey, f.overlayToken, 'without a stored credential the models.json key is resolved');
      expectedToken = f.overlayToken;
    }
    expectedSession = 'admission-native';
    await checked(() => callNativeCompaction({ registry: f.registry, model: f.model, context,
      options: { fetch, sessionId: expectedSession } }));
    assert.deepEqual(f.slots(), []);
    if (registration === 'native-overlay') {
      expectedToken = `${token}-explicit`;
      expectedSession = 'admission-explicit';
      await checked(() => callNativeCompaction({ registry: f.registry, model: f.model, context,
        options: { fetch, sessionId: expectedSession, apiKey: expectedToken } }));
    }
    const expectedRequests = registration === 'native-overlay' ? 3 : 2;
    assert.equal(requests, expectedRequests);
    if (registration !== 'builtin') assert.equal(f.customCalls(), expectedRequests, 'custom stream preserved without recursive or double admission');
    assert.deepEqual(f.slots(), []);
  });
}

test('actual configured gate releases native failed requests and aborts a queued request without dispatch', async t => {
  const f = await fixture(t);
  const context = { messages: [{ role: 'user' as const, content: 'Offline prefix', timestamp: 1 }] };
  let failedRequests = 0;
  let fetchAssertion: unknown;
  await assert.rejects(callNativeCompaction({ registry: f.registry, model: f.model, context,
    options: { sessionId: 'admission-error', fetch: (async () => {
      failedRequests++;
      try { assert.equal(f.slots().length, 1); }
      catch (error) { fetchAssertion = error; throw error; }
      return new Response('offline rejection', { status: 400 });
    }) as typeof fetch } }));
  if (fetchAssertion) throw fetchAssertion;
  assert.equal(failedRequests, 1);
  assert.deepEqual(f.slots(), []);
  const held = await acquireSlot(provider, { agentDir: f.root, kind: 'background', sessionId: 'existing-request' });
  assert.ok(held);
  const controller = new AbortController();
  let waited = false;
  let cleared!: () => void;
  const queueCleared = new Promise<void>(resolve => { cleared = resolve; });
  registerSession('admission-waiting', 'interactive', info => {
    if (info) {
      waited = true;
      // A synchronous observer stop is valid: the gate must notice it before subscribing
      // to an abort event that has already fired, and clean up without waiting for a poll.
      controller.abort();
    } else if (waited) cleared();
  });
  try {
    let dispatched = false;
    await assert.rejects(callNativeCompaction({ registry: f.registry, model: f.model, context, signal: controller.signal,
      options: { sessionId: 'admission-waiting', fetch: (async () => {
        dispatched = true; throw new Error('queued request must never leave the gate');
      }) as typeof fetch } }), /aborted/i);
    // The SDK's outer lazy stream can publish its aborted result before the inner gate finishes
    // cancellation. Its wait-cleared event, not an arbitrary delay, witnesses cleanup completion.
    await queueCleared;
    assert.equal(waited, true, 'real configured wrapper must reach the provider queue');
    assert.equal(dispatched, false);
    assert.equal(f.slots().length, 1, 'abort never releases another request\'s slot');
    assert.deepEqual(readdirSync(join(f.root, 'provider-limits', provider, 'wants')).filter(f => f.endsWith('.json')), []);
  } finally { held.release(); unregisterSession('admission-waiting'); }
  assert.deepEqual(f.slots(), []);
});
