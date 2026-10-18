import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  latestReleaseInfo,
  newerVersion,
  downloadRelease,
  RELEASE_REPOSITORY,
} from "./release-channel.mjs";
import { extractRelease } from "./release-archive.mjs";
import { writeDurableJson } from "./durable-json.mjs";
const exec = promisify(execFile);
const fail = (status, message) => Object.assign(new Error(message), { status });
// Invoke npm through Node on every platform; .cmd shims are not executables.
export async function npmCLI() {
  const directory = path.dirname(process.execPath),
    candidates = [
      process.env.npm_execpath,
      path.join(directory, "node_modules/npm/bin/npm-cli.js"),
      path.join(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
    ];
  for (const directory of String(process.env.PATH || "").split(path.delimiter))
    for (const name of ["npm", "npm.cmd"])
      try {
        const real = await fs.realpath(path.join(directory, name));
        if (real.endsWith("npm-cli.js")) candidates.push(real);
      } catch {}
  for (const candidate of candidates.filter(Boolean))
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && path.basename(candidate) === "npm-cli.js")
        return candidate;
    } catch {}
  throw fail(
    503,
    "Установи Node.js вместе с npm, затем повтори подготовку обновления.",
  );
}
export const slotName = (value) =>
  typeof value === "string" && /^v\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(value);
export function nodeCompatible(required, current = process.versions.node) {
  const normalize = (value) => value.split(".").map(Number);
  const a = normalize(current),
    b = normalize(required);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}
