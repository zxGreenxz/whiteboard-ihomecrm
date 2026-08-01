FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ENV NODE_ENV=production \
    OPENCLAW_EGRESS_HOST=0.0.0.0 \
    OPENCLAW_EGRESS_PORT=3128 \
    OPENCLAW_EGRESS_ALLOWLIST_PATH=/etc/openclaw-egress/allowlist.yaml
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3128
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.OPENCLAW_EGRESS_PORT||'3128')+'/livez',(response)=>process.exit(response.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
