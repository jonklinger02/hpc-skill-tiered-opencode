#!/usr/bin/env node
/**
 * triage-failures.js
 *
 * Phase 3 triage. Reads wiki/verification-report.yaml, clusters failures
 * (by file_path/task_id when attributed, otherwise by phase+stderr-fingerprint),
 * dispatches a Sonnet triage sub-agent per cluster, and acts on each verdict:
 *
 *   quick_fix:<directive>  → dispatch a Haiku worker with the original task
 *                            spec + directive (appended as human_guidance);
 *                            re-runs normalize-output.js on the output
 *   block:<reason>         → marks task BLOCKED via task-store.js, mints a
 *                            fork via fork-manifest.js — deliberation happens
 *                            separately in the orchestrator's loop
 *   noise:<reason>         → recorded only; no further action
 *
 * Triage decisions and actions are written to wiki/triage-report.yaml.
 *
 * Always exits 0 if it managed to write the report; the report's
 * `unresolved_blocks` and `quick_fix_count` fields drive the orchestrator's
 * decision to re-run verify-build.js or stop.
 *
 * Usage:
 *   node triage-failures.js \
 *     --manifest-dir <dir> \
 *     --output-dir <dir> \
 *     --wiki-dir <dir> \
 *     --store <path> \
 *     --triage-model <model>     # default: claude-sonnet-4-6
 *     --patch-model <model>      # default: claude-haiku-4-5-20251001
 *     [--round <n>]              # default: 1 — stamped into the report
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { resolveModel } = require("./lib/models.js");
const { callAgent } = require("./lib/opencode-client");

function parseArgs() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--manifest-dir": a.manifestDir = argv[++i]; break;
      case "--output-dir": a.outputDir = argv[++i]; break;
      case "--wiki-dir": a.wikiDir = argv[++i]; break;
      case "--store": a.store = argv[++i]; break;
      case "--triage-model": a.triageModel = argv[++i]; break;
      case "--patch-model": a.patchModel = argv[++i]; break;
      case "--round": a.round = parseInt(argv[++i], 10); break;
      // M5 §5.1 — Tier 1 termination auto-triggers Tier 2 (deliberate-fork).
      case "--auto-deliberate": a.autoDeliberate = true; break;
    }
  }
  a.triageModel = a.triageModel || "triage";
  a.patchModel = a.patchModel || "patch";
  a.round = a.round || 1;
  return a;
}

const args = parseArgs();
for (const k of ["manifestDir", "outputDir", "wikiDir", "store"]) {
  if (!args[k]) {
    console.log(`err:missing required arg --${k.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
    process.exit(1);
  }
}

const reportFile = path.join(args.wikiDir, "verification-report.yaml");
if (!fs.existsSync(reportFile)) {
  console.log(`err:no_verification_report ${reportFile} — run verify-build.js first`);
  process.exit(1);
}

// ── Parse verification report (lightweight, format we wrote ourselves) ───
//
// Not full YAML — just the failure list with the fields verify-build.js
// emits. Each failure is a block under `failures:` separated by lines that
// start with "  - phase: ".
function parseReport(text) {
  const result = { all_green: false, failures: [] };
  if (/^all_green:\s*true\b/m.test(text)) result.all_green = true;
  const failuresIdx = text.indexOf("\nfailures:");
  if (failuresIdx < 0 || /^failures:\s*\[\]\s*$/m.test(text)) return result;

  const after = text.slice(failuresIdx + 1);
  // Split on lines beginning with "  - phase: "
  const blocks = after.split(/\n  - phase: /).slice(1);
  for (const b of blocks) {
    const phase = (b.match(/^([^\n]+)/) || [])[1]?.trim();
    const get = (k) => {
      const m = b.match(new RegExp(`^    ${k}:\\s*"?([^"\\n]*)"?\\s*$`, "m"));
      if (!m) return null;
      const v = m[1].trim();
      return (v === "null" || v === "") ? null : v;
    };
    const getBlock = (k) => {
      const re = new RegExp(`^    ${k}:\\s*\\|\\n((?:      [^\\n]*\\n?)+)`, "m");
      const m = b.match(re);
      if (!m) return "";
      return m[1].split("\n").map(l => l.replace(/^      /, "")).join("\n").trimEnd();
    };
    result.failures.push({
      phase,
      command: get("command"),
      exit_code: parseInt(get("exit_code") || "1", 10),
      file_path: get("file_path"),
      task_id: get("task_id"),
      stderr_excerpt: getBlock("stderr_excerpt"),
      stdout_excerpt: getBlock("stdout_excerpt"),
    });
  }
  return result;
}

const report = parseReport(fs.readFileSync(reportFile, "utf-8"));

if (report.all_green) {
  console.log(`ok:nothing_to_triage all_green report=${reportFile}`);
  writeTriageReport({ round: args.round, decisions: [], all_green: true, quick_fix_count: 0, blocks: [], noise_count: 0 });
  process.exit(0);
}

if (report.failures.length === 0) {
  console.log(`ok:nothing_to_triage no_failures_listed report=${reportFile}`);
  writeTriageReport({ round: args.round, decisions: [], all_green: false, quick_fix_count: 0, blocks: [], noise_count: 0 });
  process.exit(0);
}

// ── Cluster failures ─────────────────────────────────────────────────────
//
// Cluster key: task_id when attributed; otherwise a sha-prefix of phase +
// first 3 lines of stderr (so duplicate failures from one underlying issue
// collapse into one triage call).
function clusterKey(f) {
  if (f.task_id) return `task:${f.task_id}`;
  const sig = `${f.phase}\n${(f.stderr_excerpt || "").split("\n").slice(0, 3).join("\n")}`;
  return `sig:${crypto.createHash("sha1").update(sig).digest("hex").slice(0, 10)}`;
}

const clusters = new Map();
for (const f of report.failures) {
  const k = clusterKey(f);
  if (!clusters.has(k)) clusters.set(k, []);
  clusters.get(k).push(f);
}

// ── Triage sub-agent dispatch (Sonnet) ───────────────────────────────────

function readTaskSpec(taskId) {
  if (!taskId) return null;
  const f = path.join(args.manifestDir, "tasks", `${taskId}.yaml`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf-8");
}

const TRIAGE_SYSTEM_PROMPT = `You are a senior engineer triaging build/test failures during an automated product build.

For each failure cluster you are given:
- The phase that failed (typecheck / build / test)
- The build command and exit code
- A stderr excerpt
- The originating task spec (when attribution succeeded) — or just the file path

Your job is to classify the failure into exactly ONE of three buckets and emit a single decision line. No prose, no explanation, no markdown.

DECISION FORMATS (output literally one line):
  quick_fix: <1-3 sentence directive to a Haiku worker on what to change in the file>
  block: <1 sentence reason this needs full council deliberation>
  noise: <1 sentence reason this is a false positive — flaky test, missing optional dep, env issue>

GUIDELINES:
- quick_fix when the failure is a small, localized, mechanical issue (typo, missing import, wrong argument count, type mismatch, off-by-one). The directive must be specific enough that a worker can act without re-reading the spec.
- block when the failure exposes a design issue (contract violation, structural mismatch with another task's output, ambiguity in the spec, multiple files involved). Council deliberation will mint a manifest patch.
- noise when re-running would likely succeed or the failure isn't actionable from the worker's side.

When in doubt between quick_fix and block, prefer block — the council can always escalate down to a quick fix, but a misclassified quick_fix wastes a round.

Output exactly one decision line. Nothing else.`;

async function callClaude(model, systemPrompt, userMessage, maxTokens = 1500, timeoutMs = 600000) {
  return callAgent({
    role: "triage",
    model: resolveModel(model),
    systemPrompt,
    userMessage,
    timeoutMs,
    tools: null,
    effort: null,
  });
}

function triageCluster(key, items) {
  const f = items[0];
  const taskSpec = readTaskSpec(f.task_id);
  const parts = [];
  parts.push(`--- CLUSTER ${key} (${items.length} failure${items.length > 1 ? "s" : ""}) ---`);
  parts.push(`phase: ${f.phase}`);
  parts.push(`command: ${f.command}`);
  parts.push(`exit_code: ${f.exit_code}`);
  parts.push(`file_path: ${f.file_path || "(unattributed)"}`);
  parts.push(`task_id: ${f.task_id || "(unattributed)"}`);
  parts.push(`\n--- stderr excerpt ---\n${f.stderr_excerpt || "(empty)"}`);
  if (f.stdout_excerpt && f.stdout_excerpt.trim()) {
    parts.push(`\n--- stdout excerpt ---\n${f.stdout_excerpt}`);
  }
  if (taskSpec) {
    parts.push(`\n--- TASK SPEC (${f.task_id}) ---\n${taskSpec}`);
  }
  parts.push(`\nClassify and emit one decision line.`);

  const r = callClaude(args.triageModel, TRIAGE_SYSTEM_PROMPT, parts.join("\n"), 1500);
  if (r.error) {
    return { key, items, decision: "block", reason: `triage_error:${r.error}`, raw: null };
  }
  const text = (r.text || "").trim();
  // Take the first non-empty line that matches one of the three formats.
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const decisionLine = lines.find(l => /^(quick_fix|block|noise):/i.test(l)) || lines[0] || "";
  const m = decisionLine.match(/^(quick_fix|block|noise):\s*(.*)$/i);
  if (!m) {
    return { key, items, decision: "block", reason: `unparseable_triage_response:${decisionLine.slice(0, 120)}`, raw: text };
  }
  return { key, items, decision: m[1].toLowerCase(), reason: m[2].trim(), raw: text };
}

// ── Action paths ─────────────────────────────────────────────────────────

function applyQuickFix(decision) {
  const f = decision.items[0];
  if (!f.task_id) {
    return { ...decision, applied: false, error: "quick_fix_no_task_attribution" };
  }
  const taskFile = path.join(args.manifestDir, "tasks", `${f.task_id}.yaml`);
  if (!fs.existsSync(taskFile)) {
    return { ...decision, applied: false, error: `task_spec_missing:${taskFile}` };
  }
  const outputFile = path.join(args.outputDir, f.file_path);
  if (!fs.existsSync(outputFile)) {
    return { ...decision, applied: false, error: `output_file_missing:${outputFile}` };
  }

  // Build a temp task spec with appended human_guidance + the failing file's
  // current content, so the worker has full context.
  const baseSpec = fs.readFileSync(taskFile, "utf-8");
  const currentContent = fs.readFileSync(outputFile, "utf-8");
  const appended = `${baseSpec.trimEnd()}

human_guidance: |
  Triage round ${args.round} — quick fix directive from Sonnet:
  ${decision.reason}

  Current file content (verbatim):
  ---BEGIN FILE---
${currentContent.split("\n").map(l => "  " + l).join("\n")}
  ---END FILE---

  Failing phase: ${f.phase}
  Command: ${f.command}
  Stderr excerpt:
${(f.stderr_excerpt || "").split("\n").map(l => "    " + l).join("\n")}
`;

  const tempDir = path.join(args.wikiDir, "triage-temp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempTaskFile = path.join(tempDir, `r${args.round}-${f.task_id}.yaml`);
  fs.writeFileSync(tempTaskFile, appended);

  // Dispatch a Haiku patch worker via subagent.js execution phase.
  const subagent = path.join(__dirname, "subagent.js");
  const r = spawnSync("node", [
    subagent,
    "--persona", "coder",
    "--model", args.patchModel,
    "--phase", "execution",
    "--task-file", tempTaskFile,
    "--output-file", outputFile,
    "--contracts-dir", path.join(args.manifestDir, "contracts"),
  ], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, timeout: 1500000 });

  const status = (r.stdout || "").trim().split("\n").pop() || "";
  if (status === "ok") {
    // Re-run normalize so the manifest header is reattached if the worker
    // somehow stripped it.
    const norm = path.join(__dirname, "normalize-output.js");
    spawnSync("node", [norm, "--output-file", outputFile, "--task-file", tempTaskFile, "--worker-model", args.patchModel], {
      encoding: "utf-8",
    });
    return { ...decision, applied: true, worker_status: status };
  }
  return { ...decision, applied: false, worker_status: status, error: r.stderr ? r.stderr.slice(0, 300) : null };
}

function applyBlock(decision) {
  const f = decision.items[0];
  if (!f.task_id) {
    return { ...decision, applied: false, error: "block_no_task_attribution" };
  }
  const taskStore = path.join(__dirname, "task-store.js");
  const forkMint = path.join(__dirname, "fork-manifest.js");

  // Mark task BLOCKED.
  const blockReason = `verify-failure r${args.round} ${f.phase}: ${decision.reason}`;
  const r1 = spawnSync("node", [
    taskStore, "fail",
    "--task-id", f.task_id,
    "--store", args.store,
    "--reason", blockReason,
  ], { encoding: "utf-8" });
  // task-store.js may use --error rather than --reason, or `block` rather
  // than `fail`; we try the canonical name and fall back.
  let blocked = (r1.stdout || "").includes("ok") || (r1.stdout || "").includes("BLOCKED");
  if (!blocked) {
    const r2 = spawnSync("node", [
      taskStore, "block",
      "--task-id", f.task_id,
      "--store", args.store,
      "--reason", blockReason,
    ], { encoding: "utf-8" });
    blocked = (r2.stdout || "").includes("ok") || (r2.stdout || "").includes("BLOCKED");
  }

  // Mint a fork.
  const r3 = spawnSync("node", [
    forkMint, "create",
    "--task-id", f.task_id,
    "--store", args.store,
    "--manifest-dir", args.manifestDir,
    "--reason", blockReason,
  ], { encoding: "utf-8" });
  const forkLine = (r3.stdout || "").trim();

  return {
    ...decision,
    applied: blocked,
    block_status: blocked ? "blocked" : "block_failed",
    fork_status: forkLine.slice(0, 200),
  };
}

// ── Process clusters ─────────────────────────────────────────────────────

const decisions = [];
for (const [key, items] of clusters) {
  const d = triageCluster(key, items);
  if (d.decision === "quick_fix") {
    decisions.push(applyQuickFix(d));
  } else if (d.decision === "block") {
    decisions.push(applyBlock(d));
  } else {
    decisions.push({ ...d, applied: true });
  }
}

const quickFixCount = decisions.filter(d => d.decision === "quick_fix" && d.applied).length;
const quickFixFailed = decisions.filter(d => d.decision === "quick_fix" && !d.applied);
const blocks = decisions.filter(d => d.decision === "block");
const noise = decisions.filter(d => d.decision === "noise");

writeTriageReport({
  round: args.round,
  decisions,
  all_green: false,
  quick_fix_count: quickFixCount,
  quick_fix_failed_count: quickFixFailed.length,
  blocks: blocks.map(b => ({ task_id: b.items[0]?.task_id || null, reason: b.reason, status: b.block_status })),
  noise_count: noise.length,
});

console.log(`ok:triage round=${args.round} clusters=${clusters.size} quick_fix=${quickFixCount} quick_fix_failed=${quickFixFailed.length} block=${blocks.length} noise=${noise.length}`);

// ── M5 §5.1: Tier 1 → Tier 2 auto-escalation ──────────────────────────────
// When triage routed any failures to BLOCKED (forks minted) and --auto-deliberate
// is set, immediately run the Tier 2 council deliberation instead of waiting for
// the orchestrator to do it. Opt-in so the supervised round-cap loop is preserved.
if (args.autoDeliberate && blocks.length > 0) {
  const deliberate = path.join(__dirname, "deliberate-fork.js");
  console.log(`auto-deliberate: ${blocks.length} block(s) → Tier 2 deliberation`);
  const r = spawnSync("node", [
    deliberate,
    "--manifest-dir", args.manifestDir,
    "--store", args.store,
    "--all",
  ], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, timeout: 1800000 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-3).join(" | ");
  console.log(`auto-deliberate result: ${out.slice(0, 400)}`);
}

// ── Report writer ────────────────────────────────────────────────────────

function writeTriageReport(summary) {
  const out = [];
  out.push(`triage_timestamp: "${new Date().toISOString()}"`);
  out.push(`round: ${summary.round}`);
  out.push(`all_green: ${summary.all_green}`);
  out.push(`quick_fix_count: ${summary.quick_fix_count || 0}`);
  out.push(`quick_fix_failed_count: ${summary.quick_fix_failed_count || 0}`);
  out.push(`noise_count: ${summary.noise_count || 0}`);
  out.push(`unresolved_blocks: ${summary.blocks?.length || 0}`);

  if (summary.blocks && summary.blocks.length > 0) {
    out.push(`blocks:`);
    for (const b of summary.blocks) {
      out.push(`  - task_id: ${b.task_id || "null"}`);
      out.push(`    status: ${b.status || "unknown"}`);
      out.push(`    reason: ${JSON.stringify(b.reason || "")}`);
    }
  } else {
    out.push(`blocks: []`);
  }

  if (summary.decisions && summary.decisions.length > 0) {
    out.push(`decisions:`);
    for (const d of summary.decisions) {
      out.push(`  - cluster: ${d.key || "?"}`);
      out.push(`    decision: ${d.decision}`);
      out.push(`    applied: ${d.applied ? "true" : "false"}`);
      if (d.items && d.items[0]) {
        out.push(`    task_id: ${d.items[0].task_id || "null"}`);
        out.push(`    file_path: ${d.items[0].file_path || "null"}`);
        out.push(`    phase: ${d.items[0].phase || "null"}`);
      }
      out.push(`    reason: ${JSON.stringify(d.reason || "")}`);
      if (d.error) out.push(`    error: ${JSON.stringify(d.error)}`);
      if (d.worker_status) out.push(`    worker_status: ${JSON.stringify(d.worker_status)}`);
    }
  } else {
    out.push(`decisions: []`);
  }

  fs.mkdirSync(args.wikiDir, { recursive: true });
  fs.writeFileSync(path.join(args.wikiDir, "triage-report.yaml"), out.join("\n") + "\n");
}
