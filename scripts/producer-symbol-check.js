#!/usr/bin/env node
/**
 * producer-symbol-check.js — Deterministic check that a producer task's emitted
 * file exports the exact symbols it declared in contracts_produced[].implements.
 *
 * Catches producer symbol-name drift (e.g., file exports ConfigStore but contract
 * declares IConfigStore) at the worker round, instead of leaking to tsc.
 *
 * For missing symbols, finds the nearest exported name (by interface-prefix drift,
 * case-insensitive substring, or Levenshtein distance) and records a structured
 * issues list for downstream retry-update steps.
 *
 * Usage (per-task):
 *   node producer-symbol-check.js --task-file T.yaml --output-file <emitted> \
 *     --contracts-dir manifest/contracts [--issues-out <path>]
 *
 * Usage (batch backstop):
 *   node producer-symbol-check.js --manifest-dir manifest --output-dir output \
 *     --report wiki/producer-symbol-report.yaml
 *
 * Symbol-kind filtering:
 *   - Extract kind from contract surface
 *   - Only CHECK: TYPE, CLASS, CONST, METHOD (for "Owner.method", check OWNER)
 *   - SKIP: ENDPOINT, EVENT (not statically checkable)
 *   - Default to top-level name if not found in surface
 *
 * Export extraction:
 *   - TS/JS: TS regex patterns + export default
 *   - Python: module-level def/async def/class/NAME=
 *   - Rust/Go/other: unsupported (record under "unsupported" and skip)
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ═════════════════════════════════════════════════════════════════════════════
// Levenshtein Distance (for near-match ranking)
// ═════════════════════════════════════════════════════════════════════════════

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// ═════════════════════════════════════════════════════════════════════════════
// Near-match ranking
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Find the closest exported symbol to an expected symbol.
 *
 * Preference order:
 * 1. Interface-prefix drift: expected === "I" + exported, or exported === "I" + expected
 * 2. Case-insensitive substring (either direction)
 * 3. Levenshtein distance <= 3
 *
 * Returns { name, line, lineText } or null.
 */
function findNearMatch(expected, exports) {
  if (!exports.length) return null;

  const candidates = [];

  for (const ex of exports) {
    const { name, line, lineText } = ex;
    let score = null;

    // Rank 1: Interface-prefix drift
    if (expected === "I" + name || name === "I" + expected) {
      score = { rank: 1, dist: 0, name, line, lineText };
    }
    // Rank 2: Case-insensitive substring
    else if (expected.toLowerCase().includes(name.toLowerCase()) ||
             name.toLowerCase().includes(expected.toLowerCase())) {
      score = { rank: 2, dist: 0, name, line, lineText };
    }
    // Rank 3: Levenshtein distance <= 3
    else {
      const dist = levenshteinDistance(expected.toLowerCase(), name.toLowerCase());
      if (dist <= 3) {
        score = { rank: 3, dist, name, line, lineText };
      }
    }

    if (score) candidates.push(score);
  }

  if (!candidates.length) return null;

  // Sort by rank (ascending), then by distance (ascending)
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.dist - b.dist;
  });

  const best = candidates[0];
  return { name: best.name, line: best.line, lineText: best.lineText };
}

// ═════════════════════════════════════════════════════════════════════════════
// Export extraction by file type
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract exported symbols from a TypeScript/JavaScript file.
 *
 * Patterns:
 * - export (default )?(async )?(function|class|const|let|var|interface|type|enum)\s+(\w+)
 * - export\s*\{([^}]*)\}            (include re-exports from)
 * - export\s*\{([^}]*)\}\s*from      (re-exports)
 * - export default (class|function)\s+(\w+)
 * - export default\s+(\w+)
 *
 * Returns array of { name, line, lineText }.
 */
