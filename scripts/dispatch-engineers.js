#!/usr/bin/env node
/**
 * dispatch-engineers.js — Dispatch engineer councils for all (area, epic) pairs
 *
 * For each (area, epic) pair found in task-groups/, build a focused input
 * bundle (only the epic file, only the task groups for that area+epic, only
 * the contracts those task groups reference, plus shared reference files),
 * write it to a per-pair temp dir, and dispatch subagent.js with
 * --input-docs <bundle-dir>.
 *
 * Per-pair output goes to <output-dir>/engineer-<AREA>-<EPIC>/engineer-output.yaml
 * The orchestrator runs split-council-output.js on each afterwards.
 *
 * Usage:
 *   node dispatch-engineers.js --manifest-dir <dir> --model <model> \
 *     --output-dir <dir> [--max-parallel <n>] [--bundle-dir <dir>]
 */

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { maxParallel: 4 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--model": parsed.model = args[++i]; break;
      case "--output-dir": parsed.outputDir = args[++i]; break;
      case "--max-parallel": parsed.maxParallel = parseInt(args[++i]); break;
      case "--bundle-dir": parsed.bundleDir = args[++i]; break;
    }
  }
  return parsed;
}

function runAsync(cmd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve(`err:${err.message.slice(0, 200)}`);
      else resolve(stdout.trim());
    });
  });
}

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function extractField(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"));
  return m ? m[1].trim() : null;
}

function extractListField(content, field) {
  // Inline form: `field: [a, b, c]` (with or without quotes)
  const inline = content.match(new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (inline) {
    return inline[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  // Block form: `field:\n  - a\n  - b`
  const block = content.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s*.+\\n?)*)`, "m"));
  if (block) {
    return (block[1].match(/^\s+-\s*"?([^"\n]+)"?/gm) || [])
      .map(l => l.replace(/^\s+-\s*"?/, "").replace(/"?\s*$/, "").trim());
  }
  return [];
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

async function main() {
  const args = parseArgs();
  const md = args.manifestDir;
  const groupsDir = path.join(md, "task-groups");
  const contractsDir = path.join(md, "contracts");
  const epicsDir = path.join(md, "epics");

  if (!fs.existsSync(groupsDir)) {
    console.log("err:no task-groups directory found");
    process.exit(1);
  }

  // Collect all task groups by (area, epic)
  const byPair = {};
  for (const f of fs.readdirSync(groupsDir)) {
    if (!f.endsWith(".yaml")) continue;
    const fp = path.join(groupsDir, f);
    const content = fs.readFileSync(fp, "utf-8");
    const area = extractField(content, "functional_area");
    const epic = extractField(content, "epic_id");
    if (!area || !epic) continue;
    const key = `${area}:${epic}`;
    if (!byPair[key]) byPair[key] = { area, epic, groups: [] };
    byPair[key].groups.push({ file: f, path: fp, content });
  }

  const pairs = Object.values(byPair);
  if (pairs.length === 0) {
    console.log("err:no (area, epic) pairs found");
    process.exit(1);
  }

  console.log(`dispatching ${pairs.length} engineer councils (max ${args.maxParallel} parallel)...`);
  fs.mkdirSync(args.outputDir, { recursive: true });
  const bundleRoot = args.bundleDir || path.join(md, "_raw", "engineer-bundles");
  fs.mkdirSync(bundleRoot, { recursive: true });

  const SCRIPTS = path.resolve(__dirname);

  const results = await runWithConcurrency(pairs, args.maxParallel, async (pair) => {
    const tag = `${pair.area}-${pair.epic}`;
    const bundleDir = path.join(bundleRoot, tag);
    const pairOutDir = path.join(args.outputDir, `engineer-${tag}`);

    // Resume: skip if engineer-output.yaml already exists for this pair
    const existingOutput = path.join(pairOutDir, "engineer-output.yaml");
    if (fs.existsSync(existingOutput) && fs.statSync(existingOutput).size > 0) {
      console.log(`  [${tag}] skip (already done)`);
      return { pair: tag, area: pair.area, epic: pair.epic, status: "ok" };
    }

    // Build the bundle: epic + this area's task groups for this epic + their referenced contracts
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.mkdirSync(bundleDir, { recursive: true });

    // Epic file
    const epicFile = path.join(epicsDir, `${pair.epic}.yaml`);
    if (fs.existsSync(epicFile)) copyFile(epicFile, path.join(bundleDir, `EPIC-${pair.epic}.yaml`));

    // Area's task groups for this epic
    const referencedContracts = new Set();
    for (const g of pair.groups) {
      copyFile(g.path, path.join(bundleDir, `task-group-${g.file}`));
      const produced = extractListField(g.content, "contracts_produced");
      const consumed = extractListField(g.content, "contracts_consumed");
      for (const cid of [...produced, ...consumed]) referencedContracts.add(cid);
    }

    // Referenced contracts (whatever subset of /contracts/ matches)
    for (const cid of referencedContracts) {
      const cFile = path.join(contractsDir, `${cid}.yaml`);
      if (fs.existsSync(cFile)) copyFile(cFile, path.join(bundleDir, `contract-${cid}.yaml`));
    }

    // Shared reference docs (small)
    for (const ref of ["architecture.yaml", "functional-areas.yaml", "ownership.yaml"]) {
      const rp = path.join(md, ref);
      if (fs.existsSync(rp)) copyFile(rp, path.join(bundleDir, `_ref-${ref}`));
    }

    const cmd = `node ${path.join(SCRIPTS, "subagent.js")} ` +
      `--persona engineer ` +
      `--model ${args.model} ` +
      `--input-docs "${bundleDir}" ` +
      `--area "${pair.area}" ` +
      `--manifest-dir "${args.manifestDir}" ` +   // for mint-id.js (canonical task IDs)
      `--tools "Bash" ` +                          // engineer council calls mint-id.js
      `--output-dir "${pairOutDir}" ` +
      `--phase planning`;

    // 45 min ceiling per pair — matches subagent.js PLANNING_TIMEOUT_MS. A
    // high-effort council on a large pair (esp. now that it also makes mint-id
    // Bash calls) can exceed 25 min; the wrapper must not kill it early.
    const result = await runAsync(cmd, 2700000);
    const status = result === "ok" ? "ok" : result;
    console.log(`  [${tag}] ${status}`);
    return { pair: tag, area: pair.area, epic: pair.epic, status };
  });

  let ok = 0;
  const errors = [];
  for (const r of results) {
    if (r.status === "ok") ok++;
    else errors.push(`${r.pair}: ${r.status}`);
  }

  if (errors.length === 0) {
    console.log(`ok:${ok} engineer councils completed`);
  } else {
    console.log(`err:${errors.length} of ${results.length} councils failed`);
    for (const e of errors) console.log(`  ${e}`);
  }
}

main().catch(e => {
  console.log(`err:${e.message}`);
  process.exit(1);
});
