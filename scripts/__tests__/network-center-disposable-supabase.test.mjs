import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DISPOSABLE_SENTINEL_FILE,
  GLOBAL_DEADLINE_MS,
  SUPABASE_CLI_PACKAGE,
  cleanupOwnedDisposableWorkspace,
  resolveNpxInvocation,
  runCommand,
} from "../network-center-disposable-db.mjs";
import {
  REQUIRED_CASE_IDS,
  main as runCrossTenantMatrix,
} from "../test-cross-tenant.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXED_NOW = new Date("2026-08-01T00:00:00.000Z");

function passingVerdictBody(localProof) {
  const verdict = {
    passed: true,
    assertion_count: REQUIRED_CASE_IDS.length,
    failed_count: 0,
    assertions: REQUIRED_CASE_IDS.map((caseId) => ({
      case_id: caseId,
      passed: true,
      detail: null,
    })),
  };
  if (localProof) verdict.local_proof = localProof;
  return JSON.stringify([{ verdict }]);
}

function proofFromSentinel(sentinel) {
  return {
    proof_nonce: sentinel.proofNonce,
    migration_manifest_sha256: sentinel.migrationManifestSha256,
    migration_count: sentinel.migrationCount,
    network_center_migration_count: sentinel.networkCenterMigrationCount,
  };
}

function isSupabaseCommand(call, ...parts) {
  return (
    call.args.includes(SUPABASE_CLI_PACKAGE) &&
    parts.every((part) => call.args.includes(part))
  );
}

async function makeTestRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "network-center-disposable-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function readSentinel(workspace) {
  return JSON.parse(
    await readFile(join(workspace, DISPOSABLE_SENTINEL_FILE), "utf8"),
  );
}

