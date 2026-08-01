# OpenClaw egress broker

This service is the only dual-homed outbound path for the private OpenClaw
application network. It implements an HTTP `CONNECT` proxy with a closed,
versioned FQDN/port allowlist. Ordinary forward-proxy HTTP requests are denied;
`GET /livez` is the only non-CONNECT route.

## Security contract

- Destinations must be canonical ASCII FQDNs with an exact reviewed port. IP
  literals, wildcard hosts, implied subdomains, single-label names and duplicate
  entries are rejected.
- Every CONNECT request performs a fresh DNS lookup. Every returned address must
  be globally routable, and the outbound socket dials the validated IP literal so
  the hostname cannot be resolved a second time between policy and connect.
- Mixed public/private answers fail closed. Loopback, RFC1918, link-local, CGNAT,
  metadata, multicast, unspecified, documentation, reserved, IPv6 ULA, host
  gateway and configured lateral-container ranges are denied.
- The original allowlisted FQDN remains the TLS authority/SNI name used by the
  client. The broker never substitutes the pinned IP as the TLS hostname, so the
  client validates the certificate for the reviewed FQDN end to end.
- A retry or redirect creates a new CONNECT request and therefore repeats exact
  allowlist, DNS and public-address validation. No decision is cached.
- Logs contain structured event codes, reviewed host/port and public pinned IP
  only. Request headers, proxy credentials and raw CONNECT authority values are
  never logged; reusable redaction helpers cover diagnostics outside that path.

## Allowlist

Mount a read-only YAML file at `OPENCLAW_EGRESS_ALLOWLIST_PATH` (default
`/etc/openclaw-egress/allowlist.yaml`). The schema is closed and versioned:

```yaml
version: 1
destinations:
  - host: tryymsxyyckgbrmmvozx.supabase.co
    port: 443
    purpose: supabase control plane
  - host: openclaw-media.chillhome.io.vn
    port: 443
    purpose: private media gateway
  - host: ai.chillhome.io.vn
    port: 443
    purpose: independent model endpoint
```

Runtime discovery, YAML aliases, unknown document fields and wildcard syntax are
not accepted.

## Runtime configuration

```text
OPENCLAW_EGRESS_HOST=0.0.0.0
OPENCLAW_EGRESS_PORT=3128
OPENCLAW_EGRESS_ALLOWLIST_PATH=/etc/openclaw-egress/allowlist.yaml
OPENCLAW_EGRESS_HOST_GATEWAY_ADDRESSES=172.17.0.1
OPENCLAW_EGRESS_CONTAINER_NETWORK_CIDRS=172.20.0.0/16,fd00:20::/64
```

The gateway-address and container-CIDR lists are optional additional topology
guards. Values are comma-separated IP literals/CIDRs and malformed entries stop
startup. The container runs as the image's unprivileged `node` user and requires
no writable runtime path.

## Build and test

Use Node `>=24.15.0 <25` and the reviewed npm CLI:

```sh
npm ci
npm run typecheck
npm test
npm run build
```
