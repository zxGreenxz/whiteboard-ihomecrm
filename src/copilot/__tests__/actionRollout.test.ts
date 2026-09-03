// Kill switch phạm vi ACTION và bộ lọc `superAdminOnly` — hai luật lọc mới của
// G2-B, đo trên chính hai adapter mà chat và UI-control dùng.
//
// VÌ SAO ĐÁNG MỘT FILE RIÊNG
//   Trước G2-B tool ghi mang `rolloutExempt: true`: nó SỐNG bất kể mọi cờ, và
//   không có bài đo nào nói được điều đó vì "miễn trừ" chính là hành vi mong
//   đợi lúc ấy. Nay nó đi theo `action:income_expense.create_draft`, và thứ cần
//   canh là cả hai chiều: cờ tắt thì tool KHÔNG có trong danh sách gửi cho mô
//   hình, cờ bật thì có. Chỉ đo một chiều là để lọt đúng lỗi tệ nhất — một kill
//   switch bấm mà không tắt gì.
import { describe, expect, it } from 'vitest';

import {
  buildRegistryDefinitions,
  toLlmTools,
  toPageAgentTools,
  type DomainTool,
  type ToolCtx,
} from '../tools/registry';
import { khoaRolloutHanhDong } from '../plan/actionCatalog';
import {
  KHOA_HANH_DONG_TAO_PHIEU,
  LOI_HANH_DONG_DA_TAT,
  hanhDongTaoPhieuDaTat,
} from '../XacNhanPhieuCard';
import type { CopilotAvailabilitySnapshot, CopilotFlagState } from '../featureFlags';
import type { PermissionsMap } from '@/lib/permissions';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const KHOA_IE = khoaRolloutHanhDong('income_expense.create_draft');

function snapshot(trangThaiHanhDong: CopilotFlagState): CopilotAvailabilitySnapshot {
  return {
    revision: 21,
    fetchedAt: Date.now(),
    organizationId: ORG,
    states: {
      'page:rooms.list': 'enabled',
      [KHOA_IE]: trangThaiHanhDong,
    },
  };
}

function ctxVoi(
  availability: CopilotAvailabilitySnapshot,
  isSuperAdmin = false,
): ToolCtx {
  return { perms: SUPER, organizationId: ORG, availability, threadId: null, generation: 0, isSuperAdmin };
}

describe('kill switch phạm vi action cho tool ghi', () => {
  it('cờ `disabled` ⇒ tao_phieu_thu_chi_nhap biến mất khỏi danh sách gửi mô hình', () => {
    const tools = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('disabled')));
    expect(tools.tao_phieu_thu_chi_nhap).toBeUndefined();
    // Tool đọc gác bằng khoá TRANG vẫn còn: kill switch của một hành động không
    // được kéo theo thứ không liên quan.
    expect(tools.phong_trong).toBeDefined();
  });

  it('cờ `enabled` ⇒ tool có mặt trở lại', () => {
    const tools = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('enabled')));
    expect(tools.tao_phieu_thu_chi_nhap).toBeDefined();
  });

  it('cờ `shadow` KHÔNG đủ để chạy — chỉ `enabled` mới mở đường ghi', () => {
    const tools = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('shadow')));
    expect(tools.tao_phieu_thu_chi_nhap).toBeUndefined();
  });

  it('khoá vắng hẳn trong snapshot ⇒ tắt, không phải "không rõ nên cho qua"', () => {
    const thieuKhoa: CopilotAvailabilitySnapshot = {
      revision: 22,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' },
    };
    expect(toLlmTools(buildRegistryDefinitions(), ctxVoi(thieuKhoa)).tao_phieu_thu_chi_nhap)
      .toBeUndefined();
  });

  it('tool ghi khai đúng khoá `action:`, không còn miễn trừ rollout', () => {
    const ghi = buildRegistryDefinitions().find((t) => t.name === 'tao_phieu_thu_chi_nhap');
    expect(ghi).toBeDefined();
    expect(ghi!.rolloutExempt).toBeUndefined();
    expect(ghi!.rolloutKey).toBe(KHOA_IE);
  });
});

describe('bộ lọc superAdminOnly', () => {
  const toolRieng: DomainTool<Record<string, never>> = {
    name: 'tool_chi_super_admin',
    description: 'Chỉ super admin.',
    inputSchema: undefined as never,
    superAdminOnly: true,
    rolloutExempt: true,
    rolloutExemptionReason: 'fixture của test, không nằm trong registry thật',
    execute: async () => 'ok',
  };

  it('người thường KHÔNG thấy tool superAdminOnly ở cả hai adapter', () => {
    const ctx = ctxVoi(snapshot('enabled'), false);
    expect(toLlmTools([toolRieng], ctx).tool_chi_super_admin).toBeUndefined();
    expect(toPageAgentTools([toolRieng], ctx).tool_chi_super_admin).toBeUndefined();
  });

  it('super admin thấy tool đó', () => {
    const ctx = ctxVoi(snapshot('enabled'), true);
    expect(toLlmTools([toolRieng], ctx).tool_chi_super_admin).toBeDefined();
    expect(toPageAgentTools([toolRieng], ctx).tool_chi_super_admin).toBeDefined();
  });

  it('mất quyền super admin sau khi adapter đã dựng ⇒ execute vẫn bị chặn', async () => {
    const ctx = ctxVoi(snapshot('enabled'), true);
    const tool = toLlmTools([toolRieng], ctx).tool_chi_super_admin;
    expect(tool).toBeDefined();
    ctx.isSuperAdmin = false;
    await expect(tool!.execute({})).rejects.toThrow(/super_admin_required/);
  });
});

describe('thẻ xác nhận đọc lại cờ ngay trước khi tiêu nonce', () => {
  it('cờ tắt / shadow / vắng / snapshot hết hạn đều chặn; chỉ `enabled` mới cho bấm', () => {
    expect(hanhDongTaoPhieuDaTat(snapshot('disabled'))).toBe(true);
    expect(hanhDongTaoPhieuDaTat(snapshot('shadow'))).toBe(true);
    expect(hanhDongTaoPhieuDaTat(snapshot('enabled'))).toBe(false);
    expect(hanhDongTaoPhieuDaTat(null)).toBe(true);
    expect(
      hanhDongTaoPhieuDaTat({
        revision: 23,
        fetchedAt: Date.now(),
        organizationId: ORG,
        states: { 'page:rooms.list': 'enabled' },
      }),
    ).toBe(true);
    // Hết hạn: cờ vẫn ghi `enabled` nhưng snapshot quá 60 giây.
    expect(
      hanhDongTaoPhieuDaTat({
        revision: 24,
        fetchedAt: Date.now() - 120_000,
        organizationId: ORG,
        states: { [KHOA_IE]: 'enabled' },
      }),
    ).toBe(true);
  });

  it('khoá thẻ dùng ĐÚNG khoá rollout của tool — không phải một chuỗi thứ hai', () => {
    expect(KHOA_HANH_DONG_TAO_PHIEU).toBe(KHOA_IE);
    expect(LOI_HANH_DONG_DA_TAT).toContain('quản trị');
  });
});
