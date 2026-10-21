import { z } from "zod";

/**
 * Hợp đồng dữ liệu của trang Cửa vân tay — chép theo docs/he-thong/26-cua-van-tay.md.
 *
 * RPC chưa có trong `types.ts` (migration viết song song) nên đây là NGUỒN KIỂU DUY NHẤT cho
 * cả RPC lẫn hàm Edge `door-access`. Dữ liệu sai dạng ⇒ ném lỗi (lớp gọi đổi thành "máy chủ
 * trả dữ liệu chưa hợp lệ"), không bao giờ đọc thành danh sách rỗng.
 */

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nullableText = z.string().nullable();

export const DEVICE_KINDS = ["access_control", "wifi_lock"] as const;
export type DoorDeviceKind = (typeof DEVICE_KINDS)[number];
export const deviceKindSchema = z.enum(DEVICE_KINDS);

/** Ba loại số trên máy mà CRM gắn được với khách. */
export const UNLOCK_TYPES = ["fingerprint", "card", "password"] as const;
export type DoorUnlockType = (typeof UNLOCK_TYPES)[number];
export const unlockTypeSchema = z.enum(UNLOCK_TYPES);

export const TENANCIES = ["CURRENT", "MOVED_OUT", "NO_CONTRACT", "STAFF"] as const;
export type DoorTenancy = (typeof TENANCIES)[number];

export const ACTIONS = [
  "REMOTE_UNLOCK",
  "TEMP_PASSWORD_CREATE",
  "TEMP_PASSWORD_DELETE",
  "KEY_DELETE",
  "DEVICE_SAVE",
  "DEVICE_DISABLE",
  "KEY_LINK",
  "KEY_UNLINK",
] as const;
export type DoorAction = (typeof ACTIONS)[number];

export const ACTION_STATUSES = ["PENDING", "OK", "FAILED", "UNKNOWN"] as const;
export type DoorActionStatus = (typeof ACTION_STATUSES)[number];

export const PURPOSES = ["XEM_PHONG", "THO", "KHACH", "KHAC"] as const;
export type TempPasswordPurpose = (typeof PURPOSES)[number];

// ---------------------------------------------------------------------------------------------
// RPC (schema public, trả jsonb)

export const deviceSchema = z.object({
  id: uuid,
  building_id: uuid,
  building_name: nullableText,
  display_name: z.string().min(1),
  device_kind: deviceKindSchema,
  tuya_device_id: z.string().min(1),
  tuya_category: nullableText,
  tuya_product_name: nullableText,
  channel_id: z.number().int().nonnegative(),
  password_length: z.number().int().nonnegative(),
  is_active: z.boolean(),
  updated_at: timestamp,
  can: z.object({
    view: z.boolean(),
    temp_password: z.boolean(),
    remote_unlock: z.boolean(),
    manage_devices: z.boolean(),
  }),
});
export type DoorDevice = z.infer<typeof deviceSchema>;
export type DoorDeviceCan = DoorDevice["can"];

export const linkSchema = z.object({
  id: uuid,
  device_id: uuid,
  unlock_type: unlockTypeSchema,
  unlock_sn: z.number().int().nonnegative(),
  tuya_user_id: nullableText,
  device_user_name: nullableText,
  customer_id: uuid.nullable(),
  customer_name: nullableText,
  label: nullableText,
  linked_at: timestamp,
  linked_by_name: nullableText,
  tenancy: z.enum(TENANCIES),
  room_name: nullableText,
  contract_end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type DoorKeyLink = z.infer<typeof linkSchema>;

export const tenantSchema = z.object({
  customer_id: uuid,
  full_name: z.string(),
  room_id: uuid.nullable(),
  room_name: nullableText,
  contract_id: uuid.nullable(),
  is_representative: z.boolean(),
});
export type DoorTenant = z.infer<typeof tenantSchema>;

/** `tuya_password_id` là bigint: JSON trả số; nhận cả chuỗi chữ số, chuẩn hoá về chuỗi để so khớp. */
const tuyaPasswordId = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,19}$/)])
  .nullable()
  .transform((value) => (value === null ? null : String(value)));

export const logSchema = z.object({
  id: uuid,
  device_id: uuid.nullable(),
  device_name: nullableText,
  building_id: uuid.nullable(),
  building_name: nullableText,
  actor_id: uuid.nullable(),
  actor_name: nullableText,
  action: z.enum(ACTIONS),
  status: z.enum(ACTION_STATUSES),
  detail: z.record(z.unknown()).nullable(),
  tuya_password_id: tuyaPasswordId,
  error_code: nullableText,
  error_message: nullableText,
  created_at: timestamp,
  finished_at: timestamp.nullable(),
});
export type DoorActionLog = z.infer<typeof logSchema>;

