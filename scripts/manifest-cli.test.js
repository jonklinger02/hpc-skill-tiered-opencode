#!/usr/bin/env node
/**
 * manifest-cli.test.js — Tests for manifest-cli.js
 *
 * Tests list, get, surfaces, add, update operations with proper fixtures.
 * Validates ID patterns, surface extraction, subdirectory/raw-path skipping.
 *
 * Run via:  node scripts/manifest-cli.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const SCRIPT = path.resolve(__dirname, "manifest-cli.js");

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temporary manifest directory.
 * files: { relPath -> content }
 */
function makeTempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-cli-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run manifest-cli with given args.
 * Returns { stdout, stderr, code }.
 */
function run(manifestDir, args) {
  try {
    const stdout = execSync(
      `node "${SCRIPT}" --manifest-dir "${manifestDir}" ${args}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const stdout = (e.stdout || "").trim();
    const stderr = (e.stderr || "").trim();
    return { stdout, stderr, code: e.status || 1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures: YAML content
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_DB = `contract_id: CONTRACT-DB-CONFIGSTORE-001
name: Database Config Store
domain: DB
surface:
  - kind: method
    name: ConfigStore.read
  - kind: method
    name: ConfigStore.write
description: Manages database configuration storage.
`;

const TASK_GROUP_DB = `group_id: GRP-DB-001
name: Database Setup
area: DB
description: Group of tasks for database initialization.
`;

const TASK_API = `task_id: TASK-API-0001
name: Implement API endpoint
area: API
description: Implement the main API endpoint.
`;

const EPIC_001 = `epic_id: EPIC-001
name: Core infrastructure
description: Set up core infrastructure.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("list --type contract includes surface symbols", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
  });

  try {
    const { stdout, code } = run(dir, "list --type contract");
    assert.equal(code, 0);

    const results = JSON.parse(stdout);
    assert(Array.isArray(results));
    assert.equal(results.length, 1);

    const contract = results[0];
    assert.equal(contract.id, "CONTRACT-DB-CONFIGSTORE-001");
    assert.equal(contract.name, "Database Config Store");
    assert(Array.isArray(contract.surface));

    // Check surface contains the expected symbol names
    assert(contract.surface.includes("ConfigStore.read"));
    assert(contract.surface.includes("ConfigStore.write"));
  } finally {
    rm(dir);
  }
});

test("list --type task_group returns group artifacts", () => {
  const dir = makeTempDir({
    "task-groups/GRP-DB-001.yaml": TASK_GROUP_DB,
  });

  try {
    const { stdout, code } = run(dir, "list --type task_group");
    assert.equal(code, 0);

    const results = JSON.parse(stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "GRP-DB-001");
    assert.equal(results[0].name, "Database Setup");
  } finally {
    rm(dir);
  }
});

test("surfaces returns map of contract_id to surface names", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
  });

  try {
    const { stdout, code } = run(dir, "surfaces");
    assert.equal(code, 0);

    const surfaceMap = JSON.parse(stdout);
    assert(surfaceMap["CONTRACT-DB-CONFIGSTORE-001"]);
    assert(Array.isArray(surfaceMap["CONTRACT-DB-CONFIGSTORE-001"]));
    assert(surfaceMap["CONTRACT-DB-CONFIGSTORE-001"].includes("ConfigStore.read"));
    assert(surfaceMap["CONTRACT-DB-CONFIGSTORE-001"].includes("ConfigStore.write"));
  } finally {
    rm(dir);
  }
});

test("get --type contract --id ID returns YAML verbatim", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
  });

  try {
    const { stdout, code } = run(
      dir,
      "get --type contract --id CONTRACT-DB-CONFIGSTORE-001"
    );
    assert.equal(code, 0);

    // Parse and verify round-trip
    const obj = yaml.load(stdout);
    assert.equal(obj.contract_id, "CONTRACT-DB-CONFIGSTORE-001");
    assert.equal(obj.name, "Database Config Store");
  } finally {
    rm(dir);
  }
});

test("get missing id returns err:not_found with exit 1", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
  });

  try {
    const { stdout, code } = run(dir, "get --type contract --id CONTRACT-MISSING-001");
    assert.equal(code, 1);
    assert.equal(stdout, "err:not_found");
  } finally {
    rm(dir);
  }
});

