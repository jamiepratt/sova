import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { conformer } from "./conform";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry } from "./store";

/**
 * Conformance cleans up after itself on every outcome (§app.project-services/conform): the scratch
 * worktrees and `sova/conform-*` branches it cut are gone after a failed setup too, even one that left
 * files behind in its worktree. On a host in memory (fake-host.ts) with real git: the setups are the fake
 * driver's runs (one writes into its worktree, as setup.mjs in the integration test does).
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-cleanup-agent-"));

const op: Caller = { kind: "operator" };
const host = new FakeHost();
let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });

function commitDef(d: object) {
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "def"]);
}

/** Every scratch branch, every worktree besides the main checkout, and every folder beside it that conform cut. */
function leftovers(): string[] {
  const branches = git(["branch", "--list", "sova/conform-*"]).split("\n").map((s) => s.trim()).filter(Boolean);
  const trees = git(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ") && l.slice(9) !== project);
  const dir = join(parent, ".worktrees");
  const folders = existsSync(dir) ? readdirSync(dir) : [];
  return [...branches.map((b) => `branch ${b}`), ...trees, ...folders.map((f) => `folder ${f}`)];
}

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-conform-cleanup-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  // Leaves an untracked file in its worktree, then fails: the worktree is dirty.
  writeFileSync(join(project, "setup.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("local.edn", "{}"); console.log("no config"); process.exit(3);`);
  writeFileSync(join(project, "fail.mjs"), `process.exit(2);`);
  writeFileSync(join(project, "web.mjs"), `console.log("web up"); setInterval(() => {}, 1000);`);
  git(["init", "-q", "-b", "main"]);
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run("teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

before(() => {
  // setup.mjs leaves an untracked file in its worktree, then fails; fail.mjs just fails.
  host.driver.once = (spec) => {
    if (spec.argv[1] === "setup.mjs") {
      writeFileSync(join(spec.cwd, "local.edn"), "{}");
      return { code: 3 };
    }
    return { code: spec.argv[1] === "fail.mjs" ? 2 : 0 };
  };
  engine = new ProjectEngine(host.deps());
  engine.conformer = conformer(engine, undefined, host.rssOf);
});

test("a setup that fails after writing into its worktree: no scratch worktree, folder or sova/conform-* branch is left", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "locals", run: ["node", "setup.mjs"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, false);
  assert.equal(r.conform?.checks.find((c) => !c.ok)?.id, "create-a");
  assert.deepEqual(leftovers(), []);
  assert.deepEqual(r.conform?.leaks, []);
  assert.equal(readRegistry().instances.length, 0);
});

test("a setup that fails cleanly: nothing is left either", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "fail", run: ["node", "fail.mjs"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, false);
  assert.deepEqual(leftovers(), []);
});

test("a run that passes leaves nothing and samples its host's resident memory", async () => {
  const observations: number[][] = [];
  const readRss = (pids: number[]) => {
    observations.push([...pids]);
    return pids.length ? pids.length * 91_337 : null;
  };
  engine = new ProjectEngine(host.deps({ rssOf: readRss }));
  engine.conformer = conformer(engine, undefined, readRss);
  const starts: { unit: string; pids: number[] }[] = [];
  const start = host.driver.start;
  host.driver.start = async (spec) => {
    await start.call(host.driver, spec);
    starts.push({ unit: spec.unit, pids: host.driver.pids(spec.unit) });
  };
  commitDef({ version: 1, slots: { cap: 1 }, services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op).finally(() => { host.driver.start = start; });
  assert.equal(r.ok, true, JSON.stringify(r.conform?.checks.filter((c) => !c.ok)));
  assert.deepEqual(r.conform?.memory?.instances, ["A", "B"].map((label) => ({
    label,
    peakBytes: 91_337,
    steadyBytes: 91_337,
    services: [{ name: "web", peakBytes: 91_337, steadyBytes: 91_337 }],
  })), "both scratch instances use the injected reader, not the host's real RSS or the fixture's default");
  const live = observations.filter((pids) => pids.length);
  assert.ok(live.length > 0, "the reader actually sampled running services");
  assert.ok(live.every((pids) => pids.length === 1 && pids[0]! > 5_000_000), "only the fake units' process ids reach the reader");
  assert.equal(starts.length, 3, "the default reload starts A, B, then restarts A");
  const [a, b, restartedA] = starts;
  assert.notEqual(a!.unit, b!.unit, "A and B have distinct units");
  assert.equal(restartedA!.unit, a!.unit, "apply restarts A's own unit");
  assert.ok(starts.every((s) => s.pids.length === 1), "each started unit has one fake process");
  assert.equal(new Set(starts.flatMap((s) => s.pids)).size, 3, "A's restart gets a new pid, distinct from A and B's original pids");
  assert.deepEqual([...new Set(live.flat())].sort((a, b) => a - b), starts.flatMap((s) => s.pids).sort((a, b) => a - b), "the reader observes exactly A, B and the restarted A, using the driver's actual pids");
  assert.deepEqual(leftovers(), []);
});
