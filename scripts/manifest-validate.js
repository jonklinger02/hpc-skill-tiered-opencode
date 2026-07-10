#!/usr/bin/env node
/**
 * manifest-validate.js — Validation gates for manifest artifacts
 * 
 * Usage:
 *   node manifest-validate.js --gate <1|2|3> --manifest-dir <dir> [--prd <file>]
 * 
 * Returns "ok" or "err:[list of failures]"
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const structure = require("./lib/structure.js");

// Load a YAML file and return the parsed object, or null on parse failure.
// Used for structured access (e.g. contract `surface:` array of objects,
// task `contracts_consumed:` list of {contract_id, invokes} objects).
// The regex-based extractField/extractArray below handle the flat-scalar
// cases that the original gates relied on.
function loadYAML(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

// Normalize a contract's `contracts_consumed` / `contracts_produced` array.
// Accepts both the legacy flat-string form and the new structured form, and
// always returns an array of {contract_id, invokes, implements} objects.
//
// Legacy form:
//   contracts_consumed:
//     - CONTRACT-DB-02
//     - CONTRACT-USER-001
//
// New (binding) form:
//   contracts_consumed:
//     - contract_id: "CONTRACT-DB-02"
//       invokes: ["JobStore.list", "JobStore.get"]
// Virtual (pseudo) contracts: referenced in contracts_consumed for guidance but
// NOT real producer/consumer code contracts — they have no contract file, no
// producer task, and no binding surface. MODULE-PATHS-MANIFEST (plan §1.6) maps
// to manifest/module-paths.yaml and is consumed-only (workers consult it for
// import paths). Validators skip existence + symmetry + surface checks for these.
const VIRTUAL_CONTRACTS = new Set(["MODULE-PATHS-MANIFEST"]);
function isVirtualContract(id) { return VIRTUAL_CONTRACTS.has(id); }

function normalizeContractRefs(value, key) {
  if (!Array.isArray(value)) return [];
  return value.map(entry => {
    if (typeof entry === "string") {
      // Legacy form — surface symbol set unspecified
      return { contract_id: entry, invokes: [], implements: [], _legacy: true };
    }
    if (entry && typeof entry === "object") {
      return {
        contract_id: entry.contract_id || entry.id || null,
        invokes: Array.isArray(entry.invokes) ? entry.invokes : [],
        implements: Array.isArray(entry.implements) ? entry.implements : [],
        _legacy: false,
      };
    }
    return { contract_id: null, invokes: [], implements: [], _legacy: false };
  }).filter(r => r.contract_id);
}

// Extract the symbol name set declared in a contract's `surface:` block.
// Returns a Set of symbol names. Each `surface[]` entry must have a `name`.
function contractSurfaceNames(contractDoc) {
  if (!contractDoc || !Array.isArray(contractDoc.surface)) return null;
  const names = new Set();
  for (const entry of contractDoc.surface) {
    if (entry && typeof entry === "object" && typeof entry.name === "string") {
      const full = entry.name;
      names.add(full);
      // Add bare-name alias for METHOD/ENDPOINT entries so consumers can
      // declare `invokes: ["foo"]` against a surface that lists
      // `foo(a: int) -> Bar`. Strip arg list and HTTP-verb prefix.
      const m = /^([A-Z]+\s+)?([A-Za-z_./][A-Za-z0-9_./]*)/.exec(full);
      if (m && m[2] && m[2] !== full) names.add(m[2]);
    }
  }
  return names;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--gate": parsed.gate = parseInt(args[++i]); break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--prd": parsed.prd = args[++i]; break;
      // M1 plan-completeness mode. Opt-in: without --completeness, Gate 1
      // behaves exactly as before (preserves supervised mode + existing tests).
      case "--completeness": parsed.completeness = true; break;
      case "--deferred-scope": parsed.deferredScope = args[++i]; break;
      case "--acceptance-criteria": parsed.acceptanceCriteria = args[++i]; break;
      // M2 §2.5: empty contracts_produced on a task in a multi-file module
      // becomes a Gate 3 failure (default is a non-blocking coverage_gap report).
      case "--strict-coverage": parsed.strictCoverage = true; break;
    }
  }
  return parsed;
}

// Simple YAML field extractor (avoids dependency on yaml parser)
function extractField(content, field) {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = content.match(regex);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

function extractArray(content, field) {
  const stripComment = (s) => s.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  // Inline form: `field: [a, b, c]` or `field: ["a", "b"]`
  const inlineRe = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]\\s*(?:#.*)?$`, "m");
  const inlineMatch = content.match(inlineRe);
  if (inlineMatch) {
    const inner = inlineMatch[1].trim();
    if (inner === "") return [];
    return inner.split(",").map(s => stripComment(s)).filter(Boolean);
  }
  // Block form: `field:\n  - a\n  - b` (with optional inline `# comment`)
  const regex = new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s*.+\\n?)*)`, "m");
  const match = content.match(regex);
  if (!match) return [];
  return (match[1].match(/^\s+-\s*.+/gm) || [])
    .map(l => stripComment(l.replace(/^\s+-\s*/, "")))
    .filter(Boolean);
}

function loadYAMLFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".yaml"))
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(dir, f), "utf-8"),
    }));
}

// ── M1 plan-completeness checks (opt-in via --completeness) ───────────────
//
// These enforce the structural-honesty guarantees the autonomous loop needs
// before freezing a manifest no human will review:
//   1.2 tech_stack present and non-empty
//   1.7 glue epic (E-GLUE-000) present when the stack declares a boot layer
//   1.4 every `deferred` council decision carries a deferral_disposition
//   1.8 deferred-scope entries are consistent with current-build outputs
//   1.9 acceptance-criteria.yaml is populated and classified
// All are skipped unless --completeness is passed, so the supervised path and
// the existing unit tests see Gate 1 exactly as it was.

const STACK_ROLES_REQUIRING_GLUE = new Set(["api_server", "web_ui", "ssr_app"]);

function normText(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Concatenated normalized text of every epic's human-facing fields, used as a
// tolerant haystack for the deferred-scope dependency-satisfiability check.
function epicCorpusText(epicsDir) {
  const out = [];
  for (const epic of loadYAMLFiles(epicsDir)) {
    const doc = loadYAML(path.join(epicsDir, epic.name)) || {};
    for (const k of ["name", "description", "suggested_future_epic"]) {
      if (doc[k]) out.push(normText(doc[k]));
    }
    for (const arrKey of ["acceptance_criteria", "functional_areas", "provides", "outputs"]) {
      if (Array.isArray(doc[arrKey])) out.push(doc[arrKey].map(normText).join(" "));
    }
  }
  return out.join("  ");
}

// Tolerant satisfiability: a dependency phrase is satisfied if its normalized
// form is a substring of the epic corpus, or ≥60% of its significant tokens
// (len ≥ 3) appear somewhere in the corpus.
function phraseSatisfiedBy(phrase, corpus) {
  const np = normText(phrase);
  if (!np) return true;
  if (corpus.includes(np)) return true;
  const toks = np.split(" ").filter(t => t.length >= 3);
  if (toks.length === 0) return corpus.includes(np);
  const hit = toks.filter(t => corpus.includes(t)).length;
  return hit / toks.length >= 0.6;
}

function loadDecisionEntries(manifestDir) {
  const delibDir = path.join(manifestDir, "deliberations");
  const entries = [];
  if (!fs.existsSync(delibDir)) return entries;
  for (const f of fs.readdirSync(delibDir)) {
    if (!f.endsWith(".yaml")) continue;
    const doc = loadYAML(path.join(delibDir, f));
    const log = doc && (doc.decisions_log || doc.decisions);
    if (Array.isArray(log)) {
      log.forEach((e, i) => entries.push({ file: f, idx: i, entry: e || {} }));
    }
  }
  return entries;
}

function runGate1Completeness(manifestDir, prdFile, opts) {
  const failures = [];
  const epicsDir = path.join(manifestDir, "epics");

  // 1.2 — tech_stack present and non-empty in manifest.yaml
  const manifestDoc = loadYAML(path.join(manifestDir, "manifest.yaml"));
  const techStack = manifestDoc && manifestDoc.tech_stack;
  const stackRoles = new Set();
  if (!Array.isArray(techStack) || techStack.length === 0) {
    failures.push("tech_stack missing or empty in manifest.yaml (C-Suite must declare it — see references/manifest-schema.md)");
  } else {
    for (const s of techStack) {
      if (s && typeof s === "object" && s.role) stackRoles.add(String(s.role));
    }
  }

  // 1.7 — glue epic required when the stack declares a boot layer
  const needsGlue = [...stackRoles].some(r => STACK_ROLES_REQUIRING_GLUE.has(r));
  if (needsGlue) {
    const glueDoc = loadYAML(path.join(epicsDir, "E-GLUE-000.yaml"));
    const glueAreas = glueDoc && glueDoc.functional_areas;
    if (!glueDoc) {
      failures.push("Glue epic E-GLUE-000 missing — tech_stack declares a boot layer (api_server/web_ui/ssr_app) that needs an owner (plan §1.7)");
    } else if (!Array.isArray(glueAreas) || glueAreas.length === 0) {
      failures.push("Glue epic E-GLUE-000 has no functional_areas — it must own the boot layer for the declared stack");
    }
  }

  // M2 §2.1/2.2 — boot_smoke is mandatory when the stack declares a runnable
  // surface. A required phase with no command is a manifest error caught here
  // (rather than surfacing as validation theater at Phase 3).
  const RUNNABLE_ROLES = new Set(["api_server", "web_ui", "ssr_app", "cli"]);
  if ([...stackRoles].some(r => RUNNABLE_ROLES.has(r))) {
    const bcFile = path.join(manifestDir, "build-commands.yaml");
    const bc = fs.existsSync(bcFile) ? fs.readFileSync(bcFile, "utf-8") : "";
    const bootCmd = bc.match(/^boot_smoke:\s*"?([^"\n]+?)"?\s*$/m);
    if (!fs.existsSync(bcFile) || !bootCmd || !bootCmd[1].trim()) {
      failures.push("build-commands.yaml is missing a boot_smoke command, but tech_stack declares a runnable surface (api_server/web_ui/ssr_app/cli) — boot_smoke is mandatory (plan §2.1)");
    }
  }

  // 1.4 — every `deferred` council decision carries a deferral_disposition
  for (const { file, idx, entry } of loadDecisionEntries(manifestDir)) {
    const status = String(entry.status || entry.disposition_status || "").toLowerCase();
    if (status === "deferred") {
      const disp = entry.deferral_disposition;
      const hasDisp = disp && (
        (typeof disp === "string" && disp.trim()) ||
        (typeof disp === "object" && (disp.generated_task || disp.waiver))
      );
      if (!hasDisp) {
        const label = entry.decision || entry.id || `#${idx}`;
        failures.push(`Deferred decision "${label}" in deliberations/${file} has no deferral_disposition (plan §1.4 — needs generated_task:<id> or waiver:<reason>)`);
      }
    }
  }

  // 1.9 — acceptance-criteria.yaml populated and classified
  const acFile = opts.acceptanceCriteria || path.join(manifestDir, "acceptance-criteria.yaml");
  const acDoc = loadYAML(acFile);
  const criteria = acDoc && acDoc.acceptance_criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    failures.push(`acceptance-criteria.yaml missing or empty (${acFile}) — run scripts/extract-acceptance.js (plan §1.9)`);
  }
  const acText = (Array.isArray(criteria) ? criteria : [])
    .map(c => normText(c && (c.text || "")) + " " + (Array.isArray(c && c.subcriteria) ? c.subcriteria.map(normText).join(" ") : ""))
    .join("  ");

  // 1.8 — deferred-scope consistency
  const dsFile = opts.deferredScope || path.join(manifestDir, "..", "input", "deferred-scope.yaml");
  const dsDoc = loadYAML(dsFile);
  if (!dsDoc || !Array.isArray(dsDoc.deferred_scope)) {
    failures.push(`deferred-scope.yaml missing or malformed (${dsFile}) — run scripts/corpus-filter.js (plan §1.1/§1.8)`);
  } else {
    const corpus = epicCorpusText(epicsDir);
    for (const d of dsDoc.deferred_scope) {
      const did = (d && d.id) || "DEFERRED-?";
      const deps = (d && Array.isArray(d.depends_on_current_build)) ? d.depends_on_current_build : [];
      for (const dep of deps) {
        if (!phraseSatisfiedBy(dep, corpus)) {
          failures.push(`${did}: depends_on_current_build "${dep}" is not satisfied by any current-build epic output (plan §1.8)`);
        }
      }
      // The deferred capability must NOT appear in any acceptance criterion —
      // if it does, it was wrongly classified as deferred (it's required).
      if (acText && d && d.summary) {
        const sumToks = normText(d.summary).split(" ").filter(t => t.length >= 5);
        const distinctive = sumToks.filter(t => acText.includes(t));
        if (sumToks.length > 0 && distinctive.length / sumToks.length >= 0.6) {
          failures.push(`${did}: deferred capability appears in current-build acceptance criteria — wrongly classified as deferred (plan §1.8)`);
        }
      }
    }
  }

  // 1.3 — report REQ-AUTO synthesis ratio (informational, non-blocking)
  if (prdFile && fs.existsSync(prdFile)) {
    const prd = fs.readFileSync(prdFile, "utf-8");
    const auto = new Set(prd.match(/REQ-AUTO-\d+/g) || []);
    const authored = new Set((prd.match(/REQ-\d+/g) || []));
    console.error(`info:REQ synthesis ratio — authored=${authored.size}, synthesized(REQ-AUTO)=${auto.size}`);
  }

  return failures;
}

