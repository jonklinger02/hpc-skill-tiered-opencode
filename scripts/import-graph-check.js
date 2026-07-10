#!/usr/bin/env node
/**
 * import-graph-check.js — Post-assembly import graph validation
 *
 * For each generated source file in --output-dir, extracts imports and verifies
 * that all local/relative imports resolve to files that either:
 * - Exist in the output directory, OR
 * - Are produced by a task (per task file_path in manifest-dir/tasks/*.yaml)
 *
 * Imports that cannot be resolved are "orphan imports" and block Phase 3.
 *
 * Usage:
 *   node scripts/import-graph-check.js \
 *     --output-dir <dir> \
 *     --manifest-dir <dir> \
 *     [--report <path>]
 *
 * Default report: <output-dir>/../wiki/import-graph-report.yaml
 *
 * Exit codes:
 *   0 = clean (all local imports resolved, or only unsupported stacks present)
 *   1 = blocking (orphan imports found)
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load YAML and return parsed object, or null on failure.
 */
function loadYAML(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

/**
 * Recursively walk a directory, collecting all file paths (relative to root).
 * Skips: node_modules, .git, dist, build, __pycache__
 */
function walkSourceFiles(dir, relDir = "") {
  const files = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        files.push(...walkSourceFiles(fullPath, relPath));
      } else {
        files.push(relPath);
      }
    }
  } catch (e) {
    // Ignore read errors on individual directories
  }

  return files;
}

/**
 * Determine the tech stack by reading manifest.yaml and/or inferring from file extensions.
 * Returns { languages: Set<string>, unsupported: Set<string> }
 */
function determineTechStack(manifestDir, outputDir, allFiles) {
  const languages = new Set();
  const unsupported = new Set();

  // Check manifest for explicit tech_stack
  let hasExplicitStack = false;
  const manifestPath = path.join(manifestDir, "manifest.yaml");
  if (fs.existsSync(manifestPath)) {
    const manifest = loadYAML(manifestPath);
    if (manifest && Array.isArray(manifest.tech_stack) && manifest.tech_stack.length > 0) {
      hasExplicitStack = true;
      for (const lang of manifest.tech_stack) {
        if (typeof lang === "string") {
          const lower = lang.toLowerCase();
          if (["python", "typescript", "javascript", "rust", "go"].includes(lower)) {
            languages.add(lower);
          }
        }
      }
    }
  }

  // Always infer unsupported stacks from file extensions
  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    switch (ext) {
      case ".py":
        if (!hasExplicitStack) languages.add("python");
        break;
      case ".ts":
      case ".tsx":
        if (!hasExplicitStack) languages.add("typescript");
        break;
      case ".js":
      case ".jsx":
      case ".mjs":
      case ".cjs":
        if (!hasExplicitStack) languages.add("javascript");
        break;
      case ".rs":
        unsupported.add("rust");
        break;
      case ".go":
        unsupported.add("go");
        break;
    }
  }

  return { languages, unsupported };
}

/**
 * Extract import specifiers from a single file based on its language.
 * Returns array of { specifier, isLocal: bool }
 */
function extractImports(filePath, content, projectPackages = new Set()) {
  const ext = path.extname(filePath).toLowerCase();
  const imports = [];

  if (ext === ".py") {
    // Python: import X, from X import Y, from .X import Y
    const lines = content.split("\n");
    for (const line of lines) {
      // from .X or from ..X (relative imports - always local)
      const m2 = /^\s*from\s+(\.+[\w.]*)\s+import\b/.exec(line);
      if (m2) {
        imports.push({ specifier: m2[1], isLocal: true });
        continue;
      }

      // import X.Y.Z or from X.Y import Z (absolute imports - check if project package)
      const m1 = /^\s*(?:import|from)\s+([\w.]+)/.exec(line);
      if (m1) {
        const spec = m1[1];
        const firstPart = spec.split(".")[0];
        const isLocal = projectPackages.has(firstPart);
        imports.push({ specifier: spec, isLocal });
      }
    }
  } else if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    // TypeScript/JavaScript imports
    // import ... from "..."
    // import "..."
    // require("...")
    // export ... from "..."

    const importFromPattern = /import\s+(?:[\w\s*{},]+\s+)?from\s+['"]([^'"]+)['"]/g;
    const importPattern = /import\s+['"]([^'"]+)['"]/g;
    const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
    const exportFromPattern = /export\s+(?:[\w\s*{},]+\s+)?from\s+['"]([^'"]+)['"]/g;

    let m;

    while ((m = importFromPattern.exec(content)) !== null) {
      imports.push({ specifier: m[1], isLocal: !isExternalSpecifier(m[1]) });
    }

    while ((m = importPattern.exec(content)) !== null) {
      imports.push({ specifier: m[1], isLocal: !isExternalSpecifier(m[1]) });
    }

    while ((m = requirePattern.exec(content)) !== null) {
      imports.push({ specifier: m[1], isLocal: !isExternalSpecifier(m[1]) });
    }

    while ((m = exportFromPattern.exec(content)) !== null) {
      imports.push({ specifier: m[1], isLocal: !isExternalSpecifier(m[1]) });
    }
  }

  return imports;
}

