FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ENV NODE_ENV=production \
    NODE_USE_ENV_PROXY=1 \
    OPENCLAW_BRIDGE_HOST=0.0.0.0 \
    OPENCLAW_BRIDGE_PORT=8080 \
    OPENCLAW_SPOOL_PATH=/var/lib/openclaw-bridge/spool.db \
    OPENCLAW_QR_ENCRYPTION_KEY_FILE=/run/secrets/openclaw_qr_encryption_key \
    OPENCLAW_MEDIA_TEMP_DIRECTORY=/var/lib/openclaw-bridge/temp
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /var/lib/openclaw-bridge/temp && chown -R node:node /var/lib/openclaw-bridge

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENCLAW_BRIDGE_PORT||'8080')+'/livez').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]
