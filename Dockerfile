# Build stage: install production dependencies only.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime stage.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Alpine's node image ships an unprivileged `node` user; use it.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# Writable data directory for packs and run state. Mount a volume here on any
# host that supports one; on hosts without persistent storage this directory is
# recreated on every deploy.
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data

USER node
EXPOSE 3000

# Containers have no shell health checker by default; this lets Docker, Fly,
# Koyeb and Northflank all probe the same endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
