#!/usr/bin/env node
/**
 * module-path-emit.js — Emit canonical module path manifest
 *
 * Reads declared tech_stack and file tree, emits a canonical path manifest
 * that Engineer councils and workers consult before deciding ANY import path.
 *
 * Usage:
 *   node scripts/module-path-emit.js \
 *     --manifest-dir <dir> \
 *     --output <manifest/module-paths.yaml>   # default <manifest-dir>/module-paths.yaml
 *
 * Input files (all optional, degrades gracefully):
 *   - <manifest-dir>/manifest.yaml → top-level `tech_stack`
 *   - <manifest-dir>/file-tree.yaml → top-level `file_tree`
 *
 * Output:
 *   - Writes YAML to --output with schema {module_paths: {...}}
 *   - On success: "ok:<summary>"
 *   - On error: "err:<description>" + exit 1
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const structure = require("./lib/structure.js");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir":
        parsed.manifestDir = args[++i];
        break;
      case "--output":
        parsed.output = args[++i];
        break;
    }
  }
  return parsed;
}

function loadYAML(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

/**
 * Extract all file paths from a file_tree structure.
 * Handles:
 *  - List of strings: ["path/to/file.ts", ...]
 *  - List of objects: [{path: "path/to/file.ts"}, ...]
 *  - Nested mapping: {src: {ui: {components: [...]}}, ...}
 *
 * Returns an array of unique path strings.
 */
function collectFilePaths(fileTree) {
  const paths = new Set();

  function traverse(obj, currentPrefix = "") {
    if (!obj) return;

    // If it's an array, process each element
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "string") {
          // Direct string path
          if (item.includes("/") || /\.[a-z0-9]+$/.test(item)) {
            paths.add(item);
          }
        } else if (item && typeof item === "object" && item.path) {
          // Object with path property
          if (item.path.includes("/") || /\.[a-z0-9]+$/.test(item.path)) {
            paths.add(item.path);
          }
        } else if (item && typeof item === "object") {
          // Recurse into nested objects
          traverse(item, currentPrefix);
        }
      }
    } else if (typeof obj === "object") {
      // Object (potentially a nested mapping)
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === "string") {
          // Scalar value that looks like a path
          if (value.includes("/") || /\.[a-z0-9]+$/.test(value)) {
            paths.add(value);
          }
        } else if (Array.isArray(value) || (value && typeof value === "object")) {
          // Recurse
          traverse(value, currentPrefix ? `${currentPrefix}/${key}` : key);
        }
      }
    }
  }

  traverse(fileTree);
  return Array.from(paths);
}

/**
 * Extract logical name from a file path (basename without extension).
 * E.g., "LoadingSkeleton.tsx" → "LoadingSkeleton"
 *        "useAuditLog.ts" → "useAuditLog"
 */
function getLogicalName(filePath) {
  const basename = path.basename(filePath);
  const ext = path.extname(basename);
  return ext ? basename.slice(0, -ext.length) : basename;
}

/**
 * Read the manifest's atomic tasks and derive two authoritative maps from the
 * frozen plan (tasks are where file_paths and produced symbols actually live):
 *   - filePaths: every task's file_path
 *   - symbolToPath: each produced contract symbol → the producing task's file_path
 *     (so a consumer of symbol X knows exactly which file to import it from —
 *     the binding that prevents worker import-path drift / the Vektor shim class)
 * Bare-name aliases of dotted symbols are also recorded (e.g. "Store.get" also
 * maps under "Store").
 */
function collectFromTasks(manifestDir) {
  const tasksDir = path.join(manifestDir, "tasks");
  const filePaths = [];
  const symbolToPath = {};
  if (!fs.existsSync(tasksDir)) return { filePaths, symbolToPath };
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith(".yaml")) continue;
    const doc = loadYAML(path.join(tasksDir, f));
    if (!doc || !doc.file_path) continue;
    const fp = doc.file_path;
    filePaths.push(fp);
    const produced = Array.isArray(doc.contracts_produced) ? doc.contracts_produced : [];
    for (const ref of produced) {
      const impl = ref && Array.isArray(ref.implements) ? ref.implements : [];
      for (const sym of impl) {
        if (typeof sym !== "string") continue;
        if (!(sym in symbolToPath)) symbolToPath[sym] = fp;
        // bare-name alias: "Module.method" → also "Module"; strip HTTP verb
        const m = /^([A-Z]+\s+)?([A-Za-z_./][A-Za-z0-9_.]*)/.exec(sym);
        const bare = m && m[2] ? m[2].split(".")[0] : null;
        if (bare && !(bare in symbolToPath)) symbolToPath[bare] = fp;
      }
    }
  }
  return { filePaths, symbolToPath };
}

/**
 * Determine which stack roles and frameworks are present.
 * Returns {roles: Set, frameworks: Set}
 */
function detectStack(techStack) {
  const roles = new Set();
  const frameworks = new Set();

  if (!Array.isArray(techStack)) return { roles, frameworks };

  for (const item of techStack) {
    if (!item || typeof item !== "object") continue;

    if (item.role) roles.add(item.role);
    if (item.language) frameworks.add(item.language);
    if (item.framework) frameworks.add(item.framework);
    if (item.bundler) frameworks.add(item.bundler);
  }

  return { roles, frameworks };
}

/**
 * Build the module_paths manifest from the tech_stack and file_tree.
 */
