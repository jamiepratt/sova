// Native live-record delivery and two hubs over real WebSockets on 127.0.0.1.
// Deterministic watcher/peer logic is in llm-inflight.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { SessionFeedMessage } from "../shared/protocol";
import { LlmInflightHub, type HubTimers, type HubWatchFactory, type LlmProcessSnapshot, type OwnCounter, type UnadoptedWorker } from "./llm-inflight";

const snap = (over: Partial<LlmProcessSnapshot> = {}): LlmProcessSnapshot => ({ v: 1, producer: "own", pid: 100, active: 0, approximate: 0, claudeTurns: 0, degraded: false, ...over });

class FakeOwn implements OwnCounter {
  value = snap();
  private fns = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (fn: () => void) => {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  };
  set(over: Partial<LlmProcessSnapshot>): void {
    this.value = snap({ ...this.value, ...over });
    for (const fn of this.fns) fn();
  }
}

const inflights = (msgs: SessionFeedMessage[]) => msgs.flatMap((m) => (m.type === "llm_inflight" ? [m.inflight] : []));
/** Poll until `ok` holds; the guard only stops a hang. */
async function until(ok: () => boolean, what: string, guardMs = 30_000): Promise<void> {
  const end = Date.now() + guardMs;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`still waiting after ${guardMs} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Hold hub timers so a native-event assertion cannot pass by a fallback rescan. */
function heldTimers() {
  let next = 0;
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const intervals = new Map<number, () => void>();
  const timers: HubTimers = {
    setTimeout: (fn, ms) => (timeouts.set(++next, { fn, ms }), next),
    clearTimeout: (handle) => void timeouts.delete(handle as number),
    setInterval: (fn) => (intervals.set(++next, fn), next),
    clearInterval: (handle) => void intervals.delete(handle as number),
  };
  return {
    timers,
    sweep: () => { for (const fn of intervals.values()) fn(); },
    waiting: (ms: number) => [...timeouts.values()].filter((t) => t.ms === ms).length,
    debounce: (ms: number) => {
      for (const [id, timer] of [...timeouts]) {
        if (timer.ms !== ms) continue;
        timeouts.delete(id);
        timer.fn();
      }
    },
    get pending(): number { return timeouts.size + intervals.size; },
  };
}

const record = (dir: string, name: string, pid: number, llm: Partial<LlmProcessSnapshot>) =>
  writeFileSync(join(dir, name), JSON.stringify({ session: { pid }, heartbeat: Date.now(), presence: { llm: snap({ producer: `p${pid}`, pid, ...llm }) } }));

describe("native live-record delivery", () => {
  test("a live dir appearing later and a failed watch recover at the next sweep; the replacement delivers a named event", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-late-native-"));
    const dir = join(root, "live");
    const held = heldTimers();
    const watchers: FSWatcher[] = [];
    let attempts = 0;
    const nativeWatch: HubWatchFactory = (path, changed) => {
      attempts++;
      const watcher = watch(path, changed);
      watchers.push(watcher);
      return watcher;
    };
    const hub = new LlmInflightHub({ own: new FakeOwn(), liveDir: dir, watch: nativeWatch, alive: () => true, debounceMs: 5, timers: held.timers });
    const got: SessionFeedMessage[] = [];
    try {
      hub.addBrowser((m) => got.push(m));
      assert.equal(watchers.length, 0, "no dir yet");
      assert.equal(attempts, 1);
      mkdirSync(dir);
      held.sweep();
      assert.equal(watchers.length, 1, "attached once the dir exists");
      watchers[0]!.emit("error", new Error("watch lost"));
      held.sweep();
      assert.equal(watchers.length, 2, "re-attached");
      assert.equal(attempts, 3);
      record(dir, "p9-x.json", 9, { active: 2 });
      await until(() => held.waiting(5) > 0, "the native replacement watch event's debounce");
      assert.equal(inflights(got).at(-1)!.count, 0, "no fallback sweep or early file read");
      held.debounce(5);
      assert.equal(inflights(got).at(-1)!.count, 2, "native event delivered before the periodic rescan");
      held.sweep();
      assert.equal(watchers.length, 2, "healthy replacement not duplicated");
    } finally {
      hub.stop();
      assert.equal(held.pending, 0);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("native adoption delivery excludes a cached unadopted worker without rereading its registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-reg-native-"));
    const held = heldTimers();
    const own = new FakeOwn();
    let reads = 0;
    let registry: UnadoptedWorker[] = [{ key: "a/1", producer: "w7", counts: { active: 1, approximate: 0, claudeTurns: 0, degraded: false } }];
    // No watch override: this exercises the production default as well as actual delivery.
    const hub = new LlmInflightHub({ own, liveDir: dir, alive: () => true, debounceMs: 1, workers: () => (reads++, registry), timers: held.timers });
    const got: SessionFeedMessage[] = [];
    try {
      hub.addBrowser((m) => got.push(m));
      assert.equal(reads, 1, "one read when counting starts");
      for (let i = 0; i < 100; i++) own.set({ active: (i + 1) % 2 });
      held.debounce(1);
      assert.equal(reads, 1, "begin/end recounts from the held snapshot");
      assert.equal(inflights(got).at(-1)!.count, 1, "own 0 + the unadopted worker's 1");
      record(dir, "p3-x.json", 3, { active: 1, folded: ["w7"] });
      await until(() => held.waiting(1) > 0, "the native adoption watch event's debounce");
      held.debounce(1);
      assert.equal(reads, 1, "the watch event does not reread the registry");
      assert.equal(inflights(got).at(-1)!.count, 1, "counted once: the held copy is excluded by the parent's folded");
      registry = [];
      held.sweep();
      assert.equal(reads >= 2, true, "the sweep refreshed it");
      assert.equal(reads, 2);
      assert.equal(inflights(got).at(-1)!.count, 1);
      record(dir, "p3-x.json", 3, { active: 0, folded: [] });
      await until(() => held.waiting(1) > 0, "the native parent completion event's debounce");
      held.debounce(1);
      assert.equal(inflights(got).at(-1)!.count, 0, "the sweep replaced the cached worker list");
      assert.equal(reads, 2, "native events still cause no registry read");
    } finally {
      hub.stop();
      assert.equal(held.pending, 0);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("two hosts over real sockets", () => {
  test("each counts the other once, both ways, and neither passes the other's count back", async () => {
    const { WebSocket, WebSocketServer } = await import("ws");
    const dirs = [mkdtempSync(join(tmpdir(), "llm-a-")), mkdtempSync(join(tmpdir(), "llm-b-"))];
    const owns = [new FakeOwn(), new FakeOwn()];
    owns[0]!.value = snap({ producer: "a", active: 1 });
    owns[1]!.value = snap({ producer: "b", active: 2 });
    const servers: InstanceType<typeof WebSocketServer>[] = [];
    const urls: string[] = [];
    const hubs: LlmInflightHub[] = [];
    for (let i = 0; i < 2; i++) {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise((r) => wss.once("listening", r));
      servers.push(wss);
      urls.push(`http://127.0.0.1:${(wss.address() as { port: number }).port}`);
    }
    for (let i = 0; i < 2; i++) {
      const other = urls[1 - i]!;
      hubs.push(
        new LlmInflightHub({
          own: owns[i]!,
          liveDir: dirs[i]!,
          sweepMs: 1000,
          mesh: { peers: () => [{ id: `h${1 - i}`, url: other }], selfId: () => `h${i}`, connect: (url) => new WebSocket(`${url.replace(/^http/, "ws")}/ws/watch?feed=llm`) },
        }),
      );
      servers[i]!.on("connection", (ws) => ws.on("close", hubs[i]!.addLocal((m) => ws.send(JSON.stringify(m)))));
    }
    try {
      const seen: SessionFeedMessage[][] = [[], []];
      hubs.forEach((h, i) => h.addBrowser((m) => seen[i]!.push(m)));
      const total = (i: number) => inflights(seen[i]!).at(-1);
      await until(() => !total(0)?.partial && !total(1)?.partial, "both peers answered");
      assert.deepEqual(total(0), { count: 3, approximate: 0, partial: false, gaps: [] });
      assert.deepEqual(total(1), { count: 3, approximate: 0, partial: false, gaps: [] });
      owns[1]!.set({ active: 4 });
      await until(() => total(0)!.count !== 3 && total(1)!.count !== 3, "b's change reached both");
      assert.equal(total(0)!.count, 5);
      assert.equal(total(1)!.count, 5, "b's own browser: a's 1 + b's 4, a never echoes b's");
    } finally {
      hubs.forEach((h) => h.stop());
      servers.forEach((s) => s.close());
      dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    }
  });
});
