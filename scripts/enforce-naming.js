#!/usr/bin/env node
// enforce-naming.js — validate and fix canonical ID naming across manifest artifacts.
// Enforces naming conventions for epics, task groups, tasks, and contracts.
// Modes: --check (default, exit 1 on violation) or --fix (normalize + rewrite refs).

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ═══════════════════════════════════════════════════════════════════════════
// NAMING CONVENTIONS (from manifest-schema.md)
// ═══════════════════════════════════════════════════════════════════════════

const CONVENTIONS = {
  epic: {
    dir: "epics",
    idField: "epic_id",
    regex: /^(EPIC-\d{3}|E-GLUE-\d{3})$/,
    pattern: "EPIC-NNN or E-GLUE-NNN",
  },
  task_group: {
    dir: "task-groups",
    idField: "group_id",
    regex: /^GRP-[A-Z][A-Z0-9]*-\d{3}$/,
    pattern: "GRP-{AREA}-NNN",
  },
  task: {
    dir: "tasks",
    idField: "task_id",
    regex: /^TASK-[A-Z][A-Z0-9]*-\d{4}$/,
    pattern: "TASK-{AREA}-NNNN",
  },
  contract: {
    dir: "contracts",
    idField: "contract_id",
    regex: /^CONTRACT-[A-Z0-9]+(-[A-Z0-9]+)*-\d{3}$/,
    pattern: "CONTRACT-{DOMAIN}-NNN",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a word-boundary-safe regex for replacing oldId with newId.
 * Matches oldId only when surrounded by non-alphanumeric, non-dash, non-underscore chars.
 */
function makeIdReplaceRegex(oldId) {
  return new RegExp(`(?<![\\w-])${escapeRegex(oldId)}(?![\\w-])`, "g");
}

/**
 * Extract the area/domain token from an old ID.
 * Examples:
 *   TG-API-001 → API
 *   DB-TG-001 → DB
 *   CONTRACT-USER-001 → USER
 * Strategy: find the first 2+ char uppercase token that's not a known prefix.
 */
function extractAreaFromOldId(oldId) {
  if (!oldId) return "GEN";
  const tokens = oldId.split(/[-_]/);
  // Known non-area prefixes to skip
  const skipTokens = new Set(["TG", "TASK", "CTRCT", "CTR", "CONTRACT", "EPIC", "E"]);

  for (const token of tokens) {
    if (
      token.length >= 2 &&
      /^[A-Z][A-Z0-9]*$/.test(token) &&
      !/^\d+$/.test(token) &&
      !skipTokens.has(token)
    ) {
      return token;
    }
  }
  return "GEN";
}

/**
 * Recursively find all YAML files in a directory, excluding _raw paths and director-* subdirs.
 */
function findYamlFiles(dir, topLevelOnly = false) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(dir, fullPath);

    // Skip _raw paths and director-* subdirectories
    if (relPath.includes("_raw") || entry.name.startsWith("director-")) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!topLevelOnly) {
        results.push(...findYamlFiles(fullPath, false));
      }
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Find all YAML files for a single artifact type (top-level only).
 */
function findArtifactFiles(manifestDir, type) {
  const typeDir = path.join(manifestDir, CONVENTIONS[type].dir);
  if (!fs.existsSync(typeDir)) return [];

  const results = [];
  const entries = fs.readdirSync(typeDir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip directories (including director-*/) and non-YAML files
    if (entry.isFile() && entry.name.endsWith(".yaml")) {
      results.push(path.join(typeDir, entry.name));
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK MODE
// ═══════════════════════════════════════════════════════════════════════════

function checkManifest(manifestDir) {
  const violations = [];
  const stats = { epics: 0, task_groups: 0, tasks: 0, contracts: 0 };

  for (const type of ["epic", "task_group", "task", "contract"]) {
    const convention = CONVENTIONS[type];
    const files = findArtifactFiles(manifestDir, type);

    for (const file of files) {
      let data;
      try {
        data = yaml.load(fs.readFileSync(file, "utf-8")) || {};
      } catch (e) {
        console.error(`err:naming:parse_error:${file}:${e.message}`);
        process.exit(1);
      }

      stats[type]++;
      const id = data[convention.idField];

      if (!id) {
        violations.push({
          type,
          file: path.basename(file),
          id: "(missing)",
          expected: convention.pattern,
        });
      } else if (!convention.regex.test(id)) {
        violations.push({
          type,
          file: path.basename(file),
          id,
          expected: convention.pattern,
        });
      }
    }
  }

  return { violations, stats };
}

// ═══════════════════════════════════════════════════════════════════════════
// FIX MODE
// ═══════════════════════════════════════════════════════════════════════════

function buildRenameMap(manifestDir, includeEpics = false) {
  const map = {}; // oldId → newId
  // Separate sequences by type and area
  const tgSequences = {}; // area → {canonical: [nums], violating: [assigned]}
  const taskSequences = {}; // area → {canonical: [nums], violating: [assigned]}
  const contractSequences = {}; // domain → {canonical: [nums], violating: [assigned]}
  const allIds = new Set(); // all existing IDs (for collision detection)
  const violatingIds = {}; // oldId → {type, data, file}

  // First pass: collect canonical IDs and identify violating ones
  for (const type of ["epic", "task_group", "task", "contract"]) {
    const convention = CONVENTIONS[type];
    if (type === "epic" && !includeEpics) continue;

    const files = findArtifactFiles(manifestDir, type);
    for (const file of files) {
      let data;
      try {
        data = yaml.load(fs.readFileSync(file, "utf-8")) || {};
      } catch (e) {
        continue;
      }

      const id = data[convention.idField];
      if (!id) continue;

      allIds.add(id);

      // Check if canonical
      if (type === "epic" && id.startsWith("E-GLUE-")) {
        // E-GLUE-* are never renamed
        continue;
      }

      if (!convention.regex.test(id)) {
        // Violating ID
        violatingIds[id] = { type, data, file };
        continue;
      }

      // Canonical ID - record its sequence number for continuation
      if (type === "task_group") {
        const match = id.match(/^GRP-([A-Z][A-Z0-9]*)-(\d{3})$/);
        if (match) {
          const area = match[1];
          const num = parseInt(match[2], 10);
          if (!tgSequences[area]) tgSequences[area] = { canonical: [], violating: [] };
          tgSequences[area].canonical.push(num);
        }
      } else if (type === "task") {
        const match = id.match(/^TASK-([A-Z][A-Z0-9]*)-(\d{4})$/);
        if (match) {
          const area = match[1];
          const num = parseInt(match[2], 10);
          if (!taskSequences[area]) taskSequences[area] = { canonical: [], violating: [] };
          taskSequences[area].canonical.push(num);
        }
      } else if (type === "contract") {
        const match = id.match(/^CONTRACT-([A-Z0-9]+(?:-[A-Z0-9]+)*)-(\d{3})$/);
        if (match) {
          const domain = match[1];
          const num = parseInt(match[2], 10);
          if (!contractSequences[domain]) contractSequences[domain] = { canonical: [], violating: [] };
          contractSequences[domain].canonical.push(num);
        }
      }
    }
  }

  // Second pass: assign new canonical IDs to violating ones
  for (const oldId of Object.keys(violatingIds)) {
    const { type, data } = violatingIds[oldId];
    const convention = CONVENTIONS[type];
    let newId;

    if (type === "epic") {
      // EPIC non-canonical → EPIC-NNN; don't rename E-GLUE
      const match = oldId.match(/\d{3}$/);
      if (match) {
        newId = `EPIC-${match[0]}`;
      } else {
        newId = `EPIC-001`;
      }
    } else if (type === "task_group") {
      const area = data.functional_area || data.area || extractAreaFromOldId(oldId);
      if (!tgSequences[area]) tgSequences[area] = { canonical: [], violating: [] };
      const seq = tgSequences[area];
      const allNums = [...seq.canonical, ...seq.violating];
      const nextNum = (allNums.length === 0 ? 0 : Math.max(...allNums)) + 1;
      newId = `GRP-${area}-${String(nextNum).padStart(3, "0")}`;
      seq.violating.push(nextNum);
    } else if (type === "task") {
      const area = data.functional_area || data.area || extractAreaFromOldId(oldId);
      if (!taskSequences[area]) taskSequences[area] = { canonical: [], violating: [] };
      const seq = taskSequences[area];
      const allNums = [...seq.canonical, ...seq.violating];
      const nextNum = (allNums.length === 0 ? 0 : Math.max(...allNums)) + 1;
      newId = `TASK-${area}-${String(nextNum).padStart(4, "0")}`;
      seq.violating.push(nextNum);
    } else if (type === "contract") {
      const domain =
        data.owner_area ||
        data.produced_by_area ||
        data.domain ||
        extractAreaFromOldId(oldId);
      if (!contractSequences[domain]) contractSequences[domain] = { canonical: [], violating: [] };
      const seq = contractSequences[domain];
      const allNums = [...seq.canonical, ...seq.violating];
      const nextNum = (allNums.length === 0 ? 0 : Math.max(...allNums)) + 1;
      newId = `CONTRACT-${domain}-${String(nextNum).padStart(3, "0")}`;
      seq.violating.push(nextNum);
    }

    // Collision check: newId must not exist as a different artifact
    if (allIds.has(newId) && newId !== oldId) {
      return { error: `collision:${newId}` };
    }

    map[oldId] = newId;
  }

  // Collision check: no two oldIds should map to the same newId
  const newIdValues = Object.values(map);
  const seen = new Set();
  for (const newId of newIdValues) {
    if (seen.has(newId)) {
      return { error: `duplicate_mapping:${newId}` };
    }
    seen.add(newId);
  }

  return { map };
}

function applyRenames(manifestDir, renameMap) {
  // Collect all YAML files (including non-artifact files) to rewrite references
  const allYamlFiles = findYamlFiles(manifestDir, false);

  // Process longer IDs first to avoid prefix overlap
  const sortedOldIds = Object.keys(renameMap).sort((a, b) => b.length - a.length);

  const renames = [];

  // 1. Rewrite all references in all YAML files
  for (const file of allYamlFiles) {
    // Skip _raw paths
    if (file.includes("_raw")) continue;

    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch (e) {
      continue;
    }

    let modified = content;
    for (const oldId of sortedOldIds) {
      const newId = renameMap[oldId];
      const regex = makeIdReplaceRegex(oldId);
      modified = modified.replace(regex, newId);
    }

    if (modified !== content) {
      fs.writeFileSync(file, modified, "utf-8");
    }
  }

  // 2. Rename the artifact files themselves
  for (const type of ["epic", "task_group", "task", "contract"]) {
    const convention = CONVENTIONS[type];
    const typeDir = path.join(manifestDir, convention.dir);
    if (!fs.existsSync(typeDir)) continue;

    const files = findArtifactFiles(manifestDir, type);
    for (const file of files) {
      const basename = path.basename(file);
      const idWithoutExt = basename.replace(/\.yaml$/, "");

      if (renameMap[idWithoutExt]) {
        const newBasename = `${renameMap[idWithoutExt]}.yaml`;
        const newFile = path.join(typeDir, newBasename);
        fs.renameSync(file, newFile);
        renames.push({ from: basename, to: newBasename });
      }
    }
  }

  return renames;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════════

function writeReport(reportPath, summary, violations = [], renames = []) {
  const report = {
    summary: {
      epics: summary.epics || 0,
      task_groups: summary.task_groups || 0,
      tasks: summary.tasks || 0,
      contracts: summary.contracts || 0,
      violations: violations.length,
      mode: summary.mode || "check",
    },
  };

  if (violations.length > 0) {
    report.violations = violations;
  }

  if (renames.length > 0) {
    report.renames = renames;
  }

  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(reportPath, yaml.dump(report), "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLI
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = {
    manifestDir: null,
    mode: "check", // check or fix
    includeEpics: false,
    reportPath: null,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--manifest-dir" && i + 1 < process.argv.length) {
      args.manifestDir = process.argv[++i];
    } else if (arg === "--check") {
      args.mode = "check";
    } else if (arg === "--fix") {
      args.mode = "fix";
    } else if (arg === "--include-epics") {
      args.includeEpics = true;
    } else if (arg === "--report" && i + 1 < process.argv.length) {
      args.reportPath = process.argv[++i];
    }
  }

  return args;
}

function main() {
  const args = parseArgs();

  if (!args.manifestDir) {
    process.stderr.write("err:naming:usage:node enforce-naming.js --manifest-dir <dir> [--check|--fix] [--include-epics] [--report <path>]\n");
    process.exit(1);
  }

  // Default report path
  if (!args.reportPath) {
    const wikiDir = path.join(args.manifestDir, "..", "wiki");
    args.reportPath = path.join(wikiDir, "naming-report.yaml");
  }

  if (args.mode === "check") {
    const { violations, stats } = checkManifest(args.manifestDir);
    writeReport(args.reportPath, { ...stats, mode: "check" }, violations);

    if (violations.length === 0) {
      const totalArtifacts = stats.epics + stats.task_groups + stats.tasks + stats.contracts;
      console.log(`ok:naming clean (${totalArtifacts} artifacts checked)`);
      process.exit(0);
    } else {
      console.log(`err:naming:${violations.length} violation(s) — see ${args.reportPath}`);
      process.exit(1);
    }
  } else if (args.mode === "fix") {
    // Build the rename map
    const mapResult = buildRenameMap(args.manifestDir, args.includeEpics);
    if (mapResult.error) {
      console.log(`err:naming:fix_collision:${mapResult.error}`);
      process.exit(1);
    }

    const renameMap = mapResult.map;
    if (Object.keys(renameMap).length === 0) {
      // Nothing to fix; re-validate to confirm clean
      const { violations, stats } = checkManifest(args.manifestDir);
      writeReport(args.reportPath, { ...stats, mode: "fix" }, violations);
      if (violations.length === 0) {
        console.log(`ok:naming fixed (0 renamed, now clean)`);
        process.exit(0);
      } else {
        console.log(`err:naming:still ${violations.length} after fix`);
        process.exit(1);
      }
    }

    // Apply renames
    const renames = applyRenames(args.manifestDir, renameMap);

    // Re-validate
    const { violations, stats } = checkManifest(args.manifestDir);
    writeReport(args.reportPath, { ...stats, mode: "fix" }, violations, renames);

    if (violations.length === 0) {
      console.log(`ok:naming fixed (${renames.length} renamed, now clean)`);
      process.exit(0);
    } else {
      console.log(`err:naming:still ${violations.length} after fix`);
      process.exit(1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS (for testing)
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  checkManifest,
  buildRenameMap,
  applyRenames,
  writeReport,
  makeIdReplaceRegex,
  extractAreaFromOldId,
  findYamlFiles,
  findArtifactFiles,
};

if (require.main === module) {
  main();
}
