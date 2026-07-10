#!/usr/bin/env node
/**
 * Tests for emit-build-commands.js
 *
 * Run via:    node --test scripts/emit-build-commands.test.js
 * Or:         ./run-tests.sh
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const SCRIPT = path.resolve(__dirname, "emit-build-commands.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-emit-build-commands-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run emit-build-commands.js and return trimmed stdout.
 */
function runEmitBuildCommands(manifestDir, opts = {}) {
  try {
    let cmd = `node "${SCRIPT}" --manifest-dir "${manifestDir}"`;
    if (opts.output) cmd += ` --output "${opts.output}"`;
    if (opts.port) cmd += ` --port ${opts.port}`;
    if (opts.force) cmd += ` --force`;

    return execSync(cmd, {
      encoding: "utf-8",
      cwd: path.dirname(SCRIPT),
    }).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Load a YAML file and return parsed object, or null on error.
 */
function loadYAML(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Parse boot_smoke with the exact regex from manifest-validate.js.
 * Matches: ^boot_smoke:\s*"?([^"\n]+?)"?\s*$
 */
function extractBootSmoke(yamlContent) {
  const match = yamlContent.match(/^boot_smoke:\s*"?([^"\n]+?)"?\s*$/m);
  return match ? match[1] : null;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("tech_stack with express api_server + vite web_ui → api_server wins (priority)", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [
        { language: "typescript", role: "api_server", framework: "express" },
        { language: "typescript", role: "web_ui", bundler: "vite", framework: "react" },
      ],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    const output = runEmitBuildCommands(dir);
    assert.match(output, /^ok:/);
    assert.match(output, /boot_smoke=yes/);
    assert.match(output, /project_type=node/);

    const bcPath = path.join(dir, "build-commands.yaml");
    const content = fs.readFileSync(bcPath, "utf-8");
    const bootSmoke = extractBootSmoke(content);

    assert.ok(bootSmoke, "boot_smoke should have a value");
    assert.match(bootSmoke, /curl/);
    assert.match(bootSmoke, /\/health/);
    assert.ok(!bootSmoke.includes('"'), "boot_smoke should not have embedded quotes");
    assert.ok(bootSmoke.split("\n").length === 1, "boot_smoke must be single-line");

    const bc = loadYAML(bcPath);
    assert.equal(bc.project_type, "node");
    assert.ok(Array.isArray(bc.required_phases));
    assert.ok(bc.required_phases.includes("boot_smoke"));
  } finally {
    rm(dir);
  }
});

test("tech_stack with only vite web_ui → boot_smoke uses vite preview", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [
        { language: "typescript", role: "web_ui", bundler: "vite", framework: "react" },
      ],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    const output = runEmitBuildCommands(dir);
    assert.match(output, /^ok:/);

    const bcPath = path.join(dir, "build-commands.yaml");
    const content = fs.readFileSync(bcPath, "utf-8");
    const bootSmoke = extractBootSmoke(content);

    assert.ok(bootSmoke);
    assert.match(bootSmoke, /vite preview/);
    assert.match(bootSmoke, /curl/);
    assert.ok(!bootSmoke.includes('"'), "no embedded quotes");
  } finally {
    rm(dir);
  }
});

test("python control_plane only → project_type python, typecheck mypy, boot_smoke pip install", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "python", role: "control_plane" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    const output = runEmitBuildCommands(dir);
    assert.match(output, /^ok:/);
    assert.match(output, /project_type=python/);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.equal(bc.project_type, "python");
    assert.ok(bc.typecheck);
    assert.match(bc.typecheck, /mypy/);

    const content = fs.readFileSync(bcPath, "utf-8");
    const bootSmoke = extractBootSmoke(content);
    assert.ok(bootSmoke);
    assert.match(bootSmoke, /pip install/);
  } finally {
    rm(dir);
  }
});

test("existing build-commands.yaml + no --force → not overwritten; WITH --force → overwritten", () => {
  const dir = mkTmp();
  try {
    const bcPath = path.join(dir, "build-commands.yaml");
    const originalContent = "original_content: true\n";
    fs.writeFileSync(bcPath, originalContent, "utf-8");

    // Run without --force: should not overwrite
    const manifest = {
      tech_stack: [{ language: "typescript", role: "web_ui", bundler: "vite" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    const output1 = runEmitBuildCommands(dir);
    assert.match(output1, /exists.*use --force/);
    const content1 = fs.readFileSync(bcPath, "utf-8");
    assert.equal(content1, originalContent);

    // Run with --force: should overwrite
    const output2 = runEmitBuildCommands(dir, { force: true });
    assert.match(output2, /^ok:/);
    const content2 = fs.readFileSync(bcPath, "utf-8");
    assert.notEqual(content2, originalContent);
    assert.match(content2, /project_type/);
  } finally {
    rm(dir);
  }
});

test("no manifest.yaml → minimal file (project_type generic, no boot_smoke)", () => {
  const dir = mkTmp();
  try {
    const output = runEmitBuildCommands(dir);
    assert.match(output, /no tech_stack/);

    const bcPath = path.join(dir, "build-commands.yaml");
    assert.ok(fs.existsSync(bcPath));
    const bc = loadYAML(bcPath);
    assert.equal(bc.project_type, "generic");
    assert.equal(bc.required_phases.length, 0);
    assert.ok(!bc.boot_smoke);
  } finally {
    rm(dir);
  }
});

test("boot_smoke regex extraction: captured value must be non-empty and quote-clean", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "typescript", role: "api_server", framework: "express" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const content = fs.readFileSync(bcPath, "utf-8");

    // Test the exact regex from manifest-validate.js
    const match = content.match(/^boot_smoke:\s*"?([^"\n]+?)"?\s*$/m);
    assert.ok(match, "boot_smoke line must match the regex");
    assert.ok(match[1], "captured group must be non-empty");
    assert.ok(!match[1].includes('"'), "captured value must not contain quotes");
    assert.equal(match[1].split("\n").length, 1, "must be single-line");
  } finally {
    rm(dir);
  }
});

