import { describe, expect, it, vi } from "vitest";

import {
  buildIncomeExpenseTypeCanonicalizationRollout,
  main,
  parseCanonicalizationArgs,
} from "../apply-income-expense-type-canonicalization.mjs";

describe("income/expense type canonicalization rollout", () => {
  it("builds one hash-stable atomic apply and rollback", () => {
    const rollout = buildIncomeExpenseTypeCanonicalizationRollout();

    expect(rollout.migrations).toHaveLength(1);
    expect(rollout.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rollout.applySql).toMatch(/^BEGIN;/);
    expect(rollout.applySql).toMatch(/COMMIT;$/);
    expect(rollout.rollbackSql).toMatch(/^BEGIN;/);
    expect(rollout.rollbackSql).toMatch(/ROLLBACK;$/);
  });

  it("requires an explicit mode and a fresh hash for network operations", () => {
    expect(() => parseCanonicalizationArgs([])).toThrow(/mode/i);
    expect(() => parseCanonicalizationArgs(["--apply"])).toThrow(/sha-256/i);
    expect(
      parseCanonicalizationArgs([
        "--rollback",
        "--expected-sha256",
        "a".repeat(64),
      ]),
    ).toEqual({
      mode: "rollback",
      expectedSha256: "a".repeat(64),
      help: false,
    });
  });

  it("keeps dry-run offline", async () => {
    const execute = vi.fn();
    const log = vi.fn();

    await main(["--dry-run"], {
      loadConfig: vi.fn(),
      execute,
      log,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/sha256/i));
  });

  it("rejects a stale apply hash before loading credentials", async () => {
    const loadConfig = vi.fn();
    const execute = vi.fn();

    await expect(
      main(["--apply", "--expected-sha256", "0".repeat(64)], {
        loadConfig,
        execute,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/hash mismatch/i);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

