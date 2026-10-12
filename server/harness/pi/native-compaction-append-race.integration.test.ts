import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { ForeignWriteGuard } from '../../write-guard.ts';
import { compactSession } from './history-ops.ts';
import { createNativeCompactionExtension, installNativeCompactionHooks } from './native-compaction-extension.ts';
import { latestNativeCompaction } from './native-compaction-state.ts';
import { loadPi } from './testing/load-pi.ts';

const pi = await loadPi();
const token = (account: string) => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.unsigned`;
const credential = (account: string) => ({ type: 'oauth' as const, access: token(account), refresh: 'unused', expires: Number.MAX_SAFE_INTEGER });
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Race = 'valid' | 'leaf' | 'model' | 'account' | 'memory' | 'foreign' | 'ownership-append' | 'other-result';

async function fixture(race: Race) {
  const root = mkdtempSync(join(tmpdir(), 'native-append-race-'));
  const authPath = join(root, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ 'openai-codex': credential('race-start') }), { mode: 0o600 });
  const runtime = await pi.agent.ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  await runtime.refresh({ providers: ['openai-codex'], allowNetwork: false });
  const catalog = new pi.agent.ModelRegistry(runtime).getAll().find(m => m.provider === 'openai-codex' && m.api === 'openai-codex-responses');
  assert.ok(catalog);
  const sm = pi.agent.SessionManager.create(root, root);
  sm.appendModelChange(catalog.provider, catalog.id);
  const old = sm.appendMessage({ role: 'user', content: 'OLD PREFIX '.repeat(80), timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'OLD ASSISTANT '.repeat(80) }], provider: catalog.provider, api: catalog.api, model: catalog.id, stopReason: 'stop', timestamp: 2, usage });
  const kept = sm.appendMessage({ role: 'user', content: 'KEPT TAIL '.repeat(80), timestamp: 3 });
  const path = sm.getSessionFile();
  assert.ok(path);
  let memory = false;
  let foreign: ForeignWriteGuard;
  let appendGuardCalls = 0;
  const owned = () => {
    const reason = foreign.check();
    if (reason) throw new Error(`Fixture ownership refused: ${reason}`);
  };
  const bodies: any[] = [];
  const fetchFixture = (async (url: any, init?: RequestInit) => {
    assert.ok(String(url).startsWith('https://chatgpt.com/'), 'never contact or redirect another provider');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token('race-start')}`);
    const raw = Buffer.from(init!.body as any);
    const body = JSON.parse((headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : raw).toString('utf8'));
    bodies.push(body);
    const compact = body.input.some((item: any) => item.type === 'compaction_trigger');
    const id = `race-${bodies.length}`;
    const item = compact ? { type: 'compaction', id: `cmp-${id}`, encrypted_content: 'synthetic-race-opaque' }
      : { type: 'message', id: `msg-${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Real portable fixture summary', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: compact ? item : { ...item, content: [] } },
      ...(!compact ? [
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Real portable fixture summary' },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Real portable fixture summary' },
      ] : []),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 3, total_tokens: 33 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const native = createNativeCompactionExtension({ host: () => ({ memoryOn: () => memory, assertOwned: owned }), enabled: () => true,
    streamOptions: { fetch: fetchFixture, transport: 'sse', maxRetries: 0 } });
  let session: Awaited<ReturnType<typeof pi.agent.createAgentSession>>['session'];
  let lateCalls = 0;
  let afterInvalidation: Buffer;
  const late = (api: any) => api.on('session_before_compact', async (event: any, ctx: any) => {
    lateCalls++;
    assert.equal(bodies.length, 2, 'public later handler runs only AFTER the feature has finished BOTH actual provider calls');
    assert.ok(!bodies[0].input.some((item: any) => item.type === 'compaction_trigger'));
    assert.ok(bodies[1].input.some((item: any) => item.type === 'compaction_trigger'));
    assert.equal(latestNativeCompaction(sm.getBranch()), null, 'nothing appended before the late handler');
    await Promise.resolve();
    if (race === 'leaf') sm.branch(old);
    if (race === 'model') {
      const changed = ctx.modelRegistry.getAll().find((m: any) => m.provider === catalog.provider && m.id !== catalog.id);
      assert.ok(changed, 'the later hook switches to another publicly registered physical model');
      await session.setModel(changed);
    }
    if (race === 'memory' || race === 'other-result') memory = true;
    if (race === 'account') {
      writeFileSync(authPath, JSON.stringify({ 'openai-codex': credential('race-later') }), { mode: 0o600 });
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(catalog);
      assert.ok(auth.ok);
      assert.equal(auth.apiKey, token('race-later'), 'positive control: request-time registry observes the different account');
    }
    if (race === 'foreign' || race === 'ownership-append') {
      appendFileSync(path, JSON.stringify({ type: 'message', id: 'foreign-late', parentId: kept, message: { role: 'user', content: 'FOREIGN AFTER BOTH CALLS', timestamp: 4 } }) + '\n');
      assert.throws(owned, /entries appended by another process/, 'actual hosted foreign-write checker sees the final interhook append');
    }
    afterInvalidation = readFileSync(path);
    // Another extension's result is deliberately not guarded by the native feature. This
    // independent case must be stopped by compactSession's EXISTING atomic append guard.
    if (race === 'ownership-append' || race === 'other-result') return { compaction: { summary: 'Other extension checkpoint', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
  const loader = new pi.agent.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true,
    systemPromptOverride: () => 'Synthetic append-race instructions', appendSystemPromptOverride: () => [], extensionFactories: [native, late] });
  await loader.reload();
  ({ session } = await pi.agent.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: catalog, sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: 'builtin' }));
  await session.bindExtensions({});
  foreign = new ForeignWriteGuard(path, id => !!sm.getEntry(id));
  installNativeCompactionHooks(session);
  const before = readFileSync(path);
  afterInvalidation = before;
  return { sm, session, path, before, bodies, lateCalls: () => lateCalls, afterInvalidation: () => afterInvalidation,
    async compact() { return compactSession(session, undefined, { guard() { appendGuardCalls++; owned(); }, allowed() {}, queued: () => false,
      beforeWrite() { throw new Error('Fixture beforeWrite must not run for cancelled work'); }, refusal: err => err instanceof Error && err.message.startsWith('Fixture ownership refused:') ? { reason: 'recent', message: err.message } : null }); },
    appendGuardCalls: () => appendGuardCalls, close() { session.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

for (const race of ['leaf', 'model', 'account', 'memory', 'foreign', 'ownership-append'] as const) {
  test(`actual SDK later public hook invalidates ${race} after both feature calls without append or third fallback`, async () => {
    const f = await fixture(race);
    try {
      const result = await f.compact();
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, race === 'ownership-append' ? 'recent' : 'cancelled', result.message);
      assert.equal(f.lateCalls(), 1);
      assert.equal(f.bodies.length, 2, 'no default/third costly summarizer call');
      assert.equal(latestNativeCompaction(f.sm.getBranch()), null);
      assert.equal(f.sm.getEntries().filter(entry => entry.type === 'compaction').length, 0);
      assert.deepEqual(readFileSync(f.path), f.afterInvalidation(), 'no checkpoint or deferred write follows late invalidation');
      if (race !== 'foreign' && race !== 'ownership-append' && race !== 'model') assert.deepEqual(readFileSync(f.path), f.before);
      if (race === 'ownership-append') assert.equal(f.appendGuardCalls(), 2, 'existing P2 guard runs at actual SDK append after the complete public handler chain');
    } finally { f.close(); }
  });
}

test('actual SDK later replacement checkpoint remains another extension’s result, not a feature-owned guard target', async () => {
  const f = await fixture('other-result');
  try {
    await f.session.compact();
    assert.equal(f.lateCalls(), 1);
    assert.equal(f.bodies.length, 2);
    const checkpoints = f.sm.getEntries().filter(entry => entry.type === 'compaction');
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]!.summary, 'Other extension checkpoint');
    assert.equal(latestNativeCompaction(f.sm.getBranch()), null, 'memory invalidation cannot cancel an independently replaced extension result');
  } finally { f.close(); }
});

test('actual SDK valid later public hook preserves and atomically appends the native checkpoint', async () => {
  const f = await fixture('valid');
  try {
    await f.session.compact();
    assert.equal(f.lateCalls(), 1);
    assert.equal(f.bodies.length, 2);
    assert.equal(f.sm.getEntries().filter(entry => entry.type === 'compaction').length, 1);
    assert.ok(latestNativeCompaction(f.sm.getBranch()));
    assert.ok(readFileSync(f.path, 'utf8').includes('Real portable fixture summary'));
    assert.ok(readFileSync(f.path, 'utf8').includes('synthetic-race-opaque'));
    assert.ok(f.sm.buildSessionProjection().messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('KEPT TAIL')));
  } finally { f.close(); }
});
