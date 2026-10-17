#!/bin/sh
set -eu
task_data_root="${TEAM_ROOM_DATA_DIR:-/data}"
mkdir -p "$task_data_root"
if [ -f "$task_data_root/team-data.seed.json" ]; then
  mv "$task_data_root/team-data.seed.json" "$task_data_root/team-data.json"
fi
# Fix only entries with the wrong owner: a full recursive chown walks and
# rewrites metadata for every file on the volume at each start.
if ! find "$task_data_root" \( ! -user node -o ! -group node \) -exec chown -h node:node {} + 2>/dev/null; then
  chown -R node:node "$task_data_root"
fi
exec su-exec node "$@"
