#!/usr/bin/env node
/**
 * deliberate-fork.js — Council deliberation for a manifest fork.
 *
 * Reads a fork dir created by fork-manifest.js, builds a council prompt
 * (Director by default, C-Suite if origin.yaml.council_tier == csuite),
 * dispatches subagent.js, writes amended artifacts under <fork>/amended/,
 * then calls fork-manifest.js merge to splice + unblock.
 *
 * Usage:
 *   node deliberate-fork.js --manifest-dir <m> --store <s> [--fork-id <id>] [--all] [--model <m>]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { appendDecision } = require("./audit-log.js");

const SCRIPTS = path.resolve(__dirname);

// ── M5 recovery-tier helpers (pure; unit-tested) ──────────────────────────
//
// The recovery ladder maps a fork's council_tier + an escalation counter to a
// numeric recovery tier: Tier 2 = Director, Tier 3 = C-Suite (fork workspace),
// Tier 4 = C-Suite re-reading the ORIGINAL corpus, Tier 5 = halt.
function recoveryTierFromCouncil(councilTier, explicit) {
  const n = parseInt(explicit, 10);
  if (!Number.isNaN(n)) return n;
  return String(councilTier || "director").toLowerCase() === "csuite" ? 3 : 2;
}
function nextTier(tier) { return Math.min(5, (tier || 2) + 1); }
function councilForTier(tier) { return tier >= 3 ? "csuite" : "director"; }

// Diff guard (§5.6): a council that wants to rewrite too much of the plan in one
// iteration is operating at the wrong tier. Threshold is per-tier — Tier 2
// (Director) 30%, Tier 3+ (C-Suite) 60% since the C-Suite legitimately rewrites
// more. Returns { ratio, threshold, exceeded }.
function diffGuardThreshold(tier) { return tier >= 3 ? 0.60 : 0.30; }
function computeDiffGuard(amendmentSize, totalTasks, tier) {
  const threshold = diffGuardThreshold(tier);
  const ratio = totalTasks > 0 ? amendmentSize / totalTasks : 0;
  return { ratio, threshold, exceeded: ratio > threshold };
}

// Stable slice id from the affected task-id set (order-independent).
function sliceHash(taskIds) {
  const sorted = [...(taskIds || [])].sort();
  return "S-" + crypto.createHash("sha1").update(sorted.join(",")).digest("hex").slice(0, 12);
}

// Hash of the full manifest (task + contract + epic file contents) — feeds the
// loop-detector's manifest-cycle check.
function manifestHash(manifestDir) {
  const h = crypto.createHash("sha1");
  for (const sub of ["tasks", "contracts", "epics"]) {
    const d = path.join(manifestDir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) {
      if (!f.endsWith(".yaml")) continue;
      try { h.update(f + "\n" + fs.readFileSync(path.join(d, f), "utf-8")); } catch {}
    }
  }
  return "MH-" + h.digest("hex").slice(0, 12);
}

function countManifestTasks(manifestDir) {
  const d = path.join(manifestDir, "tasks");
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).filter(f => f.endsWith(".yaml")).length;
}

// Append a recovery-iteration record to wiki/recovery-state.yaml (the log the
// loop-detector + budget-tracker consume). Hand-rolled YAML append to avoid a
// read-parse-rewrite race; the file is a `iterations:` list.
function recordRecoveryIteration(workspaceRoot, entry) {
  try {
    const wikiDir = path.join(workspaceRoot, "wiki");
    fs.mkdirSync(wikiDir, { recursive: true });
    const f = path.join(wikiDir, "recovery-state.yaml");
    if (!fs.existsSync(f)) fs.writeFileSync(f, "iterations:\n");
    let block = `  - iteration: ${entry.iteration}\n`;
    block += `    tier: ${entry.tier}\n`;
    block += `    slice: ${JSON.stringify(entry.slice)}\n`;
    block += `    manifest_hash: ${JSON.stringify(entry.manifest_hash)}\n`;
    block += `    task_signature_hash: ${JSON.stringify(entry.task_signature_hash)}\n`;
    block += `    fork_id: ${JSON.stringify(entry.fork_id)}\n`;
    block += `    outcome: ${JSON.stringify(entry.outcome)}\n`;
    block += `    timestamp: ${JSON.stringify(new Date().toISOString())}\n`;
    fs.appendFileSync(f, block);
  } catch { /* best-effort */ }
}

