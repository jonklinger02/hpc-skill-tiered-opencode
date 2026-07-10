#!/usr/bin/env node
/**
 * manifest-freeze.js — Freeze manifest and generate wiki hierarchy
 * 
 * Usage:
 *   node manifest-freeze.js --manifest-dir <dir>
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest-dir") parsed.manifestDir = args[++i];
  }
  return parsed;
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith(".yaml")).length;
}

function main() {
  const args = parseArgs();
  if (!args.manifestDir) {
    console.log("err:--manifest-dir required");
    process.exit(1);
  }

  // Update manifest.yaml status
  const manifestFile = path.join(args.manifestDir, "manifest.yaml");
  let manifest = "";
  if (fs.existsSync(manifestFile)) {
    manifest = fs.readFileSync(manifestFile, "utf-8");
    manifest = manifest.replace(/status:\s*\w+/, "status: APPROVED");
  } else {
    manifest = `manifest_id: "${Date.now()}"\nversion: "1.0.0"\nstatus: APPROVED\n`;
  }
  // Re-runs must not append the freeze fields twice — duplicate YAML keys make
  // js-yaml throw, which downstream loadYAML helpers swallow into null.
  if (/^frozen_at:/m.test(manifest)) {
    console.log("ok:manifest already frozen — freeze fields not re-appended");
  } else {
    manifest += `\nfrozen_at: "${new Date().toISOString()}"\n`;
    manifest += `epic_count: ${countFiles(path.join(args.manifestDir, "epics"))}\n`;
    manifest += `task_group_count: ${countFiles(path.join(args.manifestDir, "task-groups"))}\n`;
    manifest += `task_count: ${countFiles(path.join(args.manifestDir, "tasks"))}\n`;
    manifest += `contract_count: ${countFiles(path.join(args.manifestDir, "contracts"))}\n`;
  }
  fs.writeFileSync(manifestFile, manifest);

  // Generate wiki directory
  const wikiDir = path.join(args.manifestDir, "..", "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });

  // Initialize wiki files — but only the ones that don't already exist, so a
  // re-run (e.g. after a fork amendment) does NOT truncate file-index.yaml or
  // reset progress.yaml, which execute.js appends to as tasks complete.
  // file-index.yaml is owned by execute.js as a top-level sequence; we leave it
  // empty so the first append produces valid YAML rather than a mash-up.
  const initIfAbsent = (name, contents) => {
    const fp = path.join(wikiDir, name);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, contents);
  };
  initIfAbsent("file-index.yaml", "");
  initIfAbsent("contract-index.yaml", "contracts: []\n");
  initIfAbsent("progress.yaml",
    `overall:\n  total_tasks: ${countFiles(path.join(args.manifestDir, "tasks"))}\n  complete: 0\n  percent_complete: 0\nlast_updated: "${new Date().toISOString()}"\n`
  );

  // Mark all contracts as frozen
  const contractsDir = path.join(args.manifestDir, "contracts");
  if (fs.existsSync(contractsDir)) {
    for (const f of fs.readdirSync(contractsDir)) {
      if (!f.endsWith(".yaml")) continue;
      const fp = path.join(contractsDir, f);
      let content = fs.readFileSync(fp, "utf-8");
      if (!content.includes("frozen:")) {
        content += "\nfrozen: true\n";
        fs.writeFileSync(fp, content);
      }
    }
  }

  console.log("ok:manifest frozen, wiki initialized");
}

main();
