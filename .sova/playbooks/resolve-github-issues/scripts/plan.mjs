// Pure planning only. No filesystem, process, network, or mutation API.
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (s) => { throw new Error(s); };
const keys = (o, allowed, name) => {
  if (!object(o)) fail(`${name} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`unknown ${name} field: ${k}`);
};
const integer = (v, name, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < 1 || v > max) fail(`${name} must be a positive integer <= ${max}`);
  return v;
};
const text = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v !== v.trim() || /[\x00-\x1f\x7f]/.test(v)) fail(`${name} must be nonempty trimmed text`);
  return v;
};
const repoName = (v) => {
  text(v, "repo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) || v.split("/").some((p) => p === "." || p === "..")) fail("repo must be OWNER/NAME");
  return v.toLowerCase();
};
const branch = (v, name) => {
  text(v, name);
  if (v.startsWith("-") || v.startsWith("/") || v.endsWith("/") || v.endsWith(".") || /[ ~^:?*\[\\]/.test(v) || v.includes("..") || v.includes("@{") || v.includes("//") || v === "@" || v.split("/").some((p) => p.startsWith(".") || p.endsWith(".lock"))) fail(`${name} must be a plain branch name`);
  return v;
};
const numbers = (v, name) => {
  if (!Array.isArray(v)) fail(`${name} must be a list`);
  return [...new Set(v.map((n) => integer(n, name)))].sort((a, b) => a - b);
};
const strings = (v, name) => {
  if (!Array.isArray(v)) fail(`${name} must be a list`);
  return [...new Set(v.map((s) => text(s, name)))].sort();
};

/** Empty message -> {}; otherwise JSON only. No guessed natural-language targets. */
export function parseRequest(value = {}) {
  const raw = typeof value === "string" ? (value.trim() ? JSON.parse(value) : {}) : value;
  keys(raw, ["repo", "base", "landing", "issues", "parent", "filters", "batchSize", "maxBatches", "landingMode", "resume"], "request");
  const filters = raw.filters === undefined ? {} : raw.filters;
  keys(filters, ["labels", "assignee", "author", "milestone"], "filters");
  if (raw.issues !== undefined && raw.parent !== undefined) fail("issues and parent are mutually exclusive");
  if ((raw.issues !== undefined || raw.parent !== undefined) && Object.keys(filters).length) fail("filters cannot prune explicit issues or a parent tree");
  const issues = raw.issues === undefined ? undefined : numbers(raw.issues, "issues");
  if (issues && !issues.length) fail("issues cannot be empty");
  const landingMode = raw.landingMode === undefined ? "pr" : raw.landingMode;
  if (!["pr", "handoff"].includes(landingMode)) fail("landingMode must be pr or handoff");
  const resume = raw.resume === undefined ? undefined : text(raw.resume, "resume");
  if (resume && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(resume)) fail("resume must be a local run id, not a path");
  if (resume && Object.keys(raw).some((k) => k !== "resume")) fail("resume cannot change the saved request");
  return {
    ...(raw.repo !== undefined ? { repo: repoName(raw.repo) } : {}),
    ...(raw.base !== undefined ? { base: branch(raw.base, "base") } : {}),
    ...(raw.landing !== undefined ? { landing: branch(raw.landing, "landing") } : {}),
    ...(issues ? { issues } : {}),
    ...(raw.parent !== undefined ? { parent: integer(raw.parent, "parent") } : {}),
    filters: {
      ...(filters.labels !== undefined ? { labels: strings(filters.labels, "labels") } : {}),
      ...Object.fromEntries(["assignee", "author", "milestone"].filter((k) => filters[k] !== undefined).map((k) => [k, text(filters[k], k)])),
    },
    batchSize: integer(raw.batchSize === undefined ? 3 : raw.batchSize, "batchSize", 5),
    maxBatches: integer(raw.maxBatches === undefined ? 2 : raw.maxBatches, "maxBatches", 5),
    landingMode,
    ...(resume ? { resume } : {}),
  };
}

/** Input is the agent's normalized, fully paginated snapshot (contract.md), not raw CLI output.
 * `complete` is a declaration, not proof: the agent must reconcile its page ledger. */
export function plan(snapshot, input = {}) {
  const request = parseRequest(input);
  if (request.resume) fail("resume requires a validated saved run; pure plan cannot resume");
  keys(snapshot, ["repo", "defaultBranch", "branches", "landingBranch", "landingSha", "complete", "issues"], "snapshot");
  if (snapshot.complete !== true) fail("inventory is incomplete");
  const repo = repoName(snapshot.repo);
  if (request.repo && request.repo !== repo) fail("snapshot repo differs from request");
  const defaultBranch = branch(snapshot.defaultBranch, "defaultBranch");
  const branches = strings(snapshot.branches, "branches").map((b) => branch(b, "branch"));
  if (!branches.includes(defaultBranch)) fail("default branch missing from verified branch inventory");
  const base = request.base ?? defaultBranch;
  const landing = request.landing ?? defaultBranch;
  for (const b of [base, landing]) if (!branches.includes(b)) fail(`missing branch: ${b}`);
  if (snapshot.landingBranch !== landing) fail("snapshot verification target differs from selected landing");
  if (typeof snapshot.landingSha !== "string" || !/^[0-9a-f]{40}$/.test(snapshot.landingSha)) fail("landingSha must be an exact remote commit SHA");
  if (!Array.isArray(snapshot.issues) || snapshot.issues.length > 10_000) fail("issues must be a complete list of at most 10000 rows");
  const rows = new Map();
  for (const raw of snapshot.issues) {
    keys(raw, ["number", "state", "labels", "assignees", "author", "milestone", "children", "dependencies", "externalPrerequisites", "verified", "verifiedAt"], "issue");
    const number = integer(raw.number, "issue number");
    if (!["open", "closed"].includes(raw.state)) fail(`invalid state: ${number}`);
    if (typeof raw.verified !== "boolean") fail(`verified must be explicit: ${number}`);
    if (raw.verified ? raw.verifiedAt !== snapshot.landingSha : raw.verifiedAt !== null) fail(`verification must be bound to selected landing SHA (or null when unverified): ${number}`);
    const externalPrerequisites = strings(raw.externalPrerequisites, "externalPrerequisites").map((ref) => {
      const m = /^([^#]+)#([1-9][0-9]*)$/.exec(ref);
      if (!m) fail("external prerequisite must be OWNER/NAME#number");
      const other = repoName(m[1]);
      const n = integer(Number(m[2]), "external issue number");
      if (other === repo) fail("same-repo prerequisite must be a numeric graph edge");
      return `${other}#${n}`;
    });
    const row = { number, state: raw.state, labels: strings(raw.labels, "labels"), assignees: strings(raw.assignees, "assignees"), author: text(raw.author, "author"), milestone: raw.milestone === null ? null : text(raw.milestone, "milestone"), children: numbers(raw.children, "children"), dependencies: numbers(raw.dependencies, "dependencies"), externalPrerequisites: [...new Set(externalPrerequisites)].sort(), verified: raw.verified, verifiedAt: raw.verifiedAt };
    if (rows.has(number) && JSON.stringify(rows.get(number)) !== JSON.stringify(row)) fail(`conflicting inventory rows: ${number}`);
    rows.set(number, row);
  }
  // All known graph edges must resolve, even if a missing dependency isn't selected.
  for (const row of rows.values()) for (const n of [...row.children, ...row.dependencies]) if (!rows.has(n)) fail(`missing issue ${n} referenced by ${row.number}`);
  const edges = (n) => [...new Set([...rows.get(n).dependencies, ...rows.get(n).children])].sort((a, b) => a - b);
  const visited = new Set(), active = new Set(), order = [];
  const visit = (n) => {
    if (active.has(n)) fail(`dependency/subissue cycle at ${n}`);
    if (visited.has(n)) return;
    active.add(n);
    for (const d of edges(n)) visit(d);
    active.delete(n); visited.add(n); order.push(n);
  };
  for (const n of [...rows.keys()].sort((a, b) => a - b)) visit(n);
  const selected = new Set();
  const requireIssue = (n) => { if (!rows.has(n)) fail(`missing selected issue: ${n}`); };
  if (request.parent !== undefined) {
    const collect = (n) => { requireIssue(n); if (selected.has(n)) return; selected.add(n); for (const c of rows.get(n).children) collect(c); };
    collect(request.parent);
  } else if (request.issues) {
    for (const n of request.issues) { requireIssue(n); selected.add(n); }
  } else {
    const f = request.filters;
    for (const row of rows.values()) if (row.state === "open" && (!f.labels || f.labels.every((s) => row.labels.includes(s))) && (!f.assignee || row.assignees.includes(f.assignee)) && (!f.author || row.author === f.author) && (!f.milestone || row.milestone === f.milestone)) selected.add(row.number);
  }
  const context = [...selected].filter((n) => rows.get(n).state === "closed").sort((a, b) => a - b);
  if (request.issues && context.length) fail("explicit issues must be open; closed targets need a separate verification request");
  if (request.parent !== undefined && rows.get(request.parent).state !== "open") fail("parent must be open");
  const open = new Set([...selected].filter((n) => rows.get(n).state === "open"));
  const blockers = new Map();
  for (const n of order.filter((n) => open.has(n))) {
    const bad = [...edges(n).filter((d) => !rows.get(d).verified && (rows.get(d).state === "closed" || !open.has(d) || blockers.has(d))), ...rows.get(n).externalPrerequisites];
    if (bad.length) blockers.set(n, bad);
  }
  const eligible = order.filter((n) => open.has(n) && !blockers.has(n));
  const batches = [];
  for (let i = 0; i < eligible.length && batches.length < request.maxBatches; i += request.batchSize) batches.push(eligible.slice(i, i + request.batchSize));
  return { repo, defaultBranch, base, landing, landingSha: snapshot.landingSha, landingMode: request.landingMode, selected: [...open].sort((a, b) => a - b), context, batches, deferred: eligible.slice(request.batchSize * request.maxBatches), blockers: [...blockers].map(([issue, prerequisites]) => ({ issue, prerequisites })) };
}
