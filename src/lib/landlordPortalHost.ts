// Tên link cố định của link tên miền cho chủ nhà (chủ nhắn 24/10/2026) và ánh xạ tên miền ⇒ tên link.
// Tách riêng, KHÔNG import gì: cây route (chunk đầu) chỉ cần biết tên miền đang mở có phải link chủ nhà không —
// kéo zod + schema quyết toán vào đây làm chunk đầu phình quá ngưỡng.

/** Link cố định: tên miền riêng ⇒ tên link. Link nào cũng mở được ở /cn/<tên link> trên tên miền chính. */
export const LANDLORD_PORTAL_LINKS = [
  { slug: 'cgiang', host: 'cgiang.chillhome.io.vn' },
  { slug: 'agiang', host: 'agiang.chillhome.io.vn' },
] as const;
export type LandlordPortalSlug = typeof LANDLORD_PORTAL_LINKS[number]['slug'];

/** Tên link theo tên miền đang mở (không phải tên miền link ⇒ null). */
export function landlordPortalSlugFromHost(hostname: string | null | undefined): LandlordPortalSlug | null {
  const h = (hostname ?? '').toLowerCase().replace(/\.$/, '');
  return LANDLORD_PORTAL_LINKS.find((l) => l.host === h)?.slug ?? null;
}

export const landlordPortalUrl = (slug: string): string => {
  const l = LANDLORD_PORTAL_LINKS.find((x) => x.slug === slug);
  return l ? `https://${l.host}` : `https://chillhome.io.vn/cn/${slug}`;
};
