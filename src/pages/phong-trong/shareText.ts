// Tin «Chia sẻ» một phòng gửi khách (Zalo, tin nhắn). Ra NGOÀI công ty nên chỉ dùng dữ liệu công khai: dòng «Tình trạng»
// lấy saleFact.label (nhãn công khai — phòng giữ bằng cọc chỉ ghi «Đang giữ chỗ»), không bao giờ đọc depositHold (tên
// người cọc, mã phiếu), exitHold hay ghi chú nội bộ. Tách khỏi PhongTrongSheet.tsx (Sale đợt 3, 26/11/2026) để test được.
import { STATUS_META, fmtPrice, genInfoLines, type Building, type Room } from './sampleData';

/** Rút gọn địa chỉ gửi khách: số nhà "102/30…"/"331/70/101G…" -> giữ phần trước "/" đầu ("102","331");
 *  bỏ đuôi tỉnh/thành "… Hồ Chí Minh" / "TP.HCM" / "HCM". */
function shortAddr(addr: string): string {
  const s = addr.replace(/^(\d+)\/\S*/, "$1");
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const isCity = (p: string) =>
    /^(thành phố\s+)?hồ chí minh$/i.test(p) || /^tp\.?\s*hcm$/i.test(p) || /^hcm$/i.test(p);
  while (parts.length && isCity(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join(", ");
}

export function buildShareText(r: Room, building?: Building): string {
  const isPass = r.status === "pass";
  return [
    `🏠 ${r.buildingName} — Phòng ${r.code}${r.type ? ` · ${r.type}` : ""}`,
    `• Giá: ${fmtPrice(r.price)} triệu/tháng`,
    isPass
      ? (r.passContactManager
          ? `• Tình trạng: Khách pass phòng — Liên hệ quản lý`
          : `• Tình trạng: Khách pass phòng${r.passContactPhone ? " — LH " + r.passContactPhone + (r.passContactName ? " (" + r.passContactName + ")" : "") : ""}`)
      : `• Tình trạng: ${r.saleFact?.label || STATUS_META[r.status].label}`,
    `• Nội thất: ${r.amenities.join(", ")}`,
    ...(isPass && r.passAvailDate ? [`• Dự kiến trống từ: ${r.passAvailDate}`] : []),
    ...(isPass && r.passSalePolicy ? [`• Chính sách sale: ${r.passSalePolicy}`] : []),
    ...(r.saleNote ? [`• Khuyến mãi: ${r.saleNote}`] : []),
    `• Địa chỉ: ${shortAddr(r.buildingAddr)}`,
    ...(genInfoLines(building).length ? ['', '📋 Thông tin chung:'] : []),
    ...genInfoLines(building).map((t) => `• ${t}`),
  ].join("\n");
}
