#!/usr/bin/env node
// Tests for producer-symbol-check.js — symbol drift detection for producer tasks.
//
// Tests:
// - Drift: TYPE symbol mismatch (expected IConfigStore, found ConfigStore)
// - Exact: correct export matching
// - Re-export: export { Foo as IConfigStore }
// - Default export: export default class IConfigStore
// - ENDPOINT skip: POST /config is not checked
// - METHOD owner-only: IConfigStore.get checks only IConfigStore
// - Python support: class definitions and assignments
// - Legacy contracts: flat-string contracts_produced (no implements)
// - Issues file: always written, valid JSON
// - Batch mode: multiple tasks, drifted task recorded
// - Cleanup: temp dirs removed in finally

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const {
  extractTsJsExports,
  extractPythonExports,
  detectLanguage,
  levenshteinDistance,
  findNearMatch,
  reduceToTopLevel,
  getSymbolKind,
  loadContractSurface,
  loadTaskContracts,
  checkTask,
  batchCheck,
} = require("./producer-symbol-check.js");

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-producer-check-test-"));
}

const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const SCRIPT = path.resolve(__dirname, "producer-symbol-check.js");

/**
 * Create a minimal manifest structure for testing.
 * Returns { tmpDir, tasksDir, contractsDir }.
 */
function makeManifest(tmpDir) {
  const tasksDir = path.join(tmpDir, "tasks");
  const contractsDir = path.join(tmpDir, "contracts");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(contractsDir, { recursive: true });
  return { tmpDir, tasksDir, contractsDir };
}

/**
 * Write a contract YAML file.
 * Example surface:
 *   surface:
 *     - name: IConfigStore
 *       kind: TYPE
 */
function writeContract(contractsDir, contractId, surface) {
  const contract = {
    contract_id: contractId,
    name: contractId,
    surface,
  };
  fs.writeFileSync(
    path.join(contractsDir, `${contractId}.yaml`),
    yaml.dump(contract, { lineWidth: -1 })
  );
}

/**
 * Write a task YAML file.
 * Example contracts_produced:
 *   contracts_produced:
 *     - contract_id: CONTRACT-01
 *       implements:
 *         - IConfigStore
 */
function writeTask(tasksDir, taskId, contractsProduced) {
  const task = {
    task_id: taskId,
    description: `Task ${taskId}`,
    contracts_produced: contractsProduced || [],
  };
  fs.writeFileSync(
    path.join(tasksDir, `${taskId}.yaml`),
    yaml.dump(task, { lineWidth: -1 })
  );
}

/**
 * Run the CLI and return trimmed stdout.
 * Never throws — errors are captured.
 */
