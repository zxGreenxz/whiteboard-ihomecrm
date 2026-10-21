// Danh mục THỬ của khung thao tác ghi (D6, NEN-CHUNG-THAO-TAC-GHI.md mục 12.4): probe.note (reversible, ghi thẳng theo
// chính sách) và probe.confirm (money giả: sàn xác nhận luôn áp). Khoá assistant.action_probe chỉ bật trên TEST; RPC thử
// chỉ ghi biên nhận + audit, không đụng bảng nghiệp vụ (public.hermes_action_probe_v1, 20261021133823). server.mjs chỉ nạp danh mục này
// khi cấu hình host bật actionProbe (connector TEST); production mặc định danh mục rỗng.
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

export const PROBE_KEY = 'assistant.action_probe';
export const PROBE_NOTE = defineAction({ id: 'probe.note', page: 'probe', key: PROBE_KEY, class: 'reversible', rpc: 'hermes_action_probe_v1', title: 'Ghi chú thử (không đụng dữ liệu nghiệp vụ)',
  params: { note: param.text(1, 200), buildingName: param.name('building', { optional: true }) } });
export const PROBE_CONFIRM = defineAction({ id: 'probe.confirm', page: 'probe', key: PROBE_KEY, class: 'money', rpc: 'hermes_action_probe_v1', title: 'Thao tác tiền thử (luôn xác nhận)',
  params: { amount: param.vnd({ max: 10_000_000 }), buildingName: param.name('building'), roomName: param.name('room', { optional: true }),
    date: param.date({ optional: true }), reason: param.text(8, 300, { optional: true }) }, reasons: ['state_changed', 'period_locked'] });
export const probeCatalog = (keys = [PROBE_KEY]) => createActionCatalog([PROBE_NOTE, PROBE_CONFIRM], { keys });