test("materializes an authoritative fresh replay, exact seed, proven matrix, and owned cleanup", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const calls = [];
  const logs = [];
  let observedWorkspace;
  let observedSentinel;

  const runner = async (call) => {
    calls.push(call);
    if (isSupabaseCommand(call, "db", "start")) {
      observedWorkspace = call.args[call.args.indexOf("--workdir") + 1];
      observedSentinel = await readSentinel(observedWorkspace);
      const config = await readFile(
        join(observedWorkspace, "supabase", "config.toml"),
        "utf8",
      );
      assert.doesNotMatch(config, /tryymsxyyckgbrmmvozx/);
      assert.match(config, /project_id\s*=\s*"network-center-019f8c63"/);
      assert.match(config, /port\s*=\s*55432/);
      assert.match(config, /shadow_port\s*=\s*55433/);
      assert.match(config, /major_version\s*=\s*17/);
      assert.match(config, /\[db\.seed\][\s\S]*enabled\s*=\s*true/);
      assert.match(config, /sql_paths\s*=\s*\["\.\/seed\.sql"\]/);
      assert.doesNotMatch(config, /\[auth\]|\[api\]|\[studio\]/);

      const generated = (
        await readdir(join(observedWorkspace, "supabase", "migrations"))
      ).sort();
      const source = (await readdir(join(REPO_ROOT, "supabase", "migrations")))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const versions = generated.map((name) => name.match(/^(\d{14})_/)?.[1]);
      assert.equal(generated.length, source.length + 8);
      assert.equal(versions.every(Boolean), true);
      assert.equal(new Set(versions).size, versions.length);
      for (const migration of source.filter((name) =>
        name.includes("network_center"),
      )) {
        const generatedName = generated.find((name) =>
          name.endsWith(`_${migration}`),
        );
        assert.ok(generatedName);
        assert.equal(
          await readFile(
            join(observedWorkspace, "supabase", "migrations", generatedName),
            "utf8",
          ),
          await readFile(
            join(REPO_ROOT, "supabase", "migrations", migration),
            "utf8",
          ),
        );
      }
      for (const snapshot of ["PS04", "PS01", "PS02", "PS03", "PS05"]) {
        assert.equal(
          generated.some((name) => name.includes(`_dr_${snapshot}_`)),
          true,
        );
      }
      assert.equal(
        generated.some((name) =>
          name.includes("_prerequisite_local_catalog_prerequisites.sql"),
        ),
        true,
      );
      assert.equal(
        generated.some((name) =>
          name.includes("_finalizer_local_catalog_grants.sql"),
        ),
        true,
      );
      const firstPostSnapshot = generated.findIndex((name) =>
        name.includes("_20260720120000_"),
      );
      const lastSnapshot = generated.findLastIndex((name) =>
        name.includes("_dr_PS05_"),
      );
      assert.ok(lastSnapshot >= 0 && lastSnapshot < firstPostSnapshot);

      const seed = await readFile(
        join(observedWorkspace, "supabase", "seed.sql"),
        "utf8",
      );
      assert.doesNotMatch(
        seed,
        /DELETE FROM public\.organization_memberships/i,
      );
      assert.match(
        seed,
        /ON CONFLICT \(organization_id, user_id\) WHERE status IN \('INVITED','ACTIVE'\)/i,
      );
      for (const fixture of [
        "demo.chunha@username.ihomecrm.local",
        "demo.ketoan@username.ihomecrm.local",
        "demo.quanly@username.ihomecrm.local",
        "dddd0000-0000-4000-8000-000000000001",
        "aaaa0000-0000-4000-8000-000000000001",
        "DEMO-NC-BUILDING-A",
        "DEMO-NC-BUILDING-B",
        "PROD-NC-READ-ONLY",
        "authorization_scopes",
        observedSentinel.proofNonce,
        observedSentinel.migrationManifestSha256,
      ]) {
        assert.ok(seed.includes(fixture));
      }
    }
    if (isSupabaseCommand(call, "db", "query")) {
      const sqlPath = call.args[call.args.indexOf("--file") + 1];
      const sql = await readFile(sqlPath, "utf8");
      assert.match(sql, /ROLLBACK\s*;/i);
      assert.match(sql, /network_center_disposable_proof/i);
      assert.ok(sql.includes(observedSentinel.proofNonce));
      return {
        stdout: passingVerdictBody(proofFromSentinel(observedSentinel)),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  let loadConfigCalls = 0;
  let fetchCalls = 0;
  await runCrossTenantMatrix(["--local-disposable"], {
    log: (message) => logs.push(message),
    loadConfig: () => {
      loadConfigCalls += 1;
      throw new Error("production config must stay untouched");
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("production fetch must stay untouched");
    },
    disposableOptions: {
      runner,
      repoRoot: REPO_ROOT,
      tempRoot,
      now: () => FIXED_NOW,
      monotonicNow: () => 0,
      runId: () => "019f8c63",
      proofNonce: () => "0123456789abcdef0123456789abcdef",
      databasePorts: () => ({ port: 55432, shadowPort: 55433 }),
      env: {
        PATH: process.env.PATH,
        SUPABASE_ACCESS_TOKEN: "must-not-reach-local-cli",
        SUPABASE_PAT: "must-not-reach-local-cli",
      },
    },
  });

  assert.equal(loadConfigCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(
    calls.map((call) => {
      if (call.command === "docker") return "docker-version";
      if (isSupabaseCommand(call, "db", "start")) return "db-start";
      if (isSupabaseCommand(call, "db", "reset")) return "db-reset";
      if (isSupabaseCommand(call, "db", "query")) return "db-query";
      if (isSupabaseCommand(call, "stop")) return "stop";
      return "unknown";
    }),
    ["docker-version", "db-start", "db-reset", "db-query", "stop"],
  );

  for (const call of calls) {
    assert.ok(Number.isInteger(call.timeoutMs) && call.timeoutMs > 0);
    assert.ok(call.timeoutMs <= GLOBAL_DEADLINE_MS);
    assert.equal(call.args.includes("--all"), false);
    assert.equal(call.args.includes("--linked"), false);
    if (isSupabaseCommand(call)) {
      assert.ok(
        call.args.indexOf("--yes") < call.args.indexOf(SUPABASE_CLI_PACKAGE),
      );
      assert.equal(call.env.SUPABASE_ACCESS_TOKEN, undefined);
      assert.equal(call.env.SUPABASE_PAT, undefined);
    }
  }

  assert.equal(
    observedSentinel.marker,
    "network-center-disposable:v1:019f8c63",
  );
  assert.equal(observedSentinel.projectRef, "network-center-019f8c63");
  assert.equal(observedSentinel.host, "127.0.0.1");
  assert.equal(observedSentinel.workspaceName, basename(observedWorkspace));
  assert.match(observedSentinel.proofNonce, /^[a-f0-9]{32}$/);
  assert.match(observedSentinel.migrationManifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    observedSentinel.migrationCount >
      observedSentinel.networkCenterMigrationCount,
  );
  assert.equal(
    new Date(observedSentinel.expiresAt).getTime() - FIXED_NOW.getTime(),
    2 * 60 * 60 * 1_000,
  );
  assert.deepEqual(await readdir(tempRoot), []);
  assert.match(logs.join("\n"), /local disposable.*passed/i);
});

test("tears down its exact project when the matrix fails", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    if (isSupabaseCommand(call, "db", "query"))
      throw new Error("synthetic matrix failure");
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await assert.rejects(
    runCrossTenantMatrix(["--local-disposable"], {
      log: () => {},
      disposableOptions: {
        runner,
        repoRoot: REPO_ROOT,
        tempRoot,
        now: () => FIXED_NOW,
        monotonicNow: () => 0,
        runId: () => "failure1",
        databasePorts: () => ({ port: 55434, shadowPort: 55435 }),
      },
    }),
    /synthetic matrix failure/,
  );
  const stop = calls.find((call) => isSupabaseCommand(call, "stop"));
  assert.equal(
    stop.args[stop.args.indexOf("--project-id") + 1],
    "network-center-failure1",
  );
  assert.deepEqual(await readdir(tempRoot), []);
});

test("rejects a fabricated passing verdict without local database proof", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const runner = async (call) => {
    if (isSupabaseCommand(call, "db", "query")) {
      return { stdout: passingVerdictBody(), stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await assert.rejects(
    runCrossTenantMatrix(["--local-disposable"], {
      log: () => {},
      disposableOptions: {
        runner,
        repoRoot: REPO_ROOT,
        tempRoot,
        now: () => FIXED_NOW,
        monotonicNow: () => 0,
        runId: () => "proofbad1",
        proofNonce: () => "11111111111111111111111111111111",
        databasePorts: () => ({ port: 55436, shadowPort: 55437 }),
      },
    }),
    /local proof|fabricated|manifest/i,
  );
  assert.deepEqual(await readdir(tempRoot), []);
});

test("failed exact-project stop retains marker evidence and prints the manual cleanup command", async (t) => {
  const tempRoot = await makeTestRoot(t);
  let workspace;
  const runner = async (call) => {
    if (isSupabaseCommand(call, "db", "start")) {
      workspace = call.args[call.args.indexOf("--workdir") + 1];
    }
    if (isSupabaseCommand(call, "db", "query")) {
      const sentinel = await readSentinel(workspace);
      return {
        stdout: passingVerdictBody(proofFromSentinel(sentinel)),
        stderr: "",
        exitCode: 0,
      };
    }
    if (isSupabaseCommand(call, "stop"))
      throw new Error("synthetic stop failure");
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await assert.rejects(
    runCrossTenantMatrix(["--local-disposable"], {
      log: () => {},
      disposableOptions: {
        runner,
        repoRoot: REPO_ROOT,
        tempRoot,
        now: () => FIXED_NOW,
        monotonicNow: () => 0,
        runId: () => "stopfail1",
        databasePorts: () => ({ port: 55438, shadowPort: 55439 }),
      },
    }),
    (error) => {
      assert.match(error.message, /synthetic stop failure/i);
      assert.match(
        error.message,
        /npx --yes supabase@2\.109\.1 .*stop --project-id network-center-stopfail1 --no-backup/i,
      );
      return true;
    },
  );
  await access(join(workspace, DISPOSABLE_SENTINEL_FILE));
});

test("cleanup refuses unowned and non-direct paths", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const nested = join(tempRoot, "parent", "network-center-supabase-forged");
  await mkdir(nested, { recursive: true });
  const sentinel = {
    marker: "network-center-disposable:v1:forged01",
    projectRef: "network-center-forged01",
    host: "127.0.0.1",
    createdAt: FIXED_NOW.toISOString(),
    expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
  };
  await writeFile(
    join(nested, DISPOSABLE_SENTINEL_FILE),
    JSON.stringify(sentinel),
  );

  await assert.rejects(
    cleanupOwnedDisposableWorkspace({ workspace: nested, tempRoot, sentinel }),
    /direct child/i,
  );
  await access(join(nested, DISPOSABLE_SENTINEL_FILE));
});

test("cleanup refuses an ownership marker copied to a different direct workspace", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const copiedWorkspace = join(tempRoot, "network-center-supabase-copy0001");
  await mkdir(copiedWorkspace);
  const sentinel = {
    marker: "network-center-disposable:v1:copied01",
    projectRef: "network-center-copied01",
    host: "127.0.0.1",
    workspaceName: "network-center-supabase-original",
    createdAt: FIXED_NOW.toISOString(),
    expiresAt: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
  };
  await writeFile(
    join(copiedWorkspace, DISPOSABLE_SENTINEL_FILE),
    JSON.stringify(sentinel),
  );

  await assert.rejects(
    cleanupOwnedDisposableWorkspace({
      workspace: copiedWorkspace,
      tempRoot,
      sentinel,
    }),
    /marker.*workspace|workspace.*marker/i,
  );
  await access(join(copiedWorkspace, DISPOSABLE_SENTINEL_FILE));
});

test("janitor removes only owned workspaces older than 30 minutes using exact-project stop", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const stale = join(tempRoot, "network-center-supabase-stale001");
  const fresh = join(tempRoot, "network-center-supabase-fresh001");
  await mkdir(stale);
  await mkdir(fresh);
  for (const [workspace, runId, ageMinutes] of [
    [stale, "stale001", 31],
    [fresh, "fresh001", 29],
  ]) {
    const createdAt = new Date(FIXED_NOW.getTime() - ageMinutes * 60_000);
    const sentinel = {
      marker: `network-center-disposable:v1:${runId}`,
      projectRef: `network-center-${runId}`,
      host: "127.0.0.1",
      workspaceName: basename(workspace),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 2 * 60 * 60_000).toISOString(),
    };
    await writeFile(
      join(workspace, DISPOSABLE_SENTINEL_FILE),
      JSON.stringify(sentinel),
    );
  }

  const stoppedProjects = [];
  let currentWorkspace;
  const runner = async (call) => {
    if (isSupabaseCommand(call, "stop")) {
      stoppedProjects.push(call.args[call.args.indexOf("--project-id") + 1]);
    }
    if (isSupabaseCommand(call, "db", "start")) {
      currentWorkspace = call.args[call.args.indexOf("--workdir") + 1];
    }
    if (isSupabaseCommand(call, "db", "query")) {
      const sentinel = await readSentinel(currentWorkspace);
      return {
        stdout: passingVerdictBody(proofFromSentinel(sentinel)),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await runCrossTenantMatrix(["--local-disposable"], {
    log: () => {},
    disposableOptions: {
      runner,
      repoRoot: REPO_ROOT,
      tempRoot,
      now: () => FIXED_NOW,
      monotonicNow: () => 0,
      runId: () => "janitor1",
      databasePorts: () => ({ port: 55440, shadowPort: 55441 }),
    },
  });

  assert.deepEqual(stoppedProjects, [
    "network-center-stale001",
    "network-center-janitor1",
  ]);
  await assert.rejects(access(stale));
  await access(join(fresh, DISPOSABLE_SENTINEL_FILE));
});

test("one 12-minute deadline bounds the whole lifecycle and retains evidence when cleanup cannot start", async (t) => {
  const tempRoot = await makeTestRoot(t);
  const calls = [];
  let monotonic = 0;
  let workspace;
  const runner = async (call) => {
    calls.push(call);
    if (isSupabaseCommand(call, "db", "start")) {
      workspace = call.args[call.args.indexOf("--workdir") + 1];
    }
    if (isSupabaseCommand(call, "db", "reset"))
      monotonic = GLOBAL_DEADLINE_MS + 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await assert.rejects(
    runCrossTenantMatrix(["--local-disposable"], {
      log: () => {},
      disposableOptions: {
        runner,
        repoRoot: REPO_ROOT,
        tempRoot,
        now: () => FIXED_NOW,
        monotonicNow: () => monotonic,
        runId: () => "deadline1",
        databasePorts: () => ({ port: 55442, shadowPort: 55443 }),
      },
    }),
    /12-minute global deadline.*manual cleanup|manual cleanup.*12-minute global deadline/i,
  );
  assert.equal(
    calls.some((call) => isSupabaseCommand(call, "db", "query")),
    false,
  );
  assert.equal(
    calls.some((call) => isSupabaseCommand(call, "stop")),
    false,
  );
  assert.equal(
    calls.every((call) => call.timeoutMs <= GLOBAL_DEADLINE_MS),
    true,
  );
  await access(join(workspace, DISPOSABLE_SENTINEL_FILE));
});

test("missing Docker fails before workspace creation or production access", async (t) => {
  const tempRoot = await makeTestRoot(t);
  let loadConfigCalls = 0;
  const calls = [];

  await assert.rejects(
    runCrossTenantMatrix(["--local-disposable"], {
      log: () => {},
      loadConfig: () => {
        loadConfigCalls += 1;
        return { pat: "must-not-load", projectRef: "must-not-load" };
      },
      disposableOptions: {
        runner: async (call) => {
          calls.push(call);
          const error = new Error("spawn docker ENOENT");
          error.code = "ENOENT";
          throw error;
        },
        repoRoot: REPO_ROOT,
        tempRoot,
        monotonicNow: () => 0,
      },
    }),
    /Docker is required.*no production/i,
  );
  assert.equal(loadConfigCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "docker");
  assert.deepEqual(await readdir(tempRoot), []);
});

test(
  "Windows invokes the actual pinned CLI through Node, never npx.cmd with shell false",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const invocation = resolveNpxInvocation();
    assert.equal(invocation.command, process.execPath);
    assert.match(invocation.argsPrefix[0], /npx-cli\.js$/i);
    const result = await runCommand({
      command: invocation.command,
      args: [
        ...invocation.argsPrefix,
        "--yes",
        SUPABASE_CLI_PACKAGE,
        "--version",
      ],
      cwd: REPO_ROOT,
      env: process.env,
      timeoutMs: 120_000,
    });
    assert.match(result.stdout, /2\.109\.1/);
  },
);
