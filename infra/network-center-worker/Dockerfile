FROM node:20.19.4-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:20.19.4-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384

RUN groupadd --gid 10001 network-center \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin network-center

WORKDIR /app
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "const fs=require('fs');const p='/tmp/network-center-worker-health';const s=fs.statSync(p);if(Date.now()-s.mtimeMs>180000)process.exit(1)"

CMD ["node", "dist/main.js"]
