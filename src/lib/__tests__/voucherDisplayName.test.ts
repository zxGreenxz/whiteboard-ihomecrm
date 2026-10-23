// Tên hiển thị phiếu thu/chi (chủ nhắn 23/10/2026) + lõi tên hoá đơn tách khỏi getInvoiceTitle.
// Bản CŨ của getInvoiceTitle và của tên dòng Báo cáo LN được chép nguyên vào đây làm đối chứng: tách lõi /
// dời luật về hàm dùng chung không được đổi một chữ nào ở chỗ cũ. Mã / tên phòng giả.
import { describe, expect, it } from 'vitest';
import { getInvoiceTitle, invoiceTitleFromParts, invoiceTitlePartsOf, isFirstMonthInvoice } from '@/lib/invoiceUtils';
import {
  invoiceIdsForDisplay, isAutoInvoiceVoucherName, normalizeVi, profitReportRowDescription, voucherDisplayName,
} from '@/lib/voucherDisplayName';
import type { InvoiceWithRelations } from '@/types/invoice';

type HoaDon = Parameters<typeof invoiceTitlePartsOf>[0] & { room?: { name: string } | null; building?: { name: string } | null };

// ── bản cũ (commit trước 23/10/2026), giữ nguyên từng dòng logic ──
function getInvoiceTitleCu(invoice: HoaDon): string {
  const month = invoice.billing_month ?? '';
  const monthDisplay = (() => {
    if (!month) return '';
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    return m ? `${m[2]}/${m[1]}` : month;
  })();
  const loc = [invoice.room?.name, invoice.building?.name].filter(Boolean).join('/');
  const monthPart = monthDisplay || month;
  const suffix = [loc, monthPart].filter(Boolean).join(' - ');
  const notes = invoice.notes ?? '';
  const isLiquidation = (invoice as { kind?: string }).kind === 'SETTLEMENT' || /thanh\s*lý/i.test(notes);
  if (isLiquidation) {
    const isExtra = /^hoá\s*đơn\s*thu\s*thêm/i.test(notes.trimStart());
    const issueDisplay = (() => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(invoice.issue_date ?? '');
      return m ? `${m[3]}/${m[2]}/${m[1]}` : monthDisplay;
    })();
    const liqSuffix = [loc, issueDisplay].filter(Boolean).join(' - ');
    const label = isExtra ? 'Hóa đơn thu thêm (thanh lý)' : 'Hóa đơn thanh lý';
    return liqSuffix ? `${label} - ${liqSuffix}` : label;
  }
  const hasRent = invoice.invoice_items?.some((i) => i.type === 'RENT');
  const hasService = invoice.invoice_items?.some((i) => i.type === 'SERVICE' || i.type === 'PENALTY');
  if (hasRent && isFirstMonthInvoice(invoice)) return suffix ? `TIỀN PHÒNG THÁNG ĐẦU TIÊN - ${suffix}` : 'TIỀN PHÒNG THÁNG ĐẦU TIÊN';
  if (hasRent && hasService) return suffix ? `TIỀN PHÒNG - ${suffix}` : 'TIỀN PHÒNG';
  if (hasRent) return suffix ? `Hóa đơn tiền nhà - ${suffix}` : 'Hóa đơn tiền nhà';
  if (hasService) return suffix ? `Hóa đơn dịch vụ - ${suffix}` : 'Hóa đơn dịch vụ';
  return suffix ? `Hóa đơn - ${suffix}` : 'Hóa đơn';
}
const nrmCu = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/đ/g, 'd').trim();
function moTaBaoCaoCu(r: { isNote: boolean; typeName: string; description: string; invTitle?: string }, side: 'income' | 'expense', mm: number) {
  if (r.isNote) return r.description;
  if (side === 'expense') return r.description;
  if (nrmCu(`${r.typeName} ${r.description}`).includes('thanh ly')) return 'HĐ Thanh Lý Hợp Đồng';
  if (r.invTitle) return r.invTitle;
  if (nrmCu(r.description).includes('thu tien theo hd tien phong')) return `Hóa Đơn Tiền Phòng T${mm || 1}`;
  return r.description;
}

const KIND = [undefined, null, 'MONTHLY', 'SETTLEMENT'];
const NOTES = [null, '', 'thanh lý sớm', 'THANH LÝ', 'Hoá đơn thu thêm khi bỏ cọc', '  HOÁ ĐƠN THU THÊM', 'tháng đầu',
  'HĐ THÁNG ĐẦU', 'thang_đầu', 'đầu tiên', 'Hoá đơn tháng 1 + thu thêm 200.000đ', 'hóa đơn thu thêm'];
