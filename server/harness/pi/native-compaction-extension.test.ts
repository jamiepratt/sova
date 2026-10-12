import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadPi } from './testing/load-pi';
import { createNativeCompactionExtension, installNativeCompactionHooks } from './native-compaction-extension';
import { latestNativeCompaction } from './native-compaction-state';
import { readModelPolicy, writeModelPolicy, EMPTY_POLICY } from '../../model-policy';

const pi = await loadPi();
const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const rawUsage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 };
const artifact = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'synthetic-artifact' };
const token = (account: string) => `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.signature`;
const item = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });

/** Hook-level unit fixture: genuine canonical pi projection/public summary helper, no auth store,
 * no provider/network, and no SDK private test doubles. SDK dispatch/atomic append is covered separately. */
async function fixture() {
  const sm = pi.agent.SessionManager.inMemory('/synthetic/native-unit');
  const model = { id: 'synthetic-model', name: 'Synthetic', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4000 };
  const answer = (text: string) => ({ role: 'assistant' as const, provider: model.provider, api: model.api, model: model.id, content: [{ type: 'text' as const, text }], stopReason: 'stop' as const, usage, timestamp: 2 });
  sm.appendMessage({ role: 'user', content: 'OLD USER', timestamp: 1 });
  const oldAnswer = sm.appendMessage(answer('OLD ASSISTANT'));
  const kept = sm.appendMessage({ role: 'user', content: 'KEPT TAIL', timestamp: 3 });
  const hooks: Record<string, any> = {};
  let memory: false | 'uniichat' | 'zoomable' = false;
  let enabled = true, owned = true, oauth = true;
  let authToken = token('account-a');
  let currentModel: any = model, physical: any = model;
  let endpoint: string | undefined;
  let authHook: (() => void | Promise<void>) | undefined;
  let callHook: ((kind: string) => void | Promise<void>) | undefined;
  let transform: ((messages: any[]) => any[] | Promise<any[]>) = messages => messages;
  let portableFails = false, nativeFails = false, nativeHasUsage = true;
  const calls: { kind: string; context: any; options: any; payload?: any }[] = [];
  const registry: any = {
    find: () => physical, isUsingOAuth: () => oauth,
    getApiKeyAndHeaders: async () => { await authHook?.(); return { ok: true, apiKey: authToken, baseUrl: endpoint }; },
    streamSimple(m: any, context: any, options: any) {
      const kind = options.sessionId.includes('portable') ? 'portable' : 'native';
      const call: typeof calls[number] = { kind, context, options }; calls.push(call);
      let finished: Promise<any> | undefined;
      const finish = () => finished ??= (async () => {
        await callHook?.(kind);
        if (kind === 'native') {
          call.payload = await options.onPayload({ input: [item('OLD USER')], instructions: 'effective', tools: [] }, m);
          await options.onProviderStreamEvent({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: nativeFails ? [] : [artifact], ...(nativeHasUsage ? { usage: rawUsage } : {}) } }, m);
        }
        return { ...answer(kind === 'portable' ? 'REAL PORTABLE SUMMARY' : ''), responseModel: model.id, stopReason: portableFails && kind === 'portable' ? 'error' : 'stop' };
      })();
      const receiver = {};
      // A real SDK stream need not permit member replacement. Both public methods retain
      // their original receiver through the feature's owned view, including failed spend.
      return Object.freeze({
        receiver,
        async *[Symbol.asyncIterator]() {
          assert.equal(this.receiver, receiver, 'iterator keeps its original stream receiver');
          const message = await finish();
          yield { type: 'done', reason: message.stopReason, message };
        },
        result() { assert.equal(this.receiver, receiver, 'result keeps its original stream receiver'); return finish(); },
      });
    },
  };
  const ctx: any = { sessionManager: sm, modelRegistry: registry, cwd: '/synthetic/native-unit', get model() { return currentModel; } };
  const extension = createNativeCompactionExtension({ host: () => ({ memoryOn: () => !!memory, assertOwned: () => { if (!owned) throw new Error('foreign writer'); } }), enabled: () => enabled });
  assert.equal(typeof extension, 'object');
  assert.ok(typeof extension !== 'function' && 'factory' in extension);
  extension.factory({ on: (name: string, hook: any) => { hooks[name] = hook; }, getThinkingLevel: () => 'off' } as any);
  await hooks.session_start({}, ctx);
  const ordinary: any[] = [];
  const session: any = { sessionManager: sm, systemPrompt: 'EFFECTIVE SYSTEM', agent: {
    state: { tools: [{ name: 'visible', description: 'Effective visible', parameters: {} }, { name: 'hidden', description: 'Hidden', parameters: {} }] },
    transformContext: async (messages: any[]) => transform(messages),
    streamFunction: async (_m: any, _context: any, options: any) => { const payload = await options?.onPayload?.(ordinaryPayload, currentModel) ?? ordinaryPayload; ordinary.push(payload); return payload; },
  }, _hiddenDeclarations: new Set(['hidden']) };
  installNativeCompactionHooks(session);
  const abort = new AbortController();
  const event: any = { signal: abort.signal, customInstructions: 'Keep facts', preparation: { firstKeptEntryId: kept, tokensBefore: 1200, settings: { reserveTokens: 1000 }, fileOps: { read: new Set(['read.ts']), written: new Set(['write.ts']), edited: new Set(['write.ts', 'edit.ts']) } } };
  let ordinaryPayload: any = { input: [] };
  return { sm, model, ctx, event, calls, ordinary, abort, kept, oldAnswer, answer,
    compact: () => hooks.session_before_compact(event, ctx),
    append: (result: any) => sm.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true),
    replay: async (messages: any[], payload: any, options: any = {}) => { ordinaryPayload = payload; await session.agent.transformContext(messages, abort.signal); return session.agent.streamFunction(currentModel, {}, options); },
    set: (value: { memory?: typeof memory; enabled?: boolean; owned?: boolean; oauth?: boolean; model?: any; physical?: any; token?: string; endpoint?: string; authHook?: typeof authHook; callHook?: typeof callHook; transform?: typeof transform; portableFails?: boolean; nativeFails?: boolean; nativeHasUsage?: boolean }) => {
      if ('memory' in value) memory = value.memory!;
      if ('enabled' in value) enabled = value.enabled!;
      if ('owned' in value) owned = value.owned!;
      if ('oauth' in value) oauth = value.oauth!;
      if ('model' in value) currentModel = value.model;
      if ('physical' in value) physical = value.physical;
      if ('token' in value) authToken = value.token!;
      if ('endpoint' in value) endpoint = value.endpoint;
      if ('authHook' in value) authHook = value.authHook;
      if ('callHook' in value) callHook = value.callHook;
      if ('transform' in value) transform = value.transform!;
      if ('portableFails' in value) portableFails = value.portableFails!;
      if ('nativeFails' in value) nativeFails = value.nativeFails!;
      if ('nativeHasUsage' in value) nativeHasUsage = value.nativeHasUsage!;
    },
  };
}

