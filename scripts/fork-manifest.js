#!/usr/bin/env node
/**
 * fork-manifest.js — Manifest fork lifecycle: create / list / merge.
 *
 * A "fork" is a snapshot of the manifest slice (one originating task + its
 * referenced contracts + parent epic) plus an `origin.yaml` describing the
 * problem. The deliberate-fork.js script consumes pending forks, dispatches
 * a council, and writes amended artifacts under `<fork>/amended/`. The merge
 * action splices those amendments back into the live manifest and unblocks
 * the affected tasks.
 *
 * Usage:
 *   node fork-manifest.js create --task-id <X> --store <s> --manifest-dir <m>
 *   node fork-manifest.js list   --manifest-dir <m> [--pending|--resolved]
 *   node fork-manifest.js merge  --fork-id <id> --manifest-dir <m> --store <s>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SCRIPTS = path.resolve(__dirname);

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { action: args[0] };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--task-id": parsed.taskId = args[++i]; break;
      case "--store": parsed.store = args[++i]; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--fork-id": parsed.forkId = args[++i]; break;
      case "--pending": parsed.filter = "pending"; break;
      case "--resolved": parsed.filter = "resolved"; break;
      case "--logs-dir": parsed.logsDir = args[++i]; break;
    }
  }
  return parsed;
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch (e) {
    return `err:exec:${e.message.slice(0, 200)}`;
  }
}

// ── Helpers ──

function readTaskFile(manifestDir, taskId) {
  const file = path.join(manifestDir, "tasks", `${taskId}.yaml`);
  if (!fs.existsSync(file)) return null;
  return { file, content: fs.readFileSync(file, "utf-8") };
}

function extractListField(content, field) {
  const stripComment = (s) => s.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const inlineRe = new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]\\s*(?:#.*)?$`, "m");
  const inline = content.match(inlineRe);
  if (inline) {
    const inner = inline[1].trim();
    if (inner === "") return [];
    return inner.split(",").map(stripComment).filter(Boolean);
  }
  const blockRe = new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s*.+\\n?)*)`, "m");
  const block = content.match(blockRe);
  if (!block) return [];
  return (block[1].match(/^\s+-\s*.+/gm) || [])
    .map(l => stripComment(l.replace(/^\s+-\s*/, "")))
    .filter(Boolean);
}

function extractScalar(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"));
  return m ? m[1].trim() : null;
}

function extractTaskId(content) {
  return extractScalar(content, "task_id");
}

function extractEpicId(content) {
  return extractScalar(content, "epic_id");
}

function extractFilePath(content) {
  return extractScalar(content, "file_path");
}

// Best-effort: scan execute-logs/ for lines mentioning the task and return the
// last N (default 20). Used for origin.yaml error_history.
function collectErrorHistory(workspaceRoot, taskId, maxLines = 20) {
  const logDir = path.join(workspaceRoot, "execute-logs");
  if (!fs.existsSync(logDir)) return [];
  const lines = [];
  for (const f of fs.readdirSync(logDir).sort()) {
    if (!f.endsWith(".log")) continue;
    let content;
    try { content = fs.readFileSync(path.join(logDir, f), "utf-8"); } catch { continue; }
    for (const line of content.split("\n")) {
      if (line.includes(taskId) && (line.includes("err") || line.includes("validator") || line.includes("escalation"))) {
        lines.push(line);
      }
    }
  }
  return lines.slice(-maxLines);
}

// Compute affected slice (ancestors + descendants of taskId) and the set of
// distinct epic_ids those tasks belong to. Returns { sliceTaskIds, epicIds }.
function computeAffectedSlice(manifestDir, taskId) {
  const ancestorsRaw = run(`node ${path.join(SCRIPTS, "dag.js")} --manifest-dir ${manifestDir} --ancestors ${taskId} --level task`);
  const descendantsRaw = run(`node ${path.join(SCRIPTS, "dag.js")} --manifest-dir ${manifestDir} --descendants ${taskId} --level task`);
  let ancestors = [];
  let descendants = [];
  try { ancestors = JSON.parse(ancestorsRaw); } catch {}
  try { descendants = JSON.parse(descendantsRaw); } catch {}
  const sliceTaskIds = new Set([taskId, ...ancestors, ...descendants]);

  const epicIds = new Set();
  const tasksDir = path.join(manifestDir, "tasks");
  for (const tid of sliceTaskIds) {
    const tf = path.join(tasksDir, `${tid}.yaml`);
    if (!fs.existsSync(tf)) continue;
    const ep = extractEpicId(fs.readFileSync(tf, "utf-8"));
    if (ep) epicIds.add(ep);
  }
  return { sliceTaskIds: [...sliceTaskIds], epicIds: [...epicIds] };
}

