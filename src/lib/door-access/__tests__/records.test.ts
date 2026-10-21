import { describe, expect, it } from "vitest";

import { recordMethodLabel } from "../format";
import { reconcileKeys } from "../reconcile";
import { indexLinks, indexTempPasswordNames, mergeRecordPages, recordPerson } from "../records";
import { keys, link, record } from "./fixtures";

describe("Lịch sử ra vào: cách mở", () => {
  it.each([
    [{ method: "fingerprint" as const, slot: 12 }, "Vân tay #12"],
    [{ method: "card" as const, slot: 3 }, "Thẻ #3"],
    [{ method: "password" as const, slot: 2 }, "Mật khẩu #2"],
    [{ method: "temporary" as const, slot: 3001 }, "Mật khẩu tạm"],
    [{ method: "app" as const, slot: null }, "App"],
    [{ method: "remote" as const, slot: null }, "Từ xa"],
    [{ method: "fingerprint" as const, slot: "abc" }, "Vân tay"],
  ])("%o ⇒ %s", (input, label) => {
    expect(recordMethodLabel(record(input))).toBe(label);
  });

  it("chuông / cảnh báo theo kind", () => {
    expect(recordMethodLabel(record({ kind: "doorbell", method: "other" }))).toBe("Chuông");
    expect(recordMethodLabel(record({ kind: "alarm", method: "other", slot: "hijack" }))).toBe("Cảnh báo");
  });
});

