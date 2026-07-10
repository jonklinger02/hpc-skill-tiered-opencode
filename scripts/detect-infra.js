#!/usr/bin/env node
/**
 * detect-infra.js — Reads manifest/architecture.yaml and input docs to identify
 * what infrastructure the built application requires at runtime, and which
 * emulation strategy HPC should use for each component.
 *
 * Usage:
 *   node detect-infra.js \
 *     --manifest-dir <dir> \
 *     --input-docs <dir> \
 *     --output <path-to-infra-requirements.yaml>
 *
 * Returns "ok" or "err:[description]"
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir":  parsed.manifestDir = args[++i]; break;
      case "--input-docs":    parsed.inputDocs = args[++i]; break;
      case "--output":        parsed.output = args[++i]; break;
    }
  }
  return parsed;
}

// ── Heuristic detection helpers ───────────────────────────────────────────

const DB_PATTERNS = [
  { regex: /postgres|postgresql|pg\b/i,         type: "postgres",   strategy: "docker", image: "postgres:15" },
  { regex: /mysql\b/i,                           type: "mysql",      strategy: "docker", image: "mysql:8" },
  { regex: /sqlite\b/i,                          type: "sqlite",     strategy: "none" },
  { regex: /firestore|firebase.*database/i,      type: "firestore",  strategy: "firebase-emulator" },
  { regex: /supabase/i,                          type: "supabase",   strategy: "supabase-cli" },
  { regex: /mongodb|mongo\b/i,                   type: "mongodb",    strategy: "docker", image: "mongo:7" },
  { regex: /redis\b/i,                           type: "redis",      strategy: "docker", image: "redis:7-alpine" },
  { regex: /dynamodb/i,                          type: "dynamodb",   strategy: "docker", image: "amazon/dynamodb-local:latest" },
];

const AUTH_PATTERNS = [
  { regex: /firebase.*auth|auth.*firebase/i,     type: "firebase-auth",  strategy: "firebase-emulator" },
  { regex: /supabase.*auth|auth.*supabase/i,     type: "supabase-auth",  strategy: "supabase-cli" },
  { regex: /next[-_]auth|nextauth/i,             type: "nextauth",       strategy: "none" },
  { regex: /jwt\b/i,                             type: "jwt",            strategy: "none" },
  { regex: /oauth\b/i,                           type: "oauth",          strategy: "none" },
  { regex: /auth0\b/i,                           type: "auth0",          strategy: "none" },
  { regex: /clerk\b/i,                           type: "clerk",          strategy: "none" },
];

const STORAGE_PATTERNS = [
  { regex: /firebase.*storage|storage.*firebase/i, type: "firebase-storage", strategy: "firebase-emulator" },
  { regex: /supabase.*storage|storage.*supabase/i, type: "supabase-storage",  strategy: "supabase-cli" },
  { regex: /s3\b|aws.*s3/i,                        type: "s3",                strategy: "docker", image: "minio/minio:latest" },
];

const FRAMEWORK_PATTERNS = [
  { regex: /next\.js|nextjs|"next"\s*:/i,  type: "nextjs",      serve: "next dev",      build: "next build", test: "jest" },
  { regex: /nuxt\b/i,                      type: "nuxt",        serve: "nuxt dev",      build: "nuxt build", test: "vitest" },
  { regex: /sveltekit|svelte.*kit/i,       type: "sveltekit",   serve: "vite dev",      build: "vite build", test: "vitest" },
  { regex: /vite\b/i,                      type: "vite",        serve: "vite preview",  build: "vite build", test: "vitest" },
  { regex: /express\b/i,                   type: "express",     serve: "node src/index.js", build: "tsc", test: "jest" },
  { regex: /fastify\b/i,                   type: "fastify",     serve: "node src/index.js", build: "tsc", test: "jest" },
  { regex: /remix\b/i,                     type: "remix",       serve: "remix dev",     build: "remix build", test: "vitest" },
];

const ENV_VAR_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /\$\{([A-Z][A-Z0-9_]+)\}/g,
  /env:\s*([A-Z][A-Z0-9_]+)/g,
];

/**
 * Read all text files in a directory (non-recursive, .md / .yaml / .json / .ts / .js).
 */
function readTextFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return "";
  const exts = new Set([".md", ".yaml", ".yml", ".json", ".ts", ".js", ".txt"]);
  return fs.readdirSync(dir)
    .filter(f => exts.has(path.extname(f).toLowerCase()))
    .map(f => {
      try { return fs.readFileSync(path.join(dir, f), "utf-8"); }
      catch { return ""; }
    })
    .join("\n");
}

function detectAll(corpus) {
  const results = {
    databases: [],
    auth: [],
    storage: [],
    cache: [],
    framework: null,
    env_vars: [],
  };

  // Databases
  for (const p of DB_PATTERNS) {
    if (p.regex.test(corpus)) {
      if (p.type === "redis") {
        results.cache.push({ type: p.type, strategy: p.strategy, image: p.image });
      } else {
        results.databases.push({ type: p.type, strategy: p.strategy, ...(p.image ? { image: p.image } : {}) });
      }
    }
  }

  // Auth
  for (const p of AUTH_PATTERNS) {
    if (p.regex.test(corpus)) {
      results.auth.push({ type: p.type, strategy: p.strategy });
      break; // Take the first match — most projects have one auth system
    }
  }

  // Storage
  for (const p of STORAGE_PATTERNS) {
    if (p.regex.test(corpus)) {
      results.storage.push({ type: p.type, strategy: p.strategy, ...(p.image ? { image: p.image } : {}) });
    }
  }

  // Framework
  for (const p of FRAMEWORK_PATTERNS) {
    if (p.regex.test(corpus)) {
      results.framework = { type: p.type, serve: p.serve, build: p.build, test: p.test };
      break;
    }
  }

  // Environment variables — extract unique names
  const envVarSet = new Set();
  for (const pattern of ENV_VAR_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(corpus)) !== null) {
      const name = m[1];
      // Filter out common non-config env vars
      if (!["NODE_ENV", "NODE_PATH", "PATH", "HOME", "USER", "SHELL"].includes(name)) {
        envVarSet.add(name);
      }
    }
  }
  results.env_vars = [...envVarSet].sort();

  return results;
}