function runScript(args) {
  try {
    return execSync(`node "${SCRIPT}" ${args}`, {
      encoding: "utf-8",
      cwd: path.dirname(SCRIPT),
    }).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Unit Tests
// ═════════════════════════════════════════════════════════════════════════════

test("detectLanguage: recognizes TS, JS, Python, unsupported", () => {
  assert.equal(detectLanguage("foo.ts"), "ts");
  assert.equal(detectLanguage("bar.tsx"), "ts");
  assert.equal(detectLanguage("baz.js"), "ts");
  assert.equal(detectLanguage("qux.py"), "py");
  assert.equal(detectLanguage("quux.rs"), "unsupported");
  assert.equal(detectLanguage("corge.go"), "unsupported");
});

test("levenshteinDistance: calculates edit distance", () => {
  assert.equal(levenshteinDistance("cat", "cat"), 0);
  assert.equal(levenshteinDistance("cat", "hat"), 1);
  assert.equal(levenshteinDistance("", "abc"), 3);
  assert.equal(levenshteinDistance("abc", ""), 3);
});

test("reduceToTopLevel: strips HTTP verb and takes before first dot", () => {
  assert.equal(reduceToTopLevel("IConfigStore.get"), "IConfigStore");
  assert.equal(reduceToTopLevel("POST /config"), "/config");
  assert.equal(reduceToTopLevel("GET /api/users"), "/api/users");
  assert.equal(reduceToTopLevel("SimpleClass"), "SimpleClass");
  assert.equal(reduceToTopLevel("POST /api/users/{id}"), "/api/users/{id}");
});

test("findNearMatch: prefers interface-prefix drift", () => {
  const exports = [
    { name: "ConfigStore", line: 10, lineText: "export class ConfigStore" },
  ];
  const match = findNearMatch("IConfigStore", exports);
  assert.ok(match);
  assert.equal(match.name, "ConfigStore");
  assert.equal(match.line, 10);
});

test("findNearMatch: case-insensitive substring match", () => {
  const exports = [
    { name: "AccountResolver", line: 5, lineText: "class AccountResolver:" },
  ];
  const match = findNearMatch("Resolver", exports);
  assert.ok(match);
  assert.equal(match.name, "AccountResolver");
});

test("findNearMatch: levenshtein distance <= 3", () => {
  const exports = [
    { name: "AccountStore", line: 8, lineText: "export class AccountStore" },
  ];
  const match = findNearMatch("AccountStone", exports);
  assert.ok(match);
  assert.equal(match.name, "AccountStore");
});

test("findNearMatch: returns null if no candidates", () => {
  const exports = [
    { name: "FooBar", line: 1, lineText: "export class FooBar" },
  ];
  const match = findNearMatch("Unrelated", exports);
  assert.equal(match, null);
});

test("extractTsJsExports: named export function", () => {
  const code = `export function MyFunc() { }`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "MyFunc");
  assert.equal(exports[0].line, 1);
});

test("extractTsJsExports: named export class", () => {
  const code = `export class IConfigStore { }`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "IConfigStore");
});

test("extractTsJsExports: named export interface", () => {
  const code = `export interface IConfigStore { }`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "IConfigStore");
});

test("extractTsJsExports: named export const", () => {
  const code = `export const DEBUG = true;`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "DEBUG");
});

test("extractTsJsExports: export { A, B as C }", () => {
  const code = `export { Foo, Bar as IBar }`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 2);
  const names = new Set(exports.map(e => e.name));
  assert.ok(names.has("Foo"));
  assert.ok(names.has("IBar"));
});

test("extractTsJsExports: export { A } from 'module' (re-export)", () => {
  const code = `export { ConfigStore } from "./config";`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "ConfigStore");
});

test("extractTsJsExports: export type { X } from 'module' (TS type-only re-export)", () => {
  const code = `export type { IConfigStore } from "./schema";`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "IConfigStore");
});

test("extractTsJsExports: export type { A, B as C } (type-only list)", () => {
  const code = `export type { Foo, Bar as IBar };`;
  const exports = extractTsJsExports(code);
  const names = new Set(exports.map(e => e.name));
  assert.ok(names.has("Foo"));
  assert.ok(names.has("IBar"));
});

test("extractTsJsExports: export default class", () => {
  const code = `export default class MyClass { }`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "MyClass");
});

test("extractTsJsExports: export default NAME", () => {
  const code = `export default MyVar;`;
  const exports = extractTsJsExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "MyVar");
});

test("extractTsJsExports: deduplicates repeated exports", () => {
  const code = `export class Foo { }
export { Foo }`;
  const exports = extractTsJsExports(code);
  const names = exports.map(e => e.name);
  assert.equal(names.filter(n => n === "Foo").length, 1);
});

test("extractPythonExports: module-level def", () => {
  const code = `def my_function():
    pass`;
  const exports = extractPythonExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "my_function");
});

test("extractPythonExports: module-level class", () => {
  const code = `class AccountResolver:
    pass`;
  const exports = extractPythonExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "AccountResolver");
});

test("extractPythonExports: module-level assignment", () => {
  const code = `DEBUG = True
version = "1.0"`;
  const exports = extractPythonExports(code);
  assert.equal(exports.length, 2);
  const names = new Set(exports.map(e => e.name));
  assert.ok(names.has("DEBUG"));
  assert.ok(names.has("version"));
});

