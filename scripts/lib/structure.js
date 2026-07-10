"use strict";
/**
 * structure.js — framework structure-profile authority (dependency-free).
 *
 * The single source of truth for "where does a generated file belong in a
 * project of framework X". Both hpc-skill and hpc-skill-tiered vendor a synced
 * copy of this module (see hpc-lib/sync.js); the canonical source lives in
 * hpc-lib/. No external deps so it runs identically standalone or vendored.
 *
 * Profiles are JSON files in ./profiles (canonical) or, when vendored in a
 * skill, ../../references/structure-profiles. Each profile is data:
 *
 *   {
 *     "id": "nextjs-app",
 *     "description": "...",
 *     "priority": 60,
 *     "match": { "frameworks": ["nextjs","next"], "languages": [], "signals": ["app-router"] },
 *     "root_markers": ["next.config.js","package.json"],
 *     "entry_files": ["app/layout.tsx","app/page.tsx"],
 *     "default_role": "lib",
 *     "classify": [ { "pattern": "(^|/)app/...route\\.[tj]sx?$", "role": "api" }, ... ],
 *     "layout":   { "route": "app", "api": "app/api", "component": "components", ... },
 *     "enforce":  ["route","api","server","package"]   // roles whose dir is mandatory
 *   }
 *
 * Public API:
 *   listProfiles()                         -> [profile, ...]
 *   getProfile(id)                         -> profile | null
 *   resolveProfile(techStack, infra, hint) -> profile           (never throws; falls back to "generic")
 *   classifyRole(filePath, profile)        -> role string
 *   placePath(filePath, profile)           -> { path, role, moved, reason }
 *   validatePath(filePath, profile)        -> { ok, role, violations: [..] }
 */

const fs = require("fs");
const path = require("path");

// ── Profile loading ─────────────────────────────────────────────────────────

function profileDirs() {
  const dirs = [];
  if (process.env.HPC_PROFILES_DIR) dirs.push(process.env.HPC_PROFILES_DIR);
  dirs.push(path.join(__dirname, "profiles"));                               // canonical hpc-lib
  dirs.push(path.join(__dirname, "..", "..", "references", "structure-profiles")); // vendored in skill
  return dirs;
}

let _profiles = null;
function loadProfiles() {
  if (_profiles) return _profiles;
  const byId = new Map();
  for (const dir of profileDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        if (p && p.id && !byId.has(p.id)) byId.set(p.id, normalizeProfile(p));
      } catch { /* skip malformed */ }
    }
  }
  if (!byId.has("generic")) byId.set("generic", normalizeProfile(GENERIC));
  _profiles = byId;
  return _profiles;
}

function normalizeProfile(p) {
  return {
    id: p.id,
    description: p.description || "",
    priority: typeof p.priority === "number" ? p.priority : 0,
    match: {
      frameworks: (p.match && p.match.frameworks || []).map(lc),
      languages: (p.match && p.match.languages || []).map(lc),
      signals: (p.match && p.match.signals || []).map(lc),
    },
    root_markers: p.root_markers || [],
    entry_files: p.entry_files || [],
    default_role: p.default_role || "lib",
    classify: (p.classify || []).map(r => ({ pattern: r.pattern, role: r.role, re: safeRe(r.pattern) })),
    layout: p.layout || {},
    enforce: p.enforce || [],
  };
}

function safeRe(s) { try { return new RegExp(s); } catch { return null; } }
function lc(s) { return String(s == null ? "" : s).toLowerCase().trim(); }

// Always-present fallback so resolveProfile never returns null.
const GENERIC = {
  id: "generic",
  description: "No framework convention — keep paths as authored, light hygiene only.",
  priority: -1,
  default_role: "lib",
  classify: [
    { pattern: "\\.(test|spec)\\.[a-zA-Z0-9]+$", role: "test" },
    { pattern: "(^|/)(__tests__|tests?)/", role: "test" },
  ],
  layout: {},
  enforce: [],
};

// ── Profile resolution ──────────────────────────────────────────────────────

/**
 * Pick the best profile for a manifest's tech_stack + detected infra.
 * `hint` (optional) is an explicit profile id or { profile, signals: [] }.
 */