function buildModulePathsManifest(techStack, filePaths, symbolToPath = {}, profile = null) {
  const { roles, frameworks } = detectStack(techStack);

  // ─ Build logical_name_to_path ─────────────────────────────────────────
  const logicalNameToPath = {};
  for (const filePath of filePaths) {
    const logicalName = getLogicalName(filePath);
    // Only add if not already present (keep first)
    if (!(logicalName in logicalNameToPath)) {
      logicalNameToPath[logicalName] = filePath;
    }
  }

  // ─ Determine alias_anchors ─────────────────────────────────────────────
  // Build a set of common prefixes present in the file tree
  const dirPrefixes = new Set();
  for (const filePath of filePaths) {
    const dir = path.dirname(filePath);
    if (dir && dir !== ".") {
      // Add each prefix level
      const parts = dir.split("/");
      for (let i = 1; i <= parts.length; i++) {
        dirPrefixes.add(parts.slice(0, i).join("/"));
      }
    }
  }

  const aliasAnchors = {};

  // Standard anchors for react + web_ui
  if (frameworks.has("react") || roles.has("web_ui")) {
    if (dirPrefixes.has("src/ui/components") || !filePaths.length) {
      aliasAnchors["@/components"] = "src/ui/components";
    }
    if (dirPrefixes.has("src/ui/hooks") || !filePaths.length) {
      aliasAnchors["@/hooks"] = "src/ui/hooks";
    }
    if (dirPrefixes.has("src/ui/api") || !filePaths.length) {
      aliasAnchors["@/api"] = "src/ui/api";
    }
  }

  // Additional anchors for vue + web_ui
  if (frameworks.has("vue") || (roles.has("web_ui") && frameworks.has("vue"))) {
    if (dirPrefixes.has("src/components") || !filePaths.length) {
      aliasAnchors["@/components"] = "src/components";
    }
    if (dirPrefixes.has("src/views") || !filePaths.length) {
      aliasAnchors["@/views"] = "src/views";
    }
  }

  // ─ Build conventions ───────────────────────────────────────────────────
  const conventions = {};

  if (frameworks.has("react") || roles.has("web_ui")) {
    conventions.react_component_location = "src/ui/components";
    conventions.react_hook_location = "src/ui/hooks";
  }

  if (frameworks.has("express") || frameworks.has("fastify") || roles.has("api_server")) {
    conventions.server_entry_location = "src/server";
  }

  if (frameworks.has("python") || roles.has("control_plane")) {
    // Try to infer the python package root from file tree
    let pythonRoot = "src";
    // If we see common patterns, use them
    for (const prefix of dirPrefixes) {
      if (prefix && !prefix.includes("/")) {
        // Top-level dir
        pythonRoot = prefix;
        break;
      }
    }
    conventions.python_package_root = pythonRoot;
  }

  // ─ Framework-standard layout from the resolved structure profile ───────
  // The profile is the authority for where each role belongs (replacing the
  // ad-hoc react/vue/express/python table above, which is kept only as a
  // back-compat fallback for the legacy anchors). `layout` is role -> dir;
  // workers and the layout gate consult it.
  const result = {
    structure_profile: profile ? profile.id : null,
    logical_name_to_path: logicalNameToPath,
    symbol_to_path: symbolToPath,
    alias_anchors: aliasAnchors,
    conventions: conventions,
  };
  if (profile && profile.layout && Object.keys(profile.layout).length) {
    result.layout = profile.layout;
  }
  return result;
}

function main() {
  const opts = parseArgs();

  if (!opts.manifestDir) {
    console.error("err:--manifest-dir required");
    process.exit(1);
  }

  const outputPath =
    opts.output || path.join(opts.manifestDir, "module-paths.yaml");

  // Load manifest.yaml and file-tree.yaml
  const manifestPath = path.join(opts.manifestDir, "manifest.yaml");
  const fileTreePath = path.join(opts.manifestDir, "file-tree.yaml");

  const manifestDoc = loadYAML(manifestPath);
  const fileTreeDoc = loadYAML(fileTreePath);

  const techStack = manifestDoc?.tech_stack || [];
  const fileTreeRaw = fileTreeDoc?.file_tree || [];

  // Resolve the framework structure profile (explicit manifest override wins).
  const infraDoc = loadYAML(path.join(opts.manifestDir, "infra-requirements.yaml"));
  const profile = structure.resolveProfile(techStack, infraDoc, manifestDoc?.structure_profile);

  // Collect file paths from file_tree AND from the frozen atomic tasks (the
  // authoritative source of where files actually live + which symbol each
  // produces). Task data wins for symbol_to_path.
  const fromTree = collectFilePaths(fileTreeRaw);
  const { filePaths: fromTasks, symbolToPath } = collectFromTasks(opts.manifestDir);
  const filePaths = Array.from(new Set([...fromTasks, ...fromTree]));

  // Build the manifest
  const modulePathsManifest = buildModulePathsManifest(techStack, filePaths, symbolToPath, profile);

  // Count for summary
  const logicalNameCount = Object.keys(modulePathsManifest.logical_name_to_path).length;
  const symbolCount = Object.keys(modulePathsManifest.symbol_to_path).length;
  const anchorCount = Object.keys(modulePathsManifest.alias_anchors).length;

  // Write output
  try {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(
      outputPath,
      yaml.dump({ module_paths: modulePathsManifest }),
      "utf-8"
    );
  } catch (e) {
    console.error(`err:failed to write ${outputPath}: ${e.message}`);
    process.exit(1);
  }

  // Success message
  if (techStack.length === 0) {
    console.log(
      `ok:no tech_stack — emitted empty module-paths manifest`
    );
  } else {
    console.log(
      `ok:module-paths emitted (profile=${profile ? profile.id : "none"}, ${logicalNameCount} logical names, ${symbolCount} symbols, ${anchorCount} anchors)`
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildModulePathsManifest, collectFilePaths, getLogicalName, detectStack, loadYAML };