test("extractPythonExports: ignores indented definitions", () => {
  const code = `class Outer:
    def inner_method(self):
        pass`;
  const exports = extractPythonExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "Outer");
});

test("extractPythonExports: async def", () => {
  const code = `async def async_func():
    pass`;
  const exports = extractPythonExports(code);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].name, "async_func");
});

test("getSymbolKind: looks up kind in surface", () => {
  const surfaces = {
    "IConfigStore": "TYPE",
    "POST /config": "ENDPOINT",
  };
  assert.equal(getSymbolKind("IConfigStore", surfaces), "TYPE");
  assert.equal(getSymbolKind("IConfigStore.get", surfaces), null); // Not in surface
  assert.equal(getSymbolKind("POST /config", surfaces), "ENDPOINT");
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration Tests (per-task)
// ═════════════════════════════════════════════════════════════════════════════

test("Per-task: drift detected (expected IConfigStore, found ConfigStore)", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    // Contract declares IConfigStore as TYPE
    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "TYPE" },
    ]);

    // Task declares it implements IConfigStore
    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore"] },
    ]);

    // Emitted file exports ConfigStore (drift)
    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class ConfigStore { }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].expected, "IConfigStore");
    assert.equal(result.issues[0].found, "ConfigStore");
    assert.equal(result.issues[0].kind, "TYPE");
    assert.equal(result.status, "err:producer_symbol_missing");
  } finally {
    rm(dir);
  }
});

test("Per-task: exact match (no drift)", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "TYPE" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class IConfigStore { }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
    assert.match(result.status, /ok:/);
  } finally {
    rm(dir);
  }
});

test("Per-task: re-export (export { Foo as IConfigStore })", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "TYPE" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export { Foo as IConfigStore }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
    assert.match(result.status, /ok:/);
  } finally {
    rm(dir);
  }
});

test("Per-task: export default class", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "TYPE" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export default class IConfigStore { }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
  } finally {
    rm(dir);
  }
});

test("Per-task: ENDPOINT is skipped (not checked)", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "POST /config", kind: "ENDPOINT" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["POST /config"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class SomeClass { }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
    assert.match(result.status, /ok:/);
  } finally {
    rm(dir);
  }
});

test("Per-task: METHOD checks owner only (IConfigStore.get → check IConfigStore)", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "CLASS" },
      { name: "IConfigStore.get", kind: "METHOD" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore.get"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class IConfigStore { get() { } }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
  } finally {
    rm(dir);
  }
});

test("Per-task: Python class export", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "AccountResolver", kind: "CLASS" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["AccountResolver"] },
    ]);

    const outputFile = path.join(dir, "output.py");
    fs.writeFileSync(outputFile, "class AccountResolver:\n    pass");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
  } finally {
    rm(dir);
  }
});

test("Per-task: Python class drift with near-match", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "AccountResolver", kind: "CLASS" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["AccountResolver"] },
    ]);

    const outputFile = path.join(dir, "output.py");
    fs.writeFileSync(outputFile, "class AcctResolver:\n    pass");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].expected, "AccountResolver");
    assert.equal(result.issues[0].found, "AcctResolver");
  } finally {
    rm(dir);
  }
});

test("Per-task: legacy flat-string contracts_produced (no implements) → ok", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    // Legacy task with flat-string contracts_produced
    fs.writeFileSync(
      path.join(tasksDir, "TASK-01.yaml"),
      yaml.dump({
        task_id: "TASK-01",
        contracts_produced: ["CONTRACT-01"], // flat string, no implements
      }, { lineWidth: -1 })
    );

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class Something { }");

    const taskYaml = fs.readFileSync(path.join(tasksDir, "TASK-01.yaml"), "utf-8");
    const result = checkTask(taskYaml, outputFile, contractsDir);

    assert.equal(result.issues.length, 0);
    assert.match(result.status, /ok:/);
  } finally {
    rm(dir);
  }
});