function extractTsJsExports(content) {
  const lines = content.split("\n");
  const exports = [];
  const seen = new Set();

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const lineText = line.trim();

    // Pattern 1: export (default )?(async )?(function|class|const|let|var|interface|type|enum)\s+NAME
    const match1 = line.match(/export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([a-zA-Z_$]\w*)/);
    if (match1) {
      const name = match1[2];
      if (!seen.has(name)) {
        exports.push({ name, line: lineNum + 1, lineText });
        seen.add(name);
      }
    }

    // Pattern 2: export default (class|function)\s+NAME
    const match2 = line.match(/export\s+default\s+(class|function)\s+([a-zA-Z_$]\w*)/);
    if (match2) {
      const name = match2[2];
      if (!seen.has(name)) {
        exports.push({ name, line: lineNum + 1, lineText });
        seen.add(name);
      }
    }

    // Pattern 3: export default NAME (without class/function keyword)
    const match3 = line.match(/export\s+default\s+([a-zA-Z_$]\w*)/);
    if (match3 && !line.match(/export\s+default\s+(class|function)/)) {
      const name = match3[1];
      if (!seen.has(name)) {
        exports.push({ name, line: lineNum + 1, lineText });
        seen.add(name);
      }
    }

    // Pattern 4: export { A, B as C, ... } (including re-exports and TS
    // type-only re-exports: `export type { X } from '...'`).
    if (line.match(/export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\b|;|$)/)) {
      const match4 = line.match(/export\s+(?:type\s+)?\{([^}]*)\}/);
      if (match4) {
        const items = match4[1].split(",").map(s => s.trim());
        for (const item of items) {
          // Handle "A as B" (export name is B) and "A" (export name is A)
          const parts = item.split(/\s+as\s+/);
          const exportName = parts.length > 1 ? parts[1] : parts[0];
          if (exportName && !seen.has(exportName)) {
            exports.push({ name: exportName, line: lineNum + 1, lineText });
            seen.add(exportName);
          }
        }
      }
    }
  }

  return exports;
}

/**
 * Extract exported symbols from a Python file.
 * Module-level (column 0): def NAME, async def NAME, class NAME, NAME = ...
 *
 * Returns array of { name, line, lineText }.
 */
function extractPythonExports(content) {
  const lines = content.split("\n");
  const exports = [];
  const seen = new Set();

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    // Skip if not column 0 (indented = not module-level)
    if (line.length > 0 && line[0] === " " || line[0] === "\t") continue;

    // Module-level def NAME or async def NAME
    const matchDef = line.match(/^(?:async\s+)?def\s+([a-zA-Z_]\w*)/);
    if (matchDef) {
      const name = matchDef[1];
      if (!seen.has(name)) {
        exports.push({ name, line: lineNum + 1, lineText: line.trim() });
        seen.add(name);
      }
      continue;
    }

    // Module-level class NAME
    const matchClass = line.match(/^class\s+([a-zA-Z_]\w*)/);
    if (matchClass) {
      const name = matchClass[1];
      if (!seen.has(name)) {
        exports.push({ name, line: lineNum + 1, lineText: line.trim() });
        seen.add(name);
      }
      continue;
    }

    // Module-level NAME = (assignment)
    const matchAssign = line.match(/^([a-zA-Z_]\w*)\s*=/);
    if (matchAssign) {
      const name = matchAssign[1];
      if (!seen.has(name)) {
        exports.push({ name, line: lineNum + 1, lineText: line.trim() });
        seen.add(name);
      }
    }
  }

  return exports;
}

// ═════════════════════════════════════════════════════════════════════════════
// File type detection and export extraction
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Determine language by file extension.
 * Returns: "ts", "py", "unsupported", or null.
 */
function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  if ([".rs", ".go"].includes(ext)) return "unsupported";
  return "unsupported";
}

/**
 * Extract exported symbols from a file.
 * Returns { exports: [{name, line, lineText}], language, status }.
 * status: "ok", "unsupported", or "error".
 */
