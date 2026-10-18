import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hubOrigin } from "../lib/community-origin.mjs";
import { RateLimiter, sameOrigin, TelegramAuth } from "../lib/security.mjs";
import {
  filePath,
  portablePath,
  atomicProjectWrite,
  snapshot,
} from "../lib/workspace.mjs";
import { prepareSourcePackage } from "../ios-app/source-package.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamroom-unit-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("native builds require an explicit clean HTTPS origin, except loopback HTTP", () => {
  for (const value of [
    undefined,
    "",
    "http://outside.example",
    "https://name:password@hub.example",
    "https://hub.example/path",
    "https://hub.example?token=example",
    "https://hub.example/#fragment",
  ])
    assert.throws(() => hubOrigin(value));
  assert.equal(hubOrigin("https://hub.example/"), "https://hub.example");
  assert.equal(hubOrigin("http://127.0.0.1:4173"), "http://127.0.0.1:4173");
});
test("CSRF policy rejects foreign origins and rate limits expire", () => {
  const req = {
    headers: { host: "hub.example", origin: "https://outside.example" },
    socket: { encrypted: true },
  };
  assert.equal(sameOrigin(req, "https://hub.example"), false);
  req.headers.origin = "https://hub.example";
  assert.equal(sameOrigin(req, "https://hub.example"), true);
  req.headers["sec-fetch-site"] = "cross-site";
  assert.equal(sameOrigin(req, "https://hub.example"), false);
  let now = 0;
  const limiter = new RateLimiter({ clock: () => now });
  limiter.take("fixture", 1, 100);
  assert.throws(() => limiter.take("fixture", 1, 100), { status: 429 });
  now = 101;
  assert.doesNotThrow(() => limiter.take("fixture", 1, 100));
});
test("Telegram codes are browser bound, expire and can only be consumed once", () =>
  temporary(async (dir) => {
    let now = 1000,
      code;
    const auth = await new TelegramAuth({
      storage: dir,
      clock: () => now,
      deliver: async (_, { code: value }) => {
        code = value;
      },
    }).init();
    const request = {
      name: "Owner",
      userId: "owner",
      config: {},
      binding: "fixture",
    };
    const first = await auth.request(request);
    assert.throws(
      () => auth.consume(first.id, code, "wrong-browser", "login"),
      { status: 401 },
    );
    assert.equal(
      auth.consume(first.id, code, first.nonce, "login").userId,
      "owner",
    );
    assert.throws(() => auth.consume(first.id, code, first.nonce, "login"), {
      status: 401,
    });
    now += 61000;
    const second = await auth.request(request);
    now += 300001;
    assert.throws(() => auth.consume(second.id, code, second.nonce, "login"), {
      status: 401,
    });
  }));
test("portable files exclude secrets, dependencies and runtime browser profiles", () => {
  for (const name of [
    "../secret",
    "/etc/passwd",
    "C:/private",
    ".env",
    ".env.local",
    ".SSH/id_rsa",
    "node_modules/pkg/index.js",
    ".chrome-assets/Default/Cookies",
    "nested/.claude/settings.json",
  ])
    assert.throws(() => portablePath(name));
  assert.equal(portablePath("outputs/report.html"), "outputs/report.html");
  assert.equal(
    portablePath("reports/Default/summary.txt"),
    "reports/Default/summary.txt",
  );
});
test("workspace writes are atomic and cannot follow a symlink outside the project", () =>
  temporary(async (dir) => {
    const workspace = path.join(dir, "project"),
      outside = path.join(dir, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace, "link"));
    await assert.rejects(filePath(workspace, "link/report.txt"), {
      code: "SYMLINK_PATH",
    });
    await assert.rejects(
      atomicProjectWrite(workspace, "link/report.txt", Buffer.from("private")),
    );
    assert.deepEqual(await fs.readdir(outside), []);
    const payload = crypto.randomBytes(40);
    await atomicProjectWrite(workspace, "outputs/report.bin", payload);
    assert.deepEqual(
      await fs.readFile(path.join(workspace, "outputs/report.bin")),
      payload,
    );
    const files = await snapshot(workspace);
    assert.ok(files.some((row) => row.path === "outputs/report.bin"));
  }));
test("iOS source package retains relative imports and includes its installation guide", () =>
  temporary(async (dir) => {
    await prepareSourcePackage(path.join(root, "ios-app"), dir);
    for (const name of [
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "ios-app/build.mjs",
      "ios-app/source-package.mjs",
      "ios-app/README.md",
      "ios-app/Sources/TeamRoomApp.swift",
      "lib/community-origin.mjs",
    ])
      await fs.access(path.join(dir, name));
    const build = await fs.readFile(
      path.join(dir, "ios-app/build.mjs"),
      "utf8",
    );
    assert.ok(build.includes("from '../lib/community-origin.mjs'"));
    assert.ok(build.includes("from './source-package.mjs'"));
  }));

test("first setup generates private configuration and never overwrites existing values", () =>
  temporary(async (dir) => {
    await fs.mkdir(path.join(dir, "scripts"));
    await fs.copyFile(
      path.join(root, "scripts/setup.mjs"),
      path.join(dir, "scripts/setup.mjs"),
    );
    const run = () =>
      execFileSync(process.execPath, [path.join(dir, "scripts/setup.mjs")], {
        stdio: "pipe",
      });
    run();
    const file = path.join(dir, ".env"),
      first = await fs.readFile(file, "utf8");
    assert.match(first, /TEAM_ROOM_SETUP_TOKEN=[A-Za-z0-9_-]{40,}/);
    assert.match(first, /HOST=127\.0\.0\.1/);
    if (process.platform !== "win32")
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    run();
    assert.equal(await fs.readFile(file, "utf8"), first);
  }));

test("source checks work for downloaded archives without Git metadata", () =>
  temporary(async (dir) => {
    const { sourceFiles } = await import("../scripts/source-files.mjs");
    await fs.mkdir(path.join(dir, "src"));
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.writeFile(
      path.join(dir, "src/main.mjs"),
      "export const sample=true;",
    );
    await fs.writeFile(path.join(dir, "node_modules/runtime.mjs"), "");
    await fs.writeFile(path.join(dir, ".env"), "ignored fixture");
    const result = await sourceFiles(dir);
    assert.equal(result.tracked, false);
    assert.deepEqual(result.files, ["src/main.mjs"]);
  }));
