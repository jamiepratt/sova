import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseProfile, profileFileError, powersToApprove, type Profile } from "../shared/profiles";
import { approvalOf } from "../server/profile-trust";
import { listProjectPlaybooks, parseFrontmatter } from "../server/playbooks";

const bundle = fileURLToPath(new URL("../.sova/playbooks/resolve-github-issues/", import.meta.url));
const helper = new URL("../.sova/playbooks/resolve-github-issues/scripts/plan.mjs", import.meta.url).href;
const { plan, parseRequest } = await import(helper);
const SHA = "a".repeat(40), MOVED = "b".repeat(40);
const row = (number: number, extra: Record<string, unknown> = {}) => ({ number, state: "open", labels: [], assignees: [], author: "reporter", milestone: null, children: [], dependencies: [], externalPrerequisites: [], verified: false, verifiedAt: null, ...extra });
const snapshot = (issues: ReturnType<typeof row>[], extra: Record<string, unknown> = {}) => ({ repo: "owner/repository", defaultBranch: "main", branches: ["main", "release"], landingBranch: "main", landingSha: SHA, complete: true, issues, ...extra });
const read = (p: string) => readFileSync(join(bundle, p), "utf8");

test("blank invocation includes every open issue, excludes closed context and keeps deterministic bounded batches", () => {
  const inventory = snapshot([row(3), row(2, { state: "closed" }), row(1), row(4), row(5), row(6), row(7), row(8)]);
  assert.deepEqual(plan(inventory, "").selected, [1, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(plan(inventory, {}).batches, [[1, 3, 4], [5, 6, 7]]);
  assert.deepEqual(plan(inventory, {}).deferred, [8]);
  assert.deepEqual(plan(snapshot([])).batches, [], "empty selection never broadens scope");
});

test("base and destination default independently from GitHub, never from local master", () => {
  const s = snapshot([row(42)]);
  const defaults = plan(s);
  assert.deepEqual([defaults.base, defaults.landing], ["main", "main"]);
  assert.deepEqual([plan(s, { base: "release" }).base, plan(s, { base: "release" }).landing], ["release", "main"]);
  const override = plan({ ...s, landingBranch: "release" }, { repo: "OWNER/REPOSITORY", base: "release", landing: "release", landingMode: "handoff" });
  assert.deepEqual([override.repo, override.base, override.landing, override.landingMode], ["owner/repository", "release", "release", "handoff"]);
  for (const request of [{ base: "missing" }, { landing: "missing" }, { repo: "other/repo" }]) assert.throws(() => plan(s, request));
  assert.throws(() => plan({ ...s, defaultBranch: "missing" }), /default branch missing/);
});

test("single/list selection never expands to children; parent recursively includes closed verification context", () => {
  const s = snapshot([row(42, { children: [43] }), row(43, { children: [44] }), row(44, { state: "closed", verified: true, verifiedAt: SHA }), row(99)]);
  assert.deepEqual(plan(s, { issues: [42, 42] }).selected, [42]);
  assert.deepEqual(plan(s, { issues: [42] }).blockers, [{ issue: 42, prerequisites: [43] }]);
  const tree = plan(s, { parent: 42 });
  assert.deepEqual(tree.selected, [42, 43]);
  assert.deepEqual(tree.context, [44]);
  assert.deepEqual(tree.batches, [[43, 42]], "child before parent, even within a serial batch");
  assert.deepEqual(tree.blockers, []);
  assert.throws(() => plan(s, { issues: [44] }), /explicit issues must be open/);
  assert.throws(() => plan(s, { parent: 44 }), /parent must be open/);
});

test("filters are conjunctive exact matches with no implicit explicit/parent pruning", () => {
  const s = snapshot([
    row(1, { labels: ["bug", "ready"], assignees: ["maintainer"], milestone: "next", author: "alice" }),
    row(2, { labels: ["bug"], assignees: ["maintainer"], milestone: "next", author: "alice" }),
    row(3, { labels: ["bug", "ready"], assignees: ["other"], milestone: "next", author: "alice" }),
  ]);
  assert.deepEqual(plan(s, { filters: { labels: ["bug", "ready"], assignee: "maintainer", milestone: "next", author: "alice" } }).selected, [1]);
  assert.deepEqual(plan(s, { filters: { labels: ["Bug"] } }).selected, []);
  for (const request of [{ parent: 1, filters: { labels: ["bug"] } }, { issues: [1], filters: { author: "alice" } }]) assert.throws(() => plan(s, request), /filters cannot prune/);
});

test("out-of-scope and unverified closed prerequisites block, propagate, and leave independent work eligible", () => {
  const s = snapshot([row(1, { dependencies: [2] }), row(2, { dependencies: [3] }), row(3, { state: "closed" }), row(4)]);
  const p = plan(s, { issues: [1, 2, 4] });
  assert.deepEqual(p.blockers, [{ issue: 2, prerequisites: [3] }, { issue: 1, prerequisites: [2] }]);
  assert.deepEqual(p.batches, [[4]]);
  assert.deepEqual(plan(snapshot([row(1, { dependencies: [2] }), row(2)]), { issues: [1] }).blockers, [{ issue: 1, prerequisites: [2] }]);
});

test("target-verified prerequisite satisfies dependencies regardless of GitHub open/closed state", () => {
  for (const state of ["open", "closed"]) {
    const s = snapshot([row(1, { dependencies: [2] }), row(2, { state, verified: true, verifiedAt: SHA })]);
    assert.deepEqual(plan(s, { issues: [1] }).batches, [[1]], state);
    assert.deepEqual(plan(s, { issues: [1] }).blockers, [], state);
  }
  const s = snapshot([row(1, { verified: true, verifiedAt: MOVED })]);
  assert.throws(() => plan(s), /verification must be bound/);
  assert.throws(() => plan(snapshot([row(1, { verified: true, verifiedAt: SHA })], { landingSha: MOVED })), /verification must be bound/);
  assert.throws(() => plan(snapshot([row(1)]), { landing: "release" }), /verification target differs/);
});

test("qualified external blockers cannot collide with local issue numbers, propagate, and preserve independent work", () => {
  const s = snapshot([row(1, { dependencies: [2] }), row(2, { externalPrerequisites: ["OTHER/REPO#3", "other/repo#3"] }), row(3), row(4)]);
  const p = plan(s);
  assert.deepEqual(p.blockers, [{ issue: 2, prerequisites: ["other/repo#3"] }, { issue: 1, prerequisites: [2] }]);
  assert.deepEqual(p.batches, [[3, 4]], "same-number local issue cannot satisfy external issue");
  for (const ref of ["owner/repository#3", "3", "other/repo#0", "other/repo#3;cmd"]) assert.throws(() => plan(snapshot([row(1, { externalPrerequisites: [ref] })])));
});

test("deduplicate equivalent pages, but conflicts, missing edges, unknown pages, and cycles fail closed", () => {
  const one = row(1, { labels: ["b", "a"], dependencies: [2] });
  assert.deepEqual(plan(snapshot([one, row(1, { labels: ["a", "b", "a"], dependencies: [2, 2] }), row(2)])).batches, [[2, 1]]);
  assert.throws(() => plan(snapshot([one, row(1), row(2)])), /conflicting inventory/);
  assert.throws(() => plan(snapshot([row(1, { dependencies: [2] })])), /missing issue 2/);
  assert.throws(() => plan(snapshot([row(1)], { complete: false })), /incomplete/);
  assert.throws(() => plan(snapshot([row(1)]), { issues: [99] }), /missing selected issue/);
  for (const issues of [[row(1, { dependencies: [1] })], [row(1, { children: [2] }), row(2, { dependencies: [1] })]]) assert.throws(() => plan(snapshot(issues)), /cycle/);
  const missingGraph = row(1) as Record<string, unknown>; delete missingGraph.dependencies;
  assert.throws(() => plan(snapshot([missingGraph as ReturnType<typeof row>])), /dependencies must be a list/);
});

test("strict invocation refuses ambiguous targets, unsafe branches, and excessive work", () => {
  for (const bad of ["42", "[]", "null", "{bad", { issues: [] }, { issues: [0] }, { issues: ["42"] }, { parent: 1, issues: [1] }, { query: "all" }, { filters: { search: "bug" } }, { filters: null }, { batchSize: null }, { maxBatches: null }, { landingMode: null }, { repo: "repo" }, { base: "main~1" }, { landing: "--all" }, { batchSize: 6 }, { maxBatches: 6 }, { batchSize: 0 }, { landingMode: "merge-round" }]) assert.throws(() => parseRequest(bad));
  assert.deepEqual(plan(snapshot([row(1), row(2), row(3)]), { batchSize: 1, maxBatches: 1 }).deferred, [2, 3]);
});

test("resume cannot silently select unrelated new issues or alter saved targets", () => {
  const s = snapshot([row(42), row(99)]);
  assert.throws(() => plan(s, { resume: "run-a" }), /validated saved run/);
  for (const changed of [{ issues: [99] }, { parent: 99 }, { repo: "owner/repository" }, { base: "release" }, { landing: "release" }, { filters: {} }, { maxBatches: 5 }]) assert.throws(() => parseRequest({ resume: "run-a", ...changed }), /cannot change/);
  assert.deepEqual(plan(s, { issues: [42] }).selected, [42], "validated frozen open selection excludes unrelated new issue 99");
  assert.throws(() => parseRequest({ resume: "../run-a" }), /local run id/);
});

test("project profile parses, preserves workers, uses composer prefill, and cannot approve itself", () => {
  const raw = JSON.parse(readFileSync(new URL("../.sova/profiles/resolve-github-issues.json", import.meta.url), "utf8"));
  assert.equal(profileFileError(raw), null);
  const p = parseProfile(raw) as Profile;
  assert.deepEqual(p.remove, [], "remove web would implicitly remove workers");
  assert.deepEqual(p.grant, ["sessions.read", "sessions.message"]);
  assert.equal(p.singleton, true);
  assert.equal(p.overseerMayStart, true);
  assert.deepEqual(p.minorModes, ["spec"]);
  assert.match(p.firstMessage!, /absolute current checkout root from the session cwd/);
  assert.match(p.firstMessage!, /git rev-parse --show-toplevel/);
  assert.match(p.firstMessage!, /read <root>\/\.sova\/playbooks\/resolve-github-issues\/PLAYBOOK\.md/);
  assert.match(p.firstMessage!, /bootstrap reading instruction, not the playbook's JSON arguments/);
  assert.match(p.firstMessage!, /Invocation JSON: \{\}/);
  assert.equal("playbook" in raw, false, "retired linkage is not an auto-launch contract");
  assert.deepEqual(powersToApprove(p), { grant: p.grant, overseerMayStart: true });
  const listed = { ...p, source: "project" as const, key: "project:fixture#resolve-github-issues" };
  assert.equal(approvalOf(listed, {}), "needed");
  assert.equal(approvalOf(listed, { [listed.key]: { grant: p.grant, overseerMayStart: false, at: "" } }), "needed");
  const captain = JSON.parse(readFileSync(new URL("../.sova/profiles/merge-captain.json", import.meta.url), "utf8"));
  assert.equal(profileFileError(captain), null);
  assert.equal(captain.overseerMayStart, true);
});

test("real project loader discovers the branch bundle without running scripts or scheduling it", async () => {
  const temp = mkdtempSync(join(tmpdir(), "resolve-issues-catalog-"));
  try {
    const dir = join(temp, ".sova", "playbooks"); mkdirSync(dir, { recursive: true });
    symlinkSync(bundle, join(dir, "resolve-github-issues"), "dir");
    const [entry] = await listProjectPlaybooks(temp);
    assert.ok(entry);
    assert.equal(entry.id, "resolve-github-issues");
    assert.equal(entry.source, "project");
    assert.equal(entry.title, "Resolve GitHub issues");
    assert.equal(entry.schedule, undefined);
    assert.match(entry.body, /^# Resolve GitHub issues/);
    assert.deepEqual(Object.keys(parseFrontmatter(read("PLAYBOOK.md")).fields).sort(), ["description", "promptHint", "title"]);
    for (const path of ["references/contract.md", "references/workflow.md", "scripts/plan.mjs"]) assert.ok(read(path).length > 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("published safety contract holds closure and master-specific handoff behind their explicit gates", () => {
  const entry = read("PLAYBOOK.md"), workflow = read("references/workflow.md"), contract = read("references/contract.md");
  assert.match(entry, /Withhold triggering closing references through review and merge/);
  assert.match(workflow, /Publish \*\*no triggering `Fixes`\/`Closes`\/`Resolves` references before landed-result tests pass and closure is authorized\*\*/);
  assert.match(workflow, /explicit acknowledgement agreeing to \*\*only the named reviewed head\/PR/);
  assert.match(workflow, /no cleanup\/restart\/deploy/);
  assert.match(workflow, /not called by this resolver/);
  assert.match(workflow, /actual starting tree contains its prerequisite fixes/);
  assert.match(workflow, /If base differs from landing and lacks those fixes, hold/);
  assert.match(workflow, /target verification alone is not an implementation baseline/);
  assert.match(workflow, /at most 2 repair cycles/i);
  assert.match(workflow, /--paginate --full/);
  assert.match(workflow, /PR 7 if it exists/);
  assert.match(workflow, /nondefault landing branch/);
  assert.match(contract, /pure.*helper|Pure helper/);
  assert.match(contract, /plan` rejects every request containing `resume`/);
});