function countRecoveryIterations(workspaceRoot) {
  try {
    const f = path.join(workspaceRoot, "wiki", "recovery-state.yaml");
    if (!fs.existsSync(f)) return 0;
    return (fs.readFileSync(f, "utf-8").match(/^\s+-\s+iteration:/gm) || []).length;
  } catch { return 0; }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--store": parsed.store = args[++i]; break;
      case "--fork-id": parsed.forkId = args[++i]; break;
      case "--all": parsed.all = true; break;
      case "--model": parsed.model = args[++i]; break;
    }
  }
  return parsed;
}

// Default to sonnet for council deliberation (matches the sonnet → opus
// council ladder used elsewhere in the skill). Operators can override
// via --model on the CLI.
const DEFAULT_DELIBERATION_MODEL = "recovery_director";

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch (e) {
    return `err:exec:${e.message.slice(0, 200)}`;
  }
}

// runAsync via execSync with a long timeout — council calls take minutes.
// Sync because we process forks serially anyway (v1 limitation per plan §9).
function runLong(cmd, timeoutMs) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (e) {
    return `err:exec:${e.message.slice(0, 200)}`;
  }
}

function extractScalar(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"));
  return m ? m[1].trim() : null;
}

function extractList(content, field) {
  const blockRe = new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s*.+\\n?)*)`, "m");
  const m = content.match(blockRe);
  if (!m) return [];
  return (m[1].match(/^\s+-\s*"?([^"\n]+)"?/gm) || [])
    .map(l => l.replace(/^\s+-\s*"?|"?\s*$/g, "").trim())
    .filter(Boolean);
}

function readForkOrigin(forkDir) {
  const f = path.join(forkDir, "origin.yaml");
  if (!fs.existsSync(f)) return null;
  const content = fs.readFileSync(f, "utf-8");
  return {
    content,
    forkId: extractScalar(content, "fork_id"),
    originatingTaskId: extractScalar(content, "originating_task_id"),
    originatingArea: extractScalar(content, "originating_area"),
    councilTier: extractScalar(content, "council_tier") || "director",
    recoveryTier: extractScalar(content, "recovery_tier"),
    affectedTaskIds: extractList(content, "affected_task_ids"),
    referencedContractIds: extractList(content, "referenced_contract_ids"),
  };
}

// Escalate a fork one recovery tier (§5.6 diff guard / no-progress). Rewrites
// origin.yaml's council_tier + recovery_tier and writes an escalation marker;
// the fork stays PENDING so the next deliberate-fork pass re-deliberates at the
// higher tier. At Tier 3+ the workspace is snapshotted for the audit trail.
function escalateFork(forkDir, manifestDir, workspaceRoot, fromTier, toTier, reason, logFn) {
  const originFile = path.join(forkDir, "origin.yaml");
  let content = fs.readFileSync(originFile, "utf-8");
  const newCouncil = councilForTier(toTier);
  if (/^council_tier:/m.test(content)) content = content.replace(/^council_tier:.*$/m, `council_tier: "${newCouncil}"`);
  else content += `council_tier: "${newCouncil}"\n`;
  if (/^recovery_tier:/m.test(content)) content = content.replace(/^recovery_tier:.*$/m, `recovery_tier: ${toTier}`);
  else content += `recovery_tier: ${toTier}\n`;
  fs.writeFileSync(originFile, content);
  fs.writeFileSync(path.join(forkDir, "escalated-to-next-tier.txt"),
    `Escalated Tier ${fromTier} → Tier ${toTier} (council ${newCouncil}) at ${new Date().toISOString()}\nReason: ${reason}\n`);
  logFn(`escalate fork=${path.basename(forkDir)} ${fromTier}->${toTier} council=${newCouncil} reason=${reason}`);
  appendDecision(workspaceRoot, {
    tier: `M5_TIER_${toTier}`,
    decision: `Escalated fork ${path.basename(forkDir)} from Tier ${fromTier} to Tier ${toTier} (council ${newCouncil})`,
    triggering_signal: reason,
    rationale: `Tier ${fromTier} could not resolve the slice within the diff-guard / progress bounds`,
  });
}

// Snapshot the workspace the first time recovery operates at a given Tier ≥ 3
// (§5.2). Guarded by a per-(build, tier) marker so many forks deliberating at
// the same tier don't each snapshot — one snapshot per tier level marks the
// re-planning boundary operators diff against.
function ensureTierSnapshot(workspaceRoot, recTier, logFn) {
  if (recTier < 3) return;
  const marker = path.join(workspaceRoot, "wiki", `.snapshot-done-tier${recTier}`);
  if (fs.existsSync(marker)) return;
  const out = run(`node ${path.join(SCRIPTS, "fork-workspace.js")} --workspace ${workspaceRoot} --reason ${JSON.stringify("tier" + recTier + "-recovery").replace(/"/g, '\\"')}`);
  logFn(`fork-workspace tier=${recTier} result=${out.slice(0, 200)}`);
  try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, new Date().toISOString() + "\n"); } catch {}
}

