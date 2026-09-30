// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  setting: vi.fn(), oldSetting: vi.fn(), building: vi.fn(), room: vi.fn(), service: vi.fn(),
  flag: vi.fn(), toast: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'actor-a' } }) }));
vi.mock('@/hooks/useSettings', () => ({
  useUpdateIndividualSetting: () => ({ mutateAsync: io.setting, mutate: io.oldSetting, isPending: false }),
}));
vi.mock('@/hooks/useBuildings', () => ({ useCreateBuilding: () => ({ mutateAsync: io.building, isPending: false }) }));
vi.mock('@/hooks/useRooms', () => ({ useCreateRoom: () => ({ mutateAsync: io.room, isPending: false }) }));
vi.mock('@/hooks/useServices', () => ({ useCreateService: () => ({ mutateAsync: io.service, isPending: false }) }));
vi.mock('../onboardingCompleted', () => ({ ONBOARDING_KEY: 'onboarding_completed', fetchOnboardingCompleted: io.flag }));
vi.mock('sonner', () => ({ toast: { error: io.toast } }));
import OnboardingWizard from '../OnboardingWizard';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  io.flag.mockResolvedValue(false);
  io.setting.mockResolvedValue({ id: 'setting-a', value: true });
  io.building.mockResolvedValue({ id: 'building-a' });
  io.room.mockResolvedValue({ id: 'room-a' });
  io.service.mockResolvedValue({ id: 'service-a' });
});
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><OnboardingWizard /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(client.getQueryData(['onboarding-completed-flag', 'actor-a'])).toBe(false));
  return client;
}
function next() { fireEvent.click(screen.getByRole('button', { name: 'Bước tiếp' })); }
function create() { fireEvent.click(screen.getByRole('button', { name: 'Tạo & Tiếp tục' })); }

describe('onboarding feedback and completion receipt', () => {
  it('keeps the flag false and dialog open while the completion receipt is pending', async () => {
    let resolve!: (value: unknown) => void;
    io.setting.mockImplementation(() => new Promise(done => { resolve = done; }));
    const client = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua' }));
    expect(client.getQueryData(['onboarding-completed-flag', 'actor-a'])).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(io.setting).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ id: 'setting-a', value: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.getQueryData(['onboarding-completed-flag', 'actor-a'])).toBe(true);
  });
  it('does not mark completion or close on a rejected setting write, and preserves drafts', async () => {
    io.setting.mockRejectedValue({ code: '42501', message: 'permission denied: PRIVATE_SCHEMA' });
    const client = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));
    fireEvent.change(screen.getByLabelText(/Tên toà nhà/), { target: { value: 'Nhà đang nhập' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('quyền'));
    expect(client.getQueryData(['onboarding-completed-flag', 'actor-a'])).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByLabelText(/Tên toà nhà/) as HTMLInputElement).value).toBe('Nhà đang nhập');
    expect(screen.getByRole('alert').textContent).not.toContain('PRIVATE_SCHEMA');
  });
  it('the final step also waits for and requires a receipt', async () => {
    io.setting.mockRejectedValue(new TypeError('Failed to fetch'));
    const client = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn thành' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('xác nhận'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(client.getQueryData(['onboarding-completed-flag', 'actor-a'])).toBe(false);
    expect(io.setting).toHaveBeenCalledWith(true);
  });
  it.each([
    ['building', /Tên toà nhà/, 0, io.building],
    ['apartment', /Tên căn hộ/, 1, io.room],
    ['service', /Tên dịch vụ/, 2, io.service],
  ])('reveals the required %s name error and focuses that field before any writer', async (_step, label, skips, writer) => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));
    for (let i = 0; i < Number(skips); i++) next();
    create();
    const input = screen.getByLabelText(label as RegExp);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = input.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    expect(document.getElementById(errorId!)?.textContent).toContain('nhập tên');
    expect(writer).not.toHaveBeenCalled();
    expect(io.toast).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Tên hợp lệ' } });
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
  });
  it('preserves malformed currency text and blocks the service writer', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));
    next(); next();
    fireEvent.change(screen.getByLabelText(/Tên dịch vụ/), { target: { value: 'Điện' } });
    const price = screen.getAllByRole('textbox')[1];
    fireEvent.change(price, { target: { value: 'abc' } });
    create();
    await waitFor(() => expect(document.activeElement).toBe(price));
    expect(io.service).not.toHaveBeenCalled();
    expect((price as HTMLInputElement).value).toBe('abc');
    expect(document.activeElement).toBe(price);
  });
  it('does not advance or erase the building draft after a create rejection', async () => {
    io.building.mockRejectedValue({ code: '42501' });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu' }));
    const name = screen.getByLabelText(/Tên toà nhà/);
    fireEvent.change(name, { target: { value: 'Nhà A' } });
    create();
    await waitFor(() => expect(io.building).toHaveBeenCalledTimes(1));
    expect((name as HTMLInputElement).value).toBe('Nhà A');
    expect(screen.queryByLabelText(/Tên căn hộ/)).toBeNull();
  });
});
