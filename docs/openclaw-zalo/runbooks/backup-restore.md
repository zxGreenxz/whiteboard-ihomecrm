# OpenClaw Zalo - Backup And Restore

## Production gate

Before auto-reply, proactive, or sales-group production, verify the Supabase canonical
database has `RPO <= 15 minutes` and `RTO <= 4 hours`. If either is unknown or fails,
remain draft/manual limited. R2 durable object RPO is zero after verified upload and
accidental-delete restore RTO is at most four hours inside the seven-day tombstone grace.

The VPS, SQLite spool, and temporary media are not backups. Supabase is canonical; R2 is
the durable media store. Do not copy plaintext Zalo cookies/session snapshots.

## Quarterly restore drill

Run only against the DEMO organization and a test restore target:

```bash
infra/openclaw-zalo/scripts/restore-drill.sh \
  --runtime-env /srv/openclaw-runtime/cells/<demo-cell>/runtime.env \
  --adapter /opt/ihome-openclaw/bin/openclaw-recovery-adapter \
  --evidence-file /srv/openclaw-runtime/evidence/restore-<date>.json \
  --backup-observed-at <RFC3339> \
  --restore-started-at <RFC3339> \
  --restore-completed-at <RFC3339> \
  --r2-object-id <opaque-test-media-uuid> \
  --secret-source-dir /run/openclaw-rotation/<drill> \
  --session-strategy reencrypt \
  --drill-organization dddd0000-0000-4000-8000-000000000001
```

The adapter must restore a canonical DB test copy, simulate accidental R2 delete inside
`604800` seconds, restore and verify the object, then delete the fixture. The script
rotates runtime workload, maintenance/token, gateway token, and audit keys. Session AES
rotation uses authenticated atomic decrypt/re-encrypt (`temp write -> fsync -> rename`)
or `--session-strategy relogin`, which invalidates old material and requires a fresh QR.

Evidence contains actual RPO/RTO, IDs, booleans, strategy, and timestamps only. It must
prove no plaintext session snapshot exists and must contain no key, token, email, QR,
cookie, object key, message, prompt, or provider error.
