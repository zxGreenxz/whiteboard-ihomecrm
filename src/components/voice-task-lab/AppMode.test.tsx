// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VoiceTaskLabPage from '@/pages/VoiceTaskLabPage';
import { LabApiError, type LabClient } from '@/lib/voice-task-lab/client';

afterEach(cleanup);
const empty = { records: [], summary: { totalRecords: 0, reviewedFields: 0, correctFields: 0, fieldAccuracy: null, ratedRecords: 0, usefulRecords: 0, usefulnessRate: null, fullyReviewedRecords: 0, fullyCorrectRecords: 0, fullCorrectRate: null } };
function client(): LabClient {
  return { status: async () => ({ authenticated: true, chatModels: ['chat-a'], sttModels: [], providerReady: true }), evaluations: async () => empty, transcribe: vi.fn(), extract: vi.fn(), save: vi.fn(), export: async () => empty };
}
describe('CRM voice lab screen', () => {
  it.each([401, 403])('does not offer the standalone access-code login after HTTP %s', async status => {
    const api = client(); api.status = async () => { throw new LabApiError('Phiên hoặc quyền CRM không hợp lệ.', status); };
    render(<VoiceTaskLabPage client={api} accessMode="app" maxAudioBytes={2 * 1024 * 1024} />);
    await screen.findByText('Chưa mở được bản thử nghiệm');
    expect(screen.queryByLabelText('Mã truy cập')).toBeNull();
    expect(screen.getByRole('link', { name: 'Đăng nhập lại' }).getAttribute('href')).toBe('/login');
  });
  it('ignores a late extraction after cancellation even when the transport ignores the signal', async () => {
    const api = client(); let resolve!: (value: Awaited<ReturnType<LabClient['extract']>>) => void;
    api.extract = () => new Promise(done => { resolve = done; });
    render(<VoiceTaskLabPage client={api} accessMode="app" />);
    await screen.findByRole('button', { name: 'Nhập chữ' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Nhập chữ' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Nhập chữ' }));
    fireEvent.change(screen.getByLabelText('Nhập việc cần làm'), { target: { value: 'Sửa vòi phòng 201' } });
    fireEvent.click(screen.getByRole('button', { name: 'Phân tích công việc' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hủy xử lý' }));
    await act(async () => { resolve({ draft: { title: 'Bản nháp đến muộn', description: 'Sửa vòi', room: '201', building: '', jobType: '', assignee: '', deadline: '', priority: 'NORMAL' }, warnings: [], elapsedMs: 10, model: 'chat-a', referenceTime: '2026-09-26T12:00:00Z' }); });
    expect(screen.queryByText('Bản nháp đến muộn')).toBeNull();
    expect((screen.getByLabelText('Nhập việc cần làm') as HTMLTextAreaElement).value).toBe('Sửa vòi phòng 201');
  });
});
