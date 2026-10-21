import { describe, expect, it, vi } from "vitest";

// Không dựng client Supabase thật (.env của worktree có thể trỏ production).
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  createdTempPasswordSchema,
  devicesResultSchema,
  keysSchema,
  logsResultSchema,
  recordsSchema,
  statusSchema,
} from "../dto";
import { DoorAccessError } from "../errors";
import { createDoorAccessRepository, nextActionLogCursor, type DoorRpcCall } from "../repository";
import { DEVICE_1, ORG, device, link, log } from "./fixtures";

describe("DTO: dữ liệu đúng hợp đồng thì đọc được", () => {
  it("Device, Link, Log, trạng thái, nhật ký ra vào, vân tay trên máy, mật khẩu vừa tạo", () => {
    expect(devicesResultSchema.parse({ devices: [device()] }).devices).toHaveLength(1);
    const logs = logsResultSchema.parse({ logs: [log({ tuya_password_id: "3001" }), log({ id: "00000000-0000-4000-8000-0000000002a2", tuya_password_id: null })], has_more: false });
    expect(logs.logs[0]?.tuya_password_id).toBe("3001");
    // bigint về dạng số vẫn chuẩn hoá thành chuỗi để so khớp.
    const numeric = logsResultSchema.parse({ logs: [{ ...log(), tuya_password_id: 3001 }], has_more: true });
    expect(numeric.logs[0]?.tuya_password_id).toBe("3001");
    expect(statusSchema.parse({ configured: true, connectedOrg: true, mode: "read" }).mode).toBe("read");
    expect(
      recordsSchema.parse({
        records: [{ id: "r1", at: 1, kind: "unlock", method: "fingerprint", methodCode: null, slot: 12, userId: null, userName: null, unlockName: null }],
        total: 1,
        hasMore: false,
      }).records,
    ).toHaveLength(1);
    expect(keysSchema.parse({ users: [], unassigned: [], partial: true }).partial).toBe(true);
    expect(createdTempPasswordSchema.parse({ passwordId: 1, password: "1234567", effectiveSec: 10, invalidSec: 20, logId: "x" }).password).toBe("1234567");
  });
});

describe("DTO: sai dạng thì LỖI, không thành danh sách rỗng", () => {
  it.each([
    ["thiếu mảng devices", {}],
    ["device thiếu can", { devices: [{ ...device(), can: undefined }] }],
    ["device_kind lạ", { devices: [{ ...device(), device_kind: "smoke_sensor" }] }],
    ["id không phải uuid", { devices: [{ ...device(), id: "abc" }] }],
  ])("devices: %s", (_name, payload) => {
    expect(devicesResultSchema.safeParse(payload).success).toBe(false);
  });

  it("log có action ngoài hợp đồng ⇒ lỗi (không đoán)", () => {
    expect(logsResultSchema.safeParse({ logs: [{ ...log(), action: "TEMP_PASSWORD_CREATED" }], has_more: false }).success).toBe(false);
  });

  it("mật khẩu vừa tạo không phải 6–10 chữ số ⇒ lỗi", () => {
    expect(createdTempPasswordSchema.safeParse({ passwordId: 1, password: "12a4567", effectiveSec: 10, invalidSec: 20, logId: "x" }).success).toBe(false);
    expect(createdTempPasswordSchema.safeParse({ passwordId: 1, password: "12345", effectiveSec: 10, invalidSec: 20, logId: "x" }).success).toBe(false);
  });
});

function repoWith(response: { data: unknown; error: { code?: string; message?: string } | null }) {
  const rpc = vi.fn<DoorRpcCall>(async () => response);
  return { rpc, repo: createDoorAccessRepository({ rpc }) };
}