test("Per-task: --issues-out JSON file is always written and valid", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "TYPE" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class ConfigStore { }");

    const issuesOut = path.join(dir, "issues.json");
    const args = `--task-file "${path.join(tasksDir, "TASK-01.yaml")}" --output-file "${outputFile}" --contracts-dir "${contractsDir}" --issues-out "${issuesOut}"`;
    const out = runScript(args);

    assert.ok(fs.existsSync(issuesOut), "issues file should exist");
    const issues = JSON.parse(fs.readFileSync(issuesOut, "utf-8"));
    assert.ok(Array.isArray(issues.issues));
    assert.equal(issues.issues.length, 1);
    assert.equal(issues.issues[0].expected, "IConfigStore");
  } finally {
    rm(dir);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Batch Tests
// ═════════════════════════════════════════════════════════════════════════════

test("Batch: multiple tasks, one clean and one drifted", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);
    const outputDir = path.join(dir, "output");
    fs.mkdirSync(outputDir);

    // Task 1: Clean
    writeContract(contractsDir, "CONTRACT-01", [
      { name: "ConfigStore", kind: "TYPE" },
    ]);
    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["ConfigStore"] },
    ]);
    fs.writeFileSync(path.join(outputDir, "TASK-01.ts"), "export class ConfigStore { }");

    // Task 2: Drifted
    writeContract(contractsDir, "CONTRACT-02", [
      { name: "IUserService", kind: "TYPE" },
    ]);
    writeTask(tasksDir, "TASK-02", [
      { contract_id: "CONTRACT-02", implements: ["IUserService"] },
    ]);
    fs.writeFileSync(path.join(outputDir, "TASK-02.ts"), "export class UserService { }");

    const reportPath = path.join(dir, "report.yaml");
    const result = batchCheck(dir, outputDir, reportPath);

    assert.ok(fs.existsSync(reportPath));
    const report = yaml.load(fs.readFileSync(reportPath, "utf-8"));
    assert.equal(report.summary.tasks, 2);
    assert.equal(report.summary.missing, 1);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].task_id, "TASK-02");
    assert.equal(report.issues[0].expected, "IUserService");
  } finally {
    rm(dir);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLI Tests
// ═════════════════════════════════════════════════════════════════════════════

test("CLI: per-task mode with drift prints err and exits 1", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "IConfigStore", kind: "TYPE" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["IConfigStore"] },
    ]);

    const outputFile = path.join(dir, "output.ts");
    fs.writeFileSync(outputFile, "export class ConfigStore { }");

    const args = `--task-file "${path.join(tasksDir, "TASK-01.yaml")}" --output-file "${outputFile}" --contracts-dir "${contractsDir}"`;
    const out = runScript(args);

    assert.match(out, /err:producer_symbol_missing/);
  } finally {
    rm(dir);
  }
});

test("CLI: per-task mode without arguments prints usage error", () => {
  const out = runScript("");
  assert.match(out, /err:usage/);
});

test("CLI: unsupported file type → ok:stack-not-supported", () => {
  const dir = mkTmp();
  try {
    const { tasksDir, contractsDir } = makeManifest(dir);

    writeContract(contractsDir, "CONTRACT-01", [
      { name: "Something", kind: "TYPE" },
    ]);

    writeTask(tasksDir, "TASK-01", [
      { contract_id: "CONTRACT-01", implements: ["Something"] },
    ]);

    const outputFile = path.join(dir, "output.go");
    fs.writeFileSync(outputFile, "type Something struct {}");

    const args = `--task-file "${path.join(tasksDir, "TASK-01.yaml")}" --output-file "${outputFile}" --contracts-dir "${contractsDir}"`;
    const out = runScript(args);

    assert.match(out, /ok:stack-not-supported/);
  } finally {
    rm(dir);
  }
});
