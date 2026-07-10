#!/usr/bin/env node
/**
 * execute.js — Main execution loop for HPC
 * 
 * Dispatches workers in parallel batches, validates outputs, manages completions.
 * Reports batch-level status to stdout for the orchestrator.
 * 
 * Usage:
 *   node execute.js \
 *     --store <state.json> \
 *     --manifest-dir <dir> \
 *     --output-dir <dir> \
 *     --wiki-dir <dir> \
 *     --worker-model <model> \
 *     --validator-model <model> \
 *     --integration-validator-model <model> \
 *     --escalation-model <model> \
 *     [--max-parallel <n>] \
 *     [--single-batch]        # Run one batch and exit (for orchestrator-managed loops)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, exec } = require("child_process");
const yaml = require("js-yaml");
const { appendDecision } = require("./audit-log.js");

function parseArgs() {
  const args = process.argv.slice(2);
  // maxParallel left undefined here → resolved to the detected ceiling in
  // main() unless the operator passes --max-parallel / --max-concurrent.
  const parsed = { maxParallel: null, staleTimeoutMin: 5, stalePollSec: 60 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--store": parsed.store = args[++i]; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--output-dir": parsed.outputDir = args[++i]; break;
      case "--wiki-dir": parsed.wikiDir = args[++i]; break;
      case "--worker-model": parsed.workerModel = args[++i]; break;
      case "--validator-model": parsed.validatorModel = args[++i]; break;
      case "--integration-validator-model": parsed.integrationValidatorModel = args[++i]; break;
      case "--escalation-model": parsed.escalationModel = args[++i]; break;
      // --max-concurrent is the M3 name; --max-parallel kept as an alias.
      case "--max-parallel":
      case "--max-concurrent": parsed.maxParallel = parseInt(args[++i]); break;
      case "--single-batch": parsed.singleBatch = true; break;
      case "--stale-timeout-min": parsed.staleTimeoutMin = parseInt(args[++i]); break;
      case "--stale-poll-sec": parsed.stalePollSec = parseInt(args[++i]); break;
      // ── M4: continuous operation (all default OFF → behavior preserved) ──
      case "--auto-continue": parsed.autoContinue = true; break;
      case "--heartbeat": parsed.heartbeat = true; break;
      case "--heartbeat-sec": parsed.heartbeatSec = parseInt(args[++i]); break;
      case "--cooloff-min": parsed.cooloffMin = parseFloat(args[++i]); break;
      case "--abort-threshold": parsed.abortThreshold = parseFloat(args[++i]); break;
      case "--max-run-count": parsed.maxRunCount = parseInt(args[++i]); break;
      case "--watchdog-stall-min": parsed.watchdogStallMin = parseInt(args[++i]); break;
      case "--notification-webhook": parsed.notificationWebhook = args[++i]; break;
      case "--run-config": parsed.runConfig = args[++i]; break;
    }
  }
  return parsed;
}

// M4 §4.1 — load run_config defaults from a YAML file, then apply CLI overrides.
// run_config: { auto_continue, cooloff_minutes, abort_threshold, max_run_count,
//   notification_webhook }. CLI flags win over file values; file values win over
// built-in defaults. Returns a resolved config object.
function resolveRunConfig(args) {
  let rc = {};
  if (args.runConfig && fs.existsSync(args.runConfig)) {
    try {
      const doc = yaml.load(fs.readFileSync(args.runConfig, "utf-8"));
      rc = (doc && (doc.run_config || doc)) || {};
    } catch { rc = {}; }
  }
  const pick = (cliVal, fileVal, dflt) => (cliVal != null && !(typeof cliVal === "number" && Number.isNaN(cliVal))) ? cliVal : (fileVal != null ? fileVal : dflt);
  return {
    autoContinue: args.autoContinue || rc.auto_continue === true,
    heartbeat: args.heartbeat || args.autoContinue || rc.auto_continue === true,
    heartbeatSec: pick(args.heartbeatSec, rc.heartbeat_sec, 30),
    cooloffMin: pick(args.cooloffMin, rc.cooloff_minutes, 1),
    abortThreshold: pick(args.abortThreshold, rc.abort_threshold, 0.70),
    maxRunCount: pick(args.maxRunCount, rc.max_run_count, 50),
    watchdogStallMin: pick(args.watchdogStallMin, rc.watchdog_stall_min, 15),
    notificationWebhook: pick(args.notificationWebhook, rc.notification_webhook, null),
  };
}

// Read status counts from the store. Used by heartbeat + progress watchdog.
function readCounts(storeFile) {
  try {
    const state = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const c = { COMPLETE: 0, IN_PROGRESS: 0, LOCKED: 0, PLANNED: 0, ESCALATED: 0, BLOCKED: 0, REVIEW: 0, INVALIDATED: 0, total: 0 };
    for (const t of Object.values(state.tasks || {})) { c[t.status] = (c[t.status] || 0) + 1; c.total++; }
    return c;
  } catch { return null; }
}

// M3 §3.1 — detected concurrency ceiling. Replaces the hard-coded parallelism.
// The 250 hard cap exists because even on a 32-core box, ~640 simultaneous
// `claude` calls hit API rate limits and reproduce the err:exec crash pattern.
// Returns { ceiling, limit } where limit names which bound fired.
function computeCeiling() {
  const cpuBound = (os.cpus().length || 1) * 20;
  const memBound = Math.max(1, Math.floor(os.freemem() / 100e6)); // ~100MB/worker
  const HARD = 250;
  const bounds = [
    { v: cpuBound, name: "cpu" },
    { v: memBound, name: "memory" },
    { v: HARD, name: "hard-cap" },
  ];
  const min = bounds.reduce((a, b) => (b.v < a.v ? b : a));
  return { ceiling: min.v, limit: min.name };
}

// M3 §3.3 — count tasks that declare `taskId` in their depends_on. Producers
// with a large blast radius get pre-validated before consumers unblock.
function countDependents(manifestDir, taskId) {
  const tasksDir = path.join(manifestDir, "tasks");
  if (!fs.existsSync(tasksDir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
      const deps = extractListField(content, "depends_on");
      if (deps.includes(taskId)) n++;
    } catch {}
  }
  return n;
}

const SCRIPTS = path.resolve(__dirname);

// Run a command and return stdout. Short timeout — only used for store/dag
// operations (synchronous helpers, not claude CLI calls).
function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (e) {
    return `err:exec:${e.message.slice(0, 200)}`;
  }
}

// POSIX-safe single-quote escaping for shell args that may contain user-
// supplied or model-supplied text (parens, quotes, $, backticks, etc.).
function shq(s) {
  if (s == null) s = "";
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Run a sub-agent command async. Long timeout because each call spawns a
// fresh `claude -p` process: cold start + model latency. 15 min ceiling
// per worker/validator/escalation invocation.
function runAsync(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf-8", timeout: 900000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(`err:exec:${err.message.slice(0, 200)}`);
      else resolve(stdout.trim());
    });
  });
}

// Get task spec from manifest
function getTaskSpec(manifestDir, taskId) {
  const taskFile = path.join(manifestDir, "tasks", `${taskId}.yaml`);
  if (fs.existsSync(taskFile)) return taskFile;
  
  // Try without the full ID formatting
  const tasksDir = path.join(manifestDir, "tasks");
  if (!fs.existsSync(tasksDir)) return null;
  
  for (const f of fs.readdirSync(tasksDir)) {
    const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
    if (content.includes(`task_id: "${taskId}"`) || content.includes(`task_id: ${taskId}`)) {
      return path.join(tasksDir, f);
    }
  }
  return null;
}

// Extract file_path from task YAML
function getOutputPath(taskFile) {
  const content = fs.readFileSync(taskFile, "utf-8");
  const match = content.match(/^file_path:\s*"?([^"\n]+)"?/m);
  return match ? match[1].trim() : null;
}

// Extract a YAML list field (block or inline form) from a task spec, stripping
// quotes and inline `# comments`. Returns string[].
function extractListField(content, field) {
  const stripComment = (s) => s.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const inlineRe = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]\\s*(?:#.*)?$`, "m");
  const inlineMatch = content.match(inlineRe);
  if (inlineMatch) {
    const inner = inlineMatch[1].trim();
    if (inner === "") return [];
    return inner.split(",").map(stripComment).filter(Boolean);
  }
  const blockRe = new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s*.+\\n?)*)`, "m");
  const blockMatch = content.match(blockRe);
  if (!blockMatch) return [];
  return (blockMatch[1].match(/^\s+-\s*.+/gm) || [])
    .map(l => stripComment(l.replace(/^\s+-\s*/, "")))
    .filter(Boolean);
}