// Tier-4 terminal: the spec itself is structurally broken. Emit SPEC-DEFECT.md
// (a halt artifact) via spec-defect-report.js, built from the fork's error
// history + the recovery-state log.
function emitSpecDefect(workspaceRoot, origin, manifestDir, logFn) {
  const iterations = countRecoveryIterations(workspaceRoot);
  const defect = {
    diagnosis: `Recovery exhausted Tier 4 on task ${origin.originatingTaskId} without a resolvable amendment`,
    build: workspaceRoot,
    halt_reason: "Tier 4 (C-Suite spec re-read) produced no amendment that resolves the failure",
    recovery_iterations: iterations,
    implicated_sections: [],
    failure_signatures: (origin.affectedTaskIds || []).slice(0, 1).map((t, i) => ({
      iteration: iterations, tier: "Tier 4", signature: `unresolved after spec re-read (${origin.originatingTaskId})`, tasks_affected: (origin.affectedTaskIds || []).length,
    })),
    recommendation: `Review the spec corpus for the capability required by ${origin.originatingTaskId}; recovery could not synthesize it across 4 tiers, indicating the requirement is undefined or contradictory in the spec.`,
  };
  const defectFile = path.join(workspaceRoot, "wiki", "spec-defect-input.yaml");
  try {
    fs.mkdirSync(path.dirname(defectFile), { recursive: true });
    // hand-rolled YAML (avoid adding a yaml dep here)
    let y = `diagnosis: ${JSON.stringify(defect.diagnosis)}\nbuild: ${JSON.stringify(defect.build)}\n`;
    y += `halt_reason: ${JSON.stringify(defect.halt_reason)}\nrecovery_iterations: ${defect.recovery_iterations}\n`;
    y += `implicated_sections: []\nfailure_signatures:\n`;
    for (const s of defect.failure_signatures) {
      y += `  - iteration: ${s.iteration}\n    tier: ${JSON.stringify(s.tier)}\n    signature: ${JSON.stringify(s.signature)}\n    tasks_affected: ${s.tasks_affected}\n`;
    }
    if (defect.failure_signatures.length === 0) y += `  []\n`;
    y += `recommendation: ${JSON.stringify(defect.recommendation)}\n`;
    fs.writeFileSync(defectFile, y);
  } catch {}
  const outFile = path.join(workspaceRoot, "SPEC-DEFECT.md");
  const out = run(`node ${path.join(SCRIPTS, "spec-defect-report.js")} --input ${defectFile} --output ${outFile}`);
  logFn(`spec-defect emit result=${out.slice(0, 200)} file=${outFile}`);
  appendDecision(workspaceRoot, {
    tier: "M5_TIER_4",
    decision: `Emitted SPEC-DEFECT.md (halt) for ${origin.originatingTaskId}`,
    triggering_signal: "Tier 4 (C-Suite spec re-read) produced no resolvable amendment",
    rationale: defect.diagnosis,
  });
  return outFile;
}

