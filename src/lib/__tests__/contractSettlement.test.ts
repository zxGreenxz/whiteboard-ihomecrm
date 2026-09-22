import { describe, it, expect } from 'vitest';
import {
  settlementStatusOf, detectIssues, laneOf, isBlocker, supplementPending,
  sumOnVoucher, DAU_CAN_BO_SUNG, DAU_DA_BO_SUNG,
  viewStatusOf, matchStatus, fmtCompact, fmtMoney, fmtNgay, boDau,
  type SettlementRow,
} from '@/lib/contractSettlement';

const goc = (p: Partial<SettlementRow> = {}): SettlementRow => ({
  key: 'commission:v1', kind: 'commission', voucherId: 'v1', voucherCode: 'PC1',
  contractId: 'c1', contractNumber: 'HD-1', terminationId: null, roomId: 'r1',
  buildingName: 'A', roomName: '101', customerName: 'Khách', recipientName: 'Môi giới X',
  amount: 1_000_000, basis: { kind: 'matched', amount: 1_000_000 },
  status: 'pending', approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED',
  postingMode: null, bankAccount: '0123', bankName: 'NH mẫu',
  attachments: [], hasAttachment: false,
  eventDate: '2026-09-10', origin: 'contract', eventLabel: 'Ký mới',
  paidDate: null, bookName: null, issues: [], supplementPending: false,
  reviewState: 'PENDING', reviewVersion: 1, approvalVersion: 1, postingVersion: 1,
  organizationId: 'org1', buildingId: 'b1',
  ...p,
});

describe('settlementStatusOf', () => {
  it('APPROVED + POSTED là đã chi', () => {
    expect(settlementStatusOf('APPROVED', 'POSTED')).toBe('paid');
  });
  it('APPROVED + UNPOSTED là chờ chi, KHÔNG phải đã chi', () => {
    expect(settlementStatusOf('APPROVED', 'UNPOSTED')).toBe('approved');
  });
  it('APPROVED + NOT_APPLICABLE là không ghi quỹ, tách riêng khỏi đã chi', () => {
    expect(settlementStatusOf('APPROVED', 'NOT_APPLICABLE')).toBe('noncash');
  });
  it('APPROVED + REVERSED quay lại chờ chi', () => {
    expect(settlementStatusOf('APPROVED', 'REVERSED')).toBe('approved');
  });
  it('UNAPPROVED là chờ duyệt bất kể posting', () => {
    expect(settlementStatusOf('UNAPPROVED', 'UNPOSTED')).toBe('pending');
    expect(settlementStatusOf('UNAPPROVED', null)).toBe('pending');
  });
  it('CANCELLED là đã huỷ', () => {
    expect(settlementStatusOf('CANCELLED', 'UNPOSTED')).toBe('cancelled');
  });
  it('trạng thái lạ KHÔNG được coi là chờ duyệt thao tác được', () => {
    expect(settlementStatusOf('SOMETHING_ELSE', 'UNPOSTED')).toBe('unknown');
    expect(settlementStatusOf(null, null)).toBe('unknown');
  });
});

describe('detectIssues — blocker', () => {
  // Chi tiết của nhãn gộp nằm ở khối "thông tin thanh toán gộp một nhãn".
  it('lệch căn cứ là vướng', () => {
    expect(detectIssues(goc({ basis: { kind: 'mismatch', amount: 900_000 } }), '2026-09'))
      .toContain('AMOUNT_MISMATCH');
  });
  it('đọc căn cứ LỖI là vướng — không được coi là phiếu sạch', () => {
    expect(detectIssues(goc({ basis: { kind: 'unavailable', reason: 'không đủ quyền' } }), '2026-09'))
      .toContain('BASIS_UNAVAILABLE');
  });
  it('có yêu cầu bổ sung chưa xử lý là vướng', () => {
    expect(detectIssues(goc({ supplementPending: true }), '2026-09'))
      .toContain('SUPPLEMENT_PENDING');
  });
});

