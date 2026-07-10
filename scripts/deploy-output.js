#!/usr/bin/env node
"use strict";
/**
 * deploy-output.js — materialize staged HPC output into the project tree.
 *
 * Workers write generated code into hpc-workspace/output/ (a staging buffer).
 * This step lands it in the project. Unlike the old positional copy, it
 * resolves a STABLE PROJECT IDENTITY (hpc-lib/project.js): successive builds of
 * the same project deploy into the same canonical root and extend one tree
 * instead of each build siloing its own output. Each deploy is recorded on the
 * project with file provenance, so a later build overwriting an earlier build's
 * file is detected and reported rather than silently clobbered.
 *
 * Framework-standard PLACEMENT is enforced at planning time (manifest-validate
 * Gate 4) so files already sit at their canonical paths by deploy. Pass
 * --normalize-layout to additionally relocate any stragglers via the structure
 * profile (off by default — relocating can break relative imports).
 *
 * Usage:
 *   node deploy-output.js \
 *     --output-dir hpc-workspace/output/ \
 *     [--manifest-dir manifest/]        # to resolve project name + structure profile
 *     [--target-dir <projectRoot>]      # default: parent of hpc-workspace/
 *     [--project-id <id>] [--name <n>] [--profile <id>] [--registry <path>] \
 *     [--build-id <id>]                 # record this deploy as a build
 *     [--no-project]                    # legacy positional copy, no project identity
 *     [--normalize-layout]              # relocate stragglers to profile layout
 *     [--dry-run] [--overwrite]
 *
 * Returns: ok:deployed=<N>,skipped=<S>,conflicts=<C>[,root=<path>]  or  err:[description]
 */

const fs = require("fs");
const path = require("path");
const project = require("./lib/project.js");
const structure = require("./lib/structure.js");
let yaml = null; try { yaml = require("js-yaml"); } catch { /* manifest read is best-effort */ }

function parseArgs() {
  const args = process.argv.slice(2);
  const p = { dryRun: false, overwrite: false, noProject: false, normalizeLayout: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--output-dir": p.outputDir = args[++i]; break;
      case "--target-dir": p.targetDir = args[++i]; break;
      case "--manifest-dir": p.manifestDir = args[++i]; break;
      case "--project-id": p.projectId = args[++i]; break;
      case "--name": p.name = args[++i]; break;
      case "--profile": p.profile = args[++i]; break;
      case "--registry": p.registry = args[++i]; break;
      case "--build-id": p.buildId = args[++i]; break;
      case "--no-project": p.noProject = true; break;
      case "--normalize-layout": p.normalizeLayout = true; break;
      case "--dry-run": p.dryRun = true; break;
      case "--overwrite": p.overwrite = true; break;
    }
  }
  return p;
}

function walk(dir, base, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, files);
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