function resolveProfile(techStack, infra, hint) {
  const profs = [...loadProfiles().values()];

  // Explicit id wins outright.
  const hintId = typeof hint === "string" ? hint : (hint && hint.profile);
  if (hintId) {
    const exact = profs.find(p => p.id === hintId);
    if (exact) return exact;
  }

  // Gather signals from tech_stack + infra + hint.
  const frameworks = new Set();
  const languages = new Set();
  const signals = new Set();
  for (const item of (Array.isArray(techStack) ? techStack : [])) {
    if (!item || typeof item !== "object") continue;
    if (item.framework) frameworks.add(lc(item.framework));
    if (item.bundler) frameworks.add(lc(item.bundler));
    if (item.language) languages.add(lc(item.language));
    if (item.role) signals.add(lc(item.role));
    if (item.package_manager) signals.add(lc(item.package_manager));
  }
  if (infra && infra.framework && infra.framework.name) frameworks.add(lc(infra.framework.name));
  for (const s of (hint && Array.isArray(hint.signals) ? hint.signals : [])) signals.add(lc(s));

  // 2+ distinct packages → the top-level shape is a monorepo. The per-package
  // internal layout is resolved separately (each package's own tech_stack
  // subset) at placement/deploy time. A single package is NOT a monorepo.
  const packages = new Set((Array.isArray(techStack) ? techStack : []).map(i => i && i.package).filter(Boolean));
  if (packages.size >= 2) {
    signals.add("monorepo");
    const mono = profs.find(p => p.id === "monorepo");
    if (mono) return mono;
  }

  let best = null, bestScore = -Infinity;
  for (const p of profs) {
    let score = 0;
    for (const f of p.match.frameworks) if (frameworks.has(f)) score += 100;
    for (const l of p.match.languages) if (languages.has(l)) score += 20;
    for (const s of p.match.signals) if (signals.has(s)) score += 10;
    if (score === 0 && p.id !== "generic") continue;
    score += p.priority;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best || loadProfiles().get("generic");
}

// ── Classification + placement ──────────────────────────────────────────────

function normPath(fp) {
  return String(fp == null ? "" : fp).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Classify a file into a logical role using the profile's ordered rules. */
function classifyRole(filePath, profile) {
  const fp = normPath(filePath);
  for (const rule of (profile.classify || [])) {
    if (rule.re && rule.re.test(fp)) return rule.role;
  }
  return profile.default_role || "lib";
}

/** Is `fp` already located under directory `dir` (or is dir empty/"." = root)? */
function underDir(fp, dir) {
  if (!dir || dir === ".") return true;
  const d = dir.replace(/\/+$/, "");
  return fp === d || fp.startsWith(d + "/") || fp.includes("/" + d + "/") || fp.startsWith(d + "/");
}

/**
 * Strip a leading `src/` and any leading directory segments up to (and
 * including) the last segment that is a synonym of the target dir's basename,
 * so a misplaced file keeps its meaningful tail rather than its full old path.
 *   tailUnder("src/widgets/forms/Button.tsx", "components") -> "forms/Button.tsx"?
 * Conservative default: drop a leading `src/`, then return the remainder.
 */
function meaningfulTail(fp, dir) {
  let rest = fp.replace(/^src\//, "");
  const dirBase = (dir || "").split("/").pop();
  // If the remainder starts with the canonical dir's basename, drop that prefix
  // so we don't double it (e.g. components/Button when dir already = components).
  if (dirBase && (rest === dirBase || rest.startsWith(dirBase + "/"))) {
    rest = rest.slice(dirBase.length).replace(/^\//, "");
  }
  return rest || fp.split("/").pop();
}

/**
 * Normalize a file path to where the profile says its role belongs.
 * Conservative: a path already under the canonical dir is kept verbatim.
 * Returns { path, role, moved, reason }.
 */
function placePath(filePath, profile) {
  const fp = normPath(filePath);
  if (!fp) return { path: fp, role: profile.default_role || "lib", moved: false, reason: "empty" };
  const role = classifyRole(fp, profile);
  const dir = (profile.layout || {})[role];

  // No layout opinion for this role → keep as authored.
  if (dir == null) return { path: fp, role, moved: false, reason: "no_layout_for_role" };

  if (underDir(fp, dir)) return { path: fp, role, moved: false, reason: "already_conforms" };

  const tail = meaningfulTail(fp, dir);
  const placed = (dir === "." || dir === "") ? tail : `${dir.replace(/\/+$/, "")}/${tail}`;
  return { path: placed, role, moved: placed !== fp, reason: "relocated" };
}

/**
 * Validate a file path against the profile. Only roles listed in `enforce`
 * produce violations, so legitimately-flat files don't get flagged.
 */
function validatePath(filePath, profile) {
  const fp = normPath(filePath);
  const role = classifyRole(fp, profile);
  const violations = [];
  if ((profile.enforce || []).includes(role)) {
    const dir = (profile.layout || {})[role];
    if (dir != null && !underDir(fp, dir)) {
      violations.push({
        role, expected_dir: dir, actual: fp,
        message: `${profile.id}: ${role} file must live under '${dir}/', found '${fp}'`,
        suggested: placePath(fp, profile).path,
      });
    }
  }
  return { ok: violations.length === 0, role, violations };
}

function listProfiles() { return [...loadProfiles().values()]; }
function getProfile(id) { return loadProfiles().get(id) || null; }
function _resetCache() { _profiles = null; }

module.exports = {
  resolveProfile, classifyRole, placePath, validatePath,
  listProfiles, getProfile, _resetCache,
};
