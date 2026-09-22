import { describe, it, expect } from 'vitest';
import {
  settlementStatusOf, detectIssues, laneOf, isBlocker, supplementPending,
  sumOnVoucher, DAU_CAN_BO_SUNG, DAU_DA_BO_SUNG,
  viewStatusOf, matchStatus, fmtCompact, fmtMoney, fmtNgay, boDau, KIND_LABEL,
  ACTION_LABEL, STATUS_FILTER_LABEL,
  groupTotal, isOldPeriodWork, matchScope, normalisePeriodFilter,
  periodAxisOf, periodDateOf, periodScopeLabel, periodScopeOptions, statValue,
  VIEC_CHUA_XONG,
  type PeriodScope, type SettlementRow, type StatusFilter, type ViewStatus,
} from '@/lib/contractSettlement';

const goc = (p: Partial<SettlementRow> = {}): SettlementRow => ({
  key: 'commission:v1', kind: 'commission', voucherId: 'v1', voucherCode: 'PC1',
  // Mặc định: phân loại rõ ràng, không xung đột — các ca dưới đây nói về
  // vướng mắc/làn chứ không về phân loại, nên đừng để nhiễu CLASSIFICATION_REVIEW.
  kindSource: 'commission_kind', kindConflict: false,
  contractId: 'c1', contractNumber: 'HD-1', terminationId: null, roomId: 'r1',
  buildingName: 'A', roomName: '101', customerName: 'Khách', recipientName: 'Môi giới X',
  amount: 1_000_000, basis: { kind: 'matched', amount: 1_000_000 },
  status: 'pending', approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED',
  postingMode: null, bankAccount: '0123', bankName: 'NH mẫu',
  attachments: [], hasAttachment: false,
  eventDate: '2026-09-10', origin: 'contract', eventLabel: 'Ký mới',
  postedOn: null, bookName: null, issues: [], supplementPending: false,
  reviewState: 'PENDING', reviewVersion: 1, approvalVersion: 1, postingVersion: 1,
  organizationId: 'org1', buildingId: 'b1',
  notes: null, systemSource: null, commissionKind: 'broker',
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
  // ⚠ ĐỔI CÓ CHỦ Ý (T5, plan §3.4). Bản trước gộp REVERSED vào 'approved' nên
  // modal hiện đúng cái nút "Ghi nhận chi" cho một phiếu ĐÃ TỪNG CHI rồi bị đảo
  // — tức mời chi lần hai chỉ vì mapping hiển thị xếp nhầm chỗ. Hoàn tác là một
  // trạng thái RIÊNG: không phải "chưa từng chi", cũng không phải "còn phải chi".
  it('APPROVED + REVERSED có trạng thái RIÊNG, KHÔNG phải chờ chi', () => {
    expect(settlementStatusOf('APPROVED', 'REVERSED')).toBe('reversed');
  });
  it('phiếu hoàn tác không được mời chi lại bằng chữ trên nút', () => {
    expect(ACTION_LABEL.reversed).toBe('Xem phiếu');
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

// Phân loại là việc HIỂN THỊ của khu này; phiếu thì vẫn là phiếu hợp lệ bên Thu
// chi. Biến nhãn này thành blocker là dựng lại vòng kẹt của bản v1 — người duyệt
// không có cách nào "sửa phân loại" ở đây, hạng mục nằm bên Thu chi.
describe('detectIssues — cần đối chiếu phân loại', () => {
  it('xung đột dấu phân loại ra nhãn cảnh báo, KHÔNG chặn duyệt', () => {
    const r = goc({ kindConflict: true });
    expect(detectIssues(r, '2026-09')).toContain('CLASSIFICATION_REVIEW');
    expect(isBlocker('CLASSIFICATION_REVIEW')).toBe(false);
    expect(laneOf({ ...r, issues: detectIssues(r, '2026-09') })).toBe('cho-duyet');
  });

  it('chưa xác định loại cũng ra nhãn đó, không mặc định về Hoàn khách', () => {
    const r = goc({
      kind: 'unknown', kindSource: 'none',
      basis: { kind: 'not-found', reason: 'Chưa xác định loại nên chưa tra được căn cứ' },
    });
    expect(detectIssues(r, '2026-09')).toContain('CLASSIFICATION_REVIEW');
  });

  it('phân loại rõ ràng thì KHÔNG gắn nhãn', () => {
    expect(detectIssues(goc(), '2026-09')).not.toContain('CLASSIFICATION_REVIEW');
  });

  it('nhãn phân loại đứng TRƯỚC nhãn căn cứ — bảng chỉ hiện issues[0]', () => {
    const r = goc({
      kind: 'unknown', kindConflict: true,
      basis: { kind: 'not-found', reason: 'chưa tra' },
    });
    expect(detectIssues(r, '2026-09')[0]).toBe('CLASSIFICATION_REVIEW');
  });

  it('tên loại "chưa xác định" là một nhãn riêng, không mượn nhãn của ba loại kia', () => {
    expect(KIND_LABEL.unknown).toBe('Chưa xác định loại');
    expect(new Set(Object.values(KIND_LABEL)).size).toBe(Object.keys(KIND_LABEL).length);
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
  // ⚠ ĐỔI CÓ CHỦ Ý (T5, plan §3.4). Bản trước cho 'noncash' lọt vào bộ lọc
  // 'paid' trong khi THẺ SỐ chỉ cộng 'paid' — nên thẻ hiện 0đ/0 phiếu ngay trên
  // một cái bảng đang có ba dòng. Không ghi quỹ là bộ lọc/stat RIÊNG.
  it('"Đã chi" KHÔNG nuốt phiếu không ghi quỹ — hai bộ lọc tách hẳn', () => {
    expect(matchStatus('paid', 'paid')).toBe(true);
    expect(matchStatus('noncash', 'paid')).toBe(false);
    expect(matchStatus('noncash', 'noncash')).toBe(true);
    expect(matchStatus('paid', 'noncash')).toBe(false);
  });
  it('"Cần xử lý" không gồm phiếu hoàn tác — đó là lịch sử, không phải việc tồn', () => {
    expect(matchStatus('reversed', 'open')).toBe(false);
    expect(matchStatus('reversed', 'pendpay')).toBe(false);
    expect(matchStatus('reversed', 'reversed')).toBe(true);
  });
  it('"Tất cả" nhận mọi trạng thái, KỂ CẢ không xác định và hoàn tác', () => {
    for (const v of ['review', 'pending', 'approved', 'noncash', 'paid',
      'cancelled', 'reversed', 'unknown'] as ViewStatus[]) {
      expect(matchStatus(v, 'all'), v).toBe(true);
    }
  });
  it('không xác định có bộ lọc riêng để soi, không bị giấu', () => {
    expect(matchStatus('unknown', 'unknown')).toBe(true);
    expect(matchStatus('paid', 'unknown')).toBe(false);
    expect(STATUS_FILTER_LABEL.unknown).toBeTruthy();
    expect(STATUS_FILTER_LABEL.reversed).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BA PHẠM VI KỲ (plan §3.4) — chủ đã chốt: việc chưa xong có ba lựa chọn, còn
// Đã chi chỉ có hai. Phạm vi là ENUM; kỳ tham chiếu là `period` của trang. Không
// có bản sao chuỗi tháng nào trong state, nên đổi kỳ chung không để lại rác.
// ═══════════════════════════════════════════════════════════════════════════

describe('periodScopeOptions', () => {
  const BA: PeriodScope[] = ['current', 'prior', 'all'];
  const HAI: PeriodScope[] = ['current', 'all'];

  it('việc chưa xong có đủ ba phạm vi', () => {
    for (const f of ['open', 'review', 'pending', 'approved', 'pendpay'] as StatusFilter[]) {
      expect(periodScopeOptions(f), f).toEqual(BA);
    }
  });

  it('Đã chi chỉ có Kỳ hiện tại và Tất Cả — KHÔNG có Tồn Cũ', () => {
    expect(periodScopeOptions('paid')).toEqual(HAI);
    expect(periodScopeOptions('paid')).not.toContain('prior');
  });

  it('các trạng thái lịch sử khác cũng chỉ hai', () => {
    for (const f of ['noncash', 'cancelled', 'reversed', 'unknown'] as StatusFilter[]) {
      expect(periodScopeOptions(f), f).toEqual(HAI);
    }
  });

  it('Tất cả trạng thái vẫn mở Tồn Cũ (chọn xong sẽ về Cần xử lý)', () => {
    expect(periodScopeOptions('all')).toEqual(BA);
  });
});

describe('periodScopeLabel', () => {
  it('nhãn kỳ hiện tại mang đúng kỳ tham chiếu của trang', () => {
    expect(periodScopeLabel('current', '2026-09')).toBe('Kỳ hiện tại (09/2026)');
    expect(periodScopeLabel('current', '2026-12')).toBe('Kỳ hiện tại (12/2026)');
    expect(periodScopeLabel('prior', '2026-09')).toBe('Tồn Cũ');
    expect(periodScopeLabel('all', '2026-09')).toBe('Tất Cả');
  });
});

// MỘT normalizer duy nhất cho thẻ số, dropdown trạng thái và chip — nếu mỗi chỗ
// tự chữa theo cách riêng thì sẽ có chỗ quên, và chỗ quên đó để lại scope 'prior'
// ẩn sau một trạng thái lịch sử ⇒ bảng rỗng mà không ai hiểu vì sao.
describe('normalisePeriodFilter', () => {
  it('Tồn Cũ + Đã chi: phạm vi tự về Kỳ hiện tại', () => {
    expect(normalisePeriodFilter({ scope: 'prior', status: 'paid' }))
      .toEqual({ scope: 'current', status: 'paid' });
  });

  it('cùng luật đó cho Không ghi quỹ / Hủy / Hoàn tác / Không xác định', () => {
    for (const status of ['noncash', 'cancelled', 'reversed', 'unknown'] as StatusFilter[]) {
      expect(normalisePeriodFilter({ scope: 'prior', status }), status)
        .toEqual({ scope: 'current', status });
    }
  });

  it('Tồn Cũ + Tất cả trạng thái: về Cần xử lý, GIỮ phạm vi Tồn Cũ', () => {
    expect(normalisePeriodFilter({ scope: 'prior', status: 'all' }))
      .toEqual({ scope: 'prior', status: 'open' });
  });

  it('việc chưa xong ở Tồn Cũ thì giữ nguyên', () => {
    for (const status of ['open', 'review', 'pending', 'approved', 'pendpay'] as StatusFilter[]) {
      expect(normalisePeriodFilter({ scope: 'prior', status }), status)
        .toEqual({ scope: 'prior', status });
    }
  });

  it('Kỳ hiện tại và Tất Cả không bị đụng vào', () => {
    for (const scope of ['current', 'all'] as PeriodScope[]) {
      for (const status of ['open', 'paid', 'noncash', 'all', 'reversed'] as StatusFilter[]) {
        expect(normalisePeriodFilter({ scope, status }), `${scope}/${status}`)
          .toEqual({ scope, status });
      }
    }
  });

  it('thuần và bất động: chạy hai lần bằng chạy một lần', () => {
    for (const scope of ['current', 'prior', 'all'] as PeriodScope[]) {
      for (const status of ['open', 'all', 'review', 'pending', 'approved', 'pendpay',
        'paid', 'noncash', 'cancelled', 'reversed', 'unknown'] as StatusFilter[]) {
        const mot = normalisePeriodFilter({ scope, status });
        expect(normalisePeriodFilter(mot), `${scope}/${status}`).toEqual(mot);
        // Và kết quả phải luôn là một tổ hợp HỢP LỆ theo bảng lựa chọn.
        expect(periodScopeOptions(mot.status), `${scope}/${status}`).toContain(mot.scope);
      }
    }
  });
});

describe('periodAxisOf — trục ngày xét kỳ theo trạng thái', () => {
  it('Đã chi xét theo ngày GHI SỔ, không phải ngày phiếu', () => {
    expect(periodAxisOf('paid')).toBe('posted');
  });
  it('mọi trạng thái còn lại xét theo ngày phiếu', () => {
    for (const v of ['review', 'pending', 'approved', 'noncash',
      'cancelled', 'reversed', 'unknown'] as ViewStatus[]) {
      expect(periodAxisOf(v), v).toBe('voucher');
    }
  });
  it('phiếu chưa chi không mang nhãn ngày chi', () => {
    expect(periodDateOf(goc({ status: 'noncash', postedOn: '2026-09-09' }), 'noncash'))
      .toBe('2026-09-10');
  });
});

describe('matchScope', () => {
  const choDuyet = (p: Partial<SettlementRow> = {}) => goc({ status: 'pending', ...p });
  const daChi = (p: Partial<SettlementRow> = {}) =>
    goc({ status: 'paid', approvalStatus: 'APPROVED', postingStatus: 'POSTED', ...p });

  it('Tất Cả không loại ngầm thứ gì — kể cả hủy, không xác định, hoàn tác', () => {
    for (const r of [
      choDuyet(), daChi({ postedOn: '2020-01-01' }),
      goc({ status: 'cancelled' }), goc({ status: 'unknown' }),
      goc({ status: 'noncash' }), goc({ status: 'reversed' }),
      choDuyet({ eventDate: null }), daChi({ postedOn: null }),
    ]) {
      expect(matchScope(r, 'all', '2026-09'), r.status).toBe('in');
    }
  });

  it('Kỳ hiện tại: việc chưa xong xét theo ngày phiếu, chuẩn ở mốc 31/08–01/09', () => {
    expect(matchScope(choDuyet({ eventDate: '2026-08-31' }), 'current', '2026-09')).toBe('out');
    expect(matchScope(choDuyet({ eventDate: '2026-09-01' }), 'current', '2026-09')).toBe('in');
    expect(matchScope(choDuyet({ eventDate: '2026-09-30' }), 'current', '2026-09')).toBe('in');
    expect(matchScope(choDuyet({ eventDate: '2026-10-01' }), 'current', '2026-09')).toBe('out');
  });

  // Đây là cái sai số 3 trong bản cũ: chọn tháng thì query lọc `voucher_date`,
  // nên phiếu lập tháng 8 mà CHI tháng 9 biến mất khỏi kỳ 9.
  it('Đã chi xét theo posted_on: phiếu tháng 8 chi tháng 9 thuộc kỳ 9', () => {
    const r = daChi({ eventDate: '2026-08-20', postedOn: '2026-09-03' });
    expect(matchScope(r, 'current', '2026-09')).toBe('in');
    expect(matchScope(r, 'current', '2026-08')).toBe('out');
  });

  it('Đã chi mà không đọc được posted_on là CHƯA XÁC ĐỊNH, không phải ngoài kỳ', () => {
    const r = daChi({ eventDate: '2026-08-20', postedOn: null });
    expect(matchScope(r, 'current', '2026-09')).toBe('undetermined');
    // và tuyệt đối không bị đẩy thành tồn kỳ cũ theo ngày phiếu.
    expect(matchScope(r, 'prior', '2026-09')).toBe('out');
    expect(isOldPeriodWork(r, '2026-09')).toBe(false);
  });

  it('ngày phiếu null là CHƯA XÁC ĐỊNH ở cả hai phạm vi lọc kỳ', () => {
    expect(matchScope(choDuyet({ eventDate: null }), 'current', '2026-09')).toBe('undetermined');
    expect(matchScope(choDuyet({ eventDate: null }), 'prior', '2026-09')).toBe('undetermined');
  });

  it('ngày tương lai không bị nhét vào kỳ hiện tại, cũng không thành tồn cũ', () => {
    const r = choDuyet({ eventDate: '2027-03-01' });
    expect(matchScope(r, 'current', '2026-09')).toBe('out');
    expect(matchScope(r, 'prior', '2026-09')).toBe('out');
    expect(matchScope(r, 'all', '2026-09')).toBe('in');
  });

  it('Tồn Cũ: chỉ việc CHƯA XONG và ngày phiếu trước đầu kỳ', () => {
    expect(matchScope(choDuyet({ eventDate: '2026-08-31' }), 'prior', '2026-09')).toBe('in');
    expect(matchScope(choDuyet({ eventDate: '2026-09-01' }), 'prior', '2026-09')).toBe('out');
    expect(matchScope(goc({ status: 'approved', eventDate: '2026-07-01' }), 'prior', '2026-09'))
      .toBe('in');
    // Cần rà soát vẫn là một phần của chờ duyệt ⇒ vẫn là việc chưa xong.
    const raSoat = goc({ status: 'pending', eventDate: '2026-07-01', issues: ['MISSING_PAYMENT_INFO'] });
    expect(viewStatusOf(raSoat)).toBe('review');
    expect(matchScope(raSoat, 'prior', '2026-09')).toBe('in');
  });

  it('Tồn Cũ KHÔNG chứa đã chi / không ghi quỹ / hủy / hoàn tác / không xác định', () => {
    for (const status of ['paid', 'noncash', 'cancelled', 'reversed', 'unknown'] as const) {
      const r = goc({ status, eventDate: '2026-05-05', postedOn: '2026-05-06' });
      expect(matchScope(r, 'prior', '2026-09'), status).toBe('out');
    }
  });

  it('Kỳ hiện tại + Tồn Cũ KHÁC Tất Cả — Tất Cả còn chứa lịch sử đã xong', () => {
    const daXong = daChi({ eventDate: '2026-05-01', postedOn: '2026-05-02' });
    expect(matchScope(daXong, 'current', '2026-09')).toBe('out');
    expect(matchScope(daXong, 'prior', '2026-09')).toBe('out');
    expect(matchScope(daXong, 'all', '2026-09')).toBe('in');
  });

  it('hoàn tác rồi chi lại: phiếu chi lại là phiếu ĐÃ CHI của kỳ ghi sổ mới', () => {
    const daDao = goc({ status: 'reversed', eventDate: '2026-08-10' });
    const chiLai = daChi({ eventDate: '2026-08-10', postedOn: '2026-09-05' });
    expect(matchScope(daDao, 'current', '2026-08')).toBe('in');
    expect(matchScope(daDao, 'current', '2026-09')).toBe('out');
    expect(matchScope(chiLai, 'current', '2026-09')).toBe('in');
  });
});

// Ma trận mọi phạm vi × mọi trạng thái × mọi loại khoản. Bất biến cần ghim:
// LOẠI KHOẢN KHÔNG BAO GIỜ đổi việc xếp kỳ. Hoàn khách, hoa hồng, thưởng sale
// hay "chưa xác định loại" đều đi theo cùng một trục ngày của trạng thái.
describe('ma trận phạm vi × trạng thái × loại khoản', () => {
  const SCOPES: PeriodScope[] = ['current', 'prior', 'all'];
  const TRANG_THAI = [
    { status: 'pending', issues: [] as SettlementRow['issues'] },
    { status: 'pending', issues: ['MISSING_PAYMENT_INFO'] as SettlementRow['issues'] },
    { status: 'approved', issues: [] as SettlementRow['issues'] },
    { status: 'paid', issues: [] as SettlementRow['issues'] },
    { status: 'noncash', issues: [] as SettlementRow['issues'] },
    { status: 'reversed', issues: [] as SettlementRow['issues'] },
    { status: 'cancelled', issues: [] as SettlementRow['issues'] },
    { status: 'unknown', issues: [] as SettlementRow['issues'] },
  ] as const;
  const LOAI = ['refund', 'commission', 'bonus', 'unknown'] as const;
  const NGAY = [
    { eventDate: '2026-08-31', postedOn: '2026-08-31' },
    { eventDate: '2026-09-01', postedOn: '2026-09-01' },
    { eventDate: '2026-08-20', postedOn: '2026-09-03' },
    { eventDate: '2027-01-01', postedOn: '2027-01-01' },
    { eventDate: null, postedOn: null },
    { eventDate: '2026-09-05', postedOn: null },
  ];

  it('loại khoản không ảnh hưởng phép xếp kỳ ở bất kỳ ô nào', () => {
    for (const scope of SCOPES) {
      for (const tt of TRANG_THAI) {
        for (const ngay of NGAY) {
          const ket = LOAI.map((kind) =>
            matchScope(goc({ ...tt, ...ngay, kind }), scope, '2026-09'));
          expect(new Set(ket).size, `${scope}/${tt.status}/${JSON.stringify(ngay)}`).toBe(1);
        }
      }
    }
  });

  it('mọi ô trả đúng một trong ba kết quả, và Tất Cả luôn là "in"', () => {
    for (const scope of SCOPES) {
      for (const tt of TRANG_THAI) {
        for (const ngay of NGAY) {
          const r = goc({ ...tt, ...ngay });
          const k = matchScope(r, scope, '2026-09');
          expect(['in', 'out', 'undetermined'], `${scope}/${tt.status}`).toContain(k);
          if (scope === 'all') expect(k, `${scope}/${tt.status}`).toBe('in');
          // Tồn Cũ chỉ chứa việc chưa xong — không ô nào phá luật này.
          if (scope === 'prior' && k === 'in') {
            expect(VIEC_CHUA_XONG.has(viewStatusOf(r)), tt.status).toBe(true);
          }
        }
      }
    }
  });
});

describe('isOldPeriodWork — nhãn tồn chỉ gắn cho việc còn phải làm', () => {
  it('việc chưa xong của kỳ trước là tồn', () => {
    expect(isOldPeriodWork(goc({ status: 'pending', eventDate: '2026-08-31' }), '2026-09')).toBe(true);
    expect(isOldPeriodWork(goc({ status: 'approved', eventDate: '2026-07-01' }), '2026-09')).toBe(true);
  });
  it('phiếu đã xong KHÔNG bị gắn nhãn tồn', () => {
    for (const status of ['paid', 'noncash', 'cancelled', 'reversed', 'unknown'] as const) {
      expect(isOldPeriodWork(goc({ status, eventDate: '2026-01-01' }), '2026-09'), status).toBe(false);
    }
  });
  it('việc chưa xong của chính kỳ này không phải tồn', () => {
    expect(isOldPeriodWork(goc({ status: 'pending', eventDate: '2026-09-01' }), '2026-09')).toBe(false);
  });
  it('ngày phiếu null không bị suy thành tồn kỳ cũ', () => {
    expect(isOldPeriodWork(goc({ status: 'pending', eventDate: null }), '2026-09')).toBe(false);
  });
});

describe('groupTotal — bấm thẻ nào thì count/tiền khớp đúng tập dòng thẻ đó', () => {
  const ds = [
    goc({ key: 'a', status: 'paid', postedOn: '2026-09-02', amount: 1_000_000 }),
    goc({ key: 'b', status: 'paid', postedOn: '2026-09-03', amount: 2_000_000 }),
    goc({ key: 'c', status: 'noncash', amount: 9_000_000 }),
    goc({ key: 'd', status: 'pending', amount: 500_000 }),
  ];
  it('Đã chi không cộng tiền của phiếu không ghi quỹ', () => {
    expect(groupTotal(ds, ['paid'])).toEqual({ count: 2, total: 3_000_000 });
  });
  it('Không ghi quỹ là nhóm riêng', () => {
    expect(groupTotal(ds, ['noncash'])).toEqual({ count: 1, total: 9_000_000 });
  });
  it('nhóm rỗng ra 0/0', () => {
    expect(groupTotal(ds, ['cancelled'])).toEqual({ count: 0, total: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THẺ SỐ KHI KHÔNG ĐỌC ĐƯỢC BÚT TOÁN
//
// Đo thật trên org THẬT: tài khoản chủ công ty thấy 1139 phiếu chi đã ghi sổ
// nhưng 0 dòng `income_expense_postings` (policy đòi binding CUSTODIAN đúng sổ).
// Nên "không đọc được ngày chi" phải là một TRẠNG THÁI của thẻ, không phải số 0.
// ═══════════════════════════════════════════════════════════════════════════

describe('statValue', () => {
  const daChi = (postedOn: string | null, amount = 1_000_000, key = 'k') =>
    goc({ key, status: 'paid', postedOn, amount });

  it('Tồn Cũ: thẻ lịch sử nói KHÔNG ÁP DỤNG, không nói 0đ', () => {
    expect(statValue({
      rows: [daChi('2026-09-02')], views: ['paid'], scope: 'prior', period: '2026-09', needsPosting: true,
    })).toEqual({ kind: 'na' });
  });

  it('Tồn Cũ: thẻ VIỆC CHƯA XONG vẫn phải có số thật', () => {
    expect(statValue({
      rows: [goc({ status: 'pending', amount: 500_000, eventDate: '2026-08-15' })],
      views: ['pending'], scope: 'prior', period: '2026-09', needsPosting: false,
    })).toEqual({ kind: 'number', count: 1, total: 500_000 });
  });

  it('Kỳ hiện tại mà thiếu posted_on: CHƯA ĐỦ DỮ LIỆU, không phải 0đ', () => {
    expect(statValue({
      rows: [daChi(null)], views: ['paid'], scope: 'current', period: '2026-09', needsPosting: true,
    })).toEqual({ kind: 'insufficient' });
  });

  it('Tất Cả mà thiếu posted_on: có số nhưng đánh dấu CHƯA XÁC MINH', () => {
    expect(statValue({
      rows: [daChi(null, 1_000_000, 'a'), daChi('2026-09-02', 2_000_000, 'b')],
      views: ['paid'], scope: 'all', period: '2026-09', needsPosting: true,
    })).toEqual({ kind: 'unverified', count: 2, total: 3_000_000 });
  });

  it('đọc đủ ngày chi thì là một con số thật', () => {
    expect(statValue({
      rows: [daChi('2026-09-02', 1_000_000, 'a'), daChi('2026-09-03', 2_000_000, 'b')],
      views: ['paid'], scope: 'current', period: '2026-09', needsPosting: true,
    })).toEqual({ kind: 'number', count: 2, total: 3_000_000 });
  });

  it('không có phiếu đã chi nào thì 0 là kết quả THẬT, không phải thiếu dữ liệu', () => {
    expect(statValue({
      rows: [goc({ status: 'pending' })], views: ['paid'], scope: 'current', period: '2026-09', needsPosting: true,
    })).toEqual({ kind: 'number', count: 0, total: 0 });
  });

  it('thẻ không phụ thuộc bút toán thì không bao giờ báo thiếu dữ liệu', () => {
    expect(statValue({
      rows: [goc({ status: 'noncash', amount: 9_000_000 })],
      views: ['noncash'], scope: 'all', period: '2026-09', needsPosting: false,
    })).toEqual({ kind: 'number', count: 1, total: 9_000_000 });
  });

  it('phiếu đã chi KHÔNG bị hạ xuống chờ chi chỉ vì thiếu bút toán', () => {
    const r = daChi(null);
    expect(viewStatusOf(r)).toBe('paid');
    expect(matchStatus(viewStatusOf(r), 'open')).toBe(false);
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