test("add --type task creates new task file", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "task-content.yaml");
  fs.writeFileSync(contentFile, TASK_API);

  try {
    const { stdout, code } = run(
      dir,
      `add --type task --id TASK-API-0001 --content-file "${contentFile}"`
    );
    assert.equal(code, 0);
    assert.equal(stdout, "ok:add task TASK-API-0001");

    // Verify file exists and contains correct content
    const taskPath = path.join(dir, "tasks", "TASK-API-0001.yaml");
    assert(fs.existsSync(taskPath));
    const obj = yaml.load(fs.readFileSync(taskPath, "utf-8"));
    assert.equal(obj.task_id, "TASK-API-0001");
  } finally {
    rm(dir);
  }
});

test("add existing id returns err:exists:ID", () => {
  const dir = makeTempDir({
    "tasks/TASK-API-0001.yaml": TASK_API,
  });
  const contentFile = path.join(dir, "task-content.yaml");
  fs.writeFileSync(contentFile, TASK_API);

  try {
    const { stdout, code } = run(
      dir,
      `add --type task --id TASK-API-0001 --content-file "${contentFile}"`
    );
    assert.equal(code, 1);
    assert.equal(stdout, "err:exists:TASK-API-0001");
  } finally {
    rm(dir);
  }
});

test("add with id NOT matching content field returns err:id_mismatch", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "task-content.yaml");
  fs.writeFileSync(contentFile, TASK_API);

  try {
    // Try to add with id TASK-API-0002 but content has TASK-API-0001
    const { stdout, code } = run(
      dir,
      `add --type task --id TASK-API-0002 --content-file "${contentFile}"`
    );
    assert.equal(code, 1);
    assert.equal(stdout, "err:id_mismatch");
  } finally {
    rm(dir);
  }
});

test("add with non-canonical id returns err:bad_id", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "task-content.yaml");

  // Create content with a non-canonical ID
  const badContent = `group_id: TG-API-001
name: Bad Task Group
`;
  fs.writeFileSync(contentFile, badContent);

  try {
    const { stdout, code } = run(
      dir,
      `add --type task_group --id TG-API-001 --content-file "${contentFile}"`
    );
    assert.equal(code, 1);
    assert.equal(stdout, "err:bad_id");
  } finally {
    rm(dir);
  }
});

test("update existing artifact changes content on disk", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
  });

  // Update with different content
  const updatedContent = `contract_id: CONTRACT-DB-CONFIGSTORE-001
name: Updated Database Config Store
domain: DB
surface:
  - kind: method
    name: ConfigStore.read
  - kind: method
    name: ConfigStore.write
  - kind: method
    name: ConfigStore.delete
description: Updated description.
`;

  const contentFile = path.join(dir, "updated-content.yaml");
  fs.writeFileSync(contentFile, updatedContent);

  try {
    const { stdout, code } = run(
      dir,
      `update --type contract --id CONTRACT-DB-CONFIGSTORE-001 --content-file "${contentFile}"`
    );
    assert.equal(code, 0);
    assert.equal(stdout, "ok:update contract CONTRACT-DB-CONFIGSTORE-001");

    // Verify content changed
    const contractPath = path.join(dir, "contracts", "CONTRACT-DB-CONFIGSTORE-001.yaml");
    const obj = yaml.load(fs.readFileSync(contractPath, "utf-8"));
    assert.equal(obj.name, "Updated Database Config Store");
    assert.equal(obj.surface.length, 3);
  } finally {
    rm(dir);
  }
});

test("update missing id returns err:not_found", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "content.yaml");
  fs.writeFileSync(contentFile, CONTRACT_DB);

  try {
    const { stdout, code } = run(
      dir,
      `update --type contract --id CONTRACT-DB-CONFIGSTORE-001 --content-file "${contentFile}"`
    );
    assert.equal(code, 1);
    assert.equal(stdout, "err:not_found");
  } finally {
    rm(dir);
  }
});

test("list/surfaces skip subdirectories", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
    "contracts/director-subdir/CONTRACT-IGNORED-001.yaml": `contract_id: CONTRACT-IGNORED-001
name: Should be ignored
surface: []
`,
  });

  try {
    // list should only return the top-level contract
    const { stdout, code } = run(dir, "list --type contract");
    assert.equal(code, 0);

    const results = JSON.parse(stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "CONTRACT-DB-CONFIGSTORE-001");

    // surfaces should only include the top-level contract
    const { stdout: surfOutput } = run(dir, "surfaces");
    const surfMap = JSON.parse(surfOutput);
    assert(surfMap["CONTRACT-DB-CONFIGSTORE-001"]);
    assert(!surfMap["CONTRACT-IGNORED-001"]);
  } finally {
    rm(dir);
  }
});

