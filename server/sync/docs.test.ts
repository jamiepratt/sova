// Settings and themes sync between in-process "hosts", each with its own scratch agent dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelFavorites } from "../../pi-config/extensions/command-palette/favorites.ts";
import { delegateDefaults } from "../../pi-config/extensions/mode/delegate.ts";
import { specDefaults } from "../../pi-config/extensions/mode/spec.ts";
import { compareDocs, DocSync, settingsDocs, themeDoc, validFavorites, type DocPeer, type DocSyncOptions, type DocWatch } from "./docs";

const root = mkdtempSync(join(tmpdir(), "sova-doc-sync-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
let now = Date.now() + 1000;

/** Explicit delivery and debounce turns; files and parsers remain real. */
class Delivery {
  readonly watches: { directory: string; listener: (event: string, filename: string | null) => void; closes: number; close?: () => void }[] = [];
  readonly jobs: { callback: () => void; active: boolean; delay: number }[] = [];
  readonly watch: NonNullable<DocSyncOptions["watch"]> = (directory, listener) => {
    if (!existsSync(directory)) throw new Error("missing directory");
    const entry = { directory, listener, closes: 0, close: undefined as (() => void) | undefined };
    this.watches.push(entry);
    const watcher: DocWatch = {
      close: () => { entry.closes++; entry.close?.(); },
      on: (event, callback) => { if (event === "close") entry.close = callback; },
    };
    return watcher;
  };
  readonly schedule: NonNullable<DocSyncOptions["schedule"]> = (callback, delay) => {
    const job = { callback, active: true, delay };
    this.jobs.push(job);
    return () => { job.active = false; };
  };
  event(directory: string, filename: string | null) {
    for (const w of this.watches) if (w.directory === directory && !w.closes) w.listener("rename", filename);
  }
  pending() { return this.jobs.filter((j) => j.active); }
  fire() {
    const pending = this.pending();
    for (const j of pending) { j.active = false; j.callback(); }
  }
}

class Host {
  online = true;
  offset = 0;
  sync!: DocSync;
  enabled = { settings: true, themes: true };
  readonly agentDir: string;
  readonly stateDir: string;
  readonly delivery = new Delivery();
  constructor(
    readonly id: string,
    private readonly mesh: Host[],
    base: string,
    themesDir = true,
  ) {
    this.agentDir = join(base, id, "agent");
    this.stateDir = join(this.agentDir, "sova");
    mkdirSync(themesDir ? join(this.stateDir, "themes") : this.stateDir, { recursive: true });
    this.boot();
  }
  boot() {
    this.sync = new DocSync({
      hostId: this.id,
      agentDir: this.agentDir,
      stateDir: this.stateDir,
      sidecarPath: join(this.stateDir, "doc-sync.json"),
      peers: () => this.mesh.filter((h) => h !== this).map((h) => this.peerTo(h)),
      categoryEnabled: (c) => this.enabled[c],
      now: () => now + this.offset,
      log: () => {},
      debounceMs: 30,
      watch: this.delivery.watch,
      schedule: this.delivery.schedule,
    });
  }
  peerTo(t: Host): DocPeer {
    const reach = () => {
      if (!this.online || !t.online) throw new Error("unreachable");
    };
    return {
      id: t.id,
      manifest: async () => (reach(), structuredClone(t.sync.manifest())),
      doc: async (key) => {
        reach();
        const d = t.sync.doc(key);
        if (!d) throw new Error("404");
        return structuredClone(d);
      },
      push: async (body) => (reach(), t.sync.receivePush(this.id, structuredClone(body))),
    };
  }
  write(rel: string, content: string) {
    now++;
    const p = join(this.agentDir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  read(rel: string): string | undefined {
    const p = join(this.agentDir, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }
}

function mesh(n: number): Host[] {
  const base = join(root, `m${++seq}`);
  const hosts: Host[] = [];
  for (let i = 0; i < n; i++) hosts.push(new Host(String.fromCharCode(97 + i), hosts, base));
  return hosts;
}
const tick = async () => { now++; };
async function converge(hosts: Host[]) {
  for (let r = 0; r < 2; r++) for (const h of hosts) if (h.online) await h.sync.syncAll();
}
const modeJson = (mode: string) => `${JSON.stringify({ mode, minorModes: [], strict: false }, null, 2)}\n`;
const theme = (name: string) => JSON.stringify({ name, base: "dark", colors: {} });

test("favorites: the restated shape agrees with the palette's own reader on every sample", () => {
  const dir = join(root, "fav");
  mkdirSync(dir);
  const samples = [
    { version: 1, models: [] },
    { version: 1, models: [{ provider: "zai", id: "glm-5.3" }] },
    { version: 1, models: [{ provider: "zai", id: "glm-5.3", extra: 1 }] },
    { version: 1, models: [{ provider: "", id: "x" }] },
    { version: 1, models: [{ provider: "a", id: "" }] },
    { version: 1, models: [null] },
    { version: 2, models: [] },
    { version: 1, models: [], more: true },
    { version: 1 },
    { models: [] },
    [],
    "text",
    { version: 1, models: [{ provider: 1, id: "x" }] },
  ];
  for (const [i, s] of samples.entries()) {
    const text = JSON.stringify(s);
    const p = join(dir, `f${i}.json`);
    writeFileSync(p, text);
    let palette: boolean;
    try {
      new ModelFavorites(p);
      palette = true;
    } catch {
      palette = false;
    }
    assert.equal(validFavorites(text), palette, text);
  }
  assert.equal(validFavorites("{not json"), false);
});

test("validators: the consumers' defaults are valid, garbage is not; theme files are named safely", () => {
  const specs = Object.fromEntries(settingsDocs("/a", "/a/sova").map((s) => [s.key, s]));
  assert.equal(specs["settings:mode-delegate.json"]!.valid(JSON.stringify(delegateDefaults())), true);
  assert.equal(specs["settings:mode-delegate.json"]!.valid(JSON.stringify({ version: 9 })), false);
  assert.equal(specs["settings:mode-spec.json"]!.valid(JSON.stringify(specDefaults())), true);
  assert.equal(specs["settings:model-policy.json"]!.valid(JSON.stringify({ version: 1, disabledModels: ["a/b"] })), true);
  assert.equal(specs["settings:model-policy.json"]!.valid(JSON.stringify({ version: 1, disabledModels: [3] })), false);
  assert.equal(specs["settings:provider-limits.json"]!.valid(JSON.stringify({ version: 1, limits: { zai: 5 } })), true);
  assert.equal(specs["settings:provider-limits.json"]!.valid(JSON.stringify({ version: 1, limits: { zai: 0 } })), false);
  assert.equal(specs["settings:provider-limits.json"]!.valid(JSON.stringify({ version: 1, limits: {}, extra: true })), false);
  assert.equal(specs["settings:usage-windows.json"], undefined, "Ollama's old declared reset day is no longer a document");
  assert.equal(specs["settings:sova/settings.json"]!.valid("{}"), false);
  // Yours: the whole file, checked with the profile store's strict parser.
  const yours = specs["settings:sova/session-profiles.json"]!;
  assert.equal(yours.path, "/a/sova/session-profiles.json");
  assert.equal(yours.category, "settings");
  const card = { id: "claude", label: "Claude session", model: "claude-code-cli/claude-opus-5-5", thinking: "high", subagents: "claude-subs" };
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [card] })), true);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [] })), true);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [{ ...card, thinking: "hot" }] })), false);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [{ ...card, typo: 1 }] })), false);
  assert.equal(yours.valid(JSON.stringify({ version: 1, profiles: [card, { ...card, label: "Other" }] })), false, "two profiles with one id");
  assert.equal(yours.valid(JSON.stringify({ version: 2, profiles: [] })), false);
  assert.equal(yours.valid("{"), false);
  assert.equal(themeDoc("/t", "../evil.json"), null);
  assert.equal(themeDoc("/t", "a/b.json"), null);
  assert.equal(themeDoc("/t", ".hidden.json"), null);
  assert.equal(themeDoc("/t", "ocean.json")!.valid(theme("Ocean")), true);
  assert.equal(themeDoc("/t", "ocean.json")!.valid("{"), false);
});

