import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';
import { until } from '../../test-wait.ts';
import { loadPi } from './testing/load-pi.ts';
import { createNativeCompactionExtension, installNativeCompactionHooks } from './native-compaction-extension.ts';
import { latestNativeCompaction } from './native-compaction-state.ts';

const pi = await loadPi();
const account = 'writer-synthetic-account';
const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.unsigned`;
const artifact = { type: 'compaction', id: 'cmp_writer_fixture', encrypted_content: 'WRITER_OPAQUE_SENTINEL_ONLY' };
const portable = 'PORTABLE DURABLE FACT: the user rejected truncating exact wording.';
const tail = 'RETAINED DURABLE FACT: no alternative silently replaces the chosen option.';
const note = 'WRITER NOTE: preserve the exact distinction rather than a plausible substitute.';
const privateWriter = 'PRIVATE WRITER REASONING NOT A PARENT TURN';

function sse(id: string, text: string, compact: boolean): string {
  const item = compact ? artifact : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: compact ? item : { ...item, content: [] } },
    ...(!compact ? [
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, text },
    ] : []),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 30, output_tokens: 3, total_tokens: 33 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/** Fixture extension only: preserve the configured provider's catalog/auth/identity and
 * capture its REAL built-in serializer/parser request. Never call registry.streamSimple
 * from its own replacement (which would recurse), or install Sova's native factory. */
function captureExtension(url: string, attestation: string): string {
  return `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
