import { beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import { chuanHoaChinhSach, docChinhSachHanhDong, docSoHanhDong, doiChinhSachHanhDong, dienGiaiLoiChinhSach } from '../hanhDongCopilot';
beforeEach(() => rpc.mockReset());
it.each([null, {}, [{ id: 'ok', event: 'policy_changed' }, { id: 'bad' }]])('ledger malformed không giả empty/partial: %j', async data => {
 rpc.mockResolvedValue({ data, error: null }); await expect(docSoHanhDong('org-a')).rejects.toBeInstanceOf(TypeError);
});
it.each([null, {}, { revision: 1, max_direct_risk: 'L3', allowed_roles: ['superadmin'] }])('required policy malformed phải query error: %j', async data => {
 rpc.mockResolvedValue({ data, error: null }); await expect(docChinhSachHanhDong()).rejects.toBeInstanceOf(TypeError);
});
it.each([{ revision: '1', max_direct_risk: 'L3', allowed_roles: ['superadmin'], standing_grants_enabled: false }, { revision: 1, max_direct_risk: 'L3', allowed_roles: ['superadmin', 2], standing_grants_enabled: false }])('policy không ép số/lọc bỏ vai sai: %j', data => expect(chuanHoaChinhSach(data)).toBeNull());
it('policy RPC preserving SQLSTATE vẫn map business stale revision', async () => {
 const error = { code: '40001', message: 'copilot_policy_stale_revision: private details' }; rpc.mockResolvedValue({ data: null, error });
 await expect(doiChinhSachHanhDong({ expectedRevision: 1, reason: 'Thay đổi có đối chiếu', evidenceLink: 'ticket-a' })).rejects.toBe(error); expect(dienGiaiLoiChinhSach(error)).toMatch(/vừa đổi/); expect(dienGiaiLoiChinhSach(error)).not.toMatch(/private/);
});
it('unknown policy message không hiện raw diagnostic', () => expect(dienGiaiLoiChinhSach(new Error('PRIVATE_SQL_INTERNAL'))).not.toContain('PRIVATE_SQL_INTERNAL'));
