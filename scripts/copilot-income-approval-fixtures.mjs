import { DEMO_ORG, digest } from './copilot-golden-browser-evidence.mjs';

export const INCOME_APPROVAL_CASES = { C34:'vouchers-2026-07-v1', C35:'empty-expenses-2099-01-v1', C36:'pending-approval-inbox-v1' };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = value => typeof value === 'string' && value.trim().length > 0;
const optionalText = value => value === null || typeof value === 'string';
const uuid = value => text(value) && UUID.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const requireFixture = ok => { if (!ok) throw new Error('fixture_unbound'); };
const sameArgs = (actual, expected) => actual && typeof actual === 'object' && !Array.isArray(actual)
  && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([k,v]) => actual[k] === v);
export function incomeApprovalRequest(caseId) {
  requireFixture(Object.hasOwn(INCOME_APPROVAL_CASES,caseId));
  if (caseId === 'C36') return {rpc:'copilot_pending_requests_v1',args:{p_organization_id:DEMO_ORG,p_limit:20}};
  return {rpc:'copilot_income_expense_search_v1',args:{p_organization_id:DEMO_ORG,p_query:null,
    p_tu:caseId === 'C35' ? '2099-01-01' : '2026-07-01',p_den:caseId === 'C35' ? '2099-01-31' : '2026-07-31',
    p_loai:caseId === 'C35' ? 'EXPENSE' : null,p_trang_thai:null,p_limit:20}};
}
export function bindIncomeApprovalScenario(scenario, { request, payload, actorDigest }) {
  requireFixture(Object.hasOwn(INCOME_APPROVAL_CASES,scenario?.id) && scenario.oracle === INCOME_APPROVAL_CASES[scenario.id]);
  const expected = incomeApprovalRequest(scenario.id), pending = scenario.id === 'C36', empty = scenario.id === 'C35';
  requireFixture(request && Object.keys(request).length === 2 && request.rpc === expected.rpc && sameArgs(request.args,expected.args));
  requireFixture(typeof actorDigest === 'string' && /^[a-f0-9]{64}$/.test(actorDigest));
  const rows = payload?.[pending ? 'hop_cho' : 'phieu'];
  requireFixture(Array.isArray(rows) && payload.gioi_han === 20 && payload.so_luong === rows.length && rows.length <= 20);
  requireFixture(empty ? rows.length === 0 : rows.length > 0);
  for (const row of rows) {
    requireFixture(row && ['INCOME','EXPENSE'].includes(row.loai) && typeof row.so_tien === 'number' && Number.isFinite(row.so_tien) && row.so_tien >= 0);
    requireFixture(optionalText(row.ma_phieu) && (row.ma_phieu === null || text(row.ma_phieu)));
    if (pending) {
      requireFixture(uuid(row.yeu_cau_id) && (row.phieu_id === null || uuid(row.phieu_id)) && text(row.nguoi_lap));
      requireFixture(optionalText(row.ten_phieu) && (row.gui_luc === null || (text(row.gui_luc) && Number.isFinite(Date.parse(row.gui_luc)))));
      requireFixture(Number.isInteger(row.buoc) && row.buoc > 0 && Number.isInteger(row.lan_gui) && row.lan_gui > 0);
    } else {
      requireFixture(uuid(row.phieu_id) && date(row.ngay) && row.ngay >= expected.args.p_tu && row.ngay <= expected.args.p_den);
      requireFixture(['ten','hang_muc','so_quy','nguoi_tao','toa_nha'].every(k => optionalText(row[k])));
      requireFixture(['UNAPPROVED','APPROVED','CANCELLED'].includes(row.trang_thai));
      requireFixture(['UNPOSTED','POSTED','REVERSED','NOT_APPLICABLE'].includes(row.trang_thai_ghi_nhan));
    }
  }
  const identities = rows.map(r => ({id:pending ? r.yeu_cau_id : r.phieu_id,voucherId:r.phieu_id,
    code:r.ma_phieu ?? (r.phieu_id ?? r.yeu_cau_id).slice(0,8)}));
  requireFixture(new Set(identities.map(r=>r.id)).size === rows.length && new Set(identities.map(r=>r.code.toLowerCase())).size === rows.length);
  requireFixture(text(scenario.prompt) && !scenario.prompt.includes('{{'));
  const attestation = {kind:pending ? 'pending-inbox' : empty ? 'voucher-empty' : 'voucher-search',organizationId:DEMO_ORG,actorDigest,
    queryDigest:digest(expected),identityDigest:digest({organizationId:DEMO_ORG,actorDigest,identities}),responseDigest:digest(payload)};
  return {prompt:scenario.prompt,request:expected,payload,actorDigest,bindingDigest:digest(attestation),attestation};
}
