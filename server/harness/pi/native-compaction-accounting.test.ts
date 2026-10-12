import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { instrumentModelRuntime } from '../../../pi-config/extensions/llm-inflight/runtime.ts';
import { acquireSlot } from '../../../pi-config/extensions/provider-limits/gate.ts';
import { registerUsageSession } from '../../../pi-config/extensions/llm-inflight/attribution.ts';
import { parseUsageLine, type UsageRecord } from '../../../pi-config/extensions/llm-inflight/usage-record.ts';
import {
  assertCompactionModelAllowed, combineCompactionUsage, compactionUsageDetails,
  validatedCompactionUsage, withNativeCompactionUsage,
} from './native-compaction-accounting';
import { callNativeCompaction } from './native-compaction-call';
import { loadPi } from './testing/load-pi.ts';

const root = mkdtempSync(join(tmpdir(), 'sova-native-accounting-'));
after(() => rmSync(root, { recursive: true, force: true }));
const pi = await loadPi();
const provider = 'openai-codex';
const rawUsage = { input_tokens: 19, output_tokens: 7, total_tokens: 26,
  input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } };
const artifact = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'opaque-fixture' };
const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-fixture' } })).toString('base64')}.unsigned`;
const normalizedUsage = { input: 16, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 26, reasoning: 2,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } };
const component = (operation: 'portable' | 'native', usage: unknown = normalizedUsage) =>
  ({ operation, provider, model: 'fixture', usage, ...(operation === 'native' ? { reported: true } : {}) });

function ledger(): UsageRecord[] {
  const dir = join(root, 'usage/v1');
  let days: string[];
  try { days = readdirSync(dir); } catch { return []; }
  return days.flatMap(day => readdirSync(join(dir, day)).flatMap(file =>
    readFileSync(join(dir, day, file), 'utf8').trim().split('\n').map(parseUsageLine).filter((r): r is UsageRecord => !!r)));
}
async function fixture() {
  const authPath = join(root, `auth-${crypto.randomUUID()}.json`);
  writeFileSync(authPath, JSON.stringify({ [provider]: { type: 'oauth', access: token, refresh: 'unused', expires: Number.MAX_SAFE_INTEGER } }), { mode: 0o600 });
  const runtime = await pi.agent.ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await runtime.refresh({ providers: [provider], allowNetwork: false });
  assert.equal(instrumentModelRuntime(runtime), 'instrumented');
  assert.equal(instrumentModelRuntime(runtime), 'already');
  const registry = new pi.agent.ModelRegistry(runtime);
  const model = registry.getAll().find(m => m.provider === provider && m.api === 'openai-codex-responses');
  assert.ok(model);
  return { runtime, registry, model };
}
function responseEvents(usage: unknown = rawUsage) {
  return [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: artifact },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [artifact], ...(usage === null ? {} : { usage }) } }];
}
function offlineFetch(events: unknown[], requested: () => void): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    requested();
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}
async function attributed<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const remove = registerUsageSession(owner, { kind: 'main', cwd: root });
  try { return await withNativeCompactionUsage(owner, root, fn); }
  finally { remove(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; }
}

test('combined counters split cache input and never add reasoning twice', () => {
  const usage = combineCompactionUsage([component('portable'), component('native')]);
  assert.ok(usage);
  assert.equal(usage.input, 32);
  assert.equal(usage.cacheRead, 6);
  assert.equal(usage.output, 14);
  assert.equal(usage.reasoning, 4);
  assert.equal(usage.totalTokens, 52);
  assert.equal(usage.cost.total, 0.062);
});

