#!/usr/bin/env node
/**
 * emulator-start.js — Reads manifest/infra-requirements.yaml and starts all
 * required infrastructure emulators: Firebase Emulator Suite, Docker containers
 * (Postgres, MySQL, Redis, MongoDB, DynamoDB, MinIO), and Supabase CLI.
 *
 * Usage:
 *   node emulator-start.js \
 *     --manifest-dir <dir> \
 *     --output-dir <dir>      # writes emulator/ports.json, emulator/pids.json
 *     [--shutdown]            # stop previously started emulators
 *     [--timeout <seconds>]   # health-check timeout per service (default: 60)
 *
 * Returns "ok" or "err:[description]"
 *
 * Port assignments (defaults, override via env):
 *   Postgres   5432   EMULATOR_PG_PORT
 *   MySQL      3306   EMULATOR_MYSQL_PORT
 *   Redis      6379   EMULATOR_REDIS_PORT
 *   MongoDB    27017  EMULATOR_MONGO_PORT
 *   DynamoDB   8000   EMULATOR_DYNAMO_PORT
 *   MinIO      9000   EMULATOR_MINIO_PORT
 *   Firebase   4000+  (auth:9099, firestore:8080, storage:9199, ui:4000)
 *   Supabase   54321  EMULATOR_SUPABASE_PORT
 */

const fs   = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { timeout: 60 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--output-dir":   parsed.outputDir   = args[++i]; break;
      case "--shutdown":     parsed.shutdown     = true;      break;
      case "--timeout":      parsed.timeout      = parseInt(args[++i], 10); break;
    }
  }
  return parsed;
}

// ── YAML reader (minimal — just reads key: value pairs) ──────────────────

function readYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Parse infra-requirements.yaml into a structured object.
 * We use a line-by-line approach to avoid a YAML dep.
 */
