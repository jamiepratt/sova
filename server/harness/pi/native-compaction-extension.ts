import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  convertToLlm, generateSummaryWithUsage,
  type AgentSession, type ContextEvent, type ExtensionContext, type InlineExtension,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { callNativeCompaction, type NativeCompactionCallOptions as ModelsSimpleStreamOptions, type NativeCompactionCallResult } from './native-compaction-call';
import { compatibleNative, latestNativeCompaction, parseNativeCompaction, replayNativePrefix, snapshotNativeInput, type NativeIdentity } from './native-compaction-state';
import { assertCompactionModelAllowed, compactionUsageDetails, withNativeCompactionUsage, type CompactionUsageComponent } from './native-compaction-accounting';

type Message = ContextEvent['messages'][number];
export interface NativeCompactionHost {
  memoryOn(): boolean;
  assertOwned(): void;
}
export interface NativeCompactionExtensionOptions {
  host(): NativeCompactionHost | null;
  enabled?(): boolean;
  /** Request-local injection only; the production factory supplies none. */
  streamOptions?: ModelsSimpleStreamOptions;
}
interface Controller {
  options: NativeCompactionExtensionOptions;
  snapshot?: () => Message;
  registry?: ExtensionContext['modelRegistry'];
  ctx?: ExtensionContext;
  prepare?: (messages: Message[], signal: AbortSignal) => Promise<Message[]>;
  witness?: { summary: string; item: unknown };
}
const controllers = new WeakMap<object, Controller>();
const enabled = (c: Controller) => (c.options.enabled?.() ?? process.env.SOVA_NATIVE_COMPACTION === 'on');
function available(c: Controller): NativeCompactionHost | null {
  const host = c.options.host();
  if (!host || !enabled(c) || host.memoryOn()) return null;
  try { host.assertOwned(); return host; } catch { return null; }
}
function accountFingerprint(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof account === 'string' && account.length > 0 ? createHash('sha256').update(account).digest('hex') : null;
  } catch { return null; }
}
async function identity(ctx: ExtensionContext, model = ctx.model): Promise<NativeIdentity | null> {
  if (!model || model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses') return null;
  const physical = ctx.modelRegistry.find(model.provider, model.id);
  if (!physical || physical.provider !== model.provider || physical.id !== model.id ||
      physical.api !== model.api || physical.baseUrl !== model.baseUrl || !ctx.modelRegistry.isUsingOAuth(model)) return null;
  const validEndpoint = (value: string | undefined) => {
    try {
      const url = new URL(value ?? model.baseUrl);
      return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash &&
        /^\/backend-api(?:\/codex)?\/?$/.test(url.pathname);
    } catch { return false; }
  };
  if (!validEndpoint(model.baseUrl)) return null;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !validEndpoint(auth.baseUrl)) return null;
  const account = accountFingerprint(auth.apiKey);
  return account ? { provider: 'openai-codex', api: 'openai-codex-responses', modelId: model.id,
    endpointOrigin: 'https://chatgpt.com', accountFingerprint: account } : null;
}
function summarySlot(message: Message): unknown {
  const llm = convertToLlm([message])[0];
  if (!llm || llm.role !== 'user') return undefined;
  const content = typeof llm.content === 'string' ? [{ type: 'text', text: llm.content }] : llm.content;
  if (!content.every(part => part.type === 'text')) return undefined;
  return { role: 'user', content: content.map(part => ({ type: 'input_text', text: (part as { text: string }).text })) };
}
function summaryOf(message: Message): string | undefined {
  return message.role === 'compactionSummary' ? message.summary : undefined;
}
function currentSummary(manager: ExtensionContext['sessionManager']): string | undefined {
  const branch = manager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type === 'compaction') return entry.summary;
  }
  return undefined;
}
/** Install after binding: witness AFTER every context hook and pi's prompt/loadout projections. */
export function installNativeCompactionHooks(session: AgentSession): void {
  const c = controllers.get(session.sessionManager);
  if (!c || c.snapshot) return;
  c.snapshot = () => {
    const hidden = (session as unknown as { _hiddenDeclarations?: ReadonlySet<string> })._hiddenDeclarations;
    return { role: 'system', content: session.systemPrompt, timestamp: Date.now(),
      toolsAdded: session.agent.state.tools.filter(tool => !hidden?.has(tool.name)).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        ...('constrainedSampling' in tool ? { constrainedSampling: tool.constrainedSampling } : {}),
      })) } as Message;
  };
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    c.witness = undefined;
    const out = transform ? await transform(messages, signal) : messages;
    if (available(c)) {
      const branch = session.sessionManager.getBranch();
      const latest = [...branch].reverse().find(entry => entry.type === 'compaction');
      const summary = latest?.type === 'compaction' ? latest.summary : undefined;
      const summaries = out.filter(message => summaryOf(message) === summary && message.role === 'compactionSummary');
      if (summary !== undefined && summaries.length === 1) {
        const item = summarySlot(summaries[0]!);
        // A genuine summary plus an identical user quote is already ambiguous before serialization.
        if (item && out.filter(message => isDeepStrictEqual(summarySlot(message), item)).length === 1) c.witness = { summary, item };
      }
    }
    return out;
  };
  c.prepare = async (messages, signal) => session.agent.transformContext ? await session.agent.transformContext(messages, signal) : messages;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const witness = c.witness;
    c.witness = undefined;
    if (!witness || !available(c)) return stream(model, context, options);
    return stream(model, context, { ...options, async onPayload(raw, requestModel) {
      const leaf = session.sessionManager.getLeafId();
      const selectedModel = c.ctx?.model;
      const state = latestNativeCompaction(session.sessionManager.getBranch());
      const assertReplayActive = () => {
        if (options?.signal?.aborted || !available(c) || session.sessionManager.getLeafId() !== leaf ||
            c.ctx?.model !== selectedModel || !isDeepStrictEqual(state, latestNativeCompaction(session.sessionManager.getBranch())) ||
            currentSummary(session.sessionManager) !== witness.summary) {
          throw new Error('Native compaction replay cancelled');
        }
      };
      assertReplayActive();
      // Establish compatibility before caller callbacks; an initially incompatible checkpoint is text,
      // while an identity that changes after an await is explicit cancellation.
      const startIdentity = state && c.ctx && selectedModel === model ? await identity(c.ctx, model) : null;
      assertReplayActive();
      const compatible = !!state && !!startIdentity && compatibleNative(state, startIdentity);
      // Snapshot BEFORE caller onPayload (including before_provider_request). A callback can mutate
      // raw in place, remove the genuine slot or leave an identical quote as the sole match. No
      // changed input mapping is proof of provenance; unrelated request settings may still change.
      const inputBefore = snapshotNativeInput(raw);
      const uniqueBefore = inputBefore !== undefined &&
        inputBefore.filter(item => isDeepStrictEqual(item, witness.item)).length === 1;
      const transformed = await options?.onPayload?.(raw, requestModel);
      assertReplayActive();
      const payload = transformed === undefined ? raw : transformed;
      if (!compatible) return payload;
      // Resolve auth afresh after the callback, retaining only an account fingerprint across awaits.
      const now = c.ctx ? await identity(c.ctx, model) : null;
      assertReplayActive();
      if (!now || !compatibleNative(state!, now)) throw new Error('Native compaction replay cancelled');
      if (!uniqueBefore || !isDeepStrictEqual(inputBefore, snapshotNativeInput(payload))) return payload;
      return replayNativePrefix(payload, witness.item, state!, { summaryPresent: true });
    } });
  };
}