describe("repository: tên RPC + tham số đúng hợp đồng", () => {
  it("door_access_devices_v1 với công ty và cờ máy tắt", async () => {
    const { rpc, repo } = repoWith({ data: { devices: [device()] }, error: null });
    await expect(repo.listDevices(ORG, true)).resolves.toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("door_access_devices_v1", { p_organization_id: ORG, p_include_inactive: true });
  });

  it("door_access_action_logs_v1: trang đầu không gửi mốc, lọc theo thao tác", async () => {
    const { rpc, repo } = repoWith({ data: { logs: [], has_more: false }, error: null });
    await repo.listActionLogs(ORG, { deviceId: DEVICE_1, actions: ["TEMP_PASSWORD_CREATE"], limit: 100 });
    expect(rpc).toHaveBeenCalledWith("door_access_action_logs_v1", {
      p_organization_id: ORG,
      p_device_id: DEVICE_1,
      p_actions: ["TEMP_PASSWORD_CREATE"],
      p_limit: 100,
      p_before: null,
      p_before_id: null,
    });
  });

  it("door_access_action_logs_v1: Xem thêm gửi CẢ created_at lẫn id của dòng cuối trang trước", async () => {
    const lastId = "00000000-0000-4000-8000-0000000002b2";
    const page = {
      logs: [
        log({ id: "00000000-0000-4000-8000-0000000002b1", created_at: "2026-10-21T07:00:00.123456+00:00" }),
        // Cùng created_at với dòng trên — chỉ mốc thời gian thì máy chủ sẽ bỏ sót dòng này.
        log({ id: lastId, created_at: "2026-10-21T07:00:00.123456+00:00" }),
      ],
      has_more: true,
    };
    const cursor = nextActionLogCursor(page);
    expect(cursor).toEqual({ before: "2026-10-21T07:00:00.123456+00:00", beforeId: lastId });

    const { rpc, repo } = repoWith({ data: { logs: [], has_more: false }, error: null });
    await repo.listActionLogs(ORG, { deviceId: DEVICE_1, cursor });
    expect(rpc).toHaveBeenCalledWith("door_access_action_logs_v1", {
      p_organization_id: ORG,
      p_device_id: DEVICE_1,
      p_actions: null,
      p_limit: 50,
      p_before: "2026-10-21T07:00:00.123456+00:00",
      p_before_id: lastId,
    });
  });

  it("hết trang hoặc trang rỗng ⇒ không có mốc kế", () => {
    expect(nextActionLogCursor({ logs: [log()], has_more: false })).toBeUndefined();
    expect(nextActionLogCursor({ logs: [], has_more: true })).toBeUndefined();
  });

  it("door_access_link_key_v1 gửi đủ tham số, khách hoặc nhãn", async () => {
    const { rpc, repo } = repoWith({ data: link(), error: null });
    await repo.linkKey(ORG, {
      deviceId: DEVICE_1,
      unlockType: "fingerprint",
      unlockSn: 12,
      tuyaUserId: "u1",
      deviceUserName: "Người dùng 01",
      customerId: null,
      label: "Nhân viên bảo vệ",
    });
    expect(rpc).toHaveBeenCalledWith("door_access_link_key_v1", {
      p_organization_id: ORG,
      p_device_id: DEVICE_1,
      p_unlock_type: "fingerprint",
      p_unlock_sn: 12,
      p_tuya_user_id: "u1",
      p_device_user_name: "Người dùng 01",
      p_customer_id: null,
      p_label: "Nhân viên bảo vệ",
    });
  });
});

describe("repository: lỗi RPC phân biệt quyền / dữ liệu / mạng", () => {
  it("dữ liệu sai dạng ⇒ invalid_result, KHÔNG trả rỗng", async () => {
    const { repo } = repoWith({ data: { devices: "không phải mảng" }, error: null });
    await expect(repo.listDevices(ORG)).rejects.toMatchObject({ kind: "invalid_result", outcomeUnknown: false });
  });

  it("42501 ⇒ quyền", async () => {
    const { repo } = repoWith({ data: null, error: { code: "42501", message: "permission denied for door" } });
    const error = await repo.listKeyLinks(ORG, DEVICE_1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoorAccessError);
    expect(error).toMatchObject({ kind: "permission" });
    expect((error as Error).message).not.toContain("permission denied");
  });

  it.each([
    ["22023", "validation"],
    ["23505", "conflict"],
    ["54000", "rate_limited"],
    ["55000", "state"],
  ])("%s ⇒ %s và hiện câu của máy chủ", async (code, kind) => {
    const { repo } = repoWith({ data: null, error: { code, message: "Máy đã thuộc công ty khác." } });
    await expect(repo.saveDevice(ORG, {
      tuyaDeviceId: "tuyaDevFake001",
      buildingId: "00000000-0000-4000-8000-0000000000a1",
      displayName: "Cửa A",
      deviceKind: "access_control",
      tuyaCategory: null,
      tuyaProductName: null,
      channelId: 1,
      passwordLength: 7,
    })).rejects.toMatchObject({ kind, message: "Máy đã thuộc công ty khác.", outcomeUnknown: false });
  });

  it("mất mạng khi ĐỌC ⇒ unavailable (thử lại được); khi GHI ⇒ chưa rõ kết quả", async () => {
    const network = { data: null, error: { message: "TypeError: Failed to fetch" } };
    await expect(repoWith(network).repo.listDevices(ORG)).rejects.toMatchObject({ kind: "unavailable", outcomeUnknown: false });
    await expect(repoWith(network).repo.disableDevice(ORG, DEVICE_1)).rejects.toMatchObject({ kind: "unavailable", outcomeUnknown: true });
  });

  it("hàm chưa có trên máy chủ (PGRST202) ⇒ not_deployed", async () => {
    const { repo } = repoWith({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(repo.listDevices(ORG)).rejects.toMatchObject({ kind: "not_deployed" });
  });
});