// List pending forks via fork-manifest.js list.
function listPending(manifestDir) {
  const out = run(`node ${path.join(SCRIPTS, "fork-manifest.js")} list --manifest-dir ${manifestDir} --pending`);
  if (out.startsWith("err:")) return [];
  try { return JSON.parse(out); } catch { return []; }
}

// Build the council prompt. Scope is *explicitly* limited to the originating
// task + its contracts; the merge step will refuse anything outside the slice.
function buildCouncilUserMessage(forkDir, origin, manifestDirForPrompt, recTier, workspaceRoot) {
  const parts = [];
  parts.push(`--- FORK ORIGIN ---\n${origin.content}`);

  // Tier 4 (§5.1): C-Suite re-reads the ORIGINAL spec corpus (not scope-corpus)
  // with the full failure history. If recovery has exhausted Tier 3 across the
  // filtered scope, the original inputs may reveal that a deferred-scope or
  // coverage decision was wrong — or that the requirement is genuinely undefined.
  if (recTier >= 4 && workspaceRoot) {
    const inputDir = path.join(workspaceRoot, "input");
    if (fs.existsSync(inputDir)) {
      parts.push(`--- TIER 4: ORIGINAL SPEC CORPUS (re-read for structural defect analysis) ---`);
      for (const f of fs.readdirSync(inputDir).sort()) {
        if (!/\.(md|markdown|txt|yaml|yml)$/i.test(f)) continue;
        try { parts.push(`--- input/${f} ---\n${fs.readFileSync(path.join(inputDir, f), "utf-8")}`); } catch {}
      }
      parts.push(
        `--- TIER 4 INSTRUCTION ---\n` +
        `Lower recovery tiers could not resolve this failure within the filtered scope. Re-read the ` +
        `ORIGINAL corpus above. Either (a) produce amendments that resolve the failure (if the spec does ` +
        `define what's needed and an earlier tier mis-scoped it), OR (b) make NO amendments — leave the ` +
        `slice unchanged — if the spec genuinely does not define the required capability. Making no ` +
        `amendment at Tier 4 signals a structural spec defect and the build will halt with a diagnosis.`);
    }
  }

  // Include the originating task spec(s)
  const tasksDir = path.join(forkDir, "tasks");
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir).sort()) {
      if (!f.endsWith(".yaml")) continue;
      parts.push(`--- TASK SPEC: ${f} ---\n${fs.readFileSync(path.join(tasksDir, f), "utf-8")}`);
    }
  }

  // Include the parent epic
  const epicsDir = path.join(forkDir, "epics");
  if (fs.existsSync(epicsDir)) {
    for (const f of fs.readdirSync(epicsDir).sort()) {
      if (!f.endsWith(".yaml")) continue;
      parts.push(`--- PARENT EPIC: ${f} ---\n${fs.readFileSync(path.join(epicsDir, f), "utf-8")}`);
    }
  }

  // Include referenced contracts
  const contractsDir = path.join(forkDir, "contracts");
  if (fs.existsSync(contractsDir)) {
    for (const f of fs.readdirSync(contractsDir).sort()) {
      if (!f.endsWith(".yaml")) continue;
      parts.push(`--- CONTRACT: ${f} ---\n${fs.readFileSync(path.join(contractsDir, f), "utf-8")}`);
    }
  }

  // Scope guard: the merge step in fork-manifest.js enforces this allowlist.
  // The prompt warns the council so its proposals stay within scope.
  const allowedTasks = origin.affectedTaskIds.join(", ") || "(none listed)";
  const allowedContracts = origin.referencedContractIds.join(", ") || "(none listed)";

  const helperPath = path.join(SCRIPTS, "fork-amend.js");

  parts.push(
    `\n--- DELIBERATION TASK ---\n` +
    `A worker repeatedly failed on task ${origin.originatingTaskId}. Review the error_history ` +
    `in the fork origin, the task spec, the parent epic, and the referenced contracts. Propose a ` +
    `repaired task spec (and contract amendments only if necessary).\n\n` +
    `SCOPE: amend ONLY the tasks/contracts in this fork's slice; do not propose changes outside the ` +
    `listed task_ids and contract_ids. Out-of-slice amendments will be rejected by the helper.\n` +
    `  Allowed task_ids: ${allowedTasks}\n` +
    `  Allowed contract_ids: ${allowedContracts}\n\n` +
    `--- WORKER INVARIANT (READ BEFORE DRAFTING AMENDMENTS) ---\n` +
    `Each task is implemented by exactly one worker that writes exactly ONE file at the task's\n` +
    `file_path. The worker prompt instructs "Output ONLY the file content" — singular. A task whose\n` +
    `description, signature, or "Deliverables:" list enumerates multiple artifacts will be rejected\n` +
    `by the worker with err:ambiguity.\n` +
    `\n` +
    `If your repair requires N artifacts at N distinct paths, you MUST emit N separate amendments:\n` +
    `one 'task' amendment for the originating task (covering the artifact at its file_path) plus\n` +
    `N-1 'new-task' amendments for the other artifacts (each with its own file_path). Helpers like\n` +
    `Makefile targets, GitHub Action wrappers (action.yml), Dockerfiles, or auxiliary shell scripts\n` +
    `each get their own task with their own file_path — never bundle them into the description of\n` +
    `another task.\n` +
    `\n` +
    `The description, signature, and any "Deliverables:" / "Outputs:" list in a task body MUST refer\n` +
    `only to the single artifact at file_path. Do not name sibling files in prose, even as context.\n` +
    `\n` +
    `For work that requires shell or build execution at apply time (pip-compile, npm run, container\n` +
    `build, terraform plan, etc.), set artifact_type to indicate ci_runner-class work and emit it as\n` +
    `a separate task — the code-gen worker only writes file content, it does not execute commands.\n` +
    `\n` +
    `--- HOW TO EMIT AMENDMENTS ---\n` +
    `For EACH amendment, perform exactly two tool calls:\n` +
    `  1. Use Write to stage the amendment YAML to /tmp/amend-<id>.yaml. The body must be a valid\n` +
    `     task or contract spec with task_id/contract_id matching the id you pass in step 2.\n` +
    `  2. Use Bash to invoke the fork-amend helper with one of these subcommands:\n` +
    `       node ${helperPath} task     --manifest-dir ${manifestDirForPrompt} --fork-id ${origin.forkId} --task-id <ID>     --content-file /tmp/amend-<ID>.yaml\n` +
    `       node ${helperPath} contract --manifest-dir ${manifestDirForPrompt} --fork-id ${origin.forkId} --contract-id <ID> --content-file /tmp/amend-<ID>.yaml\n` +
    `       node ${helperPath} new-task --manifest-dir ${manifestDirForPrompt} --fork-id ${origin.forkId} --task-id <ID>     --content-file /tmp/amend-<ID>.yaml\n` +
    `\n` +
    `  Subcommand semantics:\n` +
    `    - task      : amend an existing task in the slice (id MUST be in Allowed task_ids)\n` +
    `    - contract  : amend an existing contract in the slice (id MUST be in Allowed contract_ids)\n` +
    `    - new-task  : add a brand-new task (id MUST NOT already exist in the slice). Will be\n` +
    `                  inserted as PLANNED in the store on merge.\n` +
    `\n` +
    `  The helper validates input and writes the canonical artifact to <fork>/amended/{tasks,contracts}/<id>.yaml.\n` +
    `  On success it prints "ok:amended_task=...". On failure it prints "err:..." — fix the body or args and re-call.\n` +
    `\n` +
    `After all helper calls, summarize what you changed in plain text. The helper writes the canonical\n` +
    `artifacts; your summary is for the audit log only. DO NOT emit a top-level YAML document of\n` +
    `amendments — only the helper's output is consumed by the merge step.`
  );

  return parts.join("\n\n");
}