test("empty tech_stack → minimal file, project_type generic", () => {
  const dir = mkTmp();
  try {
    const manifest = { tech_stack: [] };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    const output = runEmitBuildCommands(dir);
    assert.match(output, /no tech_stack/);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.equal(bc.project_type, "generic");
  } finally {
    rm(dir);
  }
});

test("required_phases includes only non-null phases", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [
        { language: "typescript", role: "web_ui", bundler: "vite" },
      ],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.ok(Array.isArray(bc.required_phases));
    assert.ok(bc.required_phases.includes("typecheck"));
    assert.ok(bc.required_phases.includes("build"));
    assert.ok(bc.required_phases.includes("boot_smoke"));
    assert.ok(!bc.required_phases.includes("test"), "test should not be in required_phases by definition");
  } finally {
    rm(dir);
  }
});

test("custom --port is substituted into boot_smoke command", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "typescript", role: "web_ui", bundler: "vite" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir, { port: 5000 });

    const bcPath = path.join(dir, "build-commands.yaml");
    const content = fs.readFileSync(bcPath, "utf-8");
    assert.match(content, /5000/);
  } finally {
    rm(dir);
  }
});

test("api_server fastify uses server.js endpoint", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "typescript", role: "api_server", framework: "fastify" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const content = fs.readFileSync(bcPath, "utf-8");
    const bootSmoke = extractBootSmoke(content);
    assert.ok(bootSmoke);
    assert.match(bootSmoke, /src\/server\/server\.js/);
  } finally {
    rm(dir);
  }
});

test("ssr_app next generates npx next build && start command", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "typescript", role: "ssr_app", framework: "next" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.ok(bc.boot_smoke);
    assert.match(bc.boot_smoke, /npx next build/);
    assert.match(bc.boot_smoke, /npx next start/);
  } finally {
    rm(dir);
  }
});

test("node project without specific bundler generates npm run build", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "typescript", role: "api_server" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.equal(bc.build, "npm run build");
  } finally {
    rm(dir);
  }
});

test("python project generates python -m compileall build command", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [{ language: "python", role: "cli" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.match(bc.build, /python -m compileall/);
  } finally {
    rm(dir);
  }
});

test("--output flag: writes to custom path", () => {
  const dir = mkTmp();
  try {
    const customPath = path.join(dir, "custom", "my-build-commands.yaml");
    const manifest = {
      tech_stack: [{ language: "typescript", role: "web_ui", bundler: "vite" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });

    runEmitBuildCommands(dir, { output: customPath });

    assert.ok(fs.existsSync(customPath));
    const bc = loadYAML(customPath);
    assert.equal(bc.project_type, "node");
  } finally {
    rm(dir);
  }
});

test("no runnable role → boot_smoke is null/omitted", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [
        { language: "python", role: "data_processor" }, // not a runnable role
      ],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.ok(!bc.boot_smoke);
    assert.ok(!bc.required_phases.includes("boot_smoke"));
  } finally {
    rm(dir);
  }
});

test("mixed python + javascript → python project_type not preferred (node wins)", () => {
  const dir = mkTmp();
  try {
    const manifest = {
      tech_stack: [
        { language: "python", role: "cli" },
        { language: "typescript", role: "web_ui", bundler: "vite" },
      ],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    runEmitBuildCommands(dir);

    const bcPath = path.join(dir, "build-commands.yaml");
    const bc = loadYAML(bcPath);
    assert.equal(bc.project_type, "node");
  } finally {
    rm(dir);
  }
});

test("--force flag preserves atomicity (no partial writes on error)", () => {
  const dir = mkTmp();
  try {
    const bcPath = path.join(dir, "build-commands.yaml");
    fs.writeFileSync(bcPath, "old: value\n", "utf-8");

    const manifest = {
      tech_stack: [{ language: "typescript", role: "web_ui", bundler: "vite" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.yaml"), yaml.dump(manifest), "utf-8");

    // Run with --force
    const output = runEmitBuildCommands(dir, { force: true });
    assert.match(output, /^ok:/);

    // Verify the new content is complete
    const bc = loadYAML(bcPath);
    assert.ok(bc.project_type);
    assert.ok(bc.required_phases);
  } finally {
    rm(dir);
  }
});
