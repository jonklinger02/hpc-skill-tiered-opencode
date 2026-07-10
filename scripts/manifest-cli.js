#!/usr/bin/env node
/**
 * manifest-cli.js — Manifest CRUD operations for planning councils
 *
 * The MANIFEST is the single source of truth. Planning councils CALL this tool
 * (via their Bash tool) to KNOW the live manifest and ADD/UPDATE it in place.
 *
 * Artifact types → dir + id field (top-level *.yaml only; IGNORE subdirs + any path containing `_raw`):
 *   contract   → contracts/      id `contract_id`
 *   task_group → task-groups/    id `group_id`
 *   task       → tasks/          id `task_id`
 *   epic       → epics/          id `epic_id`
 *
 * Usage:
 *   node scripts/manifest-cli.js --manifest-dir <dir> <op> [flags]
 *
 * Read ops (print to stdout for the council to consume; compact, parseable):
 *   list --type <T>              → JSON array of {id, name, area/domain}
 *   get --type <T> --id <ID>     → the artifact's YAML verbatim (or `err:not_found`)
 *   surfaces                      → JSON map of contract_id → [surface symbol names]
 *
 * Write ops (mutate the manifest in place; atomic tmp+rename per file):
 *   add --type <T> --id <ID> --content-file <f>     → write to <dir>/<ID>.yaml
 *   update --type <T> --id <ID> --content-file <f>  → overwrite existing
 *
 * On write success: `ok:<op> <type> <ID>`. On error: `err:<reason>`, exit 1.
 * Read ops exit 0; `get` on missing id prints `err:not_found`, exit 1.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { op: null, type: null, id: null, contentFile: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--manifest-dir") {
      parsed.manifestDir = args[++i];
    } else if (arg === "--type") {
      parsed.type = args[++i];
    } else if (arg === "--id") {
      parsed.id = args[++i];
    } else if (arg === "--content-file") {
      parsed.contentFile = args[++i];
    } else if (!arg.startsWith("--")) {
      parsed.op = arg;
    }
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if an ID matches the canonical pattern for its type.
 * Returns true if valid, false otherwise.
 */
