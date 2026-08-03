// Layer 3 and the extraction machinery behind the disposable ingest-domain
// proof, without a PostgreSQL cluster.
//
// The disposable proof (scripts/test-network-center-ingest-domains-disposable.mjs)
// owns the one question only a database can answer: do the declared domains
// equal the CHECK constraints? This file owns everything else about F6:
//
//   - the extractors really do read the SHIPPING sources, and fail closed
//     rather than returning an empty domain that would make the proof vacuous;
//   - the REAL Edge handler rejects an out-of-domain telemetry value BEFORE the
//     RPC is called, so a bad row can no longer reach a constraint violation;
//   - the REAL Edge handler maps a check violation to a 4xx that names the
//     SQLSTATE, instead of the 502 that reduced the worker log to the single
//     word "ApiClientError".
//
// The Edge function is imported directly - Node 22 strips the TypeScript - so
// these run the code that ships, not a transcription of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EDGE_FUNCTION_SOURCE,
  TELEMETRY_DOMAIN_BINDINGS,
  WORKER_DOMAIN_SOURCE,
  extractDeclaredDomain,
  extractObjectLiteralStrings,
  readDeclaredDomains,
  readEmittedClientLiterals,
  readInitializer,
  stringLiteralsIn,
  stripComments,
} from "../network-center-source-domains.mjs";
import {
  FIXED_INGEST_DOMAIN_INVARIANTS,
  buildIngestDomainProofSql,
  expectedInvariants,
  parseIngestDomainProofVerdict,
} from "../test-network-center-ingest-domains-disposable.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EDGE_ENTRYPOINT = resolve(
  REPO_ROOT,
  "supabase/functions/network-center-worker/index.ts",
);
const WORKER_SECRET = "s".repeat(48);
const NONCE = "0".repeat(32);

async function createEdgeHarness({ rpcResult } = {}) {
  const module = await import(pathToFileURL(EDGE_ENTRYPOINT).href);
  const calls = [];
  const handler = module.createWorkerHandler({
    getEnv: () => undefined,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return rpcResult ?? { data: { ok: true }, error: null };
    },
  });
  return { handler, calls };
}

function ingestRequest(payload) {
  return new Request("https://proof.invalid/network-center-worker/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-network-worker-secret": WORKER_SECRET,
    },
    body: JSON.stringify({ payload }),
  });
}

function telemetryPayload(overrides = {}) {
  return {
    observedAt: new Date().toISOString(),
    devices: [],
    interfaces: [],
    clients: [],
    ...overrides,
  };
}

function client(overrides = {}) {
  return {
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionKey: "dhcp:bc:fc:e7:64:e3:fb",
    clientFingerprint: "f".repeat(64),
    connectionType: "UNKNOWN",
    sessionType: "DHCP",
    ...overrides,
  };
}

test("source extraction reads the files that ship, and fails closed", async (t) => {
  await t.test("finds a multi-line as-const array", () => {
    const source = `export const THINGS = [\n  "A",\n  "B",\n] as const;\n`;
    assert.deepEqual(extractDeclaredDomain(source, "THINGS"), ["A", "B"]);
  });

  await t.test("finds a Set initializer", () => {
    const source = `const THINGS = new Set([\n  "A",\n  "B",\n  "C",\n]);\n`;
    assert.deepEqual(extractDeclaredDomain(source, "THINGS"), ["A", "B", "C"]);
  });

  await t.test("refuses a declaration it cannot find", () => {
    assert.throws(
      () => extractDeclaredDomain(`const OTHER = ["A"] as const;`, "THINGS"),
      /Declaration of THINGS was not found/u,
    );
  });

  await t.test("refuses an empty domain instead of proving nothing", () => {
    assert.throws(
      () => extractDeclaredDomain(`const THINGS = [] as const;`, "THINGS"),
      /contains no members/u,
    );
  });

  await t.test("refuses a domain that repeats a member", () => {
    assert.throws(
      () => extractDeclaredDomain(`const THINGS = ["A", "A"] as const;`, "THINGS"),
      /repeats a member/u,
    );
  });

  await t.test("ignores a commented-out member", () => {
    const source = `const THINGS = [\n  "A",\n  // "B",\n  /* "C", */\n] as const;\n`;
    assert.deepEqual(extractDeclaredDomain(source, "THINGS"), ["A"]);
  });

  await t.test("ignores a commented-out declaration entirely", () => {
    const source = `// const THINGS = ["GHOST"] as const;\nconst OTHER = 1;\n`;
    assert.throws(
      () => extractDeclaredDomain(source, "THINGS"),
      /was not found/u,
    );
  });

  await t.test("keeps string contents intact while stripping comments", () => {
    assert.equal(stripComments(`const a = "// not a comment"; // gone`).trim(),
      `const a = "// not a comment";`);
    assert.deepEqual(stringLiteralsIn(`["a", 'b', 3]`), ["a", "b"]);
  });

  await t.test("reads string-literal properties out of an object literal", () => {
    const source = `const rows = list.map((item) => ({\n`
      + `  externalKey: item.key,\n`
      + `  connectionType: "UNKNOWN",\n`
      + `  sessionType: "DHCP",\n`
      + `  count: 3,\n`
      + `}));\n`;
    const literals = extractObjectLiteralStrings(source, "rows");
    assert.equal(literals.get("connectionType"), "UNKNOWN");
    assert.equal(literals.get("sessionType"), "DHCP");
    assert.equal(literals.has("count"), false);
    assert.equal(literals.has("externalKey"), false);
  });

  await t.test("refuses an object literal with no string properties", () => {
    assert.throws(
      () => extractObjectLiteralStrings(`const rows = [1, 2, 3];`, "rows"),
      /No string-literal properties/u,
    );
  });

  await t.test("refuses an unterminated initializer", () => {
    assert.throws(
      () => readInitializer(`const THINGS = ["A"`, "THINGS"),
      /unterminated/u,
    );
  });
});

