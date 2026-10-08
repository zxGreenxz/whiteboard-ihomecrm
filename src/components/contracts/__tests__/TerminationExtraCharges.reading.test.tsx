// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractWithRelations } from '@/types/contract';
import type { ExtraChargeItem } from '@/lib/contractValidation';

const db = vi.hoisted(() => ({ meters: [] as { id: string; status: string | null }[], lastReading: 0, readingMeter: '' }));
vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain, is: () => chain, order: () => chain,
      eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
      limit: () => chain,
      then: (resolve: (value: { data: unknown; error: null }) => void) => {
        if (table === 'meters') return resolve({ data: db.meters, error: null });
        db.readingMeter = String(filters.meter_id);
        return resolve({ data: [{ current_reading: db.lastReading }], error: null });
      },
    };
    return chain;
  };
  return { supabase: { from: builder } };
});
vi.mock('@/hooks/useBuildingServices', () => ({ useBuildingServices: () => ({ data: [
  { is_active: true, service_id: 'elec', unit_price_override: 3500, service: { name: 'Tiền điện', unit_price: 3500 } },
] }) }));
import { TerminationExtraCharges } from '../TerminationExtraCharges';

const contract = { id: 'c1', room_id: 'room-1', rent_price: 3_000_000, contract_services: [], contract_customers: [],
  initial_electricity_reading: 100, room: { building_id: 'b1' } } as unknown as ContractWithRelations;
let items: ExtraChargeItem[] = [];
const show = () => render(<TerminationExtraCharges contract={contract} chargeDate="2026-10-08" onChange={value => { items = value; }} />);
const electric = () => items.find(item => item.kind === 'ELECTRIC');

beforeEach(() => { items = []; db.meters = [{ id: 'm-active', status: 'ACTIVE' }]; db.lastReading = 5000; db.readingMeter = ''; });
afterEach(cleanup);

describe('Tiền điện khi thanh lý: dòng nhắc chỉ hứa ghi số khi thật sự có dòng tiền điện', () => {
  it('có tiêu thụ trên đồng hồ đang chạy ⇒ phát dòng điện gắn đồng hồ và nói số được ghi', async () => {
    show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu') as HTMLInputElement).value).toBe('5000'));
    fireEvent.change(screen.getByTitle('Số điện cuối'), { target: { value: '5012' } });
    await waitFor(() => expect(electric()).toMatchObject({ meter_id: 'm-active', previous_reading: 5000, current_reading: 5012, amount: 42000 }));
    expect(screen.getByText('Số cuối ghi luôn làm chỉ số lúc trả phòng.')).toBeTruthy();
  });
  it('số cuối bằng số đầu ⇒ không có dòng điện nên nói rõ số không được ghi', async () => {
    show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu') as HTMLInputElement).value).toBe('5000'));
    fireEvent.change(screen.getByTitle('Số điện cuối'), { target: { value: '5000' } });
    await waitFor(() => expect(screen.getByText(/Không phát sinh tiền điện nên số này không được ghi/)).toBeTruthy());
    expect(electric()).toBeUndefined();
  });
  it('đồng hồ điện duy nhất đã ngừng ⇒ số đầu vẫn lấy từ đồng hồ đó, không gửi mã đồng hồ, nói rõ không ghi', async () => {
    db.meters = [{ id: 'm-old', status: 'INACTIVE' }];
    db.lastReading = 7000;
    show();
    await waitFor(() => expect((screen.getByTitle('Số điện đầu') as HTMLInputElement).value).toBe('7000'));
    expect(db.readingMeter).toBe('m-old');
    fireEvent.change(screen.getByTitle('Số điện cuối'), { target: { value: '7010' } });
    await waitFor(() => expect(electric()).toMatchObject({ meter_id: null, current_reading: 7010 }));
    expect(screen.getByText(/Phòng chưa có đồng hồ điện đang dùng/)).toBeTruthy();
  });
});
