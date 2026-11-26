// @vitest-environment jsdom
// Đợt 9, kho giấy cọc Quay số (mẫu PR #478): mỗi lần tải là một đường dẫn mới (`x-upsert: false`), tải hỏng thì cho tải lại,
// tệp mồ côi vô hại. Ảnh ĐÃ tải xong mà chưa gắn vào đội vẫn được giữ để gắn lại. Dấu «đã lên kế hoạch tải» của bản trước
// không chặn gì: đọc một lần rồi bỏ.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { luckyWorld, type FakeEvent, type FakeTeam, type LuckyWorld } from '@/lib/__tests__/helpers/luckyFakeServer';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('./LuckyWheelCanvas', () => ({ default: () => null, fireConfetti: vi.fn() }));
vi.mock('./AnimalRaceTrack', () => ({ default: () => null }));
vi.mock('./MultiRoundStage', () => ({ default: () => null }));

let world: LuckyWorld;
let event: FakeEvent;
let team: FakeTeam;
// Nạp trang một lần trước (biên dịch cả cây module) để từng ca sau `vi.resetModules()` không chạm trần giờ khi máy đang tải nặng.
beforeAll(async () => { URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn(); await import('./QuaySoPage'); }, 60_000);
beforeEach(() => {
  localStorage.clear();
  world = luckyWorld();
  event = world.addEvent();
  team = world.addTeam(event, { name: 'Đội A' });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { body?: unknown }) => world.publicFetch(url, init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  vi.resetModules();
  const { PayoutForm } = await import('./QuaySoPage');
  const publicTeam = { id: team.id, name: team.name, proofs: [], payoutAccount: null, payoutBank: null, payoutHolder: null } as never;
  return render(<PayoutForm eventId={event.id} code={team.code} team={publicTeam} onSaved={vi.fn()} />);
}
const fileInput = (view: ReturnType<typeof render>) => view.container.querySelector('input[type="file"]') as HTMLInputElement;
const pick = (view: ReturnType<typeof render>, name = 'coc.png') => fireEvent.change(fileInput(view), { target: { files: [new File(['image'], name, { type: 'image/png' })] } });
const legacyPlannedKey = () => 'ihome:lucky-proof-pending:v1:' + [event.id, 'upload:' + team.id].map(encodeURIComponent).join(':');
const uploadedKey = () => 'ihome:lucky-proof-pending:v1:' + [event.id, team.id].map(encodeURIComponent).join(':');

describe('giấy cọc: tải hỏng thì tải lại được, không khoá ô tải', () => {
  it.each(['drop-before', 'drop-after'] as const)('tải lên %s: nút «Thử lại» bật, bấm lại tải thành tệp MỚI và gắn đúng một tấm', async failure => {
    world.failNextUpload(failure);
    const view = await mount();
    pick(view);
    const retry = await screen.findByRole('button', { name: 'Thử lại coc.png' }) as HTMLButtonElement;
    expect(screen.getByRole('alert').textContent).toMatch(/Chưa tải xong coc\.png/);
    expect(retry.disabled).toBe(false);
    expect(fileInput(view).disabled).toBe(false);
    fireEvent.click(retry);
    await screen.findByText(/Đã nộp 1\/1 giấy cọc/);
    expect(team.proofs).toHaveLength(1);
    expect(world.stored).toHaveLength(failure === 'drop-after' ? 2 : 1);
    expect(team.proofs[0]!.path).toBe(world.stored.at(-1));
    expect(localStorage.getItem(uploadedKey())).toBeNull();
  });

  it('dấu «đã lên kế hoạch tải» bản trước gieo sẵn: không chặn, đọc một lần rồi bỏ, nhắc chọn lại tệp đó', async () => {
    localStorage.setItem(legacyPlannedKey(), JSON.stringify([{ path: `${event.id}/old.png`, name: 'old.png' }]));
    const view = await mount();
    expect(fileInput(view).disabled).toBe(false);
    expect(view.container.textContent).toContain('old.png');
    expect(localStorage.getItem(legacyPlannedKey())).toBeNull();
    pick(view);
    await screen.findByText(/Đã nộp 1\/1 giấy cọc/);
    expect(team.proofs.map(p => p.name)).toEqual(['coc.png']);
  });

  it('ảnh đã tải xong mà chưa gắn được vẫn giữ qua lần tải lại trang và được gắn lại, không tải lần hai', async () => {
    world.server.failNext('lucky_save_payout_v1', 'rpc', 'drop-before');
    const first = await mount();
    pick(first);
    await screen.findByText(/Tệp đã tải lên, đang chờ xác nhận: coc.png/);
    first.unmount();
    await mount();
    expect(screen.getByText(/Tệp đã tải lên, đang chờ xác nhận: coc.png/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra và gắn các tệp đã tải' }));
    await waitFor(() => expect(team.proofs).toHaveLength(1));
    expect(world.stored).toHaveLength(1);
    expect(team.proofs[0]!.path).toBe(world.stored[0]);
  });

  it('tệp chờ gắn nằm ngoài thư mục của sự kiện không bao giờ được đem gắn (hàng rào giữ nguyên)', async () => {
    localStorage.setItem(uploadedKey(), JSON.stringify([{ path: 'event-khac/x.png', name: 'x.png' }]));
    const view = await mount();
    expect(view.container.textContent).not.toContain('x.png');
    expect(fileInput(view).disabled).toBe(false);
    pick(view);
    await screen.findByText(/Đã nộp 1\/1 giấy cọc/);
    expect(team.proofs.map(p => p.name)).toEqual(['coc.png']);
  });

  it('bản lưu tệp chờ gắn hỏng dạng không khoá ô tải', async () => {
    localStorage.setItem(uploadedKey(), '{hỏng');
    const view = await mount();
    expect(fileInput(view).disabled).toBe(false);
    pick(view);
    await screen.findByText(/Đã nộp 1\/1 giấy cọc/);
  });

  it('tệp chờ gắn mà đội không gắn được nữa: có lối bỏ qua để tải tiếp, không khoá mãi', async () => {
    world.server.failNext('lucky_save_payout_v1', 'rpc', 'drop-before');
    const view = await mount();
    pick(view);
    await screen.findByText(/Tệp đã tải lên, đang chờ xác nhận: coc.png/);
    expect(fileInput(view).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua các tệp này' }));
    await waitFor(() => expect(fileInput(view).disabled).toBe(false));
    expect(localStorage.getItem(uploadedKey())).toBeNull();
  });
});