test('ordinary factory creates a real same-prefix portable checkpoint, native artifact and reported metadata only on append', async () => {
  const f = await fixture();
  const before = f.sm.getEntries();
  const result = await f.compact();
  assert.equal(result.compaction.summary, 'REAL PORTABLE SUMMARY');
  assert.equal(result.compaction.firstKeptEntryId, f.kept);
  assert.equal(latestNativeCompaction(f.sm.getBranch()), null);
  assert.deepEqual(f.sm.getEntries(), before, 'hook never writes placeholder/native state');
  assert.deepEqual(result.compaction.details.readFiles, ['read.ts']);
  assert.deepEqual(result.compaction.details.modifiedFiles, ['write.ts', 'edit.ts']);
  assert.deepEqual(f.calls.map(c => c.kind), ['portable', 'native']);
  assert.notEqual(f.calls[0]!.options.sessionId, f.calls[1]!.options.sessionId);
  const portable = JSON.stringify(f.calls[0]!.context);
  const native = JSON.stringify(f.calls[1]!.context);
  for (const text of ['OLD USER', 'OLD ASSISTANT']) { assert.ok(portable.includes(text)); assert.ok(native.includes(text)); }
  for (const text of ['KEPT TAIL']) { assert.ok(!portable.includes(text)); assert.ok(!native.includes(text)); }
  assert.ok(portable.includes('Additional focus: Keep facts'));
  assert.ok(native.includes('EFFECTIVE SYSTEM') && native.includes('Effective visible') && !native.includes('Hidden'));
  assert.equal(result.compaction.usage.totalTokens, 32);
  f.append(result);
  assert.equal(latestNativeCompaction(f.sm.getBranch())?.accountFingerprint, createHash('sha256').update('account-a').digest('hex'));
  assert.ok(JSON.stringify(f.sm.buildSessionProjection().messages).includes('KEPT TAIL'));
});

