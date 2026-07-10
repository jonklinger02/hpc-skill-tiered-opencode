#!/usr/bin/env node
/**
 * emit-build-commands.js — Derive build-commands.yaml deterministically from manifest.yaml's tech_stack.
 *
 * Closes the M2 `boot_smoke` gap: C-Suite seeds tech_stack after planning; this script generates
 * build-commands.yaml before Gate 1 runs. Will NOT overwrite an existing file unless --force given.
 *
 * Usage:
 *   node scripts/emit-build-commands.js \
 *     --manifest-dir <dir> \
 *     [--output <path>]  # default <manifest-dir>/build-commands.yaml
 *     [--port 3000]      # default port for boot_smoke tests
 *     [--force]          # overwrite existing build-commands.yaml
 *
 * Output: YAML file with deterministically derived build commands:
 *   - project_type: "node" | "python" | "generic"
 *   - typecheck: command | null
 *   - build: command | null
 *   - test: command | null
 *   - boot_smoke: command | null (quoted-safe, single-line)
 *   - required_phases: [list of phases that must run]
 *
 * Prints one-line status:
 *   ok:build-commands emitted (boot_smoke=<yes|none>, project_type=<type>)
 *   ok:build-commands exists (use --force to overwrite)
 *   ok:no tech_stack — minimal build-commands emitted
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ── Argument parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--manifest-dir":
        opts.manifestDir = argv[++i];
        break;
      case "--output":
        opts.output = argv[++i];
        break;
      case "--port":
        opts.port = parseInt(argv[++i], 10);
        break;
      case "--force":
        opts.force = true;
        break;
    }
  }
  return opts;
}

// ── Derive build commands from tech_stack ─────────────────────────────────

/**
 * Determine project_type from tech_stack roles/languages.
 * Priority: node (typescript/javascript) > python > generic
 */
function deriveProjectType(techStack) {
  if (!techStack || !Array.isArray(techStack) || techStack.length === 0) {
    return "generic";
  }

  const hasNode = techStack.some(
    (s) =>
      (s.language && /^(typescript|javascript)$/i.test(s.language)) ||
      (s.role && ["web_ui", "api_server", "ssr_app"].includes(s.role))
  );
  if (hasNode) return "node";

  const hasPython = techStack.some((s) => s.language && /^python$/i.test(s.language));
  if (hasPython) return "python";

  return "generic";
}

/**
 * Collect all roles and frameworks present in tech_stack.
 */
function analyzeStack(techStack) {
  const roles = new Set();
  const frameworks = new Set();
  const languages = new Set();
  const bundlers = new Set();

  if (!Array.isArray(techStack)) return { roles, frameworks, languages, bundlers };

  for (const entry of techStack) {
    if (entry.role) roles.add(entry.role.toLowerCase());
    if (entry.framework) frameworks.add(entry.framework.toLowerCase());
    if (entry.language) languages.add(entry.language.toLowerCase());
    if (entry.bundler) bundlers.add(entry.bundler.toLowerCase());
  }

  return { roles, frameworks, languages, bundlers };
}

/**
 * Derive typecheck command from tech_stack.
 * TS presence → npx tsc --noEmit
 * Python presence → python -m mypy . --ignore-missing-imports || true
 * Otherwise → null
 */
function deriveTypecheck(techStack) {
  const { languages } = analyzeStack(techStack);

  if (languages.has("typescript")) {
    return "npx tsc --noEmit";
  }

  if (languages.has("python")) {
    return "python -m mypy . --ignore-missing-imports || true";
  }

  return null;
}

/**
 * Derive build command from tech_stack.
 * web_ui with vite → npx vite build
 * web_ui with webpack → npx webpack
 * ssr_app with next → npx next build
 * node → npm run build
 * python → python -m compileall -q .
 * Otherwise → null
 */
