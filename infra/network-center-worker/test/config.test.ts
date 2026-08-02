import { describe, expect, it } from "vitest";

import { ConfigError, loadWorkerConfig } from "../src/config.js";

const validEnvironment = {
  NETWORK_CENTER_EDGE_URL: "https://example.supabase.co/functions/v1/network-center-worker",
  NETWORK_CENTER_WORKER_KEY: "vultr-network-center-01",
  NETWORK_CENTER_WORKER_SECRET_FILE: "/run/secrets/worker-secret",
  NETWORK_CENTER_CREDENTIALS_FILE: "/run/secrets/router-credentials.json",
  NETWORK_CENTER_BACKUP_DIR: "/var/lib/network-center/backups",
  NETWORK_CENTER_POLL_INTERVAL_MS: "60000",
  NETWORK_CENTER_RELEASE_SHA: "a".repeat(40),
  NETWORK_CENTER_POLL_CONCURRENCY: "3",
  NETWORK_CENTER_COMMAND_CONCURRENCY: "3",
  NETWORK_CENTER_COMMAND_CLAIM_LIMIT: "3",
  NETWORK_CENTER_SFTP_CONCURRENCY: "1",
  NETWORK_CENTER_EMERGENCY_STOP: "false",
};

const secureFiles = {
  readText(path: string) {
    if (path.endsWith("worker-secret")) return "w".repeat(48);
    if (path.endsWith("router-credentials.json")) return "{}";
    throw new Error("missing fixture");
  },
  mode() {
    return 0o600;
  },
};

describe("worker configuration", () => {
  it("loads secrets only from secure mounted files", () => {
    const config = loadWorkerConfig({
      env: validEnvironment,
      argv: ["node", "dist/main.js"],
      files: secureFiles,
      platform: "linux",
    });

    expect(config.edgeUrl.href).toBe(
      "https://example.supabase.co/functions/v1/network-center-worker",
    );
    expect(config.workerSecret).toHaveLength(48);
    expect(config.workerKey).toBe("vultr-network-center-01");
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.releaseSha).toBe("a".repeat(40));
    expect(config.pollConcurrency).toBe(3);
    expect(config.commandConcurrency).toBe(3);
    expect(config.commandClaimLimit).toBe(3);
    expect(config.sftpConcurrency).toBe(1);
    expect(config.emergencyStop).toBe(false);
    expect(config.credentials.size).toBe(0);
  });

  it("rejects an unreviewed release identity and concurrency above the deployment envelope", () => {
    expect(() => loadWorkerConfig({
      env: { ...validEnvironment, NETWORK_CENTER_RELEASE_SHA: "main" },
      argv: ["node", "dist/main.js"],
      files: secureFiles,
      platform: "linux",
    })).toThrow(/RELEASE_SHA/i);

    for (const [name, value] of [
      ["NETWORK_CENTER_POLL_CONCURRENCY", "4"],
      ["NETWORK_CENTER_COMMAND_CONCURRENCY", "4"],
      ["NETWORK_CENTER_COMMAND_CLAIM_LIMIT", "4"],
      ["NETWORK_CENTER_SFTP_CONCURRENCY", "2"],
    ] as const) {
      expect(() => loadWorkerConfig({
        env: { ...validEnvironment, [name]: value },
        argv: ["node", "dist/main.js"],
        files: secureFiles,
        platform: "linux",
      })).toThrow(/safe range/i);
    }

    expect(() => loadWorkerConfig({
      env: { ...validEnvironment, NETWORK_CENTER_MAX_CONCURRENCY: "15" },
      argv: ["node", "dist/main.js"],
      files: secureFiles,
      platform: "linux",
    })).toThrow(/MAX_CONCURRENCY.*removed|removed.*MAX_CONCURRENCY/i);
  });

  it("keeps the worker key as local labeling only and matches the database key format", () => {
    expect(() => loadWorkerConfig({
      env: { ...validEnvironment, NETWORK_CENTER_WORKER_KEY: "UPPER:scope" },
      argv: ["node", "dist/main.js"],
      files: secureFiles,
      platform: "linux",
    })).toThrow(/WORKER_KEY/i);
  });

  it("rejects inline secrets, CLI arguments, and world-readable secret files", () => {
    expect(() => loadWorkerConfig({
      env: { ...validEnvironment, NETWORK_CENTER_WORKER_SECRET: "do-not-accept" },
      argv: ["node", "dist/main.js"],
      files: secureFiles,
      platform: "linux",
    })).toThrow(ConfigError);

    expect(() => loadWorkerConfig({
      env: validEnvironment,
      argv: ["node", "dist/main.js", "--secret=do-not-accept"],
      files: secureFiles,
      platform: "linux",
    })).toThrow(/command-line/i);

    expect(() => loadWorkerConfig({
      env: validEnvironment,
      argv: ["node", "dist/main.js"],
      files: { ...secureFiles, mode: () => 0o644 },
      platform: "linux",
    })).toThrow(/0600/i);
  });

  it("resolves SSH keys and backup passwords from secure file references", () => {
    const contents: Record<string, string> = {
      "/run/secrets/worker-secret": "w".repeat(48),
      "/run/secrets/router-credentials.json": JSON.stringify({
        "router/demo": {
          username: "network-center",
          privateKeyFile: "/run/secrets/router-demo-key",
          backupPasswordFile: "/run/secrets/router-demo-backup-password",
        },
      }),
      "/run/secrets/router-demo-key": "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
      "/run/secrets/router-demo-backup-password": "backup-password-long-enough",
    };
    const config = loadWorkerConfig({
      env: validEnvironment,
      argv: ["node", "dist/main.js"],
      files: { readText: (path) => contents[path] ?? "", mode: () => 0o600 },
      platform: "linux",
    });

    expect(config.credentials.get("router/demo")).toMatchObject({
      username: "network-center",
      privateKey: expect.stringContaining("OPENSSH PRIVATE KEY"),
      backupPassword: "backup-password-long-enough",
    });
  });
});
