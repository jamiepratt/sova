import type { CompactionResult } from '@earendil-works/pi-coding-agent';
import { withUsageContext } from '../../../pi-config/extensions/llm-inflight/attribution.ts';
import { modelDenial, readModelPolicy } from '../../model-policy';

export type CompactionUsage = NonNullable<CompactionResult['usage']>;
export interface CompactionUsageComponent {
  operation: 'portable' | 'native';
  provider: string;
  model: string;
  responseModel?: string;
  /** The normalized reply, not raw Responses usage. Native also needs a raw usage witness. */
  usage?: unknown;
  /** Native's backend usage presence; SDK initialization alone is not reporting. */
  reported?: boolean;
}
export interface CompactionUsageDetails {
  components: Array<Omit<CompactionUsageComponent, 'usage' | 'reported'> & { usage?: CompactionUsage }>;
  usage?: CompactionUsage;
}

/** Nested registry calls do not emit model-policy's session hooks: check at each issue. */
export function assertCompactionModelAllowed(
  model: { provider: string; id: string },
  policy: () => ReturnType<typeof readModelPolicy> = readModelPolicy,
): void {
  const denial = modelDenial(policy(), `${model.provider}/${model.id}`);
  if (denial) throw new Error(denial);
}

/** Attribution only. The configured runtime remains the sole ledger writer. Use fresh routing IDs. */
export function withNativeCompactionUsage<T>(owner: string, cwd: string, fn: () => T): T {
  return withUsageContext({ owner, cwd, purpose: 'compaction' }, fn);
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tokens = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Copy only validated reported counters. No estimates, coerced numbers, or fabricated cost. */
export function validatedCompactionUsage(value: unknown): CompactionUsage | undefined {
  if (!object(value)) return undefined;
  const { input, output, cacheRead, cacheWrite, totalTokens, reasoning, cacheWrite1h } = value;
  if (!tokens(input) || !tokens(output) || !tokens(cacheRead) || !tokens(cacheWrite) || !tokens(totalTokens) ||
      totalTokens === 0 || totalTokens !== input + output + cacheRead + cacheWrite ||
      (reasoning !== undefined && (!tokens(reasoning) || reasoning > output)) ||
      (cacheWrite1h !== undefined && (!tokens(cacheWrite1h) || cacheWrite1h > cacheWrite))) return undefined;
  const c = value.cost;
  if (!object(c) || !cost(c.input) || !cost(c.output) || !cost(c.cacheRead) || !cost(c.cacheWrite) || !cost(c.total)) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    cost: { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, total: c.total } };
}

/** Preserve component attribution even when absent usage or different models prevents aggregation. */
export function compactionUsageDetails(components: readonly CompactionUsageComponent[]): CompactionUsageDetails {
  const details = components.map(({ operation, provider, model, responseModel, usage, reported }) => {
    const validated = operation === 'native' && reported !== true ? undefined : validatedCompactionUsage(usage);
    return { operation, provider, model, ...(responseModel ? { responseModel } : {}), ...(validated ? { usage: validated } : {}) };
  });
  const usage = combineCompactionUsage(components);
  return { components: details, ...(usage ? { usage } : {}) };
}

/** Reasoning is a split of output, not an extra token bucket. Never attribute mixed-model totals. */
export function combineCompactionUsage(components: readonly CompactionUsageComponent[]): CompactionUsage | undefined {
  const first = components[0];
  if (!first || !first.provider || !first.model) return undefined;
  if (components.some(c => c.provider !== first.provider || c.model !== first.model ||
      (c.responseModel ?? c.model) !== (first.responseModel ?? first.model) ||
      (c.operation === 'native' && c.reported !== true))) return undefined;
  const usages = components.map(c => validatedCompactionUsage(c.usage));
  if (usages.some(u => !u)) return undefined;
  const complete = usages as CompactionUsage[];
  const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens' | 'reasoning' | 'cacheWrite1h') =>
    complete.reduce((n, u) => n + (u[key] ?? 0), 0);
  const costs = (key: keyof CompactionUsage['cost']) => complete.reduce((n, u) => n + u.cost[key], 0);
  return validatedCompactionUsage({ input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'), totalTokens: sum('totalTokens'),
    ...(complete.every(u => u.reasoning !== undefined) ? { reasoning: sum('reasoning') } : {}),
    ...(complete.every(u => u.cacheWrite1h !== undefined) ? { cacheWrite1h: sum('cacheWrite1h') } : {}),
    cost: { input: costs('input'), output: costs('output'), cacheRead: costs('cacheRead'), cacheWrite: costs('cacheWrite'), total: costs('total') } });
}
