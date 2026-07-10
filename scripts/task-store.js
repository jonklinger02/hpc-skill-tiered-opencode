#!/usr/bin/env node
/**
 * task-store.js — File-based task store with Redis-like semantics
 *
 * Usage:
 *   node task-store.js init --manifest-dir <dir> --store <state.json>
 *   node task-store.js status --store <state.json>
 *   node task-store.js lock --store <state.json> --task-id <id> --worker <id>
 *   node task-store.js complete --store <state.json> --task-id <id>
 *   node task-store.js fail --store <state.json> --task-id <id> --reason <text>
 *   node task-store.js escalate --store <state.json> --task-id <id> --envelope <file>
 *   node task-store.js reset-stale --store <state.json> --timeout <minutes>
 *   node task-store.js batch --store <state.json> --manifest-dir <dir>
 *   node task-store.js block --store <state.json> --task-id <id> [--upstream <id>] [--fork-id <id>]
 *   node task-store.js promote-worker --store <state.json> --task-id <id> --model <name>
 *   node task-store.js merge-fork --store <state.json> --fork-id <id>
 */

// Default model used when promoting from haiku → sonnet on retry/requeue cap.
// Tier token (resolved by scripts/lib/models.js at spawn time), not a literal
// id — so the whole promotion ladder re-points from models.yaml.
const PROMOTED_WORKER_MODEL = "worker_promoted";

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { action: args[0] };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--store": parsed.store = args[++i]; break;
      case "--task-id": parsed.taskId = args[++i]; break;
      case "--worker": parsed.worker = args[++i]; break;
      case "--reason": parsed.reason = args[++i]; break;
      case "--envelope": parsed.envelope = args[++i]; break;
      case "--timeout": parsed.timeout = parseInt(args[++i]); break;
      case "--upstream": parsed.upstream = args[++i]; break;
      case "--fork-id": parsed.forkId = args[++i]; break;
      case "--model": parsed.model = args[++i]; break;
    }
  }
  return parsed;
}

// Exclusive file lock via O_EXCL lockfile. Retries with backoff up to ~6 seconds.
// Returns lock-fd or throws on timeout.
function acquireLock(storeFile) {
  const lockFile = storeFile + ".lock";
  const deadline = Date.now() + 6000;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `pid=${process.pid} t=${Date.now()}`);
      return { fd, lockFile };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Stale-lock recovery: if lockfile is older than 30s, remove it.
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 30000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      attempt++;
      const sleep = Math.min(50 * Math.pow(1.5, attempt), 500);
      const end = Date.now() + sleep;
      while (Date.now() < end) {} // busy-wait — sync to keep semantics simple
    }
  }
  throw new Error("lock_timeout: could not acquire " + lockFile);
}

function releaseLock(handle) {
  try { fs.closeSync(handle.fd); } catch {}
  try { fs.unlinkSync(handle.lockFile); } catch {}
}

// Atomic read-modify-write under exclusive file lock. Replaces the prior OCC
// implementation, which had a TOCTOU race and silently dropped writes when two
// processes/promises updated near-simultaneously.
function atomicUpdate(storeFile, updateFn) {
  const handle = acquireLock(storeFile);
  try {
    const content = fs.readFileSync(storeFile, "utf-8");
    const state = JSON.parse(content);
    const originalVersion = state._version || 0;

    const result = updateFn(state);

    state._version = originalVersion + 1;
    state.last_updated = new Date().toISOString();
    const tmp = storeFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, storeFile);

    return { error: null, result };
  } finally {
    releaseLock(handle);
  }
}

// Extract task IDs from manifest
function extractTaskIds(manifestDir) {
  const tasksDir = path.join(manifestDir, "tasks");
  const taskIds = [];
  
  if (!fs.existsSync(tasksDir)) return taskIds;
  
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith(".yaml")) continue;
    const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
    const match = content.match(/^task_id:\s*"?([^"\n]+)"?/m);
    if (match) taskIds.push(match[1].trim());
  }
  
  return taskIds;
}