describe('detectIssues — chỉ cảnh báo, KHÔNG chặn', () => {
  it('tồn kỳ cũ là cảnh báo', () => {
    const issues = detectIssues(goc({ eventDate: '2026-08-31' }), '2026-09');
    expect(issues).toContain('OLD_PERIOD');
    expect(isBlocker('OLD_PERIOD')).toBe(false);
  });
  it('loại không có công thức căn cứ không bị chặn', () => {
    const r = goc({ kind: 'bonus', basis: { kind: 'not-applicable' } });
    expect(detectIssues(r, '2026-09')).toContain('BASIS_NOT_APPLICABLE');
    expect(isBlocker('BASIS_NOT_APPLICABLE')).toBe(false);
  });
  it('chưa tra được căn cứ ở mức danh sách không chặn', () => {
    const r = goc({ basis: { kind: 'not-found', reason: 'chưa tra ở danh sách' } });
    expect(detectIssues(r, '2026-09')).toContain('BASIS_NOT_FOUND');
    expect(isBlocker('BASIS_NOT_FOUND')).toBe(false);
  });
});

describe('detectIssues — thông tin thanh toán gộp một nhãn', () => {
  const thieu = (p: Partial<SettlementRow>) => detectIssues(goc(p), '2026-09');

  it('thiếu BẤT KỲ mảnh nào cũng ra đúng MỘT nhãn chung', () => {
    for (const p of [
      { recipientName: null }, { recipientName: '  ' },
      { bankName: null }, { bankName: '' },
      { bankAccount: null }, { bankAccount: '' },
    ] as Partial<SettlementRow>[]) {
      expect(thieu(p), JSON.stringify(p)).toContain('MISSING_PAYMENT_INFO');
    }
  });

  it('thiếu cả ba vẫn chỉ MỘT nhãn, không phải ba', () => {
    const is = thieu({ recipientName: null, bankName: null, bankAccount: null });
    expect(is.filter((i) => i === 'MISSING_PAYMENT_INFO')).toHaveLength(1);
  });

  it('đủ cả ba thì không có nhãn nào', () => {
    expect(thieu({})).not.toContain('MISSING_PAYMENT_INFO');
  });

  it('ẢNH ĐÍNH KÈM miễn hẳn điều kiện này — phiếu sang thẳng Chờ duyệt', () => {
    const p = { recipientName: null, bankName: null, bankAccount: null };
    expect(thieu(p)).toContain('MISSING_PAYMENT_INFO');
    const coAnh = { ...p, attachments: ['anh.jpg'], hasAttachment: true };
    expect(thieu(coAnh)).not.toContain('MISSING_PAYMENT_INFO');
    expect(viewStatusOf(goc({ ...coAnh, status: 'pending', issues: thieu(coAnh) }))).toBe('pending');
  });

  it('thiếu thông tin thanh toán LÀ blocker', () => {
    expect(isBlocker('MISSING_PAYMENT_INFO')).toBe(true);
  });
});

describe('detectIssues — trạng thái đã đóng', () => {
  it('dòng đã chi không mang vướng mắc nhắc việc', () => {
    const issues = detectIssues(
      goc({ status: 'paid', bankAccount: '', recipientName: null, eventDate: '2026-01-01' }),
      '2026-09');
    expect(issues).not.toContain('MISSING_PAYMENT_INFO');
    expect(issues).not.toContain('OLD_PERIOD');
  });
  it('dòng đã huỷ không mang vướng mắc nào', () => {
    expect(detectIssues(goc({ status: 'cancelled', bankAccount: '' }), '2026-09')).toEqual([]);
  });
  it('thuần: gọi hai lần cho kết quả giống nhau', () => {
    const r = goc({ bankAccount: '' });
    expect(detectIssues(r, '2026-09')).toEqual(detectIssues(r, '2026-09'));
  });
});

