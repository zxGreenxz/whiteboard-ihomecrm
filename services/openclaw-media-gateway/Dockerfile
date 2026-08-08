FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
# The gateway has no runtime dependencies at all - it is Node's own crypto, http
# and fs - so nothing is installed into the runtime image. The compiler is the
# single build-stage tool and is pinned; it never reaches the stage below.
# They are installed into the project rather than run through `npx`, because
# tsc resolves `types: ["node"]` against ./node_modules/@types and npx stages
# packages somewhere else entirely.
RUN npm install --no-save --no-audit --no-fund typescript@5.8.3 @types/node@22.16.5 \n    && ./node_modules/.bin/tsc -p tsconfig.json

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ENV NODE_ENV=production \
    OPENCLAW_MEDIA_HOST=0.0.0.0 \
    OPENCLAW_MEDIA_PORT=8080 \
    OPENCLAW_MEDIA_STORAGE_ROOT=/var/lib/openclaw-media/objects \
    OPENCLAW_MEDIA_TICKET_PUBLIC_KEY_FILE=/run/secrets/openclaw_media_ticket_public_key \
    OPENCLAW_MEDIA_RECEIPT_PRIVATE_KEY_FILE=/run/secrets/openclaw_media_receipt_private_key
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /var/lib/openclaw-media/objects && chown -R node:node /var/lib/openclaw-media \
    && chmod 0700 /var/lib/openclaw-media /var/lib/openclaw-media/objects

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENCLAW_MEDIA_PORT||'8080')+'/healthz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/bin/gateway.js"]
