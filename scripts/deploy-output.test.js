"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEPLOY = path.resolve(__dirname, "deploy-output.js");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-deploy-")); }
function write(p, c) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
function read(p) { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }
function run(args) {
  try { return execFileSync("node", [DEPLOY, ...args], { encoding: "utf-8" }).trim(); }
  catch (e) { return ((e.stdout || "") + (e.stderr || "")).trim(); }
}

// A workspace fixture: hpc-workspace/{output,manifest}. Returns paths.
function fixture(stack) {
  const base = tmp();
  const ws = path.join(base, "hpc-workspace");
  const out = path.join(ws, "output");
  const man = path.join(ws, "manifest");
  write(path.join(man, "manifest.yaml"), `name: Demo\ntech_stack:\n${stack}`);
  return { base, ws, out, man, registry: path.join(base, "registry.json") };
}

test("deploy resolves a project, lands files at the canonical root, records the build", () => {
  const f = fixture("  - {language: typescript, role: ssr_app, framework: nextjs}\n");
  write(path.join(f.out, "app/page.tsx"), "export default () => null;\n");
  write(path.join(f.out, "components/Button.tsx"), "export const Button = () => null;\n");
  const target = path.join(f.base, "project");
  const out = run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B1"]);
  assert.match(out, /ok:deployed=2,skipped=0,conflicts=0/);
  assert.ok(read(path.join(target, "app/page.tsx")), "file landed at canonical root");
  // project.json written + build recorded
  const proj = JSON.parse(read(path.join(target, ".hpc/project.json")));
  assert.strictEqual(proj.structure_profile, "nextjs-app");
  assert.strictEqual(proj.builds.length, 1);
  assert.strictEqual(proj.builds[0].build_id, "B1");
  assert.deepStrictEqual(proj.builds[0].deployed_files.sort(), ["app/page.tsx", "components/Button.tsx"]);
  // .gitignore excludes .hpc/
  assert.match(read(path.join(target, ".gitignore")) || "", /\.hpc\//);
});

test("re-deploying identical content is idempotent (all skipped:unchanged)", () => {
  const f = fixture("  - {language: typescript, role: api_server, framework: express}\n");
  write(path.join(f.out, "src/routes/users.ts"), "export const r = 1;\n");
  const target = path.join(f.base, "project");
  run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B1"]);
  const out2 = run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B1"]);
  assert.match(out2, /ok:deployed=0,skipped=1,conflicts=0/);
});

test("a second build into the SAME project extends the tree and reuses identity (un-silo)", () => {
  const f = fixture("  - {language: typescript, role: api_server, framework: express}\n");
  const target = path.join(f.base, "project");
  write(path.join(f.out, "src/routes/users.ts"), "export const u = 1;\n");
  run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B1"]);
  // second build adds a new file
  fs.rmSync(path.join(f.out, "src/routes/users.ts"));
  write(path.join(f.out, "src/routes/orders.ts"), "export const o = 1;\n");
  const out = run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B2"]);
  assert.match(out, /ok:deployed=1/);
  // both files coexist; one project, two builds
  assert.ok(read(path.join(target, "src/routes/users.ts")), "build-1 file still present");
  assert.ok(read(path.join(target, "src/routes/orders.ts")), "build-2 file added");
  const proj = JSON.parse(read(path.join(target, ".hpc/project.json")));
  assert.strictEqual(proj.builds.length, 2);
});

test("cross-build overwrite of another build's file is reported as a conflict", () => {
  const f = fixture("  - {language: typescript, role: api_server, framework: express}\n");
  const target = path.join(f.base, "project");
  write(path.join(f.out, "src/routes/users.ts"), "v1\n");
  run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B1"]);
  write(path.join(f.out, "src/routes/users.ts"), "v2\n");  // B2 rewrites B1's file
  const out = run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--build-id", "B2"]);
  assert.match(out, /conflicts=1/);
  assert.strictEqual(read(path.join(target, "src/routes/users.ts")), "v2\n", "latest build wins");
});

test("--no-project preserves legacy positional copy (no .hpc/)", () => {
  const f = fixture("  - {language: typescript}\n");
  write(path.join(f.out, "src/x.ts"), "1\n");
  const out = run(["--output-dir", f.out, "--no-project"]);   // default target = parent of hpc-workspace
  assert.match(out, /ok:deployed=1/);
  assert.ok(read(path.join(f.base, "src/x.ts")), "landed at positional default (parent of hpc-workspace)");
  assert.strictEqual(read(path.join(f.base, ".hpc/project.json")), null, "no project identity in legacy mode");
});

test("HPC-internal dirs and sidecars are skipped", () => {
  const f = fixture("  - {language: typescript}\n");
  write(path.join(f.out, "src/a.ts"), "1\n");
  write(path.join(f.out, "src/a.ts.symcheck.json"), "{}\n");
  write(path.join(f.out, "emulator/ports.json"), "{}\n");
  write(path.join(f.out, "node_modules/dep/index.js"), "1\n");
  const target = path.join(f.base, "project");
  const out = run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry]);
  assert.match(out, /ok:deployed=1/);
  assert.strictEqual(read(path.join(target, "emulator/ports.json")), null);
  assert.strictEqual(read(path.join(target, "src/a.ts.symcheck.json")), null);
});

test("--normalize-layout relocates a straggler to the profile's standard dir", () => {
  const f = fixture("  - {language: typescript, role: ssr_app, framework: nextjs}\n");
  write(path.join(f.out, "src/widgets/Card.tsx"), "export const Card = () => null;\n");
  const target = path.join(f.base, "project");
  const out = run(["--output-dir", f.out, "--manifest-dir", f.man, "--target-dir", target, "--registry", f.registry, "--normalize-layout"]);
  assert.match(out, /ok:deployed=1/);
  assert.ok(read(path.join(target, "components/widgets/Card.tsx")), "relocated under components/");
  assert.strictEqual(read(path.join(target, "src/widgets/Card.tsx")), null, "not at original path");
});
