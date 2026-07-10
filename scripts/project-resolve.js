#!/usr/bin/env node
"use strict";
/**
 * project-resolve.js — resolve (or create) the stable PROJECT a build maps into.
 *
 * Reads the manifest's tech_stack + detected infra, picks a structure profile,
 * and resolves a project identity (canonical root + profile + build history)
 * via hpc-lib/project.js. This is what un-silos output: every build resolves
 * the SAME project when launched against the same target/identity, instead of
 * an isolated per-build output/ buffer.
 *
 * Usage:
 *   node project-resolve.js \
 *     --manifest-dir manifest/ \
 *     --target-dir <projectRoot> \
 *     [--project-id <id>] [--name <name>] [--profile <id>] [--registry <path>] \
 *     [--record-build <json>]      # append/update a build record, then print
 *
 * Prints: ok:project_id=<id>,root=<path>,profile=<id>,new=<bool>
 *         (and, if --record-build, builds=<count>)
 */

const fs = require("fs");
const path = require("path");
let yaml = null; try { yaml = require("js-yaml"); } catch { /* tech_stack stays empty */ }

// Resolve the vendored lib whether this file runs from a skill's scripts/ dir
// (./lib/*) or from hpc-lib/skill-scripts/ (../*).
function libreq(name) {
  try { return require(`./lib/${name}`); }
  catch { return require(`../${name}`); }
}
const structure = libreq("structure.js");
const project = libreq("project.js");

function parseArgs() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--manifest-dir": a.manifestDir = argv[++i]; break;
      case "--target-dir": a.targetDir = argv[++i]; break;
      case "--project-id": a.projectId = argv[++i]; break;
      case "--name": a.name = argv[++i]; break;
      case "--profile": a.profile = argv[++i]; break;
      case "--registry": a.registry = argv[++i]; break;
      case "--record-build": a.recordBuild = argv[++i]; break;
    }
  }
  return a;
}

function loadYaml(p) {
  try { return yaml ? yaml.load(fs.readFileSync(p, "utf-8")) : null; } catch { return null; }
}

function main() {
  const args = parseArgs();
  if (!args.targetDir) { console.log("err:usage: --target-dir <projectRoot> required"); process.exit(1); }

  // Pull tech_stack + infra from the manifest (best-effort; absent → generic).
  let techStack = [], infra = null;
  if (args.manifestDir) {
    const manifest = loadYaml(path.join(args.manifestDir, "manifest.yaml"));
    if (manifest && Array.isArray(manifest.tech_stack)) techStack = manifest.tech_stack;
    infra = loadYaml(path.join(args.manifestDir, "infra-requirements.yaml"));
  }

  // Profile: explicit flag wins; else infer from stack+infra.
  const profileId = args.profile || structure.resolveProfile(techStack, infra).id;

  const r = project.resolve({
    targetDir: args.targetDir,
    projectId: args.projectId,
    name: args.name,
    profileId,
    registryPath: args.registry,
  });

  let suffix = "";
  if (args.recordBuild) {
    let build = {};
    try { build = JSON.parse(args.recordBuild); } catch { console.log("err:invalid --record-build JSON"); process.exit(1); }
    const proj = project.recordBuild(r.projectRoot, build);
    suffix = `,builds=${proj.builds.length}`;
  }

  console.log(`ok:project_id=${r.projectId},root=${r.projectRoot},profile=${r.profileId},new=${r.isNew}${suffix}`);
}

main();
