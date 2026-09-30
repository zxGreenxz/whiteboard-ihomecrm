// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ userId: 'admin-a' }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: m.userId }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { financialPending } from '@/lib/financialPending';
import { CopilotAdminUnknownError, copilotAdminOutcomeUnknown } from '../adminWrites';
import { runPersistentCopilotAdminWrite } from '../adminPersistence';
const scope = () => ({ namespace: 'copilot-admin', userId: m.userId, organizationId: 'actor-scope', businessKey: 'settings' });
beforeEach(() => { localStorage.clear(); m.userId = 'admin-a'; });
it('marker tồn tại trước writer; unknown/selected-org change không giải phóng', async () => {
 localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-a');
 const task = vi.fn(async () => { expect(financialPending.read(scope())).not.toBeNull(); throw new CopilotAdminUnknownError(); });
 await expect(runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task)).rejects.toMatchObject({ outcome: 'unknown' });
 localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-b');
 await expect(runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task)).rejects.toMatchObject({ outcome: 'unknown' }); expect(task).toHaveBeenCalledOnce();
});
it('receipt IDs server trả vẫn giữ sau request mới/remount', async () => {
 await expect(runPersistentCopilotAdminWrite('settings', 'cấp hạn mức', async () => { throw new CopilotAdminUnknownError(['grant-a']); })).rejects.toMatchObject({ completed: [{ id: 'grant-a', label: 'Mã cần đối chiếu' }] });
 expect(financialPending.read(scope())?.completedIds).toEqual(['grant-a']);
 const task = vi.fn(); await expect(runPersistentCopilotAdminWrite('settings', 'cấp hạn mức', task)).rejects.toMatchObject({ outcome: 'partial', completed: [{ id: 'grant-a' }] }); expect(task).not.toHaveBeenCalled();
});
it('known PIN rule trả nguyên error cho exact field owner và cho sửa lại', async () => {
 const error = new Error('pin_invalid'); await expect(runPersistentCopilotAdminWrite('settings', 'lưu PIN', async () => { throw error; })).rejects.toBe(error); expect(financialPending.read(scope())).toBeNull();
 await expect(runPersistentCopilotAdminWrite('settings', 'lưu PIN', async () => ({ updatedAt: '2026-09-30T00:00:00Z' }))).resolves.toBeTruthy(); expect(financialPending.read(scope())).toBeNull();
});
it('generic transport error là unknown, không leak diagnostic và không retry', async () => {
 const task = vi.fn(async () => { throw new Error('private SQL_INTERNAL'); });
 const error = await runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task).catch(e => e); expect(copilotAdminOutcomeUnknown(error)).toBe(true); expect(error.message).not.toContain('SQL_INTERNAL');
 await expect(runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task)).rejects.toMatchObject({ outcome: 'unknown' }); expect(task).toHaveBeenCalledOnce();
});
it('scope actor khác có thể ghi, marker actor cũ vẫn chặn khi quay lại', async () => {
 const task = vi.fn(async () => { if (m.userId === 'admin-a') throw new CopilotAdminUnknownError(); return true; });
 await expect(runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task)).rejects.toMatchObject({ outcome: 'unknown' }); m.userId = 'admin-b'; await expect(runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task)).resolves.toBe(true);
 m.userId = 'admin-a'; await expect(runPersistentCopilotAdminWrite('settings', 'lưu cài đặt', task)).rejects.toMatchObject({ outcome: 'unknown' }); expect(task).toHaveBeenCalledTimes(2);
});