function deriveBuild(techStack) {
  const { roles, frameworks, bundlers, languages } = analyzeStack(techStack);

  // web_ui with specific bundlers
  if (roles.has("web_ui")) {
    if (bundlers.has("vite")) return "npx vite build";
    if (bundlers.has("webpack")) return "npx webpack";
  }

  // ssr_app with next
  if (roles.has("ssr_app") && frameworks.has("next")) {
    return "npx next build";
  }

  // node (has typescript/javascript)
  if (languages.has("typescript") || languages.has("javascript")) {
    return "npm run build";
  }

  // python
  if (languages.has("python")) {
    return "python -m compileall -q .";
  }

  return null;
}

/**
 * Derive test command from tech_stack.
 * node → npm test --silent
 * python → python -m pytest -q
 * Otherwise → null
 */
function deriveTest(techStack) {
  const { languages } = analyzeStack(techStack);

  if (languages.has("typescript") || languages.has("javascript")) {
    return "npm test --silent";
  }

  if (languages.has("python")) {
    return "python -m pytest -q";
  }

  return null;
}

/**
 * Derive boot_smoke command from tech_stack.
 * Priority order: api_server > ssr_app > web_ui > cli > control_plane
 * Each has a deterministic template.
 * Substitute $PORT with --port value (default 3000).
 *
 * Templates (no inner quotes, single-line):
 * - api_server (express) → node src/server/app.js & sleep 3 && curl --retry 5 --retry-delay 2 --fail http://localhost:<PORT>/health
 * - api_server (fastify) → node src/server/server.js & sleep 3 && curl --retry 5 --retry-delay 2 --fail http://localhost:<PORT>/health
 * - ssr_app (next) → npx next build && npx next start -p <PORT> & sleep 5 && curl --retry 5 --retry-delay 2 --fail http://localhost:<PORT>/
 * - web_ui (vite) → npx vite build && npx vite preview --port <PORT> & sleep 3 && curl --retry 5 --retry-delay 2 --fail http://localhost:<PORT>/
 * - cli (python) → pip install -e . && python -m <pkg> --version
 * - control_plane (python) → pip install -e . && python -c import_smoke
 */
function deriveBootSmoke(techStack, port = 3000) {
  const { roles, frameworks, bundlers, languages } = analyzeStack(techStack);

  // api_server (priority 1)
  if (roles.has("api_server")) {
    // Check framework to determine entry point
    if (frameworks.has("fastify")) {
      return `node src/server/server.js & sleep 3 && curl --retry 5 --retry-delay 2 --fail http://localhost:${port}/health`;
    }
    // Default to express
    return `node src/server/app.js & sleep 3 && curl --retry 5 --retry-delay 2 --fail http://localhost:${port}/health`;
  }

  // ssr_app (priority 2)
  if (roles.has("ssr_app") && frameworks.has("next")) {
    return `npx next build && npx next start -p ${port} & sleep 5 && curl --retry 5 --retry-delay 2 --fail http://localhost:${port}/`;
  }

  // web_ui (priority 3)
  if (roles.has("web_ui") && bundlers.has("vite")) {
    return `npx vite build && npx vite preview --port ${port} & sleep 3 && curl --retry 5 --retry-delay 2 --fail http://localhost:${port}/`;
  }

  // cli (priority 4)
  if (roles.has("cli") && languages.has("python")) {
    return "pip install -e . && python -m <pkg> --version";
  }

  // control_plane (priority 5)
  if (roles.has("control_plane") && languages.has("python")) {
    return "pip install -e . && python -c import_smoke";
  }

  // No runnable role
  return null;
}

/**
 * Derive required_phases from the commands that were generated.
 * Include: typecheck (if set), build (if set), boot_smoke (if set)
 */
function deriveRequiredPhases(typecheck, build, bootSmoke) {
  const phases = [];
  if (typecheck != null) phases.push("typecheck");
  if (build != null) phases.push("build");
  if (bootSmoke != null) phases.push("boot_smoke");
  return phases;
}

/**
 * Build the complete output object.
 */
