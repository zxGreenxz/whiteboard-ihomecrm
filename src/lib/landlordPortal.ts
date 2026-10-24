// =============================================================================
// landlordPortal — link tên miền cho chủ nhà vào bằng PIN (chủ nhắn 24/10/2026):
//   · cgiang.chillhome.io.vn (950NK), agiang.chillhome.io.vn (44TL + 481NVK, có ô chọn toà) — tên link CỐ ĐỊNH ở
//     đây; trang quản trị chỉ gộp toà vào link và quản lý người xem (tên + PIN 6 số);
//   · đăng nhập một lần, lưu phiên trên máy như CRM; mỗi PIN là một người xem — thao tác ghi theo người đó.
// Server là hàng rào thật (migration 20261024072823): chống dò PIN 10 lần sai / 15 phút / link, PIN băm bcrypt,
// phiên chỉ lưu sha256. Ở đây chỉ có hình gói (zod), tên link và chỗ cất phiên trên máy.
// =============================================================================
import { z } from 'zod';
import { settlementMonthSchema, settlementOverviewSchema } from '@/lib/landlordSettlement';

// tên link cố định + ánh xạ tên miền ở module nhỏ (cây route trong chunk đầu dùng mà không kéo zod)
export {
  LANDLORD_PORTAL_LINKS, landlordPortalSlugFromHost, landlordPortalUrl, type LandlordPortalSlug,
} from '@/lib/landlordPortalHost';

export const PORTAL_PIN = /^\d{6}$/;

// ─────────────────────────────── gói server ───────────────────────────────

export const portalLoginSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('OK'), session: z.string().regex(/^[A-Za-z0-9_-]{43}$/), viewer: z.string(), expires_at: z.string() }),
  z.object({ status: z.literal('INVALID'), attempts_left: z.number().int().nonnegative() }),
  z.object({ status: z.literal('LOCKED'), retry_after_seconds: z.number().int().positive() }),
  z.object({ status: z.literal('NOT_FOUND') }),
]);
export type PortalLoginResult = z.infer<typeof portalLoginSchema>;

export const portalPayloadSchema = z.object({
  /** Tên người xem của phiên (PIN). */
  viewer: z.string(),
  buildings: z.array(z.object({ key: z.string(), building_name: z.string(), landlord_name: z.string() })),
  /** Khoá toà đang xem; link chưa có toà ⇒ null. */
  selected: z.string().nullable(),
  overview: settlementOverviewSchema.nullable(),
  month: settlementMonthSchema.nullable(),
});
export type PortalPayload = z.infer<typeof portalPayloadSchema>;

export const portalViewerSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  created_at: z.string(),
  last_login_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type PortalViewer = z.infer<typeof portalViewerSchema>;

export const portalsSchema = z.object({
  portals: z.array(z.object({
    slug: z.string(),
    building_ids: z.array(z.string().uuid()),
    updated_at: z.string(),
    /** Lần nhập PIN sai trong 24 giờ và link có đang tạm khoá (10 lần / 15 phút hoặc 30 lần / 24 giờ). */
    failures_24h: z.number().int().nonnegative(),
    locked: z.boolean(),
    viewers: z.array(portalViewerSchema),
  })),
});
export type LandlordPortals = z.infer<typeof portalsSchema>;

export const portalSaveReceiptSchema = z.object({ slug: z.string(), building_ids: z.array(z.string().uuid()) });
/** PIN trả về đúng MỘT lần lúc thêm người xem. */
export const portalViewerAddReceiptSchema = z.object({ id: z.string().uuid(), label: z.string(), pin: z.string().regex(PORTAL_PIN) });
export const portalViewerRevokeReceiptSchema = z.object({ status: z.enum(['REVOKED', 'ALREADY_REVOKED']) });
export const portalUnlockReceiptSchema = z.object({ status: z.literal('UNLOCKED'), cleared: z.number().int().nonnegative() });

/** PIN dễ đoán (server không bao giờ sinh): lặp một số hoặc dãy liên tiếp tăng / giảm. */
export const isWeakPin = (pin: string): boolean =>
  /^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin);

// ─────────────────────────────── phiên trên máy ───────────────────────────────

const khoaPhien = (slug: string) => `landlord-portal-session:${slug}`;

/** Phiên đã lưu (trình duyệt chặn bộ nhớ / chế độ riêng tư ⇒ null, trang hỏi PIN như bình thường). */
export function readPortalSession(slug: string): string | null {
  let v: string | null = null;
  try {
    v = globalThis.localStorage.getItem(khoaPhien(slug));
  } catch {
    /* đọc localStorage bị chặn (chế độ riêng tư) — coi như chưa đăng nhập, trang hỏi PIN */
  }
  return v && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

export function writePortalSession(slug: string, session: string | null): void {
  try {
    if (session) globalThis.localStorage.setItem(khoaPhien(slug), session);
    else globalThis.localStorage.removeItem(khoaPhien(slug));
  } catch {
    // không lưu được thì lần sau nhập lại PIN — không chặn việc xem
  }
}