// ── Commands ──

function init(args) {
  const taskIds = extractTaskIds(args.manifestDir);
  
  if (taskIds.length === 0) {
    console.log("err:no tasks found in manifest");
    process.exit(1);
  }

  const state = {
    _version: 1,
    initialized_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    tasks: {},
    batch_history: [],
  };

  for (const id of taskIds) {
    state.tasks[id] = {
      status: "PLANNED",
      version: 1,
      locked_by: null,
      locked_at: null,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      validation_result: null,
      escalation_history: [],
      worker_model_override: null,
      blocked_at: null,
      blocked_by_upstream: null,
      assigned_fork_id: null,
    };
  }

  const storeDir = path.dirname(args.store);
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(args.store, JSON.stringify(state, null, 2));
  
  console.log(`ok:${taskIds.length} tasks loaded`);
}

function status(args) {
  const state = JSON.parse(fs.readFileSync(args.store, "utf-8"));
  const counts = { PLANNED: 0, LOCKED: 0, IN_PROGRESS: 0, REVIEW: 0, COMPLETE: 0, ESCALATED: 0, BLOCKED: 0, INVALIDATED: 0 };
  
  for (const task of Object.values(state.tasks)) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`);
  
  console.log(`[${parts.join("] [")}] total:${total}`);
}

function lock(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    if (task.status !== "PLANNED") return `cannot_lock:current_status=${task.status}`;

    task.status = "LOCKED";
    task.locked_by = args.worker || "worker-" + Date.now();
    task.locked_at = new Date().toISOString();
    task.version++;
    return "ok";
  });

  console.log(result === "ok" ? "ok" : `err:${result}`);
}

function startTask(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.status = "IN_PROGRESS";
    task.started_at = new Date().toISOString();
    task.version++;
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

function complete(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.status = "COMPLETE";
    task.completed_at = new Date().toISOString();
    task.validation_result = "ok";
    task.version++;
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

// Normalize an error string so "same error" means "same underlying problem":
// strip timestamps, file paths, and bare numbers (line/col, pids, ports) that
// vary run-to-run. Used by the early-promotion check in fail().
function normalizeError(s) {
  return String(s || "")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.,z+-]+/gi, "<ts>")
    .replace(/\/[^\s:'"]+/g, "<path>")
    .replace(/\b\d+\b/g, "N")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function fail(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.status = "PLANNED"; // Back to planned for retry
    task.retry_count++;
    task.locked_by = null;
    task.locked_at = null;
    task.validation_result = args.reason || "validation_failed";
    task.version++;

    // Record error history for the early-promotion signature check (M3 §3.4).
    task.error_history = task.error_history || [];
    task.error_history.push({ timestamp: new Date().toISOString(), error: args.reason || "validation_failed" });

    // Promotion ladder: try sonnet before transitioning to BLOCKED. Caller
    // (execute.js) is responsible for the cascade after BLOCKED.
    const promote = () => {
      if (!task.worker_model_override) {
        task.worker_model_override = PROMOTED_WORKER_MODEL;
        task.retry_count = 0;
        task.requeue_count = 0;
        // status already PLANNED above
      } else {
        task.status = "BLOCKED";
        task.blocked_at = new Date().toISOString();
      }
    };

    // Early promotion (M3 §3.4): if the two most recent attempts produced the
    // SAME normalized error, the worker is stuck on one underlying problem —
    // promote now instead of burning the full 3-strike budget on a repeat.
    // Different consecutive errors mean the worker is making progress; let the
    // 3-strike count finish.
    const recent = task.error_history.slice(-2);
    if (recent.length === 2 && normalizeError(recent[0].error) === normalizeError(recent[1].error)) {
      promote();
      return "ok";
    }

    if (task.retry_count >= 3) {
      promote();
    }
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

// Escalation-decision-driven re-queue: PLANNED with retry_count reset.
// Distinct from fail() because fail() counts toward the 3-strike auto-escalate
// threshold. After an escalation handler decides "retry with clarification",
// the task deserves a fresh budget — not an immediate re-escalate.
//
// Cap: requeue_count >= REQUEUE_MAX → ESCALATED instead. Prevents the
// requeue→worker-err→requeue dead-end loop when the handler keeps deciding
// "retry" but the worker can't actually make progress (missing inputs that
// don't exist in the manifest, capability gaps in batch mode, etc.).
const REQUEUE_MAX = 2;
function requeue(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.requeue_count = (task.requeue_count || 0) + 1;
    if (task.requeue_count > REQUEUE_MAX) {
      // Promotion ladder: try sonnet before BLOCKED. Caller is responsible
      // for the cascade once the task transitions to BLOCKED.
      if (!task.worker_model_override) {
        task.worker_model_override = PROMOTED_WORKER_MODEL;
        task.status = "PLANNED";
        task.retry_count = 0;
        task.requeue_count = 0;
        task.locked_by = null;
        task.locked_at = null;
        task.validation_result = args.reason || "promoted_to_sonnet_after_requeue_cap";
        task.version++;
        return "ok";
      }
      task.status = "BLOCKED";
      task.blocked_at = new Date().toISOString();
      task.escalation_history = task.escalation_history || [];
      task.escalation_history.push({
        timestamp: new Date().toISOString(),
        envelope: "auto:requeue_cap_exceeded_after_promotion",
      });
      task.version++;
      return "ok";
    }
    task.status = "PLANNED";
    task.retry_count = 0;
    task.locked_by = null;
    task.locked_at = null;
    task.validation_result = args.reason || "requeued_by_escalation_decision";
    task.version++;
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

function escalate(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.status = "ESCALATED";
    task.escalation_history.push({
      timestamp: new Date().toISOString(),
      envelope: args.envelope || "unknown",
    });
    task.version++;
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

function resetStale(args) {
  // Use nullish guard rather than `||` so a caller-supplied 0 (immediate
  // reset, useful in tests/cleanup) is honoured instead of silently falling
  // back to the 30-minute default.
  const timeoutMin = (args.timeout != null && !Number.isNaN(args.timeout)) ? args.timeout : 30;
  const timeout = timeoutMin * 60 * 1000; // minutes to ms
  let resetCount = 0;
  
  atomicUpdate(args.store, (state) => {
    const now = Date.now();
    for (const [id, task] of Object.entries(state.tasks)) {
      // BLOCKED tasks are awaiting fork deliberation — never reset them.
      if (task.status === "BLOCKED") continue;
      if (task.status === "IN_PROGRESS" || task.status === "LOCKED") {
        const lockTime = task.locked_at ? new Date(task.locked_at).getTime() : 0;
        if (now - lockTime > timeout) {
          task.status = "PLANNED";
          task.locked_by = null;
          task.locked_at = null;
          task.version++;
          resetCount++;
        }
      }
    }
  });
  
  console.log(`ok:reset ${resetCount} stale tasks`);
}

// Mark a task BLOCKED. If --upstream is set, this is a cascaded block (downstream
// of the originator); the supplied --fork-id is inherited. If no --upstream is
// set, the task is the originator and a new fork_id is minted unless one is
// supplied explicitly (allows execute.js to mint via fork-manifest.js then pass in).
function block(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.status = "BLOCKED";
    task.blocked_at = new Date().toISOString();
    task.locked_by = null;
    task.locked_at = null;
    if (args.upstream) {
      task.blocked_by_upstream = args.upstream;
    }
    if (args.reason) {
      // Recorded so triage / deliberate-fork can route on the cause.
      // Common reason prefixes used by the orchestrator:
      //   "symmetry_drift:<contract_id>:<symbol>" — deferred binding check failed
      //   "validation:<category>:<detail>"        — per-task validator failed
      task.blocked_reason = args.reason;
    }
    task.assigned_fork_id = args.forkId || `FORK-${args.taskId}-${Date.now()}`;
    task.version++;
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

// Promote the worker model for a task (caller-driven; the promotion ladder in
// fail()/requeue() does this automatically, but execute.js or operators may
// want to force a promotion explicitly).
function promoteWorker(args) {
  const { result } = atomicUpdate(args.store, (state) => {
    const task = state.tasks[args.taskId];
    if (!task) return "task_not_found";
    task.worker_model_override = args.model || PROMOTED_WORKER_MODEL;
    task.retry_count = 0;
    task.requeue_count = 0;
    task.status = "PLANNED";
    task.locked_by = null;
    task.locked_at = null;
    task.version++;
    return "ok";
  });
  console.log(result === "ok" ? "ok" : `err:${result}`);
}

// Flip every task assigned to <fork-id> back to PLANNED, clearing block + override.
function mergeFork(args) {
  let count = 0;
  atomicUpdate(args.store, (state) => {
    for (const task of Object.values(state.tasks)) {
      if ((task.assigned_fork_id || null) !== args.forkId) continue;
      task.status = "PLANNED";
      task.retry_count = 0;
      task.requeue_count = 0;
      task.worker_model_override = null;
      task.blocked_at = null;
      task.blocked_by_upstream = null;
      task.assigned_fork_id = null;
      task.locked_by = null;
      task.locked_at = null;
      task.version++;
      count++;
    }
  });
  console.log(`ok:merged ${count} tasks`);
}

function batch(args) {
  // Compute next executable batch using DAG
  const { execSync } = require("child_process");
  try {
    const result = execSync(
      `node ${path.join(__dirname, "dag.js")} --manifest-dir ${args.manifestDir} --next-batch ${args.store} --level task`,
      { encoding: "utf-8" }
    ).trim();
    
    const taskIds = JSON.parse(result);
    if (taskIds.length === 0) {
      // Check if all done or stuck
      const state = JSON.parse(fs.readFileSync(args.store, "utf-8"));
      const planned = Object.values(state.tasks).filter(t => t.status === "PLANNED").length;
      const inProgress = Object.values(state.tasks).filter(t => t.status === "IN_PROGRESS" || t.status === "LOCKED").length;
      const escalated = Object.values(state.tasks).filter(t => t.status === "ESCALATED").length;
      const blocked = Object.values(state.tasks).filter(t => t.status === "BLOCKED").length;
      const complete = Object.values(state.tasks).filter(t => t.status === "COMPLETE").length;

      if (planned === 0 && inProgress === 0) {
        // Surface escalation + blocked counts so the orchestrator can distinguish
        // a clean finish from finish-with-permanent-failures or finish-pending-fork.
        console.log(`done:complete=${complete} escalated=${escalated} blocked=${blocked}`);
      } else if (planned > 0 && inProgress === 0) {
        console.log("err:deadlock:planned tasks exist but none are eligible");
      } else {
        console.log("waiting:" + inProgress + " tasks in progress");
      }
    } else {
      console.log(JSON.stringify(taskIds));
    }
  } catch (e) {
    console.log(`err:batch_computation_failed:${e.message}`);
  }
}

// ── Main ──
function main() {
  const args = parseArgs();
  
  switch (args.action) {
    case "init": init(args); break;
    case "status": status(args); break;
    case "lock": lock(args); break;
    case "start": startTask(args); break;
    case "complete": complete(args); break;
    case "fail": fail(args); break;
    case "requeue": requeue(args); break;
    case "escalate": escalate(args); break;
    case "reset-stale": resetStale(args); break;
    case "batch": batch(args); break;
    case "block": block(args); break;
    case "promote-worker": promoteWorker(args); break;
    case "merge-fork": mergeFork(args); break;
    default:
      console.log(`err:unknown action: ${args.action}`);
      process.exit(1);
  }
}

main();
