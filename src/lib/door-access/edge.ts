import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { EDGE_FN } from "@/lib/edgeFunctions";

import {
  createdTempPasswordSchema,
  deletedSchema,
  discoverSchema,
  keysSchema,
  recordsSchema,
  statusSchema,
  tempPasswordsSchema,
  unlockedSchema,
  type CreatedTempPassword,
  type DiscoverResult,
  type DoorAccessStatus,
  type DoorKeysResult,
  type DoorRecordsPage,
  type DoorTempPasswordsResult,
  type DoorUnlockType,
  type TempPasswordPurpose,
} from "./dto";
import { DoorAccessError, edgeFailure } from "./errors";

/**
 * Gọi hàm Edge `door-access` (docs/he-thong/26-cua-van-tay.md §Hàm Edge).
 *
 * - JWT tươi của phiên hiện tại + `x-organization-id` = công ty ĐANG CHỌN (cùng khuôn
 *   `makeCopilotFetch`). Phiên đổi người giữa chừng ⇒ không dùng kết quả.
 * - `{ok:true, data}` ⇒ zod; sai dạng ⇒ lỗi, không trả rỗng.
 * - Lỗi đọc theo phong bì `{ok:false, error:{code, message, tuyaCode?, outcomeUnknown?}}`;
 *   thao tác ghi mà mạng đứt / phản hồi lạ ⇒ `outcomeUnknown` — không tự gửi lại.
 */

export interface DoorAccessCaller {
  actorId: string;
  organizationId: string;
}

interface SessionLike {
  access_token: string;
  user: { id: string };
}

export interface DoorEdgeDeps {
  getSession: () => Promise<{ session: SessionLike | null; failed: boolean }>;
  invoke: (body: Record<string, unknown>, headers: Record<string, string>) => Promise<{ data: unknown; error: unknown }>;
}

