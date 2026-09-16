// Đọc thời hạn ghi trên ảnh "Hợp đồng cho thuê, mượn, ở nhờ" đã ký.
//
// VÌ SAO: hạn tạm trú khai trên Cổng DVC phải đúng bằng ngày ghi trong hợp đồng.
// Trước đây nút DVC tính hạn từ NGÀY BẤM NÚT cộng 12/24 tháng, còn hợp đồng lại
// ghi theo ngày chủ tải tờ khai CT01 về in — hai mốc khác nhau nên lệch vài ngày
// (đo thật 16/09/2026: hợp đồng ghi 14/09/2028, nút đề nghị 16/09/2028).
// Chữ trên ảnh là nguồn duy nhất còn lại của ngày đó, nên đọc thẳng từ đó.
//
// Bộ nhận dạng chữ chạy trong máy (src/lib/ocr) nên ảnh giấy tờ không rời trình duyệt.

export interface HanHopDong {
  /** dd/mm/yyyy — ngày bắt đầu ghi trên hợp đồng. */
  from: string;
  /** dd/mm/yyyy — ngày hết hạn ghi trên hợp đồng; đây là hạn tạm trú cần khai. */
  to: string;
  /** Số tháng đọc được trên giấy, nếu có. */
  months?: number;
  /** `cap-ngay` = đọc thẳng cặp "từ … đến …"; `ngay-cong-thang` = ngày lập cộng số tháng. */
  nguon: 'cap-ngay' | 'ngay-cong-thang';
}

/** Bỏ dấu và gom khoảng trắng để so khớp không phụ thuộc cách OCR đánh dấu. */
export function khongDau(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

const NGAY_SO = String.raw`(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})`;
const CAP_NGAY = new RegExp(String.raw`tu\s*:?\s*${NGAY_SO}\s*den\s*:?\s*${NGAY_SO}`);
const NGAY_CHU = /ngay\s*:?\s*(\d{1,2})\s*thang\s*:?\s*(\d{1,2})\s*nam\s*:?\s*(\d{4})/;
const SO_THANG = /thoi han[^0-9]{0,40}?(\d{1,3})\s*thang/;

const hai = (n: number) => String(n).padStart(2, '0');
const inNgay = (d: Date) => `${hai(d.getUTCDate())}/${hai(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;

/** Ngày lịch có thật; trả null nếu OCR đọc ra 31/02 hay tháng 13. */
export function ngayHopLe(ngay: number, thang: number, nam: number): Date | null {
  if (!(ngay >= 1 && ngay <= 31 && thang >= 1 && thang <= 12 && nam >= 2000 && nam <= 2100)) return null;
  const d = new Date(Date.UTC(nam, thang - 1, ngay));
  return d.getUTCFullYear() === nam && d.getUTCMonth() === thang - 1 && d.getUTCDate() === ngay ? d : null;
}

/** Cộng tháng, giữ ngày trong tháng và lùi lại nếu tháng đích ngắn hơn (31/01 + 1 tháng = 28/02). */
export function congThang(goc: Date, thang: number): Date {
  const cuoiThangDich = new Date(Date.UTC(goc.getUTCFullYear(), goc.getUTCMonth() + thang + 1, 0)).getUTCDate();
  return new Date(Date.UTC(goc.getUTCFullYear(), goc.getUTCMonth() + thang, Math.min(goc.getUTCDate(), cuoiThangDich)));
}

/** Số tháng tròn giữa hai mốc, dùng để kiểm cặp ngày đọc được có khớp số tháng trên giấy. */
function soThangGiua(from: Date, to: Date): number {
  const thang = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? thang - 1 : thang;
}

/**
 * Rút thời hạn từ các dòng chữ bộ nhận dạng đọc được trên ảnh hợp đồng.
 *
 * Trả `null` khi không tìm thấy gì đáng tin — gọi bên ngoài phải giữ nguyên cách
 * tính cũ chứ đừng đoán: khai sai hạn tạm trú còn tệ hơn khai theo mặc định.
 */
export function docHanHopDong(dong: readonly string[]): HanHopDong | null {
  // Nối mọi dòng: bộ nhận dạng hay cắt "(từ 14/09/2026" và "đến 14/09/2028)" thành hai dòng.
  const chu = khongDau(dong.join(' '));

  const cap = CAP_NGAY.exec(chu);
  if (cap) {
    const from = ngayHopLe(Number(cap[1]), Number(cap[2]), Number(cap[3]));
    const to = ngayHopLe(Number(cap[4]), Number(cap[5]), Number(cap[6]));
    if (from && to && to.getTime() > from.getTime()) {
      const khoang = soThangGiua(from, to);
      if (khoang >= 1 && khoang <= 60) {
        const thang = SO_THANG.exec(chu);
        const soThang = thang ? Number(thang[1]) : undefined;
        // Số tháng in trên giấy là phép thử chéo cho cặp ngày. Lệch nhau thì một
        // trong hai đã bị đọc sai, không có cách nào biết cái nào — bỏ, không đoán.
        if (soThang !== undefined && soThang !== khoang) return null;
        return { from: inNgay(from), to: inNgay(to), months: soThang ?? khoang, nguon: 'cap-ngay' };
      }
    }
    return null;
  }

  const thang = SO_THANG.exec(chu);
  const lap = NGAY_CHU.exec(chu);
  if (thang && lap) {
    const soThang = Number(thang[1]);
    const from = ngayHopLe(Number(lap[1]), Number(lap[2]), Number(lap[3]));
    if (from && soThang >= 1 && soThang <= 60) {
      return { from: inNgay(from), to: inNgay(congThang(from, soThang)), months: soThang, nguon: 'ngay-cong-thang' };
    }
  }
  return null;
}

/** Hạn đọc được chỉ dùng khi còn ở tương lai so với hôm nay (giờ Việt Nam). */
export function hanConHieuLuc(han: HanHopDong, homNay: Date = new Date()): boolean {
  const [ngay, thang, nam] = han.to.split('/');
  const to = ngay && thang && nam ? ngayHopLe(Number(ngay), Number(thang), Number(nam)) : null;
  if (!to) return false;
  const vn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(homNay);
  return to.getTime() > new Date(`${vn}T00:00:00Z`).getTime();
}