test('missing native backend usage, incomplete counters and model changes withhold aggregate but keep attribution', () => {
  assert.equal(validatedCompactionUsage({ ...normalizedUsage, output: '7' }), undefined);
  assert.equal(validatedCompactionUsage({ ...normalizedUsage, reasoning: 8 }), undefined);
  assert.equal(validatedCompactionUsage({ ...normalizedUsage, totalTokens: 28 }), undefined);
  assert.equal(validatedCompactionUsage({ ...normalizedUsage, cost: undefined }), undefined);
  assert.equal(combineCompactionUsage([]), undefined);
  const details = compactionUsageDetails([component('portable'), { ...component('native'), reported: false }]);
  assert.equal(details.usage, undefined);
  assert.equal(details.components[0]!.usage?.output, 7);
  assert.equal(details.components[1]!.usage, undefined);
  assert.equal(combineCompactionUsage([component('portable'), { ...component('native'), model: 'different' }]), undefined);
  assert.equal(combineCompactionUsage([component('portable'), { ...component('native'), responseModel: 'different' }]), undefined);
  const partial = combineCompactionUsage([component('portable'), component('native', { ...normalizedUsage, reasoning: undefined })]);
  assert.ok(partial);
  assert.equal(partial.reasoning, undefined, 'an absent optional split is not invented as zero');
});

test('policy guard rechecks before each nested call and distinguishes global from worker-only denial', () => {
  let policy = { disabledProviders: [] as string[], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [`${provider}/fixture`] };
  assert.doesNotThrow(() => assertCompactionModelAllowed({ provider, id: 'fixture' }, () => policy));
  policy = { ...policy, disabledProviders: ['OPENAI-CODEX'] };
  assert.throws(() => assertCompactionModelAllowed({ provider, id: 'fixture' }, () => policy), /turned off/);
});

test('configured runtime writes each portable/native reply once with owner and compaction purpose', async () => {
  const { registry, model } = await fixture();
  const owner = 'accounting-success';
  let requests = 0;
  await attributed(owner, async () => {
    const options = { fetch: offlineFetch(responseEvents(), () => requests++), transport: 'sse' as const, maxRetries: 0 };
    const stream = registry.streamSimple(model, { messages: [{ role: 'user', content: 'Portable fixture', timestamp: 1 }] }, { ...options, sessionId: 'side-portable' });
    for await (const _event of stream) { /* instrumentation observes result, not iteration */ }
    const portable = await stream.result();
    assert.equal((await stream.result()).usage.output, portable.usage.output);
    await callNativeCompaction({ registry, model, context: { messages: [{ role: 'user', content: 'Native prefix', timestamp: 2 }] }, options: { ...options, sessionId: 'side-native' } });
  });
  const records = ledger().filter(r => r.owner === owner);
  assert.equal(requests, 2);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(r => r.key)).size, 2);
  for (const r of records) {
    assert.equal(r.purpose, 'compaction'); assert.equal(r.cwd, root); assert.equal(r.kind, 'main');
    assert.equal(r.provider, provider); assert.equal(r.model, model.id);
    assert.equal(r.input, 16); assert.equal(r.cacheRead, 3); assert.equal(r.output, 7);
  }
});

