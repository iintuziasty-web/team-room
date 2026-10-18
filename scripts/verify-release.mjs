#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "../lib/release-channel.mjs";
import { extractRelease } from "../lib/release-archive.mjs";
import { HubUpdates } from "../lib/hub-updates.mjs";
import { HubSupervisor } from "../lib/hub-supervisor.mjs";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url)),
  exec = promisify(execFile);
const input = process.argv.indexOf("--release"),
  releaseDir = input < 0 ? null : process.argv[input + 1];
if (!releaseDir)
  throw new Error(
    "Укажи --release с каталогом подготовленного подписанного релиза.",
  );
const envelope = JSON.parse(
    await fs.readFile(path.join(releaseDir, "team-room-update.json")),
  ),
  release = verifyRelease(envelope),
  asset = release.assets.server;
const archivePath = path.join(
    releaseDir,
    path.basename(new URL(asset.url).pathname),
  ),
  archive = await fs.readFile(archivePath);
assert.equal(
  crypto.createHash("sha256").update(archive).digest("hex"),
  asset.sha256,
);
assert.equal(archive.length, asset.bytes);
const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "teamroom-release-smoke-"),
  ),
  base = path.join(directory, "base"),
  storage = path.join(directory, "data");
let supervisor;
try {
  await extractRelease(archive, base);
  const pkg = JSON.parse(await fs.readFile(path.join(base, "package.json")));
  pkg.version = "0.0.0";
  await fs.writeFile(path.join(base, "package.json"), JSON.stringify(pkg));
  await fs.symlink(
    path.join(root, "node_modules"),
    path.join(base, "node_modules"),
    "dir",
  );
  await fs.mkdir(storage);
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = "http://127.0.0.1:" + port,
    token = crypto.randomBytes(32).toString("hex");
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    TMPDIR: os.tmpdir(),
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_URL: origin,
    TEAM_ROOM_HUB_ONLY: "1",
    TEAM_ROOM_DATA_DIR: storage,
    TEAM_ROOM_SETUP_TOKEN: token,
    TEAM_ROOM_DISABLE_UPDATE_CHECKS: "1",
  };
  supervisor = await new HubSupervisor({
    root: base,
    storage,
    env,
    stdio: "ignore",
  }).init();
  await supervisor.launch();
  const owner = await fetch(origin + "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Release fixture",
      password: "release-fixture-password",
      setupToken: token,
    }),
  });
  assert.equal(owner.status, 200);
  const cookie = owner.headers.get("set-cookie").split(";")[0],
    state = await owner.json(),
    project = state.projects[0];
  const file =
    "/api/projects/" + project.id + "/files?path=release-fixture.txt";
  const uploaded = await fetch(origin + file, {
    method: "POST",
    headers: { cookie, "content-type": "text/plain" },
    body: "preserved user output",
  });
  assert.equal(uploaded.status, 201);
  const updater = await new HubUpdates({
    storage,
    version: "0.0.0",
    managed: true,
    load: async () => ({ envelope, release }),
    download: async (_, target) => fs.copyFile(archivePath, target),
    install: (command, args, options) => exec(command, args, options),
  }).init();
  await updater.prepare(release.version);
  await supervisor.apply(updater.apply(release.version));
  const health = await (await fetch(origin + "/health")).json();
  assert.equal(health.version, release.version);
  const restored = await fetch(origin + "/api/state", { headers: { cookie } });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).me.id, state.me.id);
  assert.equal(
    await (await fetch(origin + file, { headers: { cookie } })).text(),
    "preserved user output",
  );
  const status = await (
    await fetch(origin + "/api/updates", { headers: { cookie } })
  ).json();
  assert.equal(status.managed, true);
  assert.equal(status.current, release.version);
  assert.equal(status.lastResult.ok, true);
  console.log(
    "Signed artifact smoke check passed: real hub startup, fresh dependency install, managed replacement, preserved login, project file and configuration. Baseline version is synthetic; no provider requests were made.",
  );
} finally {
  await supervisor?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
