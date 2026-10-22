import type { DoorActionLog, DoorDevice, DoorKeyLink, DoorKeysResult, DoorRecord } from "../dto";

/** Dữ liệu giả cho test — tên/địa chỉ/id bịa, không có dữ liệu thật (repo công khai). */
export const ORG = "00000000-0000-4000-8000-000000000001";
export const ACTOR = "00000000-0000-4000-8000-000000000002";
export const BUILDING_A = "00000000-0000-4000-8000-0000000000a1";
export const BUILDING_B = "00000000-0000-4000-8000-0000000000b1";
export const DEVICE_1 = "00000000-0000-4000-8000-0000000000d1";
export const DEVICE_2 = "00000000-0000-4000-8000-0000000000d2";
export const CUSTOMER_1 = "00000000-0000-4000-8000-0000000000c1";
export const CUSTOMER_2 = "00000000-0000-4000-8000-0000000000c2";

export function device(overrides: Partial<DoorDevice> = {}): DoorDevice {
  return {
    id: DEVICE_1,
    building_id: BUILDING_A,
    building_name: "Tòa A",
    display_name: "Cửa chính Tòa A",
    device_kind: "access_control",
    tuya_device_id: "tuyaDevFake001",
    tuya_category: "mk",
    tuya_product_name: "Máy kiểm soát giả",
    channel_id: 1,
    password_length: 7,
    is_active: true,
    updated_at: "2026-10-21T07:00:00.000000+00:00",
    can: { view: true, temp_password: true, remote_unlock: true, manage_devices: true },
    ...overrides,
  };
}

export function link(overrides: Partial<DoorKeyLink> = {}): DoorKeyLink {
  return {
    id: "00000000-0000-4000-8000-0000000001a1",
    device_id: DEVICE_1,
    unlock_type: "fingerprint",
    unlock_sn: 12,
    tuya_user_id: "tuyaUserFake01",
    device_user_name: "Người dùng 01",
    customer_id: CUSTOMER_1,
    customer_name: "Nguyễn Văn Thử",
    label: null,
    linked_at: "2026-10-01T03:00:00+00:00",
    linked_by_name: "Quản lý Thử",
    tenancy: "CURRENT",
    room_name: "P302",
    contract_end_date: "2027-01-31",
    ...overrides,
  };
}

export function record(overrides: Partial<DoorRecord> = {}): DoorRecord {
  return {
    id: "rec-1",
    at: Date.UTC(2026, 9, 21, 7, 5),
    kind: "unlock",
    method: "fingerprint",
    methodCode: "unlock_fingerprint",
    slot: 12,
    userId: "tuyaUserFake01",
    userName: "Người dùng 01",
    unlockName: null,
    ...overrides,
  };
}

export function log(overrides: Partial<DoorActionLog> = {}): DoorActionLog {
  return {
    id: "00000000-0000-4000-8000-0000000002a1",
    device_id: DEVICE_1,
    device_name: "Cửa chính Tòa A",
    building_id: BUILDING_A,
    building_name: "Tòa A",
    actor_id: ACTOR,
    actor_name: "Quản lý Thử",
    action: "TEMP_PASSWORD_CREATE",
    status: "OK",
    detail: { name: "Xem phòng P302", purpose: "XEM_PHONG", effective_sec: 1_792_000_000, invalid_sec: 1_792_007_200 },
    tuya_password_id: "3001",
    error_code: null,
    error_message: null,
    created_at: "2026-10-21T07:00:00+00:00",
    finished_at: "2026-10-21T07:00:02+00:00",
    ...overrides,
  };
}

export function keys(overrides: Partial<DoorKeysResult> = {}): DoorKeysResult {
  return {
    users: [
      {
        userId: "tuyaUserFake01",
        name: "Người dùng 01",
        role: "member",
        userType: 20,
        methods: [
          { method: "fingerprint", methodCode: "unlock_fingerprint", sn: 12, name: "Ngón trỏ" },
          { method: "card", methodCode: "unlock_card", sn: 3, name: null },
        ],
      },
    ],
    unassigned: [{ method: "fingerprint", methodCode: "unlock_fingerprint", sn: 40 }],
    partial: false,
    ...overrides,
  };
}