test("the extracted values come from the real worker and Edge sources", async (t) => {
  await t.test("the connector's emitted literals are readable", () => {
    const emitted = readEmittedClientLiterals(REPO_ROOT);
    assert.equal(typeof emitted.connectionType, "string");
    assert.equal(typeof emitted.sessionType, "string");
    assert.ok(emitted.connectionType.length > 0);
    assert.ok(emitted.sessionType.length > 0);
  });

  await t.test("every binding resolves to a non-empty declared domain", () => {
    const domains = readDeclaredDomains(REPO_ROOT);
    assert.equal(domains.length, TELEMETRY_DOMAIN_BINDINGS.length);
    for (const binding of domains) {
      assert.ok(
        binding.edgeMembers.length > 0,
        `${binding.field} has no Edge domain`,
      );
      if (binding.workerMembers !== null) {
        assert.ok(
          binding.workerMembers.length > 0,
          `${binding.field} has no worker domain`,
        );
      }
    }
  });

  await t.test("the two restatements agree with each other", () => {
    // Necessary, not sufficient: agreeing with each other while both differ
    // from the database is exactly the failure mode F6 was. The disposable
    // proof is what compares them to pg_get_constraintdef.
    for (const binding of readDeclaredDomains(REPO_ROOT)) {
      if (binding.workerMembers === null) continue;
      assert.deepEqual(
        [...binding.edgeMembers].sort(),
        [...binding.workerMembers].sort(),
        `${binding.field} is restated inconsistently`,
      );
    }
  });

  await t.test("the symbols named by the bindings exist in both files", () => {
    const worker = readFileSync(resolve(REPO_ROOT, WORKER_DOMAIN_SOURCE), "utf8");
    const edge = readFileSync(resolve(REPO_ROOT, EDGE_FUNCTION_SOURCE), "utf8");
    for (const binding of TELEMETRY_DOMAIN_BINDINGS) {
      assert.ok(readInitializer(edge, binding.edgeSymbol).length > 0);
      if (binding.workerSymbol !== null) {
        assert.ok(readInitializer(worker, binding.workerSymbol).length > 0);
      }
    }
  });
});

