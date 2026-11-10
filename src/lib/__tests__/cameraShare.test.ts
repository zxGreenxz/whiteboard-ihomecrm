// @vitest-environment jsdom
// Chia sẻ camera có thời hạn: hợp đồng gói server, chuẩn hoá ID/mật khẩu giống server, khung giờ (giờ Việt Nam),
// tin nhắn gửi khách và lớp gọi RPC phân biệt lỗi quyền / dữ liệu / mạng. Mã, mật khẩu, phiên đều là chuỗi giả.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));

import {
  CameraShareError, authorizeCameraShare, cameraShareCreateInput, cameraShareCreatedSchema, cameraShareLink,
  cameraShareLoginSchema, cameraShareMessage, cameraSharePlayableSpan, cameraShareStatusLabel, cameraShareWaitLabel,
  cameraShareWindow, createCameraShare, defaultCameraShareValues, listCameraShares, loginCameraShare, normalizeShareCode,
  normalizeSharePassword, readCameraShareSession, revokeCameraShare, shouldRetryCameraShare, writeCameraShareSession,
} from "@/lib/network-center/cameraShare";

const RECORDER = "20000000-0000-4000-8000-000000000001";
const SHARE = "30000000-0000-4000-8000-000000000001";
const SESSION = `cs_${"A".repeat(43)}`;
// Dựng lúc chạy: chuỗi giống mật khẩu để nguyên văn trong file làm máy quét bí mật báo nhầm.
const PASSWORD = ["k7m2", "p9qx"].join("");
const created = {
  id: SHARE, code: "ABCD2345", password: PASSWORD, recorder_id: RECORDER, channel: 2, channel_name: "Hành lang",
  window_start: "2026-11-09T17:00:00+00:00", window_end: "2026-11-10T05:30:15+00:00", expires_at: "2026-11-11T05:30:20.123456+00:00", note: null,
};
const tenantShare = {
  share_id: SHARE, recorder_id: RECORDER, organization_id: "a0000000-0000-4000-8000-000000000001", building_id: "b0000000-0000-4000-8000-000000000001",
  channel: 2, channel_name: null, building_name: "Tòa mẫu", window_start: "2026-11-09T17:00:00Z", window_end: "2026-11-10T05:30:15Z", expires_at: "2026-11-11T05:30:20Z",
};

