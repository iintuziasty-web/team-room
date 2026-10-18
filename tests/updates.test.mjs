import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  latestReleaseInfo,
  verifyRelease,
  newerVersion,
  releaseFetch,
  downloadRelease,
} from "../lib/release-channel.mjs";
import {
  packRelease,
  unpackRelease,
  releasePath,
} from "../lib/release-archive.mjs";
import { HubUpdates, nodeCompatible } from "../lib/hub-updates.mjs";
import { HubSupervisor } from "../lib/hub-supervisor.mjs";
const keys = crypto.generateKeyPairSync("ed25519"),
  verify = (envelope) => verifyRelease(envelope, { key: keys.publicKey });
const sign = (release) => {
  const payload = Buffer.from(JSON.stringify(release));
  return {
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, keys.privateKey).toString("base64"),
  };
};
async function temporary(fn) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "teamroom-updates-"),
  );
  try {
    await fn(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
const fixtureServer =
  'import fs from "node:fs/promises";import path from "node:path";const version=JSON.parse(await fs.readFile("package.json")).version;process.on("message",()=>{});process.on("SIGTERM",()=>process.exit(0));await fs.writeFile(path.join(process.env.TEAM_ROOM_DATA_DIR,"runtime-context.json"),JSON.stringify({version,url:process.env.PUBLIC_URL,trial:process.env.TEAM_ROOM_UPDATE_TRIAL}));process.send({type:"community-hub-ready",version});';
function fixture(version = "1.1.0", code = fixtureServer) {
  const entries = [
    {
      path: "package.json",
      bytes: JSON.stringify({
        name: "team-room-community",
        version,
        type: "module",
      }),
    },
    {
      path: "package-lock.json",
      bytes: JSON.stringify({
        packages: { "": { name: "team-room-community", version } },
      }),
    },
    { path: "server.mjs", bytes: code },
  ];
  const archive = packRelease(entries),
    release = {
      schema: 1,
      channel: "stable",
      version,
      notes: "Обновление по желанию владельца.",
      publishedAt: new Date().toISOString(),
      assets: {
        server: {
          url:
            "https://github.com/iintuziasty-web/team-room/releases/download/v" +
            version +
            "/source.tar.gz",
          bytes: archive.length,
          sha256: crypto.createHash("sha256").update(archive).digest("hex"),
          minimumNode: "22.9.0",
          dataSchema: 1,
        },
      },
    };
  return { archive, release, envelope: sign(release) };
}
async function manager(
  storage,
  { code, version = "1.1.0", idle = () => true } = {},
) {
  const selected = fixture(version, code);
  const instance = await new HubUpdates({
    storage,
    version: "1.0.0",
    managed: true,
    idle,
    load: async () => ({
      release: selected.release,
      envelope: selected.envelope,
    }),
    download: async (_, target) =>
      fs.writeFile(target, selected.archive, { flag: "wx" }),
    install: async (_command, args) => {
      assert.ok(args.includes("--ignore-scripts"));
      assert.ok(args.includes("ci"));
    },
  }).init();
  return { instance, ...selected };
}
async function base(root) {
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "team-room-community",
      version: "1.0.0",
      type: "module",
    }),
  );
  await fs.writeFile(path.join(root, "server.mjs"), fixtureServer);
}

