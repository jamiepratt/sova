import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import type { ChatServerMessage } from '../../../shared/protocol.ts';
import { until } from '../../test-wait.ts';
import { piSession } from './testing/handle.ts';
import { loadPi } from './testing/load-pi.ts';
import { latestNativeCompaction } from './native-compaction-state.ts';

const root = mkdtempSync(join(tmpdir(), 'native-hosted-'));
process.env.PI_CODING_AGENT_DIR = root;
process.env.SOVA_NATIVE_COMPACTION = 'on';
process.env.SOVA_MODELS_FETCH = 'off';
process.env.PI_OFFLINE = '1';
const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'hosted-fixture' } })).toString('base64')}.unsigned`;
writeFileSync(join(root, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'unused', expires: Number.MAX_SAFE_INTEGER } }), { mode: 0o600 });
// Register the hosted flags normally supplied by the excluded production extensions.
// This fixture neither loads their provider/resource side effects nor suppresses diagnostics.
const flagsExtension = join(root, 'hosted-flags.ts');
writeFileSync(flagsExtension, `export default function(api) {
  api.registerFlag('topic-outline-headless', { description: 'Fixture outline flag', type: 'boolean' });
  api.registerFlag('claude-code-provider', { description: 'Fixture provider flag', type: 'boolean' });
  api.registerFlag('align-visuals', { description: 'Fixture visual flag', type: 'string' });
}\n`);
writeFileSync(join(root, 'settings.json'), JSON.stringify({ cacheWarming: 'off', extensions: [flagsExtension], skills: [], retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } }));
const cwd = join(root, 'workspace');
const sessions = join(root, 'sessions');
const live = join(sessions, 'live');
mkdirSync(cwd, { recursive: true });
mkdirSync(live, { recursive: true });
const { acquireChat, disposeAllChats, disposeHeldChat, assertNotLive } = await import('../../chat-manager.ts');
const { getModelRuntime } = await import('./open.ts');
const { canonicalPath } = await import('../../paths.ts');
const runtime = await getModelRuntime();
await runtime.refresh({ providers: ['openai-codex'], allowNetwork: false });
const pi = await loadPi();
const model = new pi.agent.ModelRegistry(runtime).getAll().find(m => m.provider === 'openai-codex' && m.api === 'openai-codex-responses');
assert.ok(model);
let serial = 0;
after(async () => { await disposeAllChats(); rmSync(root, { recursive: true, force: true }); });
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

async function open() {
  const id = `hosted-${++serial}`;
  const literalPath = join(sessions, `${id}.jsonl`);
  const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const entries = [
    { type: 'session', version: 3, id, timestamp: '2026-10-10T00:00:00.000Z', cwd },
    { type: 'model_change', id: 'm', parentId: null, provider: model!.provider, modelId: model!.id },
    { type: 'message', id: 'u1', parentId: 'm', message: { role: 'user', content: 'Old hosted input', timestamp: 1 } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'OLD HOSTED ASSISTANT '.repeat(80) }], provider: model!.provider, api: model!.api, model: model!.id, stopReason: 'stop', timestamp: 2, usage } },
    { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'KEPT HOSTED TAIL '.repeat(80), timestamp: 3 } },
  ];
  writeFileSync(literalPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  // Canonicalize only after creation: macOS temporary paths may be symlinked.
  // The real live registry canonicalizes existing files before ownership lookup.
  const path = canonicalPath(literalPath);
  const before = readFileSync(path);
  const chat = await acquireChat(path, true);
  assert.deepEqual(readFileSync(path), before, 'opening and binding native hooks must not write');
  const mine: ChatServerMessage[] = [];
  const theirs: ChatServerMessage[] = [];
  const me = { send: (message: ChatServerMessage) => { mine.push(message); } };
  chat.attach(me);
  chat.attach({ send: message => { theirs.push(message); } });
  assert.deepEqual(readFileSync(path), before, 'attaching both clients must not write');
  mine.length = 0;
  theirs.length = 0;
  const session = piSession(chat);
  const bodies: any[] = [];
  let nativeSeen = false;
  let pauseNative = true;
  let release: (() => void) | undefined;
  const fetchFixture = (async (url: any, init?: RequestInit) => {
    assert.ok(String(url).startsWith('https://chatgpt.com/'), 'never redirect an arbitrary provider');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    const raw = Buffer.from(init!.body as any);
    const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : raw;
    const body = JSON.parse(bytes.toString('utf8'));
    bodies.push(body);
    const compact = body.input.some((item: any) => item.type === 'compaction_trigger');
    if (compact && pauseNative) {
      pauseNative = false;
      nativeSeen = true;
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(new Error('Synthetic fixture aborted')), { once: true });
      });
    }
    const responseId = `fixture-${id}-${bodies.length}`;
    const item = compact ? { type: 'compaction', id: `cmp-${responseId}`, encrypted_content: 'synthetic-hosted-opaque' }
      : { type: 'message', id: `msg-${responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Portable or ordinary answer ${responseId}`, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: compact ? item : { ...item, content: [] } },
      ...(!compact ? [
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: `Portable or ordinary answer ${responseId}` },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: `Portable or ordinary answer ${responseId}` },
      ] : []),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 3, total_tokens: 33 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  // Public request-local seams only: the hosted hooks, real compaction and built-in
  // subscription serializer/parser stay installed. No production eligibility is weakened.
  const bindFixture = (target: typeof session) => {
    const registry = target.extensionRunner.createContext().modelRegistry;
    const nested = registry.streamSimple.bind(registry);
    registry.streamSimple = (m, context, options) => nested(m, context, { ...options, fetch: fetchFixture, transport: 'sse', maxRetries: 0 });
    const ordinary = target.agent.streamFunction;
    target.agent.streamFunction = (m, context, options) => ordinary(m, context, { ...options, fetch: fetchFixture, transport: 'sse', maxRetries: 0 });
  };
  bindFixture(session);
  return { chat, session, me, mine, theirs, path, before, bodies, bindFixture, nativeSeen: () => nativeSeen, release: () => release!() };
}

test('real hosted native compact broadcasts the canonical checkpoint to both clients before a queued turn replays it', async () => {
  const f = await open();
  f.chat.handle(f.me, { type: 'compact', id: 'compact' });
  await until(f.nativeSeen);
  assert.deepEqual(readFileSync(f.path), f.before, 'no checkpoint or deferred model records are written while native work is pending');
  f.chat.handle(f.me, { type: 'prompt', text: 'QUEUED AFTER NATIVE', clientId: 'queued' });
  f.chat.handle(f.me, { type: 'compact', id: 'second' });
  await until(() => f.mine.some(message => message.type === 'compact_refused' && message.id === 'second'));
  assert.equal((f.mine.find(message => message.type === 'compact_refused' && message.id === 'second') as any).reason, 'compacting');
  assert.equal(f.bodies.length, 2, 'one portable and one pending native call, never a queued prompt sent early');
  f.release();
  await until(() => f.bodies.length === 3 && !f.session.isStreaming && f.mine.some(message => message.type === 'compacted'));
  const state = latestNativeCompaction(f.session.sessionManager.getBranch());
  assert.ok(state);
  assert.equal(f.session.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length, 1);
  const hello = f.theirs.find(message => message.type === 'hello');
  assert.ok(hello && hello.type === 'hello');
  assert.equal(hello.items.at(-1)?.kind, 'info');
  assert.equal(hello.isCompacting, false);
  assert.ok(f.theirs.findIndex(message => message.type === 'hello') < f.theirs.findIndex(message => message.type === 'event' && (message as any).event?.type === 'agent_start'), 'checkpoint branch is broadcast before queued turn starts');
  assert.ok(f.mine.some(message => message.type === 'send_ack' && message.clientId === 'queued' && message.queued));
  const replay = f.bodies[2];
  assert.equal(replay.input.filter((item: any) => item.type === 'compaction').length, 1);
  assert.ok(JSON.stringify(replay.input).includes('QUEUED AFTER NATIVE'));
  assert.ok(JSON.stringify(replay.input).includes('KEPT HOSTED TAIL'));
  assert.ok(!JSON.stringify(replay.input).includes('OLD HOSTED ASSISTANT'));
  assert.equal(replay.store, false);
});

test('late terminal ownership cancels a real pending native compact without checkpoint, deferred writes or a new fallback request', async () => {
  const f = await open();
  f.chat.handle(f.me, { type: 'compact', id: 'late' });
  await until(f.nativeSeen);
  const record = join(live, `p${process.ppid}-late.json`);
  writeFileSync(record, JSON.stringify({ session: { pid: process.ppid, sessionFile: f.path, status: 'active' }, presence: { status: 'idle' }, heartbeat: Date.now() }));
  try {
    assert.throws(() => assertNotLive(f.path), /open in another pi process/, 'positive control: the actual ownership guard must see the fixture record');
    f.release();
    await until(() => f.mine.some(message => message.type === 'compact_refused' && message.id === 'late'));
    assert.equal((f.mine.find(message => message.type === 'compact_refused' && message.id === 'late') as any).reason, 'cancelled');
    assert.deepEqual(readFileSync(f.path), f.before);
    assert.equal(latestNativeCompaction(f.session.sessionManager.getBranch()), null);
    assert.equal(f.bodies.length, 2, 'ownership invalidation explicitly cancels without an ordinary summarizer fallback');
    assert.ok(!f.theirs.some(message => message.type === 'hello'), 'cancelled work does not pretend a checkpoint landed');
    f.chat.handle(f.me, { type: 'compact', id: 'busy' });
    await until(() => f.mine.some(message => message.type === 'compact_refused' && message.id === 'busy'));
    assert.equal((f.mine.find(message => message.type === 'compact_refused' && message.id === 'busy') as any).reason, 'busy');
    assert.equal(f.bodies.length, 2);
    assert.deepEqual(readFileSync(f.path), f.before);
  } finally { rmSync(record, { force: true }); }
});

test('a complete foreign append during native work cancels the hosted checkpoint and preserves every foreign byte', async () => {
  const f = await open();
  f.chat.handle(f.me, { type: 'compact', id: 'foreign' });
  await until(f.nativeSeen);
  appendFileSync(f.path, JSON.stringify({ type: 'message', id: 'foreign-input', parentId: 'u2', message: { role: 'user', content: 'EXTERNAL WRITER INPUT', timestamp: 4 } }) + '\n');
  const foreignBytes = readFileSync(f.path);
  f.release();
  await until(() => f.mine.some(message => message.type === 'compact_refused' && message.id === 'foreign'));
  assert.equal((f.mine.find(message => message.type === 'compact_refused' && message.id === 'foreign') as any).reason, 'cancelled');
  assert.deepEqual(readFileSync(f.path), foreignBytes, 'no checkpoint or deferred write may overwrite or follow the foreign input');
  assert.equal(latestNativeCompaction(f.session.sessionManager.getBranch()), null);
  assert.equal(f.bodies.length, 2, 'foreign-write cancellation cannot start a fallback request');
  f.chat.handle(f.me, { type: 'compact', id: 'foreign-again' });
  await until(() => f.mine.some(message => message.type === 'compact_refused' && message.id === 'foreign-again'));
  assert.equal((f.mine.find(message => message.type === 'compact_refused' && message.id === 'foreign-again') as any).reason, 'recent');
  assert.deepEqual(readFileSync(f.path), foreignBytes);
  assert.equal(f.bodies.length, 2);
});

test('a real hosted checkpoint reopens without writes, replays natively, then a durable hosted rewind restores its old history', async () => {
  const f = await open();
  f.chat.handle(f.me, { type: 'compact', id: 'persist' });
  await until(f.nativeSeen);
  f.release();
  await until(() => f.mine.some(message => message.type === 'compacted' && message.id === 'persist'));
  const checkpoint = latestNativeCompaction(f.session.sessionManager.getBranch());
  assert.ok(checkpoint);
  assert.equal(await disposeHeldChat(f.path, 'Fixture reopen'), true);
  const compactedBytes = readFileSync(f.path);
  const reopened = await acquireChat(f.path);
  assert.deepEqual(readFileSync(f.path), compactedBytes, 'a recent owned checkpoint can reopen without force or a write');
  const session = piSession(reopened);
  assert.deepEqual(latestNativeCompaction(session.sessionManager.getBranch()), checkpoint);
  f.bindFixture(session);
  const frames: ChatServerMessage[] = [];
  const client = { send: (message: ChatServerMessage) => { frames.push(message); } };
  reopened.attach(client);
  assert.deepEqual(readFileSync(f.path), compactedBytes);
  reopened.handle(client, { type: 'prompt', text: 'REOPENED NATIVE TURN', clientId: 'reopened' });
  await until(() => f.bodies.length === 3 && !session.isStreaming && frames.some(message => message.type === 'event' && (message as any).event?.type === 'agent_end'));
  assert.equal(f.bodies[2].input.filter((item: any) => item.type === 'compaction').length, 1);
  assert.ok(!JSON.stringify(f.bodies[2].input).includes('OLD HOSTED ASSISTANT'));
  reopened.handle(client, { type: 'rewind', id: 'rewind-old', entryId: 'u2' });
  await until(() => frames.some(message => message.type === 'rewound' && message.id === 'rewind-old'));
  assert.equal(latestNativeCompaction(session.sessionManager.getBranch()), null);
  assert.ok(session.sessionManager.getEntries().some(entry => entry.type === 'compaction'), 'rewind changes ancestry rather than deleting durable metadata');
  await disposeHeldChat(f.path, 'Fixture rewind reopen');
  const rewoundBytes = readFileSync(f.path);
  const rewound = await acquireChat(f.path);
  const rewoundSession = piSession(rewound);
  assert.deepEqual(readFileSync(f.path), rewoundBytes, 'the persisted rewind marker survives hosted reopen without repair');
  assert.equal(latestNativeCompaction(rewoundSession.sessionManager.getBranch()), null);
  f.bindFixture(rewoundSession);
  const after: ChatServerMessage[] = [];
  const afterClient = { send: (message: ChatServerMessage) => { after.push(message); } };
  rewound.attach(afterClient);
  rewound.handle(afterClient, { type: 'prompt', text: 'POST REWIND TURN', clientId: 'rewound' });
  await until(() => f.bodies.length === 4 && !rewoundSession.isStreaming && after.some(message => message.type === 'event' && (message as any).event?.type === 'agent_end'));
  assert.equal(f.bodies[3].input.filter((item: any) => item.type === 'compaction').length, 0);
  assert.ok(JSON.stringify(f.bodies[3].input).includes('OLD HOSTED ASSISTANT'), 'pre-checkpoint ancestry is restored, not silently replaced by an orphan artifact');
  assert.ok(!JSON.stringify(f.bodies[3].input).includes('REOPENED NATIVE TURN'));
});

test('Stop aborts actual native work without a checkpoint, portable retry or multitab reset', async () => {
  const f = await open();
  f.chat.handle(f.me, { type: 'compact', id: 'stop' });
  await until(f.nativeSeen);
  f.chat.handle(f.me, { type: 'abort' });
  await until(() => f.mine.some(message => message.type === 'compact_refused' && message.id === 'stop'));
  assert.equal((f.mine.find(message => message.type === 'compact_refused' && message.id === 'stop') as any).reason, 'cancelled');
  assert.deepEqual(readFileSync(f.path), f.before);
  assert.equal(f.bodies.length, 2);
  assert.equal(latestNativeCompaction(f.session.sessionManager.getBranch()), null);
  assert.ok(!f.theirs.some(message => message.type === 'hello'));
});