test("list/surfaces skip _raw paths", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-DB-CONFIGSTORE-001.yaml": CONTRACT_DB,
    "contracts/_raw_backup.yaml": `contract_id: CONTRACT-RAW-BACKUP-001
name: Should be ignored
surface: []
`,
  });

  try {
    const { stdout, code } = run(dir, "list --type contract");
    assert.equal(code, 0);

    const results = JSON.parse(stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "CONTRACT-DB-CONFIGSTORE-001");

    // surfaces should skip _raw file
    const { stdout: surfOutput } = run(dir, "surfaces");
    const surfMap = JSON.parse(surfOutput);
    assert(surfMap["CONTRACT-DB-CONFIGSTORE-001"]);
    assert(!surfMap["CONTRACT-RAW-BACKUP-001"]);
  } finally {
    rm(dir);
  }
});

test("add with non-canonical epic id returns err:bad_id", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "epic-content.yaml");

  const badEpicContent = `epic_id: BAD-EPIC-001
name: Bad epic
`;
  fs.writeFileSync(contentFile, badEpicContent);

  try {
    const { stdout, code } = run(
      dir,
      `add --type epic --id BAD-EPIC-001 --content-file "${contentFile}"`
    );
    assert.equal(code, 1);
    assert.equal(stdout, "err:bad_id");
  } finally {
    rm(dir);
  }
});

test("add with valid epic id EPIC-NNN succeeds", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "epic-content.yaml");
  fs.writeFileSync(contentFile, EPIC_001);

  try {
    const { stdout, code } = run(
      dir,
      `add --type epic --id EPIC-001 --content-file "${contentFile}"`
    );
    assert.equal(code, 0);
    assert.equal(stdout, "ok:add epic EPIC-001");

    const epicPath = path.join(dir, "epics", "EPIC-001.yaml");
    assert(fs.existsSync(epicPath));
  } finally {
    rm(dir);
  }
});

test("add with valid epic id E-GLUE-NNN succeeds", () => {
  const dir = makeTempDir({});
  const contentFile = path.join(dir, "epic-content.yaml");

  const eGlueContent = `epic_id: E-GLUE-042
name: Glue epic
`;
  fs.writeFileSync(contentFile, eGlueContent);

  try {
    const { stdout, code } = run(
      dir,
      `add --type epic --id E-GLUE-042 --content-file "${contentFile}"`
    );
    assert.equal(code, 0);
    assert.equal(stdout, "ok:add epic E-GLUE-042");

    const epicPath = path.join(dir, "epics", "E-GLUE-042.yaml");
    assert(fs.existsSync(epicPath));
  } finally {
    rm(dir);
  }
});

test("list empty directory returns empty array", () => {
  const dir = makeTempDir({});

  try {
    const { stdout, code } = run(dir, "list --type contract");
    assert.equal(code, 0);

    const results = JSON.parse(stdout);
    assert(Array.isArray(results));
    assert.equal(results.length, 0);
  } finally {
    rm(dir);
  }
});

test("surfaces empty manifest returns empty object", () => {
  const dir = makeTempDir({});

  try {
    const { stdout, code } = run(dir, "surfaces");
    assert.equal(code, 0);

    const surfMap = JSON.parse(stdout);
    assert.equal(Object.keys(surfMap).length, 0);
  } finally {
    rm(dir);
  }
});

test("contract surface tolerant of missing names", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-TEST-001.yaml": `contract_id: CONTRACT-TEST-001
name: Test
surface:
  - kind: method
    name: Method.one
  - kind: method
  - name:
  - kind: method
    name: Method.two
`,
  });

  try {
    const { stdout, code } = run(dir, "list --type contract");
    assert.equal(code, 0);

    const results = JSON.parse(stdout);
    const contract = results[0];

    // Should only include items with valid names
    assert.equal(contract.surface.length, 2);
    assert(contract.surface.includes("Method.one"));
    assert(contract.surface.includes("Method.two"));
  } finally {
    rm(dir);
  }
});