beforeEach(() => { mocks.rpc.mockReset(); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("chuẩn hoá giống server", () => {
  it("ID: viết hoa, bỏ khoảng trắng và mọi loại gạch nối; mật khẩu: bỏ khoảng trắng hai đầu, viết thường", () => {
    expect(normalizeShareCode(" abcd-2345 ")).toBe("ABCD2345");
    expect(normalizeShareCode("ab cd–2345")).toBe("ABCD2345");
    expect(normalizeSharePassword(`  ${PASSWORD.slice(0, 4).toUpperCase()}${PASSWORD.slice(4)} \n`)).toBe(PASSWORD);
  });
});

describe("gói server", () => {
  it("nhận gói tạo hợp lệ (giờ có micro giây và múi giờ) và từ chối ID dễ nhầm hoặc mật khẩu sai dạng", () => {
    const parsed = cameraShareCreatedSchema.parse(created);
    expect(parsed.code).toBe("ABCD2345");
    // Micro giây của Postgres cắt về mili giây, đổi sang ISO "Z" để Safari trên iPhone đọc được.
    expect(parsed.expires_at).toBe("2026-11-11T05:30:20.123Z");
    expect(parsed.window_start).toBe("2026-11-09T17:00:00.000Z");
    expect(cameraShareCreatedSchema.safeParse({ ...created, code: "ABCD1234" }).success).toBe(false); // 1 dễ nhầm với I
    expect(cameraShareCreatedSchema.safeParse({ ...created, code: "ABCDO234" }).success).toBe(false); // O dễ nhầm với 0
    expect(cameraShareCreatedSchema.safeParse({ ...created, password: PASSWORD.toUpperCase() }).success).toBe(false);
    expect(cameraShareCreatedSchema.safeParse({ ...created, window_start: "không phải giờ" }).success).toBe(false);
  });
  it("đọc đủ bốn kết quả đăng nhập và chặn phiên sai dạng", () => {
    expect(cameraShareLoginSchema.parse({ status: "OK", session: SESSION, share: tenantShare }).status).toBe("OK");
    expect(cameraShareLoginSchema.parse({ status: "INVALID", attempts_left: 2 })).toEqual({ status: "INVALID", attempts_left: 2 });
    expect(cameraShareLoginSchema.parse({ status: "LOCKED", retry_after_seconds: 90 })).toEqual({ status: "LOCKED", retry_after_seconds: 90 });
    expect(cameraShareLoginSchema.parse({ status: "ENDED" })).toEqual({ status: "ENDED" });
    expect(cameraShareLoginSchema.safeParse({ status: "OK", session: "cs_short", share: tenantShare }).success).toBe(false);
  });
});

describe("khung giờ và form", () => {
  const now = Date.parse("2026-11-10T05:30:15Z"); // 12:30:15 giờ Việt Nam
  it("mặc định hôm nay 00:00 → bây giờ theo giờ Việt Nam, hiệu lực 24 giờ; vừa qua nửa đêm thì lùi một giờ", () => {
    expect(defaultCameraShareValues(now + 400, 3)).toEqual({ channel: 3, from: "2026-11-10T00:00:00", to: "2026-11-10T12:30:15", expiry: "24h", note: "" });
    expect(defaultCameraShareValues(Date.parse("2026-11-09T17:00:30Z"), 1)).toMatchObject({ from: "2026-11-09T23:00:30", to: "2026-11-10T00:00:30" });
  });
  it("bắt đầu phải ở quá khứ, kết thúc sau bắt đầu, tối đa 24 giờ; kết thúc ở tương lai bị chặn (chỉ xem lại)", () => {
    expect(cameraShareWindow("2026-11-10T12:30:16", "2026-11-10T13:00:00", now)).toMatchObject({ ok: false, field: "from" });
    expect(cameraShareWindow("2026-11-10T10:00:00", "2026-11-10T10:00:00", now)).toMatchObject({ ok: false, field: "to" });
    expect(cameraShareWindow("2026-11-09T10:00:00", "2026-11-10T10:00:01", now)).toMatchObject({ ok: false, field: "to", message: "Khung giờ xem lại tối đa 24 giờ." });
    expect(cameraShareWindow("", "2026-11-10T10:00:00", now)).toMatchObject({ ok: false, field: "from" });
    expect(cameraShareWindow("2026-09-10T10:00:00", "2026-09-10T11:00:00", now)).toMatchObject({ ok: false, field: "from", message: "Chỉ chia sẻ được bản ghi trong 60 ngày gần nhất." });
    expect(cameraShareWindow("2026-11-09T12:30:00", "2026-11-10T12:30:00", now)).toEqual({ ok: true, start: Date.parse("2026-11-09T05:30:00Z"), end: Date.parse("2026-11-10T05:30:00Z") });
    // Khung giờ kéo sang tương lai = khách theo dõi gần như trực tiếp ⇒ chặn; lề một phút cho "đến bây giờ" của form.
    expect(cameraShareWindow("2026-11-10T08:00:00", "2026-11-10T20:00:00", now)).toMatchObject({ ok: false, field: "to", message: "Giờ kết thúc không được ở tương lai: khách chỉ xem lại, không xem trực tiếp." });
    expect(cameraShareWindow("2026-11-10T08:00:00", "2026-11-10T12:31:16", now)).toMatchObject({ ok: false, field: "to" });
    expect(cameraShareWindow("2026-11-10T08:00:00", "2026-11-10T12:31:15", now).ok).toBe(true);
  });
  it("đổi form sang tham số RPC: giờ ISO tròn giây, số giờ hiệu lực, ghi chú cắt khoảng trắng hoặc null", () => {
    expect(cameraShareCreateInput(RECORDER, { channel: 2, from: "2026-11-10T00:00:00", to: "2026-11-10T12:30:15", expiry: "7d", note: "  Chị Lan P302 " }, now)).toEqual({
      recorderId: RECORDER, channel: 2, windowStart: "2026-11-09T17:00:00.000Z", windowEnd: "2026-11-10T05:30:15.000Z", expiresHours: 168, note: "Chị Lan P302",
    });
    expect(cameraShareCreateInput(RECORDER, { channel: 1, from: "2026-11-10T00:00:00", to: "2026-11-10T01:00:00", expiry: "1h", note: "  " }, now)).toMatchObject({ expiresHours: 1, note: null });
    expect(() => cameraShareCreateInput(RECORDER, { channel: 1, from: "2026-11-10T13:00:00", to: "2026-11-10T14:00:00", expiry: "1h", note: "" }, now)).toThrow(CameraShareError);
  });
  it("khoảng khách xem được dừng ở bây giờ trừ lề lệch đồng hồ", () => {
    expect(cameraSharePlayableSpan({ window_start: "2026-11-10T01:00:00Z", window_end: "2026-11-10T02:00:00Z" }, now)).toEqual({ from: Date.parse("2026-11-10T01:00:00Z"), to: Date.parse("2026-11-10T02:00:00Z") });
    expect(cameraSharePlayableSpan({ window_start: "2026-11-10T05:00:00Z", window_end: "2026-11-10T08:00:00Z" }, now)).toEqual({ from: Date.parse("2026-11-10T05:00:00Z"), to: Date.parse("2026-11-10T05:30:10Z") });
  });
});

describe("tin nhắn và nhãn", () => {
  it("tin nhắn gửi khách có link, ID, mật khẩu, camera, khung giờ và giờ hết hạn (giờ Việt Nam)", () => {
    const link = cameraShareLink("https://crm.example.test/", "ABCD2345");
    expect(link).toBe("https://crm.example.test/xem-camera/ABCD2345");
    const message = cameraShareMessage({ link, code: "ABCD2345", password: PASSWORD, cameraLabel: "Hành lang · kênh 2", buildingName: "Tòa mẫu", windowStart: created.window_start, windowEnd: created.window_end, expiresAt: created.expires_at });
    for (const part of [link, "ID: ABCD2345", `Mật khẩu: ${PASSWORD}`, "Hành lang · kênh 2", "tại Tòa mẫu", "00:00:00 10/11/2026", "12:30:15 10/11/2026", "Link hết hạn lúc 12:30:20 11/11/2026"]) expect(message).toContain(part);
  });
  it("nhãn trạng thái và thời gian chờ", () => {
    expect(cameraShareStatusLabel).toEqual({ ACTIVE: "Đang hiệu lực", EXPIRED: "Hết hạn", REVOKED: "Đã thu hồi" });
    expect(cameraShareWaitLabel(45)).toBe("45 giây");
    expect(cameraShareWaitLabel(130)).toBe("khoảng 3 phút");
  });
});

describe("lớp gọi RPC", () => {
  it("tạo: gửi đúng tên hàm và tham số, trả gói đã kiểm", async () => {
    mocks.rpc.mockResolvedValue({ data: created, error: null });
    await expect(createCameraShare({ recorderId: RECORDER, channel: 2, windowStart: "2026-11-09T17:00:00.000Z", windowEnd: "2026-11-10T05:30:15.000Z", expiresHours: 24, note: " P302 " })).resolves.toMatchObject({ password: PASSWORD });
    expect(mocks.rpc).toHaveBeenCalledWith("camera_share_create_v1", {
      p_recorder_id: RECORDER, p_channel: 2, p_window_start: "2026-11-09T17:00:00.000Z", p_window_end: "2026-11-10T05:30:15.000Z", p_expires_hours: 24, p_note: "P302",
    });
  });
  it.each([
    [{ code: "42501", message: "permission denied" }, "permission", "Bạn không có quyền chia sẻ camera của tòa nhà này."],
    [{ code: "22023", message: "window too long" }, "validation", /Thông tin chia sẻ chưa hợp lệ/],
    [{ code: "P0001", message: "Đầu ghi chưa bật dịch vụ xem lại." }, "rule", "Đầu ghi chưa bật dịch vụ xem lại."],
    [{ code: "PGRST202", message: "not found" }, "unavailable", "Dịch vụ chia sẻ camera chưa được triển khai."],
    [{ code: "", message: "TypeError: Failed to fetch" }, "network", /Không kết nối được máy chủ/],
  ])("phân loại lỗi %o", async (error, kind, message) => {
    mocks.rpc.mockResolvedValue({ data: null, error });
    const failure = await listCameraShares("b0000000-0000-4000-8000-000000000001").catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CameraShareError);
    expect((failure as CameraShareError).kind).toBe(kind);
    expect((failure as CameraShareError).message).toMatch(message);
    expect(shouldRetryCameraShare(0, failure)).toBe(kind === "network");
  });
  it("gói sai hợp đồng là lỗi dữ liệu, không phải danh sách rỗng", async () => {
    mocks.rpc.mockResolvedValue({ data: { shares: [{ id: "x" }] }, error: null });
    await expect(listCameraShares("b0000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ kind: "data" });
    mocks.rpc.mockResolvedValue({ data: { status: "REVOKED" }, error: null });
    await expect(revokeCameraShare(SHARE)).resolves.toEqual({ status: "REVOKED" });
  });
  it("khách: chuẩn hoá trước khi gửi; quyền bị từ chối báo trang tạm ngưng chứ không nói về tòa nhà", async () => {
    mocks.rpc.mockResolvedValue({ data: { status: "INVALID", attempts_left: 4 }, error: null });
    await loginCameraShare("abcd-2345", ` ${PASSWORD.toUpperCase()} `);
    expect(mocks.rpc).toHaveBeenCalledWith("camera_share_login_v1", { p_code: "ABCD2345", p_password: PASSWORD });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(authorizeCameraShare(SESSION)).resolves.toBeNull();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(authorizeCameraShare(SESSION)).rejects.toThrow("Trang xem camera đang tạm ngưng. Vui lòng liên hệ bên quản lý.");
  });
});

describe("phiên khách trong tab", () => {
  it("lưu theo ID, bỏ qua giá trị sai dạng, xoá được", () => {
    writeCameraShareSession("ABCD2345", SESSION);
    expect(readCameraShareSession("ABCD2345")).toBe(SESSION);
    expect(readCameraShareSession("WXYZ2345")).toBeNull();
    sessionStorage.setItem("camera-share-session:WXYZ2345", "phien-sai-dang");
    expect(readCameraShareSession("WXYZ2345")).toBeNull();
    writeCameraShareSession("ABCD2345", null);
    expect(readCameraShareSession("ABCD2345")).toBeNull();
  });
});