function getTaskContracts(taskFile) {
  const content = fs.readFileSync(taskFile, "utf-8");
  return {
    produced: extractListField(content, "contracts_produced"),
    consumed: extractListField(content, "contracts_consumed"),
  };
}

// Check if task is a critical DAG junction
function isCriticalJunction(manifestDir, taskId) {
  try {
    const result = run(`node ${path.join(SCRIPTS, "dag.js")} --manifest-dir ${manifestDir} --critical-junctions --level task`);
    const junctions = JSON.parse(result);
    return junctions.some(j => j.id === taskId);
  } catch {
    return false;
  }
}

// Read worker_model_override from the live store. Returns null if not set or
// if the store/task can't be read — caller falls back to the default model.
function getWorkerOverride(storeFile, taskId) {
  try {
    const state = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const t = state.tasks && state.tasks[taskId];
    return (t && t.worker_model_override) || null;
  } catch {
    return null;
  }
}

// Read the task's status from the store. Used after fail()/requeue() to detect
// a BLOCKED transition (the promotion ladder is internal to those actions).
function getTaskStatus(storeFile, taskId) {
  try {
    const state = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const t = state.tasks && state.tasks[taskId];
    return (t && t.status) || null;
  } catch {
    return null;
  }
}

function getAssignedForkId(storeFile, taskId) {
  try {
    const state = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
    const t = state.tasks && state.tasks[taskId];
    return (t && t.assigned_fork_id) || null;
  } catch {
    return null;
  }
}

// triggerFork: ask fork-manifest.js to mint a fork dir for the originating
// task. Returns { forkId, forkDir } or null on failure. Idempotent in the
// sense that calling it twice creates two distinct forks (epoch_ms suffix);
// callers should guard against that.
function triggerFork(manifestDir, store, taskId, logFn) {
  const out = run(`node ${path.join(SCRIPTS, "fork-manifest.js")} create --task-id ${taskId} --store ${store} --manifest-dir ${manifestDir}`);
  if (out.startsWith("err:")) {
    logFn(`fork-create-err task=${taskId} result=${out.slice(0, 300)}`);
    return null;
  }
  const [forkId, forkDir] = out.split("\t");
  logFn(`fork-created task=${taskId} fork=${forkId} dir=${forkDir}`);
  return { forkId: forkId.trim(), forkDir: (forkDir || "").trim() };
}

// cascade: walk the DAG forward from blockedTaskId and mark every transitive
// dependent BLOCKED with --upstream + --fork-id so they share the fork.
function cascade(manifestDir, store, blockedTaskId, forkId, logFn) {
  const listRaw = run(`node ${path.join(SCRIPTS, "dag.js")} --manifest-dir ${manifestDir} --cascade-block ${store} ${blockedTaskId} --level task`);
  let dependents = [];
  try { dependents = JSON.parse(listRaw); } catch {
    logFn(`cascade-list-parse-err task=${blockedTaskId} raw=${listRaw.slice(0, 200)}`);
    return 0;
  }
  for (const dep of dependents) {
    run(`node ${path.join(SCRIPTS, "task-store.js")} block --store ${store} --task-id ${shq(dep)} --upstream ${shq(blockedTaskId)} --fork-id ${forkId}`);
  }
  logFn(`cascade-block originator=${blockedTaskId} fork=${forkId} dependents=${dependents.length}`);
  return dependents.length;
}

// blockOriginator: mint a fork, mark the originating task BLOCKED with that
// fork_id, then cascade. If the task is already BLOCKED with an existing
// fork (e.g. from the promotion ladder in fail/requeue), reuse the existing
// fork id rather than minting a second one.
function blockOriginator(manifestDir, store, taskId, logFn) {
  const existingFork = getAssignedForkId(store, taskId);
  let forkId = existingFork;
  if (!forkId) {
    const fork = triggerFork(manifestDir, store, taskId, logFn);
    if (!fork) return null;
    forkId = fork.forkId;
  }
  run(`node ${path.join(SCRIPTS, "task-store.js")} block --store ${store} --task-id ${taskId} --fork-id ${forkId}`);
  cascade(manifestDir, store, taskId, forkId, logFn);
  return forkId;
}

