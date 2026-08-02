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

Session AES rotation must either use the committed session-crypto `rotate` operation for
atomic authenticated decrypt/re-encrypt with a new nonce and `fsync + rename`, or remove
old encrypted session material and force fresh QR re-login. Never restore a plaintext
cookie/session snapshot. Emergency suspected compromise also increments session/control
generation, revokes challenges/tickets, fences old workload, and keeps outbound paused
until owner review.
