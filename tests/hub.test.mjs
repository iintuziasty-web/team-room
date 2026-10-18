import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
const root = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function unzip(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18),
      nameLength = bytes.readUInt16LE(offset + 26),
      extraLength = bytes.readUInt16LE(offset + 28),
      start = offset + 30 + nameLength + extraLength;
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    entries.set(
      bytes.subarray(offset + 30, offset + 30 + nameLength).toString(),
      bytes.subarray(start, start + size),
    );
    offset = start + size;
  }
  return entries;
}

test(
  "fresh isolated hub: accounts, files, device packages and durable sessions",
  { timeout: 60000 },
  async (t) => {
    const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "teamroom-quality-"),
      ),
      port = await freePort(),
      origin = `http://127.0.0.1:${port}`,
      setupToken = crypto.randomBytes(32).toString("hex");
    let child,
      logs = "";
    const sockets = new Set();
    async function stop() {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      if (child && child.exitCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        const forced = setTimeout(() => child.kill("SIGKILL"), 10000);
        try {
          await stopped;
        } finally {
          clearTimeout(forced);
        }
      }
    }
    async function start() {
      // Deliberately omit the developer's provider credentials and production settings.
      child = spawn(process.execPath, ["server.mjs"], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: os.tmpdir(),
          HOST: "127.0.0.1",
          PORT: String(port),
          PUBLIC_URL: origin,
          TEAM_ROOM_HUB_ONLY: "1",
          TEAM_ROOM_DATA_DIR: path.join(directory, "data"),
          TEAM_ROOM_SETUP_TOKEN: setupToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => (logs += chunk));
      child.stderr.on("data", (chunk) => (logs += chunk));
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error(logs);
        try {
          const response = await fetch(origin + "/health");
          if (response.ok) return;
        } catch {}
        await delay(50);
      }
      throw new Error("Hub did not start: " + logs);
    }
    async function request(
      route,
      { cookie, method = "GET", body, headers = {} } = {},
    ) {
      return fetch(origin + route, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    }
    async function json(route, options, status = 200) {
      const response = await request(route, options);
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return {
        value,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
        response,
      };
    }
    try {
      await start();
      await t.test(
        "requires owner setup token and refuses anonymous state access",
        async () => {
          assert.equal(
            (await json("/api/bootstrap")).value.setupRequired,
            true,
          );
          await json("/api/state", {}, 401);
          await json(
            "/api/setup",
            {
              method: "POST",
              body: {
                name: "Owner",
                password: "quality-password",
                setupToken: "incorrect",
              },
            },
            403,
          );
        },
      );
      const owner = await json("/api/setup", {
        method: "POST",
        body: { name: "Owner", password: "quality-password", setupToken },
      });
      assert.ok(owner.cookie?.startsWith("trc_session="));
      assert.match(
        owner.response.headers.get("set-cookie"),
        /HttpOnly; SameSite=Strict/,
      );
      await t.test(
        "rejects repeated owner creation and cross-site writes",
        async () => {
          await json(
            "/api/setup",
            {
              method: "POST",
              body: {
                name: "Another",
                password: "quality-password",
                setupToken,
              },
            },
            409,
          );
          await json(
            "/api/projects",
            {
              cookie: owner.cookie,
              method: "POST",
              body: { name: "blocked" },
              headers: { origin: "https://outside.example" },
            },
            403,
          );
        },
      );
      const member = await json("/api/join", {
        method: "POST",
        body: {
          name: "Member",
          password: "member-password",
          invite: owner.value.inviteCode,
        },
      });
      await t.test(
        "protects owner settings and does not leak credentials in state",
        async () => {
          await json(
            "/api/invite",
            { method: "POST", cookie: member.cookie, body: {} },
            403,
          );
          const state = (await json("/api/state", { cookie: owner.cookie }))
            .value;
          assert.equal(JSON.stringify(state).includes(setupToken), false);
          assert.equal(JSON.stringify(state).includes("tokenHash"), false);
          assert.equal(JSON.stringify(state).includes("password"), false);
        },
      );
      const project = (
        await json(
          "/api/projects",
          {
            method: "POST",
            cookie: owner.cookie,
            body: { name: "Quality fixture" },
          },
          201,
        )
      ).value;
      const chat = (
        await json(
          "/api/chats",
          {
            method: "POST",
            cookie: owner.cookie,
            body: { projectId: project.id, provider: "claude" },
          },
          201,
        )
      ).value;
      await t.test(
        "keeps each personal board private inside the shared workspace",
        async () => {
          const result = await request("/api/board/chats/" + chat.id, {
            method: "PATCH",
            cookie: member.cookie,
            body: { pinned: true },
          });
          assert.ok([403, 404].includes(result.status));
          await json("/api/board/chats/" + chat.id, {
            method: "PATCH",
            cookie: owner.cookie,
            body: { pinned: true },
          });
        },
      );
      await t.test(
        "serves uploads safely with ranges and a sandboxed HTML preview",
        async () => {
          const route =
            "/api/projects/" + project.id + "/files?path=sample.html";
          const response = await fetch(origin + route, {
            method: "POST",
            headers: { cookie: owner.cookie, "content-type": "text/html" },
            body: "<h1>Quality fixture</h1>",
          });
          assert.equal(response.status, 201, await response.text());
          const preview = await request(route + "&preview=1", {
            cookie: owner.cookie,
          });
          assert.equal(preview.status, 200);
          assert.match(
            preview.headers.get("content-security-policy"),
            /sandbox allow-scripts;/,
          );
          assert.doesNotMatch(
            preview.headers.get("content-security-policy"),
            /allow-same-origin/,
          );
          const range = await request(route, {
            cookie: owner.cookie,
            headers: { range: "bytes=0-3" },
          });
          assert.equal(range.status, 206);
          assert.equal(await range.text(), "<h1>");
          assert.equal(
            (
              await request(
                "/api/projects/" + project.id + "/files?path=../private",
                { cookie: owner.cookie },
              )
            ).status,
            400,
          );
        },
      );
      await t.test(
        "archives and restores an idle chat without deleting its history",
        async () => {
          await json("/api/chats/" + chat.id + "/archive", {
            method: "POST",
            cookie: owner.cookie,
            body: { archived: true },
          });
          const archived = await json("/api/chats/" + chat.id, {
            cookie: owner.cookie,
          });
          assert.ok(archived.value.archivedAt);
          await json("/api/chats/" + chat.id + "/archive", {
            method: "POST",
            cookie: owner.cookie,
            body: { archived: false },
          });
          const restored = (
            await json("/api/chats/" + chat.id, { cookie: owner.cookie })
          ).value;
          assert.equal(Boolean(restored.archivedAt), false);
          assert.deepEqual(restored.messages, chat.messages);
        },
      );
      await t.test(
        "exports a complete connector with installation-owned credentials only",
        async () => {
          const response = await request("/api/device-package", {
            method: "POST",
            cookie: owner.cookie,
            body: {
              name: "Fixture computer",
              hubUrl: origin,
              projectId: project.id,
            },
          });
          assert.equal(response.status, 200);
          const files = unzip(Buffer.from(await response.arrayBuffer()));
          for (const filename of [
            "bridge.mjs",
            "teamroom.mjs",
            "install-integration.mjs",
            "install-background.mjs",
            "lib/security.mjs",
            "lib/voice-worker.py",
          ])
            assert.ok(files.has(filename), filename);
          const config = JSON.parse(files.get("device-config.json"));
          assert.equal(config.hubUrl, origin);
          assert.equal(config.token.length, 64);
          const state = await json("/api/state", { cookie: owner.cookie });
          assert.equal(
            JSON.stringify(state.value).includes(config.token),
            false,
          );
          const update = await request("/api/connect-update", {
            cookie: owner.cookie,
          });
          assert.equal(update.status, 200);
          assert.equal(
            unzip(Buffer.from(await update.arrayBuffer())).has(
              "device-config.json",
            ),
            false,
          );
        },
      );
      await t.test(
        "preserves the owner login and chat across a hub restart",
        async () => {
          await stop();
          await start();
          const state = await json("/api/state", { cookie: owner.cookie });
          assert.ok(state.value.projects.some((row) => row.id === project.id));
          const saved = await json("/api/chats/" + chat.id, {
            cookie: owner.cookie,
          });
          assert.equal(saved.value.projectId, project.id);
          assert.equal(
            (await json("/api/bootstrap")).value.setupRequired,
            false,
          );
        },
      );
      await t.test(
        "closes the browser connection and invalidates login on logout",
        async () => {
          const socket = new WebSocket(
            origin.replace("http:", "ws:") + "/events",
            { headers: { cookie: owner.cookie, origin } },
          );
          sockets.add(socket);
          await once(socket, "open");
          const closed = once(socket, "close");
          await json("/api/logout", {
            method: "POST",
            cookie: owner.cookie,
            body: {},
          });
          assert.equal((await closed)[0], 4001);
          await json("/api/state", { cookie: owner.cookie }, 401);
        },
      );
    } finally {
      await stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
