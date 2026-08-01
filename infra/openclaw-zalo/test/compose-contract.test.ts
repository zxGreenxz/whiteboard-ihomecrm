import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function text(path: string) {
  return readFile(resolve(root, path), "utf8");
}

async function yaml(path: string) {
  return parse(await text(path), { merge: true }) as Record<string, any>;
}

function mounts(service: Record<string, any>) {
  return [...(service.volumes ?? []), ...(service.tmpfs ?? [])];
}

describe("Task 19 rootless composition", () => {
  it("keeps application services on one internal-only network and only the broker dual-homed", async () => {
    const compose = await yaml("infra/openclaw-zalo/compose.cell.yaml");
    expect(compose.name).toBe("openclaw-zalo-${OPENCLAW_CELL_ID:?cell id required}");
    expect(compose.networks.application.internal).toBe(true);
    expect(compose.networks.egress.internal).toBe(false);
    expect(Object.keys(compose.services).sort()).toEqual([
      "bridge",
      "cell",
      "egress-broker",
      "maintenance",
    ]);

    for (const name of ["cell", "bridge", "maintenance"]) {
      expect(Object.keys(compose.services[name].networks)).toEqual(["application"]);
    }
    expect(Object.keys(compose.services["egress-broker"].networks).sort()).toEqual([
      "application",
      "egress",
    ]);
  });

  it("has no host publication, build context, Docker socket, source mount, or mutable pull", async () => {
    const compose = await yaml("infra/openclaw-zalo/compose.cell.yaml");
    const serialized = JSON.stringify(compose);
    expect(serialized).not.toMatch(/docker\.sock|host\.docker\.internal|\/var\/run\/docker/i);
    expect(serialized).not.toMatch(/9router|cli-proxy/i);

    for (const service of Object.values(compose.services) as Record<string, any>[]) {
      expect(service.ports).toBeUndefined();
      expect(service.expose).toBeUndefined();
      expect(service.build).toBeUndefined();
      expect(service.pull_policy).toBe("never");
      expect(service.image).toMatch(/@sha256:\$\{OPENCLAW_[A-Z_]+_IMAGE_SHA256:\?[a-z ]+\}$/);
      for (const mount of mounts(service)) {
        const rendered = typeof mount === "string" ? mount : JSON.stringify(mount);
        expect(rendered).not.toContain("/opt/openclaw-cell/vendor");
        expect(rendered).not.toContain("/home/node/.openclaw/npm/projects");
        expect(rendered).not.toContain("entrypoint.sh");
      }
    }
  });

  it("hardens every service and gives app containers proxy-only egress", async () => {
    const compose = await yaml("infra/openclaw-zalo/compose.cell.yaml");
    for (const service of Object.values(compose.services) as Record<string, any>[]) {
      expect(service.read_only).toBe(true);
      expect(service.cap_drop).toContain("ALL");
      expect(service.security_opt).toContain("no-new-privileges:true");
      expect(service.pids_limit).toBeGreaterThan(0);
      expect(service.restart).toBe("unless-stopped");
      expect(service.logging.options["max-size"]).toBe("10m");
      expect(service.logging.options["max-file"]).toBe("3");
    }
    for (const name of ["cell", "bridge", "maintenance"]) {
      const env = compose.services[name].environment;
      expect(env.HTTP_PROXY).toBe("http://egress-broker:8080");
      expect(env.HTTPS_PROXY).toBe("http://egress-broker:8080");
      expect(env.ALL_PROXY).toBe("http://egress-broker:8080");
      expect(env.NO_PROXY).toMatch(/localhost,127\.0\.0\.1/);
      expect(env.NO_PROXY).toContain("egress-broker");
    }
  });

  it("persists only ciphertext and keeps every session plaintext path on tmpfs", async () => {
    const compose = await yaml("infra/openclaw-zalo/compose.cell.yaml");
    const cell = compose.services.cell;
    expect(cell.command).toEqual([
      "/opt/openclaw-cell/entrypoint.sh",
      "node",
      "openclaw.mjs",
      "gateway",
    ]);
    expect(cell.volumes).toEqual([
      {
        type: "volume",
        source: "session-ciphertext",
        target: "/var/lib/openclaw-session",
        volume: { nocopy: true },
      },
    ]);
    expect(cell.tmpfs).toEqual(expect.arrayContaining([
      "/home/node/.openclaw/credentials:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=32m",
      "/home/node/.openclaw/agents:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=256m",
      "/home/node/.openclaw/internal-agent-runs:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=64m",
      "/run/openclaw:rw,noexec,nosuid,nodev,mode=0700,uid=1000,gid=1000,size=16m",
    ]));
    expect(cell.environment.OPENCLAW_SESSION_PLAINTEXT_ROOT).toBe(
      "/home/node/.openclaw/credentials",
    );
    expect(cell.environment.OPENCLAW_SESSION_CIPHERTEXT_ROOT).toBe(
      "/var/lib/openclaw-session",
    );
    expect(cell.environment.OPENCLAW_INTERNAL_AGENT_RUNS_DIR).toBe(
      "/home/node/.openclaw/internal-agent-runs",
    );
    expect(compose.secrets.openclaw_session_key.file).toBe(
      "/srv/openclaw-runtime/secrets/${OPENCLAW_CELL_ID}/openclaw_session_key",
    );
    expect(cell.secrets).toContainEqual({
      source: "openclaw_session_key",
      target: "openclaw_session_key",
      uid: "1000",
      gid: "1000",
      mode: 400,
    });
  });

  it("allows named volumes only for reviewed ciphertext, spool, and bounded temp data", async () => {
    const compose = await yaml("infra/openclaw-zalo/compose.cell.yaml");
    expect(Object.keys(compose.volumes).sort()).toEqual([
      "bridge-spool",
      "bridge-temp",
      "session-ciphertext",
    ]);
    expect(compose.services.bridge.volumes).toEqual([
      expect.objectContaining({ source: "bridge-spool", target: "/var/lib/openclaw-bridge/spool" }),
      expect.objectContaining({ source: "bridge-temp", target: "/var/lib/openclaw-bridge/temp" }),
    ]);
  });

  it("copies and integrity-locks the reviewed entrypoint without admitting hidden artifacts", async () => {
    const [dockerfile, dockerignore, lockText, entrypoint] = await Promise.all([
      text("services/openclaw-zalo-cell/Dockerfile"),
      text("services/openclaw-zalo-cell/.dockerignore"),
      text("services/openclaw-zalo-cell/image-lock.json"),
      text("services/openclaw-zalo-cell/scripts/entrypoint.sh"),
    ]);
    const lock = JSON.parse(lockText);
    expect(dockerfile).toContain(
      "COPY --chmod=0555 --chown=node:node scripts/entrypoint.sh /opt/openclaw-cell/entrypoint.sh",
    );
    expect(dockerignore.split(/\r?\n/)).toContain("!scripts/entrypoint.sh");
    const record = lock.inputs.find((item: any) => item.path === "scripts/entrypoint.sh");
    expect(record).toEqual(expect.objectContaining({ type: "blob", mode: "100755" }));
    expect(record.size).toBe(Buffer.byteLength(entrypoint));
    expect(record.sha256).toBe(createHash("sha256").update(entrypoint).digest("hex"));
  });

  it("keeps the test overlay non-publishing and explicitly enables isolation fixtures", async () => {
    const compose = await yaml("infra/openclaw-zalo/compose.test.yaml");
    for (const service of Object.values(compose.services) as Record<string, any>[]) {
      expect(service.ports).toBeUndefined();
      expect(service.build).toBeUndefined();
      expect(service.environment.OPENCLAW_ISOLATION_TEST).toBe("1");
    }
    expect(compose.services["egress-broker"].environment.OPENCLAW_DNS_REBINDING_TEST).toBe("1");
  });

  it("uses a closed exact-FQDN allowlist with no wildcard, IP literal, or runtime discovery", async () => {
    const allowlist = await yaml("infra/openclaw-zalo/egress/allowlist.yaml");
    expect(Object.keys(allowlist).sort()).toEqual(["destinations", "version"]);
    expect(allowlist.version).toBe(1);
    expect(allowlist.destinations.map((entry: any) => entry.host)).toEqual(expect.arrayContaining([
      "tryymsxyyckgbrmmvozx.supabase.co",
      "openclaw-media.chillhome.io.vn",
      "ai.chillhome.io.vn",
      "chat.zalo.me",
    ]));
    for (const entry of allowlist.destinations) {
      expect(Object.keys(entry).sort()).toEqual(["host", "port", "purpose"]);
      expect(entry.host).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/);
      expect(entry.host).not.toContain("*");
      expect(entry.host).not.toMatch(/^\d+(?:\.\d+){3}$/);
      expect(entry.port).toBe(443);
      expect(entry.purpose).toMatch(/\S/);
    }
  });
});
