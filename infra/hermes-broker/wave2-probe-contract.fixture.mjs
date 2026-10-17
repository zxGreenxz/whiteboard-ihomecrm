// Sổ thăm dò cho test broker đợt 2 (chỉ nạp trong tiến trình con qua wave2-probe-hooks.fixture.mjs):
// hai báo cáo khác khoá để chạy được ca forbidden và đo tools/list khi hai tool meta đã hiện.
import { w2Report, id, nullable, amount } from './wave2-kit.mjs';
export const W2A_REPORTS = Object.freeze({
  probe_rows: w2Report({ permission: 'vehicles.view', source: 'crm.probe_rows', scope: 'rows', title: 'Thăm dò theo toà',
    params: ['buildingId', 'month'], required: ['month'], fields: { buildingId: nullable(id), total: amount } }),
  probe_org: w2Report({ permission: 'materials.view', source: 'crm.probe_org', scope: 'organization', title: 'Thăm dò toàn công ty',
    params: ['query'], fields: { total: amount } }),
});