test("release signature detects tampering, wrong keys and incompatible metadata", () => {
  const selected = fixture();
  assert.equal(verify(selected.envelope).version, "1.1.0");
  const changed = {
    ...selected.envelope,
    payload: Buffer.from(
      JSON.stringify({ ...selected.release, notes: "tampered" }),
    ).toString("base64"),
  };
  assert.throws(() => verify(changed), /Подпись/);
  assert.throws(() => verifyRelease(selected.envelope), /Подпись/);
  assert.throws(
    () => verify(sign({ ...selected.release, schema: 2 })),
    /формат/,
  );
  const altered = structuredClone(selected.release);
  altered.assets.server.url =
    "https://github.com/another/project/releases/download/v1.1.0/source.tar.gz";
  assert.throws(() => verify(sign(altered)), /репозиторию/);
});
test("version policy never offers a downgrade and checks Node compatibility", () => {
  assert.equal(newerVersion("1.10.0", "1.9.9"), true);
  assert.equal(newerVersion("1.1.0", "1.1.0"), false);
  assert.equal(newerVersion("1.0.0", "1.1.0"), false);
  assert.equal(newerVersion("bad", "1.0.0"), false);
  assert.equal(nodeCompatible("22.9.0", "22.8.0"), false);
  assert.equal(nodeCompatible("22.9.0", "22.9.0"), true);
});
test("release downloads only follow allowed GitHub redirects", async () => {
  await assert.rejects(
    releaseFetch(
      "https://github.com/iintuziasty-web/team-room/releases/latest/download/file",
      {
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://outside.example/secret" },
          }),
      },
    ),
    /адрес/,
  );
  const result = await latestReleaseInfo({
    key: keys.publicKey,
    fetchImpl: async () => Response.json(fixture().envelope),
  });
  assert.equal(result.release.version, "1.1.0");
});
test("a corrupt download is removed and cannot become a prepared update", () =>
  temporary(async (directory) => {
    const asset = fixture().release.assets.server;
    const target = path.join(directory, "source.tar.gz");
    await assert.rejects(
      downloadRelease(asset, target, {
        fetchImpl: async () => new Response("corrupt"),
      }),
    );
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  }));
test("source archives reject traversal, duplicate files and malformed contents", () => {
  for (const name of [
    "../secret",
    "/etc/file",
    "storage/private",
    "node_modules/runtime",
    "nested/../../file",
  ])
    assert.throws(() => releasePath(name));
  const entries = unpackRelease(fixture().archive);
  assert.ok(entries.some((entry) => entry.path === "server.mjs"));
  const archive = packRelease([
    { path: "server.mjs", bytes: "" },
    { path: "server.mjs", bytes: "" },
    { path: "package-lock.json", bytes: "{}" },
  ]);
  assert.throws(() => unpackRelease(archive));
});
test("preparing requires consented version and refuses active jobs and overlapping preparation", () =>
  temporary(async (directory) => {
    let idle = false;
    const { instance } = await manager(directory, { idle: () => idle });
    await assert.rejects(instance.prepare("1.1.0"), { status: 409 });
    idle = true;
    await assert.rejects(instance.prepare("1.2.0"), { status: 409 });
    const request = instance.prepare("1.1.0");
    await assert.rejects(instance.prepare("1.1.0"), { status: 409 });
    await request;
    assert.equal(instance.status().readyVersion, "1.1.0");
    idle = false;
    assert.throws(() => instance.apply("1.1.0"), { status: 409 });
  }));
test("automatic checks can be disabled while explicit checks remain available", () =>
  temporary(async (directory) => {
    let calls = 0;
    const instance = await new HubUpdates({
      storage: directory,
      version: "1.0.0",
      load: async () => {
        calls++;
        return null;
      },
    }).init();
    await instance.settings(false);
    await instance.check();
    assert.equal(calls, 0);
    await instance.check({ force: true });
    assert.equal(calls, 1);
    assert.equal(
      (
        await new HubUpdates({ storage: directory, version: "1.0.0" }).init()
      ).status().enabled,
      false,
    );
  }));
test("managed update keeps the personal hub and data and survives supervisor restart", () =>
  temporary(async (directory) => {
    const root = path.join(directory, "base"),
      storage = path.join(directory, "data");
    await base(root);
    await fs.mkdir(storage);
    const state = {
      users: [{ name: "Fixture owner" }],
      personalSetting: "preserve",
    };
    await fs.writeFile(
      path.join(storage, "team-data.json"),
      JSON.stringify(state),
    );
    const { instance } = await manager(storage);
    await instance.prepare("1.1.0");
    const env = { ...process.env, PUBLIC_URL: "https://personal.example" };
    const supervisor = await new HubSupervisor({
      root,
      storage,
      env,
      verify,
      stdio: "ignore",
      readyTimeout: 3000,
    }).init();
    try {
      await supervisor.launch();
      await supervisor.apply(instance.apply("1.1.0"));
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(storage, "runtime-context.json")),
        ).url,
        "https://personal.example",
      );
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(storage, "team-data.json"))),
        state,
      );
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(storage, ".community-updates/current.json"),
          ),
        ).id,
        supervisor.slot,
      );
    } finally {
      await supervisor.close();
    }
    const restarted = await new HubSupervisor({
      root,
      storage,
      env,
      verify,
      stdio: "ignore",
      readyTimeout: 3000,
    }).init();
    try {
      await restarted.launch();
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(storage, "runtime-context.json")),
        ).version,
        "1.1.0",
      );
    } finally {
      await restarted.close();
    }
  }));
