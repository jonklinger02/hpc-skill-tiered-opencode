#!/usr/bin/env node
/**
 * fork-amend.js — Council helper that writes individual task/contract
 * amendments into a fork's amended/ directory with input validation.
 *
 * Called by sonnet during deliberate-fork.js council deliberation. Replaces
 * the monolithic-YAML output approach: each amendment becomes one helper
 * call, eliminating brittle indent-based parsing of council output.
 *
 * Usage:
 *   node fork-amend.js task     --manifest-dir <m> --fork-id F --task-id X     --content-file <p>
 *   node fork-amend.js contract --manifest-dir <m> --fork-id F --contract-id X --content-file <p>
 *   node fork-amend.js new-task --manifest-dir <m> --fork-id F --task-id X     --content-file <p>
 *
 * --content-file may be "-" to read from stdin.
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { action: args[0] };
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--fork-id": parsed.forkId = args[++i]; break;
      case "--task-id": parsed.taskId = args[++i]; break;
      case "--contract-id": parsed.contractId = args[++i]; break;
      case "--content-file": parsed.contentFile = args[++i]; break;
    }
  }
  return parsed;
}

function fail(msg) {
  process.stdout.write(`err:${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`ok:${msg}\n`);
  process.exit(0);
}

function readContent(args) {
  if (!args.contentFile) fail("missing_content_file:--content-file required (use - for stdin)");
  if (args.contentFile === "-") return fs.readFileSync(0, "utf-8");
  if (!fs.existsSync(args.contentFile)) fail(`content_file_not_found:${args.contentFile}`);
  return fs.readFileSync(args.contentFile, "utf-8");
}

function getForkDir(args) {
  if (!args.manifestDir) fail("missing_manifest_dir:--manifest-dir required");
  if (!args.forkId) fail("missing_fork_id:--fork-id required");
  const forkDir = path.join(args.manifestDir, "forks", args.forkId);
  if (!fs.existsSync(forkDir)) fail(`fork_not_found:${args.forkId}`);
  return forkDir;
}

function readAllowlists(forkDir) {
  const f = path.join(forkDir, "origin.yaml");
  if (!fs.existsSync(f)) return { taskIds: new Set(), contractIds: new Set() };
  const c = fs.readFileSync(f, "utf-8");
  const extract = (field) => {
    const out = new Set();
    const m = c.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s*.+\\n?)*)`, "m"));
    if (!m) return out;
    for (const line of m[1].match(/^\s+-\s*"?([^"\n]+)"?/gm) || []) {
      const lm = line.match(/^\s+-\s*"?([^"\n]+)"?/);
      if (lm) out.add(lm[1].trim());
    }
    return out;
  };
  return {
    taskIds: extract("affected_task_ids"),
    contractIds: extract("referenced_contract_ids"),
  };
}

function extractScalar(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function validateTask(content, expectedId) {
  const tid = extractScalar(content, "task_id");
  if (!tid) fail("invalid_task:body missing task_id field");
  if (tid !== expectedId) fail(`invalid_task:task_id mismatch (body="${tid}" flag="${expectedId}")`);
  if (!/^[A-Z][A-Z0-9-]+$/.test(tid)) fail(`invalid_task:task_id "${tid}" must match [A-Z][A-Z0-9-]+`);
  const canonicalPath = extractScalar(content, "file_path");
  if (!canonicalPath) fail("invalid_task:body missing file_path field");

  // Backstop: enforce one task = one file_path = one output file invariant.
  // Scan the body for path-like tokens; any non-canonical match means the
  // council described multiple deliverables in a single task — worker would
  // reject with err:ambiguity. Force a split via new-task subcommand.
  const pathRegex = /\b(?:scripts|src|lib|app|tests?|\.github)\/[A-Za-z0-9_./\-]+|[A-Za-z0-9_./\-]+\.(?:sh|py|tsx|jsx|ts|js|yaml|yml|md|toml)|\bMakefile\b/g;
  const norm = (p) => p.replace(/^\.\//, "").replace(/\/+$/, "").trim();
  const canonical = norm(canonicalPath);
  const found = new Set();
  for (const m of content.matchAll(pathRegex)) {
    const t = norm(m[0]);
    if (t && t !== canonical) found.add(t);
  }
  if (found.size > 0) {
    fail(`multi_file_deliverable:task ${tid} describes additional artifacts ${[...found].join(",")}; split into separate tasks via new-task subcommand`);
  }
}

function validateContract(content, expectedId) {
  const cid = extractScalar(content, "contract_id");
  if (!cid) fail("invalid_contract:body missing contract_id field");
  if (cid !== expectedId) fail(`invalid_contract:contract_id mismatch (body="${cid}" flag="${expectedId}")`);
}

function writeAmendment(forkDir, kind, id, content) {
  const targetDir = path.join(forkDir, "amended", kind);
  fs.mkdirSync(targetDir, { recursive: true });
  const outFile = path.join(targetDir, `${id}.yaml`);
  fs.writeFileSync(outFile, content.endsWith("\n") ? content : content + "\n");
  return outFile;
}

function amendTask(args) {
  if (!args.taskId) fail("missing_task_id:--task-id required");
  const forkDir = getForkDir(args);
  const { taskIds } = readAllowlists(forkDir);
  if (!taskIds.has(args.taskId)) {
    fail(`task_not_in_slice:${args.taskId} — slice allows: ${[...taskIds].join(",") || "(empty)"} — use 'new-task' for additions`);
  }
  const content = readContent(args);
  validateTask(content, args.taskId);
  const out = writeAmendment(forkDir, "tasks", args.taskId, content);
  ok(`amended_task=${args.taskId} file=${out}`);
}

function amendContract(args) {
  if (!args.contractId) fail("missing_contract_id:--contract-id required");
  const forkDir = getForkDir(args);
  const { contractIds } = readAllowlists(forkDir);
  if (!contractIds.has(args.contractId)) {
    fail(`contract_not_in_slice:${args.contractId} — slice allows: ${[...contractIds].join(",") || "(empty)"}`);
  }
  const content = readContent(args);
  validateContract(content, args.contractId);
  const out = writeAmendment(forkDir, "contracts", args.contractId, content);
  ok(`amended_contract=${args.contractId} file=${out}`);
}

function newTask(args) {
  if (!args.taskId) fail("missing_task_id:--task-id required");
  const forkDir = getForkDir(args);
  const { taskIds } = readAllowlists(forkDir);
  if (taskIds.has(args.taskId)) {
    fail(`task_already_in_slice:${args.taskId} — use 'task' subcommand to amend existing tasks`);
  }
  const content = readContent(args);
  validateTask(content, args.taskId);
  const out = writeAmendment(forkDir, "tasks", args.taskId, content);
  ok(`new_task=${args.taskId} file=${out}`);
}

const args = parseArgs();
switch (args.action) {
  case "task": amendTask(args); break;
  case "contract": amendContract(args); break;
  case "new-task": newTask(args); break;
  default:
    fail(`unknown_action:${args.action || "(none)"} — must be one of: task, contract, new-task`);
}
