FROM ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f AS install
ARG SOURCE_DATE_EPOCH
USER node
COPY --chown=node:node image-lock.json /opt/openclaw-cell/image-lock.json
COPY --chown=node:node vendor/zalouser-bridge/FORK.json /opt/openclaw-cell/vendor/FORK.json
COPY --chown=node:node vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz /opt/openclaw-cell/vendor/openclaw-zalouser-2026.7.1.tgz
COPY --chmod=0555 --chown=node:node scripts/install-vendored-zalouser.sh /opt/openclaw-cell/install-vendored-zalouser.sh
COPY --chown=node:node scripts/normalize-openclaw-install.mjs /opt/openclaw-cell/normalize-openclaw-install.mjs
RUN --network=none node -e 'const m=/^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(process.version);if(!m||Number(m[1])<15){console.error("Official stable Node >=24.15.0 <25 is required");process.exit(1)}' \
    && test "$SOURCE_DATE_EPOCH" = "1785062400" \
    && test ! -e /tmp/npm-empty \
    && mkdir /tmp/npm-empty \
    && test -z "$(find /tmp/npm-empty -mindepth 1 -print -quit)" \
    && /opt/openclaw-cell/install-vendored-zalouser.sh --offline --cache /tmp/npm-empty --no-fallback \
    && node /opt/openclaw-cell/normalize-openclaw-install.mjs --source-date-epoch "$SOURCE_DATE_EPOCH"

FROM ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f AS runtime
USER node
COPY --from=install --chown=node:node /home/node/.openclaw/npm/projects/zalouser /home/node/.openclaw/npm/projects/zalouser
COPY --chown=node:node session-crypto/dist/package.json /opt/openclaw-cell/session-crypto/dist/package.json
COPY --chown=node:node session-crypto/dist/crypto.js /opt/openclaw-cell/session-crypto/dist/crypto.js
COPY --chown=node:node session-crypto/dist/daemon.js /opt/openclaw-cell/session-crypto/dist/daemon.js
COPY --chown=node:node config/openclaw.json.tmpl /opt/openclaw-cell/openclaw.json.tmpl
