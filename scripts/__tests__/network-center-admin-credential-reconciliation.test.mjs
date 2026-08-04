import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as admin from "../network-center-admin.mjs";

const WORKER_KEY = "worker-demo-01";
const OTHER_WORKER_KEY = "worker-demo-02";
const WORKER_ID = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const BUILDING_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const EXPIRES_AT = "2026-08-30T00:00:00.000Z";
const NOT_BEFORE = "2026-08-02T00:00:00.000Z";

const assignments = [{
  organizationId: ORGANIZATION_ID,
  buildingId: BUILDING_ID,
  deviceId: DEVICE_ID,
  enabled: true,
  canPoll: true,
  canInventory: true,
  canExecute: false,
}];

async function withSecretTarget(run) {
  const directory = await mkdtemp(join(tmpdir(), "network-center-admin-reconcile-"));
  const outputPath = join(directory, "worker.secret");
  try {
    return await run({ directory, outputPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function credentialStatus({ fingerprint, workerKey = WORKER_KEY, found = true } = {}) {
  return {
    found,
    workerKey,
    credentialFingerprint: fingerprint,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
  };
}

function httpResponse(status, body, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function rpcName(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").at(-1));
}

function authoritativeMutationResponse(operation, args) {
  if (operation === "provision") {
    return {
      workerId: WORKER_ID,
      workerKey: args.p_worker_key,
      status: "ACTIVE",
      credentialFingerprint: args.p_fingerprint,
      assignmentCount: args.p_assignments.length,
    };
  }
  return {
    workerId: WORKER_ID,
    workerKey: args.p_worker_key,
    credentialFingerprint: args.p_fingerprint,
    notBefore: args.p_not_before,
    expiresAt: args.p_expires_at,
  };
}

test("ships exact service-only credential reconciliation without digest projection", () => {
  const migrationPath = new URL(
    "../../supabase/migrations/20260729137000_network_center_admin_credential_reconciliation.sql",
    import.meta.url,
  );
  assert.equal(existsSync(migrationPath), true, "credential reconciliation migration missing");
  if (!existsSync(migrationPath)) return;
  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /network_center_admin_worker_credential_status_v1/i);
  assert.match(sql, /p_worker_key\s+text[\s\S]*p_fingerprint\s+text/i);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
  assert.doesNotMatch(
    sql.slice(sql.search(/network_center_admin_worker_credential_status_v1/i)),
    /secret_digest|credential_digest|plaintext_secret/i,
  );
});

test("provision reconciles commit-then-disconnect and preserves the only secret", async () => {
  await withSecretTarget(async ({ outputPath }) => {
    let fingerprint;
    let digest;
    let secret;
    const rpc = async (name, args) => {
      if (name === "network_center_admin_provision_worker_v1") {
        fingerprint = args.p_fingerprint;
        digest = args.p_secret_digest;
        secret = (await readFile(outputPath, "utf8")).trim();
        const error = new Error(`socket lost ${secret} ${digest}`);
        error.outcome = "UNKNOWN";
        throw error;
      }
      if (name === "network_center_admin_worker_credential_status_v1") {
        assert.equal(args.p_worker_key, WORKER_KEY);
        assert.equal(args.p_fingerprint, fingerprint);
        return credentialStatus({ fingerprint });
      }
      if (name === "network_center_admin_status_v1") return { workers: [], assignments: [] };
      throw new Error(`unexpected RPC ${name}`);
    };

    const result = await admin.provisionWorker({
      workerKey: WORKER_KEY,
      displayName: "Demo worker",
      outputPath,
      expiresAt: EXPIRES_AT,
      assignments,
      rpc,
    });

    assert.equal(existsSync(outputPath), true);
    assert.equal(result.reconciled, true);
    assert.equal(result.credentialFingerprint, fingerprint);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(digest), false);
  });
});

test("rotation reconciles commit-then-disconnect for the exact worker and fingerprint", async () => {
  await withSecretTarget(async ({ outputPath }) => {
    let fingerprint;
    const rpc = async (name, args) => {
      if (name === "network_center_admin_rotate_worker_credential_v1") {
        fingerprint = args.p_fingerprint;
        const error = new Error(`response lost ${args.p_secret_digest}`);
        error.outcome = "UNKNOWN";
        throw error;
      }
      if (name === "network_center_admin_worker_credential_status_v1") {
        assert.equal(args.p_worker_key, WORKER_KEY);
        assert.equal(args.p_fingerprint, fingerprint);
        return credentialStatus({ fingerprint });
      }
      if (name === "network_center_admin_status_v1") return { workers: [] };
      throw new Error(`unexpected RPC ${name}`);
    };

    const result = await admin.rotateWorker({
      workerKey: WORKER_KEY,
      outputPath,
      notBefore: NOT_BEFORE,
      expiresAt: EXPIRES_AT,
      rpc,
    });

    assert.equal(existsSync(outputPath), true);
    assert.equal(result.reconciled, true);
    assert.equal(result.credentialFingerprint, fingerprint);
  });
});

test("exact credential readback reconciles success even when broad status is unavailable", async () => {
  await withSecretTarget(async ({ outputPath }) => {
    let fingerprint;
    let upstreamStatus;
    const rpc = async (name, args) => {
      if (name === "network_center_admin_provision_worker_v1") {
        fingerprint = args.p_fingerprint;
        const error = new Error("response lost after commit");
        error.outcome = "UNKNOWN";
        throw error;
      }
      if (name === "network_center_admin_worker_credential_status_v1") {
        assert.equal(args.p_worker_key, WORKER_KEY);
        assert.equal(args.p_fingerprint, fingerprint);
        upstreamStatus = credentialStatus({ fingerprint });
        return upstreamStatus;
      }
      if (name === "network_center_admin_status_v1") {
        throw new Error("broad status unavailable");
      }
      throw new Error(`unexpected RPC ${name}`);
    };

    const result = await admin.provisionWorker({
      workerKey: WORKER_KEY,
      displayName: "Demo worker",
      outputPath,
      expiresAt: EXPIRES_AT,
      assignments,
      rpc,
    });

    assert.equal(result.reconciled, true);
    assert.notStrictEqual(result.credentialStatus, upstreamStatus);
    assert.deepEqual(result.credentialStatus, credentialStatus({ fingerprint }));
    assert.equal(existsSync(outputPath), true);
  });
});

test("unknown or mismatched reconciliation preserves the secret and redacts credential material", async () => {
  for (const statusFactory of [
    ({ fingerprint }) => credentialStatus({ fingerprint, found: false }),
    ({ fingerprint }) => credentialStatus({ fingerprint, workerKey: OTHER_WORKER_KEY }),
    ({ fingerprint }) => ({
      ...credentialStatus({ fingerprint }),
      notBefore: "not-a-timestamp",
    }),
    ({ fingerprint, secret, digest }) => ({
      ...credentialStatus({ fingerprint }),
      secretDigest: digest,
      credentialSecret: secret,
    }),
    () => ({ malformed: true }),
    () => { throw new Error("readback unavailable"); },
  ]) {
    await withSecretTarget(async ({ outputPath }) => {
      let secret;
      let digest;
      let fingerprint;
      const rpc = async (name, args) => {
        if (name === "network_center_admin_provision_worker_v1") {
          digest = args.p_secret_digest;
          fingerprint = args.p_fingerprint;
          secret = (await readFile(outputPath, "utf8")).trim();
          const error = new Error(`ambiguous ${secret} ${digest}`);
          error.outcome = "UNKNOWN";
          throw error;
        }
        if (name === "network_center_admin_worker_credential_status_v1") {
          assert.equal(args.p_worker_key, WORKER_KEY);
          assert.equal(args.p_fingerprint, fingerprint);
          return statusFactory({ fingerprint, secret, digest });
        }
        throw new Error(`unexpected RPC ${name}`);
      };

      const error = await admin.provisionWorker({
        workerKey: WORKER_KEY,
        displayName: "Demo worker",
        outputPath,
        expiresAt: EXPIRES_AT,
        assignments,
        rpc,
      }).catch((cause) => cause);

      assert.equal(existsSync(outputPath), true);
      assert.equal(error?.code, "CREDENTIAL_OUTCOME_UNKNOWN");
      assert.equal(String(error?.message).includes(secret), false);
      assert.equal(String(error?.message).includes(digest), false);
      assert.match(String(error?.message), new RegExp(fingerprint));
    });
  }
});

test("authoritative RPC rejection removes the unused generated secret", async () => {
  await withSecretTarget(async ({ outputPath }) => {
    const rpc = async (name) => {
      assert.equal(name, "network_center_admin_provision_worker_v1");
      const error = new Error("request rejected before commit");
      error.outcome = "REJECTED";
      throw error;
    };

    await assert.rejects(admin.provisionWorker({
      workerKey: WORKER_KEY,
      displayName: "Demo worker",
      outputPath,
      expiresAt: EXPIRES_AT,
      assignments,
      rpc,
    }), /rejected before commit/i);
    assert.equal(existsSync(outputPath), false);
  });
});

test("gateway HTTP failures reconcile provision and preserve the generated secret", async () => {
  assert.equal(typeof admin.createRpcTransport, "function");
  if (typeof admin.createRpcTransport !== "function") return;

  for (const gatewayStatus of [500, 502, 503, 504, 524]) {
    await withSecretTarget(async ({ outputPath }) => {
      let mutationArgs;
      const rpc = admin.createRpcTransport({
        projectRef: "test-project",
        serviceRoleKey: "test-service-role-key",
      }, async (url, options) => {
        const name = rpcName(url);
        const args = JSON.parse(options.body);
        if (name === "network_center_admin_provision_worker_v1") {
          mutationArgs = args;
          return httpResponse(gatewayStatus, "upstream gateway unavailable", "text/plain");
        }
        if (name === "network_center_admin_worker_credential_status_v1") {
          assert.equal(args.p_worker_key, WORKER_KEY);
          assert.equal(args.p_fingerprint, mutationArgs.p_fingerprint);
          return httpResponse(200, credentialStatus({ fingerprint: mutationArgs.p_fingerprint }));
        }
        if (name === "network_center_admin_status_v1") {
          return httpResponse(200, { workers: [], assignments: [] });
        }
        throw new Error(`unexpected RPC ${name}`);
      });

      const result = await admin.provisionWorker({
        workerKey: WORKER_KEY,
        displayName: "Demo worker",
        outputPath,
        expiresAt: EXPIRES_AT,
        assignments,
        rpc,
      });

      assert.equal(result.reconciled, true);
      assert.equal(existsSync(outputPath), true);
    });
  }
});

test("gateway HTTP failures reconcile rotation and preserve the generated secret", async () => {
  assert.equal(typeof admin.createRpcTransport, "function");
  if (typeof admin.createRpcTransport !== "function") return;

  for (const gatewayStatus of [500, 502, 503, 504, 524]) {
    await withSecretTarget(async ({ outputPath }) => {
      let mutationArgs;
      const rpc = admin.createRpcTransport({
        projectRef: "test-project",
        serviceRoleKey: "test-service-role-key",
      }, async (url, options) => {
        const name = rpcName(url);
        const args = JSON.parse(options.body);
        if (name === "network_center_admin_rotate_worker_credential_v1") {
          mutationArgs = args;
          return httpResponse(gatewayStatus, "upstream gateway unavailable", "text/plain");
        }
        if (name === "network_center_admin_worker_credential_status_v1") {
          assert.equal(args.p_worker_key, WORKER_KEY);
          assert.equal(args.p_fingerprint, mutationArgs.p_fingerprint);
          return httpResponse(200, credentialStatus({ fingerprint: mutationArgs.p_fingerprint }));
        }
        if (name === "network_center_admin_status_v1") {
          return httpResponse(200, { workers: [] });
        }
        throw new Error(`unexpected RPC ${name}`);
      });

      const result = await admin.rotateWorker({
        workerKey: WORKER_KEY,
        outputPath,
        notBefore: NOT_BEFORE,
        expiresAt: EXPIRES_AT,
        rpc,
      });

      assert.equal(result.reconciled, true);
      assert.equal(existsSync(outputPath), true);
    });
  }
});

test("JSON 5xx responses remain unknown and preserve provision and rotation secrets", async () => {
  for (const operation of ["provision", "rotate"]) {
    for (const serverStatus of [500, 502, 503, 504, 524]) {
      await withSecretTarget(async ({ outputPath }) => {
        let mutationArgs;
        let secret;
        let digest;
        const rpc = admin.createRpcTransport({
          projectRef: "test-project",
          serviceRoleKey: "test-service-role-key",
        }, async (url, options) => {
          const name = rpcName(url);
          const args = JSON.parse(options.body);
          if (name === `network_center_admin_${operation === "provision"
            ? "provision_worker_v1"
            : "rotate_worker_credential_v1"}`) {
            mutationArgs = args;
            digest = args.p_secret_digest;
            secret = (await readFile(outputPath, "utf8")).trim();
            return httpResponse(serverStatus, {
              code: "22023",
              message: `upstream failed ${secret} ${digest}`,
              details: null,
              hint: null,
            });
          }
          if (name === "network_center_admin_worker_credential_status_v1") {
            assert.equal(args.p_worker_key, WORKER_KEY);
            assert.equal(args.p_fingerprint, mutationArgs.p_fingerprint);
            return httpResponse(200, credentialStatus({ fingerprint: mutationArgs.p_fingerprint }));
          }
          if (name === "network_center_admin_status_v1") {
            return httpResponse(200, { workers: [], assignments: [] });
          }
          throw new Error(`unexpected RPC ${name}`);
        });

        const result = await (operation === "provision"
          ? admin.provisionWorker({
            workerKey: WORKER_KEY,
            displayName: "Demo worker",
            outputPath,
            expiresAt: EXPIRES_AT,
            assignments,
            rpc,
          })
          : admin.rotateWorker({
            workerKey: WORKER_KEY,
            outputPath,
            notBefore: NOT_BEFORE,
            expiresAt: EXPIRES_AT,
            rpc,
          }));

        assert.equal(result.reconciled, true);
        assert.equal(existsSync(outputPath), true);
        assert.equal(JSON.stringify(result).includes(secret), false);
        assert.equal(JSON.stringify(result).includes(digest), false);
      });
    }
  }
});

test("non-authoritative 4xx envelopes remain unknown and preserve the generated secret", async () => {
  const invalidEnvelopes = [
    { message: "missing standard envelope keys" },
    { code: "ERROR", details: null, hint: null, message: "generic proxy error" },
    { code: "99999", details: null, hint: null, message: "unknown SQLSTATE" },
    { code: "PGRST999", details: null, hint: null, message: "unknown PostgREST code" },
    { code: "22023", details: {}, hint: null, message: "invalid details type" },
    { code: "22023", details: null, hint: 42, message: "invalid hint type" },
    { code: "22023", details: null, hint: null, message: "" },
    { code: "22023", details: null, hint: null, message: "m".repeat(2_001) },
    { code: "22023", details: "d".repeat(2_001), hint: null, message: "oversized details" },
    { code: "22023", details: null, hint: "h".repeat(2_001), message: "oversized hint" },
    {
      code: "22023",
      details: null,
      hint: null,
      message: "unexpected envelope key",
      proxyRequestId: "proxy-123",
    },
  ];

  for (const envelope of invalidEnvelopes) {
    await withSecretTarget(async ({ outputPath }) => {
      let mutationArgs;
      const rpc = admin.createRpcTransport({
        projectRef: "test-project",
        serviceRoleKey: "test-service-role-key",
      }, async (url, options) => {
        const name = rpcName(url);
        const args = JSON.parse(options.body);
        if (name === "network_center_admin_provision_worker_v1") {
          mutationArgs = args;
          return httpResponse(400, envelope);
        }
        if (name === "network_center_admin_worker_credential_status_v1") {
          return httpResponse(200, credentialStatus({ fingerprint: mutationArgs.p_fingerprint }));
        }
        if (name === "network_center_admin_status_v1") {
          return httpResponse(200, { workers: [], assignments: [] });
        }
        throw new Error(`unexpected RPC ${name}`);
      });

      const result = await admin.provisionWorker({
        workerKey: WORKER_KEY,
        displayName: "Demo worker",
        outputPath,
        expiresAt: EXPIRES_AT,
        assignments,
        rpc,
      });

      assert.equal(result.reconciled, true);
      assert.equal(existsSync(outputPath), true);
    });
  }
});

test("exact allowlisted PostgREST rejections delete unused provision and rotation secrets", async () => {
  assert.equal(typeof admin.createRpcTransport, "function");
  if (typeof admin.createRpcTransport !== "function") return;

  for (const operation of ["provision", "rotate"]) {
    const allowedCodes = operation === "provision"
      ? ["22023", "23503", "23505", "P0002", "PGRST202"]
      : ["22023", "23505", "P0002", "PGRST202"];
    for (const code of allowedCodes) {
      await withSecretTarget(async ({ outputPath }) => {
        let secret;
        let digest;
        const rpc = admin.createRpcTransport({
          projectRef: "test-project",
          serviceRoleKey: "test-service-role-key",
        }, async (_url, options) => {
          const args = JSON.parse(options.body);
          digest = args.p_secret_digest;
          secret = (await readFile(outputPath, "utf8")).trim();
          return httpResponse(400, {
            code,
            details: null,
            hint: null,
            message: `request rejected ${secret} ${digest}`,
          });
        });

        const error = await (operation === "provision"
          ? admin.provisionWorker({
            workerKey: WORKER_KEY,
            displayName: "Demo worker",
            outputPath,
            expiresAt: EXPIRES_AT,
            assignments,
            rpc,
          })
          : admin.rotateWorker({
            workerKey: WORKER_KEY,
            outputPath,
            notBefore: NOT_BEFORE,
            expiresAt: EXPIRES_AT,
            rpc,
          })).catch((cause) => cause);

        assert.equal(error?.outcome, "REJECTED");
        assert.equal(existsSync(outputPath), false);
        assert.equal(String(error?.message).includes(secret), false);
        assert.equal(String(error?.message).includes(digest), false);
      });
    }
  }
});

test("non-authoritative 2xx mutation payloads require exact credential reconciliation", async () => {
  const invalidPayloads = [
    () => "",
    () => null,
    () => ({}),
    (operation, args) => ({
      ...authoritativeMutationResponse(operation, args),
      workerKey: OTHER_WORKER_KEY,
    }),
    (operation, args) => ({
      ...authoritativeMutationResponse(operation, args),
      credentialFingerprint: "sha256:000000000000000000000000",
    }),
    (operation, args) => operation === "provision"
      ? { ...authoritativeMutationResponse(operation, args), status: "PAUSED" }
      : { ...authoritativeMutationResponse(operation, args), expiresAt: NOT_BEFORE },
  ];

  for (const operation of ["provision", "rotate"]) {
    for (const invalidPayload of invalidPayloads) {
      await withSecretTarget(async ({ outputPath }) => {
        let mutationArgs;
        let reconciliationCalls = 0;
        const rpc = admin.createRpcTransport({
          projectRef: "test-project",
          serviceRoleKey: "test-service-role-key",
        }, async (url, options) => {
          const name = rpcName(url);
          const args = JSON.parse(options.body);
          if (name === `network_center_admin_${operation === "provision"
            ? "provision_worker_v1"
            : "rotate_worker_credential_v1"}`) {
            mutationArgs = args;
            return httpResponse(200, invalidPayload(operation, args), "application/json");
          }
          if (name === "network_center_admin_worker_credential_status_v1") {
            reconciliationCalls += 1;
            assert.equal(args.p_worker_key, WORKER_KEY);
            assert.equal(args.p_fingerprint, mutationArgs.p_fingerprint);
            return httpResponse(200, credentialStatus({ fingerprint: mutationArgs.p_fingerprint }));
          }
          if (name === "network_center_admin_status_v1") {
            return httpResponse(200, { workers: [], assignments: [] });
          }
          throw new Error(`unexpected RPC ${name}`);
        });

        const result = await (operation === "provision"
          ? admin.provisionWorker({
            workerKey: WORKER_KEY,
            displayName: "Demo worker",
            outputPath,
            expiresAt: EXPIRES_AT,
            assignments,
            rpc,
          })
          : admin.rotateWorker({
            workerKey: WORKER_KEY,
            outputPath,
            notBefore: NOT_BEFORE,
            expiresAt: EXPIRES_AT,
            rpc,
          }));

        assert.equal(result.reconciled, true);
        assert.equal(reconciliationCalls, 1);
        assert.equal(existsSync(outputPath), true);
      });
    }
  }
});

test("exact authoritative provision and rotation payloads are accepted without reconciliation", async () => {
  for (const operation of ["provision", "rotate"]) {
    await withSecretTarget(async ({ outputPath }) => {
      let authoritativePayload;
      let reconciliationCalls = 0;
      const rpc = admin.createRpcTransport({
        projectRef: "test-project",
        serviceRoleKey: "test-service-role-key",
      }, async (url, options) => {
        const name = rpcName(url);
        const args = JSON.parse(options.body);
        if (name === `network_center_admin_${operation === "provision"
          ? "provision_worker_v1"
          : "rotate_worker_credential_v1"}`) {
          authoritativePayload = authoritativeMutationResponse(operation, args);
          return httpResponse(200, authoritativePayload);
        }
        if (name === "network_center_admin_worker_credential_status_v1") {
          reconciliationCalls += 1;
          throw new Error("authoritative success must not reconcile");
        }
        if (name === "network_center_admin_status_v1") {
          return httpResponse(200, { workers: [], assignments: [] });
        }
        throw new Error(`unexpected RPC ${name}`);
      });

      const result = await (operation === "provision"
        ? admin.provisionWorker({
          workerKey: WORKER_KEY,
          displayName: "Demo worker",
          outputPath,
          expiresAt: EXPIRES_AT,
          assignments,
          rpc,
        })
        : admin.rotateWorker({
          workerKey: WORKER_KEY,
          outputPath,
          notBefore: NOT_BEFORE,
          expiresAt: EXPIRES_AT,
          rpc,
        }));

      assert.deepEqual(result.operation, authoritativePayload);
      assert.equal(result.reconciled, undefined);
      assert.equal(reconciliationCalls, 0);
      assert.equal(existsSync(outputPath), true);
    });
  }
});
