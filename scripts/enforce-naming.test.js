#!/usr/bin/env node
// Tests for enforce-naming.js — canonical ID naming validation and fixes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const SCRIPT = path.resolve(__dirname, "enforce-naming.js");
const {
  checkManifest,
  buildRenameMap,
  applyRenames,
  makeIdReplaceRegex,
  extractAreaFromOldId,
  findArtifactFiles,
} = require("./enforce-naming.js");

// ───────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-naming-test-"));
}

function rm(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

function createArtifact(manifestDir, type, id, data = {}) {
  const dirs = {
    epic: "epics",
    task_group: "task-groups",
    task: "tasks",
    contract: "contracts",
  };

  const dir = path.join(manifestDir, dirs[type]);
  fs.mkdirSync(dir, { recursive: true });

  const idField = {
    epic: "epic_id",
    task_group: "group_id",
    task: "task_id",
    contract: "contract_id",
  };

  const obj = { [idField[type]]: id, ...data };
  const file = path.join(dir, `${id}.yaml`);
  fs.writeFileSync(file, yaml.dump(obj), "utf-8");
  return file;
}

function runCLI(args) {
  try {
    const out = execSync(`node "${SCRIPT}" ${args}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { stdout: out, exitCode: 0 };
  } catch (e) {
    const stdout = (e.stdout || "").trim();
    const stderr = (e.stderr || "").trim();
    return { stdout: stdout || stderr, stderr, exitCode: e.status };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("extractAreaFromOldId: TG-API-001 → API", () => {
  assert.equal(extractAreaFromOldId("TG-API-001"), "API");
});

test("extractAreaFromOldId: DB-TG-001 → DB", () => {
  assert.equal(extractAreaFromOldId("DB-TG-001"), "DB");
});

test("extractAreaFromOldId: no 2+ char token → GEN", () => {
  assert.equal(extractAreaFromOldId("X-Y-001"), "GEN");
});

test("makeIdReplaceRegex: boundary-safe replacement", () => {
  const regex = makeIdReplaceRegex("TG-API-001");
  const input = "group_id: TG-API-001 and TG-API-0010 and prefix-TG-API-001-suffix";
  const result = input.replace(regex, "NEW-ID");
  assert.match(result, /NEW-ID and TG-API-0010/);
});

// ═══════════════════════════════════════════════════════════════════════════
// CHECK MODE TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("check: canonical task-group is not flagged", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "GRP-DB-001", { functional_area: "DB" });
    const { violations } = checkManifest(dir);
    assert.equal(violations.length, 0);
  } finally {
    rm(dir);
  }
});

test("check: violating task-group TG-API-001 is flagged", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });
    createArtifact(dir, "task_group", "GRP-DB-001", { functional_area: "DB" });
    const { violations } = checkManifest(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].type, "task_group");
    assert.equal(violations[0].id, "TG-API-001");
  } finally {
    rm(dir);
  }
});

test("check: all canonical → clean exit 0", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "GRP-API-001", { functional_area: "API" });
    createArtifact(dir, "task", "TASK-API-0001", { functional_area: "API" });
    const result = runCLI(`--manifest-dir "${dir}"`);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ok:naming clean/);
  } finally {
    rm(dir);
  }
});

test("check: violations → exit 1", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });
    const result = runCLI(`--manifest-dir "${dir}"`);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /err:naming:1 violation/);
  } finally {
    rm(dir);
  }
});

test("check: ignores subdirectories (director-API/)", () => {
  const dir = mkTmp();
  try {
    const directorDir = path.join(dir, "task-groups", "director-API");
    fs.mkdirSync(directorDir, { recursive: true });
    const badFile = path.join(directorDir, "director-output.yaml");
    fs.writeFileSync(badFile, yaml.dump({ group_id: "BAD-ID-001" }), "utf-8");
    const { violations } = checkManifest(dir);
    assert.equal(violations.length, 0);
  } finally {
    rm(dir);
  }
});

test("check: ignores _raw paths", () => {
  const dir = mkTmp();
  try {
    const rawDir = path.join(dir, "manifest", "_raw");
    fs.mkdirSync(rawDir, { recursive: true });
    const badFile = path.join(rawDir, "BAD-ID.yaml");
    fs.writeFileSync(badFile, yaml.dump({ task_id: "BAD-ID-0001" }), "utf-8");
    const { violations } = checkManifest(dir);
    assert.equal(violations.length, 0);
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX MODE TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("fix: rename violating task-group and rewrite references", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });
    createArtifact(dir, "task", "TASK-API-0001", {
      functional_area: "API",
      group_id: "TG-API-001",
    });

    // Run fix
    const result = runCLI(`--manifest-dir "${dir}" --fix`);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ok:naming fixed/);

    // Verify file renamed
    const taskGroupFile = path.join(dir, "task-groups", "GRP-API-001.yaml");
    assert.ok(fs.existsSync(taskGroupFile));

    // Verify reference rewritten in task
    const taskFile = path.join(dir, "tasks", "TASK-API-0001.yaml");
    const taskData = yaml.load(fs.readFileSync(taskFile, "utf-8"));
    assert.equal(taskData.group_id, "GRP-API-001");

    // Verify no violations on re-check
    const { violations } = checkManifest(dir);
    assert.equal(violations.length, 0);
  } finally {
    rm(dir);
  }
});

test("fix: boundary-safe replacement (TG-API-0010 not rewritten)", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });

    // Create another file with a longer ID that should not be rewritten
    const tasksDir = path.join(dir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const otherFile = path.join(tasksDir, "reference.yaml");
    fs.writeFileSync(
      otherFile,
      yaml.dump({ content: "depends on TG-API-0010 and TG-API-001" }),
      "utf-8"
    );

    // Run fix
    runCLI(`--manifest-dir "${dir}" --fix`);

    // Verify TG-API-001 was rewritten but TG-API-0010 was not
    const content = fs.readFileSync(otherFile, "utf-8");
    assert.match(content, /GRP-API-001/);
    assert.match(content, /TG-API-0010/);
  } finally {
    rm(dir);
  }
});

test("fix: collision detection (newId conflicts with existing artifact)", () => {
  const dir = mkTmp();
  try {
    // Create a canonical artifact, then try to fix a violating one that would collide
    createArtifact(dir, "task_group", "GRP-API-001", { functional_area: "API" });
    // This violating ID extracts to API and would try to map to GRP-API-001 but it exists
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });

    const result = runCLI(`--manifest-dir "${dir}" --fix`);
    // Should succeed because TG-API-001 becomes GRP-API-002 (next in sequence)
    assert.equal(result.exitCode, 0);

    // Verify both files exist with correct names
    assert.ok(fs.existsSync(path.join(dir, "task-groups", "GRP-API-001.yaml")));
    assert.ok(fs.existsSync(path.join(dir, "task-groups", "GRP-API-002.yaml")));
  } finally {
    rm(dir);
  }
});

test("fix: contract rename and reference rewrite", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "contract", "CTR-API-1", {
      owner_area: "API",
      contract_type: "OPENAPI",
    });
    createArtifact(dir, "task", "TASK-API-0001", {
      functional_area: "API",
      contracts_consumed: [{ contract_id: "CTR-API-1" }],
    });

    runCLI(`--manifest-dir "${dir}" --fix`);

    // Verify contract file renamed
    assert.ok(fs.existsSync(path.join(dir, "contracts", "CONTRACT-API-001.yaml")));

    // Verify task reference rewritten
    const taskData = yaml.load(
      fs.readFileSync(path.join(dir, "tasks", "TASK-API-0001.yaml"), "utf-8")
    );
    assert.equal(taskData.contracts_consumed[0].contract_id, "CONTRACT-API-001");
  } finally {
    rm(dir);
  }
});

test("fix: epic rename (only with --include-epics)", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "epic", "EPIC-001", { name: "Test" });

    // Without --include-epics, epic should not be renamed
    runCLI(`--manifest-dir "${dir}" --fix`);
    assert.ok(fs.existsSync(path.join(dir, "epics", "EPIC-001.yaml")));

    // With --include-epics, it would be canonical already, so no change
    // (need a bad epic format to test rename)
  } finally {
    rm(dir);
  }
});

test("fix: E-GLUE-* left untouched", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "epic", "E-GLUE-000", { name: "Glue" });

    runCLI(`--manifest-dir "${dir}" --fix --include-epics`);

    // Verify E-GLUE-000 still exists (not renamed)
    assert.ok(fs.existsSync(path.join(dir, "epics", "E-GLUE-000.yaml")));
  } finally {
    rm(dir);
  }
});

test("fix: no violations → 0 renamed, still clean", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "GRP-API-001", { functional_area: "API" });

    const result = runCLI(`--manifest-dir "${dir}" --fix`);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /0 renamed, now clean/);
  } finally {
    rm(dir);
  }
});

test("fix: report written with renames list", () => {
  const dir = mkTmp();
  try {
    const reportPath = path.join(dir, "wiki", "naming-report.yaml");
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });

    runCLI(
      `--manifest-dir "${dir}" --fix --report "${reportPath}"`
    );

    assert.ok(fs.existsSync(reportPath));
    const report = yaml.load(fs.readFileSync(reportPath, "utf-8"));
    assert.equal(report.summary.mode, "fix");
    assert.ok(Array.isArray(report.renames));
    assert.ok(report.renames.length > 0);
  } finally {
    rm(dir);
  }
});

test("buildRenameMap: area from functional_area field", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-OLD-001", { functional_area: "DB" });

    const result = buildRenameMap(dir, false);
    assert.ok(!result.error);
    assert.equal(result.map["TG-OLD-001"], "GRP-DB-001");
  } finally {
    rm(dir);
  }
});

test("buildRenameMap: area extracted from ID token if not in field", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001"); // no functional_area

    const result = buildRenameMap(dir, false);
    assert.ok(!result.error);
    assert.equal(result.map["TG-API-001"], "GRP-API-001");
  } finally {
    rm(dir);
  }
});

test("buildRenameMap: sequence continues past existing canonical IDs", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "GRP-API-001", { functional_area: "API" });
    createArtifact(dir, "task_group", "GRP-API-002", { functional_area: "API" });
    createArtifact(dir, "task_group", "TG-OLD-001", { functional_area: "API" });

    const result = buildRenameMap(dir, false);
    assert.ok(!result.error);
    // Should be GRP-API-003 (continuing the sequence)
    assert.equal(result.map["TG-OLD-001"], "GRP-API-003");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS (CLI)
// ═══════════════════════════════════════════════════════════════════════════

test("CLI: --check mode is default", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });

    // Run without --check or --fix; should default to check
    const result = runCLI(`--manifest-dir "${dir}"`);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /err:naming/);
  } finally {
    rm(dir);
  }
});

test("CLI: --manifest-dir required", () => {
  const result = runCLI("");
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /err:naming:usage/);
});

test("CLI: default report written to wiki/naming-report.yaml", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "GRP-API-001", { functional_area: "API" });

    runCLI(`--manifest-dir "${dir}"`);

    const reportPath = path.join(dir, "..", "wiki", "naming-report.yaml");
    assert.ok(fs.existsSync(reportPath));
  } finally {
    rm(dir);
  }
});

test("CLI: --report custom path", () => {
  const dir = mkTmp();
  try {
    const customReportPath = path.join(dir, "custom-report.yaml");
    createArtifact(dir, "task_group", "GRP-API-001", { functional_area: "API" });

    runCLI(
      `--manifest-dir "${dir}" --report "${customReportPath}"`
    );

    assert.ok(fs.existsSync(customReportPath));
  } finally {
    rm(dir);
  }
});

test("CLI: multiple violations reported with counts", () => {
  const dir = mkTmp();
  try {
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });
    createArtifact(dir, "task", "TSK-DB-0001", { functional_area: "DB" });
    createArtifact(dir, "contract", "CTRCT-001", { owner_area: "API" });

    const result = runCLI(`--manifest-dir "${dir}"`);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /err:naming:3 violation/);
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPREHENSIVE INTEGRATION TEST
// ═══════════════════════════════════════════════════════════════════════════

test("comprehensive: full workflow check → violations → fix → clean", () => {
  const dir = mkTmp();
  try {
    // Initial state: mixed canonical and violating
    createArtifact(dir, "task_group", "TG-API-001", { functional_area: "API" });
    createArtifact(dir, "task_group", "GRP-DB-001", { functional_area: "DB" });
    createArtifact(dir, "task", "TASK-API-0001", {
      functional_area: "API",
      group_id: "TG-API-001",
    });
    createArtifact(dir, "task", "TASK-DB-0001", {
      functional_area: "DB",
      group_id: "GRP-DB-001",
    });
    createArtifact(dir, "contract", "CTR-USER-1", {
      owner_area: "API",
      contract_type: "OPENAPI",
    });

    // Step 1: Check (should find violations)
    const checkResult = runCLI(`--manifest-dir "${dir}"`);
    assert.equal(checkResult.exitCode, 1);
    assert.match(checkResult.stdout, /err:naming:2 violation/);

    // Step 2: Fix
    const fixResult = runCLI(`--manifest-dir "${dir}" --fix`);
    assert.equal(fixResult.exitCode, 0);
    assert.match(fixResult.stdout, /ok:naming fixed/);

    // Step 3: Re-check (should be clean)
    const recheckResult = runCLI(`--manifest-dir "${dir}"`);
    assert.equal(recheckResult.exitCode, 0);
    assert.match(recheckResult.stdout, /ok:naming clean/);

    // Step 4: Verify all references were rewritten
    const taskData = yaml.load(
      fs.readFileSync(path.join(dir, "tasks", "TASK-API-0001.yaml"), "utf-8")
    );
    assert.equal(taskData.group_id, "GRP-API-001");

    const contractData = yaml.load(
      fs.readFileSync(path.join(dir, "contracts", "CONTRACT-API-001.yaml"), "utf-8")
    );
    assert.ok(contractData);
  } finally {
    rm(dir);
  }
});
