import type { User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  from: vi.fn(),
  getSessionUser: vi.fn(),
  getSessionUserId: vi.fn(),
  loadProfile: vi.fn(),
  select: vi.fn(),
  useAuth: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: mocks.useQuery };
});

vi.mock("@/hooks/useAuth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/authSession", () => ({
  getSessionUser: mocks.getSessionUser,
  getSessionUserId: mocks.getSessionUserId,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mocks.from },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import * as profileModule from "@/hooks/useProfile";

interface CapturedProfileQuery {
  enabled?: boolean;
  queryFn: () => Promise<profileModule.Profile | null>;
  queryKey: readonly unknown[];
}

const user = (id: string): User => ({ id } as User);

function captureProfileQuery(): CapturedProfileQuery {
  return profileModule.useProfile() as unknown as CapturedProfileQuery;
}

describe("useProfile identity isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useQuery.mockImplementation((options) => options);
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockImplementation((_column, userId) => ({
      single: () => mocks.loadProfile(userId),
    }));
  });

  it("uses a profile prefix plus the authenticated user id and disables signed-out queries", () => {
    const queryKeys = (profileModule as typeof profileModule & {
      profileQueryKeys?: {
        prefix: readonly unknown[];
        byUser: (userId: string | null) => readonly unknown[];
      };
    }).profileQueryKeys;

    expect(queryKeys).toBeDefined();
    expect(queryKeys?.prefix).toEqual(["profile"]);

    mocks.useAuth.mockReturnValue({ data: user("user-a") });
    expect(captureProfileQuery()).toMatchObject({
      enabled: true,
      queryKey: ["profile", "user-a"],
    });

    mocks.useAuth.mockReturnValue({ data: null });
    expect(captureProfileQuery()).toMatchObject({
      enabled: false,
      queryKey: ["profile", null],
    });
  });

  it("captures the rendering user id so a late account-A query cannot read account B", async () => {
    mocks.useAuth.mockReturnValue({ data: user("user-a") });
    mocks.getSessionUserId.mockResolvedValue("user-a");
    const accountAQuery = captureProfileQuery();

    mocks.useAuth.mockReturnValue({ data: user("user-b") });
    mocks.getSessionUserId.mockResolvedValue("user-b");
    const accountBQuery = captureProfileQuery();
    mocks.loadProfile.mockImplementation(async (userId) => ({
      data: { id: userId, full_name: `Profile ${userId}` },
      error: null,
    }));

    await accountAQuery.queryFn();
    await accountBQuery.queryFn();

    expect(accountAQuery.queryKey).toEqual(["profile", "user-a"]);
    expect(accountBQuery.queryKey).toEqual(["profile", "user-b"]);
    expect(mocks.eq).toHaveBeenNthCalledWith(1, "id", "user-a");
    expect(mocks.eq).toHaveBeenNthCalledWith(2, "id", "user-b");
  });
});
