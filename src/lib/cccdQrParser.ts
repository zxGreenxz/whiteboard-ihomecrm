// =============================================
// CCCD QR Code Parser
// Cấu trúc payload chuẩn (do Bộ Công An phát hành, đọc bằng VNeID/Camera):
//   <CCCD>|<CMND cũ>|<Họ tên>|<ddMMyyyy ngày sinh>|<Giới tính>|<Địa chỉ thường trú>|<ddMMyyyy ngày cấp>
// Ví dụ:
//   094095000036|025237827|Trần Bảo Hiệp|10021995|Nam|78H/2, KP3, P.Hiệp Thành, Quận 12, TP.Hồ Chí Minh|13032022
// =============================================

export interface CCCDQrData {
  /** Số CCCD (12 chữ số) */
  idNumber: string;
  /** Họ tên đầy đủ */
  fullName: string;
  /** Ngày sinh ở dạng ISO yyyy-MM-dd (rỗng nếu parse thất bại) */
  dateOfBirth: string;
  /** "Nam" | "Nữ" | "Khác" — đã normalize từ "Male"/"Female" */
  gender: string;
  /** Toàn bộ địa chỉ thường trú dạng thô */
  permanentAddress: string;
  /** Ngày cấp CCCD ở dạng ISO yyyy-MM-dd */
  idIssueDate: string;
  /** Nơi cấp — mặc định "Cục Cảnh Sát" theo yêu cầu của user */
  idIssuePlace: string;
}

/** Chuyển "ddMMyyyy" → "yyyy-MM-dd". Trả rỗng nếu không hợp lệ. */
function parseCccdDate(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length !== 8) return '';
  const dd = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  const yyyy = digits.slice(4, 8);
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  if (!day || !month || !year) return '';
  if (day < 1 || day > 31 || month < 1 || month > 12) return '';
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeGender(raw: string): string {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'male' || v === 'nam' || v === 'm') return 'Nam';
  if (v === 'female' || v === 'nữ' || v === 'nu' || v === 'f') return 'Nữ';
  return 'Khác';
}

/**
 * Parse chuỗi QR CCCD. Ném lỗi nếu định dạng sai (không có dấu `|` hoặc không đủ trường).
 * Trả `null` nếu input rỗng / không phải chuỗi.
 */
export function parseCccdQr(raw: string | null | undefined): CCCDQrData | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('|').map((p) => p.trim());
  if (parts.length < 7) {
    throw new Error(
      `Chuỗi QR không đúng định dạng CCCD (cần 7 trường, nhận được ${parts.length})`
    );
  }

  const [idNumber, , fullName, dobRaw, genderRaw, permanentAddress, issueRaw] = parts;

  return {
    idNumber: idNumber || '',
    fullName: fullName || '',
    dateOfBirth: parseCccdDate(dobRaw),
    gender: normalizeGender(genderRaw),
    permanentAddress: permanentAddress || '',
    idIssueDate: parseCccdDate(issueRaw),
    idIssuePlace: 'Cục Cảnh Sát',
  };
}