describe('laneOf', () => {
  const withIssues = (p: Partial<SettlementRow>) => {
    const r = goc(p);
    return { ...r, issues: detectIssues(r, '2026-09') };
  };

  it('không vướng gì thì ở Chờ duyệt', () => {
    expect(laneOf(withIssues({}))).toBe('cho-duyet');
  });
  it('thiếu tên thì ở Cần rà soát', () => {
    expect(laneOf(withIssues({ recipientName: null }))).toBe('can-ra-soat');
  });
  it('TỒN KỲ CŨ VẪN Ở CHỜ DUYỆT — đây là vòng kẹt của bản v1', () => {
    // v1 đẩy phiếu cũ vào Cần rà soát rồi ẩn nút Duyệt, mà cách duy nhất hết
    // vướng lại là duyệt. 50/95 phiếu chờ duyệt thuộc kỳ trước.
    expect(laneOf(withIssues({ eventDate: '2026-07-15' }))).toBe('cho-duyet');
  });
  it('thưởng sale không có căn cứ vẫn ở Chờ duyệt', () => {
    expect(laneOf(withIssues({ kind: 'bonus', basis: { kind: 'not-applicable' } })))
      .toBe('cho-duyet');
  });
  it('đọc căn cứ lỗi thì ở Cần rà soát', () => {
    expect(laneOf(withIssues({ basis: { kind: 'unavailable', reason: 'lỗi mạng' } })))
      .toBe('can-ra-soat');
  });
  it('phiếu không còn chờ duyệt thì không thuộc làn nào', () => {
    expect(laneOf(goc({ status: 'approved' }))).toBeNull();
    expect(laneOf(goc({ status: 'paid' }))).toBeNull();
    expect(laneOf(goc({ status: 'noncash' }))).toBeNull();
    expect(laneOf(goc({ status: 'cancelled' }))).toBeNull();
    expect(laneOf(goc({ status: 'unknown' }))).toBeNull();
  });
});

describe('supplementPending', () => {
  const n = (s: string) => ({ note: s });
  it('không ghi chú nào thì không treo', () => {
    expect(supplementPending([])).toBe(false);
  });
  it('ghi chú thường không đổi làn', () => {
    expect(supplementPending([n('Đã gọi cho sale')])).toBe(false);
  });
  it('dấu cần bổ sung làm treo', () => {
    expect(supplementPending([n(`${DAU_CAN_BO_SUNG} thiếu ảnh chứng từ`)])).toBe(true);
  });
  it('dấu đã bổ sung gỡ treo', () => {
    expect(supplementPending([
      n(`${DAU_CAN_BO_SUNG} thiếu ảnh`), n(`${DAU_DA_BO_SUNG} đã đính ảnh`),
    ])).toBe(false);
  });
  it('yêu cầu lần hai sau khi đã bổ sung thì treo lại', () => {
    expect(supplementPending([
      n(`${DAU_CAN_BO_SUNG} thiếu ảnh`), n(`${DAU_DA_BO_SUNG} đã đính`),
      n(`${DAU_CAN_BO_SUNG} ảnh mờ, chụp lại`),
    ])).toBe(true);
  });
  it('ghi chú thường xen giữa không làm mất dấu', () => {
    expect(supplementPending([
      n(`${DAU_CAN_BO_SUNG} thiếu ảnh`), n('Đang liên hệ chủ nhà'),
    ])).toBe(true);
  });
  it('dấu phải ở ĐẦU, nằm giữa thì không tính', () => {
    expect(supplementPending([n(`ghi chú ${DAU_CAN_BO_SUNG} gì đó`)])).toBe(false);
  });
  it('ghi chú null không nổ', () => {
    expect(supplementPending([{ note: null }])).toBe(false);
  });
});

describe('sumOnVoucher', () => {
  it('cộng số trên phiếu, không cộng số căn cứ', () => {
    expect(sumOnVoucher([
      goc({ amount: 100, basis: { kind: 'mismatch', amount: 999 } }),
      goc({ key: 'k2', amount: 50 }),
    ])).toBe(150);
  });
  it('bỏ qua dòng đã huỷ', () => {
    expect(sumOnVoucher([
      goc({ amount: 100 }), goc({ key: 'k2', amount: 50, status: 'cancelled' }),
    ])).toBe(100);
  });
  it('danh sách rỗng ra 0', () => {
    expect(sumOnVoucher([])).toBe(0);
  });
});