function parseInfraYaml(content) {
  const result = {
    framework:   { type: "unknown" },
    databases:   [],
    auth:        [],
    storage:     [],
    cache:       [],
    emulator_tools_required: { firebase: false, supabase_cli: false, docker: false },
  };

  let currentSection = null;
  let currentItem = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    // Top-level section headers
    if (/^framework:/.test(line)) { currentSection = "framework"; currentItem = null; continue; }
    if (/^databases:/.test(line)) { currentSection = "databases"; currentItem = null; continue; }
    if (/^auth:/.test(line))      { currentSection = "auth";      currentItem = null; continue; }
    if (/^storage:/.test(line))   { currentSection = "storage";   currentItem = null; continue; }
    if (/^cache:/.test(line))     { currentSection = "cache";     currentItem = null; continue; }
    if (/^emulator_tools_required:/.test(line)) { currentSection = "emulator_tools"; currentItem = null; continue; }
    if (/^env_vars_required:/.test(line)) { currentSection = null; continue; }

    const kv = line.match(/^\s{2}(\w+):\s*(.+)$/);
    const listItem = line.match(/^\s{2}-\s+(.*)$/);
    const nestedKv = line.match(/^\s{4}(\w+):\s*(.+)$/);

    if (currentSection === "framework" && kv) {
      const [, k, v] = kv;
      result.framework[k] = v.replace(/^["']|["']$/g, "");
    } else if (currentSection === "emulator_tools" && kv) {
      const [, k, v] = kv;
      result.emulator_tools_required[k] = v.trim() === "true";
    } else if (["databases", "auth", "storage", "cache"].includes(currentSection)) {
      if (listItem) {
        // inline: "  - type: postgres"
        const inlineKv = listItem[1].match(/^(\w+):\s*(.+)$/);
        if (inlineKv) {
          currentItem = { [inlineKv[1]]: inlineKv[2] };
          result[currentSection].push(currentItem);
        } else {
          currentItem = {};
          result[currentSection].push(currentItem);
        }
      } else if (nestedKv && currentItem) {
        const [, k, v] = nestedKv;
        currentItem[k] = v.replace(/^["']|["']$/g, "");
      }
    }
  }

  return result;
}

// ── Port helpers ──────────────────────────────────────────────────────────

const DEFAULT_PORTS = {
  postgres:  parseInt(process.env.EMULATOR_PG_PORT,       10) || 5432,
  mysql:     parseInt(process.env.EMULATOR_MYSQL_PORT,    10) || 3306,
  redis:     parseInt(process.env.EMULATOR_REDIS_PORT,    10) || 6379,
  mongodb:   parseInt(process.env.EMULATOR_MONGO_PORT,    10) || 27017,
  dynamodb:  parseInt(process.env.EMULATOR_DYNAMO_PORT,   10) || 8000,
  s3:        parseInt(process.env.EMULATOR_MINIO_PORT,    10) || 9000,
  supabase:  parseInt(process.env.EMULATOR_SUPABASE_PORT, 10) || 54321,
  // Firebase ports
  "firebase-ui":       4000,
  "firebase-auth":     9099,
  "firebase-firestore":8080,
  "firebase-storage":  9199,
  "firebase-hosting":  5000,
};

function isPortFree(port) {
  try {
    execSync(`node -e "const n=require('net');const s=n.createServer();s.listen(${port},()=>{ s.close(()=>process.exit(0)); });s.on('error',()=>process.exit(1));"`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── Health check helpers ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForPort(port, timeoutSec, label) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      execSync(
        `node -e "const n=require('net');const c=n.createConnection(${port},'127.0.0.1');c.on('connect',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1))"`,
        { timeout: 2000 }
      );
      return true; // connected
    } catch {
      await sleep(1500);
    }
  }
  return false;
}

// ── Tool availability ─────────────────────────────────────────────────────

function commandExists(cmd) {
  try { execSync(`which ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}

function dockerRunning() {
  try { execSync("docker info", { stdio: "ignore" }); return true; }
  catch { return false; }
}

// ── Config file generators ────────────────────────────────────────────────

/**
 * Write a minimal firebase.json if none exists.
 */
function ensureFirebaseJson(projectDir, components) {
  const fbJsonPath = path.join(projectDir, "firebase.json");
  if (fs.existsSync(fbJsonPath)) return;

  const emulators = {};
  if (components.includes("firebase-auth"))     emulators.auth      = { port: DEFAULT_PORTS["firebase-auth"] };
  if (components.includes("firestore"))         emulators.firestore  = { port: DEFAULT_PORTS["firebase-firestore"] };
  if (components.includes("firebase-storage"))  emulators.storage    = { port: DEFAULT_PORTS["firebase-storage"] };
  emulators.ui = { enabled: true, port: DEFAULT_PORTS["firebase-ui"] };

  const config = { emulators };
  fs.writeFileSync(fbJsonPath, JSON.stringify(config, null, 2));
}

/**
 * Write a .env.test with emulator connection strings.
 */
function writeEnvTest(outputDir, ports) {
  const lines = ["# Auto-generated by emulator-start.js — do not edit manually"];
  if (ports.postgres)  lines.push(`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${ports.postgres}/testdb`);
  if (ports.mysql)     lines.push(`DATABASE_URL=mysql://root:root@127.0.0.1:${ports.mysql}/testdb`);
  if (ports.redis)     lines.push(`REDIS_URL=redis://127.0.0.1:${ports.redis}`);
  if (ports.mongodb)   lines.push(`MONGODB_URI=mongodb://127.0.0.1:${ports.mongodb}/testdb`);
  if (ports.dynamodb)  lines.push(`DYNAMODB_ENDPOINT=http://127.0.0.1:${ports.dynamodb}`);
  if (ports.s3) {
    lines.push(`S3_ENDPOINT=http://127.0.0.1:${ports.s3}`);
    lines.push(`AWS_ACCESS_KEY_ID=minioadmin`);
    lines.push(`AWS_SECRET_ACCESS_KEY=minioadmin`);
  }
  if (ports["firebase-auth"])     lines.push(`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:${ports["firebase-auth"]}`);
  if (ports["firebase-firestore"]) lines.push(`FIRESTORE_EMULATOR_HOST=127.0.0.1:${ports["firebase-firestore"]}`);
  if (ports["firebase-storage"])  lines.push(`FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:${ports["firebase-storage"]}`);
  if (ports.supabase)             lines.push(`SUPABASE_URL=http://127.0.0.1:${ports.supabase}`);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, ".env.test"), lines.join("\n") + "\n");
}

// ── Docker helpers ────────────────────────────────────────────────────────

function dockerContainerName(type) {
  return `hpc-emulator-${type}`;
}

async function startDockerContainer(type, image, hostPort, containerPort, envVars, timeoutSec) {
  const name = dockerContainerName(type);

  // Kill any existing container with this name
  try { execSync(`docker rm -f ${name}`, { stdio: "ignore" }); } catch {}

  const envFlags = envVars.map(e => `-e ${e}`).join(" ");
  const cmd = `docker run -d --name ${name} -p ${hostPort}:${containerPort} ${envFlags} ${image}`;

  try {
    execSync(cmd, { stdio: "ignore" });
  } catch (e) {
    return { ok: false, error: `docker run failed for ${type}: ${e.message}` };
  }

  const ready = await waitForPort(hostPort, timeoutSec, type);
  if (!ready) {
    return { ok: false, error: `${type} container did not accept connections on port ${hostPort} within ${timeoutSec}s` };
  }
  return { ok: true };
}

async function stopDockerContainers(types) {
  for (const type of types) {
    const name = dockerContainerName(type);
    try { execSync(`docker rm -f ${name}`, { stdio: "ignore" }); } catch {}
  }
}

// ── Firebase helpers ──────────────────────────────────────────────────────

let firebaseProc = null;

async function startFirebaseEmulator(projectDir, components, timeoutSec) {
  ensureFirebaseJson(projectDir, components);

  // Use FIREBASE_EMULATOR_HUB for programmatic control
  const emulatorList = [];
  if (components.includes("firebase-auth"))    emulatorList.push("auth");
  if (components.includes("firestore"))        emulatorList.push("firestore");
  if (components.includes("firebase-storage")) emulatorList.push("storage");

  const only = emulatorList.length > 0 ? `--only ${emulatorList.join(",")}` : "";

  const logPath = path.join(projectDir, "emulator", "firebase-emulator.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");

  firebaseProc = spawn(
    "firebase",
    ["emulators:start", ...only.split(" ").filter(Boolean), "--project", "demo-hpc"],
    {
      cwd: projectDir,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    }
  );

  firebaseProc.on("error", (err) => {
    fs.appendFileSync(logPath, `\n[emulator-start.js] Firebase spawn error: ${err.message}\n`);
  });

  // Detach fully so the open child handle/fd cannot keep this process alive;
  // shutdown is handled via pids.json, not this process object.
  firebaseProc.unref();
  try { fs.closeSync(logFd); } catch {}

  // Wait for firestore/auth/storage ports
  const portsToCheck = [];
  if (components.includes("firebase-auth"))    portsToCheck.push(DEFAULT_PORTS["firebase-auth"]);
  if (components.includes("firestore"))        portsToCheck.push(DEFAULT_PORTS["firebase-firestore"]);
  if (components.includes("firebase-storage")) portsToCheck.push(DEFAULT_PORTS["firebase-storage"]);

  for (const port of portsToCheck) {
    const ready = await waitForPort(port, timeoutSec, `firebase:${port}`);
    if (!ready) {
      firebaseProc.kill();
      return { ok: false, error: `Firebase emulator did not start on port ${port} within ${timeoutSec}s` };
    }
  }

  return { ok: true, pid: firebaseProc.pid };
}

function stopFirebaseEmulator() {
  if (firebaseProc) {
    try { firebaseProc.kill("SIGTERM"); } catch {}
    firebaseProc = null;
  }
  // Also try killing by name (in case we didn't spawn it this session)
  try { execSync("pkill -f 'firebase emulators:start'", { stdio: "ignore" }); } catch {}
}

// ── Supabase helpers ──────────────────────────────────────────────────────

let supabaseStarted = false;

async function startSupabase(projectDir, timeoutSec) {
  // Supabase CLI requires `supabase init` to have been run
  const supabaseDir = path.join(projectDir, "supabase");
  if (!fs.existsSync(supabaseDir)) {
    try { execSync("supabase init", { cwd: projectDir, stdio: "ignore" }); } catch {}
  }

  try {
    execSync("supabase start", { cwd: projectDir, stdio: "ignore", timeout: timeoutSec * 1000 });
    supabaseStarted = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `supabase start failed: ${e.message.slice(0, 200)}` };
  }
}

async function stopSupabase(projectDir) {
  try { execSync("supabase stop", { cwd: projectDir, stdio: "ignore", timeout: 30000 }); } catch {}
  supabaseStarted = false;
}

// ── PID/port registry ─────────────────────────────────────────────────────

function writePidRegistry(outputDir, pids) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "pids.json"), JSON.stringify(pids, null, 2));
}