export function createNativeCompactionExtension(options: NativeCompactionExtensionOptions): InlineExtension {
  const c: Controller = { options };
  return { name: 'sova-native-compaction', hidden: true, factory(pi) {
    pi.on('session_start', async (_event, ctx) => { controllers.set(ctx.sessionManager, c); c.registry = ctx.modelRegistry; c.ctx = ctx; });
    pi.on('session_shutdown', async (_event, ctx) => { controllers.delete(ctx.sessionManager); c.witness = undefined; });
    pi.on('session_before_compact', async (event, ctx) => {
      if (!available(c) || !c.snapshot) return;
      const leaf = ctx.sessionManager.getLeafId();
      const model = ctx.model;
      const startIdentity = await identity(ctx);
      if (event.signal.aborted || !available(c) || ctx.sessionManager.getLeafId() !== leaf || ctx.model !== model) return { cancel: true };
      if (!startIdentity || !model) return;
      const valid = async () => {
        try { assertCompactionModelAllowed(model); } catch { return false; }
        if (event.signal.aborted || !available(c) || ctx.sessionManager.getLeafId() !== leaf || ctx.model !== model) return false;
        const now = await identity(ctx);
        return !!now && compatibleNative({ ...startIdentity } as never, now) && !event.signal.aborted &&
          !!available(c) && ctx.sessionManager.getLeafId() === leaf && ctx.model === model;
      };
      // Invalidation after any await is explicit cancellation, not default compaction fallback.
      if (!(await valid())) return { cancel: true };
      const projection = ctx.sessionManager.buildSessionProjection();
      const cut = projection.entries.findIndex(entry => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
      if (cut < 0) return { cancel: true };
      const old = projection.entries.slice(0, cut).flatMap(entry => entry.messages).filter(message => message.role !== 'system');
      const prefix = c.prepare ? await c.prepare([c.snapshot(), ...old], event.signal) : [c.snapshot(), ...old];
      if (!(await valid())) return { cancel: true };
      const portablePrefix = prefix.filter(message => message.role !== 'system');
      if (!portablePrefix.length) return { cancel: true };
      const components: CompactionUsageComponent[] = [];
      let portable: Awaited<ReturnType<typeof generateSummaryWithUsage>>;
      try {
        assertCompactionModelAllowed(model);
        const route = `sova-compaction-portable-${randomUUID()}`;
        portable = await withNativeCompactionUsage(ctx.sessionManager.getSessionId(), ctx.cwd, () => generateSummaryWithUsage(
          portablePrefix, model, event.preparation.settings.reserveTokens, undefined, undefined, event.signal, event.customInstructions,
          undefined, pi.getThinkingLevel(), (m, context, callOptions) => ctx.modelRegistry.streamSimple(m, context,
            { ...callOptions, ...options.streamOptions, signal: event.signal, sessionId: route }),
        ));
        components.push({ operation: 'portable', provider: model.provider, model: model.id, usage: portable.usage });
      } catch { return { cancel: true }; }
      if (!(await valid()) || !portable.text.trim()) return { cancel: true };
      let native: NativeCompactionCallResult | undefined;
      let normalized: { usage?: unknown; model?: string; responseModel?: string } | undefined;
      let nativeUsageReported = false;
      try {
        assertCompactionModelAllowed(model);
        const route = `sova-compaction-native-${randomUUID()}`;
        const registry = { streamSimple: (...args: Parameters<typeof ctx.modelRegistry.streamSimple>) => {
          const out = ctx.modelRegistry.streamSimple(...args);
          const result = out.result.bind(out);
          out.result = async () => { const message = await result(); normalized = message; return message; };
          return out;
        } };
        const prior = latestNativeCompaction(ctx.sessionManager.getBranch());
        const summaries = prefix.filter(message => message.role === 'compactionSummary');
        const summary = summaries.length === 1 ? summaries[0] : undefined;
        const summaryItem = summary ? summarySlot(summary) : undefined;
        const summaryPresent = !!summaryItem && prefix.filter(message => isDeepStrictEqual(summarySlot(message), summaryItem)).length === 1;
        native = await withNativeCompactionUsage(ctx.sessionManager.getSessionId(), ctx.cwd, () => callNativeCompaction({
          registry, model, context: { messages: convertToLlm(prefix) }, signal: event.signal,
          options: { ...options.streamOptions, sessionId: route, async onProviderStreamEvent(raw, requestModel) {
            // A failed artifact can still report real spend. The ledger owns counting;
            // keep an independent raw witness so checkpoint details do not erase it.
            const event = raw as { type?: string; response?: { usage?: unknown } };
            if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type ?? '') &&
                event.response?.usage !== undefined) nativeUsageReported = true;
            await options.streamOptions?.onProviderStreamEvent?.(raw, requestModel);
          } }, 
          ...(prior && summary ? { priorPrefix: { state: prior, identity: startIdentity,
            expectedSummaryItem: summaryItem, summaryPresent } } : {}),
        }));
      } catch { /* A valid portable checkpoint already exists; do not make a second fallback call. */ }
      if (!(await valid())) return { cancel: true };
      components.push({ operation: 'native', provider: model.provider, model: model.id,
        responseModel: normalized?.responseModel ?? normalized?.model, usage: normalized?.usage, reported: nativeUsageReported });
      const accounting = compactionUsageDetails(components);
      const fileOps = event.preparation.fileOps;
      const state = native ? parseNativeCompaction({ ...startIdentity, v: 1, protocol: 'codex-responses-v2',
        boundary: { kind: 'pi-old-prefix', firstKeptEntryId: event.preparation.firstKeptEntryId },
        replacementHistory: native.replacementHistory, responseId: native.responseId }) : null;
      return { compaction: { summary: portable.text, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, ...(accounting.usage ? { usage: accounting.usage } : {}),
        details: { readFiles: [...fileOps.read], modifiedFiles: [...new Set([...fileOps.written, ...fileOps.edited])],
          sovaCompactionUsage: accounting.components, ...(state ? { sovaNativeCompaction: state } : {}) },
      } };
    });
  } };
}