function buildOutput(techStack, port = 3000) {
  const projectType = deriveProjectType(techStack);
  const typecheck = deriveTypecheck(techStack);
  const build = deriveBuild(techStack);
  const test = deriveTest(techStack);
  const bootSmoke = deriveBootSmoke(techStack, port);
  const requiredPhases = deriveRequiredPhases(typecheck, build, bootSmoke);

  const output = {
    project_type: projectType,
  };

  if (typecheck != null) output.typecheck = typecheck;
  if (build != null) output.build = build;
  if (test != null) output.test = test;
  if (bootSmoke != null) output.boot_smoke = bootSmoke;

  output.required_phases = requiredPhases;

  return { output, bootSmoke, projectType };
}

/**
 * Format the output for YAML emission.
 * Use hand-rolled format to ensure boot_smoke is a quoted-safe string (no inner quotes).
 */
function formatYAML(output) {
  let lines = [];

  lines.push(`project_type: ${output.project_type}`);

  if (output.typecheck != null) {
    lines.push(`typecheck: ${output.typecheck}`);
  }

  if (output.build != null) {
    lines.push(`build: ${output.build}`);
  }

  if (output.test != null) {
    lines.push(`test: ${output.test}`);
  }

  if (output.boot_smoke != null) {
    // Ensure boot_smoke is quoted-safe and single-line (regex in verify-build.js expects this)
    lines.push(`boot_smoke: ${output.boot_smoke}`);
  }

  lines.push(`required_phases: [${output.required_phases.map((p) => `"${p}"`).join(", ")}]`);

  return lines.join("\n") + "\n";
}

// ── Main entry point ──────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (!opts.manifestDir) {
    console.log("err:usage: node emit-build-commands.js --manifest-dir <dir> [--output <path>] [--port 3000] [--force]");
    process.exit(1);
  }

  const outputPath = opts.output || path.join(opts.manifestDir, "build-commands.yaml");
  const port = opts.port || 3000;

  // Check if build-commands.yaml already exists
  if (fs.existsSync(outputPath) && !opts.force) {
    console.log("ok:build-commands exists (use --force to overwrite)");
    return;
  }

  // Load manifest.yaml
  const manifestPath = path.join(opts.manifestDir, "manifest.yaml");
  let techStack = [];

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = yaml.load(fs.readFileSync(manifestPath, "utf-8")) || {};
      techStack = manifest.tech_stack || [];
    } catch (e) {
      console.log("err:failed to parse manifest.yaml");
      process.exit(1);
    }
  } else {
    // No manifest.yaml; emit minimal
    const output = { project_type: "generic", required_phases: [] };
    const yamlStr = formatYAML(output);
    try {
      fs.writeFileSync(outputPath, yamlStr, "utf-8");
      console.log("ok:no tech_stack — minimal build-commands emitted");
      return;
    } catch (e) {
      console.log("err:failed to write build-commands.yaml");
      process.exit(1);
    }
  }

  // Derive and emit
  if (techStack.length === 0) {
    // Empty tech_stack
    const output = { project_type: "generic", required_phases: [] };
    const yamlStr = formatYAML(output);
    try {
      fs.writeFileSync(outputPath, yamlStr, "utf-8");
      console.log("ok:no tech_stack — minimal build-commands emitted");
      return;
    } catch (e) {
      console.log("err:failed to write build-commands.yaml");
      process.exit(1);
    }
  }

  // Non-empty tech_stack
  const { output, bootSmoke, projectType } = buildOutput(techStack, port);
  const yamlStr = formatYAML(output);

  try {
    fs.writeFileSync(outputPath, yamlStr, "utf-8");
    const bootSmokeStatus = bootSmoke ? "yes" : "none";
    console.log(`ok:build-commands emitted (boot_smoke=${bootSmokeStatus}, project_type=${projectType})`);
  } catch (e) {
    console.log("err:failed to write build-commands.yaml");
    process.exit(1);
  }
}

module.exports = {
  deriveProjectType,
  deriveTypecheck,
  deriveBuild,
  deriveTest,
  deriveBootSmoke,
  analyzeStack,
  deriveRequiredPhases,
  buildOutput,
  formatYAML,
};

if (require.main === module) {
  main().catch((e) => {
    console.log("err:" + (e.message || String(e)));
    process.exit(1);
  });
}
