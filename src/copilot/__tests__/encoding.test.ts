// Chuỗi tiếng Việt trong `src/copilot` đã từng bị hỏng mã: file UTF-8 bị đọc lại
// bằng CP1252 rồi ghi đè, biến `Chưa đăng nhập` thành `ChÆ°a Ä‘Äƒng nháº­p`. Người
// dùng đọc nguyên văn chuỗi hỏng đó trong banner lỗi của Copilot.
//
// Vì sao phải là TEST chứ không phải một lần grep: hỏng mã không làm gãy build,
// không làm đỏ tsc, và lần sau ai đó mở file bằng editor đặt sai encoding là nó
// quay lại y hệt. Chỉ có gate chạy mỗi lần mới giữ được.
//
// Vì sao KHÔNG dò một ký tự `Ã` trần: `Ã` CÓ THẬT trong tiếng Việt viết hoa
// (`ĐÃ`, `MÃ`). Dấu hiệu chắc chắn là CẶP ký tự — byte thứ hai của một chuỗi
// UTF-8 bị đọc lệch luôn rơi vào dải cao CP1252, không bao giờ là ASCII.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THU_MUC_COPILOT = fileURLToPath(new URL('..', import.meta.url));

const MA_ASCII_CAO_NHAT = 127;

const DAU_HIEU_MOJIBAKE: readonly { ten: string; dinh: (dong: string) => boolean }[] = [
  {
    ten: 'Ã + ký tự phi-ASCII (à â ã ê ô ú…)',
    dinh: (dong) => {
      for (let i = 0; i < dong.length - 1; i += 1) {
        if (dong[i] === 'Ã' && dong.charCodeAt(i + 1) > MA_ASCII_CAO_NHAT) return true;
      }
      return false;
    },
  },
  { ten: 'Æ (ư, ơ)', dinh: (dong) => dong.includes('Æ') },
  { ten: 'Ä (đ, ă)', dinh: (dong) => dong.includes('Ä') },
  { ten: 'á» (ề ị ộ ổ ớ…)', dinh: (dong) => dong.includes('á»') },
  { ten: 'áº (ả ấ ậ ắ ế…)', dinh: (dong) => dong.includes('áº') },
];

/** Mọi file nguồn của Copilot, TRỪ chính thư mục test này. */
function fileNguonCopilot(thuMuc: string = THU_MUC_COPILOT): string[] {
  const ra: string[] = [];
  for (const muc of readdirSync(thuMuc, { withFileTypes: true })) {
    const duongDan = path.join(thuMuc, muc.name);
    if (muc.isDirectory()) {
      if (muc.name === '__tests__') continue;
      ra.push(...fileNguonCopilot(duongDan));
      continue;
    }
    if (muc.name.endsWith('.ts') || muc.name.endsWith('.tsx')) ra.push(duongDan);
  }
  return ra;
}

function chuoiHongMa(duongDan: string): string[] {
  const dong = readFileSync(duongDan, 'utf8').split('\n');
  const loi: string[] = [];
  dong.forEach((noiDung, i) => {
    for (const { ten, dinh } of DAU_HIEU_MOJIBAKE) {
      if (dinh(noiDung)) {
        loi.push(`${path.relative(THU_MUC_COPILOT, duongDan)}:${i + 1} [${ten}] ${noiDung.trim()}`);
        break;
      }
    }
  });
  return loi;
}

describe('encoding: chuỗi tiếng Việt trong src/copilot không được hỏng mã', () => {
  it('quét được ít nhất vài chục file nguồn (chống test rỗng xanh giả)', () => {
    expect(fileNguonCopilot().length).toBeGreaterThan(20);
  });

  it('không file nguồn nào chứa dấu vết UTF-8 bị đọc bằng CP1252', () => {
    const loi = fileNguonCopilot().flatMap(chuoiHongMa);
    expect(loi).toEqual([]);
  });

  it('bộ dò bắt được mojibake mẫu và bỏ qua tiếng Việt viết hoa hợp lệ', () => {
    const dinhBatKy = (s: string) => DAU_HIEU_MOJIBAKE.some(({ dinh }) => dinh(s));
    expect(dinhBatKy('ChÆ°a Ä‘Äƒng nháº­p')).toBe(true);
    expect(dinhBatKy('Pháº£i chá»n tá»• chá»©c')).toBe(true);
    expect(dinhBatKy('khÃ´ng cÃ²n trÃªn trang')).toBe(true);
    expect(dinhBatKy('Chưa đăng nhập')).toBe(false);
    expect(dinhBatKy('ĐÃ LỌC QUYỀN, MÃ NGUỒN')).toBe(false);
  });
});