function isValidId(type, id) {
  switch (type) {
    case "contract":
      return /^CONTRACT-[A-Z0-9]+(-[A-Z0-9]+)*-\d{3}$/.test(id);
    case "task_group":
      return /^GRP-[A-Z][A-Z0-9]*-\d{3}$/.test(id);
    case "task":
      return /^TASK-[A-Z][A-Z0-9]*-\d{4}$/.test(id);
    case "epic":
      return /^EPIC-\d{3}$/.test(id) || /^E-GLUE-\d{3}$/.test(id);
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the subdirectory name for a given type.
 */
function getTypeDir(type) {
  switch (type) {
    case "contract":
      return "contracts";
    case "task_group":
      return "task-groups";
    case "task":
      return "tasks";
    case "epic":
      return "epics";
    default:
      return null;
  }
}

/**
 * Get the full path to the artifact file.
 */
function getArtifactPath(manifestDir, type, id) {
  const typeDir = getTypeDir(type);
  if (!typeDir) return null;
  return path.join(manifestDir, typeDir, `${id}.yaml`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory scanning (skip subdirs and _raw paths)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all top-level .yaml files in a directory, skipping subdirectories
 * and paths containing "_raw".
 */
function getTopLevelYamlFiles(dir) {
  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  try {
    for (const file of fs.readdirSync(dir)) {
      // Skip files/paths containing _raw
      if (file.includes("_raw")) continue;

      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      // Skip subdirectories
      if (stat.isDirectory()) continue;

      // Only .yaml files
      if (file.endsWith(".yaml")) {
        files.push({ name: file, path: fullPath });
      }
    }
  } catch (e) {
    // Return empty list on error
  }

  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// ID extraction from YAML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the ID field from a YAML artifact.
 * Returns the ID value or null if parsing fails or field is missing.
 */
function extractIdFromYaml(content, type) {
  try {
    const obj = yaml.load(content);
    if (!obj) return null;

    switch (type) {
      case "contract":
        return obj.contract_id || null;
      case "task_group":
        return obj.group_id || null;
      case "task":
        return obj.task_id || null;
      case "epic":
        return obj.epic_id || null;
      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface extraction (for contracts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract surface symbol names from a contract YAML.
 * Tolerantly handles surface as a list of {kind, name, ...} objects.
 * Returns an array of surface names.
 */
function extractSurfaceNames(content) {
  try {
    const obj = yaml.load(content);
    if (!obj || !obj.surface) return [];

    const surface = obj.surface;
    if (!Array.isArray(surface)) return [];

    return surface
      .filter(item => item && typeof item === "object" && item.name)
      .map(item => item.name);
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Read operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List operation: return JSON array of {id, name, area/domain} for all artifacts of type T.
 * For contracts, also include `surface` = array of surface symbol names.
 */
function opList(manifestDir, type) {
  const typeDir = getTypeDir(type);
  if (!typeDir) {
    console.log("err:invalid_type");
    process.exit(1);
  }

  const dir = path.join(manifestDir, typeDir);
  const files = getTopLevelYamlFiles(dir);

  const results = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const id = extractIdFromYaml(content, type);

      if (!id) continue;

      const obj = yaml.load(content);
      const result = {
        id,
        name: obj.name || "",
      };

      // Add area or domain field if present
      if (obj.area) result.area = obj.area;
      if (obj.domain) result.domain = obj.domain;

      // For contracts, add surface symbol names
      if (type === "contract") {
        result.surface = extractSurfaceNames(content);
      }

      results.push(result);
    } catch (e) {
      // Skip files that don't parse
    }
  }

  console.log(JSON.stringify(results));
}

/**
 * Get operation: return the artifact's YAML verbatim or err:not_found.
 */
function opGet(manifestDir, type, id) {
  const artifactPath = getArtifactPath(manifestDir, type, id);
  if (!artifactPath) {
    console.log("err:not_found");
    process.exit(1);
  }

  if (!fs.existsSync(artifactPath)) {
    console.log("err:not_found");
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(artifactPath, "utf-8");
    console.log(content);
  } catch (e) {
    console.log("err:not_found");
    process.exit(1);
  }
}

/**
 * Surfaces operation: return JSON map { <contract_id>: [<surface symbol names>], ... }
 * across ALL contracts. Skips files in subdirectories and paths with "_raw".
 */
function opSurfaces(manifestDir) {
  const contractsDir = path.join(manifestDir, "contracts");
  const files = getTopLevelYamlFiles(contractsDir);

  const result = {};

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.path, "utf-8");
      const contractId = extractIdFromYaml(content, "contract");

      if (contractId) {
        const surfaceNames = extractSurfaceNames(content);
        result[contractId] = surfaceNames;
      }
    } catch (e) {
      // Skip files that don't parse
    }
  }

  console.log(JSON.stringify(result));
}

// ─────────────────────────────────────────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add operation: write artifact from content-file to <dir>/<ID>.yaml.
 * Validates: file parses as YAML and id field === <ID>.
 * Errors on existence or ID mismatch.
 */
function opAdd(manifestDir, type, id, contentFile) {
  // Validate ID format
  if (!isValidId(type, id)) {
    console.log("err:bad_id");
    process.exit(1);
  }

  // Read and parse content file
  let content;
  try {
    content = fs.readFileSync(contentFile, "utf-8");
  } catch (e) {
    console.log("err:cannot_read_content_file");
    process.exit(1);
  }

  // Parse as YAML to validate and extract ID
  let obj;
  try {
    obj = yaml.load(content);
  } catch (e) {
    console.log("err:invalid_yaml");
    process.exit(1);
  }

  if (!obj) {
    console.log("err:invalid_yaml");
    process.exit(1);
  }

  // Validate ID match
  const contentId = extractIdFromYaml(content, type);
  if (contentId !== id) {
    console.log("err:id_mismatch");
    process.exit(1);
  }

  // Get artifact path and check if it already exists
  const artifactPath = getArtifactPath(manifestDir, type, id);
  if (!artifactPath) {
    console.log("err:invalid_type");
    process.exit(1);
  }

  if (fs.existsSync(artifactPath)) {
    console.log(`err:exists:${id}`);
    process.exit(1);
  }

  // Create directory if needed
  const dir = path.dirname(artifactPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.log("err:cannot_create_dir");
    process.exit(1);
  }

  // Write atomically: tmp + rename
  const tmpPath = artifactPath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, artifactPath);
    console.log(`ok:add ${type} ${id}`);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    console.log("err:write_failed");
    process.exit(1);
  }
}

/**
 * Update operation: overwrite existing artifact from content-file.
 * Same validation as add, but artifact MUST exist.
 */
function opUpdate(manifestDir, type, id, contentFile) {
  // Validate ID format
  if (!isValidId(type, id)) {
    console.log("err:bad_id");
    process.exit(1);
  }

  // Get artifact path and check if it exists
  const artifactPath = getArtifactPath(manifestDir, type, id);
  if (!artifactPath) {
    console.log("err:invalid_type");
    process.exit(1);
  }

  if (!fs.existsSync(artifactPath)) {
    console.log("err:not_found");
    process.exit(1);
  }

  // Read and parse content file
  let content;
  try {
    content = fs.readFileSync(contentFile, "utf-8");
  } catch (e) {
    console.log("err:cannot_read_content_file");
    process.exit(1);
  }

  // Parse as YAML to validate and extract ID
  let obj;
  try {
    obj = yaml.load(content);
  } catch (e) {
    console.log("err:invalid_yaml");
    process.exit(1);
  }

  if (!obj) {
    console.log("err:invalid_yaml");
    process.exit(1);
  }

  // Validate ID match
  const contentId = extractIdFromYaml(content, type);
  if (contentId !== id) {
    console.log("err:id_mismatch");
    process.exit(1);
  }

  // Write atomically: tmp + rename
  const tmpPath = artifactPath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, artifactPath);
    console.log(`ok:update ${type} ${id}`);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    console.log("err:write_failed");
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();

  if (!args.manifestDir) {
    console.log("err:missing --manifest-dir");
    process.exit(1);
  }

  if (!args.op) {
    console.log("err:missing operation");
    process.exit(1);
  }

  switch (args.op) {
    case "list":
      if (!args.type) {
        console.log("err:list requires --type");
        process.exit(1);
      }
      opList(args.manifestDir, args.type);
      break;

    case "get":
      if (!args.type || !args.id) {
        console.log("err:get requires --type and --id");
        process.exit(1);
      }
      opGet(args.manifestDir, args.type, args.id);
      break;

    case "surfaces":
      opSurfaces(args.manifestDir);
      break;

    case "add":
      if (!args.type || !args.id || !args.contentFile) {
        console.log("err:add requires --type, --id, and --content-file");
        process.exit(1);
      }
      opAdd(args.manifestDir, args.type, args.id, args.contentFile);
      break;

    case "update":
      if (!args.type || !args.id || !args.contentFile) {
        console.log("err:update requires --type, --id, and --content-file");
        process.exit(1);
      }
      opUpdate(args.manifestDir, args.type, args.id, args.contentFile);
      break;

    default:
      console.log(`err:unknown_operation:${args.op}`);
      process.exit(1);
  }
}

main();
