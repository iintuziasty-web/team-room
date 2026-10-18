import crypto from "node:crypto";
import fs from "node:fs/promises";
import { releasePublicKey } from "./release-key.mjs";
export const RELEASE_REPOSITORY = "iintuziasty-web/team-room";
export const RELEASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/team-room-update.json`;
const hosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export function newerVersion(next, current) {
  const parse = (value) =>
    typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)
      ? value.split(".").map(Number)
      : null;
  const a = parse(next),
    b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function allowedURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Недопустимый адрес релиза.");
  if (
    url.hostname === "github.com" &&
    !url.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/`)
  )
    throw new Error("Релиз относится к другому репозиторию.");
  return url;
}
export async function releaseFetch(
  url,
  { fetchImpl = fetch, signal = AbortSignal.timeout(20000) } = {},
) {
  let current = allowedURL(url);
  for (let i = 0; i < 6; i++) {
    const response = await fetchImpl(current.href, {
      redirect: "manual",
      signal,
      headers: { accept: "application/octet-stream" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const next = response.headers.get("location");
    await response.body?.cancel();
    if (!next) throw new Error("Неверное перенаправление релиза.");
    current = allowedURL(new URL(next, current).href);
  }
  throw new Error("Слишком много перенаправлений релиза.");
}
export async function boundedBytes(response, max) {
  if (Number(response.headers.get("content-length")) > max)
    throw new Error("Файл релиза слишком большой.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error("Файл релиза слишком большой.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function verifyRelease(envelope, { key = releasePublicKey } = {}) {
  if (
    typeof envelope?.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    envelope.payload.length > 65536 ||
    envelope.signature.length > 128
  )
    throw new Error("Неверное описание релиза.");
  const bytes = Buffer.from(envelope.payload, "base64"),
    signature = Buffer.from(envelope.signature, "base64");
  if (signature.length !== 64 || !crypto.verify(null, bytes, key, signature))
    throw new Error("Подпись релиза не прошла проверку.");
  const release = JSON.parse(bytes);
  if (
    release.schema !== 1 ||
    release.channel !== "stable" ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    typeof release.notes !== "string" ||
    release.notes.length > 16000 ||
    !Number.isFinite(Date.parse(release.publishedAt))
  )
    throw new Error("Неверный формат релиза.");
  if (
    !release.assets ||
    typeof release.assets !== "object" ||
    Array.isArray(release.assets)
  )
    throw new Error("Релиз не содержит файлов.");
  for (const [kind, asset] of Object.entries(release.assets)) {
    if (
      !["server", "macos"].includes(kind) ||
      !asset ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > (kind === "server" ? 128 * 1024 * 1024 : 1400000000)
    )
      throw new Error("Неверные параметры файла релиза.");
    const url = allowedURL(asset.url);
    if (
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(
        `/${RELEASE_REPOSITORY}/releases/download/v${release.version}/`,
      ) ||
      url.search
    )
      throw new Error("Неверный файл версии релиза.");
  }
  if (
    release.assets.server &&
    (release.assets.server.dataSchema !== 1 ||
      !/^\d+\.\d+(?:\.\d+)?$/.test(release.assets.server.minimumNode || ""))
  )
    throw new Error("Эта схема серверного обновления не поддерживается.");
  if (
    release.assets.macos &&
    !/^\d+\.\d+(?:\.\d+)?$/.test(release.assets.macos.minimumMacOS || "")
  )
    throw new Error("Не указана версия macOS.");
  return release;
}
export async function latestReleaseInfo({
  fetchImpl = fetch,
  key = releasePublicKey,
} = {}) {
  const response = await releaseFetch(RELEASE_URL, { fetchImpl });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Канал обновлений сейчас недоступен.");
  const envelope = JSON.parse(
    (await boundedBytes(response, 65536)).toString("utf8"),
  );
  return { envelope, release: verifyRelease(envelope, { key }) };
}
export async function latestRelease(options) {
  return (await latestReleaseInfo(options))?.release || null;
}
export async function downloadRelease(
  asset,
  target,
  { fetchImpl = fetch, progress = () => {} } = {},
) {
  const response = await releaseFetch(asset.url, {
    fetchImpl,
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error("Не удалось скачать релиз.");
  const file = await fs.open(target, "wx", 0o600),
    hash = crypto.createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > asset.bytes) throw new Error("Размер релиза не совпал.");
      hash.update(chunk);
      await file.writeFile(chunk);
      progress(bytes, asset.bytes);
    }
    if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256)
      throw new Error("Контрольная сумма релиза не совпала.");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => {});
    await fs.rm(target, { force: true });
    throw error;
  } finally {
    await file.close().catch(() => {});
  }
}
