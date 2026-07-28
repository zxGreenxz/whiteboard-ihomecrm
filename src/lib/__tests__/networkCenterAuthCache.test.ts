import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createAuthIdentityCacheIsolator } from "@/lib/network-center/authCacheIsolation";

describe("auth identity cache isolation", () => {
  it("removes only my-permissions and buildings families when the authenticated user id changes", () => {
    const queryClient = new QueryClient();
    const isolate = createAuthIdentityCacheIsolator(queryClient);

    queryClient.setQueryData(["my-permissions"], { network_center: { execute: true } });
    queryClient.setQueryData(["buildings", { includeVirtual: false }], [{ id: "building-a" }]);
    queryClient.setQueryData(["profile"], { id: "user-a", full_name: "User A" });
    queryClient.setQueryData(["unrelated-public-data"], { keep: true });

    expect(isolate("user-a")).toBe(false);
    expect(isolate("user-a")).toBe(false);
    expect(queryClient.getQueryData(["my-permissions"])).toBeDefined();

    expect(isolate("user-b")).toBe(true);
    expect(queryClient.getQueryData(["my-permissions"])).toBeUndefined();
    expect(queryClient.getQueryData(["buildings", { includeVirtual: false }])).toBeUndefined();
    expect(queryClient.getQueryData(["profile"])).toEqual({ id: "user-a", full_name: "User A" });
    expect(queryClient.getQueryData(["unrelated-public-data"])).toEqual({ keep: true });
  });

  it("clears sensitive cache on sign-out without treating token refresh as an identity change", () => {
    const queryClient = new QueryClient();
    const isolate = createAuthIdentityCacheIsolator(queryClient);

    isolate("user-a");
    queryClient.setQueryData(["my-permissions"], { cached: true });
    expect(isolate("user-a")).toBe(false);
    expect(queryClient.getQueryData(["my-permissions"])).toEqual({ cached: true });

    expect(isolate(null)).toBe(true);
    expect(queryClient.getQueryData(["my-permissions"])).toBeUndefined();
  });
});