test('configured provider gate holds one slot at request and releases it on completion', async () => {
  const { runtime, registry, model } = await fixture();
  writeFileSync(join(root, 'provider-limits.json'), JSON.stringify({ version: 1, limits: { [provider]: 1 } }));
  const builtin = runtime.getProvider(provider);
  assert.ok(builtin);
  // Injectable configured-provider admission fixture uses the existing neutral lease core.
  // Production gateStreamSimple registration is source-reviewed, not imported here: it reaches
  // pi-ai from pi-config's package scope, unlike the adapter's selected pinned-SDK loader.
  runtime.registerProvider(provider, { api: model.api, streamSimple(requestModel, context, options) {
    const out = pi.ai.createAssistantMessageEventStream();
    void (async () => {
      const slot = await acquireSlot(provider, { agentDir: root, kind: 'background', sessionId: options?.sessionId, signal: options?.signal });
      try { for await (const event of builtin.streamSimple(requestModel, context, options)) out.push(event); }
      finally { slot?.release(); out.end(); }
    })().catch((error: unknown) => {
      out.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api,
        provider, model: model.id, usage: { ...normalizedUsage, input: 0, output: 0, cacheRead: 0,
          totalTokens: 0, reasoning: 0 }, stopReason: 'error', errorMessage: String(error), timestamp: 1 } });
      out.end();
    });
    return out;
  } });
  const slots = join(root, 'provider-limits', provider, 'slots');
  await attributed('accounting-gate', async () => {
    await callNativeCompaction({ registry, model, context: { messages: [{ role: 'user', content: 'Prefix', timestamp: 1 }] },
      options: { sessionId: 'side-gated', fetch: offlineFetch(responseEvents(), () => {
        const files = readdirSync(slots).filter(f => f.endsWith('.json'));
        assert.equal(files.length, 1);
        assert.equal(JSON.parse(readFileSync(join(slots, files[0]!), 'utf8')).sessionId, 'side-gated');
      }) } });
  });
  assert.deepEqual(readdirSync(slots).filter(f => f.endsWith('.json')), []);
});

test('rejected native artifact retains valid reported spend exactly once', async () => {
  const { registry, model } = await fixture();
  const events = responseEvents();
  // Validation latches failure until normalized SDK finish: the real usage writer still sees tokens.
  events.splice(1, 0, { type: 'response.output_item.done', output_index: 1, item: { ...artifact, id: 'cmp_other' } } as never);
  await attributed('accounting-rejection', async () => {
    await assert.rejects(callNativeCompaction({ registry, model, context: { messages: [{ role: 'user', content: 'Prefix', timestamp: 1 }] },
      options: { sessionId: 'side-rejection', fetch: offlineFetch(events, () => undefined) } }), /multiple-artifacts|conflicting-artifact/);
  });
  const records = ledger().filter(r => r.owner === 'accounting-rejection');
  assert.equal(records.length, 1);
  assert.equal(records[0]!.output, 7);
});

test('abort after native reports spent tokens preserves both portable and aborted native records', async () => {
  const { runtime, registry, model } = await fixture();
  const builtin = runtime.getProvider(provider);
  assert.ok(builtin);
  const controller = new AbortController();
  let nativeResult: Promise<unknown> | undefined;
  // The configured provider emits an aborted terminal reply carrying the backend's reported
  // counters. This tests accounting of spent tokens, not a claim that pre-terminal Codex usage exists.
  runtime.registerProvider(provider, { api: model.api, streamSimple(requestModel, context, options) {
    const inner = builtin.streamSimple(requestModel, context, options);
    if (options?.sessionId !== 'side-aborted-native') return inner;
    const out = pi.ai.createAssistantMessageEventStream();
    nativeResult = out.result();
    void (async () => {
      for await (const event of inner) {
        if (event.type === 'done') {
          out.push({ type: 'error', reason: 'aborted', error: { ...event.message,
            stopReason: 'aborted', errorMessage: 'Offline cancellation after reported spend' } });
          controller.abort();
        } else out.push(event);
      }
      out.end();
    })();
    return out;
  } });
  const owner = 'accounting-mid-abort';
  await attributed(owner, async () => {
    const context = { messages: [{ role: 'user' as const, content: 'Prefix', timestamp: 1 }] };
    const fetch = offlineFetch(responseEvents(), () => undefined);
    await registry.streamSimple(model, context, { sessionId: 'side-abort-portable', transport: 'sse', fetch }).result();
    await assert.rejects(callNativeCompaction({ registry, model, context, signal: controller.signal,
      options: { sessionId: 'side-aborted-native', fetch } }), /aborted/);
    assert.ok(nativeResult);
    await nativeResult;
  });
  const records = ledger().filter(r => r.owner === owner);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(r => r.key)).size, 2);
  assert.deepEqual(records.map(r => r.output), [7, 7]);
  assert.deepEqual(records.map(r => r.stop), ['stop', 'aborted']);
  assert.ok(records.every(r => r.purpose === 'compaction' && r.cwd === root));
});

