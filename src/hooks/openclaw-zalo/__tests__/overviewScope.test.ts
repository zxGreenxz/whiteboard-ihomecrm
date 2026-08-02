import { describe, expect, it } from "vitest";

import { openClawQueryKeys } from "../queryKeys";

const ORG = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_A = "dddd1000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "dddd1000-0000-4000-8000-00000000000b";

/**
 * `openclaw_get_overview_v1` takes only an organizationId and counts every account
 * in it. Keying that per account cached identical org-wide numbers under each
 * account, so switching from an account with three unresolved UNKNOWN rows to one
 * with none still showed three in the header while the account-scoped UNKNOWN list
 * showed zero.
 */
describe("overview query scope", () => {
  it("uses one organization-scoped key regardless of the selected account", () => {
    const a = openClawQueryKeys.overview(ORG, ACCOUNT_A);
    const b = openClawQueryKeys.overview(ORG, ACCOUNT_B);
    expect(a).toEqual(b);
    expect(a).not.toContain(ACCOUNT_A);
    expect(a).not.toContain(ACCOUNT_B);
  });

  it("still separates organizations", () => {
    const other = "dddd0000-0000-4000-8000-000000000002";
    expect(openClawQueryKeys.overview(ORG, ACCOUNT_A))
      .not.toEqual(openClawQueryKeys.overview(other, ACCOUNT_A));
  });

  it("keeps genuinely account-scoped surfaces keyed per account", () => {
    // Guards the guard: if `scope` itself had been made org-only, this would fail.
    expect(openClawQueryKeys.conversations(ORG, ACCOUNT_A))
      .not.toEqual(openClawQueryKeys.conversations(ORG, ACCOUNT_B));
  });
});
