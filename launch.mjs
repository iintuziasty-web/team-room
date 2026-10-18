import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubSupervisor } from "./lib/hub-supervisor.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const storage = path.resolve(
  process.env.TEAM_ROOM_DATA_DIR || path.join(root, "storage", "community-hub"),
);
const supervisor = await new HubSupervisor({ root, storage }).init();
let closing = false;
for (const name of ["SIGINT", "SIGTERM"])
  process.on(name, () => {
    if (closing) return;
    closing = true;
    void supervisor.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
await supervisor.launch();
