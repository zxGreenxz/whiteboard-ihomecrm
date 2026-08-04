import { describe, expect, it } from "vitest";

import { resolveNetworkActor } from "@/lib/network-center/actorIdentity";

describe("network center actor identity", () => {
  it("uses a matching profile, then auth display metadata, email, and user id", () => {
    const user = {
      id: "user-12345678",
      email: "operator@example.com",
      user_metadata: { display_name: "Tên từ auth" },
    };

    expect(resolveNetworkActor(user, { id: user.id, full_name: "Tên hồ sơ", email: "profile@example.com" })).toEqual({
      id: user.id,
      label: "Tên hồ sơ",
    });
    expect(resolveNetworkActor(user, null).label).toBe("Tên từ auth");
    expect(resolveNetworkActor({ ...user, user_metadata: {} }, null).label).toBe(user.email);
    expect(resolveNetworkActor({ id: user.id, user_metadata: {} }, null).label).toBe(user.id);
  });

  it("ignores a stale profile from another account without blocking on profile loading", () => {
    const user = {
      id: "user-b",
      email: "user-b@example.com",
      user_metadata: { display_name: "Tên auth B" },
    };

    expect(resolveNetworkActor(user, {
      id: "user-a",
      full_name: "Tên hồ sơ A",
      email: "user-a@example.com",
    })).toEqual({ id: "user-b", label: "Tên auth B" });
    expect(resolveNetworkActor(user, null)).toEqual({ id: "user-b", label: "Tên auth B" });
  });
});