export default function(api) {
  // Fail closed even if a later extension assertion/registration fails: a failed
  // fixture must never fall through to a real backend with synthetic credentials.
  const network = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    assert.equal(new URL(String(input)).origin, ${JSON.stringify(url)}, 'fixture child refuses all nonlocal fetch');
    return network(input, init);
  };
  globalThis.WebSocket = class { constructor() { throw new Error('Fixture child refuses WebSocket; the captured built-in provider must use SSE'); } };
  api.on('session_start', async (_event, ctx) => {
    const registry = ctx.modelRegistry;
    const model = ctx.model;
    assert.ok(model && model.provider === 'openai-codex' && model.api === 'openai-codex-responses');
    const physical = registry.find(model.provider, model.id);
    assert.ok(physical && physical.api === model.api && physical.baseUrl === model.baseUrl);
    assert.equal(new URL(model.baseUrl).origin, 'https://chatgpt.com');
    const original = registry.getProvider(model.provider);
    assert.ok(original && typeof original.streamSimple === 'function');
    const streamSimple = original.streamSimple.bind(original);
    const stream = original.stream.bind(original);
    const fetchLocal = globalThis.fetch;
    const local = (input, init) => {
      assert.ok(String(input).startsWith('https://chatgpt.com/'), 'only the real Codex service request is intercepted');
      const headers = new Headers(init?.headers);
      headers.set('x-fixture-writer-pid', String(process.pid));
      return fetchLocal(${JSON.stringify(`${url}/writer`)}, { ...init, headers });
    };
    // Native Provider registration retains the SAME auth object and model catalog,
    // unlike defining a synthetic API-key provider or replacing its endpoint/model.
    api.registerProvider({ ...original,
      getModels: original.getModels.bind(original),
      ...(original.getAllModels ? { getAllModels: original.getAllModels.bind(original) } : {}),
      stream(model, context, options) { return stream(model, context, { ...options, fetch: local, transport: 'sse', maxRetries: 0 }); },
      streamSimple(model, context, options) { return streamSimple(model, context, { ...options, fetch: local, transport: 'sse', maxRetries: 0 }); },
    });
    assert.equal(registry.getProvider(model.provider).auth, original.auth);
    assert.ok(registry.isUsingOAuth(model));
    const auth = await registry.getApiKeyAndHeaders(model);
    assert.ok(auth.ok && auth.apiKey === ${JSON.stringify(token)});
    assert.equal(new URL(auth.baseUrl ?? model.baseUrl).origin, 'https://chatgpt.com');
    const branch = ctx.sessionManager.getBranch();
    const checkpoint = [...branch].reverse().find(entry => entry.type === 'compaction');
    assert.ok(checkpoint?.details?.sovaNativeCompaction, 'the actual fork carries native metadata, not merely a text-only source');
    writeFileSync(${JSON.stringify(attestation)}, JSON.stringify({
      pid: process.pid, bun: process.versions.bun, policy: process.env.SOVA_NATIVE_COMPACTION,
      home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR,
      provider: model.provider, api: model.api, modelId: model.id, baseUrl: model.baseUrl,
      oauth: registry.isUsingOAuth(model), authMatches: auth.apiKey === ${JSON.stringify(token)},
      summary: checkpoint.summary, native: checkpoint.details.sovaNativeCompaction,
    }), { mode: 0o600 });
  });
}\n`;
}

test('actual compact-handoff background writer on an eligible subscription model uses durable portable text, never native operations or encrypted checkpoint replay', async (t) => {
  assert.ok(process.versions.bun, 'the parent project integration selector must use the pinned Bun runtime');
  const root = mkdtempSync(join(tmpdir(), 'native-writer-'));
  const home = join(root, 'home');
  const agentDir = join(home, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: token, refresh: 'unused', expires: Number.MAX_SAFE_INTEGER } }), { mode: 0o600 });
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 }, skills: [] }));
  const parentBodies: any[] = [];
  const writerBodies: any[] = [];
  const writerPids: string[] = [];
  const failures: string[] = [];
  let serial = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const encoding = req.headers['content-encoding'];
      assert.ok(encoding === undefined || encoding === 'zstd');
      const body = JSON.parse((encoding === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString('utf8'));
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers['chatgpt-account-id'], account);
      const writer = req.url === '/writer';
      (writer ? writerBodies : parentBodies).push(body);
      if (writer) writerPids.push(String(req.headers['x-fixture-writer-pid']));
      const compact = body.input.some((item: any) => item.type === 'compaction_trigger');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(`writer_fixture_${++serial}`, writer ? `${privateWriter}\n<handoff>${note}</handoff>` : portable, compact));
    } catch (error) {
      failures.push(String(error));
      res.writeHead(500); res.end('Synthetic fixture rejected a request');
    }
  });
  let session: Awaited<ReturnType<typeof pi.agent.createAgentSession>>['session'] | undefined;
  let writer: ChildProcess | undefined;
  let handle: { stop(): Promise<void> } | undefined;
  let childExit: Promise<void> | undefined;
  const key = `writer-launch-${crypto.randomUUID()}`;
  const savedPolicy = process.env.SOVA_NATIVE_COMPACTION;
  process.env.SOVA_NATIVE_COMPACTION = 'on';
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const fetchLocal: typeof fetch = ((input: any, init?: RequestInit) => {
      assert.ok(String(input).startsWith('https://chatgpt.com/'));
      return fetch(`${url}/parent`, init);
    }) as typeof fetch;
    const runtime = await pi.agent.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    await runtime.refresh({ providers: ['openai-codex'], allowNetwork: false });
    const registry = new pi.agent.ModelRegistry(runtime);
    const model = registry.getAll().find(m => m.provider === 'openai-codex' && m.api === 'openai-codex-responses');
    assert.ok(model && registry.isUsingOAuth(model));
    assert.equal(new URL(model.baseUrl).origin, 'https://chatgpt.com');
    const auth = await registry.getApiKeyAndHeaders(model);
    assert.ok(auth.ok && auth.apiKey === token);
    const sm = pi.agent.SessionManager.create(root, root);
    sm.appendModelChange(model.provider, model.id);
    sm.appendMessage({ role: 'user', content: 'OLD DURABLE INPUT: exact wording is a requirement.', timestamp: 1 });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'OLD ASSISTANT HISTORY '.repeat(100) }],
      provider: model.provider, api: model.api, model: model.id, stopReason: 'stop', timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    sm.appendMessage({ role: 'user', content: tail.repeat(30), timestamp: 3 });
    const attestation = join(root, 'writer-attestation.json');
    const capture = join(root, 'writer-capture.ts');
    writeFileSync(capture, captureExtension(url, attestation));
    let copied = '';
    let launches = 0;
    let launchCommand = '';
    let launchArgs: string[] = [];
    let copiedNative: unknown;
    let writerError = '';
    (globalThis as any)[key] = {
      start(actualStart: (spec: any, handlers: any) => any, spec: any, handlers: any) {
        copied = readFileSync(spec.forkSession, 'utf8');
        copiedNative = latestNativeCompaction(copied.trim().split('\n').map(line => JSON.parse(line)));
        // Existing test seams ONLY forward to the real background launcher. Its
        // executable, argv, RPC handshake, marker and child extension stay intact.
        handle = actualStart({ ...spec, extensions: [...(spec.extensions ?? []), capture],
          spawnImpl(command: string, args: string[], options: any) {
            launches++;
            launchCommand = command; launchArgs = [...args];
            const env = { ...options.env, HOME: home, PI_CODING_AGENT_DIR: agentDir,
              SOVA_NATIVE_COMPACTION: 'on', PI_OFFLINE: '1', SOVA_MODELS_FETCH: 'off' };
            // No caller auth/env shortcut may turn the child into another provider.
            for (const name of ['OPENAI_API_KEY', 'OPENAI_CODEX_API_KEY', 'SOVA_PI_CLI', 'NODE_OPTIONS', 'BUN_OPTIONS', 'PI_PACKAGE_DIR']) delete env[name];
            writer = spawn(command, args, { ...options, env });
            writer.stderr?.on('data', data => { writerError = (writerError + String(data)).slice(-4000); });
            childExit = new Promise<void>(resolve => writer!.once('close', () => resolve()));
            return writer;
          },
        }, handlers);
        return handle;
      },
    };
    const wrapper = join(root, 'handoff-real-launch.ts');
    writeFileSync(wrapper, `import handoff from ${JSON.stringify(resolve('pi-config/extensions/compact-handoff/index.ts'))};\nimport { startBackgroundFork } from ${JSON.stringify(resolve('pi-config/extensions/subagents/fork/background.ts'))};\nexport default function(api) { handoff(api, { agentDir: () => ${JSON.stringify(agentDir)}, start: (spec, handlers) => globalThis[${JSON.stringify(key)}].start(startBackgroundFork, spec, handlers) }); }\n`);
    const settings = pi.agent.SettingsManager.inMemory({ cacheWarming: 'off', retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
    const native = createNativeCompactionExtension({ host: () => ({ memoryOn: () => false, assertOwned() {} }), streamOptions: { fetch: fetchLocal, transport: 'sse' } });
    const loader = new pi.agent.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [wrapper],
      systemPromptOverride: () => 'Synthetic writer portability instructions', appendSystemPromptOverride: () => [], extensionFactories: [native] });
    await loader.reload();
    ({ session } = await pi.agent.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model,
      sessionManager: sm, settingsManager: settings, resourceLoader: loader, noTools: 'all' }));
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (m, context, options) => stream(m, context, { ...options, fetch: fetchLocal, transport: 'sse', maxRetries: 0 });
    await session.bindExtensions({});
    installNativeCompactionHooks(session);
    await session.compact('Keep the actual facts in portable text');
    const state = latestNativeCompaction(sm.getBranch());
    assert.ok(state, 'positive control: policy/model/auth must produce a genuine native checkpoint');
    assert.deepEqual(state.replacementHistory.filter(item => item.type === 'compaction'), [artifact]);
    assert.equal(parentBodies.length, 2, 'real portable generation and native operation both reach the fixture');
    assert.deepEqual(parentBodies[1].input.at(-1), { type: 'compaction_trigger' });
    await session.prompt('Parent ordinary replay positive control');
    assert.deepEqual(parentBodies.at(-1).input.filter((item: any) => item.type === 'compaction'), [artifact], 'ordinary factory can really send the opaque checkpoint');
    await session.prompt('/compact-handoff preserve exact wording');
    assert.equal(launches, 1, 'the real command invokes exactly one background process');
    assert.ok(writer?.pid && writer.pid !== process.pid, 'a real subprocess, not a fake RPC child');
    assert.equal(realpathSync(launchCommand), realpathSync(process.execPath), 'actual launcher uses the parent pinned Bun binary');
    const pinnedCli = join(pi.dir, JSON.parse(readFileSync(join(pi.dir, 'package.json'), 'utf8')).bin.pi);
    assert.ok(launchArgs.some(arg => realpathSyncIfPresent(arg) === pinnedCli), 'actual pinned pi CLI is launched, not a replacement script');
    assert.ok(launchArgs.includes('--no-extensions'));
    const extensions = launchArgs.flatMap((arg, index) => arg === '-e' ? [launchArgs[index + 1]] : []);
    assert.equal(extensions[0], resolve('pi-config/extensions/subagents/worker-mark.ts'));
    assert.equal(extensions.at(-1), resolve('pi-config/extensions/subagents/fork/child.ts'));
    assert.equal(extensions.length, 3, 'only marker, fixture capture and real fork child; no native feature extension');
    assert.ok(launchArgs.includes('--fork') && launchArgs.includes('--mode') && launchArgs.includes('rpc'));
    assert.ok(copied.includes(artifact.encrypted_content) && copied.includes(portable), 'the writer source really contains both representations');
    assert.deepEqual(copiedNative, state);
    await until(() => existsSync(attestation) && writerBodies.length > 0 && !session!.isCompacting && sm.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'compact-handoff' && JSON.stringify(entry.data).includes(note)),
      'the actual writer saves its note and the parent settles', 30_000).catch(error => {
        throw new Error(`${String(error)}; writer=${writerError}; fixture=${failures.join('; ')}`);
      });
    await childExit;
    const child = JSON.parse(readFileSync(attestation, 'utf8'));
    assert.equal(child.pid, writer!.pid);
    assert.equal(child.bun, process.versions.bun);
    assert.equal(child.policy, 'on');
    assert.equal(child.home, home); assert.equal(child.agent, agentDir);
    assert.equal(child.provider, model.provider); assert.equal(child.api, model.api); assert.equal(child.modelId, model.id); assert.equal(child.baseUrl, model.baseUrl);
    assert.equal(child.oauth, true); assert.equal(child.authMatches, true);
    assert.equal(child.summary, portable); assert.deepEqual(child.native, state);
    assert.ok(writerBodies.length >= 1, 'negative assertions require actual child model traffic');
    assert.ok(writerPids.every(pid => pid === String(writer!.pid)));
    const first = JSON.stringify(writerBodies[0].input);
    assert.ok(first.includes(portable) && first.includes(tail), 'actual writer receives genuine summary and durable kept facts as text');
    for (const [index, body] of writerBodies.entries()) {
      // Report ALL matches as paths/kinds only: ordinary include metadata, tool
      // schemas and textual mentions are not evidence of an opaque replay leak.
      const occurrences = encryptedContentLocations(body);
      t.diagnostic(JSON.stringify({ writerRequest: index, encryptedContentLocations: occurrences }));
      assert.ok(!JSON.stringify(body).includes(artifact.encrypted_content), 'opaque sentinel absent from EVERY child request, not just its first input');
      assert.ok(!JSON.stringify(body).includes(artifact.id));
      assert.deepEqual(body.include, ['reasoning.encrypted_content'], 'positive ordinary Codex transport metadata, not a replayed checkpoint');
      assert.deepEqual(nativeHistoryLocations(body.input), [], 'actual input history must contain no native artifact, operation or checkpoint properties');
      assert.equal(Object.hasOwn(body, 'context_management'), false);
      assert.equal(body.context_management, undefined);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.store, false);
      assert.equal(body.model, model.id);
    }
    assert.deepEqual(failures, []);
    assert.ok(!JSON.stringify(sm.getBranch()).includes(privateWriter), 'only the extracted note, never private writer reasoning, enters the parent');
    assert.ok(readFileSync(join(agentDir, 'compact-handoffs', `${sm.getSessionId()}.md`), 'utf8').includes(note));
  } finally {
    await handle?.stop().catch(() => {});
    await childExit;
    session?.dispose();
    delete (globalThis as any)[key];
    if (savedPolicy === undefined) delete process.env.SOVA_NATIVE_COMPACTION; else process.env.SOVA_NATIVE_COMPACTION = savedPolicy;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

type StructuralLocation = { path: string; kind: string };
/** Values are never returned: diagnostics cannot print credentials, ciphertext or text. */
function encryptedContentLocations(value: unknown, path = '$'): StructuralLocation[] {
  if (typeof value === 'string') return value.includes('encrypted_content') ? [{ path, kind: 'string-value' }] : [];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => encryptedContentLocations(item, `${path}[${index}]`));
  return Object.entries(value).flatMap(([key, child]) => {
    const at = `${path}[${JSON.stringify(key)}]`;
    return [...(key.includes('encrypted_content') ? [{ path: at, kind: 'property-name' }] : []), ...encryptedContentLocations(child, at)];
  });
}
/** Examine actual history objects, not arbitrary words in instructions or tool schemas. */
function nativeHistoryLocations(value: unknown, path = '$["input"]'): StructuralLocation[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => nativeHistoryLocations(item, `${path}[${index}]`));
  const node = value as Record<string, unknown>;
  const own: StructuralLocation[] = [];
  if (node.type === 'compaction' || node.type === 'compaction_trigger') own.push({ path, kind: 'native-wire-type' });
  if (node.protocol === 'codex-responses-v2') own.push({ path, kind: 'native-checkpoint-protocol' });
  for (const key of ['encrypted_content', 'sovaNativeCompaction', 'context_management', 'previous_response_id']) {
    if (Object.hasOwn(node, key)) own.push({ path: `${path}[${JSON.stringify(key)}]`, kind: 'native-history-property' });
  }
  return [...own, ...Object.entries(node).flatMap(([key, child]) => nativeHistoryLocations(child, `${path}[${JSON.stringify(key)}]`))];
}

function realpathSyncIfPresent(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}