test('both memory types unavailable views, opt-out, OAuth refusal, unknown/virtual model and proxy make zero feature calls', async () => {
  for (const config of [{ memory: 'uniichat' }, { memory: 'zoomable' }, { enabled: false }, { oauth: false }, { physical: undefined }, { token: 'API-key' }, { endpoint: 'https://proxy.invalid/backend-api' }] as any[]) {
    const f = await fixture(); f.set(config);
    assert.equal(await f.compact(), undefined);
    assert.equal(f.calls.length, 0);
  }
  for (const api of ['pi-virtual', 'openai-responses']) {
    const f = await fixture(); f.set({ physical: { ...f.model, api } });
    assert.equal(await f.compact(), undefined); assert.equal(f.calls.length, 0);
  }
});

test('portable failure explicitly cancels; failed native retains valid text and actual reported spend without another fallback', async () => {
  const p = await fixture(); p.set({ portableFails: true });
  assert.deepEqual(await p.compact(), { cancel: true }); assert.equal(p.calls.length, 1);
  const n = await fixture(); n.set({ nativeFails: true });
  const result = await n.compact();
  assert.equal(result.compaction.summary, 'REAL PORTABLE SUMMARY');
  assert.equal(result.compaction.details.sovaNativeCompaction, undefined);
  assert.equal(result.compaction.details.sovaCompactionUsage[1].usage.totalTokens, 16);
  assert.equal(result.compaction.usage.totalTokens, 32);
  assert.equal(n.calls.length, 2);
  const missing = await fixture(); missing.set({ nativeHasUsage: false });
  const partial = await missing.compact();
  assert.equal(partial.compaction.details.sovaCompactionUsage[1].usage, undefined);
  assert.equal(partial.compaction.usage, undefined);
});

test('abort before or during portable/native work cancels with zero extra costly fallback', async () => {
  for (const stage of ['before', 'portable', 'native']) {
    const f = await fixture();
    if (stage === 'before') f.abort.abort();
    else f.set({ callHook: kind => { if (kind === stage) f.abort.abort(); } });
    assert.deepEqual(await f.compact(), { cancel: true });
    assert.equal(f.calls.length, stage === 'before' ? 0 : stage === 'portable' ? 1 : 2);
    assert.equal(latestNativeCompaction(f.sm.getBranch()), null);
  }
});

test('post-await leaf, current model, account, memory and ownership invalidation explicitly cancels without default fallback', async () => {
  for (const stage of ['portable', 'native']) for (const kind of ['leaf', 'model', 'account', 'memory', 'ownership']) {
    const f = await fixture();
    f.set({ callHook: operation => {
      if (operation !== stage) return;
      if (kind === 'leaf') f.sm.appendMessage({ role: 'user', content: 'RACING USER', timestamp: 5 });
      if (kind === 'model') f.set({ model: { ...f.model, id: 'new-model' } });
      if (kind === 'account') f.set({ token: token('account-b') });
      if (kind === 'memory') f.set({ memory: 'uniichat' });
      if (kind === 'ownership') f.set({ owned: false });
    } });
    assert.deepEqual(await f.compact(), { cancel: true }, `${stage}/${kind}`);
    assert.equal(f.calls.length, stage === 'portable' ? 1 : 2);
    assert.equal(latestNativeCompaction(f.sm.getBranch()), null);
  }
  const f = await fixture(); f.set({ authHook: () => f.set({ owned: false }) });
  assert.deepEqual(await f.compact(), { cancel: true }); assert.equal(f.calls.length, 0);
});

test('model policy denies before issue and cancels when policy changes after a feature call', async () => {
  const previous = readModelPolicy();
  try {
    for (const stage of ['before', 'portable', 'native']) {
      writeModelPolicy(EMPTY_POLICY);
      const f = await fixture();
      const deny = () => { writeModelPolicy({ ...EMPTY_POLICY, disabledModels: [`${f.model.provider}/${f.model.id}`] }); };
      if (stage === 'before') deny();
      else f.set({ callHook: kind => { if (kind === stage) deny(); } });
      assert.deepEqual(await f.compact(), { cancel: true }, stage);
      assert.equal(f.calls.length, stage === 'before' ? 0 : stage === 'portable' ? 1 : 2);
    }
  } finally { writeModelPolicy(previous); }
});