function runGate1(manifestDir, prdFile, opts = {}) {
  const failures = [];
  const epicsDir = path.join(manifestDir, "epics");
  const epics = loadYAMLFiles(epicsDir);

  if (epics.length === 0) {
    failures.push("No epic files found in manifest/epics/");
    return failures;
  }

  // Check each epic has acceptance_criteria
  for (const epic of epics) {
    const epicId = extractField(epic.content, "epic_id");
    const criteria = extractArray(epic.content, "acceptance_criteria");
    if (criteria.length === 0) {
      failures.push(`${epicId || epic.name}: missing acceptance_criteria`);
    }
    const areas = extractArray(epic.content, "functional_areas");
    if (areas.length === 0) {
      failures.push(`${epicId || epic.name}: no functional_areas assigned`);
    }
  }

  // Check DAG acyclicity
  const dagFile = path.join(manifestDir, "dag-skeleton.yaml");
  if (fs.existsSync(dagFile)) {
    // Use dag.js for cycle detection
    const { execSync } = require("child_process");
    try {
      const result = execSync(
        `node ${path.join(__dirname, "dag.js")} --manifest-dir ${manifestDir} --check-cycles --level epic`,
        { encoding: "utf-8" }
      ).trim();
      if (result !== "ok") failures.push(`Epic DAG: ${result}`);
    } catch (e) {
      failures.push(`Epic DAG check failed: ${e.message}`);
    }
  }

  // Check PRD coverage if PRD provided
  if (prdFile && fs.existsSync(prdFile)) {
    const prdContent = fs.readFileSync(prdFile, "utf-8");
    // Extract requirement IDs (pattern: REQ-NNN, plus the REQ-AUTO-NNN ids
    // synthesized by inject-req-ids.js — both must be epic-covered)
    const reqIds = [...new Set((prdContent.match(/REQ-(?:AUTO-)?\d+/g) || []))];
    const coveredReqs = new Set();
    for (const epic of epics) {
      const refs = extractArray(epic.content, "prd_refs");
      refs.forEach(r => coveredReqs.add(r));
    }
    for (const req of reqIds) {
      if (!coveredReqs.has(req)) {
        failures.push(`PRD requirement ${req} not mapped to any epic`);
      }
    }
  }

  if (opts.completeness) {
    failures.push(...runGate1Completeness(manifestDir, prdFile, opts));
  }

  return failures;
}

