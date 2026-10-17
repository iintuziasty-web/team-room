FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
# Imported workspaces may use owner-only modes; the runtime runs as node.
RUN chmod -R a+rX /app
ENV HOST=0.0.0.0 PORT=4173 TEAM_ROOM_HUB_ONLY=1 TEAM_ROOM_DATA_DIR=/data
RUN mkdir /data && chown node:node /data
RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
EXPOSE 4173
# Heap ceiling for large self-hosted archives; memory is allocated as needed.
CMD ["node", "--max-old-space-size=4096", "server.mjs"]