test('canonical projection excludes edited omissions/abandoned branches and preserves split-turn prefix/source boundary', async () => {
  const f = await fixture();
  f.sm.appendContextEdit(f.oldAnswer, null);
  const anchor = f.sm.getLeafId();
  f.sm.appendMessage(f.answer('ABANDONED FACT'));
  f.sm.branch(anchor!);
  const split = f.sm.appendMessage(f.answer('SPLIT KEPT ASSISTANT'));
  f.event.preparation.firstKeptEntryId = split;
  const result = await f.compact();
  assert.equal(result.compaction.firstKeptEntryId, split);
  for (const c of f.calls) {
    const prefix = JSON.stringify(c.context);
    assert.ok(prefix.includes('OLD USER') && prefix.includes('KEPT TAIL'));
    for (const excluded of ['OLD ASSISTANT', 'ABANDONED FACT', 'SPLIT KEPT ASSISTANT']) assert.ok(!prefix.includes(excluded), `${c.kind}/${excluded}`);
  }
});

test('replay requires genuine final-summary provenance and exactly one whole slot; identical quotes are not provenance', async () => {
  for (const scenario of ['genuine', 'removed-with-quote', 'collision', 'memory', 'later-text']) {
    const f = await fixture(); const result = await f.compact(); f.append(result);
    const summary = f.sm.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')!;
    const expected = (pi.agent.convertToLlm([summary])[0]!.content as any[]).map(p => ({ type: 'input_text', text: p.text }));
    const slot = { role: 'user', content: expected };
    const quote = { role: 'user', content: (pi.agent.convertToLlm([summary])[0] as any).content, timestamp: 8 };
    const tail = item('TAIL PRESERVED');
    const messages: any[] = scenario === 'genuine' ? [summary] : [summary, quote];
    if (scenario === 'removed-with-quote') f.set({ transform: ms => ms.filter(m => m.role !== 'compactionSummary') });
    if (scenario === 'memory') f.set({ memory: 'zoomable' });
    if (scenario === 'later-text') f.sm.appendCompaction('Later text', f.kept, 10, {}, true);
    const payload = { input: scenario === 'collision' ? [slot, slot, tail] : [slot, tail], tools: [{ name: 'unchanged' }], instructions: 'unchanged' };
    const out = await f.replay(messages, payload);
    assert.deepEqual(out, scenario === 'genuine' ? { ...payload, input: [...result.compaction.details.sovaNativeCompaction.replacementHistory, tail] } : payload, scenario);
    assert.equal(f.calls.length, 2, 'replay never issues a nested native/portable call');
  }
});

test('caller payload transforms cannot turn an ambiguous or changed input mapping into checkpoint provenance', async () => {
  for (const scenario of ['remove-genuine', 'remove-genuine-in-place', 'move-slot', 'rewrite-slot', 'add-quote', 'settings-only', 'initial-account-mismatch']) {
    const f = await fixture(); const result = await f.compact(); f.append(result);
    const summary = f.sm.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')!;
    const slot = { role: 'user', content: (pi.agent.convertToLlm([summary])[0]!.content as any[]).map(p => ({ type: 'input_text', text: p.text })) };
    const tail = item('UNRELATED TAIL');
    const duplicate = scenario.startsWith('remove-genuine');
    const payload = { input: duplicate ? [structuredClone(slot), structuredClone(slot), tail] : [slot, tail], instructions: 'initial', tools: [{ name: 'initial' }] };
    if (scenario === 'initial-account-mismatch') f.set({ token: token('account-b') });
    let callbacks = 0;
    let callbackPayload: any;
    const out = await f.replay([summary], payload, { onPayload: async (raw: any, model: any) => {
      callbacks++;
      assert.equal(model, f.model);
      await Promise.resolve();
      if (scenario === 'remove-genuine-in-place') { raw.input.splice(0, 1); callbackPayload = raw; return undefined; }
      callbackPayload = { ...raw, instructions: 'caller instructions', tools: [{ name: 'caller tool' }], temperature: 0.25 };
      if (scenario === 'remove-genuine') callbackPayload.input = raw.input.slice(1);
      if (scenario === 'move-slot') callbackPayload.input = [tail, slot];
      if (scenario === 'rewrite-slot') callbackPayload.input = [item('REWRITTEN'), tail];
      if (scenario === 'add-quote') callbackPayload.input = [slot, structuredClone(slot), tail];
      return callbackPayload;
    } });
    assert.equal(callbacks, 1, 'caller callback still runs exactly once');
    assert.deepEqual(out, scenario === 'settings-only' ? { ...callbackPayload, input: [...result.compaction.details.sovaNativeCompaction.replacementHistory, tail] } : callbackPayload, scenario);
    assert.equal(f.calls.length, 2, 'replay creates no nested feature call');
  }
});

