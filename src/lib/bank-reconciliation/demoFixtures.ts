import type { Cashbook, DemoState, Invoice, BankTransaction } from './demoModel';
import { routeDemoTransactions } from './demoModel';
import { createSourceRules, demoSources, messagesForTransaction } from './sourceFixtures';
import { channelLabels } from './sourceRules';

export const cashbooks: Cashbook[] = [
  { id: 'demo-an', name: 'Sổ An Nhiên', bank: 'Vietcombank', account: '•••• 8001', buildings: ['An Nhiên'] },
  { id: 'demo-binh', name: 'Sổ Bình Minh', bank: 'Techcombank', account: '•••• 8002', buildings: ['Bình Minh'] },
  { id: 'demo-chung', name: 'Sổ thu chung', bank: 'MB', account: '•••• 8003', buildings: ['An Nhiên', 'Bình Minh'] },
  { id: 'demo-mbdemo', name: 'MBDemo', bank: 'MB', account: '00xxx123', buildings: ['DEMO-A'] },
];
const invoice = (id: string, building: string, room: string, customer: string, total: number, extra: Partial<Invoice> = {}): Invoice => ({
  id, number: `DEMO-HD-${id}`, org: 'DEMO', building, room, customers: [customer], period: '10/2026',
  books: [building === 'An Nhiên' ? 'demo-an' : 'demo-binh', 'demo-chung'], total, paid: 0, status: 'APPROVED', revision: 1, kind: 'Tháng', ...extra,
});
const transaction = (id: string, amount: number, book: string | null, description: string, extra: Partial<BankTransaction> = {}): BankTransaction => ({
  id: `DEMO-GD-${id}`, org: 'DEMO', at: `2026-10-17T${id.padStart(2, '0')}:15:00+07:00`, receivedAt: `2026-10-17T${id.padStart(2, '0')}:16:00+07:00`,
  amount, book, description, direction: 'in', reference: `DEMO-BANK-${id}`, sources: ['SMS · Máy An Nhiên'], ...extra,
});

