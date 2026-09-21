import { describe, it, expect } from 'vitest';
import {
  settlementStatusOf, detectIssues, laneOf, isBlocker, supplementPending,
  sumOnVoucher, DAU_CAN_BO_SUNG, DAU_DA_BO_SUNG,
  type SettlementRow,
} from '@/lib/contractSettlement';

const goc = (p: Partial<SettlementRow> = {}): SettlementRow => ({
  key: 'commission:v1', kind: 'commission', voucherId: 'v1', voucherCode: 'PC1',
  contractId: 'c1', contractNumber: 'HD-1', terminationId: null, roomId: 'r1',
  buildingName: 'A', roomName: '101', customerName: 'Khách', recipientName: 'Môi giới X',
  amount: 1_000_000, basis: { kind: 'matched', amount: 1_000_000 },
  status: 'pending', approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED',
  postingMode: null, bankRequired: true, bankAccount: '0123',
  eventDate: '2026-09-10', issues: [], supplementPending: false,
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
  it('thiếu TÊN người nhận là vướng', () => {
    expect(detectIssues(goc({ recipientName: null }), '2026-09')).toContain('MISSING_RECIPIENT');
    expect(detectIssues(goc({ recipientName: '  ' }), '2026-09')).toContain('MISSING_RECIPIENT');
  });
  it('thiếu STK là vướng', () => {
    expect(detectIssues(goc({ bankAccount: '' }), '2026-09')).toContain('MISSING_BANK');
  });
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
    expect(isBlocker('OLD_PERIOD', goc())).toBe(false);
  });
  it('loại không có công thức căn cứ không bị chặn', () => {
    const r = goc({ kind: 'bonus', basis: { kind: 'not-applicable' } });
    expect(detectIssues(r, '2026-09')).toContain('BASIS_NOT_APPLICABLE');
    expect(isBlocker('BASIS_NOT_APPLICABLE', r)).toBe(false);
  });
  it('chưa tra được căn cứ ở mức danh sách không chặn', () => {
    const r = goc({ basis: { kind: 'not-found', reason: 'chưa tra ở danh sách' } });
    expect(detectIssues(r, '2026-09')).toContain('BASIS_NOT_FOUND');
    expect(isBlocker('BASIS_NOT_FOUND', r)).toBe(false);
  });
  it('phiếu chi tiền mặt không bị chặn vì thiếu STK', () => {
    const r = goc({ bankAccount: '', bankRequired: false });
    expect(detectIssues(r, '2026-09')).toContain('MISSING_BANK');
    expect(isBlocker('MISSING_BANK', r)).toBe(false);
  });
});

describe('detectIssues — trạng thái đã đóng', () => {
  it('dòng đã chi không mang vướng mắc nhắc việc', () => {
    const issues = detectIssues(
      goc({ status: 'paid', bankAccount: '', recipientName: null, eventDate: '2026-01-01' }),
      '2026-09');
    expect(issues).not.toContain('MISSING_BANK');
    expect(issues).not.toContain('MISSING_RECIPIENT');
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
