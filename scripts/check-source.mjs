#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./source-files.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const { files } = await sourceFiles(root);
let checked = 0;
const failures = [];
for (const file of files.filter((file) => /\.(?:mjs|js)$/.test(file))) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    checked++;
  } catch (error) {
    failures.push(file + ": " + String(error.stderr || error.message));
  }
  const source = await fs.readFile(path.join(root, file), "utf8");
  for (const match of source.matchAll(
    /(?:^|\n)import\s+(?:[^'";]*?\s+from\s*)?['"](\.[^'"]+)['"]/g,
  )) {
    try {
      await fs.access(
        path.resolve(root, path.dirname(file), match[1].split(/[?#]/)[0]),
      );
    } catch {
      failures.push(file + ": missing import " + match[1]);
    }
  }
}
for (const file of files.filter((file) => /\.html$/.test(file))) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  for (const match of source.matchAll(
    /<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g,
  )) {
    const value = match[1].split(/[?#]/)[0];
    if (!value || /^(?:[a-z]+:|\/\/)/i.test(value)) continue;
    const target = value.startsWith("/")
      ? path.join(root, "public", value)
      : path.resolve(root, path.dirname(file), value);
    try {
      await fs.access(target);
    } catch {
      failures.push(file + ": missing asset " + value);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Source check passed: ${checked} JavaScript files, local imports and HTML assets.`,
  );
