// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import ExcelInvoiceDialog from '../ExcelInvoiceDialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const source = vi.hoisted(() => ({ load: vi.fn(), submit: vi.fn() }));
vi.mock('@/hooks/invoices/useExcelInvoiceData', () => ({ fetchExcelInvoiceSource: source.load, fetchPreviousDebtForContract: vi.fn(), useSubmitExcelInvoices: () => ({ submit: source.submit, isPending: false }) }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [{ id: 'b1', name: 'Building' }] }) }));
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [], isLoading: false, isError: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/ui/select', async (importOriginal) => {
 const actual = await importOriginal<typeof import('@/components/ui/select')>();
 return { ...actual, SelectContent: (props: React.ComponentProps<typeof actual.SelectContent>) => <actual.SelectContent {...props} position='item-aligned' /> };
});
afterEach(cleanup);
it('discards an in-flight Excel load when the user changes billing month', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  let resolve!: (data: unknown) => void;
  source.load.mockReturnValue(new Promise(done => { resolve = done; }));
  render(<QueryClientProvider client={new QueryClient()}><ExcelInvoiceDialog open onOpenChange={() => {}} /></QueryClientProvider>);
  fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('option', { name: 'Building' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  await waitFor(() => expect(source.load).toHaveBeenCalledWith('b1', expect.objectContaining({ month: expect.stringMatching(/^\d{4}-\d{2}$/), readingDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })));
  fireEvent.change(document.querySelector('input[type="month"]')!, { target: { value: '2026-12' } });
  await act(async () => resolve({ dupRoomNames: [], contracts: [{ id: 'c1', room_id: 'r1', room: { name: 'OLD-MONTH-ROOM' }, rent_price: 1000000, rent_support: { revision: 1, schedule: { version: 2, start_billing_month: '2026-09', segments: [{ month_count: 12, monthly_amount: '300000' }] } } }],
    meterByRoom: new Map(), lastReading: new Map(), creditByContract: new Map(), invoiceCountByContract: new Map(), previousDebtByContract: new Map() }));
  expect(screen.queryByText('OLD-MONTH-ROOM')).toBeNull();
});
it('clears already loaded meter endpoints when the billing month changes', async () => {
 vi.stubGlobal('PointerEvent', MouseEvent);
 HTMLElement.prototype.scrollIntoView=vi.fn(); HTMLElement.prototype.hasPointerCapture=vi.fn(()=>false); HTMLElement.prototype.releasePointerCapture=vi.fn();
 source.load.mockResolvedValue({dupRoomNames:[],contracts:[{id:'c1',room_id:'r1',room:{name:'SOURCE-MONTH-ROOM'},rent_price:1000000}],meterByRoom:new Map([['r1','meter-1']]),lastReading:new Map([['meter-1',120]]),creditByContract:new Map(),invoiceCountByContract:new Map(),previousDebtByContract:new Map()});
 render(<QueryClientProvider client={new QueryClient()}><ExcelInvoiceDialog open onOpenChange={()=>{}} /></QueryClientProvider>);
 fireEvent.keyDown(screen.getAllByRole('combobox')[0],{key:'ArrowDown'});fireEvent.keyDown(screen.getByRole('option',{name:'Building'}),{key:'Enter'});
 fireEvent.click(screen.getByRole('button',{name:'Tải dữ liệu'}));await screen.findByText('SOURCE-MONTH-ROOM');
 fireEvent.change(document.querySelector('input[type="month"]')!,{target:{value:'2027-01'}});
 expect(screen.queryByText('SOURCE-MONTH-ROOM')).toBeNull();
});
it('keeps batch receipts with their rows and explains locked rooms across batches, closing, reloading and month changes', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  source.submit.mockReset();
  source.load.mockResolvedValue({ dupRoomNames: [], contracts: ['P101', 'P102', 'P103', 'P104'].map((name, i) => ({ id: `c${i + 1}`, room_id: `r${i + 1}`, room: { name }, rent_price: 1000000 })),
    meterByRoom: new Map(), lastReading: new Map(), creditByContract: new Map(), invoiceCountByContract: new Map(), previousDebtByContract: new Map() });
  let finish!: (result: unknown) => void;
  source.submit.mockReturnValueOnce(new Promise(done => { finish = done; }));
  function Page() {
    const [open, setOpen] = useState(true);
    return <><button type="button" onClick={() => setOpen(true)}>Mở lại</button><ExcelInvoiceDialog open={open} onOpenChange={setOpen} /></>;
  }
  render(<QueryClientProvider client={new QueryClient()}><Page /></QueryClientProvider>);
  fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' }); fireEvent.keyDown(screen.getByRole('option', { name: 'Building' }), { key: 'Enter' });
  const month = () => document.querySelector('input[type="month"]') as HTMLInputElement;
  fireEvent.change(month(), { target: { value: '2026-11' } });
  const load = async () => { fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' })); await screen.findByText('P101'); };
  const create = (count: number) => screen.getByRole('button', { name: `Tạo ${count} hoá đơn` }) as HTMLButtonElement;
  const row = (room: string) => screen.getByText(room).closest('tr')!;
  const box = (room: string) => row(room).querySelector('button[role="checkbox"]') as HTMLButtonElement;
  const boxes = () => ['P101', 'P102', 'P103', 'P104'].map(room => `${box(room).getAttribute('aria-checked')}${box(room).disabled ? ' khoá' : ''}`);
  const reading = 'Đã tạo hoá đơn nhưng chưa lưu được chỉ số điện';
  const expectLockedReasons = () => {
    expect(row('P101').textContent).toContain('Đã tạo hoá đơn');
    expect(row('P101').textContent).not.toContain(reading);
    expect(row('P102').textContent).toContain('Chưa rõ kết quả P102');
    expect(row('P102').textContent).not.toContain('Đã tạo hoá đơn');
    expect(row('P104').textContent).toContain(reading);
  };
  const dialogAlert = () => document.querySelector('[role="dialog"] > p[role="alert"]');
  await load();
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  // Lô 1: P101 tạo xong, P102 chưa rõ kết quả, P103 lỗi thường, P104 tạo xong nhưng chưa lưu được chỉ số.
  fireEvent.click(create(4));
  // Đang tạo: không đóng, không đổi toà/kỳ, không tải lại.
  expect((screen.getByRole('button', { name: 'Huỷ' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  expect((screen.getAllByRole('combobox')[0] as HTMLButtonElement).disabled).toBe(true);
  expect(month().disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Tải dữ liệu' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish({ ok: 2, fail: 2, readingFails: ['P104'], recovered: [], errors: [{ contractId: 'c2', message: 'Chưa rõ kết quả P102' }, { contractId: 'c3', message: 'Lỗi P103' }],
    rows: [{ contractId: 'c1', roomName: 'P101', invoiceId: 'i1', readingSaved: true }, { contractId: 'c2', roomName: 'P102', readingSaved: false, error: 'Chưa rõ kết quả P102', outcomeUnknown: true },
      { contractId: 'c3', roomName: 'P103', readingSaved: false, error: 'Lỗi P103' }, { contractId: 'c4', roomName: 'P104', invoiceId: 'i4', readingSaved: false }] }));
  const receipts = screen.getAllByText('Đã tạo hoá đơn — xem biên nhận')[0].closest('[role="status"]')!;
  expect(receipts.textContent).toContain('P103: Lỗi P103');
  expect(receipts.textContent).not.toContain('Chưa lưu được chỉ số điện');
  expect(screen.getByText(/Chưa lưu được chỉ số điện: P104/)).toBeTruthy();
  expectLockedReasons();
  expect(boxes()).toEqual(['false khoá', 'false khoá', 'true', 'false khoá']);
  // Lô 2 trong cùng phiên lại lỗi một phần: dòng khoá từ lô 1 vẫn giữ lý do.
  source.submit.mockResolvedValueOnce({ ok: 0, fail: 1, readingFails: [], recovered: [], errors: [{ contractId: 'c3', message: 'Lỗi P103 lần 2' }], rows: [{ contractId: 'c3', roomName: 'P103', readingSaved: false, error: 'Lỗi P103 lần 2' }] });
  fireEvent.click(create(1));
  await waitFor(() => expect(row('P103').textContent).toContain('Lỗi P103 lần 2'));
  expect(source.submit.mock.lastCall?.[0].map((selected: { contract_id: string }) => selected.contract_id)).toEqual(['c3']);
  expectLockedReasons();
  expect(screen.getByText(/P103: Lỗi P103 lần 2/)).toBeTruthy();
  // Huỷ rồi mở lại: biên nhận bị xoá cùng các dòng.
  fireEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mở lại' }));
  expect(screen.queryByText(/P103: Lỗi P103 lần 2/)).toBeNull();
  expect(screen.queryByText('Đã tạo hoá đơn — xem biên nhận')).toBeNull();
  expect(screen.queryByText(/Chưa lưu được chỉ số điện/)).toBeNull();
  // Tải lại cùng toà/kỳ: phòng đã khoá không tự chọn lại và vẫn hiện lý do.
  await load();
  expectLockedReasons();
  expect(row('P103').textContent).not.toContain('Lỗi P103');
  expect(boxes()).toEqual(['false khoá', 'false khoá', 'true', 'false khoá']);
  // Lỗi phụ của bảng cũ (tải lại nợ cũ hỏng) bị xoá khi tải lại thành công.
  fireEvent.click(row('P103').querySelector('button[title="Tải lại nợ cũ tự động"]')!);
  await waitFor(() => expect(dialogAlert()).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Tải dữ liệu' }));
  await waitFor(() => expect(dialogAlert()).toBeNull());
  expectLockedReasons();
  // Đổi kỳ khi đang có dòng (toà không đồng hồ): khoá và lý do theo đúng kỳ.
  fireEvent.change(month(), { target: { value: '2026-12' } });
  expect(boxes()).toEqual(['false', 'false', 'true', 'false']);
  expect(row('P101').textContent).not.toContain('Đã tạo hoá đơn');
  expect(row('P102').textContent).not.toContain('Chưa rõ kết quả P102');
  const all = document.querySelector('thead button[role="checkbox"]') as HTMLButtonElement;
  fireEvent.click(all); expect(boxes()).toEqual(['true', 'true', 'true', 'true']);
  fireEvent.change(month(), { target: { value: '2026-11' } });
  expectLockedReasons();
  expect(boxes()).toEqual(['false khoá', 'false khoá', 'true', 'false khoá']);
  // "Chọn tất cả" chỉ xét phòng còn mở.
  expect(all.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(all); expect(create(0).disabled).toBe(true);
  fireEvent.click(all); expect(boxes()).toEqual(['false khoá', 'false khoá', 'true', 'false khoá']);
  source.submit.mockResolvedValueOnce({ ok: 1, fail: 0, readingFails: [], recovered: [], errors: [], rows: [{ contractId: 'c3', roomName: 'P103', invoiceId: 'i3', readingSaved: false }] });
  fireEvent.click(create(1));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(source.submit.mock.lastCall?.[0].map((selected: { contract_id: string }) => selected.contract_id)).toEqual(['c3']);
  // Khoá theo kỳ: tải kỳ khác thì cả bốn phòng chọn lại được.
  fireEvent.click(screen.getByRole('button', { name: 'Mở lại' }));
  fireEvent.change(month(), { target: { value: '2026-12' } });
  await load();
  expect(create(4).disabled).toBe(false);
}, 30000);