test('native disables transparent retries and explicitly retried spent attempts each record once', async () => {
  const { registry, model } = await fixture();
  const owner = 'accounting-retries';
  let requests = 0;
  await attributed(owner, async () => {
    const context = { messages: [{ role: 'user' as const, content: 'Prefix', timestamp: 1 }] };
    await assert.rejects(callNativeCompaction({ registry, model, context, options: {
      sessionId: 'side-retry-503', maxRetries: 9, fetch: (async () => {
        requests++; return new Response('offline service unavailable', { status: 503 });
      }) as typeof fetch,
    } }));
    assert.equal(requests, 1, 'feature-owned native operation overrides SDK HTTP retry configuration');
    const invalid = responseEvents();
    invalid.splice(1, 0, { type: 'response.output_item.done', output_index: 1,
      item: { ...artifact, id: 'cmp_retry_other' } } as never);
    await assert.rejects(callNativeCompaction({ registry, model, context, options: {
      sessionId: 'side-retry-spent-failure', fetch: offlineFetch(invalid, () => requests++),
    } }), /multiple-artifacts|conflicting-artifact/);
    await callNativeCompaction({ registry, model, context, options: {
      sessionId: 'side-retry-spent-success', fetch: offlineFetch(responseEvents(), () => requests++),
    } });
  });
  const records = ledger().filter(r => r.owner === owner);
  assert.equal(requests, 3);
  assert.equal(records.length, 2, 'tokenless transport failure writes nothing; both reporting attempts survive');
  assert.equal(new Set(records.map(r => r.key)).size, 2);
  assert.ok(records.every(r => r.output === 7 && r.purpose === 'compaction'));
});

test('runtime replacement instruments the new instance without counting either request twice', async () => {
  const owner = 'accounting-replacement';
  await attributed(owner, async () => {
    for (const sessionId of ['side-old-runtime', 'side-new-runtime']) {
      const { registry, model } = await fixture();
      await callNativeCompaction({ registry, model, context: { messages: [{ role: 'user', content: 'Prefix', timestamp: 1 }] },
        options: { sessionId, fetch: offlineFetch(responseEvents(), () => undefined) } });
    }
  });
  const records = ledger().filter(r => r.owner === owner);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(r => r.key)).size, 2);
});

test('request-time auth loss after success admits no second provider call or record', async () => {
  const { runtime, registry, model } = await fixture();
  const owner = 'accounting-auth-loss';
  let requests = 0;
  await attributed(owner, async () => {
    const context = { messages: [{ role: 'user' as const, content: 'Prefix', timestamp: 1 }] };
    const fetch = offlineFetch(responseEvents(), () => requests++);
    await callNativeCompaction({ registry, model, context, options: { sessionId: 'side-before-logout', fetch } });
    await runtime.logout(provider);
    await assert.rejects(callNativeCompaction({ registry, model, context, options: { sessionId: 'side-after-logout', fetch } }));
  });
  assert.equal(requests, 1);
  assert.equal(ledger().filter(r => r.owner === owner).length, 1);
});

test('absent backend usage and pre-abort write no initialized zero records', async () => {
  const { registry, model } = await fixture();
  const owner = 'accounting-absent';
  let requests = 0;
  await attributed(owner, async () => {
    const context = { messages: [{ role: 'user' as const, content: 'Prefix', timestamp: 1 }] };
    const options = { sessionId: 'side-absent', fetch: offlineFetch(responseEvents(null), () => requests++) };
    const result = await callNativeCompaction({ registry, model, context, options });
    assert.equal(result.usage, undefined);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(callNativeCompaction({ registry, model, context, options, signal: aborted.signal }), /aborted/);
  });
  assert.equal(requests, 1);
  assert.deepEqual(ledger().filter(r => r.owner === owner), []);
});