const ITEMS: HoaDon['invoice_items'][] = [null, [], [{ type: 'RENT', from_date: '2025-01-01' }], [{ type: 'RENT', from_date: '2025-01-05' }],
  [{ type: 'SERVICE' }], [{ type: 'PENALTY' }], [{ type: 'RENT', from_date: null }, { type: 'SERVICE' }],
  [{ type: 'OTHER' }, { type: 'RENT', from_date: '2024-12-01' }, { type: 'RENT', from_date: '2025-01-01' }]];
const CONTRACT = [null, { start_billing_date: '2025-01-01' }, { start_billing_date: null }];
const MONTH = ['2025-01', null, 'tháng 1'];
const ISSUE = ['2025-01-20', null];
const PLACE: Pick<HoaDon, 'room' | 'building'>[] = [{}, { room: { name: '203' } }, { room: { name: '203' }, building: { name: 'Toà A' } }];

describe('lõi tên hoá đơn tách khỏi getInvoiceTitle', () => {
  it('trùng TỪNG CHỮ bản cũ trên mọi tổ hợp loại × ghi chú × dòng × hợp đồng × kỳ × ngày lập × phòng/toà', () => {
    let soCa = 0;
    for (const kind of KIND) for (const notes of NOTES) for (const invoice_items of ITEMS) for (const contract of CONTRACT)
      for (const billing_month of MONTH) for (const issue_date of ISSUE) for (const place of PLACE) {
        const hd: HoaDon = { kind, notes, invoice_items, contract, billing_month, issue_date, ...place };
        expect(getInvoiceTitle(hd as unknown as InvoiceWithRelations)).toBe(getInvoiceTitleCu(hd));
        soCa += 1;
      }
    expect(soCa).toBe(4 * 12 * 8 * 3 * 3 * 2 * 3);
  });

  it('dựng từ phần: không chỗ ⇒ như cũ thiếu phòng/toà; có chỗ ⇒ chèn đúng chỗ', () => {
    const p = invoiceTitlePartsOf({ kind: 'MONTHLY', billing_month: '2026-10', invoice_items: [{ type: 'RENT' }, { type: 'SERVICE' }] });
    expect(invoiceTitleFromParts(p, null)).toBe('TIỀN PHÒNG - 10/2026');
    expect(invoiceTitleFromParts(p, '203')).toBe('TIỀN PHÒNG - 203 - 10/2026');
    const tl = invoiceTitlePartsOf({ kind: 'SETTLEMENT', billing_month: '2026-10', issue_date: '2026-10-05' });
    expect(invoiceTitleFromParts(tl, '203')).toBe('Hóa đơn thanh lý - 203 - 05/10/2026');
  });
});