// Count amendments written to <fork>/amended/{tasks,contracts}/ by the
// fork-amend.js helper. The council writes each amendment via a tool call
// during deliberation, so by the time we get here the files are already on
// disk — we just verify that *something* was written.
function verifyAmendments(forkDir) {
  const amendedDir = path.join(forkDir, "amended");
  const tasksDir = path.join(amendedDir, "tasks");
  const contractsDir = path.join(amendedDir, "contracts");
  const tasksWritten = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter(f => f.endsWith(".yaml")).length
    : 0;
  const contractsWritten = fs.existsSync(contractsDir)
    ? fs.readdirSync(contractsDir).filter(f => f.endsWith(".yaml")).length
    : 0;
  return { tasksWritten, contractsWritten };
}

async function deliberateOne(args, forkInfo) {
  const forkDir = forkInfo.fork_dir;
  const origin = readForkOrigin(forkDir);
  if (!origin) {
    console.log(`err:no_origin_yaml:${forkDir}`);
    return false;
  }
  const tier = (origin.councilTier || "director").toLowerCase();
  const recTier = recoveryTierFromCouncil(origin.councilTier, origin.recoveryTier);
  const workspaceRoot = path.resolve(args.manifestDir, "..");
  const model = args.model || DEFAULT_DELIBERATION_MODEL;
  const logFn = (s) => console.log(s);

  console.log(`deliberation start fork=${origin.forkId} council=${tier} recovery_tier=${recTier} originating_task=${origin.originatingTaskId}`);

  // §5.2 — snapshot the workspace on the first Tier-3+ recovery operation.
  ensureTierSnapshot(workspaceRoot, recTier, logFn);

  const userMessage = buildCouncilUserMessage(forkDir, origin, args.manifestDir, recTier, workspaceRoot);

  // Stage the user message to a tmp file — passing very large prompts via the
  // command line is brittle. We invoke subagent.js via --input <file>.
  const stagingDir = path.join(forkDir, ".staging");
  fs.mkdirSync(stagingDir, { recursive: true });
  const promptFile = path.join(stagingDir, "council-prompt.txt");
  fs.writeFileSync(promptFile, userMessage);

  // We dispatch via subagent.js planning-phase, but planning-phase reads
  // --input as a file/dir of YAML and assembles a council prompt. To pass
  // our hand-crafted prompt verbatim, we use --input pointing at promptFile.
  // The planning prompt builder will append the standard council instructions
  // — that is acceptable; our explicit SCOPE language is in the prompt body
  // and dominates the output.
  const outputDir = path.join(forkDir, "amended-raw");
  fs.mkdirSync(outputDir, { recursive: true });

  const areaArg = origin.originatingArea ? ` --area ${origin.originatingArea}` : "";
  // Council needs Bash + Write + Read so it can stage amend YAMLs to /tmp and
  // invoke fork-amend.js per amendment. Without these, the subagent can only
  // emit text into <tier>-output.yaml — which the merge step cannot consume.
  const cmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
    `--persona ${tier} ` +
    `--model ${model} ` +
    `--phase planning ` +
    `--input ${promptFile}` +
    areaArg + ` ` +
    `--output-dir ${outputDir} ` +
    `--tools "Bash,Write,Read"`;

  // Council calls run minutes-long. 25 min ceiling matches subagent.js's
  // internal timeout window plus margin.
  const result = runLong(cmd, 1700000);
  if (result.startsWith("err:")) {
    console.log(`deliberation-err fork=${origin.forkId} result=${result.slice(0, 300)}`);
    return false;
  }

  // Council writes amendments via fork-amend.js helper calls during deliberation.
  // The <tier>-output.yaml summary is informational only; we count files in
  // <fork>/amended/{tasks,contracts}/ to determine what was actually written.
  const { tasksWritten, contractsWritten } = verifyAmendments(forkDir);
  console.log(`deliberation amendments fork=${origin.forkId} tasks=${tasksWritten} contracts=${contractsWritten}`);

  // Compute this iteration's recovery-state record (slice + manifest/task hashes).
  const amendmentSize = tasksWritten + contractsWritten;
  const totalTasks = countManifestTasks(args.manifestDir);
  const slice = sliceHash(origin.affectedTaskIds);
  const iteration = countRecoveryIterations(workspaceRoot) + 1;
  const amendedTaskFile = path.join(forkDir, "amended", "tasks", `${origin.originatingTaskId}.yaml`);
  const tsh = fs.existsSync(amendedTaskFile)
    ? "TS-" + crypto.createHash("sha1").update(fs.readFileSync(amendedTaskFile, "utf-8")).digest("hex").slice(0, 12)
    : "TS-none";
  const record = (outcome) => recordRecoveryIteration(workspaceRoot, {
    iteration, tier: recTier, slice, manifest_hash: manifestHash(args.manifestDir),
    task_signature_hash: tsh, fork_id: origin.forkId, outcome,
  });

  // No amendments: the council at this tier couldn't make progress.
  if (amendmentSize === 0) {
    if (recTier >= 4) {
      record("spec_defect");
      const defectFile = emitSpecDefect(workspaceRoot, origin, args.manifestDir, logFn);
      console.log(`halt:spec_defect fork=${origin.forkId} report=${defectFile}`);
      return false;
    }
    const to = nextTier(recTier);
    record("escalated_no_amendment");
    escalateFork(forkDir, args.manifestDir, workspaceRoot, recTier, to, "no amendments produced at this tier", logFn);
    console.log(`escalated:no_amendment fork=${origin.forkId} tier=${recTier}->${to} (re-deliberate next pass)`);
    return false;
  }

  // Diff guard (§5.6): a council rewriting too much in one iteration is at the
  // wrong tier — escalate instead of merging a runaway amendment.
  const dg = computeDiffGuard(amendmentSize, totalTasks, recTier);
  if (dg.exceeded) {
    const to = nextTier(recTier);
    if (to >= 5) {
      record("spec_defect");
      const defectFile = emitSpecDefect(workspaceRoot, origin, args.manifestDir, logFn);
      console.log(`halt:spec_defect fork=${origin.forkId} (diff-guard at top tier) report=${defectFile}`);
      return false;
    }
    record("escalated_diffguard");
    escalateFork(forkDir, args.manifestDir, workspaceRoot, recTier, to,
      `amendment touched ${amendmentSize}/${totalTasks} tasks (${(dg.ratio * 100).toFixed(1)}%) — exceeds ${(dg.threshold * 100).toFixed(0)}% threshold`, logFn);
    console.log(`escalated:diff_guard fork=${origin.forkId} ratio=${(dg.ratio * 100).toFixed(1)}% threshold=${(dg.threshold * 100).toFixed(0)}% tier=${recTier}->${to}`);
    return false;
  }

  // Splice + unblock via fork-manifest.js merge
  const mergeRes = runLong(
    `node ${path.join(SCRIPTS, "fork-manifest.js")} merge --fork-id ${origin.forkId} --manifest-dir ${args.manifestDir} --store ${args.store}`,
    300000
  );
  const merged = !mergeRes.startsWith("err:");
  record(merged ? "merged" : "merge_failed");
  console.log(`deliberation complete fork=${origin.forkId} merge=${mergeRes.replace(/\n/g, " | ")}`);
  return merged;
}