export const devicesResultSchema = z.object({ devices: z.array(deviceSchema) });
export const linksResultSchema = z.object({ links: z.array(linkSchema) });
export const tenantsResultSchema = z.object({ tenants: z.array(tenantSchema) });
export const logsResultSchema = z.object({ logs: z.array(logSchema), has_more: z.boolean() });
export const unlinkResultSchema = z.object({ id: uuid, unlinked: z.literal(true) });

export type DoorLogsPage = z.infer<typeof logsResultSchema>;

// ---------------------------------------------------------------------------------------------
// Hàm Edge `door-access` — `{ok:true, data}`

export const MODES = ["off", "read", "all"] as const;
export type DoorAccessMode = (typeof MODES)[number];

export const statusSchema = z.object({
  configured: z.boolean(),
  connectedOrg: z.boolean(),
  mode: z.enum(MODES),
});
export type DoorAccessStatus = z.infer<typeof statusSchema>;

export const discoveredDeviceSchema = z.object({
  tuyaDeviceId: z.string().min(1),
  name: nullableText,
  category: nullableText,
  productName: nullableText,
  online: z.boolean().nullable(),
  kind: deviceKindSchema.nullable(),
  registered: z.object({ deviceId: uuid, buildingId: uuid }).nullable(),
});
export type DiscoveredDevice = z.infer<typeof discoveredDeviceSchema>;
export const discoverSchema = z.object({ devices: z.array(discoveredDeviceSchema), hasMore: z.boolean() });
export type DiscoverResult = z.infer<typeof discoverSchema>;

/** Cách mở theo thư viện Tuya (supabase/functions/door-access/tuyaDoor.ts). */
export const METHODS = ["fingerprint", "password", "card", "temporary", "dynamic", "app", "remote", "face", "other"] as const;
export type DoorMethod = (typeof METHODS)[number];
const methodSchema = z.enum(METHODS);

export const RECORD_KINDS = ["unlock", "alarm", "doorbell"] as const;
export type DoorRecordKind = (typeof RECORD_KINDS)[number];

export const recordSchema = z.object({
  id: z.string().min(1),
  at: z.number().nullable(),
  kind: z.enum(RECORD_KINDS),
  method: methodSchema,
  methodCode: nullableText,
  slot: z.union([z.number(), z.string()]).nullable(),
  userId: nullableText,
  userName: nullableText,
  unlockName: nullableText,
});
export type DoorRecord = z.infer<typeof recordSchema>;
export const recordsSchema = z.object({
  records: z.array(recordSchema),
  total: z.number().nullable(),
  hasMore: z.boolean(),
});
export type DoorRecordsPage = z.infer<typeof recordsSchema>;

const keyMethodSchema = z.object({
  method: methodSchema,
  methodCode: nullableText,
  sn: z.number().nullable(),
  name: nullableText,
});
export const keysSchema = z.object({
  users: z.array(
    z.object({
      userId: nullableText,
      name: nullableText,
      role: z.enum(["owner", "admin", "member"]).nullable(),
      userType: z.number().nullable(),
      methods: z.array(keyMethodSchema),
    }),
  ),
  unassigned: z.array(z.object({ method: methodSchema, methodCode: nullableText, sn: z.number().nullable() })),
  partial: z.boolean(),
});
export type DoorKeysResult = z.infer<typeof keysSchema>;
export type DoorDeviceUser = DoorKeysResult["users"][number];

export const tempPasswordSchema = z.object({
  id: z.number().int().nonnegative(),
  name: nullableText,
  phase: z.number().nullable(),
  effectiveSec: z.number().nullable(),
  invalidSec: z.number().nullable(),
  deliveryStatus: z.number().nullable(),
});
export type DoorTempPassword = z.infer<typeof tempPasswordSchema>;
export const tempPasswordsSchema = z.object({ passwords: z.array(tempPasswordSchema), hasMore: z.boolean() });
export type DoorTempPasswordsResult = z.infer<typeof tempPasswordsSchema>;

/** Mã chỉ đi qua đúng một lần trong kết quả này — không lưu ở đâu khác. */
export const createdTempPasswordSchema = z.object({
  passwordId: z.number().int().nonnegative(),
  password: z.string().regex(/^\d{6,10}$/),
  effectiveSec: z.number().int().positive(),
  invalidSec: z.number().int().positive(),
  logId: z.string().min(1),
});
export type CreatedTempPassword = z.infer<typeof createdTempPasswordSchema>;

export const deletedSchema = z.object({ deleted: z.boolean(), logId: z.string().min(1) });
export const unlockedSchema = z.object({ unlocked: z.boolean(), logId: z.string().min(1) });