const supabaseDeps: DoorEdgeDeps = {
  async getSession() {
    const { data, error } = await supabase.auth.getSession();
    return { session: data.session ?? null, failed: Boolean(error) };
  },
  async invoke(body, headers) {
    const { data, error } = await supabase.functions.invoke(EDGE_FN.doorAccess, { body, headers });
    return { data: data as unknown, error: error as unknown };
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const okEnvelope = z.object({ ok: z.literal(true), data: z.unknown() });

/** Đọc status + JSON từ `error.context` (Response) của FunctionsHttpError. */
async function readErrorResponse(context: unknown): Promise<{ status: number | null; body: unknown }> {
  if (!isRecord(context)) return { status: null, body: null };
  const status = typeof context.status === "number" ? context.status : null;
  const json = context.json;
  if (typeof json !== "function") return { status, body: null };
  try {
    return { status, body: await (json as () => Promise<unknown>).call(context) };
  } catch {
    return { status, body: null };
  }
}

export async function invokeDoorAccess<T>(
  caller: DoorAccessCaller,
  body: Record<string, unknown>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  context: { operation: string; mutation: boolean },
  deps: DoorEdgeDeps = supabaseDeps,
): Promise<T> {
  let before: Awaited<ReturnType<DoorEdgeDeps["getSession"]>>;
  try {
    before = await deps.getSession();
  } catch {
    before = { session: null, failed: true };
  }
  if (before.failed || !before.session || before.session.user.id !== caller.actorId) {
    // Chưa gửi gì đi ⇒ kết quả rõ: chưa làm.
    throw new DoorAccessError("session", "Phiên đăng nhập đã thay đổi. Tải lại trang rồi thử lại.");
  }

  let result: { data: unknown; error: unknown };
  try {
    result = await deps.invoke(body, {
      Authorization: `Bearer ${before.session.access_token}`,
      "x-organization-id": caller.organizationId,
    });
  } catch {
    throw edgeFailure({ transport: "network", status: null, body: null, ...context });
  }

  let after: Awaited<ReturnType<DoorEdgeDeps["getSession"]>>;
  try {
    after = await deps.getSession();
  } catch {
    after = { session: null, failed: true };
  }
  if (after.failed || after.session?.user.id !== caller.actorId) {
    throw new DoorAccessError("session", "Phiên đăng nhập đã thay đổi trong lúc thực hiện. Tải lại trang.", {
      outcomeUnknown: context.mutation,
    });
  }

  if (result.error) {
    const name = isRecord(result.error) && typeof result.error.name === "string" ? result.error.name : "";
    if (name === "FunctionsHttpError") {
      const response = await readErrorResponse(isRecord(result.error) ? result.error.context : null);
      throw edgeFailure({ transport: "http", status: response.status, body: response.body, ...context });
    }
    throw edgeFailure({ transport: name === "FunctionsRelayError" ? "relay" : "network", status: null, body: null, ...context });
  }

  const envelope = okEnvelope.safeParse(result.data);
  if (!envelope.success) throw edgeFailure({ transport: "ok", status: 200, body: result.data, ...context });
  const parsed = schema.safeParse(envelope.data.data);
  if (!parsed.success) throw edgeFailure({ transport: "ok", status: 200, body: null, ...context });
  return parsed.data;
}

export const RECORDS_PAGE_SIZE = 50;

export interface RecordsQuery {
  deviceId: string;
  startMs: number;
  endMs: number;
  pageNo: number;
  pageSize?: number;
}

export interface CreateTempPasswordInput {
  deviceId: string;
  name: string;
  purpose: TempPasswordPurpose;
  effectiveSec: number;
  invalidSec: number;
}

export interface DeleteKeyInput {
  deviceId: string;
  unlockType: DoorUnlockType;
  unlockNo: number;
  tuyaUserId: string;
}

export function doorAccessEdge(caller: DoorAccessCaller, deps: DoorEdgeDeps = supabaseDeps) {
  const read = <T>(body: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>, operation: string) =>
    invokeDoorAccess(caller, body, schema, { operation, mutation: false }, deps);
  const write = <T>(body: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>, operation: string) =>
    invokeDoorAccess(caller, body, schema, { operation, mutation: true }, deps);

  return {
    status: (): Promise<DoorAccessStatus> => read({ action: "status" }, statusSchema, "kiểm tra kết nối SmartLife"),
    discover: (): Promise<DiscoverResult> => read({ action: "discover" }, discoverSchema, "tìm máy trên SmartLife"),
    records: (query: RecordsQuery): Promise<DoorRecordsPage> =>
      read(
        {
          action: "records",
          deviceId: query.deviceId,
          startMs: query.startMs,
          endMs: query.endMs,
          pageNo: query.pageNo,
          pageSize: query.pageSize ?? RECORDS_PAGE_SIZE,
        },
        recordsSchema,
        "tải lịch sử ra vào",
      ),
    keys: (deviceId: string): Promise<DoorKeysResult> =>
      read({ action: "keys", deviceId }, keysSchema, "tải danh sách vân tay trên máy"),
    tempPasswords: (deviceId: string): Promise<DoorTempPasswordsResult> =>
      read({ action: "temp_passwords", deviceId }, tempPasswordsSchema, "tải mật khẩu tạm"),
    createTempPassword: (input: CreateTempPasswordInput): Promise<CreatedTempPassword> =>
      write(
        {
          action: "create_temp_password",
          deviceId: input.deviceId,
          name: input.name,
          purpose: input.purpose,
          effectiveSec: input.effectiveSec,
          invalidSec: input.invalidSec,
        },
        createdTempPasswordSchema,
        "tạo mật khẩu tạm",
      ),
    deleteTempPassword: (deviceId: string, passwordId: number) =>
      write({ action: "delete_temp_password", deviceId, passwordId }, deletedSchema, "xoá mật khẩu tạm"),
    remoteUnlock: (deviceId: string) => write({ action: "remote_unlock", deviceId }, unlockedSchema, "mở cửa từ xa"),
    deleteKey: (input: DeleteKeyInput) =>
      write(
        {
          action: "delete_key",
          deviceId: input.deviceId,
          unlockType: input.unlockType,
          unlockNo: input.unlockNo,
          tuyaUserId: input.tuyaUserId,
        },
        deletedSchema,
        "xoá trên máy",
      ),
  };
}

export type DoorAccessEdge = ReturnType<typeof doorAccessEdge>;
