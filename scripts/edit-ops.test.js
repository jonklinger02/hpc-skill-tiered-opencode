#!/usr/bin/env node
/**
 * edit-ops.test.js — Tests for edit-ops.js
 *
 * Tests:
 *   - rename-symbol: whole-word boundary safety, --line constraint, no match, bad identifier
 *   - add-export: append statement, idempotent (already present), non-export guard
 *   - replace-line: replace at line N, out-of-range error
 *   - file_not_found error
 *   - file contents verified after each operation
 *
 * Run via:  node scripts/edit-ops.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.resolve(__dirname, "edit-ops.js");

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temporary file with given content.
 * Returns the file path.
 */
function makeTempFile(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-edit-ops-test-"));
  const filePath = path.join(tmpDir, "test.ts");
  fs.writeFileSync(filePath, content, "utf-8");
  return { filePath, tmpDir };
}

/**
 * Clean up temp directory
 */
function cleanup(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Run edit-ops.js with given action and args. Returns { stdout, code, error }.
 */
function runEditOps(args) {
  try {
    const stdout = execSync(`node "${SCRIPT}" ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: __dirname,
    }).trim();
    return { stdout, code: 0, error: null };
  } catch (e) {
    const stdout = (e.stdout || "").trim();
    const stderr = (e.stderr || "").trim();
    return {
      stdout,
      code: e.status || 1,
      error: stderr || stdout,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("rename-symbol: whole-word boundary safety", (t) => {
  const content = `class ConfigStore {
  constructor() {}
}

class ConfigStoreError extends Error {
  constructor() {}
}

export { ConfigStore, ConfigStoreError };
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:renamed 2 occurrence/);

    const newContent = fs.readFileSync(filePath, "utf-8");
    // Should replace the standalone ConfigStore (class and export), but NOT inside ConfigStoreError
    assert.match(newContent, /class IConfigStore \{/);
    assert.match(newContent, /class ConfigStoreError extends Error \{/);
    assert.match(newContent, /export \{ IConfigStore, ConfigStoreError \}/);
    // Verify ConfigStoreError was NOT renamed
    const errors = newContent.match(/ConfigStoreError/g);
    assert.equal(errors.length, 2, "ConfigStoreError should appear twice, unchanged");
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: --line N constraint", (t) => {
  const content = `let x = ConfigStore;
let y = ConfigStore;
let z = ConfigStore;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    // Rename only on line 2
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore --line 2`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:renamed 1 occurrence\(s\) line 2/);

    const newContent = fs.readFileSync(filePath, "utf-8");
    const lines = newContent.split("\n");
    assert.match(lines[0], /let x = ConfigStore;/);
    assert.match(lines[1], /let y = IConfigStore;/);
    assert.match(lines[2], /let z = ConfigStore;/);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: no match → err:no_match, file unchanged", (t) => {
  const content = `class MyClass {
  constructor() {}
}
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:no_match/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: no match on specified line → err:no_match", (t) => {
  const content = `let x = ConfigStore;
let y = Something;
let z = ConfigStore;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore --line 2`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:no_match/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: bad identifier --to → err:bad_identifier", (t) => {
  const content = `class ConfigStore {}`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to "Foo Bar"`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:bad_identifier/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: bad identifier --from → err:bad_identifier", (t) => {
  const content = `class ConfigStore {}`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from "Config Store" --to IConfigStore`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:bad_identifier/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: --count-only does not write file", (t) => {
  const content = `let x = ConfigStore;
let y = ConfigStore;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore --count-only`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:renamed 2 occurrence/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("add-export: appends export statement", (t) => {
  const content = `const x = 1;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `add-export --file "${filePath}" --statement "export { IConfigStore } from './schema';"`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:export_added/);

    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.match(newContent, /const x = 1;/);
    assert.match(newContent, /export \{ IConfigStore \} from '\.\/schema';/);
    // Should end with newline
    assert(newContent.endsWith("\n"));
  } finally {
    cleanup(tmpDir);
  }
});

