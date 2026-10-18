import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { verifyRelease, newerVersion } from "./release-channel.mjs";
import { slotName, nodeCompatible } from "./hub-updates.mjs";
import { writeDurableJson } from "./durable-json.mjs";
export class HubSupervisor {
  constructor({
    root,
    storage,
    env = process.env,
    readyTimeout = 120000,
    settleMs = 1500,
    verify = verifyRelease,
    stdio = "inherit",
  } = {}) {
    Object.assign(this, {
      root,
      storage,
      env,
      readyTimeout,
      settleMs,
      verify,
      stdio,
    });
    this.folder = path.join(storage, ".community-updates");
    this.child = null;
    this.slot = null;
    this.closing = false;
    this.installing = false;
    this.retries = 0;
    this.restartTimer = null;
  }
  async init() {
    await fs.mkdir(this.folder, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.folder)).isSymbolicLink())
      throw new Error("Папка обновлений не может быть ссылкой.");
    try {
      const state = JSON.parse(
        await fs.readFile(path.join(this.folder, "current.json")),
      );
      if (state.id !== null) {
        await this.validateSlot(state.id);
        this.slot = state.id;
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          "Состояние обновления повреждено. Сохрани данные и восстанови previous.json перед запуском.",
        );
    }
    try {
      const pending = JSON.parse(
        await fs.readFile(path.join(this.folder, "pending.json")),
      );
      const selected = await this.validateSlot(pending.id);
      if (pending.id !== this.slot) {
        if (pending.previous !== this.slot)
          throw new Error("Состояние прерванного обновления не совпало.");
        if (pending.backupReady) {
          const backup = path.join(selected.stage, "state-backup.json"),
            stat = await fs.lstat(backup);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Неверная резервная копия.");
          await writeDurableJson(
            path.join(this.storage, "team-data.json"),
            await fs.readFile(backup),
          );
        }
        await writeDurableJson(path.join(this.folder, "last-result.json"), {
          ok: false,
          message:
            "Прерванное обновление отменено. Восстановлена предыдущая версия.",
          at: new Date().toISOString(),
        });
      }
      await fs.rm(path.join(this.folder, "pending.json"), { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (this.slot) {
      const selected = await this.validateSlot(this.slot),
        base = JSON.parse(
          await fs.readFile(path.join(this.root, "package.json")),
        );
      if (newerVersion(base.version, selected.release.version)) {
        await writeDurableJson(path.join(this.folder, "previous.json"), {
          id: this.slot,
        });
        await writeDurableJson(path.join(this.folder, "current.json"), {
          id: null,
        });
        this.slot = null;
      }
    }
    return this;
  }
  async validateSlot(id) {
    if (!slotName(id)) throw new Error("Неверная версия обновления.");
    const stage = path.join(this.folder, id),
      app = path.join(stage, "app");
    for (const folder of [stage, app]) {
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Неверная папка релиза.");
    }
    const release = this.verify(
        JSON.parse(await fs.readFile(path.join(stage, "release.json"))),
      ),
      asset = release.assets.server;
    if (
      !asset ||
      !nodeCompatible(asset.minimumNode) ||
      id !== "v" + release.version + "-" + asset.sha256.slice(0, 16)
    )
      throw new Error("Версия обновления не совпала.");
    const file = await fs.open(path.join(stage, "source.tar.gz"), "r");
    try {
      const hash = crypto.createHash("sha256");
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        hash.update(chunk);
      }
      if (size !== asset.bytes || hash.digest("hex") !== asset.sha256)
        throw new Error("Архив обновления повреждён.");
    } finally {
      await file.close();
    }
    const pkg = JSON.parse(await fs.readFile(path.join(app, "package.json")));
    if (pkg.version !== release.version || pkg.name !== "team-room-community")
      throw new Error("Пакет обновления повреждён.");
    return { stage, app, release };
  }
  async directory(slot = this.slot) {
    return slot ? (await this.validateSlot(slot)).app : this.root;
  }
  async launch(slot = this.slot, trial = false) {
    const cwd = await this.directory(slot),
      version = JSON.parse(
        await fs.readFile(path.join(cwd, "package.json")),
      ).version;
    const stdio =
      this.stdio === "ignore"
        ? ["ignore", "ignore", "ignore", "ipc"]
        : ["inherit", "inherit", "inherit", "ipc"];
    const flags = process.execArgv.filter((value) =>
      /^--max[-_]old[-_]space[-_]size=\d+$/.test(value),
    );
    const child = spawn(
      process.execPath,
      [...flags, path.join(cwd, "server.mjs")],
      {
        cwd,
        env: {
          ...this.env,
          TEAM_ROOM_DATA_DIR: this.storage,
          TEAM_ROOM_MANAGED_UPDATES: "1",
          TEAM_ROOM_UPDATE_TRIAL: trial ? "1" : "0",
        },
        stdio,
      },
    );
    this.child = child;
    child.on("message", (packet) => {
      if (
        child === this.child &&
        packet?.type === "community-update-apply" &&
        !this.installing &&
        !this.closing
      )
        void this.apply(packet.id).catch((error) => {
          console.error("Обновление сервера:", error.message);
          if (this.child?.connected)
            this.child.send({
              type: "community-update-rejected",
              message:
                "Обновление не установлено. Предыдущая версия сохранена.",
            });
        });
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Новая версия не подтвердила запуск.")),
        this.readyTimeout,
      );
      const exit = () =>
        finish(
          new Error("Процесс сервера завершился до подтверждения запуска."),
        );
      const error = () => finish(new Error("Не удалось запустить сервер."));
      const message = (packet) => {
        if (
          packet?.type === "community-hub-ready" &&
          packet.version === version
        )
          finish();
      };
      function finish(error) {
        clearTimeout(timer);
        child.off("exit", exit);
        child.off("error", errorHandler);
        child.off("message", message);
        error ? reject(error) : resolve(child);
      }
      const errorHandler = error;
      child.once("exit", exit);
      child.once("error", errorHandler);
      child.on("message", message);
    }).catch(async (error) => {
      await this.stopChild(child);
      throw error;
    });
    child.on("exit", () => {
      if (this.child === child && !this.installing && !this.closing) {
        this.retries++;
        if (this.retries > 3) {
          console.error(
            "Хаб повторно завершился. Проверь журнал и свободное место.",
          );
          process.exitCode = 1;
          return;
        }
        this.restartTimer = setTimeout(
          () =>
            void this.launch().catch((error) => {
              console.error(error.message);
              process.exitCode = 1;
            }),
          1000 * this.retries,
        );
      }
    });
    return ready;
  }
  async stopChild(child = this.child) {
    if (!child || child.exitCode !== null || child.signalCode)
      return { forced: false };
    const done = once(child, "exit");
    let forced = false;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 25000);
    try {
      await done;
      return { forced };
    } finally {
      clearTimeout(force);
    }
  }
  async apply(id) {
    if (this.inFlight) throw new Error("Обновление уже выполняется.");
    const work = this.applyRelease(id);
    this.inFlight = work;
    try {
      return await work;
    } finally {
      if (this.inFlight === work) this.inFlight = null;
    }
  }
  async applyRelease(id) {
    if (this.installing || this.closing)
      throw new Error("Обновление уже выполняется.");
    this.installing = true;
    const previous = this.slot;
    let backup = null,
      stopped = false,
      committed = false;
    try {
      const next = await this.validateSlot(id),
        cwd = await this.directory(previous),
        current = JSON.parse(
          await fs.readFile(path.join(cwd, "package.json")),
        ).version;
      if (!newerVersion(next.release.version, current))
        throw new Error("Версия уже установлена.");
      await fs.rm(path.join(next.stage, "state-backup.json"), { force: true });
      await writeDurableJson(path.join(this.folder, "pending.json"), {
        id,
        previous,
        backupReady: false,
      });
      const stoppedProcess = await this.stopChild();
      stopped = true;
      if (stoppedProcess.forced)
        throw new Error(
          "Сервер не завершил сохранение вовремя. Обновление отменено.",
        );
      const data = path.join(this.storage, "team-data.json");
      const backupPath = path.join(next.stage, "state-backup.json");
      try {
        await fs.copyFile(data, backupPath);
        await fs.chmod(backupPath, 0o600);
        const handle = await fs.open(backupPath, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        backup = backupPath;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        backup = null;
      }
      await writeDurableJson(path.join(this.folder, "pending.json"), {
        id,
        previous,
        backupReady: Boolean(backup),
      });
      await this.launch(id, true);
      await new Promise((resolve) => setTimeout(resolve, this.settleMs));
      if (
        this.child.exitCode !== null ||
        this.child.signalCode ||
        !this.child.connected
      )
        throw new Error("Новая версия завершилась сразу после запуска.");
      await writeDurableJson(path.join(this.folder, "previous.json"), {
        id: previous,
      });
      await writeDurableJson(path.join(this.folder, "current.json"), { id });
      this.slot = id;
      this.retries = 0;
      committed = true;
      await writeDurableJson(path.join(this.folder, "last-result.json"), {
        ok: true,
        version: next.release.version,
        at: new Date().toISOString(),
      }).catch(() => {});
      this.child.send({ type: "community-update-committed" });
      await fs.rm(path.join(this.folder, "pending.json"), { force: true });
      for (const entry of await fs.readdir(this.folder, {
        withFileTypes: true,
      }))
        if (
          entry.isDirectory() &&
          slotName(entry.name) &&
          ![id, previous].includes(entry.name)
        )
          await fs.rm(path.join(this.folder, entry.name), {
            recursive: true,
            force: true,
          });
    } catch (error) {
      if (committed) {
        console.warn(
          "Новая версия запущена; очистка старых файлов будет повторена.",
        );
        return;
      }
      if (stopped) {
        await this.stopChild();
        if (backup)
          await writeDurableJson(
            path.join(this.storage, "team-data.json"),
            await fs.readFile(backup),
          );
        this.slot = previous;
        await writeDurableJson(path.join(this.folder, "current.json"), {
          id: previous,
        });
        await this.launch(previous);
      }
      await writeDurableJson(path.join(this.folder, "last-result.json"), {
        ok: false,
        message:
          "Новая версия не запустилась. Восстановлена предыдущая версия.",
        at: new Date().toISOString(),
      });
      await fs.rm(path.join(this.folder, "pending.json"), { force: true });
      throw error;
    } finally {
      this.installing = false;
    }
  }
  async close() {
    this.closing = true;
    clearTimeout(this.restartTimer);
    await this.inFlight?.catch(() => {});
    await this.stopChild();
  }
}