describe('tên hiển thị phiếu', () => {
  const tienPhong = invoiceTitlePartsOf({
    kind: 'MONTHLY', billing_month: '2026-10', invoice_items: [{ type: 'RENT', from_date: '2026-10-01' }, { type: 'SERVICE' }],
    contract: { start_billing_date: '2026-09-01' },
  });
  const thangDau = { ...tienPhong, isFirstMonth: true };

  it('"Thu tiền theo HĐ <mã>" gắn hoá đơn ⇒ tên hoá đơn; nơi không có cột phòng chèn phòng', () => {
    const v = { name: 'Thu tiền theo HĐ INV-2026-00001', roomName: '203', invoice: tienPhong };
    expect(voucherDisplayName(v, { includeRoom: false })).toBe('TIỀN PHÒNG - 10/2026');
    expect(voucherDisplayName(v, { includeRoom: true })).toBe('TIỀN PHÒNG - 203 - 10/2026');
    expect(voucherDisplayName({ ...v, invoice: thangDau }, { includeRoom: false })).toBe('TIỀN PHÒNG THÁNG ĐẦU TIÊN - 10/2026');
    // mã hoá đơn rỗng (writer COALESCE '') vẫn là mẫu tự sinh
    expect(voucherDisplayName({ ...v, name: 'Thu tiền theo HĐ ' }, { includeRoom: false })).toBe('TIỀN PHÒNG - 10/2026');
  });

  it('chưa tải xong / không đọc được hoá đơn ⇒ tạm tên gốc; tên đã sửa tay giữ nguyên dù gắn hoá đơn', () => {
    expect(voucherDisplayName({ name: 'Thu tiền theo HĐ INV-2026-00001', invoice: null }, { includeRoom: true }))
      .toBe('Thu tiền theo HĐ INV-2026-00001');
    for (const name of ['Thu tiền theo HĐ INV-1 + cọc tháng 10', 'Tiền phòng anh Ba', 'Thu tiền theo hợp đồng', 'DEMO Thu tiền theo HĐ INV-1']) {
      expect(voucherDisplayName({ name, roomName: '203', invoice: tienPhong }, { includeRoom: true })).toBe(name);
    }
    expect(voucherDisplayName({ name: null }, { includeRoom: true })).toBe('');
  });

  it('"… — HĐ <mã hợp đồng>" ⇒ bỏ mã; nơi không có cột phòng thay bằng "— phòng <phòng>"', () => {
    const cases: [string, string | null, boolean, string][] = [
      ['Doanh thu bỏ cọc — HĐ HD-2026-0012', '203', true, 'Doanh thu bỏ cọc — phòng 203'],
      ['Doanh thu thanh lý — HĐ HĐT-0001/2026', '203', false, 'Doanh thu thanh lý'],
      ['Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ HD-2026-0012', null, true, 'Doanh thu thanh lý (khoản hoàn cấn nợ)'],
      ['Khách trả thêm khi thanh lý — HĐ HD-2026-0012', 'Phòng 305', true, 'Khách trả thêm khi thanh lý — Phòng 305'],
      ['Hoàn tiền cọc — HĐ HĐT-0001/2026', ' 101 ', true, 'Hoàn tiền cọc — phòng 101'],
      // không phải đuôi hệ thống (gạch ngắn / không có "HĐ" / mã ở giữa) ⇒ giữ nguyên
      ['Sửa điện - HĐ HD-1', '203', true, 'Sửa điện - HĐ HD-1'],
      ['Doanh thu — tháng 10', '203', true, 'Doanh thu — tháng 10'],
      ['— HĐ HD-1', '203', true, '— HĐ HD-1'],
    ];
    for (const [name, roomName, includeRoom, want] of cases) {
      expect(voucherDisplayName({ name, roomName }, { includeRoom })).toBe(want);
    }
  });

  it('chỉ đọc hoá đơn của phiếu mang tên tự sinh, không trùng id', () => {
    expect(invoiceIdsForDisplay([
      { name: 'Thu tiền theo HĐ INV-1', invoice_id: 'a' },
      { name: 'Thu tiền theo HĐ INV-1', invoice_id: 'a' },
      { name: 'Doanh thu bỏ cọc — HĐ HD-1', invoice_id: 'b' },
      { name: 'Thu tiền theo HĐ INV-2', invoice_id: null },
      { name: 'Thu tiền theo HĐ INV-3', invoice_id: 'c' },
    ])).toEqual(['a', 'c']);
    expect(isAutoInvoiceVoucherName('Thu tiền theo HĐ INV-2026-01184')).toBe(true);
    expect(isAutoInvoiceVoucherName(undefined)).toBe(false);
  });
});

describe('tên dòng Báo cáo LN dời về hàm dùng chung', () => {
  it('trùng bản cũ của hai trang báo cáo trên mọi loại dòng', () => {
    const inv = invoiceTitlePartsOf({ kind: 'MONTHLY', billing_month: '2026-10', invoice_items: [{ type: 'RENT' }, { type: 'SERVICE' }] });
    const rows = [
      { isNote: true, typeName: 'Ghi chú', description: 'Trống 12 ngày — Thanh lý HĐ' },
      { isNote: false, typeName: 'Doanh thu thanh lý', description: 'Doanh thu thanh lý — HĐ HD-1' },
      { isNote: false, typeName: 'Tiền phòng', description: 'Thu tiền theo HĐ Tiền phòng T10' },
      { isNote: false, typeName: 'Tiền phòng', description: 'Thu tiền theo HĐ INV-1' },
      { isNote: false, typeName: 'Điện', description: 'Chi tiền điện' },
      { isNote: false, typeName: null as unknown as string, description: 'Thu khác' },
    ];
    for (const r of rows) for (const side of ['income', 'expense'] as const) for (const coHd of [true, false]) for (const mm of [10, 0]) {
      const invTitle = coHd ? invoiceTitleFromParts(inv, null) : undefined;
      expect(profitReportRowDescription({ ...r, side }, { invoice: coHd ? inv : null, month: mm || 1 }))
        .toBe(moTaBaoCaoCu({ ...r, invTitle }, side, mm));
    }
    expect(normalizeVi(' ĐIỆN Nước ')).toBe('dien nuoc');
  });
});
