#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./source-files.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const { files, tracked } = await sourceFiles(root);
const forbiddenNames = new Set([
  "team-data.json",
  "device-config.json",
  "local-client.json",
  "connection-status.json",
  "last-process-stop.json",
  "running-jobs.json",
  "pending-results.json",
  "security-key",
  "security-config.json",
  "mcp-vault.json",
  "push-notifications.json",
  "session-board.json",
  "instance.json",
]);
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "provider secret",
    /\b(?:sk-ant-|sk-proj-|gh[pousr]_|github_pat_|ntn_)[A-Za-z0-9_-]{20,}\b/,
  ],
  ["Telegram bot token", /\b\d{8,13}:[A-Za-z0-9_-]{30,}\b/],
  ["machine-specific home", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  [
    "concrete device/session UUID",
    /\b[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/i,
  ],
];
const errors = [];
for (const relative of files) {
  const filename = path.join(root, relative),
    name = path.basename(relative),
    stat = await fs.lstat(filename);
  if (stat.isSymbolicLink()) {
    errors.push(relative + ": symbolic link");
    continue;
  }
  if (
    forbiddenNames.has(name) ||
    /\.(?:pem|key|p12|mobileprovision|log|jsonl|zip|dmg|ipa)$/.test(name) ||
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    relative
      .split(path.sep)
      .some((part) =>
        [
          "storage",
          "node_modules",
          "dist",
          ".build-cache",
          "xcuserdata",
        ].includes(part),
      )
  ) {
    errors.push(relative + ": installation data or artifact");
    continue;
  }
  if (/\.(?:woff2|png)$/.test(name)) continue;
  const content = await fs.readFile(filename, "utf8");
  for (const [label, pattern] of rules)
    if (pattern.test(content)) errors.push(relative + ": " + label);
}
// These are architectural assertions, not a replacement for source review.
const desktop = await fs.readFile(
  path.join(root, "mac-app/connector/instance.mjs"),
  "utf8",
);
if (
  !desktop.includes("config.hubUrl||process.env.TEAMROOM_HUB_URL") ||
  /https:\/\/[a-z0-9.-]+/i.test(desktop)
)
  errors.push("Native origin must be supplied by the installation");
const integration = await fs.readFile(
  path.join(root, "install-integration.mjs"),
  "utf8",
);
if (!integration.includes("'teamroom-community'"))
  errors.push("Transfer helper must use the community namespace");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "Public source audit passed: " +
      files.length +
      " " +
      (tracked ? "tracked and untracked source" : "source") +
      " files. No runtime data, keys, fixed device IDs or machine home paths detected.",
  );