test("failed startup restores the previous code and the saved state", () =>
  temporary(async (directory) => {
    const root = path.join(directory, "base"),
      storage = path.join(directory, "data");
    await base(root);
    await fs.mkdir(storage);
    const original = '{"personalSetting":"preserve"}';
    await fs.writeFile(path.join(storage, "team-data.json"), original);
    const code =
      'import fs from "node:fs/promises";import path from "node:path";await fs.writeFile(path.join(process.env.TEAM_ROOM_DATA_DIR,"team-data.json"),"{}");process.exit(1);';
    const { instance } = await manager(storage, { code });
    await instance.prepare("1.1.0");
    const supervisor = await new HubSupervisor({
      root,
      storage,
      verify,
      stdio: "ignore",
      readyTimeout: 3000,
    }).init();
    try {
      await supervisor.launch();
      await assert.rejects(supervisor.apply(instance.apply("1.1.0")));
      assert.equal(
        await fs.readFile(path.join(storage, "team-data.json"), "utf8"),
        original,
      );
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(storage, "runtime-context.json")),
        ).version,
        "1.0.0",
      );
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(storage, ".community-updates/last-result.json"),
          ),
        ).ok,
        false,
      );
    } finally {
      await supervisor.close();
    }
  }));
test("an interrupted installation is rolled back before accepting new work", () =>
  temporary(async (directory) => {
    const root = path.join(directory, "base"),
      storage = path.join(directory, "data");
    await base(root);
    await fs.mkdir(storage);
    const { instance } = await manager(storage);
    await instance.prepare("1.1.0");
    const id = instance.ready.id,
      folder = path.join(storage, ".community-updates");
    await fs.writeFile(
      path.join(folder, id, "state-backup.json"),
      '{"personalSetting":"preserve"}',
    );
    await fs.writeFile(path.join(storage, "team-data.json"), "{}");
    await fs.writeFile(
      path.join(folder, "pending.json"),
      JSON.stringify({ id, previous: null, backupReady: true }),
    );
    const supervisor = await new HubSupervisor({
      root,
      storage,
      verify,
      stdio: "ignore",
      readyTimeout: 3000,
    }).init();
    assert.equal(
      JSON.parse(await fs.readFile(path.join(storage, "team-data.json")))
        .personalSetting,
      "preserve",
    );
    await assert.rejects(fs.access(path.join(folder, "pending.json")), {
      code: "ENOENT",
    });
    await supervisor.close();
  }));

test("recovery never restores a stale backup before the new backup is committed", () =>
  temporary(async (directory) => {
    const root = path.join(directory, "base"),
      storage = path.join(directory, "data");
    await base(root);
    await fs.mkdir(storage);
    const { instance } = await manager(storage);
    await instance.prepare("1.1.0");
    const id = instance.ready.id,
      folder = path.join(storage, ".community-updates");
    await fs.writeFile(
      path.join(folder, id, "state-backup.json"),
      '{"personalSetting":"stale"}',
    );
    await fs.writeFile(
      path.join(storage, "team-data.json"),
      '{"personalSetting":"latest"}',
    );
    await fs.writeFile(
      path.join(folder, "pending.json"),
      JSON.stringify({ id, previous: null, backupReady: false }),
    );
    const supervisor = await new HubSupervisor({
      root,
      storage,
      verify,
      stdio: "ignore",
    }).init();
    assert.equal(
      JSON.parse(await fs.readFile(path.join(storage, "team-data.json")))
        .personalSetting,
      "latest",
    );
    await supervisor.close();
  }));
test("a newer manually deployed base is preferred over an older managed slot", () =>
  temporary(async (directory) => {
    const root = path.join(directory, "base"),
      storage = path.join(directory, "data");
    await base(root);
    await fs.mkdir(storage);
    const { instance } = await manager(storage);
    await instance.prepare("1.1.0");
    await fs.writeFile(
      path.join(storage, ".community-updates/current.json"),
      JSON.stringify({ id: instance.ready.id }),
    );
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "team-room-community",
        version: "1.2.0",
        type: "module",
      }),
    );
    const supervisor = await new HubSupervisor({
      root,
      storage,
      verify,
      stdio: "ignore",
    }).init();
    assert.equal(supervisor.slot, null);
    await supervisor.close();
  }));

test("update result written after candidate startup is visible without another restart", () =>
  temporary(async (directory) => {
    const instance = await new HubUpdates({ storage: directory, version: "1.1.0" }).init();
    assert.equal(instance.status().lastResult, null);
    await fs.writeFile(path.join(instance.folder, "last-result.json"), JSON.stringify({ ok: true, version: "1.1.0" }));
    await instance.refreshResult();
    assert.equal(instance.status().lastResult.ok, true);
    await fs.writeFile(path.join(instance.folder, "last-result.json"), JSON.stringify({ ok: false, message: "Recovered previous version" }));
    await instance.refreshResult();
    assert.equal(instance.status().lastResult.ok, false);
  }));
