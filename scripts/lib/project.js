"use strict";
/**
 * project.js — stable project identity + registry (dependency-free).
 *
 * Solves output siloing: instead of each build's output being a positional
 * staging buffer, a build resolves a stable PROJECT (identity + canonical root
 * + chosen structure profile) that successive builds extend.
 *
 * Metadata is JSON so this module needs no YAML dependency and runs identically
 * vendored in any skill:
 *   - <projectRoot>/.hpc/project.json   — per-project identity + build history
 *   - <registry>/registry.json          — projectId -> canonicalRoot map
 *     (registry default: $HPC_REGISTRY or ~/.hpc/registry.json)
 *
 * `.hpc/` is HPC tooling state, not a deliverable — add it to the project's
 * .gitignore (the deploy step does this).
 *
 * Public API:
 *   defaultRegistryPath()
 *   loadRegistry(p) / saveRegistry(p, reg)
 *   findProjectRoot(startDir)                 -> root | null   (walks up for .hpc/project.json)
 *   loadProject(root) / saveProject(root, obj)
 *   makeProjectId(name, root)
 *   resolve({ targetDir, projectId, name, profileId, registryPath })
 *                                             -> { projectId, projectRoot, profileId, isNew, project }
 *   recordBuild(root, build)                  -> project
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

function defaultRegistryPath() {
  return process.env.HPC_REGISTRY || path.join(os.homedir(), ".hpc", "registry.json");
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function loadRegistry(p) {
  const reg = readJson(p || defaultRegistryPath(), null);
  return (reg && typeof reg === "object" && reg.projects) ? reg : { version: 1, projects: {} };
}
function saveRegistry(p, reg) { writeJson(p || defaultRegistryPath(), reg); }

function projectFile(root) { return path.join(root, ".hpc", "project.json"); }

function loadProject(root) { return readJson(projectFile(root), null); }
function saveProject(root, obj) { writeJson(projectFile(root), obj); return obj; }

/** Walk up from startDir looking for an existing .hpc/project.json. */
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir || ".");
  for (;;) {
    if (fs.existsSync(projectFile(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function slug(s) {
  return String(s || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "project";
}

/** Deterministic id: same canonical root + name always yields the same id. */
function makeProjectId(name, root) {
  const h = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8);
  return `${slug(name)}-${h}`;
}

function nowIso(clock) {
  // Allow an injected clock so callers/tests can be deterministic.
  if (typeof clock === "function") return clock();
  return new Date().toISOString();
}

/**
 * Resolve (or create) the project identity for a build.
 *   - explicit projectId in the registry → reuse its canonical root + profile
 *   - else an existing .hpc/project.json at/above targetDir → reuse it
 *   - else create a new project rooted at targetDir
 * Always leaves .hpc/project.json on disk and the registry updated.
 */
function resolve(opts) {
  opts = opts || {};
  const registryPath = opts.registryPath || defaultRegistryPath();
  const reg = loadRegistry(registryPath);

  let projectRoot = null;
  let existing = null;

  if (opts.projectId && reg.projects[opts.projectId] && fs.existsSync(projectFile(reg.projects[opts.projectId].root))) {
    projectRoot = reg.projects[opts.projectId].root;
    existing = loadProject(projectRoot);
  } else {
    const found = findProjectRoot(opts.targetDir || ".");
    if (found) { projectRoot = found; existing = loadProject(found); }
  }

  if (existing && projectRoot) {
    // Reuse — never silently change a project's profile once chosen.
    reg.projects[existing.project_id] = { root: path.resolve(projectRoot), name: existing.name, profile: existing.structure_profile };
    saveRegistry(registryPath, reg);
    return { projectId: existing.project_id, projectRoot: path.resolve(projectRoot), profileId: existing.structure_profile, isNew: false, project: existing };
  }

  // Create a new project.
  projectRoot = path.resolve(opts.targetDir || ".");
  fs.mkdirSync(projectRoot, { recursive: true });
  const name = opts.name || path.basename(projectRoot);
  const projectId = opts.projectId || makeProjectId(name, projectRoot);
  const project = {
    project_id: projectId,
    name,
    structure_profile: opts.profileId || "generic",
    created_at: nowIso(opts.clock),
    builds: [],
  };
  saveProject(projectRoot, project);
  reg.projects[projectId] = { root: projectRoot, name, profile: project.structure_profile };
  saveRegistry(registryPath, reg);
  return { projectId, projectRoot, profileId: project.structure_profile, isNew: true, project };
}

/** Append (or update) a build record on the project. Dedupes by build_id. */
function recordBuild(root, build) {
  const project = loadProject(root);
  if (!project) throw new Error(`no .hpc/project.json at ${root}`);
  project.builds = project.builds || [];
  const i = project.builds.findIndex(b => b.build_id === build.build_id);
  if (i >= 0) project.builds[i] = { ...project.builds[i], ...build };
  else project.builds.push(build);
  saveProject(root, project);
  return project;
}

module.exports = {
  defaultRegistryPath, loadRegistry, saveRegistry,
  findProjectRoot, loadProject, saveProject, makeProjectId,
  resolve, recordBuild,
};