// Check if task is a UI task
// ── Deferred contract-symmetry check (run on every COMPLETE transition) ──
//
// When task T transitions to COMPLETE, sweep every contract T references and
// every peer task that references the same contract. For peers that are also
// COMPLETE, verify declaration-level binding symmetry between the (now-frozen)
// declared `invokes` and `implements` sets:
//
//   - Every symbol in any COMPLETE consumer's `invokes` for contract C must
//     appear in some COMPLETE producer's `implements` for C.
//   - Every symbol the consumer's emitted file calls from C (per its declared
//     invokes) must be findable in the producer's emitted file. This deeper
//     file-pair check requires reading both files; for the cheap declaration-
//     only path, this function compares declarations.
//
// Peers in any non-COMPLETE state (PLANNED, LOCKED, IN_PROGRESS, BLOCKED,
// ESCALATED) are skipped — they will trigger the check when they themselves
// transition to COMPLETE. This is the user-requested queuing semantics: never
// fail a task because its counterpart isn't done yet.
//
// On detected drift: returns a list of {drifted_task_id, reason, peer_task_id,
// contract_id, symbol}. Caller decides whether to mark BLOCKED + fork.
function runDeferredSymmetryChecks(manifestDir, storeFile, justCompletedTaskId, logFn) {
  const drifts = [];
  const tasksDir = path.join(manifestDir, "tasks");
  const contractsDir = path.join(manifestDir, "contracts");

  const loadYaml = (p) => {
    try { return yaml.load(fs.readFileSync(p, "utf-8")); } catch { return null; }
  };
  const normRefs = (refs) => {
    if (!Array.isArray(refs)) return [];
    return refs.map(r => {
      if (typeof r === "string") return { contract_id: r, invokes: [], implements: [], _legacy: true };
      return {
        contract_id: r && (r.contract_id || r.id) || null,
        invokes: Array.isArray(r && r.invokes) ? r.invokes : [],
        implements: Array.isArray(r && r.implements) ? r.implements : [],
        _legacy: false,
      };
    }).filter(r => r.contract_id);
  };

  const taskFile = path.join(tasksDir, `${justCompletedTaskId}.yaml`);
  const justCompleted = loadYaml(taskFile);
  if (!justCompleted) return drifts;

  const consumedByJC = normRefs(justCompleted.contracts_consumed);
  const producedByJC = normRefs(justCompleted.contracts_produced);
  const contractIdsTouched = new Set([
    ...consumedByJC.map(r => r.contract_id),
    ...producedByJC.map(r => r.contract_id),
  ]);
  if (contractIdsTouched.size === 0) return drifts;

  // Load full task list once
  const state = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
  const allTasks = {};
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith(".yaml")) continue;
    const tid = f.replace(/\.yaml$/, "");
    const doc = loadYaml(path.join(tasksDir, f));
    if (doc) allTasks[tid] = doc;
  }

  // For each contract this task touches, classify peers as producers/consumers
  // (declared) and split by completion state.
  //
  // The deferred-symmetry check is a FALSIFICATION test: it can only fire
  // when both sides of the contract have produced their declarations. If any
  // declared producer for the contract has not yet COMPLETE'd, we cannot tell
  // whether a missing symbol is drift (producer never going to ship it) or
  // pending (producer just hasn't run yet). Defer.
  for (const cid of contractIdsTouched) {
    // Find all tasks that declare any reference to this contract.
    const declaredProducers = [];  // [{taskId, doc, status}]
    const declaredConsumers = [];
    for (const [tid, doc] of Object.entries(allTasks)) {
      const status = state.tasks[tid] && state.tasks[tid].status;
      for (const r of normRefs(doc.contracts_produced)) {
        if (r.contract_id === cid) { declaredProducers.push({ taskId: tid, doc, status, ref: r }); break; }
      }
      for (const r of normRefs(doc.contracts_consumed)) {
        if (r.contract_id === cid) { declaredConsumers.push({ taskId: tid, doc, status, ref: r }); break; }
      }
    }

    // QUEUE/DEFER rule: if not all declared producers are COMPLETE, skip the
    // check for this contract entirely. Same if not all declared consumers
    // are COMPLETE (otherwise we'd report stale-looking drifts that resolve
    // themselves when later consumers complete).
    const allProducersComplete = declaredProducers.length > 0 &&
      declaredProducers.every(p => p.status === "COMPLETE");
    const allConsumersComplete = declaredConsumers.length > 0 &&
      declaredConsumers.every(c => c.status === "COMPLETE");
    if (!allProducersComplete || !allConsumersComplete) {
      // Defer — will re-fire when each remaining peer transitions to COMPLETE.
      continue;
    }

    // Both sides fully complete — run the actual symmetry check.
    const producerSymbols = new Set();
    for (const p of declaredProducers) {
      for (const sym of p.ref.implements) producerSymbols.add(sym);
    }
    for (const c of declaredConsumers) {
      for (const sym of c.ref.invokes) {
        if (!producerSymbols.has(sym)) {
          drifts.push({
            drifted_task_id: c.taskId,
            peer_task_id: justCompletedTaskId,
            contract_id: cid,
            symbol: sym,
            reason: `consumer task "${c.taskId}" declares invokes ["${sym}"] from ${cid} but no producer task implements that symbol (all peers COMPLETE — final symmetry failure)`,
          });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const d of drifts) {
    const k = `${d.drifted_task_id}|${d.contract_id}|${d.symbol}`;
    if (!seen.has(k)) { seen.add(k); unique.push(d); }
  }

  if (unique.length > 0 && logFn) {
    for (const d of unique) {
      logFn(`SYMMETRY_DRIFT task=${d.drifted_task_id} peer=${d.peer_task_id} contract=${d.contract_id} symbol=${d.symbol}`);
    }
  }
  return unique;
}

function isUITask(taskFile) {
  const content = fs.readFileSync(taskFile, "utf-8");
  return content.includes("artifact_type: COMPONENT") || 
         content.includes("functional_area: UI") ||
         content.includes(".tsx") || content.includes(".jsx");
}

// Update wiki after task completion. `contracts` is {produced: string[], consumed: string[]}.
function updateWiki(wikiDir, taskId, filePath, contracts) {
  fs.mkdirSync(wikiDir, { recursive: true });

  // Update file index. Maintained as a top-level YAML sequence (no `files:`
  // mapping header) so re-rewrites on each call stay valid YAML. We re-read,
  // dedupe by path, append the new entry, and rewrite.
  const indexFile = path.join(wikiDir, "file-index.yaml");
  const fileEntries = {}; // path -> { task_id, status }
  if (fs.existsSync(indexFile)) {
    const existing = fs.readFileSync(indexFile, "utf-8");
    const blockRe = /^- path:\s*"?([^"\n]+)"?\s*\n((?:\s{2,}.+\n?)*)/gm;
    let m;
    while ((m = blockRe.exec(existing)) !== null) {
      const p = m[1].trim();
      const body = m[2];
      const tidMatch = body.match(/^\s*task_id:\s*"?([^"\n]+)"?/m);
      const statusMatch = body.match(/^\s*status:\s*"?([^"\n]+)"?/m);
      fileEntries[p] = {
        task_id: tidMatch ? tidMatch[1].trim() : "",
        status: statusMatch ? statusMatch[1].trim() : "COMPLETE",
      };
    }
  }
  fileEntries[filePath] = { task_id: taskId, status: "COMPLETE" };
  let indexOut = "";
  for (const [p, info] of Object.entries(fileEntries).sort()) {
    indexOut += `- path: "${p}"\n  task_id: "${info.task_id}"\n  status: ${info.status}\n`;
  }
  fs.writeFileSync(indexFile, indexOut);

  // Update contract index — merge this task's produced/consumed into the
  // skill's intended {producer, consumers[]} map per manifest-schema §Wiki.
  const contractIndexFile = path.join(wikiDir, "contract-index.yaml");
  const produced = (contracts && contracts.produced) || [];
  const consumed = (contracts && contracts.consumed) || [];
  if (produced.length > 0 || consumed.length > 0) {
    // Parse existing entries (we wrote them; format is simple and known).
    let entries = {}; // contract_id -> { producer: taskId|null, consumers: Set }
    if (fs.existsSync(contractIndexFile)) {
      const existing = fs.readFileSync(contractIndexFile, "utf-8");
      // Match each `- contract_id: X` block and pull producer + consumers.
      const blockRe = /^- contract_id:\s*"?([^"\n]+)"?\s*\n((?:\s{2,}.+\n?)*)/gm;
      let m;
      while ((m = blockRe.exec(existing)) !== null) {
        const cid = m[1].trim();
        const body = m[2];
        const prodMatch = body.match(/^\s*producer:\s*"?([^"\n]+)"?/m);
        const consumerLines = (body.match(/^\s+-\s*"?([^"\n]+)"?/gm) || [])
          .map(l => l.replace(/^\s+-\s*"?|"?\s*$/g, "").trim())
          .filter(Boolean);
        entries[cid] = {
          producer: prodMatch ? prodMatch[1].trim() : null,
          consumers: new Set(consumerLines),
        };
      }
    }

    for (const cid of produced) {
      if (!entries[cid]) entries[cid] = { producer: null, consumers: new Set() };
      entries[cid].producer = taskId;
    }
    for (const cid of consumed) {
      if (!entries[cid]) entries[cid] = { producer: null, consumers: new Set() };
      entries[cid].consumers.add(taskId);
    }

    let out = "";
    for (const [cid, info] of Object.entries(entries).sort()) {
      out += `- contract_id: "${cid}"\n`;
      out += `  producer: ${info.producer ? `"${info.producer}"` : "null"}\n`;
      out += `  consumers:\n`;
      for (const c of [...info.consumers].sort()) {
        out += `    - "${c}"\n`;
      }
      if (info.consumers.size === 0) out += `    []\n`.replace(/^/, "");
    }
    fs.writeFileSync(contractIndexFile, out);
  }

  // Update progress dashboard with the full schema (overall + by_epic + by_area)
  // computed from store + manifest. See manifest-schema.md "Progress Dashboard".
  writeProgressDashboard(wikiDir);
}

// Compute and write wiki/progress.yaml from the live task store and manifest.
// Best-effort — silent fallback to a minimal stamp if anything errors so that
// a missing manifest dir doesn't break the execution loop.
function writeProgressDashboard(wikiDir) {
  const progressFile = path.join(wikiDir, "progress.yaml");
  try {
    const args = parseArgs();
    const state = JSON.parse(fs.readFileSync(args.store, "utf-8"));
    const tasksDir = path.join(args.manifestDir, "tasks");

    // task_id -> { epic, area } from manifest task specs
    const taskMeta = {};
    if (fs.existsSync(tasksDir)) {
      for (const f of fs.readdirSync(tasksDir)) {
        if (!f.endsWith(".yaml")) continue;
        const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
        const idM = content.match(/^task_id:\s*"?([^"\n]+)"?/m);
        const epicM = content.match(/^epic_id:\s*"?([^"\n]+)"?/m);
        const areaM = content.match(/^functional_area:\s*"?([^"\n]+)"?/m);
        // Fallback: derive area from task_id pattern TASK-{AREA}-...
        let area = areaM ? areaM[1].trim() : null;
        if (!area && idM) {
          const am = idM[1].match(/^(?:TASK-)?([A-Z]+)/);
          if (am) area = am[1];
        }
        if (idM) {
          taskMeta[idM[1].trim()] = {
            epic: epicM ? epicM[1].trim() : "UNKNOWN",
            area: area || "UNKNOWN",
          };
        }
      }
    }

    let total = 0, complete = 0, inProgress = 0, planned = 0, escalated = 0, blocked = 0;
    const byEpic = {}; // epic -> {total, complete}
    const byArea = {}; // area -> {total, complete}

    for (const [tid, t] of Object.entries(state.tasks || {})) {
      total++;
      const meta = taskMeta[tid] || { epic: "UNKNOWN", area: "UNKNOWN" };
      if (!byEpic[meta.epic]) byEpic[meta.epic] = { total: 0, complete: 0 };
      if (!byArea[meta.area]) byArea[meta.area] = { total: 0, complete: 0 };
      byEpic[meta.epic].total++;
      byArea[meta.area].total++;
      switch (t.status) {
        case "COMPLETE":
          complete++;
          byEpic[meta.epic].complete++;
          byArea[meta.area].complete++;
          break;
        case "IN_PROGRESS":
        case "LOCKED":
          inProgress++; break;
        case "PLANNED":
          planned++; break;
        case "ESCALATED":
          escalated++; break;
        case "BLOCKED":
          blocked++; break;
      }
    }

    const pct = total > 0 ? Math.round((complete / total) * 10000) / 100 : 0;
    let out = "overall:\n";
    out += `  total_tasks: ${total}\n`;
    out += `  complete: ${complete}\n`;
    out += `  in_progress: ${inProgress}\n`;
    out += `  planned: ${planned}\n`;
    out += `  escalated: ${escalated}\n`;
    out += `  blocked: ${blocked}\n`;
    out += `  percent_complete: ${pct}\n`;
    out += "by_epic:\n";
    for (const [k, v] of Object.entries(byEpic).sort()) {
      out += `  ${k}:\n    total: ${v.total}\n    complete: ${v.complete}\n`;
    }
    out += "by_area:\n";
    for (const [k, v] of Object.entries(byArea).sort()) {
      out += `  ${k}:\n    total: ${v.total}\n    complete: ${v.complete}\n`;
    }
    out += `last_updated: "${new Date().toISOString()}"\n`;
    fs.writeFileSync(progressFile, out);
  } catch (e) {
    fs.writeFileSync(progressFile, `last_updated: "${new Date().toISOString()}"\n# progress_compute_error: ${String(e.message).slice(0, 200)}\n`);
  }
}