// ── Từ vựng hiển thị (bản thiết kế 03) ─────────────────────────────────────

describe('viewStatusOf', () => {
  it('phiếu chờ duyệt còn BLOCKER thì hiện là Cần rà soát', () => {
    expect(viewStatusOf(goc({ status: 'pending', issues: ['MISSING_PAYMENT_INFO'] }))).toBe('review');
  });
  it('phiếu chờ duyệt chỉ có CẢNH BÁO thì vẫn là Chờ duyệt', () => {
    // Đây chính là chỗ bản v1 sai: tồn kỳ cũ bị đẩy sang rà soát rồi kẹt.
    expect(viewStatusOf(goc({ status: 'pending', issues: ['OLD_PERIOD'] }))).toBe('pending');
    expect(viewStatusOf(goc({ status: 'pending', issues: ['BASIS_NOT_FOUND'] }))).toBe('pending');
  });
  it('phiếu có ảnh đính kèm thì không còn vướng thông tin thanh toán', () => {
    const r = goc({
      status: 'pending', recipientName: null, bankName: null, bankAccount: null,
      attachments: ['anh.jpg'], hasAttachment: true,
    });
    expect(viewStatusOf({ ...r, issues: detectIssues(r, '2026-09') })).toBe('pending');
  });
  it('trạng thái khác chờ duyệt thì giữ nguyên', () => {
    expect(viewStatusOf(goc({ status: 'approved', issues: ['MISSING_PAYMENT_INFO'] }))).toBe('approved');
    expect(viewStatusOf(goc({ status: 'paid', issues: [] }))).toBe('paid');
    expect(viewStatusOf(goc({ status: 'noncash', issues: [] }))).toBe('noncash');
  });
});

describe('matchStatus', () => {
  it('"Cần xử lý" gồm đúng ba làn còn việc', () => {
    for (const v of ['review', 'pending', 'approved'] as const) {
      expect(matchStatus(v, 'open')).toBe(true);
    }
    for (const v of ['paid', 'cancelled', 'noncash'] as const) {
      expect(matchStatus(v, 'open')).toBe(false);
    }
  });
  it('thẻ gộp "Chờ duyệt và Chi" KHÔNG nuốt Cần rà soát', () => {
    expect(matchStatus('pending', 'pendpay')).toBe(true);
    expect(matchStatus('approved', 'pendpay')).toBe(true);
    expect(matchStatus('review', 'pendpay')).toBe(false);
  });
  it('"Đã chi" gom cả phiếu không ghi quỹ — chúng đã xong việc', () => {
    expect(matchStatus('paid', 'paid')).toBe(true);
    expect(matchStatus('noncash', 'paid')).toBe(true);
  });
  it('"Tất cả" nhận mọi trạng thái', () => {
    expect(matchStatus('unknown', 'all')).toBe(true);
    expect(matchStatus('cancelled', 'all')).toBe(true);
  });
});

describe('định dạng', () => {
  it('fmtCompact rút gọn từ 1 triệu trở lên', () => {
    expect(fmtCompact(13_472_000)).toBe('13,47 tr');
    expect(fmtCompact(999_000)).toBe('999.000 đ');
  });
  it('fmtMoney làm tròn, không để số lẻ lọt ra giao diện tiền', () => {
    expect(fmtMoney(1_234_567.89)).toBe('1.234.568 đ');
  });
  it('fmtNgay đọc được cả chuỗi ISO có giờ', () => {
    expect(fmtNgay('2026-09-13')).toBe('13/09/2026');
    expect(fmtNgay('2026-09-13T17:00:00.000Z')).toBe('13/09/2026');
    expect(fmtNgay(null)).toBe('—');
  });
  it('boDau cho phép gõ không dấu vẫn tìm ra', () => {
    expect(boDau('Nguyễn Minh An')).toBe('nguyen minh an');
  });
});
