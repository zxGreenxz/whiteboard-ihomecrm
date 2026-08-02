# OpenClaw Zalo - Secret Rotation

Inventory stores only secret reference, owner, generation, creation/rotation timestamps,
and dependent service. Never store values in Git, evidence, stdout, shell history, or
ticket text.

Rotate in this order when planned: new workload/maintenance credential, acquire higher
fence, activate new credential, revoke old credential/lease, rotate gateway device token,
audit signing key, model key, QR encryption key, bridge HMAC, then session AES key.

Use runner-owned `0400` source files and the exact rootless socket:

```bash
DOCKER_HOST=unix:///run/user/<runner-uid>/docker.sock \
infra/openclaw-zalo/scripts/rotate-secrets.sh \
  --runtime-env /srv/openclaw-runtime/cells/<cell>/runtime.env \
  --name <reviewed-secret-name> \
  --source-file /run/openclaw-rotation/<generation>/<name>
```

## Watchdog envelope signing keys (Ed25519)

The watchdog Worker and the host guard authenticate to `openclaw-watchdog` with a signed
envelope, not a shared bearer, so rotation is generation-based and needs no downtime:

1. Generate the new key pair for that signer only
   (`openssl genpkey -algorithm ed25519 -out <signer>-<generation>.pem`).
2. ADD the new generation to `OPENCLAW_WATCHDOG_ENVELOPE_KEYS_JSON` with its
   `activatesAt`, its `organizationId`, and the narrowest `allowedOperations`
   (Worker: `health.probe`,`health.record`; host guard: `host.guard`). Never edit an
   existing generation in place - an in-place edit invalidates envelopes already in
   flight and destroys the audit trail of which key signed what.
3. Install the private half: Worker secret `OPENCLAW_WATCHDOG_SIGNING_KEY_PKCS8_BASE64`
   plus `OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION`; host guard `0400` file
   `/srv/openclaw-runtime/secrets/<cell>/openclaw_watchdog_envelope_key.pem` plus
   `OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION` in the cell `runtime.env`.
4. Confirm traffic on the new generation, then set `retiresAt` on the old generation.
   Suspected compromise sets `revokedAt` instead, which denies immediately.

Only public keys ever reach the Edge. Private keys never appear in argv, environment
dumps, evidence, or logs; the host guard signs by handing `openssl` a file path.

Session AES rotation must either use the committed session-crypto `rotate` operation for
atomic authenticated decrypt/re-encrypt with a new nonce and `fsync + rename`, or remove
old encrypted session material and force fresh QR re-login. Never restore a plaintext
cookie/session snapshot. Emergency suspected compromise also increments session/control
generation, revokes challenges/tickets, fences old workload, and keeps outbound paused
until owner review.