function readPidRegistry(outputDir) {
  const p = path.join(outputDir, "pids.json");
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return {}; }
}

function writePortRegistry(outputDir, ports) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "ports.json"), JSON.stringify(ports, null, 2));
}

// ── Shutdown mode ─────────────────────────────────────────────────────────

async function shutdown(outputDir, projectDir) {
  const pids = readPidRegistry(outputDir);

  // Kill registered PIDs
  for (const [service, pid] of Object.entries(pids)) {
    if (pid && typeof pid === "number") {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }

  // Stop Docker containers (standard set)
  await stopDockerContainers(["postgres", "mysql", "redis", "mongodb", "dynamodb", "s3"]);

  // Stop Firebase
  stopFirebaseEmulator();

  // Stop Supabase
  if (projectDir) await stopSupabase(projectDir);

  // Clean up files
  try { fs.unlinkSync(path.join(outputDir, "pids.json")); } catch {}
  try { fs.unlinkSync(path.join(outputDir, "ports.json")); } catch {}
  try { fs.unlinkSync(path.join(outputDir, ".env.test")); } catch {}

  console.log("ok:shutdown_complete");
}

// ── Docker image definitions ──────────────────────────────────────────────

const DOCKER_SERVICES = {
  postgres: {
    image: "postgres:15",
    containerPort: 5432,
    envVars: ["POSTGRES_PASSWORD=postgres", "POSTGRES_DB=testdb"],
  },
  mysql: {
    image: "mysql:8",
    containerPort: 3306,
    envVars: ["MYSQL_ROOT_PASSWORD=root", "MYSQL_DATABASE=testdb"],
  },
  redis: {
    image: "redis:7-alpine",
    containerPort: 6379,
    envVars: [],
  },
  mongodb: {
    image: "mongo:7",
    containerPort: 27017,
    envVars: [],
  },
  dynamodb: {
    image: "amazon/dynamodb-local:latest",
    containerPort: 8000,
    envVars: [],
  },
  s3: {
    image: "minio/minio:latest",
    containerPort: 9000,
    envVars: ["MINIO_ROOT_USER=minioadmin", "MINIO_ROOT_PASSWORD=minioadmin"],
  },
};

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!args.outputDir) {
    console.log("err:usage: node emulator-start.js --manifest-dir <dir> --output-dir <dir> [--shutdown] [--timeout <sec>]");
    process.exit(0);
  }

  const emulatorDir = path.join(args.outputDir, "emulator");

  if (args.shutdown) {
    await shutdown(emulatorDir, args.manifestDir ? path.dirname(args.manifestDir) : process.cwd());
    return;
  }

  if (!args.manifestDir) {
    console.log("err:usage: --manifest-dir is required unless --shutdown");
    process.exit(0);
  }

  const infraPath = path.join(args.manifestDir, "infra-requirements.yaml");
  const infraContent = readYaml(infraPath);
  if (!infraContent) {
    console.log(`err:infra_not_found: ${infraPath} — run detect-infra.js first`);
    process.exit(0);
  }

  const infra = parseInfraYaml(infraContent);
  const { emulator_tools_required: tools } = infra;

  const ports = {};
  const pids  = {};
  const started = [];
  const failed  = [];

  // ── Docker services ───────────────────────────────────────────────────

  if (tools.docker) {
    if (!commandExists("docker")) {
      console.log("err:docker_not_found: docker is required but not installed");
      process.exit(0);
    }
    if (!dockerRunning()) {
      console.log("err:docker_not_running: Docker daemon is not running — start Docker Desktop and retry");
      process.exit(0);
    }

    // Databases
    for (const db of infra.databases) {
      if (db.strategy !== "docker") continue;
      const svc = DOCKER_SERVICES[db.type];
      if (!svc) continue;
      const hostPort = DEFAULT_PORTS[db.type];
      const result = await startDockerContainer(
        db.type, svc.image, hostPort, svc.containerPort, svc.envVars, args.timeout
      );
      if (result.ok) {
        ports[db.type] = hostPort;
        started.push(db.type);
      } else {
        failed.push(result.error);
      }
    }

    // Cache (Redis)
    for (const c of infra.cache) {
      if (c.strategy !== "docker") continue;
      const svc = DOCKER_SERVICES[c.type];
      if (!svc) continue;
      const hostPort = DEFAULT_PORTS[c.type];
      const result = await startDockerContainer(
        c.type, svc.image, hostPort, svc.containerPort, svc.envVars, args.timeout
      );
      if (result.ok) {
        ports[c.type] = hostPort;
        started.push(c.type);
      } else {
        failed.push(result.error);
      }
    }

    // Storage (MinIO for S3)
    for (const s of infra.storage) {
      if (s.strategy !== "docker") continue;
      const svc = DOCKER_SERVICES[s.type];
      if (!svc) continue;
      const hostPort = DEFAULT_PORTS[s.type] || DEFAULT_PORTS["s3"];
      const result = await startDockerContainer(
        s.type, svc.image, hostPort, svc.containerPort, svc.envVars, args.timeout
      );
      if (result.ok) {
        ports[s.type] = hostPort;
        started.push(s.type);
      } else {
        failed.push(result.error);
      }
    }
  }

  // ── Firebase ──────────────────────────────────────────────────────────

  if (tools.firebase) {
    if (!commandExists("firebase")) {
      console.log("err:firebase_not_found: firebase-tools is required — run: npm install -g firebase-tools");
      process.exit(0);
    }

    const firebaseComponents = [
      ...infra.databases.filter(d => d.strategy === "firebase-emulator").map(d => d.type),
      ...infra.auth.filter(a => a.strategy === "firebase-emulator").map(a => a.type),
      ...infra.storage.filter(s => s.strategy === "firebase-emulator").map(s => s.type),
    ];

    const projectDir = path.resolve(args.outputDir, "..");
    const result = await startFirebaseEmulator(projectDir, firebaseComponents, args.timeout);

    if (result.ok) {
      if (firebaseComponents.includes("firebase-auth"))    ports["firebase-auth"]      = DEFAULT_PORTS["firebase-auth"];
      if (firebaseComponents.includes("firestore"))        ports["firebase-firestore"]  = DEFAULT_PORTS["firebase-firestore"];
      if (firebaseComponents.includes("firebase-storage")) ports["firebase-storage"]    = DEFAULT_PORTS["firebase-storage"];
      ports["firebase-ui"] = DEFAULT_PORTS["firebase-ui"];
      pids.firebase = result.pid;
      started.push("firebase");
    } else {
      failed.push(result.error);
    }
  }

  // ── Supabase ──────────────────────────────────────────────────────────

  if (tools.supabase_cli) {
    if (!commandExists("supabase")) {
      console.log("err:supabase_not_found: supabase CLI is required — run: npm install -g supabase");
      process.exit(0);
    }

    const projectDir = path.resolve(args.outputDir, "..");
    const result = await startSupabase(projectDir, args.timeout);

    if (result.ok) {
      ports.supabase = DEFAULT_PORTS.supabase;
      started.push("supabase");
    } else {
      failed.push(result.error);
    }
  }

  // ── Write outputs ─────────────────────────────────────────────────────

  fs.mkdirSync(emulatorDir, { recursive: true });
  writePortRegistry(emulatorDir, ports);
  writePidRegistry(emulatorDir,  pids);
  writeEnvTest(emulatorDir, ports);

  if (failed.length > 0) {
    // Partial failure — report the first failure
    console.log(`err:emulator_failed:${failed[0]}`);
    process.exit(0);
  }

  const summary = started.length > 0 ? started.join(",") : "none";
  console.log(`ok:started=${summary}`);
  process.exit(0);
}

main().catch(err => {
  console.log(`err:unexpected:${err.message}`);
  process.exit(0);
});