function shouldSkipPath(relPath) {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized.includes("node_modules/")) return "node_modules";
  if (normalized.endsWith(".symcheck.json")) return "symcheck_sidecar";
  const segments = normalized.split("/");
  if (segments.length === 1 && segments[0].endsWith(".yaml")) return "root_yaml_artifact";
  if (segments.length === 1 && segments[0].startsWith(".env")) return "env_file";
  // HPC-internal runtime/staging dirs that are never deliverables.
  if (/^(emulator|screenshots|wiki|e2e\/_diag)\//.test(normalized)) return "hpc_internal_dir";
  return null;
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function quote(s) { return `"${String(s).replace(/"/g, '\\"')}"`; }
function loadYaml(p) { try { return yaml ? yaml.load(fs.readFileSync(p, "utf-8")) : null; } catch { return null; } }
function sameContent(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** Ensure the project's .gitignore excludes HPC tooling state. */
function ensureGitignore(root) {
  const gi = path.join(root, ".gitignore");
  let txt = "";
  try { txt = fs.readFileSync(gi, "utf-8"); } catch { /* none yet */ }
  if (/^\.hpc\/?\s*$/m.test(txt)) return;
  const add = (txt && !txt.endsWith("\n") ? "\n" : "") + "\n# HPC tooling state\n.hpc/\n";
  try { fs.writeFileSync(gi, txt + add); } catch { /* best-effort */ }
}

function main() {
  const args = parseArgs();
  if (!args.outputDir) { console.log("err:missing --output-dir"); process.exit(1); }

  const outputDir = path.resolve(args.outputDir);
  if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
    console.log(`err:output-dir does not exist: ${outputDir}`); process.exit(1);
  }

  const positionalDefault = path.join(outputDir, "..", "..");

  // ── Resolve the project (unless --no-project) ──────────────────────────────
  let targetDir, profile = null, resolved = null;
  if (args.noProject) {
    targetDir = path.resolve(args.targetDir || positionalDefault);
  } else {
    const manifestDoc = args.manifestDir ? loadYaml(path.join(args.manifestDir, "manifest.yaml")) : null;
    const infraDoc = args.manifestDir ? loadYaml(path.join(args.manifestDir, "infra-requirements.yaml")) : null;
    const techStack = (manifestDoc && manifestDoc.tech_stack) || [];
    const profileId = args.profile
      || (manifestDoc && manifestDoc.structure_profile)
      || structure.resolveProfile(techStack, infraDoc).id;
    try {
      resolved = project.resolve({
        targetDir: path.resolve(args.targetDir || positionalDefault),
        projectId: args.projectId,
        name: args.name || (manifestDoc && manifestDoc.name),
        profileId,
        registryPath: args.registry,
      });
      targetDir = resolved.projectRoot;
      profile = structure.getProfile(resolved.profileId);
    } catch (e) {
      console.log(`err:project_resolve_failed:${e.message}`); process.exit(1);
    }
  }

  // Prior provenance: which build last wrote each path (for conflict detection).
  const priorOwner = {};
  if (resolved && resolved.project && Array.isArray(resolved.project.builds)) {
    for (const b of resolved.project.builds) {
      for (const f of (b.deployed_files || [])) priorOwner[f] = b.build_id;
    }
  }

  let allFiles;
  try { allFiles = walk(outputDir, outputDir, []); }
  catch (e) { console.log(`err:walk_failed:${e.message}`); process.exit(1); }

  const deployed = [];
  const skipped = [];     // { path, reason }
  const conflicts = [];   // { path, prior_build }

  for (const rel of allFiles) {
    const skipReason = shouldSkipPath(rel);
    if (skipReason) { skipped.push({ path: rel, reason: skipReason }); continue; }

    const sourcePath = path.join(outputDir, rel);

    // Canonical destination relpath. Default = authored path; --normalize-layout
    // relocates stragglers via the profile (may rewrite imports — opt-in).
    let destRel = rel.split(path.sep).join("/");
    if (args.normalizeLayout && profile) {
      const placed = structure.placePath(destRel, profile);
      if (placed.moved) destRel = placed.path;
    }
    const targetPath = path.join(targetDir, destRel);

    // Idempotent: identical content already in place → skip.
    if (fs.existsSync(targetPath) && sameContent(sourcePath, targetPath)) {
      skipped.push({ path: destRel, reason: "unchanged" }); continue;
    }

    // Cross-build conflict: a DIFFERENT prior build owns this file.
    const owner = priorOwner[destRel];
    if (owner && owner !== args.buildId) conflicts.push({ path: destRel, prior_build: owner });

    // Newest-wins guard only applies in legacy/no-overwrite mode. Within a
    // resolved project a build is authoritative for the files it produced.
    if (fs.existsSync(targetPath) && !args.overwrite && !resolved) {
      try {
        if (fs.statSync(targetPath).mtimeMs > fs.statSync(sourcePath).mtimeMs) {
          skipped.push({ path: destRel, reason: "target is newer" }); continue;
        }
      } catch (e) { skipped.push({ path: destRel, reason: `stat_failed:${e.message}` }); continue; }
    }

    if (args.dryRun) { deployed.push(destRel); continue; }

    try {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(sourcePath, targetPath);
      deployed.push(destRel);
    } catch (e) { console.log(`err:copy_failed:${destRel}:${e.message}`); process.exit(1); }
  }

  // ── Record the build on the project + ignore .hpc/ ─────────────────────────
  if (!args.dryRun && resolved) {
    ensureGitignore(targetDir);
    if (args.buildId) {
      try {
        project.recordBuild(targetDir, {
          build_id: args.buildId,
          status: "deployed",
          deployed_at: new Date().toISOString(),
          deployed_files: deployed,
          conflicts: conflicts.map(c => c.path),
        });
      } catch (e) { console.log(`warn:record_build_failed:${e.message}`); }
    }
  }

  // ── deploy-log.yaml ────────────────────────────────────────────────────────
  const wikiDir = path.join(outputDir, "..", "wiki");
  try { ensureDir(wikiDir); } catch (e) { console.log(`err:wiki_mkdir_failed:${e.message}`); process.exit(1); }
  const lines = [];
  lines.push("# Auto-generated by deploy-output.js");
  lines.push(`deployed_at: ${quote(new Date().toISOString())}`);
  lines.push(`target_dir: ${quote(targetDir)}`);
  lines.push(`source_dir: ${quote(outputDir)}`);
  if (resolved) {
    lines.push(`project_id: ${quote(resolved.projectId)}`);
    lines.push(`structure_profile: ${quote(resolved.profileId)}`);
    lines.push(`new_project: ${resolved.isNew ? "true" : "false"}`);
  }
  if (args.buildId) lines.push(`build_id: ${quote(args.buildId)}`);
  lines.push(`dry_run: ${args.dryRun ? "true" : "false"}`);
  lines.push(`normalize_layout: ${args.normalizeLayout ? "true" : "false"}`);
  const yamlList = (key, arr, fmt) => {
    if (!arr.length) { lines.push(`${key}: []`); return; }
    lines.push(`${key}:`);
    for (const x of arr) fmt(x);
  };
  yamlList("deployed", deployed, p => lines.push(`  - ${quote(p)}`));
  yamlList("skipped", skipped, s => { lines.push(`  - path: ${quote(s.path)}`); lines.push(`    reason: ${quote(s.reason)}`); });
  yamlList("conflicts", conflicts, c => { lines.push(`  - path: ${quote(c.path)}`); lines.push(`    prior_build: ${quote(c.prior_build)}`); });
  try { fs.writeFileSync(path.join(wikiDir, "deploy-log.yaml"), lines.join("\n") + "\n"); }
  catch (e) { console.log(`err:log_write_failed:${e.message}`); process.exit(1); }

  const rootNote = resolved ? `,root=${targetDir}` : "";
  console.log(`ok:deployed=${deployed.length},skipped=${skipped.length},conflicts=${conflicts.length}${rootNote}`);
}

main();
