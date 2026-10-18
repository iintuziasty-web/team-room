import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
const MAX = 128 * 1024 * 1024;
export function releasePath(name) {
  if (
    typeof name !== "string" ||
    name.length > 200 ||
    !name ||
    /[^a-zA-Z0-9_./@+-]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..") ||
    name
      .split("/")
      .some((part) =>
        [".git", "node_modules", "storage", "dist", ".env"].includes(part),
      )
  )
    throw new Error("Недопустимый путь в релизе.");
  return name;
}
const octal = (header, at, length, value) =>
  header.write(
    value.toString(8).padStart(length - 1, "0") + "\0",
    at,
    length,
    "ascii",
  );
export function packRelease(entries) {
  const chunks = [];
  let total = 0;
  for (const entry of entries) {
    const name = releasePath(entry.path);
    if (Buffer.byteLength(name) > 100)
      throw new Error("Слишком длинное имя файла релиза.");
    const bytes = Buffer.from(entry.bytes);
    total += bytes.length;
    if (total > MAX) throw new Error("Серверный релиз слишком большой.");
    const h = Buffer.alloc(512);
    h.write(name);
    octal(h, 100, 8, entry.executable ? 0o755 : 0o600);
    octal(h, 108, 8, 0);
    octal(h, 116, 8, 0);
    octal(h, 124, 12, bytes.length);
    octal(h, 136, 12, 0);
    h.fill(32, 148, 156);
    h[156] = 48;
    h.write("ustar\0", 257);
    h.write("00", 263);
    octal(
      h,
      148,
      8,
      [...h].reduce((n, b) => n + b, 0),
    );
    chunks.push(h, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
}
export function unpackRelease(archive) {
  const bytes = gunzipSync(archive, { maxOutputLength: MAX }),
    entries = [],
    names = new Set();
  let offset = 0,
    total = 0;
  while (offset + 512 <= bytes.length) {
    const h = bytes.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const text = (at, size) =>
      h
        .subarray(at, at + size)
        .toString("utf8")
        .split("\0")[0];
    const number = (at, size) => {
      const value = text(at, size).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("Повреждён архив релиза.");
      return parseInt(value, 8);
    };
    const copy = Buffer.from(h);
    copy.fill(32, 148, 156);
    if (
      number(148, 8) !== [...copy].reduce((n, b) => n + b, 0) ||
      ![0, 48].includes(h[156]) ||
      text(345, 155)
    )
      throw new Error("Неподдерживаемый архив релиза.");
    const name = releasePath(text(0, 100)),
      size = number(124, 12);
    offset += 512;
    total += size;
    if (
      names.has(name) ||
      entries.length >= 10000 ||
      total > MAX ||
      !Number.isSafeInteger(size) ||
      offset + size > bytes.length
    )
      throw new Error("Повреждён архив релиза.");
    names.add(name);
    entries.push({
      path: name,
      bytes: Buffer.from(bytes.subarray(offset, offset + size)),
      executable: Boolean(number(100, 8) & 0o111),
    });
    offset += Math.ceil(size / 512) * 512;
  }
  if (
    !entries.some((entry) => entry.path === "server.mjs") ||
    !entries.some((entry) => entry.path === "package-lock.json")
  )
    throw new Error("Серверный релиз неполный.");
  return entries;
}
export async function extractRelease(bytes, directory) {
  const entries = unpackRelease(bytes);
  await fs.mkdir(directory, { mode: 0o700 });
  for (const entry of entries) {
    const file = path.join(directory, entry.path);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, entry.bytes, {
      flag: "wx",
      mode: entry.executable ? 0o700 : 0o600,
    });
  }
  return entries;
}