export class HubUpdates {
  constructor({
    storage,
    version,
    managed = false,
    idle = () => true,
    load = latestReleaseInfo,
    download = downloadRelease,
    install = exec,
  } = {}) {
    Object.assign(this, {
      storage,
      version,
      managed,
      idle,
      load,
      download,
      install,
    });
    this.folder = path.join(storage, ".community-updates");
    this.phase = "idle";
    this.enabled = true;
    this.pending = null;
    this.info = null;
    this.checkedAt = 0;
    this.error = null;
    this.ready = null;
  }
  async init() {
    try {
      this.lastResult = JSON.parse(
        await fs.readFile(path.join(this.folder, "last-result.json")),
      );
    } catch {}
    await fs.mkdir(this.folder, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.folder)).isSymbolicLink())
      throw new Error("Папка обновления не может быть ссылкой.");
    try {
      this.enabled =
        JSON.parse(
          await fs.readFile(path.join(this.folder, "preferences.json")),
        ).enabled !== false;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }
  status() {
    const release = this.info?.release;
    return {
      current: this.version,
      repository: RELEASE_REPOSITORY,
      managed: this.managed,
      enabled: this.enabled,
      checkedAt: this.checkedAt || null,
      phase: this.phase,
      error: this.error,
      available: Boolean(
        release &&
          release.assets.server &&
          newerVersion(release.version, this.version),
      ),
      version: release?.version || null,
      notes: release?.notes || "",
      publishedAt: release?.publishedAt || null,
      readyVersion: this.ready?.version || null,
      busy: !this.idle(),
      restartRequired: true,
      lastResult: this.lastResult || null,
    };
  }
  async check({ force = false } = {}) {
    if (this.pending) return this.pending;
    if (
      (!this.enabled && !force) ||
      (!force &&
        Date.now() - this.checkedAt < (this.error ? 60000 : 6 * 3600000))
    )
      return this.status();
    const pending = (async () => {
      try {
        this.info = await this.load();
        this.error = null;
        this.checkedAt = Date.now();
      } catch {
        this.error =
          "Не удалось проверить релизы. Текущая версия продолжает работать.";
        this.checkedAt = Date.now();
      }
      return this.status();
    })();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async settings(enabled) {
    if (typeof enabled !== "boolean")
      throw fail(400, "Укажи режим проверки обновлений.");
    await writeDurableJson(path.join(this.folder, "preferences.json"), {
      enabled,
    });
    this.enabled = enabled;
    return this.status();
  }
  assertIdle() {
    if (!this.idle())
      throw fail(
        409,
        "Дождись завершения задач, передачи файлов и входов в подписки перед обновлением сервера.",
      );
  }
  async prepare(version) {
    if (this.preparing) throw fail(409, "Обновление уже подготавливается.");
    this.preparing = true;
    try {
      return await this.prepareRelease(version);
    } finally {
      this.preparing = false;
    }
  }
  async prepareRelease(version) {
    if (!this.managed)
      throw fail(
        409,
        "Один раз запусти хаб через npm start из новой версии. После этого появится установка кнопкой.",
      );
    if (this.phase === "preparing")
      throw fail(409, "Обновление уже подготавливается.");
    this.assertIdle();
    await this.check({ force: true });
    const selected = this.info;
    if (
      !selected ||
      selected.release.version !== version ||
      !selected.release.assets.server ||
      !newerVersion(version, this.version)
    )
      throw fail(409, "Список релизов изменился. Проверь обновления ещё раз.");
    const asset = selected.release.assets.server;
    if (!nodeCompatible(asset.minimumNode))
      throw fail(
        409,
        "Сначала обнови Node.js до " + asset.minimumNode + " или новее.",
      );
    const id = "v" + version + "-" + asset.sha256.slice(0, 16),
      stage = path.join(this.folder, id),
      app = path.join(stage, "app");
    if (this.ready?.id === id) return this.status();
    this.phase = "preparing";
    this.error = null;
    try {
      const stat = await fs.statfs(this.folder);
      if (
        Number(stat.bavail) * Number(stat.bsize) <
        asset.bytes * 4 + 300 * 1024 * 1024
      )
        throw fail(
          507,
          "Недостаточно места для подготовки обновления. Освободи не менее 300 МБ и повтори.",
        );
      await fs.rm(stage, { recursive: true, force: true });
      await fs.mkdir(stage, { mode: 0o700 });
      await this.download(asset, path.join(stage, "source.tar.gz"));
      await extractRelease(
        await fs.readFile(path.join(stage, "source.tar.gz")),
        app,
      );
      const pkg = JSON.parse(await fs.readFile(path.join(app, "package.json"))),
        lock = JSON.parse(
          await fs.readFile(path.join(app, "package-lock.json")),
        );
      if (
        pkg.name !== "team-room-community" ||
        pkg.version !== version ||
        lock.packages?.[""]?.version !== version
      )
        throw new Error("Неверная версия пакета.");
      const npmHome = path.join(stage, "npm-home");
      await fs.mkdir(npmHome, { mode: 0o700 });
      await fs.writeFile(
        path.join(npmHome, ".npmrc"),
        "registry=https://registry.npmjs.org\n",
        { mode: 0o600 },
      );
      const installEnv = {
        PATH: process.env.PATH,
        HOME: npmHome,
        TMPDIR: os.tmpdir(),
        npm_config_userconfig: path.join(npmHome, ".npmrc"),
        npm_config_globalconfig: path.join(npmHome, "global.npmrc"),
      };
      for (const name of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "SystemRoot",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
      ])
        if (process.env[name]) installEnv[name] = process.env[name];
      await this.install(
        process.execPath,
        [
          await npmCLI(),
          "ci",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--cache",
          path.join(stage, "npm-cache"),
        ],
        {
          cwd: app,
          timeout: 180000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: installEnv,
        },
      );
      await fs.rm(path.join(stage, "npm-cache"), {
        recursive: true,
        force: true,
      });
      await fs.rm(npmHome, { recursive: true, force: true });
      await writeDurableJson(
        path.join(stage, "release.json"),
        selected.envelope,
      );
      this.ready = { id, version };
      this.phase = "ready";
      return this.status();
    } catch (error) {
      this.phase = "idle";
      this.error =
        "Не удалось подготовить обновление. Работающая версия и данные сохранены.";
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (error.status) throw error;
      throw fail(503, this.error);
    }
  }
  apply(version) {
    this.assertIdle();
    if (
      !this.managed ||
      !this.ready ||
      this.ready.version !== version ||
      this.phase !== "ready"
    )
      throw fail(409, "Сначала подготовь выбранное обновление.");
    this.phase = "installing";
    return this.ready.id;
  }
}