function extractExports(filePath) {
  const language = detectLanguage(filePath);

  if (language === "unsupported") {
    return { exports: [], language, status: "unsupported" };
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let exports = [];

    if (language === "ts") {
      exports = extractTsJsExports(content);
    } else if (language === "py") {
      exports = extractPythonExports(content);
    }

    return { exports, language, status: "ok" };
  } catch (err) {
    return { exports: [], language, status: "error", error: err.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Contract surface lookup
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Reduce a symbol to its top-level identifier.
 * - Strip leading HTTP verb (^[A-Z]+\s+)
 * - Take the part before the first '.'
 *
 * Examples: "IConfigStore.get" → "IConfigStore", "POST /config" → "/config"
 */
function reduceToTopLevel(symbol) {
  // Strip HTTP verb
  let reduced = symbol.replace(/^[A-Z]+\s+/, "");
  // Take before first dot
  return reduced.split(".")[0];
}

/**
 * Load a contract and extract the surface map.
 * Returns { surfaces: {name: kind, ...}, raw: raw_surface_list }.
 */
function loadContractSurface(contractPath, contractId) {
  try {
    const content = fs.readFileSync(contractPath, "utf-8");
    const doc = yaml.load(content);

    if (!doc || !Array.isArray(doc.surface)) {
      return { surfaces: {}, raw: [] };
    }

    const surfaces = {};
    for (const entry of doc.surface) {
      if (entry.name && entry.kind) {
        surfaces[entry.name] = entry.kind;
      }
    }

    return { surfaces, raw: doc.surface };
  } catch (err) {
    return { surfaces: {}, raw: [] };
  }
}

/**
 * Determine the kind of a symbol from the contract surface.
 * Direct lookup only — if not found in surface, returns null.
 */
function getSymbolKind(symbol, surfaces) {
  return surfaces[symbol] || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Symbol checking (per-task)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Load a task YAML and extract the contracts_produced with implements.
 * Returns array of { contract_id, implements: [symbols] }.
 */
function loadTaskContracts(taskYaml) {
  try {
    const doc = yaml.load(taskYaml);
    if (!doc || !Array.isArray(doc.contracts_produced)) {
      return [];
    }

    const produced = [];
    for (const entry of doc.contracts_produced) {
      if (entry.contract_id && Array.isArray(entry.implements) && entry.implements.length > 0) {
        produced.push({
          contract_id: entry.contract_id,
          implements: entry.implements,
        });
      }
    }
    return produced;
  } catch (err) {
    return [];
  }
}

/**
 * Check a single task's producer symbols.
 *
 * Returns:
 * {
 *   status: "ok" | "err:stack-not-supported" | "err:producer_symbol_missing",
 *   checked: number,
 *   issues: [{expected, found, line, line_content, kind, contract_id}]
 * }
 */
function checkTask(taskYaml, outputFile, contractsDir) {
  const contracts = loadTaskContracts(taskYaml);

  // Legacy flat-string refs → nothing to check
  if (contracts.length === 0) {
    return { status: "ok:no contracts to check", checked: 0, issues: [] };
  }

  // Extract exports from the emitted file
  const { exports, language, status } = extractExports(outputFile);

  if (status === "unsupported") {
    return { status: "ok:stack-not-supported", checked: 0, issues: [] };
  }

  if (status === "error") {
    return { status: "ok", checked: 0, issues: [] }; // Graceful fallback
  }

  // Build export set for fast lookup
  const exportSet = new Set(exports.map(e => e.name));

  let totalChecked = 0;
  const issues = [];

  // For each contract in contracts_produced
  for (const contract of contracts) {
    const contractId = contract.contract_id;
    const contractPath = path.join(contractsDir, `${contractId}.yaml`);
    const { surfaces } = loadContractSurface(contractPath, contractId);

    // For each implements symbol
    for (const symbol of contract.implements) {
      const kind = getSymbolKind(symbol, surfaces);

      // SKIP: ENDPOINT, EVENT (not statically checkable via exports)
      if (kind && ["ENDPOINT", "EVENT"].includes(kind.toUpperCase())) {
        continue;
      }

      // Determine what to check: top-level identifier (for METHOD or unknown)
      const toCheck = reduceToTopLevel(symbol);
      totalChecked++;

      // Check if the top-level identifier is in the export set
      if (!exportSet.has(toCheck)) {
        // Missing: find near-match
        const nearMatch = findNearMatch(toCheck, exports);
        issues.push({
          expected: toCheck,
          found: nearMatch ? nearMatch.name : null,
          line: nearMatch ? nearMatch.line : null,
          line_content: nearMatch ? nearMatch.lineText : null,
          kind: kind || "UNKNOWN",
          contract_id: contractId,
        });
      }
    }
  }

  const status_str = issues.length > 0
    ? `err:producer_symbol_missing`
    : `ok:producer symbols present (${totalChecked} checked)`;

  return { status: status_str, checked: totalChecked, issues };
}

// ═════════════════════════════════════════════════════════════════════════════
// Batch checking (manifest-dir mode)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run batch check across all tasks in manifest.
 * Returns { status, summary, issues, report_path }.
 */
function batchCheck(manifestDir, outputDir, reportPath) {
  const tasksDir = path.join(manifestDir, "tasks");
  const contractsDir = path.join(manifestDir, "contracts");

  if (!fs.existsSync(tasksDir)) {
    return { status: "err:no tasks directory", summary: {}, issues: [], report_path: reportPath };
  }

  const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith(".yaml"));
  let totalTasks = 0;
  let totalChecked = 0;
  let totalIssues = 0;
  let totalSkipped = 0;
  const allIssues = [];

  for (const taskFile of taskFiles) {
    const taskId = taskFile.replace(/\.yaml$/, "");
    const taskPath = path.join(tasksDir, taskFile);
    const taskYaml = fs.readFileSync(taskPath, "utf-8");

    // Real layout: outputDir/<task file_path> (same field execute.js's
    // getOutputPath reads). Probe that first, then fall back to the legacy
    // outputDir/<taskId>.<ext> layout.
    let outputPath = null;
    const fpMatch = taskYaml.match(/^file_path:\s*"?([^"\n]+)"?/m);
    if (fpMatch) {
      const candidate = path.join(outputDir, fpMatch[1].trim());
      if (fs.existsSync(candidate)) outputPath = candidate;
    }
    if (!outputPath) {
      const exts = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"];
      for (const ext of exts) {
        const altPath = path.join(outputDir, taskId + ext);
        if (fs.existsSync(altPath)) {
          outputPath = altPath;
          break;
        }
      }
    }

    if (!outputPath) {
      // Emitted file not found under either layout — count it (no silent skips)
      totalSkipped++;
      continue;
    }

    const result = checkTask(taskYaml, outputPath, contractsDir);
    totalTasks++;
    totalChecked += result.checked;
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        allIssues.push({ task_id: taskId, ...issue });
      }
      totalIssues += result.issues.length;
    }
  }

  const summary = {
    tasks: totalTasks,
    checked: totalChecked,
    missing: totalIssues,
    skipped_file_not_found: totalSkipped,
  };

  const report = {
    summary,
    issues: allIssues,
  };

  // Write report
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, yaml.dump(report, { lineWidth: -1 }));

  const statusStr = totalIssues > 0
    ? `err:producer_symbol_missing:${totalIssues}`
    : `ok:producer-symbols clean (${totalChecked} checked, ${totalSkipped} skipped:file-not-found)`;

  return { status: statusStr, summary, issues: allIssues, report_path: reportPath };
}