test("newest edit wins; ties by origin then hash", () => {
  const a = { hash: "a".repeat(64), modifiedAt: 5, origin: "a" };
  assert.ok(compareDocs({ ...a, modifiedAt: 6 }, a) > 0);
  assert.ok(compareDocs({ ...a, origin: "b" }, a) > 0);
  assert.ok(compareDocs({ ...a, hash: "b".repeat(64) }, a) > 0);
  assert.ok(compareDocs({ ...a, hash: null }, a) < 0);
});

test("mesh off: constructing reads and writes nothing", () => {
  const dir = join(root, "off");
  mkdirSync(dir);
  new DocSync({ hostId: "x", agentDir: dir, stateDir: join(dir, "sova"), sidecarPath: join(dir, "sova", "doc-sync.json") });
  assert.deepEqual(readdirSync(dir), []);
});

test("a settings edit on one host reaches the others; a later edit elsewhere wins back", async () => {
  const [a, b, c] = mesh(3);
  for (const h of [a!, b!, c!]) await h.sync.start();
  try {
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!, c!]);
    for (const h of [b!, c!]) assert.equal(h.read("mode.json"), modeJson("delegate"), h.id);
    await tick();
    c!.write("mode.json", modeJson("normal"));
    c!.sync.observe();
    await converge([a!, b!, c!]);
    for (const h of [a!, b!]) assert.equal(h.read("mode.json"), modeJson("normal"), h.id);
  } finally {
    for (const h of [a!, b!, c!]) h.sync.stop();
  }
});