test('ordinary replay preserves genuine SDK wire input with optional undefined assistant fields', async () => {
  const f = await fixture(); const result = await f.compact(); f.append(result);
  const summary = f.sm.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')!;
  const slot = { role: 'user', id: undefined,
    content: (pi.agent.convertToLlm([summary])[0]!.content as any[]).map(p => ({ type: 'input_text', text: p.text })) };
  const assistant = { type: 'message', role: 'assistant', id: 'assistant_fixture', phase: undefined,
    content: [{ type: 'output_text', text: 'Assistant tail' }] };
  const tail = item('KEPT USER');
  const payload = { input: [slot, assistant, tail], tools: [{ name: 'unchanged' }] };
  let callbacks = 0;
  const out = await f.replay([summary], payload, { onPayload: (raw: any) => {
    callbacks++;
    raw.input[1].optional = undefined;
    return undefined;
  } });
  assert.equal(callbacks, 1);
  assert.deepEqual(out.input, [...result.compaction.details.sovaNativeCompaction.replacementHistory, assistant, tail]);
  assert.equal(out.input.at(-2), assistant, 'tail object remains untouched');
  assert.equal(out.input.at(-1), tail);
  assert.equal(out.tools, payload.tools);
});

test('replay declines callback input accessors without evaluating them or changing the callback payload', async () => {
  for (const nested of [false, true]) {
    const f = await fixture(); const result = await f.compact(); f.append(result);
    const summary = f.sm.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')!;
    const slot = { role: 'user', content: (pi.agent.convertToLlm([summary])[0]!.content as any[]).map(p => ({ type: 'input_text', text: p.text })) };
    let reads = 0, callbacks = 0;
    let callbackPayload: any;
    const out = await f.replay([summary], { input: [slot] }, { onPayload: (raw: any) => {
      callbacks++;
      callbackPayload = structuredClone(raw);
      if (nested) Object.defineProperty(callbackPayload.input[0].content[0], 'text', {
        enumerable: true, get: () => { reads++; return slot.content[0]!.text; },
      });
      else Object.defineProperty(callbackPayload, 'input', {
        enumerable: true, get: () => { reads++; return [slot]; },
      });
      return callbackPayload;
    } });
    assert.equal(out, callbackPayload, 'uncertain mapping is passed through without replay');
    assert.equal(reads, 0);
    assert.equal(callbacks, 1);
    assert.equal(f.calls.length, 2, 'replay creates no nested feature call');
  }
});

test('replay resolves auth anew and cancels ownership/memory/leaf/model/account invalidation after awaited callback or auth', async () => {
  for (const stage of ['payload', 'auth']) for (const kind of ['ownership', 'memory', 'leaf', 'model', 'account']) {
    const f = await fixture(); const result = await f.compact(); f.append(result);
    const summary = f.sm.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')!;
    const invalidate = () => {
      if (kind === 'ownership') f.set({ owned: false });
      if (kind === 'memory') f.set({ memory: 'zoomable' });
      if (kind === 'leaf') f.sm.appendMessage({ role: 'user', content: 'RACING USER', timestamp: 9 });
      if (kind === 'model') f.set({ model: { ...f.model, id: 'changed-model' } });
      if (kind === 'account') f.set({ token: token('account-b') });
    };
    let authCalls = 0;
    if (stage === 'auth') f.set({ authHook: () => { if (++authCalls === 2) invalidate(); } });
    await assert.rejects(f.replay([summary], { input: [] }, stage === 'payload' ? { onPayload: async () => { await Promise.resolve(); invalidate(); } } : {}), /replay cancelled/, `${stage}/${kind}`);
    assert.equal(f.ordinary.length, 0, 'invalidated request never leaves provider callback');
  }
});