/**
 * Determine if a TS/JS specifier is external (package name, not a local path).
 * External: no leading `.` or `/` and not an `@/` alias that maps to a local dir.
 */
function isExternalSpecifier(spec) {
  if (typeof spec !== "string") return true;
  // Starts with . or / = local
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  // Check for @/ style alias (we assume it's local if it starts with @/)
  // For simplicity, @/ is treated as external; only explicit ./ or / or matching
  // project root packages are local.
  return true;
}

/**
 * Build the set of resolvable target files (exist OR produced by task).
 */
function buildResolvableSet(outputDir, manifestDir, allFiles) {
  const resolvable = new Set();

  // Add all existing files
  for (const file of allFiles) {
    resolvable.add(file);
  }

  // Add files produced by tasks
  const tasksDir = path.join(manifestDir, "tasks");
  if (fs.existsSync(tasksDir)) {
    for (const file of fs.readdirSync(tasksDir)) {
      if (!file.endsWith(".yaml")) continue;
      const taskPath = path.join(tasksDir, file);
      const task = loadYAML(taskPath);
      if (task && task.file_path) {
        resolvable.add(task.file_path);
      }
    }
  }

  return resolvable;
}

/**
 * Find Python packages at the root level of outputDir.
 * A package is a directory containing __init__.py or .py files.
 */
function findPythonPackages(outputDir) {
  const packages = new Set();

  if (!fs.existsSync(outputDir)) return packages;

  try {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(outputDir, entry.name);
        // Check if directory has __init__.py or any .py files
        const files = fs.readdirSync(dirPath);
        const isPkgDir = files.some(f => f === "__init__.py" || f.endsWith(".py"));
        if (isPkgDir) {
          packages.add(entry.name);
        }
      }
    }
  } catch (e) {
    // Ignore read errors
  }

  return packages;
}

/**
 * For a local import specifier in a given file, try to resolve it to candidates.
 * Returns { resolved: bool, candidates: string[] }
 */
