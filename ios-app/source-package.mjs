import fs from "node:fs/promises";
import path from "node:path";

// Preserve the same relative imports as a checkout: ios-app/ sits beside lib/.
export async function prepareSourcePackage(root, destination) {
  await fs.mkdir(path.join(destination, "ios-app"), { recursive: true });
  for (const name of [
    "Sources",
    "resources",
    "TeamRoom.xcodeproj",
    "build.mjs",
    "source-package.mjs",
    "README.md",
  ]) {
    await fs.cp(
      path.join(root, name),
      path.join(destination, "ios-app", name),
      {
        recursive: true,
        filter: (filename) =>
          !["xcuserdata", ".DS_Store"].includes(path.basename(filename)) &&
          !path.basename(filename).startsWith("._"),
      },
    );
  }
  await fs.mkdir(path.join(destination, "lib"), { recursive: true });
  await fs.copyFile(
    path.join(root, "../lib/community-origin.mjs"),
    path.join(destination, "lib/community-origin.mjs"),
  );
  await fs.copyFile(
    path.join(root, "README.md"),
    path.join(destination, "README.md"),
  );
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    await fs.copyFile(
      path.join(root, "..", name),
      path.join(destination, name),
    );
}