async function main() {
  const args = parseArgs();
  if (!args.manifestDir || !args.store) {
    console.log("err:missing required args (--manifest-dir, --store)");
    process.exit(1);
  }
  if (!args.forkId && !args.all) {
    console.log("err:must specify --fork-id or --all");
    process.exit(1);
  }

  let toProcess = [];
  if (args.forkId) {
    const forkDir = path.join(args.manifestDir, "forks", args.forkId);
    if (!fs.existsSync(forkDir)) {
      console.log(`err:fork_not_found:${args.forkId}`);
      process.exit(1);
    }
    toProcess = [{ fork_id: args.forkId, fork_dir: forkDir, status: "pending" }];
  } else {
    toProcess = listPending(args.manifestDir).filter(f => f.status === "pending");
  }

  if (toProcess.length === 0) {
    console.log("ok:no pending forks");
    return;
  }

  console.log(`deliberate-fork: processing ${toProcess.length} fork(s) serially`);
  let succeeded = 0;
  let failed = 0;
  for (const fork of toProcess) {
    const ok = await deliberateOne(args, fork);
    if (ok) succeeded++; else failed++;
  }
  console.log(`done:succeeded=${succeeded} failed=${failed}`);
}

// Export pure helpers for unit testing; only run when invoked directly.
module.exports = {
  recoveryTierFromCouncil, nextTier, councilForTier,
  diffGuardThreshold, computeDiffGuard, sliceHash, manifestHash, countManifestTasks,
};

if (require.main === module) {
  main().catch(e => {
    console.log(`err:uncaught:${e.message}`);
    process.exit(1);
  });
}
