# Reviewed ZaloUser fork harness

This directory freezes the exact OpenClaw `@openclaw/zalouser@2026.7.1` source snapshot,
its reviewed provenance and license inputs, the ordered iHomeCRM patch series, and the
reproducible internal artifact.

Use official stable Node 24.15.0 or later within major 24. `npm run verify` reacquires and
verifies the upstream inputs, prepares a unique ignored work tree from the committed source
snapshot, applies the patches and bridge overlay, builds and packs twice, then verifies a
clean offline installed tree. The npm lifecycle name `prepare` is intentionally unused;
preparation is explicit through `npm run vendor:prepare`.

`FORK.json` is external control metadata and is never included in the internal package.