test("the Edge function refuses an out-of-domain telemetry value", async (t) => {
  await t.test("a rejected client value never reaches the RPC", async () => {
    const { handler, calls } = await createEdgeHarness();

    const response = await handler(ingestRequest(telemetryPayload({
      clients: [client({ sessionType: "LEASE" })],
    })));
    const body = await response.json();

    assert.equal(response.status, 400);
    // The whole point: the transaction is never opened, so nothing can be
    // rolled back by it.
    assert.equal(calls.length, 0);
    assert.equal(body.error, "invalid_request");
    assert.match(body.reason, /payload\.clients\[0\]\.sessionType/u);
    // The rejected VALUE is never echoed back.
    assert.equal(JSON.stringify(body).includes("LEASE"), false);
  });

  await t.test("the pre-fix connection type is rejected too", async () => {
    const { handler, calls } = await createEdgeHarness();

    const response = await handler(ingestRequest(telemetryPayload({
      clients: [client({ connectionType: "DHCP" })],
    })));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
    assert.match(body.reason, /payload\.clients\[0\]\.connectionType/u);
  });

  await t.test("every enumerated telemetry field is policed", async () => {
    const cases = [
      ["devices", { healthStatus: "BROKEN" }, /devices\[0\]\.healthStatus/u],
      ["devices", { pppoeState: "FLAPPING" }, /devices\[0\]\.pppoeState/u],
      ["interfaces", { linkState: "FLAPPING" }, /interfaces\[0\]\.linkState/u],
    ];
    for (const [key, row, expected] of cases) {
      const { handler, calls } = await createEdgeHarness();
      const response = await handler(
        ingestRequest(telemetryPayload({ [key]: [row] })),
      );
      const body = await response.json();
      assert.equal(response.status, 400, `${key} ${JSON.stringify(row)}`);
      assert.equal(calls.length, 0);
      assert.match(body.reason, expected);
    }
  });

  await t.test("a rejected row is found wherever it sits in the batch", async () => {
    const { handler, calls } = await createEdgeHarness();

    const response = await handler(ingestRequest(telemetryPayload({
      clients: [client(), client(), client({ sessionType: "LEASE" })],
    })));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
    assert.match(body.reason, /payload\.clients\[2\]\.sessionType/u);
  });

  await t.test("case is not silently repaired", async () => {
    // The CHECK constraint is exact. Accepting "dhcp" here would mean the Edge
    // quietly rewriting a value the database would have refused, which is how a
    // producer drifts into a shape only this function understands.
    const { handler, calls } = await createEdgeHarness();

    const response = await handler(ingestRequest(telemetryPayload({
      clients: [client({ sessionType: "dhcp" })],
    })));

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });

  await t.test("a non-object row is refused before jsonb_to_recordset sees it", async () => {
    const { handler, calls } = await createEdgeHarness();

    const response = await handler(ingestRequest(telemetryPayload({
      clients: ["not-an-object"],
    })));

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("the Edge function still forwards everything the database accepts", async (t) => {
  await t.test("the literals the connector actually emits are forwarded", async () => {
    // Read from sshConnector.ts, not typed here: if the worker regresses to the
    // swapped pair this test fails without anyone editing it.
    const emitted = readEmittedClientLiterals(REPO_ROOT);
    const { handler, calls } = await createEdgeHarness();

    const response = await handler(ingestRequest(telemetryPayload({
      clients: [client({
        connectionType: emitted.connectionType,
        sessionType: emitted.sessionType,
      })],
    })));

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "network_center_worker_ingest_v2");
  });

  await t.test("every declared member is accepted", async () => {
    const domains = readDeclaredDomains(REPO_ROOT);
    const byField = new Map(domains.map((entry) => [entry.field, entry]));
    const connectionTypes = byField.get("clients[].connectionType").edgeMembers;
    const sessionTypes = byField.get("clients[].sessionType").edgeMembers;
    for (const connectionType of connectionTypes) {
      for (const sessionType of sessionTypes) {
        const { handler, calls } = await createEdgeHarness();
        const response = await handler(ingestRequest(telemetryPayload({
          clients: [client({ connectionType, sessionType })],
        })));
        assert.equal(
          response.status,
          200,
          `${connectionType}/${sessionType} was refused`,
        );
        assert.equal(calls.length, 1);
      }
    }
  });

  await t.test("absent and null enumerated fields are still accepted", async () => {
    // The RPC coalesces both to 'UNKNOWN', so refusing them would reject rows
    // the database stores happily.
    for (const value of [undefined, null]) {
      const { handler, calls } = await createEdgeHarness();
      const row = client();
      row.sessionType = value;
      row.connectionType = value;
      const response = await handler(
        ingestRequest(telemetryPayload({ clients: [row] })),
      );
      assert.equal(response.status, 200, `value=${String(value)}`);
      assert.equal(calls.length, 1);
    }
  });
});

test("a database domain error names itself instead of degrading to 502", async (t) => {
  await t.test("a check violation is a 4xx carrying the SQLSTATE", async () => {
    const { handler } = await createEdgeHarness({
      rpcResult: { data: null, error: { code: "23514" } },
    });

    const response = await handler(ingestRequest(telemetryPayload()));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, "23514");
  });

  await t.test("the whole data-exception class is a client error", async () => {
    for (const code of ["22023", "22P02", "22003", "23502"]) {
      const { handler } = await createEdgeHarness({
        rpcResult: { data: null, error: { code } },
      });
      const response = await handler(ingestRequest(telemetryPayload()));
      const body = await response.json();
      assert.equal(response.status, 400, code);
      assert.equal(body.code, code);
    }
  });

  await t.test("conflicts stay conflicts and authorization stays 403", async () => {
    const expected = [
      ["23503", 409],
      ["23505", 409],
      ["55000", 409],
      ["42501", 403],
      ["P0002", 404],
      ["28000", 401],
    ];
    for (const [code, status] of expected) {
      const { handler } = await createEdgeHarness({
        rpcResult: { data: null, error: { code } },
      });
      const response = await handler(ingestRequest(telemetryPayload()));
      assert.equal(response.status, status, code);
    }
  });

  await t.test("a genuinely unknown failure is still a 502", async () => {
    const { handler } = await createEdgeHarness({
      rpcResult: { data: null, error: { code: "XX000" } },
    });

    const response = await handler(ingestRequest(telemetryPayload()));

    assert.equal(response.status, 502);
  });
});

test("the disposable proof builder refuses to run on nothing", async (t) => {
  const emitted = { connectionType: "UNKNOWN", sessionType: "DHCP" };
  const domains = [{
    field: "clients[].sessionType",
    table: "public.network_client_current",
    column: "session_type",
    workerSymbol: "CLIENT_SESSION_TYPES",
    edgeSymbol: "CLIENT_SESSION_TYPES",
    workerMembers: ["UNKNOWN", "DHCP"],
    edgeMembers: ["UNKNOWN", "DHCP"],
  }];

  await t.test("requires the cluster's own nonce", () => {
    assert.throws(
      () => buildIngestDomainProofSql({
        localProof: { proofNonce: "nope" },
        emitted,
        domains,
      }),
      /proof nonce/u,
    );
  });

  await t.test("requires the literals read from the connector", () => {
    assert.throws(
      () => buildIngestDomainProofSql({
        localProof: { proofNonce: NONCE },
        emitted: {},
        domains,
      }),
      /literals read from the connector source/u,
    );
  });

  await t.test("requires at least one binding", () => {
    assert.throws(
      () => buildIngestDomainProofSql({
        localProof: { proofNonce: NONCE },
        emitted,
        domains: [],
      }),
      /at least one domain binding/u,
    );
  });

  await t.test("carries the emitted literals into the SQL verbatim", () => {
    const sql = buildIngestDomainProofSql({
      localProof: { proofNonce: NONCE },
      emitted: { connectionType: "ETHERNET", sessionType: "STATIC" },
      domains,
    });
    assert.match(sql, /'connectionType', 'ETHERNET'/u);
    assert.match(sql, /'sessionType', 'STATIC'/u);
    // The pre-fix control values are what the proof deliberately re-sends.
    assert.match(sql, /'connectionType', 'DHCP'/u);
    assert.match(sql, /'sessionType', 'LEASE'/u);
  });

  await t.test("counts one assertion per restatement of every binding", () => {
    assert.equal(
      expectedInvariants(readDeclaredDomains(REPO_ROOT)),
      FIXED_INGEST_DOMAIN_INVARIANTS
        + TELEMETRY_DOMAIN_BINDINGS.length * 2
        + TELEMETRY_DOMAIN_BINDINGS.filter((entry) => entry.workerSymbol !== null).length,
    );
  });
});

test("the disposable proof verdict fails closed", async (t) => {
  const passing = {
    status: "PASS",
    invariants: 2,
    proofNonce: NONCE,
    names: ["a", "b"],
    measurements: { outOfDomainSqlstate: "23514" },
  };
  const context = {
    expectedLocalProof: { proofNonce: NONCE },
    expectedInvariants: 2,
  };

  await t.test("accepts a complete verdict", () => {
    assert.equal(
      parseIngestDomainProofVerdict(JSON.stringify(passing), context).invariants,
      2,
    );
  });

  await t.test("rejects a short assertion ledger", () => {
    assert.throws(
      () => parseIngestDomainProofVerdict(
        JSON.stringify({ ...passing, invariants: 1, names: ["a"] }),
        context,
      ),
      /expected PASS/u,
    );
  });

  await t.test("rejects a duplicated assertion name", () => {
    assert.throws(
      () => parseIngestDomainProofVerdict(
        JSON.stringify({ ...passing, names: ["a", "a"] }),
        context,
      ),
      /malformed assertion/u,
    );
  });

  await t.test("rejects a verdict from another cluster", () => {
    assert.throws(
      () => parseIngestDomainProofVerdict(
        JSON.stringify({ ...passing, proofNonce: "1".repeat(32) }),
        context,
      ),
      /expected PASS/u,
    );
  });

  await t.test("rejects a run that never measured a check violation", () => {
    assert.throws(
      () => parseIngestDomainProofVerdict(
        JSON.stringify({ ...passing, measurements: {} }),
        context,
      ),
      /did not measure a check violation/u,
    );
  });

  await t.test("rejects output with no verdict at all", () => {
    assert.throws(
      () => parseIngestDomainProofVerdict("no json here", context),
      /expected PASS/u,
    );
  });
});