// ── Main execution loop ──
async function main() {
  const args = parseArgs();
  
  if (!args.store || !args.manifestDir || !args.outputDir) {
    console.log("err:missing required args");
    process.exit(1);
  }

  fs.mkdirSync(args.outputDir, { recursive: true });
  fs.mkdirSync(args.wikiDir || path.join(args.outputDir, "../wiki"), { recursive: true });
  const wikiDir = args.wikiDir || path.join(args.outputDir, "../wiki");

  const logDir = path.join(args.outputDir, "..", "execute-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `run-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const logLine = (s) => logStream.write(`[${new Date().toISOString()}] ${s}\n`);
  logLine(`execute.js started pid=${process.pid} args=${JSON.stringify(args)}`);

  // Resolve concurrency. Operator override (--max-concurrent/--max-parallel)
  // wins; otherwise use the detected ceiling (M3 §3.1).
  if (args.maxParallel == null || Number.isNaN(args.maxParallel)) {
    const { ceiling, limit } = computeCeiling();
    args.maxParallel = ceiling;
    logLine(`concurrency ceiling=${ceiling} limit=${limit} (cpus=${os.cpus().length} freemem_mb=${Math.floor(os.freemem()/1e6)})`);
    console.log(`concurrency: ceiling=${ceiling} limit=${limit}`);
  } else {
    logLine(`concurrency override max_concurrent=${args.maxParallel}`);
    console.log(`concurrency: override=${args.maxParallel}`);
  }

  // ── M4: continuous-operation setup (no-op unless --auto-continue) ──
  const rc = resolveRunConfig(args);
  const wsRoot = path.resolve(args.outputDir, "..");
  if (rc.autoContinue) logLine(`auto-continue ON cooloff_min=${rc.cooloffMin} abort_threshold=${rc.abortThreshold} max_run_count=${rc.maxRunCount} watchdog_stall_min=${rc.watchdogStallMin}`);

  // Progress watchdog state: timestamp of the last observed task transition.
  let lastTransitionAt = Date.now();
  let lastCountsSig = null;
  const transitionSig = (c) => c ? `${c.COMPLETE}/${c.IN_PROGRESS + c.LOCKED}/${c.PLANNED}/${c.BLOCKED}/${c.ESCALATED}` : "";
  const noteTransition = () => {
    const c = readCounts(args.store);
    const sig = transitionSig(c);
    if (sig !== lastCountsSig) { lastCountsSig = sig; lastTransitionAt = Date.now(); }
    return c;
  };
  lastCountsSig = transitionSig(readCounts(args.store));

  // M4 §4.3 heartbeat — pure observability; emits one stdout line / interval.
  let heartbeatTimer = null;
  if (rc.heartbeat) {
    heartbeatTimer = setInterval(() => {
      const c = readCounts(args.store);
      if (!c) return;
      const ago = Math.round((Date.now() - lastTransitionAt) / 1000);
      console.log(`[${new Date().toISOString()}] phase=execute run=${runCount} tasks=COMPLETE:${c.COMPLETE} IN_PROGRESS:${c.IN_PROGRESS + c.LOCKED} PLANNED:${c.PLANNED} BLOCKED:${c.BLOCKED} ESCALATED:${c.ESCALATED} workers_alive=${c.IN_PROGRESS + c.LOCKED} last_transition=${ago}s_ago`);
    }, Math.max(5, rc.heartbeatSec) * 1000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  // M4 §4.4 — fire an outbound halt notification (commit+push+webhook) for a
  // halt artifact. Best-effort; never throws into the loop.
  const notifyHalt = (kind, reportPath) => {
    try {
      const wh = rc.notificationWebhook ? ` --webhook ${shq(rc.notificationWebhook)}` : "";
      const out = run(`node ${path.join(SCRIPTS, "notify-halt.js")} --report ${shq(reportPath)} --kind ${kind} --workspace ${shq(wsRoot)}${wh}`);
      logLine(`notify-halt kind=${kind} report=${reportPath} result=${out.slice(0, 200)}`);
    } catch (e) {
      logLine(`notify-halt-failed kind=${kind} err=${e.message}`);
    }
  };

  const recoveryState = path.join(wikiDir, "recovery-state.yaml");

  // M5 §5.5 — emit a SPEC-DEFECT.md halt artifact (when one wasn't already
  // written by a Tier-4 deliberation) and notify. Best-effort.
  const haltSpecDefect = (reasonText) => {
    const report = path.join(wsRoot, "SPEC-DEFECT.md");
    if (!fs.existsSync(report)) {
      const inp = path.join(wikiDir, "spec-defect-input.yaml");
      try {
        fs.writeFileSync(inp,
          `diagnosis: ${JSON.stringify("Autonomous recovery halted: " + reasonText)}\n` +
          `build: ${JSON.stringify(wsRoot)}\n` +
          `halt_reason: ${JSON.stringify(reasonText)}\n` +
          `recovery_iterations: ${(() => { try { return (fs.readFileSync(recoveryState, "utf-8").match(/^\s+-\s+iteration:/gm) || []).length; } catch { return 0; } })()}\n` +
          `implicated_sections: []\nfailure_signatures: []\n` +
          `recommendation: ${JSON.stringify("Recovery could not converge. Inspect wiki/recovery-state.yaml and the tier3-iteration-* workspace snapshots.")}\n`);
        run(`node ${path.join(SCRIPTS, "spec-defect-report.js")} --input ${shq(inp)} --output ${shq(report)}`);
      } catch (e) { logLine(`spec-defect-emit-failed err=${e.message}`); }
    }
    appendDecision(wsRoot, { tier: "M5_HALT", decision: "Build halted with SPEC-DEFECT", triggering_signal: reasonText });
    notifyHalt("SPEC-DEFECT", report);
    return report;
  };

  // M5 — recovery driver. Consults the iteration-cap (budget-tracker) and the
  // loop-detector around the tier-escalating deliberate-fork pass. Returns a
  // string starting with "halt:" when the build must stop.
  const triggerRecovery = (reason) => {
    logLine(`recovery-trigger reason=${reason}`);
    appendDecision(wsRoot, { tier: "M5_RECOVERY", decision: "Recovery ladder triggered", triggering_signal: reason });

    // §5.4 — iteration cap. Stop before another round if the cap is reached.
    const budget = run(`node ${path.join(SCRIPTS, "budget-tracker.js")} --manifest-dir ${args.manifestDir} --state ${shq(recoveryState)}`);
    logLine(`recovery budget ${budget.split("\n")[0]}`);
    if (budget.startsWith("halt:cap_reached")) {
      const r = haltSpecDefect(`recovery iteration cap reached (${budget.replace(/\n/g, " ")})`);
      logLine(`recovery HALT cap report=${r}`);
      return `halt:budget:${budget}`;
    }

    // Tier 2+ deliberation (deliberate-fork self-escalates tiers and may emit
    // SPEC-DEFECT.md at Tier 4).
    const out = run(`node ${path.join(SCRIPTS, "deliberate-fork.js")} --manifest-dir ${args.manifestDir} --store ${args.store} --all`);
    logLine(`recovery deliberate-fork result=${out.slice(0, 300)}`);

    // A Tier-4 terminal emits SPEC-DEFECT.md directly → halt + notify.
    const specDefect = path.join(wsRoot, "SPEC-DEFECT.md");
    if (fs.existsSync(specDefect)) {
      logLine(`recovery spec-defect detected report=${specDefect}`);
      appendDecision(wsRoot, { tier: "M5_HALT", decision: "Build halted: Tier-4 emitted SPEC-DEFECT.md", triggering_signal: `recovery reason=${reason}` });
      notifyHalt("SPEC-DEFECT", specDefect);
      return "halt:spec_defect";
    }

    // §5.3 — loop detector. A manifest cycle (oscillation) halts; signature/
    // slice-stable escalate (already handled by deliberate-fork's diff guard
    // and tier bumps, so here we only act on the halt verdict).
    const verdict = run(`node ${path.join(SCRIPTS, "loop-detector.js")} --state ${shq(recoveryState)}`);
    logLine(`recovery loop-detector ${verdict.split("\n")[0]}`);
    if (verdict.startsWith("verdict:halt")) {
      const r = haltSpecDefect(`loop detector halted recovery (${verdict.replace(/\n/g, " ")})`);
      logLine(`recovery HALT loop report=${r}`);
      return `halt:loop:${verdict}`;
    }
    return out;
  };

  const runAbortedReport = (errRate, errs, total, runs) =>
    `# RUN-ABORTED\n\n` +
    `**Halted at:** ${new Date().toISOString()}\n` +
    `**Reason:** worker-error rate exceeded abort_threshold (likely systemic — every worker failing)\n` +
    `**Worker-error rate:** ${(errRate * 100).toFixed(1)}% (${errs}/${total} dispatches in the run segment)\n` +
    `**Abort threshold:** ${(rc.abortThreshold * 100).toFixed(0)}%\n` +
    `**Consecutive runs:** ${runs}\n\n` +
    `## Next steps\nInspect \`wiki/worker-crashes/\` for crash_reason classification (rate_limit / oom / ` +
    `timeout / empty_output / structured_error). A systemic crash_reason indicates an environment or ` +
    `rate-limit issue, not a per-task spec defect.\n\nFull audit log: \`wiki/autonomous-decisions.yaml\`\n`;

  let batchNum = 0;
  let lastStaleCheck = 0;
  let runCount = 0;
  // Per-run-segment worker-error accounting for the abort-threshold check.
  let segErrors = 0;
  let segTotal = 0;

  // Cross-cutting sanity cap: 72h of continuous execution with ZERO observable
  // progress halts the build with SANITY-CAP-HIT.md. "Observable progress" =
  // any task reaching COMPLETE, or any recovery iteration completing. (The
  // 15-min watchdog resets on every recovery trigger, so it can't catch a
  // recovery loop that runs forever without resolving anything — this can.)
  const SANITY_CAP_MS = 72 * 60 * 60 * 1000;
  let lastRealProgressAt = Date.now();
  let prevCompleteCount = (readCounts(args.store) || {}).COMPLETE || 0;
  const markProgress = () => { lastRealProgressAt = Date.now(); };

  // Periodic watchdog: workers can hang without runAsync's timeout firing
  // (claude -p sometimes orphans grandchild processes), leaving tasks stuck
  // in IN_PROGRESS forever. Run reset-stale on a wall-clock interval to
  // recover them automatically.
  const staleSweep = () => {
    const now = Date.now();
    if (now - lastStaleCheck < args.stalePollSec * 1000) return;
    lastStaleCheck = now;
    const res = run(`node ${path.join(SCRIPTS, "task-store.js")} reset-stale --store ${args.store} --timeout ${args.staleTimeoutMin}`);
    const m = res.match(/reset (\d+) stale/);
    if (m && parseInt(m[1]) > 0) {
      logLine(`watchdog reset_stale=${m[1]} timeout_min=${args.staleTimeoutMin}`);
      console.log(`watchdog: reset ${m[1]} stale tasks`);
    }
  };

  // ESCALATED is a legacy stuck-state. Under the new architecture, every
  // structural failure should land in BLOCKED so the council deliberation
  // pipeline can resolve it. This sweep transitions any pre-existing or
  // newly-created ESCALATED task into BLOCKED + cascades, minting a fork
  // on the way so deliberate-fork.js can pick it up.
  const rescueEscalated = () => {
    let state;
    try { state = JSON.parse(fs.readFileSync(args.store, "utf-8")); }
    catch { return 0; }
    const escalated = Object.entries(state.tasks || {})
      .filter(([_, t]) => t.status === "ESCALATED")
      .map(([id]) => id);
    if (escalated.length === 0) return 0;
    logLine(`rescue-escalated count=${escalated.length} ids=${escalated.join(",")}`);
    let rescued = 0;
    for (const tid of escalated) {
      const forkId = blockOriginator(args.manifestDir, args.store, tid, logLine);
      if (forkId) {
        logLine(`rescue-escalated task=${tid} fork=${forkId} status=BLOCKED`);
        rescued++;
      } else {
        logLine(`rescue-escalated-failed task=${tid}`);
      }
    }
    if (rescued > 0) console.log(`rescue: transitioned ${rescued} ESCALATED tasks to BLOCKED`);
    return rescued;
  };

  // One-shot rescue at start: pick up any pre-existing ESCALATED tasks
  // from prior runs and route them through the BLOCKED pipeline.
  rescueEscalated();

  while (true) {
    batchNum++;

    staleSweep();
    if (batchNum > 1) rescueEscalated();

    // Cross-cutting 72h sanity cap. Update the real-progress clock when the
    // COMPLETE count rises; halt if 72h pass with none.
    if (rc.autoContinue) {
      const c = readCounts(args.store) || {};
      if ((c.COMPLETE || 0) > prevCompleteCount) { prevCompleteCount = c.COMPLETE; markProgress(); }
      if (Date.now() - lastRealProgressAt > SANITY_CAP_MS) {
        const report = path.join(wsRoot, "SANITY-CAP-HIT.md");
        try {
          fs.writeFileSync(report,
            `# SANITY-CAP-HIT\n\n**Halted at:** ${new Date().toISOString()}\n` +
            `**Reason:** 72h of continuous execution with zero observable progress (no task reached ` +
            `COMPLETE and no recovery iteration resolved).\n\n` +
            `This is the pathological-loop backstop. Inspect \`wiki/recovery-state.yaml\`, ` +
            `\`wiki/stall-diagnostic-*.yaml\`, and \`wiki/worker-crashes/\` for the stuck slice.\n`);
        } catch {}
        logLine(`SANITY-CAP-HIT 72h no-progress`);
        console.log(`halt:SANITY-CAP-HIT 72h without observable progress report=${report}`);
        appendDecision(wsRoot, { tier: "SANITY_CAP", decision: "Build halted: SANITY-CAP-HIT", triggering_signal: "72h with zero observable progress" });
        notifyHalt("SANITY-CAP", report);
        break;
      }
    }

    // M4 §4.2 progress watchdog — busy-but-not-progressing detection. If no
    // task transition has been observed within the stall window, dump a
    // diagnostic and trigger recovery (the build is stuck, not just slow).
    if (rc.autoContinue) {
      noteTransition();
      const stallMs = rc.watchdogStallMin * 60 * 1000;
      if (Date.now() - lastTransitionAt > stallMs) {
        const diag = path.join(wikiDir, `stall-diagnostic-${Date.now()}.yaml`);
        const c = readCounts(args.store) || {};
        try {
          fs.writeFileSync(diag,
            `stall_detected_at: "${new Date().toISOString()}"\n` +
            `minutes_without_transition: ${Math.round((Date.now() - lastTransitionAt) / 60000)}\n` +
            `run: ${runCount}\nbatch: ${batchNum}\ncounts:\n` +
            `  complete: ${c.COMPLETE || 0}\n  in_progress: ${(c.IN_PROGRESS || 0) + (c.LOCKED || 0)}\n` +
            `  planned: ${c.PLANNED || 0}\n  blocked: ${c.BLOCKED || 0}\n  escalated: ${c.ESCALATED || 0}\n`);
        } catch {}
        logLine(`STALL detected stall_min=${rc.watchdogStallMin} diag=${diag}`);
        console.log(`stall: no task transition in ${rc.watchdogStallMin}min — diagnostic=${path.basename(diag)}, triggering recovery`);
        const recRes = triggerRecovery("progress_watchdog_stall");
        lastTransitionAt = Date.now(); // reset so we don't re-fire each iteration
        if (recRes && recRes.startsWith("halt:")) {
          console.log(`halt:recovery ${recRes.split(":").slice(0, 2).join(":")} — see SPEC-DEFECT.md`);
          logLine(`halt recovery=${recRes}`);
          break;
        }
      }
    }

    // Get next batch
    const batchResult = run(`node ${path.join(SCRIPTS, "task-store.js")} batch --store ${shq(args.store)} --manifest-dir ${shq(args.manifestDir)}`);
    
    if (batchResult === "done" || batchResult.startsWith("done:")) {
      // task-store.js#batch may return either bare "done" (legacy) or
      // "done:complete=N escalated=M" (post-fix). Pass the detail through.
      if (batchResult.startsWith("done:")) {
        const detail = batchResult.slice("done:".length);
        const escMatch = detail.match(/escalated=(\d+)/);
        const blkMatch = detail.match(/blocked=(\d+)/);
        const escalatedCount = escMatch ? parseInt(escMatch[1]) : 0;
        const blockedCount = blkMatch ? parseInt(blkMatch[1]) : 0;
        if (blockedCount > 0) {
          // M4 §4.1 auto-continue: instead of stopping for a human to run
          // deliberate-fork, auto-deliberate and re-enter the loop — unless
          // the worker-error rate signals a systemic failure, or the
          // consecutive-run cap is hit.
          if (rc.autoContinue) {
            const errRate = segTotal > 0 ? segErrors / segTotal : 0;
            if (errRate > rc.abortThreshold) {
              const report = path.join(wsRoot, "RUN-ABORTED.md");
              try { fs.writeFileSync(report, runAbortedReport(errRate, segErrors, segTotal, runCount)); } catch {}
              logLine(`RUN-ABORTED err_rate=${errRate.toFixed(3)} errs=${segErrors} total=${segTotal}`);
              console.log(`halt:RUN-ABORTED worker_err_rate=${(errRate * 100).toFixed(1)}% report=${report}`);
              appendDecision(wsRoot, { tier: "RUN_ABORTED", decision: "Build halted: RUN-ABORTED", triggering_signal: `worker-err rate ${(errRate * 100).toFixed(1)}% > abort_threshold ${(rc.abortThreshold * 100).toFixed(0)}%` });
              notifyHalt("RUN-ABORTED", report);
              break;
            }
            runCount++;
            markProgress(); // a completed recovery iteration counts as progress
            if (runCount >= rc.maxRunCount) {
              console.log(`halt:max_run_count reached (${rc.maxRunCount}) with ${blockedCount} blocked fork(s) pending`);
              logLine(`halt max_run_count=${rc.maxRunCount} blocked=${blockedCount}`);
              break;
            }
            logLine(`auto-continue run=${runCount} reason=blocked_forks blocked=${blockedCount} errRate=${errRate.toFixed(2)}`);
            console.log(`auto-continue: run ${runCount} — deliberating ${blockedCount} blocked fork(s), ${rc.cooloffMin}min cooloff`);
            const recRes = triggerRecovery("blocked_forks");
            if (recRes && recRes.startsWith("halt:")) {
              console.log(`halt:recovery ${recRes.split(":").slice(0, 2).join(":")} — see SPEC-DEFECT.md`);
              logLine(`halt recovery=${recRes}`);
              break;
            }
            segErrors = 0; segTotal = 0;
            lastTransitionAt = Date.now();
            await new Promise(r => setTimeout(r, Math.max(0, rc.cooloffMin) * 60 * 1000));
            continue; // re-enter — merged forks return tasks to PLANNED
          }
          console.log(`done:complete_with_blocked:${detail}`);
          console.log(`hint: run 'node scripts/deliberate-fork.js --manifest-dir ${args.manifestDir} --store ${args.store} --all' to deliberate pending forks`);
        } else if (escalatedCount > 0) {
          console.log(`done:complete_with_escalations:${detail}`);
        } else {
          console.log(`ok:all tasks complete:${detail}`);
        }
      } else {
        console.log("ok:all tasks complete");
      }
      break;
    }
    if (batchResult.startsWith("err:")) {
      console.log(batchResult);
      break;
    }
    if (batchResult.startsWith("waiting:")) {
      console.log(batchResult);
      // If single-batch mode, exit and let orchestrator handle
      if (args.singleBatch) break;
      // Otherwise wait and retry
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    let taskIds;
    try {
      taskIds = JSON.parse(batchResult);
    } catch {
      console.log(`err:invalid batch result: ${batchResult}`);
      break;
    }

    if (taskIds.length === 0) {
      if (args.singleBatch) break;
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // Limit parallelism
    const batch = taskIds.slice(0, args.maxParallel);
    console.log(`batch:${batchNum}:dispatching ${batch.length} tasks: ${batch.join(", ")}`);

    // Lock all tasks in batch. A refused lock means the task is no longer
    // PLANNED (another dispatcher/worker owns it) — skip it so we never
    // spawn a duplicate worker for the same task.
    const lockedBatch = [];
    for (const taskId of batch) {
      const lockResult = run(`node ${path.join(SCRIPTS, "task-store.js")} lock --store ${args.store} --task-id ${shq(taskId)}`);
      if (!lockResult.startsWith("ok")) {
        logLine(`WARN lock-refused task=${taskId} result=${lockResult.slice(0, 200)}`);
        console.log(`warn: lock refused for ${taskId} (${lockResult.slice(0, 120)}) — skipping dispatch`);
        continue;
      }
      run(`node ${path.join(SCRIPTS, "task-store.js")} start --store ${args.store} --task-id ${shq(taskId)}`);
      lockedBatch.push(taskId);
    }

    // Dispatch workers in parallel
    const workerPromises = lockedBatch.map(async (taskId) => {
      const taskFile = getTaskSpec(args.manifestDir, taskId);
      if (!taskFile) {
        logLine(`ERROR task_spec_not_found task=${taskId}`);
        return { taskId, status: `err:task_spec_not_found:${taskId}` };
      }

      const outputPath = getOutputPath(taskFile);
      if (!outputPath) {
        logLine(`ERROR output_path_missing task=${taskId} taskFile=${taskFile}`);
        return { taskId, status: `err:output_path_missing`, taskFile };
      }
      const fullOutputPath = path.join(args.outputDir, outputPath);
      fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });

      // Per-task model override (set by promotion ladder in task-store.js
      // fail()/requeue() when haiku exhausts caps). Falls through to the
      // default workerModel when no override is present.
      const overrideModel = getWorkerOverride(args.store, taskId);
      const workerModel = overrideModel || args.workerModel;
      if (overrideModel) logLine(`worker-promoted task=${taskId} model=${overrideModel}`);

      // Dispatch worker. --module-paths binds the worker's cross-file imports
      // to the canonical symbol→file map (prevents orphan-import drift).
      const modulePathsFile = path.join(args.manifestDir, "module-paths.yaml");
      const mpArg = fs.existsSync(modulePathsFile) ? ` --module-paths ${modulePathsFile}` : "";
      const workerCmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
        `--persona coder ` +
        `--model ${workerModel} ` +
        `--task-file ${shq(taskFile)} ` +
        `--contracts-dir ${path.join(args.manifestDir, "contracts")} ` +
        `--output-file ${shq(fullOutputPath)}` +
        mpArg + ` ` +
        `--phase execution`;

      logLine(`worker-start task=${taskId} out=${fullOutputPath}`);
      const workerResult = await runAsync(workerCmd);

      if (workerResult.startsWith("err:")) {
        // Surface crash_reason (M3 §3.2) on the worker-err event when the
        // subagent classified one (err:exec:<crash_reason>:...).
        const crashMatch = workerResult.match(/^err:exec:([a-z_]+):/);
        const crashTag = crashMatch ? ` crash_reason=${crashMatch[1]}` : "";
        logLine(`worker-err task=${taskId}${crashTag} result=${workerResult.slice(0, 500)}`);
        return { taskId, status: workerResult, taskFile, outputPath: fullOutputPath };
      }

      // Normalize worker output: ensure raw YAML frontmatter is present,
      // and try to recover from chat-prose-style worker responses. Best-effort;
      // the validator is still the authoritative gate for correctness.
      const normCmd = `node ${path.join(SCRIPTS, "normalize-output.js")} ` +
        `--output-file ${shq(fullOutputPath)} ` +
        `--task-file ${shq(taskFile)} ` +
        `--worker-model ${workerModel}`;
      const normResult = run(normCmd);
      logLine(`normalize task=${taskId} ${normResult.slice(0, 300)}`);

      // Deterministic producer-symbol check (exact-name binding) BEFORE the LLM
      // schema-validator. If the emitted file exports a symbol under the wrong
      // name (e.g. ConfigStore vs the contract's IConfigStore), the locator
      // pinpoints it + the line, and a surgical `retry-update` (same coder
      // persona, minimal edit) fixes it — bounded retries, then normal failure.
      const psCheckJs = path.join(SCRIPTS, "producer-symbol-check.js");
      if (fs.existsSync(psCheckJs)) {
        const contractsDir = path.join(args.manifestDir, "contracts");
        const issuesFile = `${fullOutputPath}.symcheck.json`;
        const psCmd = `node ${psCheckJs} --task-file ${shq(taskFile)} --output-file ${shq(fullOutputPath)} --contracts-dir ${contractsDir} --issues-out ${shq(issuesFile)}`;
        let psResult = run(psCmd);
        let psAttempt = 0;
        while (psResult.startsWith("err:producer_symbol_missing") && psAttempt < 2) {
          psAttempt++;
          logLine(`producer-symbol-fix task=${taskId} attempt=${psAttempt} ${psResult.slice(0, 160)}`);
          const ruCmd = `node ${path.join(SCRIPTS, "subagent.js")} --persona coder --phase retry-update ` +
            `--task-file ${shq(taskFile)} --output-file ${shq(fullOutputPath)} --issues ${shq(issuesFile)} ` +
            `--contracts-dir ${contractsDir} --model ${workerModel}`;
          await runAsync(ruCmd);
          run(normCmd); // re-normalize after the surgical edit
          psResult = run(psCmd);
        }
        if (psResult.startsWith("err:")) {
          logLine(`producer-symbol-unresolved task=${taskId} result=${psResult.slice(0, 200)}`);
          return { taskId, status: `err:validation:producer_symbol:${psResult.slice(0, 200)}`, taskFile, outputPath: fullOutputPath };
        }
      }

      // Worker succeeded — run schema validation
      const validatorCmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
        `--persona schema-validator ` +
        `--model ${args.validatorModel} ` +
        `--validate-file ${shq(fullOutputPath)} ` +
        `--task-file ${shq(taskFile)} ` +
        `--contracts-dir ${path.join(args.manifestDir, "contracts")} ` +
        `--phase validation`;

      const validationResult = await runAsync(validatorCmd);

      if (validationResult.startsWith("err:")) {
        logLine(`validator-err task=${taskId} result=${validationResult.slice(0, 500)}`);
        return { taskId, status: `err:validation:${validationResult}`, taskFile, outputPath: fullOutputPath };
      }
      logLine(`task-ok task=${taskId}`);

      // If UI task: run UI validator (Sonnet) — same ok/err contract as schema-validator.
      if (isUITask(taskFile)) {
        const uiValCmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
          `--persona ui-validator ` +
          `--model ${args.integrationValidatorModel} ` +
          `--validate-file ${shq(fullOutputPath)} ` +
          `--task-file ${shq(taskFile)} ` +
          `--contracts-dir ${path.join(args.manifestDir, "contracts")} ` +
          `--phase validation`;

        const uiResult = await runAsync(uiValCmd);
        if (uiResult.startsWith("err:")) {
          logLine(`ui-validator-err task=${taskId} result=${uiResult.slice(0, 500)}`);
          return { taskId, status: `err:ui_validation:${uiResult}`, taskFile, outputPath: fullOutputPath };
        }
      }

      // If critical junction OR a high-fan-out producer (≥5 dependents), run
      // integration validation. The latter is M3 §3.3 producer pre-validation:
      // a producer whose output many consumers depend on is locally
      // contract-validated (deep, Sonnet) BEFORE its COMPLETE transition
      // unblocks them — a failure here returns err and routes through normal
      // failure handling, so broken producer output never reaches consumers.
      const dependentCount = countDependents(args.manifestDir, taskId);
      if (isCriticalJunction(args.manifestDir, taskId) || dependentCount >= 5) {
        if (dependentCount >= 5) logLine(`producer-prevalidation task=${taskId} dependents=${dependentCount}`);
        const intValCmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
          `--persona integration-validator ` +
          `--model ${args.integrationValidatorModel} ` +
          `--validate-file ${shq(fullOutputPath)} ` +
          `--task-file ${shq(taskFile)} ` +
          `--contracts-dir ${path.join(args.manifestDir, "contracts")} ` +
          `--phase validation`;

        const intResult = await runAsync(intValCmd);
        if (intResult.startsWith("err:")) {
          return { taskId, status: `err:integration_validation:${intResult}`, taskFile, outputPath: fullOutputPath };
        }
      }

      return { taskId, status: "ok", taskFile, outputPath: fullOutputPath, filePath: outputPath };
    });

    const results = await Promise.all(workerPromises);

    // Process results in two phases:
    //   Phase 1 — fast, sequential: complete-or-fail decisions and a quick
    //     verification of the COMPLETE writes. Builds the list of escalation
    //     candidates without blocking on any of them.
    //   Phase 2 — parallel: dispatch all escalation handlers concurrently
    //     via Promise.all, then apply their decisions to the store.
    let completed = 0;
    let failed = 0;
    let escalated = 0;
    let blocked = 0;
    const escalationCandidates = [];

    for (const result of results) {
      if (result.status === "ok") {
        const completeRes = run(`node ${path.join(SCRIPTS, "task-store.js")} complete --store ${args.store} --task-id ${shq(result.taskId)}`);
        const verifyState = JSON.parse(fs.readFileSync(args.store, "utf-8"));
        const taskAfter = verifyState.tasks[result.taskId];
        if (!taskAfter || taskAfter.status !== "COMPLETE") {
          logLine(`WARN complete-verify-failed task=${result.taskId} status=${taskAfter && taskAfter.status} retry=once completeRes=${completeRes}`);
          run(`node ${path.join(SCRIPTS, "task-store.js")} complete --store ${args.store} --task-id ${shq(result.taskId)}`);
          const verify2 = JSON.parse(fs.readFileSync(args.store, "utf-8"));
          if (!verify2.tasks[result.taskId] || verify2.tasks[result.taskId].status !== "COMPLETE") {
            logLine(`ERROR complete-failed-after-retry task=${result.taskId} status=${verify2.tasks[result.taskId] && verify2.tasks[result.taskId].status}`);
          }
        }
        if (result.filePath) {
          const contracts = result.taskFile ? getTaskContracts(result.taskFile) : { produced: [], consumed: [] };
          updateWiki(wikiDir, result.taskId, result.filePath, contracts);
        }

        // Deferred contract-symmetry check (binding-rule enforcement).
        // On this task's COMPLETE transition, sweep peers across every contract
        // it references. For peers that are also COMPLETE, verify the declared
        // invokes/implements still satisfy the symmetry rule. Drift on either
        // side blocks the drifted task (NOT the just-completed task if its own
        // declarations + emitted file passed all local checks at validation
        // time) and routes to fork via task-store.js block.
        try {
          const drifts = runDeferredSymmetryChecks(args.manifestDir, args.store, result.taskId, logLine);
          for (const d of drifts) {
            const driftedState = JSON.parse(fs.readFileSync(args.store, "utf-8"));
            const driftedTaskState = driftedState.tasks[d.drifted_task_id];
            if (driftedTaskState && driftedTaskState.status === "COMPLETE") {
              // The drifted task is COMPLETE but its declarations don't match
              // what producers actually claim to implement (or vice versa).
              // Block it and let triage/deliberate-fork sort the contract drift.
              logLine(`SYMMETRY_BLOCK task=${d.drifted_task_id} reason=${d.reason}`);
              run(`node ${path.join(SCRIPTS, "task-store.js")} block --store ${args.store} --task-id ${shq(d.drifted_task_id)} --reason ${shq("symmetry_drift:" + d.contract_id + ":" + d.symbol)}`);
            }
          }
        } catch (e) {
          // Never let a symmetry-check bug abort the execution loop.
          logLine(`WARN symmetry-check-failed task=${result.taskId} err=${e.message}`);
        }

        completed++;
      } else if (result.status.includes("err:ambiguity") || result.status.includes("err:scope") || result.status.includes("err:missing_input")) {
        const envelopeDir = path.join(args.outputDir, "../store/escalations");
        fs.mkdirSync(envelopeDir, { recursive: true });
        const envelopeFile = path.join(envelopeDir, `${result.taskId}.yaml`);

        // Build a rich envelope per manifest-schema.md "Escalation Envelope".
        // On retry, APPEND a new attempt block instead of clobbering — the
        // history of all attempts is what makes the handler effective.
        const verifyState = JSON.parse(fs.readFileSync(args.store, "utf-8"));
        const taskState = verifyState.tasks[result.taskId] || {};
        const workerId = taskState.locked_by || "worker-unknown";
        const contracts = result.taskFile ? getTaskContracts(result.taskFile) : { produced: [], consumed: [] };
        const relevantContracts = [...(contracts.produced || []), ...(contracts.consumed || [])];

        // Best-effort context_snippet: first ~600 chars of the task spec.
        let contextSnippet = "";
        if (result.taskFile && fs.existsSync(result.taskFile)) {
          try { contextSnippet = fs.readFileSync(result.taskFile, "utf-8").slice(0, 600); } catch {}
        }

        // Classify escalation_type from the error string.
        let escType = "AMBIGUITY";
        if (result.status.includes("err:scope")) escType = "SCOPE_QUESTION";
        else if (result.status.includes("err:missing_input")) escType = "DEPENDENCY_MISSING";
        else if (result.status.includes("err:contract")) escType = "CONTRACT_CONFLICT";

        const attempt = {
          attempt_at: new Date().toISOString(),
          worker_id: workerId,
          attempted_action: `coder dispatch on ${result.taskFile || "unknown"}`,
          ambiguity_description: result.status,
          // The worker did not return options in the err string today; leave empty
          // so the handler sees a clear "no options provided" signal.
          options: [],
        };

        // Read previous envelope and preserve attempts[] so the handler sees history.
        let priorAttempts = [];
        if (fs.existsSync(envelopeFile)) {
          try {
            const prior = fs.readFileSync(envelopeFile, "utf-8");
            // Heuristic: each attempt block begins with "  - attempt_at:".
            const blocks = prior.split(/^\s*-\s+attempt_at:/m).slice(1);
            for (const b of blocks) {
              priorAttempts.push("  - attempt_at:" + b.replace(/\n+$/, ""));
            }
          } catch {}
        }

        // Repeat-signature heuristic: normalize (trim, lowercase, first 200 chars)
        // the latest ambiguity_description and compare against priors.
        const normSig = (s) => String(s || "").trim().toLowerCase().slice(0, 200);
        const latestSig = normSig(attempt.ambiguity_description);
        const repeatSignature = priorAttempts.some(pa => {
          const m = pa.match(/ambiguity_description:\s*(.*)$/m);
          if (!m) return false;
          let val = m[1].trim();
          // Strip surrounding JSON quotes if present.
          if (val.startsWith('"') && val.endsWith('"')) {
            try { val = JSON.parse(val); } catch {}
          }
          return normSig(val) === latestSig && latestSig.length > 0;
        });

        let envelope = "";
        envelope += `task_id: ${JSON.stringify(result.taskId)}\n`;
        envelope += `worker_id: ${JSON.stringify(workerId)}\n`;
        envelope += `escalation_type: ${escType}\n`;
        envelope += `attempted_action: ${JSON.stringify(attempt.attempted_action)}\n`;
        envelope += `ambiguity_description: ${JSON.stringify(attempt.ambiguity_description)}\n`;
        envelope += `repeat_signature: ${repeatSignature}\n`;
        envelope += `options: []\n`;
        envelope += `relevant_contracts:\n`;
        if (relevantContracts.length === 0) {
          envelope += `  []\n`;
        } else {
          for (const c of relevantContracts) envelope += `  - ${JSON.stringify(c)}\n`;
        }
        envelope += `context_snippet: ${JSON.stringify(contextSnippet)}\n`;
        envelope += `attempts:\n`;
        for (const pa of priorAttempts) envelope += pa + "\n";
        envelope += `  - attempt_at: ${JSON.stringify(attempt.attempt_at)}\n`;
        envelope += `    worker_id: ${JSON.stringify(attempt.worker_id)}\n`;
        envelope += `    attempted_action: ${JSON.stringify(attempt.attempted_action)}\n`;
        envelope += `    ambiguity_description: ${JSON.stringify(attempt.ambiguity_description)}\n`;
        fs.writeFileSync(envelopeFile, envelope);
        escalationCandidates.push({ taskId: result.taskId, envelopeFile, taskFile: result.taskFile, repeatSignature, attemptCount: priorAttempts.length + 1 });
      } else {
        run(`node ${path.join(SCRIPTS, "task-store.js")} fail --store ${args.store} --task-id ${result.taskId} --reason ${shq(result.status.slice(0, 500))}`);
        failed++;
        // The fail() action handles the promotion ladder internally and may
        // have transitioned the task to BLOCKED (caps exhausted on sonnet).
        // Detect and trigger fork + cascade.
        const postFailStatus = getTaskStatus(args.store, result.taskId);
        if (postFailStatus === "BLOCKED") {
          logLine(`auto-block-from-fail task=${result.taskId}`);
          blockOriginator(args.manifestDir, args.store, result.taskId, logLine);
        }
      }
    }

    // ── Escalation phase: run handlers in parallel ──
    if (escalationCandidates.length > 0) {
      logLine(`escalation-batch dispatching=${escalationCandidates.length}`);
      const escPromises = escalationCandidates.map(async (e) => {
        const taskFileArg = e.taskFile ? ` --task-file ${e.taskFile}` : "";
        const escCmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
          `--persona escalation-handler ` +
          `--model ${args.escalationModel} ` +
          `--escalation-envelope ${e.envelopeFile} ` +
          `--manifest-dir ${args.manifestDir}` +
          taskFileArg +
          ` --phase escalation`;
        const escResult = await runAsync(escCmd);
        return { ...e, escResult };
      });
      const escResults = await Promise.all(escPromises);

      for (const e of escResults) {
        // Repeat-signature circuit breaker: if the handler returned `ok` but
        // the worker has already failed >=2 times with the same error string,
        // treat as definitionally structural and force a BLOCKED transition.
        if (e.escResult === "ok" && e.attemptCount >= 2 && e.repeatSignature) {
          logLine(`escalation-decision task=${e.taskId} decision=block_from_circuit_breaker reason=repeat_signature attempts=${e.attemptCount}`);
          blockOriginator(args.manifestDir, args.store, e.taskId, logLine);
          blocked++;
          continue;
        }
        if (e.escResult === "ok") {
          // Handler approved a retry path — requeue with retry_count reset
          // so the task is not immediately re-escalated by the 3-strike rule.
          // requeue() may itself transition to BLOCKED (cap exhausted on sonnet).
          run(`node ${path.join(SCRIPTS, "task-store.js")} requeue --store ${args.store} --task-id ${e.taskId} --reason ${shq("escalation_resolved_retry")}`);
          logLine(`escalation-decision task=${e.taskId} decision=requeue`);
          failed++; // counted as "needs-retry" in the batch summary
          const postReqStatus = getTaskStatus(args.store, e.taskId);
          if (postReqStatus === "BLOCKED") {
            logLine(`auto-block-from-requeue task=${e.taskId}`);
            blockOriginator(args.manifestDir, args.store, e.taskId, logLine);
            blocked++;
          }
        } else if (e.escResult === "err:escalate_to_director") {
          // Handler explicitly punts to the council — bypass the promotion
          // ladder (handler's verdict overrides). Mark BLOCKED + cascade +
          // mint a fork. NOT ESCALATED (per BLOCKED-STATE-PLAN §4 + #9).
          logLine(`escalation-decision task=${e.taskId} decision=block_from_handler`);
          blockOriginator(args.manifestDir, args.store, e.taskId, logLine);
          blocked++;
        } else {
          // Other handler errors (timeout, no terminal token, api err) —
          // preserve legacy behavior: mark ESCALATED for manual review.
          run(`node ${path.join(SCRIPTS, "task-store.js")} escalate --store ${args.store} --task-id ${e.taskId}`);
          logLine(`escalation-decision task=${e.taskId} decision=escalate result=${(e.escResult || "").slice(0, 200)}`);
          escalated++;
        }
      }
    }

    // M4 §4.1 — accumulate worker-error accounting for this run segment so the
    // auto-continue abort-threshold check has a denominator.
    segTotal += lockedBatch.length;
    segErrors += (failed + escalated + blocked);

    console.log(`batch:${batchNum}:results: completed=${completed} failed=${failed} escalated=${escalated} blocked=${blocked}`);
    if (blocked > 0) {
      console.log(`hint: run 'node scripts/deliberate-fork.js --manifest-dir ${args.manifestDir} --store ${args.store} --all' to deliberate pending forks`);
    }
    
    // Print overall status
    const statusResult = run(`node ${path.join(SCRIPTS, "task-store.js")} status --store ${args.store}`);
    console.log(`status: ${statusResult}`);

    if (args.singleBatch) break;

    // Small delay between batches
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Export pure helpers for unit testing; only run the loop when invoked directly.
module.exports = { computeCeiling, countDependents, resolveRunConfig, readCounts, extractListField };

if (require.main === module) {
  main().catch(e => {
    console.log(`err:execution_loop:${e.message}`);
    process.exit(1);
  });
}
