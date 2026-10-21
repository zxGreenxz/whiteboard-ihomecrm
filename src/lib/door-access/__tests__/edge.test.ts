import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { doorAccessEdge, type DoorEdgeDeps } from "../edge";
import { edgeFailure, rpcFailure } from "../errors";
import { ACTOR, DEVICE_1, ORG } from "./fixtures";

const caller = { actorId: ACTOR, organizationId: ORG };

/** Response giả như FunctionsHttpError.context (chỉ cần status + json()). */
function httpError(status: number, body: unknown) {
  return {
    name: "FunctionsHttpError",
    context: { status, json: async () => body },
  };
}

function deps(result: { data: unknown; error: unknown } | (() => Promise<{ data: unknown; error: unknown }>), sessionUser = ACTOR) {
  const invoke = vi.fn<DoorEdgeDeps["invoke"]>(typeof result === "function" ? result : async () => result);
  const getSession = vi.fn<DoorEdgeDeps["getSession"]>(async () => ({
    session: { access_token: "jwt-fake", user: { id: sessionUser } },
    failed: false,
  }));
  return { invoke, getSession, deps: { invoke, getSession } satisfies DoorEdgeDeps };
}

describe("door-access Edge: gọi đúng hợp đồng", () => {
  it("gửi JWT + x-organization-id, đọc phong bì {ok:true,data}", async () => {
    const d = deps({ data: { ok: true, data: { configured: true, connectedOrg: true, mode: "all" } }, error: null });
    await expect(doorAccessEdge(caller, d.deps).status()).resolves.toEqual({ configured: true, connectedOrg: true, mode: "all" });
    expect(d.invoke).toHaveBeenCalledWith(
      { action: "status" },
      { Authorization: "Bearer jwt-fake", "x-organization-id": ORG },
    );
  });

  it("records gửi deviceId (id CRM), mốc ms, trang", async () => {
    const d = deps({ data: { ok: true, data: { records: [], total: 0, hasMore: false } }, error: null });
    await doorAccessEdge(caller, d.deps).records({ deviceId: DEVICE_1, startMs: 1_000_000_000_000, endMs: 1_000_086_400_000, pageNo: 2 });
    expect(d.invoke.mock.calls[0]?.[0]).toEqual({
      action: "records",
      deviceId: DEVICE_1,
      startMs: 1_000_000_000_000,
      endMs: 1_000_086_400_000,
      pageNo: 2,
      pageSize: 50,
    });
  });

  it("phiên đã đổi người ⇒ không gọi Edge", async () => {
    const d = deps({ data: null, error: null }, "someone-else");
    await expect(doorAccessEdge(caller, d.deps).status()).rejects.toMatchObject({ kind: "session" });
    expect(d.invoke).not.toHaveBeenCalled();
  });

  it("dữ liệu sai dạng khi ĐỌC ⇒ invalid_result, không trả rỗng", async () => {
    const d = deps({ data: { ok: true, data: { records: "?", total: 0, hasMore: false } }, error: null });
    await expect(doorAccessEdge(caller, d.deps).records({ deviceId: DEVICE_1, startMs: 1, endMs: 2, pageNo: 1 })).rejects.toMatchObject({
      kind: "invalid_result",
      outcomeUnknown: false,
    });
  });

  it("mở cửa: lỗi mạng ⇒ outcomeUnknown, gọi đúng MỘT lần", async () => {
    const d = deps(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(doorAccessEdge(caller, d.deps).remoteUnlock(DEVICE_1)).rejects.toMatchObject({ kind: "unavailable", outcomeUnknown: true });
    expect(d.invoke).toHaveBeenCalledTimes(1);
  });

  it("mở cửa: FunctionsFetchError ⇒ outcomeUnknown", async () => {
    const d = deps({ data: null, error: { name: "FunctionsFetchError", context: {} } });
    await expect(doorAccessEdge(caller, d.deps).remoteUnlock(DEVICE_1)).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it("tạo mật khẩu: 200 mà thiếu mã ⇒ chưa rõ kết quả (không coi là thất bại sạch)", async () => {
    const d = deps({ data: { ok: true, data: { passwordId: 1, effectiveSec: 1, invalidSec: 2, logId: "l" } }, error: null });
    await expect(
      doorAccessEdge(caller, d.deps).createTempPassword({ deviceId: DEVICE_1, name: "Thợ", purpose: "THO", effectiveSec: 1, invalidSec: 2 }),
    ).rejects.toMatchObject({ kind: "invalid_result", outcomeUnknown: true });
  });

  it("đọc phong bì lỗi của FunctionsHttpError", async () => {
    const d = deps({
      data: null,
      error: httpError(502, { ok: false, error: { code: "tuya_rejected", message: "device is offline", tuyaCode: 2001 } }),
    });
    const error = await doorAccessEdge(caller, d.deps).keys(DEVICE_1).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "tuya_rejected", tuyaCode: "2001" });
    expect((error as Error).message).toBe("SmartLife từ chối (mã 2001): device is offline.");
  });
});

describe("edgeFailure: bảng mã lỗi", () => {
  const read = (body: unknown, status = 400) => edgeFailure({ transport: "http", status, body, operation: "tải mật khẩu tạm", mutation: false });
  const write = (body: unknown, status = 400) => edgeFailure({ transport: "http", status, body, operation: "mở cửa từ xa", mutation: true });
  const env = (code: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: { code, message: "Câu máy chủ.", ...extra } });

  it("not_permitted ⇒ 'Bạn chưa có quyền …'", () => {
    const error = read(env("not_permitted"), 403);
    expect(error.kind).toBe("permission");
    expect(error.message).toBe("Bạn chưa có quyền tải mật khẩu tạm ở máy này.");
  });

  it("writes_disabled ⇒ chỉ đọc", () => {
    expect(write(env("writes_disabled"), 403)).toMatchObject({ kind: "read_only", message: "Đang ở chế độ chỉ đọc — chưa thao tác được trên máy." });
  });

  it.each(["rate_limited", "invalid_request", "conflict"])("%s ⇒ câu của máy chủ", (code) => {
    expect(read(env(code)).message).toBe("Câu máy chủ.");
  });

  it.each(["not_configured", "org_not_connected"])("%s ⇒ chưa kết nối", (code) => {
    expect(read(env(code), 503).kind).toBe("not_connected");
  });

  it("mode_off ⇒ đang tắt", () => {
    expect(read(env("mode_off"), 403).kind).toBe("mode_off");
  });

  it("tuya_unavailable khi ghi ⇒ outcomeUnknown theo máy chủ", () => {
    const error = write(env("tuya_unavailable", { outcomeUnknown: true }), 504);
    expect(error).toMatchObject({ kind: "unavailable", outcomeUnknown: true });
    expect(error.message).toContain("Chưa rõ");
  });

  it("tuya_unavailable khi đọc ⇒ lỗi mạng, thử lại được", () => {
    const error = read(env("tuya_unavailable"), 504);
    expect(error).toMatchObject({ kind: "unavailable", outcomeUnknown: false, retryable: true });
  });

  it("phản hồi không phải phong bì: 404 ⇒ hàm chưa triển khai; 401 ⇒ phiên", () => {
    expect(read({ code: "NOT_FOUND", message: "Requested function was not found" }, 404).kind).toBe("not_deployed");
    expect(read({ msg: "Invalid JWT" }, 401).kind).toBe("session");
  });

  it("5xx không phong bì khi GHI ⇒ chưa rõ kết quả; 4xx của cổng ⇒ chắc chắn chưa làm", () => {
    expect(write(null, 546)).toMatchObject({ outcomeUnknown: true });
    expect(write(null, 413)).toMatchObject({ outcomeUnknown: false });
  });

  it("không lộ chữ kỹ thuật của mã lạ", () => {
    const error = read(env("internal", { message: "TypeError: x is undefined at handler" }), 500);
    expect(error.kind).toBe("internal");
    expect(error.message).not.toContain("TypeError");
  });
});

describe("rpcFailure", () => {
  it("lỗi cổng không SQLSTATE khi ghi ⇒ chưa rõ kết quả", () => {
    expect(rpcFailure({ message: "<html>504 Gateway Timeout</html>" }, { operation: "gắn số", mutation: true })).toMatchObject({
      outcomeUnknown: true,
    });
  });

  it("phiên hết hạn ⇒ session", () => {
    expect(rpcFailure({ code: "PGRST301", message: "JWT expired" }, { operation: "tải", mutation: false }).kind).toBe("session");
  });
});