test("add-export: idempotent (already present → ok:already_present)", (t) => {
  const content = `const x = 1;
export { IConfigStore } from './schema';
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    // First call should say already_present
    const result = runEditOps(
      `add-export --file "${filePath}" --statement "export { IConfigStore } from './schema';"`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:already_present/);

    // Verify file is unchanged (no duplication)
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);

    // Verify only one occurrence of the export
    const matches = newContent.match(/export \{ IConfigStore \}/g);
    assert.equal(matches.length, 1);
  } finally {
    cleanup(tmpDir);
  }
});

test("add-export: non-export statement → err:not_an_export_statement", (t) => {
  const content = `const x = 1;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `add-export --file "${filePath}" --statement "const y = 2;"`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:not_an_export_statement/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("replace-line: replaces entire line N", (t) => {
  const content = `line 1
line 2
line 3
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `replace-line --file "${filePath}" --line 2 --to "new line 2"`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:line_replaced 2/);

    const newContent = fs.readFileSync(filePath, "utf-8");
    const lines = newContent.split("\n");
    assert.equal(lines[0], "line 1");
    assert.equal(lines[1], "new line 2");
    assert.equal(lines[2], "line 3");
  } finally {
    cleanup(tmpDir);
  }
});

test("replace-line: line out of range → err:line_out_of_range", (t) => {
  const content = `line 1
line 2
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `replace-line --file "${filePath}" --line 10 --to "new line"`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:line_out_of_range/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("replace-line: line 0 (out of range)", (t) => {
  const content = `line 1
line 2
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `replace-line --file "${filePath}" --line 0 --to "new line"`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:line_out_of_range/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("replace-line: non-numeric --line → err:invalid_line, exit 1, file unchanged", (t) => {
  const content = `line 1
line 2
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `replace-line --file "${filePath}" --line twelve --to "new line"`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:invalid_line:twelve/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: non-numeric --line → err:invalid_line, exit 1, file unchanged", (t) => {
  const content = `let x = ConfigStore;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore --line abc`
    );
    assert.equal(result.code, 1, "expected error exit");
    assert.match(result.stdout, /err:invalid_line:abc/);

    // Verify file is unchanged
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(newContent, content);
  } finally {
    cleanup(tmpDir);
  }
});

test("file_not_found: rename-symbol on missing file", (t) => {
  const result = runEditOps(
    `rename-symbol --file /nonexistent/file.ts --from X --to Y`
  );
  assert.equal(result.code, 1, "expected error exit");
  assert.match(result.stdout, /err:file_not_found/);
});

test("file_not_found: add-export on missing file", (t) => {
  const result = runEditOps(
    `add-export --file /nonexistent/file.ts --statement "export { X };"`
  );
  assert.equal(result.code, 1, "expected error exit");
  assert.match(result.stdout, /err:file_not_found/);
});

test("file_not_found: replace-line on missing file", (t) => {
  const result = runEditOps(
    `replace-line --file /nonexistent/file.ts --line 1 --to "new"`
  );
  assert.equal(result.code, 1, "expected error exit");
  assert.match(result.stdout, /err:file_not_found/);
});

test("atomic write: rename creates tmp then renames", (t) => {
  const content = `let x = ConfigStore;`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);

    // Verify the final file exists and is correct
    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.match(newContent, /let x = IConfigStore;/);

    // Verify no tmp file left behind
    const tmpFile = filePath + ".tmp";
    assert(!fs.existsSync(tmpFile), "tmp file should not be left behind");
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol: multiple occurrences on different lines", (t) => {
  const content = `let a = ConfigStore;
let b = OtherClass;
let c = ConfigStore;
let d = ConfigStore;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from ConfigStore --to IConfigStore`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:renamed 3 occurrence/);

    const newContent = fs.readFileSync(filePath, "utf-8");
    const lines = newContent.split("\n");
    assert.match(lines[0], /let a = IConfigStore;/);
    assert.match(lines[1], /let b = OtherClass;/);
    assert.match(lines[2], /let c = IConfigStore;/);
    assert.match(lines[3], /let d = IConfigStore;/);
  } finally {
    cleanup(tmpDir);
  }
});

test("rename-symbol with $-suffix identifier", (t) => {
  const content = `let x = $config;
let y = $config$store;
`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `rename-symbol --file "${filePath}" --from '$config' --to '$newConfig'`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    assert.match(result.stdout, /ok:renamed 1 occurrence/);

    const newContent = fs.readFileSync(filePath, "utf-8");
    assert.match(newContent, /let x = \$newConfig;/);
    assert.match(newContent, /let y = \$config\$store;/);
  } finally {
    cleanup(tmpDir);
  }
});

test("add-export: preserves trailing newline", (t) => {
  const content = `const x = 1;\n`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `add-export --file "${filePath}" --statement "export { X };"`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);

    const newContent = fs.readFileSync(filePath, "utf-8");
    assert(newContent.endsWith("\n"));
  } finally {
    cleanup(tmpDir);
  }
});

test("add-export: adds trailing newline if missing", (t) => {
  const content = `const x = 1;`;
  const { filePath, tmpDir } = makeTempFile(content);

  try {
    const result = runEditOps(
      `add-export --file "${filePath}" --statement "export { X };"`
    );
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);

    const newContent = fs.readFileSync(filePath, "utf-8");
    assert(newContent.endsWith("\n"));
  } finally {
    cleanup(tmpDir);
  }
});
