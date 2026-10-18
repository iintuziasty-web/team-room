import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "storage",
  ".build-cache",
  "dist",
  ".playwright-mcp",
  "xcuserdata",
  "Assets.xcassets",
]);

// Use the candidate working tree, including new files and excluding deletions.
// A source archive has no Git metadata, so it must also work without Git.
export async function sourceFiles(root) {
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    if (path.resolve(top) === path.resolve(root)) {
      const deleted = new Set(git(["ls-files", "--deleted", "-z"]).split("\0"));
      const files = [
        ...new Set(
          git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
            .split("\0")
            .filter((file) => file && !deleted.has(file)),
        ),
      ];
      return { files, tracked: true };
    }
  } catch {
    /* Git is optional for downloaded source archives. */
  }
  const files = [];
  async function walk(relative = "") {
    for (const entry of await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (
        ignoredDirectories.has(entry.name) ||
        entry.name === ".env" ||
        (entry.name.startsWith(".env.") && entry.name !== ".env.example")
      )
        continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else files.push(name);
    }
  }
  await walk();
  return { files, tracked: false };
}