export function createDemoState(): DemoState {
  const invoices = [
    invoice('101', 'An Nhiên', '101', 'Khách mẫu Linh', 3_250_000),
    invoice('102', 'An Nhiên', '102', 'Khách mẫu Nam', 3_000_000),
    invoice('103', 'An Nhiên', '103', 'Khách mẫu Hân', 2_800_000),
    invoice('104', 'An Nhiên', '104', 'Khách mẫu An', 5_000_000, { paid: 2_000_000, status: 'PARTIAL_PAID' }),
    invoice('201', 'Bình Minh', '201', 'Khách mẫu Minh', 3_000_000),
    invoice('202', 'Bình Minh', '202', 'Khách mẫu Thảo', 3_000_000),
    invoice('105', 'An Nhiên', '105', 'Khách mẫu Hải', 500_000, { period: '09/2026', status: 'OVERDUE', carriedBy: '106' }),
    invoice('106', 'An Nhiên', '105', 'Khách mẫu Hải', 3_500_000, { debtNote: 'Đã gồm 500.000đ nợ tháng 9 (DEMO-HD-105).' }),
    invoice('107', 'An Nhiên', '107', 'Khách mẫu Vy', 3_000_000, { paid: 3_000_000, status: 'PAID' }),
    invoice('108', 'An Nhiên', '108', 'Khách mẫu Hà', 2_500_000, { paid: 2_495_000, status: 'PAID', debtNote: 'Đã tất toán: thu 2.495.000đ + làm tròn 5.000đ.' }),
    invoice('203', 'Bình Minh', '203', 'Khách mẫu Long', 4_200_000, { debtUnclear: true, debtNote: 'Nợ cũ chưa có danh sách nguồn để đối chiếu.' }),
    invoice('204', 'Bình Minh', '204', 'Khách mẫu Ngọc', 1_850_000, { kind: 'Thanh lý', status: 'OVERDUE' }),
    invoice('D06', 'DEMO-A', 'D06', 'Khách mẫu Minh Châu', 650_000, { books: ['demo-mbdemo'], debtNote: 'Tình huống mô phỏng: giả định còn nợ 650.000đ; không phải hóa đơn thật của khách.' }),
  ];
  const transactions = [
    transaction('09', 3_250_000, 'demo-an', 'Khach mau Linh phong 101 An Nhien thang 10', { sources: ['SMS · Máy An Nhiên', 'Gmail · Thu tiền DEMO'], balance: 28_450_000 }),
    transaction('10', 2_990_000, 'demo-an', 'Khach mau Nam phong 102 An Nhien', { sources: ['Gmail · Thu tiền DEMO'] }),
    transaction('11', 2_810_000, 'demo-an', 'Khach mau Han phong 103 An Nhien'),
    transaction('12', 3_000_000, 'demo-an', 'Khach mau An phong 104 An Nhien thanh toan phan con lai'),
    transaction('13', 3_000_000, 'demo-chung', 'Thanh toan tien phong', { sources: ['Thông báo app · Máy dự phòng'] }),
    transaction('14', 3_500_000, 'demo-an', 'Phong 105 An Nhien thang 10 va no thang 9'),
    transaction('15', 3_010_000, 'demo-an', 'Khach mau Vy phong 107 An Nhien', { reference: 'DEMO-BANK-OLD', receivedAt: '2026-10-17T18:30:00+07:00', sources: ['Gmail · Thu tiền DEMO'] }),
    transaction('16', 2_989_999, 'demo-an', 'Phong 102 An Nhien', { sources: ['Gmail · Thu tiền DEMO'] }),
    transaction('17', 950_000, 'demo-binh', 'Thanh toan dich vu bao tri DEMO', { direction: 'out', sources: ['Thông báo app · Máy Bình Minh'] }),
    transaction('18', 3_000_000, null, 'Thanh toan tien phong'),
    transaction('19', 4_200_000, 'demo-binh', 'Phong 203 Binh Minh', { issue: 'Hóa đơn liên quan có nợ gộp chưa rõ nguồn.' }),
    transaction('20', 3_000_000, 'demo-chung', 'Khach mau Minh phong 201 Binh Minh'),
    transaction('21', 3_250_000, 'demo-an', 'Phong 101 An Nhien', { issue: 'Nghi trùng với DEMO-GD-09; thiếu mã ngân hàng để kết luận.', sources: ['Thông báo app · Máy dự phòng'] }),
    transaction('22', 1_850_000, 'demo-binh', 'Khach mau Ngoc phong 204 Binh Minh thanh ly'),
    transaction('08', 600_000, 'demo-binh', 'Khoan coc giu cho DEMO', { classification: 'other', note: 'Cọc riêng, chưa khớp hóa đơn khách thuê.' }),
    transaction('MB01', 650_000, 'demo-mbdemo', 'KHACH MAU MINH CHAU thanh toan', { at: '2026-10-17T09:15:00+07:00', receivedAt: '2026-10-17T09:15:20+07:00', sources: ['Thông báo app · MBDemo'] }),
  ];
  for (const t of transactions) {
    t.messages = messagesForTransaction(t);
    t.sources = t.messages.map(m => `${channelLabels[m.channel]} · ${demoSources.find(s => s.id === m.sourceId)?.name ?? m.sourceId}`);
  }
  return routeDemoTransactions({ invoices, transactions, version: 0, audit: [], sourceRules: createSourceRules(), sourceHistory: [], receipts: [
    { id: 'DEMO-PT-CU-01', invoiceId: '107', book: 'demo-an', org: 'DEMO', retained: 3_010_000, applied: 3_000_000, credit: 10_000, reference: 'DEMO-BANK-OLD', active: true, posted: true },
  ] });
}
