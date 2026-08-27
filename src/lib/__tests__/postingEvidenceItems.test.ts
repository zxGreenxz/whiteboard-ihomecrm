// Chủ báo 27/08/2026: "bấm huỷ chi rồi bấm chi lại thêm ảnh chứng từ nhưng sau
// đó không thấy ảnh đó trong dòng thu chi" — ảnh chứng từ và ảnh đính kèm là hai
// kho tách rời. Sau khi hợp nhất, ô chứng từ của hộp thoại Thu/Chi chỉ còn vẽ
// đúng một danh sách: attachments của phiếu. Test khoá phần toán đó.

import { describe, it, expect } from 'vitest';
import {
  buildPostingEvidenceItems,
  countUsableEvidence,
  describeEvidenceSkipReason,
  isPdfAttachment,
} from '../postingEvidenceItems';

const A = 'https://x.supabase.co/storage/v1/object/public/income-expense-attachments/u1/1-a.jpg';
const B = 'https://x.supabase.co/storage/v1/object/public/income-expense-attachments/u1/2-b.png';
const PDF = 'https://x.supabase.co/storage/v1/object/public/income-expense-attachments/u1/3-c.pdf';

describe('buildPostingEvidenceItems', () => {
  it('phiếu chưa có ảnh nào thì không có chứng từ nào dùng được', () => {
    const items = buildPostingEvidenceItems({ attachments: [], skipped: [] });
    expect(items).toEqual([]);
    expect(countUsableEvidence(items)).toBe(0);
  });

  it('ảnh vừa dán trong phiên này dùng được và được đánh dấu addedNow', () => {
    const items = buildPostingEvidenceItems({
      attachments: [A],
      sessionUploaded: [B],
      skipped: [],
    });
    expect(items.map((i) => i.url)).toEqual([A, B]);
    expect(items.every((i) => i.usable)).toBe(true);
    expect(items.map((i) => i.addedNow)).toEqual([false, true]);
    expect(countUsableEvidence(items)).toBe(2);
  });

  it('CHI LẠI sau khi huỷ chi: ảnh của lần chi trước mờ đi kèm lý do, ảnh mới vẫn dùng được', () => {
    const items = buildPostingEvidenceItems({
      attachments: [A, B],
      sessionUploaded: [B],
      skipped: [{ url: A, reason: 'ATTACHED' }],
    });
    expect(items[0]).toMatchObject({
      url: A,
      usable: false,
      reason: 'ATTACHED',
      reasonText: 'Đã dùng cho lần ghi sổ trước — mỗi lần chi cần chứng từ riêng',
    });
    expect(items[1]).toMatchObject({ url: B, usable: true, addedNow: true });
    expect(countUsableEvidence(items)).toBe(1);
  });

  it('mọi ảnh đều đã dùng cho lần trước ⇒ không còn chứng từ nào ⇒ phải thêm ảnh mới', () => {
    const items = buildPostingEvidenceItems({
      attachments: [A, B],
      skipped: [
        { url: A, reason: 'ATTACHED' },
        { url: B, reason: 'ATTACHED' },
      ],
    });
    expect(countUsableEvidence(items)).toBe(0);
  });

  it('ảnh đã về trong attachments sau khi refetch thì không nhân đôi', () => {
    const items = buildPostingEvidenceItems({
      attachments: [A, B],
      sessionUploaded: [B],
    });
    expect(items).toHaveLength(2);
    expect(items[1].addedNow).toBe(true);
  });

  it('bỏ qua giá trị rỗng và giữ nguyên thứ tự phiếu', () => {
    const items = buildPostingEvidenceItems({
      attachments: [B, '', A],
      sessionUploaded: null,
    });
    expect(items.map((i) => i.url)).toEqual([B, A]);
  });
});

describe('describeEvidenceSkipReason', () => {
  it('dịch các mã server sang câu tiếng Việt', () => {
    expect(describeEvidenceSkipReason('QUARANTINED')).toBe('Ảnh đang bị cách ly');
    expect(describeEvidenceSkipReason('FILE_KHONG_CON_TRONG_STORAGE')).toBe(
      'File không còn trong kho lưu trữ',
    );
  });

  it('mã lạ vẫn hiện được, kèm nguyên mã để còn lần theo', () => {
    expect(describeEvidenceSkipReason('MA_MOI')).toContain('MA_MOI');
    expect(describeEvidenceSkipReason(undefined)).toBe('Không dùng được làm chứng từ');
  });
});

describe('isPdfAttachment', () => {
  it('phân biệt PDF với ảnh', () => {
    expect(isPdfAttachment(PDF)).toBe(true);
    expect(isPdfAttachment(A)).toBe(false);
    expect(isPdfAttachment(`${PDF}?token=abc`)).toBe(true);
  });
});