describe("Lịch sử ra vào ↔ liên kết", () => {
  const links = indexLinks([link(), link({ id: "00000000-0000-4000-8000-0000000001a2", unlock_type: "card", unlock_sn: 3, customer_id: null, customer_name: null, label: "Nhân viên bảo vệ", tenancy: "STAFF", room_name: null })]);

  it("vân tay có số đã gắn ⇒ tên khách + phòng", () => {
    expect(recordPerson(record(), links)).toMatchObject({ name: "Nguyễn Văn Thử", detail: "P302", source: "link" });
  });

  it("thẻ gắn nhãn ⇒ nhãn", () => {
    expect(recordPerson(record({ method: "card", slot: 3 }), links)).toMatchObject({ name: "Nhân viên bảo vệ", source: "link" });
  });

  it("cùng số nhưng KHÁC loại không được ghép nhầm", () => {
    expect(recordPerson(record({ method: "password", slot: 12, userName: null, unlockName: null }), links)).toMatchObject({
      name: "Chưa gắn",
      source: "none",
    });
  });

  it("chưa gắn ⇒ tên trên máy (userName rồi unlockName), không có thì 'Chưa gắn'", () => {
    expect(recordPerson(record({ slot: 99, userName: "Người dùng 99" }), links)).toMatchObject({ name: "Người dùng 99", source: "device" });
    expect(recordPerson(record({ slot: 99, userName: null, unlockName: "Ngón cái" }), links)).toMatchObject({ name: "Ngón cái" });
    expect(recordPerson(record({ slot: 99, userName: null, unlockName: null }), links)).toMatchObject({ name: "Chưa gắn" });
  });

  it("App/Từ xa không tra liên kết dù slot trùng số; không có tên thì '—' (không phải 'Chưa gắn')", () => {
    expect(recordPerson(record({ method: "app", slot: 12, userName: "Chủ nhà" }), links)).toMatchObject({ name: "Chủ nhà", source: "device" });
    expect(recordPerson(record({ method: "app", slot: null, userName: null, unlockName: null }), links)).toMatchObject({ name: "—", source: "none" });
  });

  it("mật khẩu tạm tạo từ CRM ⇒ tên đặt lúc tạo; tạo ngoài CRM ⇒ '—'", () => {
    const names = indexTempPasswordNames([
      { action: "TEMP_PASSWORD_CREATE", status: "OK", tuya_password_id: "3001", detail: { name: " Xem phòng 201 ", purpose: "XEM_PHONG" } },
      { action: "TEMP_PASSWORD_CREATE", status: "FAILED", tuya_password_id: null, detail: { name: "Hỏng" } },
      { action: "TEMP_PASSWORD_DELETE", status: "OK", tuya_password_id: "3002", detail: { password_id: 3002 } },
      { action: "TEMP_PASSWORD_CREATE", status: "OK", tuya_password_id: "3003", detail: null },
    ]);
    expect([...names]).toEqual([["3001", "Xem phòng 201"]]);
    const temp = { method: "temporary" as const, userName: null, unlockName: null };
    expect(recordPerson(record({ ...temp, slot: 3001 }), links, names)).toMatchObject({ name: "Xem phòng 201", source: "temp" });
    expect(recordPerson(record({ ...temp, slot: "3001" }), links, names)).toMatchObject({ name: "Xem phòng 201" });
    expect(recordPerson(record({ ...temp, slot: 9999 }), links, names)).toMatchObject({ name: "—", source: "none" });
    // Mật khẩu tạm không bao giờ ghép nhầm với liên kết mật khẩu cố định cùng số.
    expect(recordPerson(record({ ...temp, slot: 3 }), links, names)).toMatchObject({ name: "—" });
  });

  it("gộp trang Xem thêm, bỏ bản trùng id", () => {
    const merged = mergeRecordPages([{ records: [record({ id: "a" }), record({ id: "b" })] }, { records: [record({ id: "b" }), record({ id: "c" })] }]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("Đối chiếu vân tay", () => {
  it("ghép số trên máy với liên kết, tính Cần xoá / Không còn trên máy / Chưa gắn", () => {
    const result = reconcileKeys(keys(), [
      link({ unlock_type: "fingerprint", unlock_sn: 12, tenancy: "MOVED_OUT" }),
      link({ id: "00000000-0000-4000-8000-0000000001a3", unlock_type: "fingerprint", unlock_sn: 77, tenancy: "CURRENT", customer_name: "Trần Thị Thử" }),
    ]);
    expect(result.rows.map((row) => row.key)).toEqual(["fingerprint:12", "fingerprint:40", "fingerprint:77", "card:3"]);

    const fp12 = result.rows.find((row) => row.key === "fingerprint:12");
    expect(fp12).toMatchObject({ onDevice: true, state: "MOVED_OUT", needsDelete: true, tuyaUserId: "tuyaUserFake01", keyName: "Ngón trỏ" });
    expect(result.needsDelete.map((row) => row.key)).toEqual(["fingerprint:12"]);

    const fp77 = result.rows.find((row) => row.key === "fingerprint:77");
    expect(fp77).toMatchObject({ onDevice: false, goneFromDevice: true, needsDelete: false, state: "CURRENT" });
    expect(result.gone.map((row) => row.key)).toEqual(["fingerprint:77"]);

    // fingerprint:40 (chưa gán người trên máy) và card:3 chưa có liên kết.
    expect(result.unlinked).toBe(2);
    expect(result.rows.find((row) => row.key === "fingerprint:40")).toMatchObject({ tuyaUserId: null, state: "UNLINKED" });
  });

  it("khách đã trả phòng mà số KHÔNG còn trên máy thì không 'Cần xoá'", () => {
    const result = reconcileKeys(keys({ users: [], unassigned: [] }), [link({ tenancy: "MOVED_OUT" })]);
    expect(result.needsDelete).toEqual([]);
    expect(result.gone).toHaveLength(1);
  });

  it("NO_CONTRACT và STAFF không vào Cần xoá", () => {
    const result = reconcileKeys(keys(), [link({ tenancy: "NO_CONTRACT" }), link({ id: "00000000-0000-4000-8000-0000000001a4", unlock_type: "card", unlock_sn: 3, tenancy: "STAFF" })]);
    expect(result.needsDelete).toEqual([]);
  });

  it("bỏ cách mở không gắn được (khuôn mặt) và số rỗng; số trùng giữa người dùng và 'chưa gán' chỉ một dòng", () => {
    const result = reconcileKeys(
      keys({
        users: [
          {
            userId: "u1",
            name: "A",
            role: null,
            userType: null,
            methods: [
              { method: "face", methodCode: "unlock_face", sn: 1, name: null },
              { method: "fingerprint", methodCode: null, sn: null, name: null },
              { method: "fingerprint", methodCode: null, sn: 5, name: null },
            ],
          },
        ],
        unassigned: [{ method: "fingerprint", methodCode: null, sn: 5 }],
      }),
      [],
    );
    expect(result.rows.map((row) => row.key)).toEqual(["fingerprint:5"]);
    expect(result.rows[0]?.tuyaUserId).toBe("u1");
  });

  it("máy trả danh sách chưa đủ ⇒ báo partial", () => {
    expect(reconcileKeys(keys({ partial: true }), []).partial).toBe(true);
  });
});
