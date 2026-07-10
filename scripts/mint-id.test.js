#!/usr/bin/env node
/**
 * mint-id.test.js — Tests for mint-id.js
 *
 * Tests: fresh manifest, pre-existing IDs, independent areas, type-specific formats,
 * count minting, normalization, error handling, and parallel safety (lock contention).
 *
 * Run via:  node scripts/mint-id.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRIPT = path.resolve(__dirname, "mint-id.js");

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temporary manifest directory with the standard structure.
 */
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-mint-id-test-"));
  fs.mkdirSync(path.join(dir, "epics"), { recursive: true });
  fs.mkdirSync(path.join(dir, "task-groups"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });
  return dir;
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run mint-id.js with given args. Returns { stdout, code, error }.
 */
function runMintId(manifestDir, args = "") {
  try {
    const stdout = execSync(`node "${SCRIPT}" --manifest-dir "${manifestDir}" ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
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

/**
 * Parse the output of mint-id: split by newline, filter empty.
 */
function parseOutput(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("fresh manifest, mint task_group area api → GRP-API-001", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0, `expected success, got: ${result.error}`);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-API-001"]);
  } finally {
    rm(dir);
  }
});

test("second call for same area advances counter → GRP-API-002", (t) => {
  const dir = makeTempDir();
  try {
    runMintId(dir, '--type task_group --area api');
    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-API-002"]);
  } finally {
    rm(dir);
  }
});

test("pre-existing GRP-API-005.yaml → first mint returns GRP-API-006", (t) => {
  const dir = makeTempDir();
  try {
    // Create a pre-existing task group file with group_id GRP-API-005
    const yamlContent = `group_id: GRP-API-005
name: Existing Group
description: Pre-seeded group
`;
    fs.writeFileSync(path.join(dir, "task-groups", "GRP-API-005.yaml"), yamlContent);

    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-API-006"]);
  } finally {
    rm(dir);
  }
});

test("different areas are independent: GRP-DB-001 then GRP-API-001", (t) => {
  const dir = makeTempDir();
  try {
    const result1 = runMintId(dir, '--type task_group --area db');
    assert.equal(result1.code, 0);
    const ids1 = parseOutput(result1.stdout);
    assert.deepEqual(ids1, ["GRP-DB-001"]);

    const result2 = runMintId(dir, '--type task_group --area api');
    assert.equal(result2.code, 0);
    const ids2 = parseOutput(result2.stdout);
    assert.deepEqual(ids2, ["GRP-API-001"]);
  } finally {
    rm(dir);
  }
});

test("task type uses 4-digit format → TASK-API-0001", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["TASK-API-0001"]);
  } finally {
    rm(dir);
  }
});

test("contract with --domain api-http → CONTRACT-API-HTTP-001", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type contract --domain api-http');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["CONTRACT-API-HTTP-001"]);
  } finally {
    rm(dir);
  }
});

test("epic → EPIC-001, never E-GLUE-*", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type epic');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["EPIC-001"]);
    // Verify it's not E-GLUE-*
    assert(!ids[0].startsWith("E-GLUE"));
  } finally {
    rm(dir);
  }
});

test("--count 3 for fresh area → 3 consecutive IDs (001, 002, 003)", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task_group --area api --count 3');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-API-001", "GRP-API-002", "GRP-API-003"]);
  } finally {
    rm(dir);
  }
});

test("after --count 3, next single mint is -004", (t) => {
  const dir = makeTempDir();
  try {
    runMintId(dir, '--type task_group --area api --count 3');
    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-API-004"]);
  } finally {
    rm(dir);
  }
});

test("area lowercase/mixed → uppercased", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task_group --area ApiHttp');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-APIHTTP-001"]);
  } finally {
    rm(dir);
  }
});

test("area with hyphens normalized correctly", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task_group --area api-http');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["GRP-API-HTTP-001"]);
  } finally {
    rm(dir);
  }
});

test("missing required --area for task_group → err:", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task_group');
    assert.equal(result.code, 1);
    assert(parseOutput(result.stdout)[0].startsWith("err:"));
  } finally {
    rm(dir);
  }
});

test("missing required --area for task → err:", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type task');
    assert.equal(result.code, 1);
    assert(parseOutput(result.stdout)[0].startsWith("err:"));
  } finally {
    rm(dir);
  }
});

test("contract without --domain or --area → err:", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type contract');
    assert.equal(result.code, 1);
    assert(parseOutput(result.stdout)[0].startsWith("err:"));
  } finally {
    rm(dir);
  }
});

test("contract falls back to --area if --domain absent", (t) => {
  const dir = makeTempDir();
  try {
    const result = runMintId(dir, '--type contract --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["CONTRACT-API-001"]);
  } finally {
    rm(dir);
  }
});

test("task-groups subdirectories ignored in scan (director-X/)", (t) => {
  const dir = makeTempDir();
  try {
    // Create a task group in a subdirectory with a high ID
    fs.mkdirSync(path.join(dir, "task-groups", "director-00"), { recursive: true });
    const yamlContent = `group_id: GRP-API-999
name: In Subdir
`;
    fs.writeFileSync(
      path.join(dir, "task-groups", "director-00", "GRP-API-999.yaml"),
      yamlContent
    );

    // Mint a new task group for api area
    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    // Should mint 001, not 1000, because subdirectory was skipped
    assert.deepEqual(ids, ["GRP-API-001"]);
  } finally {
    rm(dir);
  }
});

test("task-groups/_raw files ignored in scan", (t) => {
  const dir = makeTempDir();
  try {
    // Create files under _raw (should be ignored)
    fs.mkdirSync(path.join(dir, "task-groups", "_raw"), { recursive: true });
    const yamlContent = `group_id: GRP-API-999
name: In Raw
`;
    fs.writeFileSync(
      path.join(dir, "task-groups", "_raw", "GRP-API-999.yaml"),
      yamlContent
    );

    // Mint a new task group for api area
    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    // Should mint 001, not 1000, because _raw was skipped
    assert.deepEqual(ids, ["GRP-API-001"]);
  } finally {
    rm(dir);
  }
});

test("PARALLEL safety: 8 concurrent mints for same area are UNIQUE", (t) => {
  const dir = makeTempDir();
  try {
    const concurrency = 8;
    const promises = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve) => {
          const result = spawnSync(
            "node",
            [SCRIPT, "--manifest-dir", dir, "--type", "task_group", "--area", "api"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
          );
          const stdout = (result.stdout || "").trim();
          const code = result.status;
          resolve({ stdout, code });
        })
      );
    }

    Promise.all(promises).then((results) => {
      const ids = [];
      for (const res of results) {
        assert.equal(res.code, 0, `child process failed: ${res.stdout}`);
        const lines = res.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        assert.equal(lines.length, 1, "expected 1 ID per child");
        ids.push(lines[0]);
      }

      // All IDs must be unique
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, concurrency, `expected ${concurrency} unique IDs, got ${uniqueIds.size}`);

      // All IDs must match the pattern GRP-API-NNN
      for (const id of ids) {
        assert.match(id, /^GRP-API-\d{3}$/, `invalid ID format: ${id}`);
      }
    });
  } finally {
    rm(dir);
  }
});

test("PARALLEL safety: spawn 8 children, sync wait, verify all unique", (t) => {
  const dir = makeTempDir();
  try {
    const concurrency = 8;
    const results = [];

    // Spawn all children and collect their outputs
    for (let i = 0; i < concurrency; i++) {
      const result = spawnSync(
        "node",
        [SCRIPT, "--manifest-dir", dir, "--type", "task_group", "--area", "api"],
        { encoding: "utf-8" }
      );
      results.push(result);
    }

    const ids = [];
    for (const res of results) {
      assert.equal(res.status, 0, `child failed: ${res.stdout}`);
      const lines = res.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      assert.equal(lines.length, 1, "expected 1 ID per child");
      ids.push(lines[0]);
    }

    // All IDs must be unique
    const uniqueIds = new Set(ids);
    assert.equal(
      uniqueIds.size,
      concurrency,
      `expected ${concurrency} unique IDs, got ${uniqueIds.size}. IDs: ${ids.join(", ")}`
    );

    // All IDs must match the pattern GRP-API-NNN
    for (const id of ids) {
      assert.match(id, /^GRP-API-\d{3}$/, `invalid ID format: ${id}`);
    }
  } finally {
    rm(dir);
  }
});

test("task-groups: only scan top-level .yaml files", (t) => {
  const dir = makeTempDir();
  try {
    // Create a top-level file that should be scanned
    const topYaml = `group_id: GRP-API-005
name: Top Level
`;
    fs.writeFileSync(path.join(dir, "task-groups", "top.yaml"), topYaml);

    // Create a subdirectory with another file (should NOT be scanned)
    fs.mkdirSync(path.join(dir, "task-groups", "subdir"));
    const subYaml = `group_id: GRP-API-010
name: In Subdir
`;
    fs.writeFileSync(path.join(dir, "task-groups", "subdir", "sub.yaml"), subYaml);

    const result = runMintId(dir, '--type task_group --area api');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    // Should respect top-level max (005), not the hidden one (010)
    assert.deepEqual(ids, ["GRP-API-006"]);
  } finally {
    rm(dir);
  }
});

test("epic with 3-digit padding", (t) => {
  const dir = makeTempDir();
  try {
    // Mint 100 epics to get to EPIC-100
    runMintId(dir, '--type epic --count 100');
    const result = runMintId(dir, '--type epic');
    assert.equal(result.code, 0);
    const ids = parseOutput(result.stdout);
    assert.deepEqual(ids, ["EPIC-101"]);
  } finally {
    rm(dir);
  }
});