function runGate2(manifestDir) {
  const failures = [];
  const groupsDir = path.join(manifestDir, "task-groups");
  const contractsDir = path.join(manifestDir, "contracts");
  const groups = loadYAMLFiles(groupsDir);
  const contracts = loadYAMLFiles(contractsDir);
  
  if (groups.length === 0) {
    failures.push("No task group files found");
    return failures;
  }

  // Build contract ID set + parse each contract structurally for the
  // `surface:` binding check.
  const contractIds = new Set();
  const contractDocs = {};  // contract_id -> parsed YAML doc
  for (const c of contracts) {
    const id = extractField(c.content, "contract_id");
    if (id) {
      contractIds.add(id);
      const doc = loadYAML(path.join(contractsDir, c.name));
      if (doc) contractDocs[id] = doc;
    }
  }

  // Binding check: every contract MUST declare a non-empty structured
  // `surface:` block. The `surface:` is what makes the contract binding;
  // without it, consumers can improvise method names and validators cannot
  // catch the drift. See SKILL.md "Picking the typecheck command" and
  // references/manifest-schema.md "Binding rule".
  for (const id of contractIds) {
    const doc = contractDocs[id];
    if (!doc) {
      failures.push(`Contract ${id}: YAML parse failure — cannot validate surface`);
      continue;
    }
    const names = contractSurfaceNames(doc);
    if (names === null) {
      failures.push(`Contract ${id}: missing required \`surface:\` block (binding-rule violation — see references/manifest-schema.md)`);
      continue;
    }
    if (names.size === 0) {
      failures.push(`Contract ${id}: \`surface:\` is empty — a contract must enumerate at least one symbol it exposes`);
      continue;
    }
    // Optional: warn if any surface entry lacks `signature` (advisory only)
    for (const entry of doc.surface) {
      if (entry && typeof entry === "object" && typeof entry.name === "string" && !entry.signature && !entry.fields && !entry.request) {
        // Advisory; not blocking. METHOD/ENDPOINT entries should have signature/request,
        // TYPE entries should have fields. CONST/EVENT entries may omit these.
      }
    }
  }

  // Check contract references exist
  for (const group of groups) {
    const groupId = extractField(group.content, "group_id");
    const produced = extractArray(group.content, "contracts_produced");
    const consumed = extractArray(group.content, "contracts_consumed");
    
    for (const item of [...produced, ...consumed]) {
      // extractArray mangles the structured form `- contract_id: "CONTRACT-X"`
      // into `contract_id: "CONTRACT-X` (only the trailing quote stripped) —
      // recover the id. Ignore continuation fields (e.g. `invokes:`) that leak in.
      const structured = item.match(/^contract_id:\s*["']?(.+?)["']?$/);
      const cid = structured ? structured[1] : item;
      if (!structured && /^[\w-]+:/.test(item)) continue;
      if (!contractIds.has(cid) && !isVirtualContract(cid)) {
        failures.push(`${groupId}: references non-existent contract ${cid}`);
      }
    }
  }

  // Check namespace uniqueness
  const namespaceOwners = {};
  const ownershipFile = path.join(manifestDir, "ownership.yaml");
  if (fs.existsSync(ownershipFile)) {
    const content = fs.readFileSync(ownershipFile, "utf-8");
    const claims = content.match(/path_pattern:\s*"?([^"\n]+)"?\s*\n\s*owning_area:\s*"?([^"\n]+)"?/g);
    if (claims) {
      for (const claim of claims) {
        const m = claim.match(/path_pattern:\s*"?([^"\n]+)"?\s*\n\s*owning_area:\s*"?([^"\n]+)"?/);
        if (m) {
          const [, ns, owner] = m;
          if (namespaceOwners[ns] && namespaceOwners[ns] !== owner) {
            failures.push(`Namespace ${ns} claimed by ${namespaceOwners[ns]} and ${owner}`);
          }
          namespaceOwners[ns] = owner;
        }
      }
    }
  }

  // Check DAG acyclicity
  const { execSync } = require("child_process");
  try {
    const result = execSync(
      `node ${path.join(__dirname, "dag.js")} --manifest-dir ${manifestDir} --check-cycles --level group`,
      { encoding: "utf-8" }
    ).trim();
    if (result !== "ok") failures.push(`Task group DAG: ${result}`);
  } catch (e) {
    failures.push(`Task group DAG check failed: ${e.message}`);
  }

  return failures;
}

function runGate3(manifestDir, opts = {}) {
  const failures = [];
  const tasksDir = path.join(manifestDir, "tasks");
  const contractsDir = path.join(manifestDir, "contracts");
  const tasks = loadYAMLFiles(tasksDir);
  const contracts = loadYAMLFiles(contractsDir);

  if (tasks.length === 0) {
    failures.push("No atomic task files found");
    return failures;
  }

  // Check file path uniqueness
  const filePaths = {};
  for (const task of tasks) {
    const taskId = extractField(task.content, "task_id");
    const filePath = extractField(task.content, "file_path");
    if (filePath) {
      if (filePaths[filePath]) {
        failures.push(`File path collision: ${filePath} claimed by ${filePaths[filePath]} and ${taskId}`);
      }
      filePaths[filePath] = taskId;
    }
  }

  // Check contract references exist + load contract surface for symmetry check
  const contractIds = new Set();
  const contractSurface = {};  // contract_id -> Set of declared symbol names
  for (const c of contracts) {
    const id = extractField(c.content, "contract_id");
    if (id) {
      contractIds.add(id);
      const doc = loadYAML(path.join(contractsDir, c.name));
      const names = contractSurfaceNames(doc);
      if (names) contractSurface[id] = names;
    }
  }

  const producedContracts = new Set();
  const consumedContracts = new Set();

  // Track invokes / implements per contract for the declaration-level
  // symmetry check below. Each entry: { taskId, symbols: [...] }.
  const invokesByContract = {};   // contract_id -> [{taskId, symbols}]
  const implementsByContract = {}; // contract_id -> [{taskId, symbols}]
  const legacyTasks = new Set();   // task_ids using the legacy flat-string contract form

  for (const task of tasks) {
    const taskId = extractField(task.content, "task_id");
    const taskDoc = loadYAML(path.join(tasksDir, task.name));
    const producedRefs = normalizeContractRefs(
      taskDoc && taskDoc.contracts_produced, "contracts_produced"
    );
    const consumedRefs = normalizeContractRefs(
      taskDoc && taskDoc.contracts_consumed, "contracts_consumed"
    );

    for (const ref of [...producedRefs, ...consumedRefs]) {
      if (!contractIds.has(ref.contract_id) && !isVirtualContract(ref.contract_id)) {
        failures.push(`${taskId}: references non-existent contract ${ref.contract_id}`);
      }
      if (ref._legacy) legacyTasks.add(taskId);
    }
    // Virtual contracts (e.g. MODULE-PATHS-MANIFEST) are consumed-only guidance
    // with no producer/surface — exclude from the symmetry index entirely.
    producedRefs.forEach(r => {
      if (isVirtualContract(r.contract_id)) return;
      producedContracts.add(r.contract_id);
      (implementsByContract[r.contract_id] ||= []).push({ taskId, symbols: r.implements });
    });
    consumedRefs.forEach(r => {
      if (isVirtualContract(r.contract_id)) return;
      consumedContracts.add(r.contract_id);
      (invokesByContract[r.contract_id] ||= []).push({ taskId, symbols: r.invokes });
    });
  }

  // Declaration-level binding symmetry check.
  // For every (consumer task, contract) pair: every symbol in `invokes` MUST
  // appear in some producer task's `implements` for the same contract.
  // For every contract: every entry in `surface:` MUST be claimed by at
  // least one producer task's `implements`.
  // This is the cheapest place to catch engineer-council drift — failures
  // here mean Director-tier did not align the contract surface across
  // producer/consumer expectations. See SKILL.md Gate 3.
  // Normalize symbols to bare-name form for tolerant matching:
  // surface "foo(x: int) -> Bar" matches consumer "foo" or producer
  // "foo(x: int) -> Bar" interchangeably. HTTP verb prefix stripped.
  function bareSym(s) {
    if (typeof s !== "string") return s;
    const m = /^([A-Z]+\s+)?([A-Za-z_./][A-Za-z0-9_./]*)/.exec(s);
    return m && m[2] ? m[2] : s;
  }
  function symKey(s) { return bareSym(s); }
  for (const [cid, consumers] of Object.entries(invokesByContract)) {
    const implementedBare = new Set();
    for (const p of implementsByContract[cid] || []) {
      p.symbols.forEach(s => implementedBare.add(symKey(s)));
    }
    const surfaceBare = new Set();
    for (const s of (contractSurface[cid] || [])) surfaceBare.add(symKey(s));
    for (const consumer of consumers) {
      for (const sym of consumer.symbols) {
        const key = symKey(sym);
        if (!implementedBare.has(key)) {
          failures.push(`${consumer.taskId}: invokes "${sym}" from ${cid} but no producer task implements it (binding-symmetry violation)`);
        }
        if (contractSurface[cid] && !surfaceBare.has(key)) {
          failures.push(`${consumer.taskId}: invokes "${sym}" from ${cid} but symbol is not in contract surface (improvisation forbidden — see SKILL.md "Binding rule")`);
        }
      }
    }
  }

  // Surface coverage: every symbol in `surface:` must be claimed by some producer.
  for (const [cid, surface] of Object.entries(contractSurface)) {
    const implementedBare = new Set();
    for (const p of implementsByContract[cid] || []) {
      p.symbols.forEach(s => implementedBare.add(symKey(s)));
    }
    // Dedup surface by bare-name so we don't flag both the full signature
    // and the synthetic bare alias.
    const surfaceUnique = new Set();
    for (const s of surface) surfaceUnique.add(symKey(s));
    for (const sym of surfaceUnique) {
      if (!implementedBare.has(sym)) {
        failures.push(`Contract ${cid}: surface symbol "${sym}" has no producer task (binding-symmetry violation — assign a task to implement it)`);
      }
    }
  }

  // Orphan-contract checks emit warnings, not failures — they indicate
  // possible omissions in engineer-tier outputs but do not block execution
  // (the execution phase writes files; orphan contracts are informational).
  let orphanCount = 0;
  for (const cid of contractIds) {
    if (!producedContracts.has(cid) && !consumedContracts.has(cid)) orphanCount++;
    else if (!producedContracts.has(cid)) orphanCount++;
    else if (!consumedContracts.has(cid)) orphanCount++;
  }
  if (orphanCount > 0) {
    console.error(`warn:${orphanCount} orphan-contract advisories (not blocking)`);
  }
  if (legacyTasks.size > 0) {
    console.error(`warn:${legacyTasks.size} task(s) using legacy flat-string contracts_consumed/produced form — upgrade to structured {contract_id, invokes/implements} per references/manifest-schema.md`);
  }

  // M2 §2.5 — coverage_gap. Count tasks whose contracts_produced is empty
  // (their output is outside the contract-integrity guarantee). Default:
  // non-blocking, reported in the summary. With --strict-coverage, an empty
  // contracts_produced is a Gate 3 failure for any task whose file_path lives
  // in a "multi-file module" — a directory that more than one task writes into
  // (the case where unguarded outputs cause cross-file integration drift).
  const dirCounts = {};   // dir -> number of task file_paths
  const taskFiles = [];   // { taskId, filePath, producedEmpty }
  for (const task of tasks) {
    const taskDoc = loadYAML(path.join(tasksDir, task.name));
    const taskId = extractField(task.content, "task_id");
    const filePath = (taskDoc && taskDoc.file_path) || extractField(task.content, "file_path");
    if (!filePath) continue;
    const produced = normalizeContractRefs(taskDoc && taskDoc.contracts_produced, "contracts_produced");
    const dir = path.dirname(filePath);
    dirCounts[dir] = (dirCounts[dir] || 0) + 1;
    taskFiles.push({ taskId, filePath, producedEmpty: produced.length === 0 });
  }
  const coverageGap = taskFiles.filter(t => t.producedEmpty).length;
  if (coverageGap > 0) {
    console.error(`warn:coverage_gap=${coverageGap} task(s) declare no contracts_produced (outputs outside the integrity guarantee)`);
  }
  if (opts.strictCoverage) {
    for (const t of taskFiles) {
      if (t.producedEmpty && dirCounts[path.dirname(t.filePath)] > 1) {
        failures.push(`${t.taskId}: empty contracts_produced for ${t.filePath} in a multi-file module (--strict-coverage; plan §2.5)`);
      }
    }
  }

  // Check DAG acyclicity
  const { execSync } = require("child_process");
  try {
    const result = execSync(
      `node ${path.join(__dirname, "dag.js")} --manifest-dir ${manifestDir} --check-cycles --level task`,
      { encoding: "utf-8" }
    ).trim();
    if (result !== "ok") failures.push(`Task DAG: ${result}`);
  } catch (e) {
    failures.push(`Task DAG check failed: ${e.message}`);
  }

  return failures;
}

// ── Gate 4: framework-standard layout ───────────────────────────────────────
//
// Every task's file_path must conform to the resolved structure profile (e.g.
// no `pages/` routes under an app-router Next.js profile, server files under
// src/server, go entrypoints under cmd/). Catches the layout drift the old
// uniqueness-only check (Gate 3) could not. The `generic` profile (unknown
// stack) enforces nothing, so this gate is a no-op when there's no convention.
function runGate4Layout(manifestDir) {
  const failures = [];
  const manifestDoc = loadYAML(path.join(manifestDir, "manifest.yaml"));
  const infraDoc = loadYAML(path.join(manifestDir, "infra-requirements.yaml"));
  const techStack = (manifestDoc && manifestDoc.tech_stack) || [];
  const profile = structure.resolveProfile(techStack, infraDoc, manifestDoc && manifestDoc.structure_profile);

  const tasks = loadYAMLFiles(path.join(manifestDir, "tasks"));
  for (const task of tasks) {
    const taskId = extractField(task.content, "task_id");
    const filePath = extractField(task.content, "file_path");
    if (!filePath) continue;
    const v = structure.validatePath(filePath, profile);
    if (!v.ok) {
      for (const viol of v.violations) {
        failures.push(`[${profile.id}] ${taskId}: ${viol.message} → suggest '${viol.suggested}'`);
      }
    }
  }
  return failures;
}

// ── Main ──
function main() {
  const args = parseArgs();
  if (!args.gate || !args.manifestDir) {
    console.log("err:usage: node manifest-validate.js --gate <1|2|3|4> --manifest-dir <dir>");
    process.exit(1);
  }

  let failures;
  switch (args.gate) {
    case 1: failures = runGate1(args.manifestDir, args.prd, {
      completeness: !!args.completeness,
      deferredScope: args.deferredScope,
      acceptanceCriteria: args.acceptanceCriteria,
    }); break;
    case 2: failures = runGate2(args.manifestDir); break;
    case 3: failures = runGate3(args.manifestDir, { strictCoverage: !!args.strictCoverage }); break;
    case 4: failures = runGate4Layout(args.manifestDir); break;
    default:
      console.log(`err:unknown gate: ${args.gate}`);
      process.exit(1);
  }

  if (failures.length === 0) {
    console.log("ok");
  } else {
    console.log(`err:gate_${args.gate}_failures:\n${failures.map(f => `  - ${f}`).join("\n")}`);
  }
}

main();
