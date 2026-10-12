import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPi } from './testing/load-pi.ts';
import { forkSessionFile } from './fork.ts';
import { latestNativeCompaction } from './native-compaction-state.ts';

const pi = await loadPi();
const model = { provider: 'openai-codex', api: 'openai-codex-responses', model: 'fixture-model' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text: string) => ({ role: 'assistant' as const, ...model, content: [{ type: 'text' as const, text }], stopReason: 'stop' as const, timestamp: 2, usage });
const textOf = (messages: any[]) => JSON.stringify(pi.agent.convertToLlm(messages));
function state(firstKeptEntryId: string) {
  return { v: 1, protocol: 'codex-responses-v2', provider: 'openai-codex', api: 'openai-codex-responses', modelId: model.model, endpointOrigin: 'https://chatgpt.com', accountFingerprint: 'b'.repeat(64), boundary: { kind: 'pi-old-prefix', firstKeptEntryId }, replacementHistory: [{ type: 'compaction', id: 'cmp_persisted', encrypted_content: 'synthetic-persisted-artifact' }], responseId: 'resp_persisted' };
}

test('persisted checkpoint reload and forks before/after it preserve source bytes and exclude abandoned ancestry', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-lifecycle-'));
  try {
    const sm = pi.agent.SessionManager.create(root, root);
    sm.appendModelChange(model.provider, model.model);
    sm.appendThinkingLevelChange('off');
    sm.appendMessage({ role: 'user', content: 'ORIGINAL PREFIX', timestamp: 1 });
    const before = sm.appendMessage(answer('BEFORE CHECKPOINT REPLY'));
    const kept = sm.appendMessage({ role: 'user', content: 'KEPT TAIL', timestamp: 3 });
    const checkpoint = sm.appendCompaction('Portable persisted summary', kept, 100, { sovaNativeCompaction: state(kept) }, true);
    const after = sm.appendMessage(answer('AFTER CHECKPOINT REPLY'));
    const abandoned = sm.appendMessage(answer('ABANDONED REPLY'));
    sm.branch(after);
    sm.appendCustomEntry('sova-rewind', { targetId: after, fromLeafId: abandoned });
    const source = sm.getSessionFile();
    assert.ok(source);
    const bytes = readFileSync(source);
    const reopened = pi.agent.SessionManager.open(source);
    assert.deepEqual(readFileSync(source), bytes, 'opening a current complete persisted file must not repair or rewrite it');
    assert.deepEqual(latestNativeCompaction(reopened.getBranch()), state(kept));
    assert.ok(!textOf(reopened.buildSessionProjection().messages).includes('ABANDONED REPLY'));
    assert.ok(reopened.getEntries().some(e => e.id === abandoned), 'abandoned data stays on disk');
    for (const [entry, expectNative] of [[before, false], [after, true]] as const) {
      const fork = forkSessionFile(source, entry);
      assert.ok(fork.ok, fork.ok ? undefined : fork.message);
      const forkBytes = readFileSync(fork.path);
      const forked = pi.agent.SessionManager.open(fork.path);
      assert.deepEqual(readFileSync(fork.path), forkBytes);
      assert.deepEqual(readFileSync(source), bytes, 'a fork never modifies or navigates the source file');
      assert.equal(!!latestNativeCompaction(forked.getBranch()), expectNative);
      const context = textOf(forked.buildSessionProjection().messages);
      assert.ok(!context.includes('ABANDONED REPLY'));
      if (expectNative) {
        assert.ok(context.includes('Portable persisted summary'));
        assert.ok(context.includes('KEPT TAIL'));
        assert.ok(!context.includes('ORIGINAL PREFIX'));
        assert.ok(forked.getBranch().some(e => e.id === checkpoint));
      } else {
        assert.ok(context.includes('ORIGINAL PREFIX'));
        assert.ok(!context.includes('KEPT TAIL'));
        assert.ok(!context.includes('Portable persisted summary'));
      }
    }
    const refusal = forkSessionFile(source, abandoned);
    assert.equal(refusal.ok, false);
    if (!refusal.ok) assert.equal(refusal.reason, 'not_on_branch');
    assert.deepEqual(readFileSync(source), bytes);
    // Persisted rewind before the checkpoint must remove native state only from active
    // ancestry, not delete its durable bytes from the file.
    const priorLeaf = reopened.getLeafId();
    reopened.branch(before);
    reopened.appendCustomEntry('sova-rewind', { targetId: before, fromLeafId: priorLeaf });
    const rewoundBytes = readFileSync(source);
    const rewound = pi.agent.SessionManager.open(source);
    assert.equal(latestNativeCompaction(rewound.getBranch()), null);
    assert.ok(textOf(rewound.buildSessionProjection().messages).includes('ORIGINAL PREFIX'));
    assert.ok(!textOf(rewound.buildSessionProjection().messages).includes('Portable persisted summary'));
    assert.ok(rewound.getEntries().some(e => e.id === checkpoint));
    assert.deepEqual(readFileSync(source), rewoundBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native checkpoint metadata does not bypass projected dangling-tool fork refusal', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-pairing-'));
  try {
    const sm = pi.agent.SessionManager.create(root, root);
    sm.appendMessage({ role: 'user', content: 'OLD PREFIX', timestamp: 1 });
    const kept = sm.appendMessage({ role: 'user', content: 'TOOL TURN', timestamp: 2 });
    sm.appendCompaction('Portable tool prefix', kept, 100, { sovaNativeCompaction: state(kept) }, true);
    const call = sm.appendMessage({ ...answer(''), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_fixture', name: 'fixture_tool', arguments: {} }] });
    sm.appendMessage({ role: 'toolResult', toolCallId: 'call_fixture', toolName: 'fixture_tool', content: [{ type: 'text', text: 'RESULT' }], isError: false, timestamp: 3 });
    const complete = sm.appendMessage(answer('FINISHED TOOL TURN'));
    const source = sm.getSessionFile();
    assert.ok(source);
    const bytes = readFileSync(source);
    const missing = forkSessionFile(source, call);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, 'tool_boundary');
    const paired = forkSessionFile(source, complete);
    assert.equal(paired.ok, true, 'negative control: paired context can fork');
    assert.deepEqual(readFileSync(source), bytes);
    sm.appendContextEdit(call, null);
    // An omitted call no longer needs a result; the existing projection pairing rule,
    // not the artifact's presence, remains authoritative.
    const visible = sm.appendMessage(answer('AFTER CONTEXT EDIT'));
    assert.equal(forkSessionFile(source, visible).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
