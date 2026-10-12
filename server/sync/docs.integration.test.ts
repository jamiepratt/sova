// Native filesystem delivery belongs here; debounce/filter/cache logic is exercised explicitly in docs.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DocSync, settingsDocs } from "./docs";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const theme = (name: string) => JSON.stringify({ name, base: "dark", colors: {} });

async function until(condition: () => boolean): Promise<boolean> {
  const end = Date.now() + 15_000; // Existing native-delivery hang guard, not a readiness delay.
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
  return condition();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sova-doc-sync-native-"));
  const agentDir = join(root, "agent");
  const stateDir = join(agentDir, "sova");
  mkdirSync(stateDir, { recursive: true });
  return { root, agentDir, stateDir, sidecarPath: join(stateDir, "doc-sync.json") };
}

function nativeDiagnostics(agentDir: string) {
  let order = 0;
  let cleanup = false;
  const attempts: { order: number; directory: string; kind: "attempt" | "attached" | "throw"; code?: string }[] = [];
  const events: { order: number; directory: string; event: string; filename: string | null; type: string }[] = [];
  const lifecycle: { order: number; directory: string; kind: "error" | "close"; code?: string; phase: "before-teardown" | "cleanup" }[] = [];
  const watchers: FSWatcher[] = [];
  const attachments: string[] = [];
  const subscribe = (directory: string, listener: (event: string, filename: string | null) => void = () => {}) => {
    const label = relative(agentDir, directory) || ".";
    attempts.push({ order: ++order, directory: label, kind: "attempt" });
    let w: FSWatcher;
    try {
      w = watch(directory, { persistent: false }, (event, filename) => {
        events.push({ order: ++order, directory: label, event, filename, type: typeof filename });
        listener(event, filename);
      });
    } catch (error) {
      attempts.push({ order: ++order, directory: label, kind: "throw", code: (error as NodeJS.ErrnoException).code });
      throw error;
    }
    attempts.push({ order: ++order, directory: label, kind: "attached" });
    attachments.push(label);
    w.on("error", (error: NodeJS.ErrnoException) => lifecycle.push({ order: ++order, directory: label, kind: "error", code: error.code, phase: cleanup ? "cleanup" : "before-teardown" }));
    w.on("close", () => lifecycle.push({ order: ++order, directory: label, kind: "close", phase: cleanup ? "cleanup" : "before-teardown" }));
    watchers.push(w);
    return w;
  };
  return {
    subscribe, watchers, events,
    snapshot: () => ({ attempts, events, attachments, lifecycle }),
    beginCleanup: () => { cleanup = true; },
  };
}

test("raw native parent watch reports an immediately created child directory without DocSync", async (t) => {
  const f = fixture();
  const diagnostics = nativeDiagnostics(f.agentDir);
  const { events, watchers, subscribe: attach } = diagnostics;
  const themesDir = join(f.stateDir, "themes");
  try {
    // Match start(): loadSidecar(), then observe(true)'s watchThemes(), specs(), readLocal().
    // With all documents absent, readLocal stops at its first lstat and observeOne returns
    // before its optional mtime lstat; observe persists no sidecar in this fixture.
    assert.throws(() => readFileSync(f.sidecarPath, "utf8"), { code: "ENOENT" });
    assert.throws(() => attach(themesDir), { code: "ENOENT" });
    assert.throws(() => readdirSync(themesDir), { code: "ENOENT" });
    for (const spec of settingsDocs(f.agentDir, f.stateDir)) {
      assert.throws(() => lstatSync(spec.path), { code: "ENOENT" });
    }
    attach(f.agentDir);
    attach(f.stateDir);
    assert.throws(() => attach(themesDir), { code: "ENOENT" });
    await Promise.resolve(); // Same microtask boundary as awaiting async start(), not a readiness wait.
    mkdirSync(themesDir);
    writeFileSync(join(themesDir, "late.json"), theme("Late"));
    assert.equal(await until(() => events.some((e) => e.directory === "sova")), true, `raw native parent event; ${JSON.stringify(diagnostics.snapshot())}`);
    // No Sova object, observer, filtering, debounce or reconciliation is involved.
  } finally {
    t.diagnostic(JSON.stringify({ rawNative: true, phase: "before-teardown", ...diagnostics.snapshot() }));
    diagnostics.beginCleanup();
    for (const w of watchers) w.close();
    t.diagnostic(JSON.stringify({ rawNative: true, phase: "cleanup", expectedCloseRequests: watchers.length, ...diagnostics.snapshot() }));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native parent watch sees the first theme write in a late folder, then its deletion without reconcile", async (t) => {
  const f = fixture();
  const diagnostics = nativeDiagnostics(f.agentDir);
  const sync = new DocSync({
    ...f,
    hostId: "a",
    debounceMs: 30,
    log: () => {},
    watch: diagnostics.subscribe,
  });
  await sync.start();
  try {
    // Deliberately no watch-readiness sleep: the very first write remains exposed.
    const themesDir = join(f.stateDir, "themes");
    mkdirSync(themesDir);
    const path = join(themesDir, "late.json");
    writeFileSync(path, theme("Late"));
    assert.equal(await until(() => sync.recordsSnapshot()["themes:late.json"]?.hash === hash(theme("Late"))), true, `first creation seen through native parent delivery; ${JSON.stringify(diagnostics.snapshot())}`);
    rmSync(path);
    assert.equal(await until(() => sync.recordsSnapshot()["themes:late.json"]?.hash === null), true, `deletion seen through the attached native theme watch; ${JSON.stringify(diagnostics.snapshot())}`);
    // No doc(), observe(), syncWith() or periodic reconcile can satisfy either assertion.
  } finally {
    t.diagnostic(JSON.stringify({ phase: "before-teardown", ...diagnostics.snapshot() }));
    diagnostics.beginCleanup();
    sync.stop();
    t.diagnostic(JSON.stringify({ phase: "cleanup", expectedCloseRequests: diagnostics.watchers.length, ...diagnostics.snapshot() }));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native directory watch delivers the first settings write and atomic replacement, not just a later reconciliation", async () => {
  const f = fixture();
  const events: { directory: string; filename: string | null }[] = [];
  const sync = new DocSync({
    ...f,
    hostId: "a",
    debounceMs: 30,
    log: () => {},
    watch: (directory, listener) => watch(directory, { persistent: false }, (event, filename) => {
      events.push({ directory, filename });
      listener(event, filename);
    }),
  });
  await sync.start();
  try {
    const path = join(f.agentDir, "mode.json");
    const first = JSON.stringify({ mode: "delegate" });
    writeFileSync(path, first); // No readiness delay before the first native event.
    const delivered = () => events.some((e) => e.directory === f.agentDir && e.filename === "mode.json");
    assert.equal(await until(() => delivered() && sync.recordsSnapshot()["settings:mode.json"]?.hash === hash(first)), true, "first named native event and resulting record");
    events.length = 0;
    const latest = JSON.stringify({ mode: "normal" });
    const temporary = join(f.agentDir, "mode.json.tmp");
    writeFileSync(temporary, latest);
    renameSync(temporary, path);
    assert.equal(await until(() => delivered() && sync.recordsSnapshot()["settings:mode.json"]?.hash === hash(latest)), true, "replacement named native event and latest bytes, with no manual observe");
  } finally {
    sync.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