// ── Commands ──

function create(args) {
  if (!args.taskId || !args.store || !args.manifestDir) {
    console.log("err:missing required args (--task-id, --store, --manifest-dir)");
    process.exit(1);
  }

  const taskRec = readTaskFile(args.manifestDir, args.taskId);
  if (!taskRec) {
    console.log(`err:task_spec_not_found:${args.taskId}`);
    process.exit(1);
  }

  const forkId = `FORK-${args.taskId}-${Date.now()}`;
  const forksRoot = path.join(args.manifestDir, "forks");
  const forkDir = path.join(forksRoot, forkId);
  fs.mkdirSync(forkDir, { recursive: true });
  fs.mkdirSync(path.join(forkDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(forkDir, "epics"), { recursive: true });
  fs.mkdirSync(path.join(forkDir, "contracts"), { recursive: true });

  // 1. Copy originating task spec
  fs.copyFileSync(taskRec.file, path.join(forkDir, "tasks", path.basename(taskRec.file)));

  // 2. Copy parent epic
  const epicId = extractEpicId(taskRec.content);
  if (epicId) {
    const epicFile = path.join(args.manifestDir, "epics", `${epicId}.yaml`);
    if (fs.existsSync(epicFile)) {
      fs.copyFileSync(epicFile, path.join(forkDir, "epics", `${epicId}.yaml`));
    }
  }

  // 3. Copy referenced contracts
  const consumed = extractListField(taskRec.content, "contracts_consumed");
  const produced = extractListField(taskRec.content, "contracts_produced");
  const contractIds = [...new Set([...consumed, ...produced])];
  for (const cid of contractIds) {
    const cf = path.join(args.manifestDir, "contracts", `${cid}.yaml`);
    if (fs.existsSync(cf)) {
      fs.copyFileSync(cf, path.join(forkDir, "contracts", `${cid}.yaml`));
    }
  }

  // 4. Compute affected slice for council tier picker
  const { sliceTaskIds, epicIds } = computeAffectedSlice(args.manifestDir, args.taskId);
  const councilTier = epicIds.length > 1 ? "csuite" : "director";

  // 5. Determine originating area from task_id pattern (TASK-{AREA}-...)
  let originatingArea = null;
  const areaM = args.taskId.match(/^(?:TASK-)?([A-Z]+)/);
  if (areaM) originatingArea = areaM[1];

  // 6. Collect error history from execute-logs/ (workspace root inferred from
  //    manifest-dir's parent — same convention execute.js uses).
  const workspaceRoot = args.logsDir
    ? path.resolve(args.logsDir, "..")
    : path.resolve(args.manifestDir, "..");
  const errorHistory = collectErrorHistory(workspaceRoot, args.taskId);

  // 7. Write origin.yaml (hand-rolled to avoid YAML dep — same pattern as
  //    execute.js's wiki writers and escalation envelope writer).
  let origin = "";
  origin += `fork_id: "${forkId}"\n`;
  origin += `originating_task_id: "${args.taskId}"\n`;
  if (epicId) origin += `originating_epic_id: "${epicId}"\n`;
  if (originatingArea) origin += `originating_area: "${originatingArea}"\n`;
  origin += `fork_created_at: "${new Date().toISOString()}"\n`;
  origin += `council_tier: "${councilTier}"\n`;
  origin += `affected_epic_ids:\n`;
  for (const e of epicIds.sort()) origin += `  - "${e}"\n`;
  if (epicIds.length === 0) origin += `  []\n`;
  origin += `affected_task_ids:\n`;
  for (const t of sliceTaskIds.sort()) origin += `  - "${t}"\n`;
  if (sliceTaskIds.length === 0) origin += `  []\n`;
  origin += `referenced_contract_ids:\n`;
  for (const c of contractIds.sort()) origin += `  - "${c}"\n`;
  if (contractIds.length === 0) origin += `  []\n`;
  origin += `error_history:\n`;
  if (errorHistory.length === 0) {
    origin += `  []\n`;
  } else {
    for (const line of errorHistory) {
      origin += `  - ${JSON.stringify(line)}\n`;
    }
  }
  origin += `status: "pending"\n`;
  fs.writeFileSync(path.join(forkDir, "origin.yaml"), origin);

  // 8. Output: <fork_id>\t<fork_dir>
  process.stdout.write(`${forkId}\t${forkDir}\n`);
}

function list(args) {
  if (!args.manifestDir) {
    console.log("err:missing --manifest-dir");
    process.exit(1);
  }
  const forksRoot = path.join(args.manifestDir, "forks");
  if (!fs.existsSync(forksRoot)) {
    console.log("[]");
    return;
  }
  const out = [];
  for (const entry of fs.readdirSync(forksRoot)) {
    const p = path.join(forksRoot, entry);
    if (!fs.statSync(p).isDirectory()) continue;
    const isResolved = entry.endsWith(".resolved");
    if (args.filter === "pending" && isResolved) continue;
    if (args.filter === "resolved" && !isResolved) continue;
    const originFile = path.join(p, "origin.yaml");
    let forkId = entry.replace(/\.resolved$/, "");
    let originatingTaskId = null;
    let councilTier = null;
    if (fs.existsSync(originFile)) {
      const c = fs.readFileSync(originFile, "utf-8");
      forkId = extractScalar(c, "fork_id") || forkId;
      originatingTaskId = extractScalar(c, "originating_task_id");
      councilTier = extractScalar(c, "council_tier");
    }
    out.push({
      fork_id: forkId,
      fork_dir: p,
      status: isResolved ? "resolved" : "pending",
      originating_task_id: originatingTaskId,
      council_tier: councilTier,
    });
  }
  console.log(JSON.stringify(out));
}

function merge(args) {
  if (!args.forkId || !args.manifestDir || !args.store) {
    console.log("err:missing required args (--fork-id, --manifest-dir, --store)");
    process.exit(1);
  }
  const forksRoot = path.join(args.manifestDir, "forks");
  const forkDir = path.join(forksRoot, args.forkId);
  if (!fs.existsSync(forkDir)) {
    console.log(`err:fork_not_found:${args.forkId}`);
    process.exit(1);
  }
  const amendedDir = path.join(forkDir, "amended");
  if (!fs.existsSync(amendedDir)) {
    console.log(`err:no_amendments:${amendedDir} missing — run deliberate-fork.js first`);
    process.exit(1);
  }

  // Read origin.yaml allowlists. Amendments outside these lists are warned + skipped.
  const originContent = fs.readFileSync(path.join(forkDir, "origin.yaml"), "utf-8");
  const allowedTaskIds = new Set();
  const taskAllowMatch = originContent.match(/^affected_task_ids:\s*\n((?:\s+-\s*.+\n?)*)/m);
  if (taskAllowMatch) {
    for (const line of taskAllowMatch[1].match(/^\s+-\s*"?([^"\n]+)"?/gm) || []) {
      const m = line.match(/^\s+-\s*"?([^"\n]+)"?/);
      if (m) allowedTaskIds.add(m[1].trim());
    }
  }
  const allowedContractIds = new Set();
  const cAllowMatch = originContent.match(/^referenced_contract_ids:\s*\n((?:\s+-\s*.+\n?)*)/m);
  if (cAllowMatch) {
    for (const line of cAllowMatch[1].match(/^\s+-\s*"?([^"\n]+)"?/gm) || []) {
      const m = line.match(/^\s+-\s*"?([^"\n]+)"?/);
      if (m) allowedContractIds.add(m[1].trim());
    }
  }

  let tasksAmended = 0;
  let tasksAdded = 0;
  let tasksSkipped = 0;
  let contractsAmended = 0;
  let contractsSkipped = 0;
  const renamedFiles = [];

  // 1. Process task amendments
  const amendedTasksDir = path.join(amendedDir, "tasks");
  if (fs.existsSync(amendedTasksDir)) {
    for (const f of fs.readdirSync(amendedTasksDir)) {
      if (!f.endsWith(".yaml")) continue;
      const src = path.join(amendedTasksDir, f);
      const newContent = fs.readFileSync(src, "utf-8");
      const newTaskId = extractTaskId(newContent) || f.replace(/\.yaml$/, "");

      const liveTaskFile = path.join(args.manifestDir, "tasks", `${newTaskId}.yaml`);
      const isExisting = fs.existsSync(liveTaskFile);

      if (isExisting && !allowedTaskIds.has(newTaskId)) {
        console.log(`warn:amendment_outside_slice_skipped:task=${newTaskId}`);
        tasksSkipped++;
        continue;
      }

      // Diff file_path for existing tasks; rename old output if it changed.
      if (isExisting) {
        const oldContent = fs.readFileSync(liveTaskFile, "utf-8");
        const oldFp = extractFilePath(oldContent);
        const newFp = extractFilePath(newContent);
        if (oldFp && newFp && oldFp !== newFp) {
          // Best-effort: workspace output dir is sibling of manifest. The actual
          // output may not exist (task never completed), so wrap in try.
          const outputRoot = path.resolve(args.manifestDir, "..", "output");
          const oldOutputFile = path.join(outputRoot, oldFp);
          if (fs.existsSync(oldOutputFile)) {
            const bak = oldOutputFile + ".OLD.bak";
            try {
              fs.renameSync(oldOutputFile, bak);
              renamedFiles.push({ from: oldOutputFile, to: bak });
              console.log(`renamed:${oldOutputFile} -> ${bak}`);
            } catch (e) {
              console.log(`warn:rename_failed:${oldOutputFile}:${e.message}`);
            }
          }
        }
      }

      fs.copyFileSync(src, liveTaskFile);
      if (isExisting) {
        tasksAmended++;
      } else {
        tasksAdded++;
        // New task: insert PLANNED entry into store via task-store.js init-style write.
        // We don't have an "insert single task" command, so do it inline via Node:
        try {
          const storeContent = fs.readFileSync(args.store, "utf-8");
          const state = JSON.parse(storeContent);
          if (!state.tasks[newTaskId]) {
            state.tasks[newTaskId] = {
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
            state._version = (state._version || 0) + 1;
            state.last_updated = new Date().toISOString();
            const tmp = args.store + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
            fs.renameSync(tmp, args.store);
          }
        } catch (e) {
          console.log(`warn:insert_new_task_failed:${newTaskId}:${e.message}`);
        }
      }
    }
  }

  // 2. Process contract amendments
  const amendedContractsDir = path.join(amendedDir, "contracts");
  if (fs.existsSync(amendedContractsDir)) {
    for (const f of fs.readdirSync(amendedContractsDir)) {
      if (!f.endsWith(".yaml")) continue;
      const src = path.join(amendedContractsDir, f);
      const cid = f.replace(/\.yaml$/, "");
      const liveCFile = path.join(args.manifestDir, "contracts", `${cid}.yaml`);
      const isExisting = fs.existsSync(liveCFile);
      if (isExisting && !allowedContractIds.has(cid)) {
        console.log(`warn:amendment_outside_slice_skipped:contract=${cid}`);
        contractsSkipped++;
        continue;
      }
      fs.copyFileSync(src, liveCFile);
      contractsAmended++;
    }
  }

  // 3. Flip BLOCKED tasks back to PLANNED via task-store.js merge-fork
  const mergeRes = run(`node ${path.join(SCRIPTS, "task-store.js")} merge-fork --store ${args.store} --fork-id ${args.forkId}`);
  console.log(`store-merge:${mergeRes}`);

  // 4. Move fork dir to .resolved (audit trail)
  const resolvedDir = forkDir + ".resolved";
  try {
    fs.renameSync(forkDir, resolvedDir);
  } catch (e) {
    console.log(`warn:resolve_rename_failed:${e.message}`);
  }

  console.log(`ok:tasks_amended=${tasksAmended} tasks_added=${tasksAdded} tasks_skipped=${tasksSkipped} contracts_amended=${contractsAmended} contracts_skipped=${contractsSkipped} files_renamed=${renamedFiles.length}`);
}

// ── Main ──
function main() {
  const args = parseArgs();
  switch (args.action) {
    case "create": create(args); break;
    case "list": list(args); break;
    case "merge": merge(args); break;
    default:
      console.log(`err:unknown action: ${args.action}`);
      process.exit(1);
  }
}

main();
