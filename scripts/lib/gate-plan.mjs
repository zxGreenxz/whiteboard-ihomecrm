import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import yaml from "js-yaml";
import { khopGlob, phanLoai } from "../check-risk-classifier.mjs";
import { isDeferredGate, isDeferredTest, DEFERRED_TEST_PATTERNS } from "./deferred-modules.mjs";
import { GATE_REGISTRY, GENERATOR_REGISTRY, SHARD_MIN_FILES, isOfflineBrowserSelection } from "./gate-registry.mjs";
import { indexInputConflicts } from "./local-gate-snapshot.mjs";

const riskDefault = JSON.parse(readFileSync(new URL("../../tooling/risk-map.json", import.meta.url), "utf8"));
const testsDefault = JSON.parse(readFileSync(new URL("../../tooling/test-matrix.json", import.meta.url), "utf8"));
const unique = (values) => [...new Set(values)].sort();
const matches = (path, patterns = []) => patterns.some((p) => khopGlob(path, p));
const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const printer = ts.createPrinter({ removeComments: true });
function source(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}
// Visibility, pointer events, positioning and arbitrary variants cannot prove cosmetic safety.
function safeClasses(text) {
  return text.split(/\s+/).filter(Boolean).every((c) => /^(?:(?:sm|md|lg|xl|2xl|hover|focus):)*(?:(?:p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy]|text|bg|border|rounded|font|leading|tracking|shadow)-[\w./#\[\]-]+|italic|not-italic)$/.test(c));
}
function cosmeticFingerprint(path, text) {
  const sf = source(path, text);
  if (sf.parseDiagnostics.length) return null;
  const icons = new Set();
  for (const s of sf.statements) if (ts.isImportDeclaration(s) && s.moduleSpecifier.text === "lucide-react") {
    const names = s.importClause?.namedBindings;
    if (!names || !ts.isNamedImports(names)) return null;
    for (const item of names.elements) icons.add(item.name.text);
  }
  const replacements = []; let unsafeIcon = false;
  const replace = (node, value) => replacements.push([node.getStart(sf), node.end, value]);
  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "lucide-react") { replace(node, "import {} from 'lucide-react';"); return; }
    if (ts.isJsxText(node)) { replace(node, "__text__"); return; }
    if (ts.isJsxAttribute(node) && node.name.text === "className" && node.initializer && ts.isStringLiteral(node.initializer) && safeClasses(node.initializer.text)) { replace(node.initializer, '"__class__"'); return; }
    if (ts.isIdentifier(node) && icons.has(node.text)) {
      const p = node.parent;
      const inTag = (ts.isJsxSelfClosingElement(p) || ts.isJsxOpeningElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node;
      const iconProperty = ts.isPropertyAssignment(p) && p.name.getText(sf) === "icon" && p.initializer === node;
      if (inTag || iconProperty) replace(node, "__Icon__"); else unsafeIcon = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (unsafeIcon) return null;
  let transformed = text;
  for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) transformed = transformed.slice(0, start) + value + transformed.slice(end);
  const normalized = source(path, transformed);
  return normalized.parseDiagnostics.length ? null : printer.printFile(normalized);
}
function cssFingerprint(text) {
  // Narrow simple rule blocks only. At-rules, selector changes and dynamic values escalate.
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@|url\s*\(/i.test(clean)) return null;
  const result = []; let offset = 0;
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (clean.slice(offset, m.index).trim()) return null;
    const declarations = m[2].split(";").filter((d) => d.trim()).map((d) => {
      const i = d.indexOf(":"); if (i < 0) return null;
      const key = d.slice(0, i).trim(); const value = d.slice(i + 1).trim();
      return /^(?:color|background-color|font-(?:size|weight|family)|line-height|letter-spacing|border(?:-(?:color|width|radius))?|(?:margin|padding)(?:-(?:top|right|bottom|left))?|gap)$/.test(key) && !/!important|url\s*\(/i.test(value) ? `${key}:__presentation__` : `${key}:${value}`;
    });
    if (declarations.includes(null)) return null;
    result.push([m[1].trim(), declarations]); offset = m.index + m[0].length;
  }
  return clean.slice(offset).trim() || !result.length ? null : JSON.stringify(result);
}
export function isCosmeticChange(change, riskMap = riskDefault) {
  if (change.status !== "M" || change.oldPath || typeof change.before !== "string" || typeof change.after !== "string" || !matches(change.path, riskMap.scope?.cosmeticPaths)) return false;
  const before = change.path.endsWith(".css") ? cssFingerprint(change.before) : cosmeticFingerprint(change.path, change.before);
  const after = change.path.endsWith(".css") ? cssFingerprint(change.after) : cosmeticFingerprint(change.path, change.after);
  return before !== null && after !== null && before === after;
}
function sensitiveBehavior(change, demo) {
  if (!/\.[cm]?[jt]sx?$|\.sql$/.test(change.path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(change.path)) return { money: false, auth: false };
  // Verifier fixtures/command names describe boundaries; they do not execute product writes.
  // Operational writers use explicit risk tiers or unknown/full coverage instead.
  if (!/^(?:src\/|api\/|supabase\/(?:functions|migrations)\/|public\/demos\/|worker\/)/.test(change.path)) return { money: false, auth: false };
  const names = [];
  const before = change.before ?? ""; const after = change.after ?? "";
  let start = 0; let tail = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (tail < Math.min(before.length, after.length) - start && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
  for (const text of [change.before, change.after]) {
    if (typeof text !== "string") continue;
    if (change.path.endsWith(".sql")) { names.push(text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "")); continue; }
    const sf = source(change.path, text); const end = text.length - tail;
    const intersects = (node) => node.end >= start && node.getStart(sf) <= end;
    function collect(node) { if (ts.isIdentifier(node) || ts.isStringLiteral(node)) names.push(node.text); ts.forEachChild(node, collect); }
    function walk(node) {
      if (!intersects(node)) return;
      // Include a changed call's callee when only an amount/permission argument changed.
      if (ts.isCallExpression(node)) { collect(node); return; }
      if (ts.isIdentifier(node) || ts.isStringLiteral(node)) names.push(node.text);
      ts.forEachChild(node, walk);
    }
    walk(sf);
  }
  const tokens = names.join(" ");
  const remote = /\b(?:supabase|fetch|rpc|XMLHttpRequest)\b/.test(tokens);
  const money = /(?:save|record|post|approve|cancel|delete|update|create|pay|reverse|settle|transfer)[_A-Z-]*(?:payment|invoice|voucher|income[_-]?expense|cashbook|salary|deposit)|\b(?:income_expenses|cash_books|invoice_payments|financial_requests|ledger_entries|reconcile_money)\b/i.test(tokens);
  const auth = /\b(?:policy|security\s+definer|auth\.uid|RequirePermission|can_access_building|organization_id|authorize|jwt|service_role|permission)\b/i.test(tokens);
  return { money: money && (!demo || remote), auth: auth && !demo };
}
const owned = (file, suite) => !isDeferredTest(file) && matches(file, suite.includes) && !matches(file, suite.excludes);

/** Pure selection; snapshots and manifests in, serializable obligations out. */
export function createGatePlan({ changes = [], snapshot, full = false, environment = "local", riskMap = riskDefault, testMatrix = testsDefault, registry = GATE_REGISTRY, testFiles = [], trackedPaths = [], digests = {} } = {}) {
  if (!snapshot?.head || !snapshot?.tree) throw new Error("A verified snapshot head and tree are required");
  if (!riskMap.scope || !riskMap.gateProfiles || !Array.isArray(testMatrix.sourceSelectionRules)) throw new Error("Scope policy is missing or invalid");
  const profiles = new Set(); const reasons = [];
  const paths = unique(changes.flatMap((c) => [c.path, c.oldPath].filter(Boolean)).map((p) => p.replace(/\\/g, "/")));
  const gates = new Set(["secret-scan"]); const generators = new Set(); const matchedRules = new Set(); const directTests = new Set(); const offlinePaths = new Set();
  let fullFallback = full || snapshot.source === "unknown-base"; let money = false; let auth = false; let tierReview = false;
  const add = (profile, path, reason) => { profiles.add(profile); reasons.push({ path, profile, reason }); };
  if (fullFallback) add("shared-tooling", null, full ? "explicit --full" : "No verified diff base; full active fallback");
  for (const c of changes) {
    const both = [c.path, c.oldPath].filter(Boolean);
    if (isDeferredTest(c.path) && !c.oldPath) { reasons.push({ path: c.path, profile: "deferred", reason: "DEFERRED test; not executed or counted as passed" }); continue; }
    const tiers = phanLoai(both, riskMap.tiers);
    tierReview ||= tiers.crossReview;
    const schema = both.some((p) => matches(p, riskMap.scope.schemaPaths));
    const shared = both.some((p) => matches(p, riskMap.scope.sharedPaths));
    const documentation = !schema && !shared && both.every((p) => matches(p, riskMap.scope.docsPaths));
    const cosmetic = !schema && !shared && isCosmeticChange(c, riskMap);
    const demo = both.every((p) => matches(p, riskMap.scope.demoPaths));
    const behavior = cosmetic || documentation ? { money: false, auth: false } : sensitiveBehavior(c, demo);
    const isMoney = !cosmetic && !documentation && (tiers.theoTier.has("money") || behavior.money);
    const isAuth = !cosmetic && !documentation && (tiers.theoTier.has("authorization") || behavior.auth);
    money ||= isMoney; auth ||= isAuth;
    if (schema) add("schema", c.path, "Schema/evidence path: preserve migration and live boundaries");
    if (isMoney || isAuth) add("money-auth", c.path, isMoney ? "Financial path or executable payment behavior" : "Authorization path or executable authorization boundary");
    if (shared) { fullFallback = true; add("shared-tooling", c.path, "Shared core/runtime/lock/policy changes invalidate scoped coverage"); }
    else if (cosmetic) add("cosmetic-ui", c.path, "AST presentation whitelist; other executable structure is identical");
    else if (both.every((p) => matches(p, riskMap.scope.docsPaths)) && !schema) add("docs-only", c.path, "Documentation-only inputs");
    else if (!schema) add(both.some((p) => matches(p, riskMap.scope.uiPaths)) ? "ui-behavior" : "logic", c.path, "Executable or interaction change");
    const rules = documentation ? [] : testMatrix.sourceSelectionRules.filter((r) => both.some((p) => matches(p, r.sourcePaths)));
    for (const rule of rules) matchedRules.add(rule);
    if (!schema && !shared && !isMoney && !isAuth && both.every((path) => rules.some((rule) => rule.ciSafe === true && matches(path, rule.sourcePaths) && testMatrix.suites.some((suite) => suite.id === rule.suiteId && suite.runner === "playwright")))) offlinePaths.add(c.path);
    const ownSuite = testMatrix.suites.find((s) => s.status !== "deferred" && owned(c.path, s));
    if (ownSuite) directTests.add(c.path);
    let siblingTest = false;
    if (/^scripts\/[^/]+\.mjs$/.test(c.path)) {
      const sibling = c.path.replace(/^scripts\//, "scripts/__tests__/").replace(/\.mjs$/, ".test.mjs");
      if (testFiles.includes(sibling)) { directTests.add(sibling); siblingTest = true; }
    }
    const known = schema || shared || cosmetic || isMoney || isAuth || rules.length || ownSuite || siblingTest || both.every((p) => matches(p, riskMap.scope.docsPaths));
    if (!known) { fullFallback = true; add("shared-tooling", c.path, "Unknown source/dependency mapping; full active fallback"); }
    if (/^(?:A|D|R|C)/.test(c.status ?? "") || both.some((p) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p))) generators.add("generate-repository-inventory");
  }
  if (!profiles.size && !changes.length) reasons.push({ path: null, profile: "none", reason: "Verified empty diff; only invariant evidence is required" });
  // Offline source and its spec contribute their own browser suite, not app-wide
  // profile gates. Other files in a mixed diff still contribute their full profile.
  for (const p of profiles) if (reasons.some((r) => r.profile === p && !offlinePaths.has(r.path))) for (const id of riskMap.gateProfiles[p] ?? []) gates.add(id);
  if (money) { gates.add("reconcile-money"); gates.add("reconcile-money-v2"); }
  if (auth) gates.add("check-definer-body-authz");
  if (changes.some((c) => /^[AR]/.test(c.status ?? "") && /^src\/.*\.[jt]sx?$/.test(c.path))) {
    gates.add("check-new-modules-strict"); gates.add("check-strict-islands");
  }
  if (profiles.has("schema") || paths.some((p) => matches(p, riskMap.scope.realtimePaths) && !/\.md$/.test(p))) gates.add("check-realtime-descriptors");
  if (profiles.has("schema")) for (const id of ["gen-supabase-types", "normalize-supabase-types", "generate-rpc-surface", "generate-edge-surface", "generate-realtime-surface"]) generators.add(id);
  if (paths.some((p) => /^(?:docs\/|docs-site\/)|\.md$/.test(p)) || generators.has("generate-repository-inventory") || paths.some((p) => /^tooling\/|baseline\.json$/.test(p))) {
    for (const id of ["generate-docs-views", "check-doc-counts", "check-baseline-doc"]) generators.add(id);
    for (const id of riskMap.gateProfiles["docs-only"]) gates.add(id);
  }
  if (paths.some((p) => p.startsWith("docs-site/") || p.startsWith("docs/huong-dan-su-dung/"))) gates.add("docs-build");
  const affectsApp = paths.some((p) => /^src\//.test(p) || (p.startsWith("public/") && !p.startsWith("public/demos/")));
  if (!fullFallback && !affectsApp) {
    for (const id of ["app-build", "bundle-inventory", "check-ts-baseline", "check-strict-islands", "check-new-modules-strict"]) gates.delete(id);
  }
  if (offlinePaths.size) reasons.push({ path: null, profile: "ui-behavior", reason: "Offline demo source/spec scope contributes selected browser interaction; other changed files retain their own gates" });
  if (fullFallback) for (const [id, gate] of Object.entries(registry)) if (!id.startsWith("suite:") && gate.evidenceClass !== "live" && !isDeferredGate(id)) gates.add(id);
  for (const rule of testMatrix.sourceSelectionRules) if ((rule.profiles ?? []).some((p) => profiles.has(p))) matchedRules.add(rule);
  const suiteSelections = []; const browserRequirements = []; const unavailable = []; const external = new Map();
  const requireExternal = (workflow, suite, jobs) => {
    if (!external.has(workflow)) external.set(workflow, { workflow, jobs: [], suiteIds: [] });
    const item = external.get(workflow);
    item.jobs = unique([...item.jobs, ...jobs]); item.suiteIds = unique([...item.suiteIds, suite.id]);
  };
  for (const suite of testMatrix.suites.filter((s) => s.status !== "deferred")) {
    let rules = [...matchedRules].filter((r) => r.suiteId === suite.id);
    if (suite.workflowOwner && suite.workflowOwner !== ".github/workflows/ci-gates.yml") {
      if (rules.length || [...directTests].some((f) => owned(f, suite))) requireExternal(suite.workflowOwner, suite, (suite.ciJobs ?? []).filter((j) => j.workflow === suite.workflowOwner).map((j) => j.job));
      continue;
    }
    for (const rule of rules.filter((r) => r.workflowOwner && r.workflowOwner !== ".github/workflows/ci-gates.yml")) requireExternal(rule.workflowOwner, suite, rule.jobs ?? []);
    rules = rules.filter((r) => !r.workflowOwner || r.workflowOwner === ".github/workflows/ci-gates.yml");
    const all = fullFallback && suite.runner !== "playwright" && suite.workflowOwner === ".github/workflows/ci-gates.yml";
    let files = unique(testFiles.filter((f) => owned(f, suite) && (all || directTests.has(f) || rules.some((r) => matches(f, r.testPatterns)))));
    if (suite.id === "node-native") files = files.filter((f) => !f.includes("/network-center-"));
    if (!files.length) { if (rules.length) unavailable.push({ suiteId: suite.id, reason: "Selected mapping has no owned active tests" }); continue; }
    const selection = { id: suite.id, runner: suite.runner, files, mode: all ? "all" : "targeted", reason: all ? "Full active fallback" : rules.map((r) => r.id).join(", ") || "Changed owned test", viewports: unique(rules.flatMap((r) => r.viewports ?? [])) };
    suiteSelections.push(selection);
    if (suite.runner === "playwright") {
      browserRequirements.push({ suiteId: suite.id, files, viewports: selection.viewports.length ? selection.viewports : ["affected"], reason: selection.reason });
      if (!isOfflineBrowserSelection(suite.id, files)) { unavailable.push({ suiteId: suite.id, reason: "Live browser evidence requires affected preview/role; not default CI pass" }); continue; }
    }
    const id = `suite:${suite.id}`;
    // CI only: parallel parts of one large selection; every part stays a required gate.
    const shards = environment === "ci" && files.length >= SHARD_MIN_FILES ? Object.values(registry).filter((gate) => gate.shardOf === id) : [];
    if (shards.length) for (const gate of shards) gates.add(gate.id);
    else if (registry[id]) gates.add(id); else unavailable.push({ suiteId: suite.id, reason: "Runner belongs to a separate workflow" });
  }
  const manualUiPaths = unique(reasons.filter((r) => r.path && !offlinePaths.has(r.path) &&
    (["cosmetic-ui", "ui-behavior"].includes(r.profile) || (r.profile === "shared-tooling" && matches(r.path, riskMap.scope.uiPaths))))
    .map((r) => r.path).filter((path) => !testMatrix.sourceSelectionRules.some((rule) => matches(path, rule.sourcePaths) && browserRequirements.some((b) => b.suiteId === rule.suiteId))));
  if (manualUiPaths.length) {
    const responsive = changes.some((c) => manualUiPaths.includes(c.path) && (c.path.startsWith('src/components/ui/') || /(?:sm|md|lg|xl|2xl):|@media/.test((c.before ?? '') + (c.after ?? ''))));
    browserRequirements.push({ status: "required", suiteId: null, files: [], paths: manualUiPaths, viewports: responsive ? ["desktop", "mobile"] : ["affected"], reason: "Verify the affected UI viewport and console; no automatic browser spec mapped for these paths" });
  }
  const gateIds = unique([...gates].filter((id) => !isDeferredGate(id)));
  for (const id of gateIds) if (!registry[id]) throw new Error(`Gate policy refers to unknown command: ${id}`);
  const inputPatterns = unique(gateIds.flatMap((id) => registry[id].inputs ?? []));
  return { schemaVersion: 1, snapshot, environment, profiles: [...profiles].sort(), reasons, changedPaths: paths,
    gateIds, suiteSelections, generatorIds: Object.keys(GENERATOR_REGISTRY).filter((id) => generators.has(id)), requiredJobs: unique(gateIds.map((id) => registry[id].job).filter(Boolean)),
    deferred: [...DEFERRED_TEST_PATTERNS], inputPatterns, inputPaths: unique([...paths, ...trackedPaths.filter((p) => matches(p, inputPatterns)), ...suiteSelections.flatMap((s) => s.files)]), fullFallback,
    crossReview: tierReview || profiles.has("schema") || profiles.has("money-auth") || profiles.has("shared-tooling"), browserRequirements, unavailable, requiredExternalWorkflows: [...external.values()], executionMismatches: [],
    policyDigest: digests.policyDigest ?? digest({ riskMap, testMatrix }), runtimeDigest: digests.runtimeDigest ?? digest({ fixture: true }), inputDigest: digests.inputDigest ?? digest({ snapshot, changes }) };
}

function parseChanges(raw) {
  const tokens = raw.split("\0"); const changes = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    if (/^[RC]/.test(status)) { const oldPath = tokens[i++]; const path = tokens[i++]; changes.push({ status, oldPath, path }); }
    else changes.push({ status, path: tokens[i++] });
  }
  return changes;
}
/** Index only locally; explicit event before/after for commit scope. */
export function planFromGit({ root, mode = "staged", base, head = "HEAD", full = false, environment = "local" } = {}) {
  if (!root || !["staged", "commit"].includes(mode)) throw new Error("root and a valid snapshot mode are required");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const resolve = (ref) => git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const target = resolve(head);
  if (environment === "ci" && target !== resolve("HEAD")) throw new Error("CI checkout bytes do not belong to requested SHA");
  const from = mode === "staged" ? resolve(base ?? "HEAD") : base ? resolve(base) : null;
  const tree = mode === "staged" ? git("write-tree").trim() : git("rev-parse", `${target}^{tree}`).trim();
  const snapshot = { base: from, head: target, tree, source: mode === "staged" ? "index" : from ? "commit-range" : "unknown-base" };
  const entries = git("ls-tree", "-rz", tree).split("\0").filter(Boolean).map((line) => { const at = line.indexOf("\t"); return { path: line.slice(at + 1), object: line.slice(0, at).split(" ")[2] }; });
  const read = (ref, path) => git("show", `${ref}:${path}`);
  const optionalRead = (ref, path) => { try { return read(ref, path); } catch { return null; } };
  const changes = from ? parseChanges(git("diff", "--name-status", "-z", "--find-renames", from, mode === "staged" ? tree : target, "--")) : [];
  for (const c of changes) { c.before = c.status === "A" ? "" : optionalRead(from, c.oldPath ?? c.path); c.after = c.status === "D" ? "" : optionalRead(tree, c.path); }
  const riskText = optionalRead(tree, "tooling/risk-map.json"); const matrixText = optionalRead(tree, "tooling/test-matrix.json");
  if (!riskText || !matrixText) throw new Error("Scope policy missing from the selected Git snapshot");
  const riskMap = JSON.parse(riskText); const testMatrix = JSON.parse(matrixText);
  const policyFiles = entries.filter((e) => matches(e.path, ["tooling/risk-map.json", "tooling/test-matrix.json", "tooling/deferred-modules.json", "scripts/lib/gate-*.mjs", "scripts/lib/deferred-modules.mjs", "scripts/check-risk-classifier.mjs", ".github/workflows/**", "package.json"]));
  const runtimeFiles = entries.filter((e) => matches(e.path, ["tooling/runtime-matrix.json", "**/package-lock.json", "**/deno.lock", "package.json", "**/package.json"]));
  const p = createGatePlan({ changes, snapshot, full, environment, riskMap, testMatrix, trackedPaths: entries.map((e) => e.path), testFiles: entries.map((e) => e.path).filter((f) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f)), digests: { policyDigest: digest(policyFiles), runtimeDigest: digest(runtimeFiles), inputDigest: digest(entries) } });
  for (const obligation of p.requiredExternalWorkflows) {
    const workflow = yaml.load(read(tree, obligation.workflow));
    obligation.jobIds = [...obligation.jobs];
    obligation.jobs = obligation.jobIds.map((id) => {
      if (!workflow?.jobs?.[id]) throw new Error(`Missing required external job ${obligation.workflow}/${id}`);
      const name = workflow.jobs[id].name ?? id;
      if (typeof name !== 'string' || name.includes('${{')) throw new Error(`Dynamic external job name requires explicit evidence mapping: ${id}`);
      return name;
    });
  }
  const stagedAgainstCommit = mode === 'commit' ? git('diff', '--cached', '--name-only', '-z', target).split('\0').filter(Boolean) : [];
  p.executionMismatches = unique([...indexInputConflicts(root, [...p.inputPatterns, ...p.inputPaths]), ...stagedAgainstCommit]);
  return p;
}