/**
 * Determine if any detected component needs Firebase emulator.
 */
function needsFirebase(detected) {
  return (
    detected.databases.some(d => d.strategy === "firebase-emulator") ||
    detected.auth.some(a => a.strategy === "firebase-emulator") ||
    detected.storage.some(s => s.strategy === "firebase-emulator")
  );
}

/**
 * Determine if any detected component needs Supabase CLI.
 */
function needsSupabase(detected) {
  return (
    detected.databases.some(d => d.strategy === "supabase-cli") ||
    detected.auth.some(a => a.strategy === "supabase-cli") ||
    detected.storage.some(s => s.strategy === "supabase-cli")
  );
}

/**
 * Determine if any detected component needs Docker.
 */
function needsDocker(detected) {
  const all = [...detected.databases, ...detected.storage, ...detected.cache];
  return all.some(c => c.strategy === "docker");
}

/**
 * Build the YAML string for infra-requirements.yaml.
 */
function buildYaml(detected) {
  const lines = ["# Auto-generated by detect-infra.js — do not edit manually", ""];

  lines.push("framework:");
  if (detected.framework) {
    lines.push(`  type: ${detected.framework.type}`);
    lines.push(`  serve_command: "${detected.framework.serve}"`);
    lines.push(`  build_command: "${detected.framework.build}"`);
    lines.push(`  test_command: "${detected.framework.test}"`);
  } else {
    lines.push("  type: unknown");
    lines.push("  serve_command: null");
    lines.push("  build_command: \"npm run build\"");
    lines.push("  test_command: \"npm test\"");
  }
  lines.push("");

  lines.push("databases:");
  if (detected.databases.length === 0) {
    lines.push("  []");
  } else {
    for (const db of detected.databases) {
      lines.push(`  - type: ${db.type}`);
      lines.push(`    strategy: ${db.strategy}`);
      if (db.image) lines.push(`    docker_image: ${db.image}`);
      if (db.strategy === "docker") {
        lines.push(`    docker_port: ${db.type === "postgres" ? 5432 : db.type === "mysql" ? 3306 : db.type === "mongodb" ? 27017 : 27017}`);
        lines.push(`    env_var: DATABASE_URL`);
      }
    }
  }
  lines.push("");

  lines.push("auth:");
  if (detected.auth.length === 0) {
    lines.push("  []");
  } else {
    for (const a of detected.auth) {
      lines.push(`  - type: ${a.type}`);
      lines.push(`    strategy: ${a.strategy}`);
    }
  }
  lines.push("");

  lines.push("storage:");
  if (detected.storage.length === 0) {
    lines.push("  []");
  } else {
    for (const s of detected.storage) {
      lines.push(`  - type: ${s.type}`);
      lines.push(`    strategy: ${s.strategy}`);
      if (s.image) lines.push(`    docker_image: ${s.image}`);
    }
  }
  lines.push("");

  lines.push("cache:");
  if (detected.cache.length === 0) {
    lines.push("  []");
  } else {
    for (const c of detected.cache) {
      lines.push(`  - type: ${c.type}`);
      lines.push(`    strategy: ${c.strategy}`);
      if (c.image) lines.push(`    docker_image: ${c.image}`);
    }
  }
  lines.push("");

  lines.push("emulator_tools_required:");
  lines.push(`  firebase: ${needsFirebase(detected)}`);
  lines.push(`  supabase_cli: ${needsSupabase(detected)}`);
  lines.push(`  docker: ${needsDocker(detected)}`);
  lines.push("");

  lines.push("env_vars_required:");
  if (detected.env_vars.length === 0) {
    lines.push("  []");
  } else {
    for (const v of detected.env_vars) {
      lines.push(`  - ${v}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();
  if (!args.manifestDir || !args.output) {
    console.log("err:usage: node detect-infra.js --manifest-dir <dir> --input-docs <dir> --output <file>");
    process.exit(0);
  }

  // Collect corpus: architecture.yaml + all input docs
  const corpusParts = [];
  const archFile = path.join(args.manifestDir, "architecture.yaml");
  if (fs.existsSync(archFile)) corpusParts.push(fs.readFileSync(archFile, "utf-8"));
  corpusParts.push(readTextFiles(args.inputDocs));
  const corpus = corpusParts.join("\n");

  if (!corpus.trim()) {
    console.log("err:no_corpus: provide --manifest-dir with architecture.yaml or --input-docs");
    process.exit(0);
  }

  const detected = detectAll(corpus);
  const yaml = buildYaml(detected);

  const outDir = path.dirname(args.output);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.output, yaml);

  const summary = [
    detected.framework ? detected.framework.type : "unknown-framework",
    ...(detected.databases.map(d => d.type)),
    ...(detected.auth.map(a => a.type)),
    ...(detected.cache.map(c => c.type)),
  ].join(",");
  console.log(`ok:detected=${summary}`);
}

main();