function resolveLocalImport(specifier, importerFile, outputDir, resolvable) {
  const ext = path.extname(importerFile).toLowerCase();
  const importerDir = path.dirname(importerFile);
  const candidates = [];

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    // TS/JS: resolve relative path
    if (specifier.startsWith(".")) {
      // Relative import: ./foo, ../foo, etc.
      // Resolve relative to the importer's directory
      const resolved = path.normalize(path.join(importerDir, specifier));

      // Try multiple extensions; candidates are paths relative to outputDir
      const variants = [
        resolved,
        resolved + ".ts",
        resolved + ".tsx",
        resolved + ".js",
        resolved + ".jsx",
        resolved + "/index.ts",
        resolved + "/index.tsx",
        resolved + "/index.js",
        resolved + "/index.jsx",
      ];

      for (const v of variants) {
        candidates.push(v);
        if (resolvable.has(v)) return { resolved: true, candidates };
      }
    } else if (specifier.startsWith("/")) {
      // Absolute import (relative to output root)
      const resolved = specifier.substring(1);
      const variants = [
        resolved,
        resolved + ".ts",
        resolved + ".tsx",
        resolved + ".js",
        resolved + ".jsx",
        resolved + "/index.ts",
        resolved + "/index.tsx",
        resolved + "/index.js",
        resolved + "/index.jsx",
      ];

      for (const v of variants) {
        candidates.push(v);
        if (resolvable.has(v)) return { resolved: true, candidates };
      }
    }
  } else if (ext === ".py") {
    // Python: from . or .module or from pkg.subpkg
    if (specifier.startsWith(".")) {
      // Relative import: from . or from .module or from ..module
      const relParts = specifier.match(/^(\.+)(.*)/);
      if (relParts) {
        const dots = relParts[1].length;
        const modulePath = relParts[2];

        // Navigate up dot levels from the importer's directory
        let targetDir = importerDir;
        for (let i = 1; i < dots; i++) {
          targetDir = path.dirname(targetDir);
        }

        // Resolve module path
        const resolved = path.join(targetDir, modulePath.replace(/\./g, "/"));
        const variants = [
          resolved + ".py",
          resolved + "/__init__.py",
        ];

        for (const v of variants) {
          candidates.push(v);
          if (resolvable.has(v)) return { resolved: true, candidates };
        }
      }
    } else {
      // Absolute import: from pkg.subpkg or import pkg.subpkg
      const modulePath = specifier.replace(/\./g, "/");
      const variants = [
        modulePath + ".py",
        modulePath + "/__init__.py",
      ];

      for (const v of variants) {
        candidates.push(v);
        if (resolvable.has(v)) return { resolved: true, candidates };
      }
    }
  }

  return { resolved: false, candidates };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    outputDir: null,
    manifestDir: null,
    report: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--output-dir":
        parsed.outputDir = args[++i];
        break;
      case "--manifest-dir":
        parsed.manifestDir = args[++i];
        break;
      case "--report":
        parsed.report = args[++i];
        break;
    }
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  if (!opts.outputDir || !opts.manifestDir) {
    console.error("err:missing --output-dir or --manifest-dir");
    process.exit(1);
  }

  // Default report path
  let reportPath = opts.report;
  if (!reportPath) {
    const parent = path.dirname(opts.outputDir);
    reportPath = path.join(parent, "wiki", "import-graph-report.yaml");
  }

  // Walk output directory to find all source files
  const allFiles = walkSourceFiles(opts.outputDir);

  // Determine tech stack
  const { languages, unsupported } = determineTechStack(opts.manifestDir, opts.outputDir, allFiles);

  // Filter to supported source files
  const supportedExtensions = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
  const sourceFiles = allFiles.filter(f => supportedExtensions.has(path.extname(f).toLowerCase()));

  // Build resolvable target set
  const resolvable = buildResolvableSet(opts.outputDir, opts.manifestDir, allFiles);

  // Find Python packages for local import detection
  const pythonPackages = findPythonPackages(opts.outputDir);

  // Process each source file for imports
  const orphans = [];
  let externalImportsCount = 0;
  let localImportsCount = 0;
  let resolvedCount = 0;

  for (const sourceFile of sourceFiles) {
    const fullPath = path.join(opts.outputDir, sourceFile);
    let content;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch (e) {
      continue;
    }

    const imports = extractImports(sourceFile, content, pythonPackages);

    for (const imp of imports) {
      if (imp.isLocal) {
        localImportsCount++;
        const resolution = resolveLocalImport(imp.specifier, sourceFile, opts.outputDir, resolvable);
        if (resolution.resolved) {
          resolvedCount++;
        } else {
          orphans.push({
            importer_file: sourceFile,
            specifier: imp.specifier,
            kind: "orphan",
            tried: resolution.candidates,
          });
        }
      } else {
        externalImportsCount++;
      }
    }
  }

  // Build report
  const report = {
    summary: {
      files_scanned: sourceFiles.length,
      imports_total: externalImportsCount + localImportsCount,
      external_imports: externalImportsCount,
      local_imports: localImportsCount,
      resolved: resolvedCount,
      orphans: orphans.length,
      unsupported_files: allFiles.length - sourceFiles.length,
    },
    stack: Array.from(languages).sort(),
    unsupported_stacks: Array.from(unsupported).sort(),
    orphans,
    notes: [],
  };

  // Add notes for unsupported stacks
  for (const stack of unsupported) {
    const count = allFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      if (stack === "rust") return ext === ".rs";
      if (stack === "go") return ext === ".go";
      return false;
    }).length;
    report.notes.push(`warn:stack-not-supported: ${stack} (${count} files skipped)`);
  }

  // Write report
  const reportDir = path.dirname(reportPath);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, yaml.dump(report, { lineWidth: -1 }));

  // Determine exit status
  if (orphans.length > 0) {
    console.log(`err:import_graph:${orphans.length} orphan import(s) — see ${reportPath}`);
    process.exit(1);
  }

  console.log(`ok:import-graph clean (${resolvedCount} local resolved, ${externalImportsCount} external, ${sourceFiles.length} files)`);
}

main();