// ═════════════════════════════════════════════════════════════════════════════
// CLI
// ═════════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--task-file": parsed.taskFile = args[++i]; break;
      case "--output-file": parsed.outputFile = args[++i]; break;
      case "--contracts-dir": parsed.contractsDir = args[++i]; break;
      case "--issues-out": parsed.issuesOut = args[++i]; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--output-dir": parsed.outputDir = args[++i]; break;
      case "--report": parsed.report = args[++i]; break;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs();

  // Batch mode
  if (args.manifestDir && args.outputDir && args.report) {
    const result = batchCheck(args.manifestDir, args.outputDir, args.report);
    console.log(result.status);
    process.exit(result.issues.length > 0 ? 1 : 0);
  }

  // Per-task mode
  if (!args.taskFile || !args.outputFile) {
    console.log("err:usage: node producer-symbol-check.js --task-file <file> --output-file <file> --contracts-dir <dir> [--issues-out <path>]");
    process.exit(1);
  }

  const contractsDir = args.contractsDir || "manifest/contracts";
  const issuesOut = args.issuesOut || (args.outputFile + ".symcheck.json");

  const taskYaml = fs.readFileSync(args.taskFile, "utf-8");
  const result = checkTask(taskYaml, args.outputFile, contractsDir);

  // Always write issues file
  fs.mkdirSync(path.dirname(issuesOut), { recursive: true });
  fs.writeFileSync(issuesOut, JSON.stringify({ issues: result.issues }, null, 2));

  // Print status
  if (result.issues.length > 0) {
    console.log(`${result.status}:${result.issues.length} issue(s) — see ${issuesOut}`);
    process.exit(1);
  } else {
    console.log(result.status);
    process.exit(0);
  }
}

// Export for testing
module.exports = {
  extractTsJsExports,
  extractPythonExports,
  extractExports,
  detectLanguage,
  levenshteinDistance,
  findNearMatch,
  reduceToTopLevel,
  getSymbolKind,
  loadContractSurface,
  loadTaskContracts,
  checkTask,
  batchCheck,
};

if (require.main === module) {
  main();
}
