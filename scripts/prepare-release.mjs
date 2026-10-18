#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packRelease } from "../lib/release-archive.mjs";
import { verifyRelease, RELEASE_REPOSITORY } from "../lib/release-channel.mjs";
import { releasePublicKey } from "../lib/release-key.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const option = (name) => {
  const at = process.argv.indexOf("--" + name);
  return at < 0 ? null : process.argv[at + 1];
};
const keyPath = option("key") || process.env.TEAMROOM_RELEASE_SIGNING_KEY;
if (!keyPath)
  throw new Error(
    "Укажи --key с путём к своему ключу Ed25519 вне репозитория.",
  );
if (path.resolve(keyPath).startsWith(path.resolve(root) + path.sep))
  throw new Error("Закрытый ключ должен храниться вне репозитория.");
const key = crypto.createPrivateKey(await fs.readFile(keyPath));
if (
  key.asymmetricKeyType !== "ed25519" ||
  crypto.createPublicKey(key).export({ type: "spki", format: "pem" }) !==
    releasePublicKey
)
  throw new Error("Ключ не совпадает с опубликованным ключом проверки.");
const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
if (git(["status", "--porcelain"]).trim())
  throw new Error(
    "Сначала зафиксируй проверенные изменения. Релиз собирается только из чистого HEAD.",
  );
execFileSync(process.execPath, ["scripts/audit-public.mjs"], {
  cwd: root,
  stdio: "inherit",
});
const pkg = JSON.parse(git(["show", "HEAD:package.json"])),
  version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Нужна версия x.y.z.");
const notes = await fs.readFile(
  option("notes") || path.join(root, "RELEASE_NOTES.md"),
  "utf8",
);
if (!notes.trim() || notes.length > 16000)
  throw new Error("Добавь описание релиза до 16 000 символов.");
const output = path.resolve(
  option("out") || path.join(root, "dist", "releases", "v" + version),
);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const files = git(["ls-tree", "-r", "--name-only", "HEAD"])
  .split("\n")
  .filter(Boolean);
const entries = files.map((name) => ({
  path: name,
  bytes: execFileSync("git", ["show", "HEAD:" + name], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  }),
  executable: name === "docker-entrypoint.sh",
}));
const archive = packRelease(entries),
  serverName = "Team-Room-" + version + "-source.tar.gz";
await fs.writeFile(path.join(output, serverName), archive);
const asset = (name, bytes) => ({
  url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${name}`,
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});
const release = {
  schema: 1,
  channel: "stable",
  version,
  commit: git(["rev-parse", "HEAD"]).trim(),
  publishedAt: new Date().toISOString(),
  notes: notes.trim(),
  assets: {
    server: {
      ...asset(serverName, archive),
      minimumNode: "22.9.0",
      dataSchema: 1,
    },
  },
};
const macPath = option("mac");
if (macPath) {
  const plist = execFileSync(
    "/usr/bin/unzip",
    ["-p", macPath, "Team Room Community.app/Contents/Info.plist"],
    { encoding: "utf8", maxBuffer: 65536 },
  );
  const value = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
    }),
  );
  if (
    value.CFBundleIdentifier !== "io.teamroom.community" ||
    value.CFBundleShortVersionString !== version ||
    value.TeamRoomHubURL
  )
    throw new Error(
      "Общий Mac-релиз должен быть без привязки к хабу и с той же версией.",
    );
  const instance = JSON.parse(
    execFileSync(
      "/usr/bin/unzip",
      [
        "-p",
        macPath,
        "Team Room Community.app/Contents/Resources/instance.json",
      ],
      { encoding: "utf8", maxBuffer: 65536 },
    ),
  );
  if (instance.hubUrl || instance.updateChannel !== "community")
    throw new Error(
      "Mac-сборка должна использовать общий канал без привязки к хабу.",
    );
  const keyModule = execFileSync(
    "/usr/bin/unzip",
    [
      "-p",
      macPath,
      "Team Room Community.app/Contents/Resources/connect/lib/release-key.mjs",
    ],
    { encoding: "utf8", maxBuffer: 65536 },
  );
  if (!keyModule.includes(JSON.stringify(releasePublicKey)))
    throw new Error("Mac-сборка содержит другой ключ проверки.");
  const bytes = await fs.readFile(macPath),
    name = "Team-Room-" + version + "-macOS-universal.zip";
  await fs.copyFile(macPath, path.join(output, name));
  release.assets.macos = {
    ...asset(name, bytes),
    minimumMacOS: value.LSMinimumSystemVersion,
  };
}
const payload = Buffer.from(JSON.stringify(release)),
  envelope = {
    payload: payload.toString("base64"),
    signature: crypto.sign(null, payload, key).toString("base64"),
  };
verifyRelease(envelope);
await fs.writeFile(
  path.join(output, "team-room-update.json"),
  JSON.stringify(envelope, null, 2) + "\n",
);
await fs.writeFile(path.join(output, "release-notes.md"), notes);
console.log(
  "Подписанный релиз подготовлен: " +
    output +
    "\nОпубликуй файлы в GitHub release v" +
    version +
    " как Latest; prerelease не используется каналом stable.",
);
