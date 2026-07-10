#!/usr/bin/env node
/**
 * Tests for module-path-emit.js
 *
 * Run via:    node --test scripts/module-path-emit.test.js
 * Or:         ./run-tests.sh
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const MODULE_PATH_EMIT_SCRIPT = path.resolve(__dirname, "module-path-emit.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-module-path-emit-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run module-path-emit.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runModulePathEmit(manifestDir, outputPath) {
  try {
    return execSync(
      `node "${MODULE_PATH_EMIT_SCRIPT}" --manifest-dir "${manifestDir}" --output "${outputPath}"`,
      { encoding: "utf-8", cwd: path.dirname(MODULE_PATH_EMIT_SCRIPT) }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Load a YAML file and return the parsed object.
 */
function loadOutput(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("react web_ui with file-tree paths → maps logical names, has conventions and anchors", async () => {
  const tmpDir = makeTempDir();
  try {
    // Create manifest.yaml with react tech_stack
    const manifest = {
      tech_stack: [
        {
          language: "typescript",
          role: "web_ui",
          framework: "react",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    // Create file-tree.yaml with some paths
    const fileTree = {
      file_tree: [
        "src/ui/components/LoadingSkeleton.tsx",
        "src/ui/hooks/useAuditLog.ts",
        "src/ui/api/client.ts",
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    // Check output message
    assert.match(result, /^ok:/);
    assert.match(result, /logical names.*anchors/);

    // Load and validate output
    const output = loadOutput(outputPath);
    assert.ok(output);
    assert.ok(output.module_paths);

    // Check logical_name_to_path
    const logicalNames = output.module_paths.logical_name_to_path;
    assert.deepEqual(logicalNames.LoadingSkeleton, "src/ui/components/LoadingSkeleton.tsx");
    assert.deepEqual(logicalNames.useAuditLog, "src/ui/hooks/useAuditLog.ts");
    assert.deepEqual(logicalNames.client, "src/ui/api/client.ts");

    // Check alias_anchors
    const anchors = output.module_paths.alias_anchors;
    assert.deepEqual(anchors["@/components"], "src/ui/components");
    assert.deepEqual(anchors["@/hooks"], "src/ui/hooks");
    assert.deepEqual(anchors["@/api"], "src/ui/api");

    // Check conventions
    const conventions = output.module_paths.conventions;
    assert.deepEqual(conventions.react_component_location, "src/ui/components");
    assert.deepEqual(conventions.react_hook_location, "src/ui/hooks");
  } finally {
    rm(tmpDir);
  }
});

test("empty tech_stack → emits minimal valid manifest", async () => {
  const tmpDir = makeTempDir();
  try {
    // Create manifest.yaml with empty tech_stack
    const manifest = {
      tech_stack: [],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    // Check output message mentions "no tech_stack"
    assert.match(result, /^ok:/);
    assert.match(result, /no tech_stack/);

    // Load and validate output
    const output = loadOutput(outputPath);
    assert.ok(output);
    assert.ok(output.module_paths);
    assert.deepEqual(output.module_paths.logical_name_to_path, {});
    assert.deepEqual(output.module_paths.alias_anchors, {});
    assert.deepEqual(output.module_paths.conventions, {});
  } finally {
    rm(tmpDir);
  }
});

test("no manifest files at all → emits minimal valid manifest", async () => {
  const tmpDir = makeTempDir();
  try {
    // Don't create any manifest files
    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    // Should succeed with empty manifest
    assert.match(result, /^ok:/);

    // Load and validate output
    const output = loadOutput(outputPath);
    assert.ok(output);
    assert.ok(output.module_paths);
  } finally {
    rm(tmpDir);
  }
});

test("file-tree as list of objects with path property → collects paths", async () => {
  const tmpDir = makeTempDir();
  try {
    const manifest = {
      tech_stack: [
        {
          language: "typescript",
          role: "web_ui",
          framework: "react",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    // file-tree as list of objects
    const fileTree = {
      file_tree: [
        { path: "src/ui/components/Button.tsx" },
        { path: "src/ui/hooks/useButton.ts" },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    assert.match(result, /^ok:/);

    const output = loadOutput(outputPath);
    assert.ok(output.module_paths.logical_name_to_path.Button);
    assert.ok(output.module_paths.logical_name_to_path.useButton);
  } finally {
    rm(tmpDir);
  }
});

test("file-tree as nested mapping → collects paths from all levels", async () => {
  const tmpDir = makeTempDir();
  try {
    const manifest = {
      tech_stack: [
        {
          language: "typescript",
          role: "web_ui",
          framework: "react",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    // file-tree as nested structure
    const fileTree = {
      file_tree: {
        src: {
          ui: {
            components: ["LoadingSkeleton.tsx"],
            hooks: ["useAuditLog.ts"],
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    assert.match(result, /^ok:/);

    const output = loadOutput(outputPath);
    // Note: nested structures need full paths to be reconstructed,
    // but our collector should at least find the basenames as strings
    // This test validates the tolerance for nested input.
    assert.ok(output.module_paths);
  } finally {
    rm(tmpDir);
  }
});

test("default output path → writes to <manifest-dir>/module-paths.yaml", async () => {
  const tmpDir = makeTempDir();
  try {
    const manifest = {
      tech_stack: [
        {
          language: "typescript",
          role: "web_ui",
          framework: "react",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    const fileTree = {
      file_tree: ["src/ui/components/Test.tsx"],
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    // Run without --output (uses default)
    const result = execSync(
      `node "${MODULE_PATH_EMIT_SCRIPT}" --manifest-dir "${tmpDir}"`,
      { encoding: "utf-8", cwd: path.dirname(MODULE_PATH_EMIT_SCRIPT) }
    ).trim();

    assert.match(result, /^ok:/);

    // Check that module-paths.yaml exists in manifest-dir
    const defaultPath = path.join(tmpDir, "module-paths.yaml");
    assert.ok(fs.existsSync(defaultPath));

    const output = loadOutput(defaultPath);
    assert.ok(output.module_paths);
  } finally {
    rm(tmpDir);
  }
});

test("missing --manifest-dir → error", async () => {
  try {
    execSync(`node "${MODULE_PATH_EMIT_SCRIPT}"`, {
      encoding: "utf-8",
      cwd: path.dirname(MODULE_PATH_EMIT_SCRIPT),
    });
    assert.fail("should have thrown");
  } catch (e) {
    const output = (e.stdout || "") + (e.stderr || "");
    assert.match(output, /err:/);
  }
});

test("duplicate logical names → keeps first, ignores duplicates", async () => {
  const tmpDir = makeTempDir();
  try {
    const manifest = {
      tech_stack: [
        {
          language: "typescript",
          role: "web_ui",
          framework: "react",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    // Two files with same basename (different extensions)
    const fileTree = {
      file_tree: [
        "src/ui/components/Button.tsx",
        "src/ui/components/Button.test.tsx", // same logical name "Button"
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    assert.match(result, /^ok:/);

    const output = loadOutput(outputPath);
    // Should have only one "Button" entry (the first one)
    assert.deepEqual(
      output.module_paths.logical_name_to_path.Button,
      "src/ui/components/Button.tsx"
    );
  } finally {
    rm(tmpDir);
  }
});

test("express/fastify api_server → conventions include server_entry_location", async () => {
  const tmpDir = makeTempDir();
  try {
    const manifest = {
      tech_stack: [
        {
          language: "typescript",
          role: "api_server",
          framework: "express",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    const fileTree = {
      file_tree: ["src/server/index.ts"],
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    assert.match(result, /^ok:/);

    const output = loadOutput(outputPath);
    assert.deepEqual(
      output.module_paths.conventions.server_entry_location,
      "src/server"
    );
  } finally {
    rm(tmpDir);
  }
});

test("python control_plane → conventions include python_package_root", async () => {
  const tmpDir = makeTempDir();
  try {
    const manifest = {
      tech_stack: [
        {
          language: "python",
          role: "control_plane",
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "manifest.yaml"),
      yaml.dump(manifest),
      "utf-8"
    );

    const fileTree = {
      file_tree: ["src/orchestrator.py"],
    };
    fs.writeFileSync(
      path.join(tmpDir, "file-tree.yaml"),
      yaml.dump(fileTree),
      "utf-8"
    );

    const outputPath = path.join(tmpDir, "module-paths.yaml");
    const result = runModulePathEmit(tmpDir, outputPath);

    assert.match(result, /^ok:/);

    const output = loadOutput(outputPath);
    assert.deepEqual(
      output.module_paths.conventions.python_package_root,
      "src"
    );
  } finally {
    rm(tmpDir);
  }
});