test("themes: an added theme appears everywhere, a deleted one disappears everywhere", async () => {
  const [a, b] = mesh(2);
  await a!.sync.start();
  await b!.sync.start();
  try {
    a!.write("sova/themes/ocean.json", theme("Ocean"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("sova/themes/ocean.json"), theme("Ocean"));
    await tick();
    rmSync(join(b!.stateDir, "themes", "ocean.json"));
    b!.sync.observe();
    await converge([a!, b!]);
    assert.equal(a!.read("sova/themes/ocean.json"), undefined);
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("first run: existing files are stamped by mtime (the later edit wins); a missing file deletes nothing", async () => {
  const [a, b] = mesh(2);
  a!.write("mode-spec.json", `${JSON.stringify(specDefaults())}\n`);
  b!.write("mode-spec.json", `${JSON.stringify({ ...specDefaults() }, null, 2)}\n`);
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(join(a!.agentDir, "mode-spec.json"), old, old);
  a!.write("sova/themes/only-a.json", theme("A"));
  await a!.sync.start();
  await b!.sync.start();
  try {
    await converge([a!, b!]);
    assert.equal(a!.read("mode-spec.json"), b!.read("mode-spec.json"));
    assert.equal(a!.read("mode-spec.json"), `${JSON.stringify({ ...specDefaults() }, null, 2)}\n`, "B's newer edit won");
    assert.equal(b!.read("sova/themes/only-a.json"), theme("A"), "B had no such theme: nothing to delete");
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("a local file its reader rejects is neither offered nor overwritten; a symlink is never written", async () => {
  const [a, b] = mesh(2);
  a!.write("model-favorites.json", JSON.stringify({ version: 1, models: [{ provider: "zai", id: "glm-5.3" }] }));
  b!.write("model-favorites.json", "{ broken");
  const target = join(root, `link-target-${seq}.json`);
  writeFileSync(target, modeJson("normal"));
  symlinkSync(target, join(b!.agentDir, "mode.json"));
  await a!.sync.start();
  await b!.sync.start();
  try {
    await tick();
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("model-favorites.json"), "{ broken", "never overwritten");
    assert.equal(readFileSync(target, "utf8"), modeJson("normal"), "the link's target is untouched");
    assert.equal(b!.sync.manifest().docs["settings:mode.json"], undefined);
    assert.equal(b!.sync.manifest().docs["settings:model-favorites.json"], undefined);
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("the palette's lock is honoured, and an unobserved local edit is never written over", async () => {
  const [a, b] = mesh(2);
  const fav = (id: string) => JSON.stringify({ version: 1, models: [{ provider: "zai", id }] });
  await a!.sync.start();
  await b!.sync.start();
  try {
    a!.write("model-favorites.json", fav("one"));
    a!.sync.observe();
    const lock = join(b!.agentDir, "model-favorites.json.lock");
    mkdirSync(lock);
    await converge([a!, b!]);
    assert.equal(b!.read("model-favorites.json"), undefined, "held off by the palette's lock");
    rmdirSync(lock);
    await converge([a!, b!]);
    assert.equal(b!.read("model-favorites.json"), fav("one"));
    // B edits after A's edit but before B has looked: applying A's document first folds B's
    // unobserved edit in (stamped now, so newer), and A's is refused rather than written over it.
    await tick();
    a!.write("model-favorites.json", fav("two"));
    a!.sync.observe();
    await tick();
    b!.write("model-favorites.json", fav("local"));
    const reason = b!.sync.apply("settings:model-favorites.json", a!.sync.doc("settings:model-favorites.json")!);
    assert.equal(reason, "older");
    assert.equal(b!.read("model-favorites.json"), fav("local"));
    await converge([a!, b!]);
    assert.equal(a!.read("model-favorites.json"), fav("local"), "the later edit won everywhere");
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("a switched-off category is neither offered nor taken; clock skew refuses", async () => {
  const [a, b] = mesh(2);
  await a!.sync.start();
  await b!.sync.start();
  try {
    b!.enabled.themes = false;
    a!.write("sova/themes/x.json", theme("X"));
    a!.write("mode.json", modeJson("delegate"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("sova/themes/x.json"), undefined);
    assert.equal(b!.read("mode.json"), modeJson("delegate"));
    b!.offset = 3_600_000;
    await tick();
    a!.write("mode.json", modeJson("normal"));
    a!.sync.observe();
    await converge([a!, b!]);
    assert.equal(b!.read("mode.json"), modeJson("delegate"), "no exchange across the skew");
    assert.equal(b!.sync.peers().a?.state, "clock-skew");
  } finally {
    a!.sync.stop();
    b!.sync.stop();
  }
});

test("a forged document (content not matching its hash, or rejected by its reader) is refused", async () => {
  const [a] = mesh(1);
  await a!.sync.start();
  try {
    const now = Date.now() + 1000;
    const r = a!.sync.receivePush("b", {
      hostId: "b",
      now: Date.now(),
      docs: {
        "settings:mode.json": { meta: { hash: "0".repeat(64), modifiedAt: now, origin: "b" }, content: modeJson("delegate") },
        "themes:../../auth.json": { meta: { hash: null, modifiedAt: now, origin: "b" }, content: null },
        "settings:auth.json": { meta: { hash: null, modifiedAt: now, origin: "b" }, content: null },
      },
    });
    assert.deepEqual(r.rejected.map((x) => x.reason), ["invalid", "unknown", "unknown"]);
    assert.equal(a!.read("mode.json"), undefined);
  } finally {
    a!.sync.stop();
  }
});

test("late themes folder: explicit parent event attaches one watcher; filtered, coalesced scans read the latest file and deletion", async () => {
  const hosts: Host[] = [];
  const base = join(root, `m${++seq}`);
  const a = new Host("a", hosts, base, false);
  hosts.push(a);
  await a.sync.start();
  try {
    const d = a.delivery;
    const themesDir = join(a.stateDir, "themes");
    assert.deepEqual(d.watches.map((w) => w.directory), [a.agentDir, a.stateDir], "no watch for the missing folder");
    d.event(a.agentDir, "auth.json");
    d.event(a.stateDir, "doc-sync.json");
    assert.equal(d.pending().length, 0, "unrelated files do not schedule a scan");
    a.write("sova/themes/late.json", theme("Late"));
    d.event(a.stateDir, "themes");
    assert.equal(a.sync.recordsSnapshot()["themes:late.json"], undefined, "the event only schedules");
    assert.equal(d.pending().length, 1);
    d.fire();
    const first = a.sync.recordsSnapshot()["themes:late.json"]!;
    assert.equal(typeof first.hash, "string", "creation scanned");
    assert.equal(d.watches.filter((w) => w.directory === themesDir).length, 1);
    d.fire(); // finish the creation's queued peer notification (there are no peers)
    d.event(themesDir, "temporary.txt");
    assert.equal(d.pending().length, 0, "theme watch ignores non-json names");
    a.write("sova/themes/late.json", theme("Intermediate"));
    d.event(themesDir, "late.json");
    const discarded = d.pending()[0]!;
    a.write("sova/themes/late.json", theme("Latest"));
    d.event(themesDir, null);
    assert.equal(discarded.active, false, "a second event replaces the pending scan");
    assert.equal(d.pending().length, 1);
    assert.equal(d.pending()[0]!.delay, 30);
    assert.equal(a.sync.recordsSnapshot()["themes:late.json"]!.hash, first.hash, "cached record unchanged before debounce");
    d.fire();
    assert.equal(a.sync.recordsSnapshot()["themes:late.json"]!.hash, createHash("sha256").update(theme("Latest")).digest("hex"), "the scan read the latest bytes, not an event-time snapshot");
    assert.notEqual(a.sync.recordsSnapshot()["themes:late.json"]!.hash, first.hash);
    assert.equal(a.sync.doc("themes:late.json")!.content, theme("Latest"));
    assert.equal(d.watches.filter((w) => w.directory === themesDir).length, 1, "scans do not duplicate the theme watcher");
    rmSync(join(themesDir, "late.json"));
    d.event(themesDir, "late.json");
    d.fire();
    assert.equal(a.sync.recordsSnapshot()["themes:late.json"]!.hash, null, "deletion scanned without a manual observe");
    a.write("mode.json", modeJson("delegate"));
    d.event(a.agentDir, "mode.json");
    assert.equal(d.pending().length, 2, "scan and coalesced sync are both pending");
    const beforeStop = a.sync.recordsSnapshot();
    a.sync.stop();
    a.sync.stop();
    assert.equal(d.pending().length, 0, "stop cancels both debounce paths");
    assert.ok(d.watches.every((w) => w.closes === 1), "every watch closes once, including the late theme watch");
    // A callback delivered after close cannot queue more work.
    d.watches[0]!.listener("rename", "mode.json");
    assert.equal(d.pending().length, 0);
    d.fire();
    assert.deepEqual(a.sync.recordsSnapshot(), beforeStop, "no scan after teardown");
  } finally {
    a.sync.stop();
  }
});

test("a local delete first noticed by a peer's request still reaches every other peer at once", async () => {
  // The lab's repro: b has themes off while a adds a theme (c takes it); a deletes it and b turns
  // themes back on at once, so b's pull asks a for the document before a's own watcher scans.
  const [a, b, c] = mesh(3);
  for (const h of [a!, b!, c!]) await h.sync.start();
  try {
    b!.enabled.themes = false;
    a!.write("sova/themes/toggle.json", theme("Toggle"));
    a!.sync.observe();
    await converge([a!, b!, c!]);
    assert.equal(c!.read("sova/themes/toggle.json"), theme("Toggle"));
    await tick();
    rmSync(join(a!.stateDir, "themes", "toggle.json"));
    b!.enabled.themes = true;
    // b pulls from a before a's watcher fires: a.doc() folds the delete into a's records.
    await b!.sync.syncWith(b!.peerTo(a!));
    assert.equal(a!.sync.recordsSnapshot()["themes:toggle.json"]!.hash, null, "the request folded the deletion into the cache");
    assert.equal(c!.read("sova/themes/toggle.json"), theme("Toggle"), "c still has the old document before the queued push");
    assert.equal(a!.delivery.pending().length, 1, "multiple local changes coalesce into one sync, even when doc() observes first");
    a!.delivery.fire();
    // Drain the in-process peer promises, not a wall-clock timer or a manual reconcile.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(c!.read("sova/themes/toggle.json"), undefined, "c lost it through the scheduled sync, without a reconcile");
  } finally {
    for (const h of [a!, b!, c!]) h.sync.stop();
  }
});
