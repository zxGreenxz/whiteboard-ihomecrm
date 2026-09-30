// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NetworkActionDialog } from './NetworkActionDialog';
import { MaintenanceDialog } from './MaintenanceDialog';
import { SettingsTab } from './tabs/SettingsTab';
import { DemoNetworkCenterRepository } from '@/lib/network-center/demoRepository';
import type { NetworkCenterController } from '@/hooks/network-center/useNetworkCenter';
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
const site = new DemoNetworkCenterRepository([{ id: 'a', name: 'Tòa A', roomsCount: 10 }]).getBuilding('a')!;
describe('network form field feedback', () => {
  it('keeps invalid action open and focuses reason before invoking the server', async () => {
    const execute = vi.fn();
    render(<NetworkActionDialog site={{ ...site, rolloutState: 'EXECUTE' }} canExecute disabledReason="" onExecute={execute} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thao tác MikroTik' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Kiểm tra và thực thi' }).closest('form')!);
    const reason = screen.getByLabelText('Lý do thao tác');
    await waitFor(() => expect(document.activeElement).toBe(reason));
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(execute).not.toHaveBeenCalled();
  });
  it('shows every maintenance field error and focuses the first', async () => {
    const create = vi.fn();
    render(<MaintenanceDialog buildingId="a" buildingName="Tòa A" rolloutState="EXECUTE" canExecute disabledReason="" onCreate={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tạo bảo trì' }));
    fireEvent.change(screen.getByLabelText('Thời lượng (phút)'), { target: { value: '1' } });
    fireEvent.submit(screen.getAllByRole('button', { name: 'Tạo bảo trì' }).at(-1)!.closest('form')!);
    const duration = screen.getByLabelText('Thời lượng (phút)');
    await waitFor(() => expect(document.activeElement).toBe(duration));
    expect(screen.getByLabelText('Lý do').getAttribute('aria-invalid')).toBe('true');
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves all settings and points to the first invalid field', async () => {
    const updateSettings = vi.fn();
    const controller = { canExecute: true, executeDisabledMessage: '', updateSettings } as unknown as NetworkCenterController;
    render(<SettingsTab site={{ ...site, rolloutState: 'EXECUTE', settingsVersion: 1 }} controller={controller} />);
    fireEvent.change(screen.getByLabelText('Chu kỳ kiểm tra (giây)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
    const input = screen.getByLabelText('Chu kỳ kiểm tra (giây)');
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
