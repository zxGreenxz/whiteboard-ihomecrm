// Nhãn "Kỳ / ngày" của một hoá đơn trong bảng Tài chính (bản desktop mới).
//
// VÌ SAO PHẢI GHÉP TỪ HAI NGUỒN — đo trên production 12/09/2026:
//   · `invoices.billing_month` NOT NULL, 1470/1470 hoá đơn còn sống đều có kỳ
//     THÁNG. Đây cũng là thứ đang in trong tên hoá đơn ("TIỀN PHÒNG - … - 09/2026").
//   · Khoảng NGÀY chi tiết không nằm trên bảng `invoices` mà nằm ở từng dòng
//     (`invoice_items.from_date/to_date`), và chỉ 1047/1470 hoá đơn (71%) có ít
//     nhất một dòng mang ngày (1219/5450 dòng).
// ⇒ Có ngày thì hiện khoảng ngày (thông tin nhiều hơn), không có thì hiện kỳ
//   tháng. Không bao giờ trả chuỗi rỗng — ô trống trong bảng tiền đọc như
//   "thiếu dữ liệu", trong khi sự thật là "hệ thống chỉ biết tới tháng".
//
// Kỳ thật bám THÁNG DƯƠNG LỊCH (01/09–30/09; tháng đầu vào ở thì 06/09–30/09).
// File thiết kế vẽ "06/09 – 05/10/2026" là số minh hoạ, không phải cách hệ
// thống chia kỳ — đừng sửa hàm này cho khớp hình.

export interface DongHoaDonCoKy {
  from_date?: string | null;
  to_date?: string | null;
}

export interface HoaDonCoKy {
  billing_month?: string | null;
  invoice_items?: DongHoaDonCoKy[] | null;
}

/** "2026-09-30" → 3 số; trả null cho mọi thứ không phải ngày ISO. */
function tachNgayIso(gt: string | null | undefined): [number, number, number] | null {
  if (!gt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(gt);
  if (!m) return null;
  const nam = Number(m[1]);
  const thang = Number(m[2]);
  const ngay = Number(m[3]);
  if (thang < 1 || thang > 12 || ngay < 1 || ngay > 31) return null;
  return [nam, thang, ngay];
}

const hai = (n: number) => String(n).padStart(2, "0");

/** Kỳ tháng từ `billing_month` ("2026-09" → "09/2026"). Dị dạng thì trả nguyên. */
export function nhanKyThang(billingMonth: string | null | undefined): string {
  if (!billingMonth) return "";
  const m = /^(\d{4})-(\d{2})$/.exec(billingMonth);
  return m ? `${m[2]}/${m[1]}` : billingMonth;
}

export function nhanKyHoaDon(hoaDon: HoaDonCoKy): string {
  const dong = hoaDon.invoice_items ?? [];

  let tu: [number, number, number] | null = null;
  let den: [number, number, number] | null = null;
  for (const d of dong) {
    const a = tachNgayIso(d.from_date);
    const b = tachNgayIso(d.to_date);
    // Chỉ nhận dòng có ĐỦ CẶP. Một dòng chỉ có from_date là dữ liệu dở dang;
    // lấy nó rồi ghép với to_date của dòng khác sẽ dựng ra một khoảng thời gian
    // chưa từng tồn tại.
    if (!a || !b) continue;
    if (!tu || a < tu) tu = a;
    if (!den || b > den) den = b;
  }

  if (tu && den) {
    const cungNam = tu[0] === den[0];
    const veDau = cungNam
      ? `${hai(tu[2])}/${hai(tu[1])}`
      : `${hai(tu[2])}/${hai(tu[1])}/${tu[0]}`;
    return `${veDau} – ${hai(den[2])}/${hai(den[1])}/${den[0]}`;
  }

  return nhanKyThang(hoaDon.billing_month) || "—";
}
