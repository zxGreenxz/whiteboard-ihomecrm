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
  requireFixture(Object.prototype.hasOwnProperty.call(INCOME_APPROVAL_CASES,caseId));
  if (caseId === 'C36') return {rpc:'copilot_pending_requests_v1',args:{p_organization_id:DEMO_ORG,p_limit:20}};
  return {rpc:'copilot_income_expense_search_v1',args:{p_organization_id:DEMO_ORG,p_query:null,
    p_tu:caseId === 'C35' ? '2099-01-01' : '2026-07-01',p_den:caseId === 'C35' ? '2099-01-31' : '2026-07-31',
    p_loai:caseId === 'C35' ? 'EXPENSE' : null,p_trang_thai:null,p_limit:20}};
}
export function dailyCashbookRequest() {
  return {rpc:'copilot_report_daily_cashbook_v1',args:{p_organization_id:DEMO_ORG,p_tu:'2026-07-01',p_den:'2026-07-31',p_building_id:null,p_limit:20}};
}
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k=>Object.prototype.hasOwnProperty.call(value,k));
export function validDailyCashbookBinding(value) {
  const expected=dailyCashbookRequest(), p=value?.payload, th=p?.tong_hop;
  const nonnegative=n=>typeof n==='number' && Number.isFinite(n) && n>=0;
  const integer=n=>nonnegative(n) && Number.isInteger(n);
  if(!exactKeys(value,['request','payload']) || !exactKeys(value.request,['rpc','args'])
    || value.request.rpc!==expected.rpc || !sameArgs(value.request.args,expected.args)
    || !exactKeys(p,['gioi_han','so_luong','tu','den','tong_hop','theo_ngay'])
    || p.gioi_han!==20 || p.tu!==expected.args.p_tu || p.den!==expected.args.p_den
    || !Array.isArray(p.theo_ngay) || p.so_luong!==p.theo_ngay.length || p.so_luong>20
    || !exactKeys(th,['tong_thu','tong_chi','rong','so_ngay_co_phat_sinh','phieu_han_che_bi_loai'])
    || !nonnegative(th.tong_thu) || !nonnegative(th.tong_chi) || !Number.isFinite(th.rong)
    || th.rong!==th.tong_thu-th.tong_chi || !integer(th.so_ngay_co_phat_sinh)
    || !integer(th.phieu_han_che_bi_loai) || th.so_ngay_co_phat_sinh<p.so_luong)return false;
  return p.theo_ngay.every((r,i)=>exactKeys(r,['ngay','thu','chi','rong']) && date(r.ngay)
    && r.ngay>=p.tu && r.ngay<=p.den && (!i || p.theo_ngay[i-1].ngay>r.ngay)
    && nonnegative(r.thu) && nonnegative(r.chi) && Number.isFinite(r.rong) && r.rong===r.thu-r.chi);
}
export function bindIncomeApprovalScenario(scenario, { request, payload, actorDigest, dailyCashbook }) {
  requireFixture(Object.prototype.hasOwnProperty.call(INCOME_APPROVAL_CASES,scenario?.id) && scenario.oracle === INCOME_APPROVAL_CASES[scenario.id]);
  requireFixture(dailyCashbook === undefined || (scenario.id === 'C34' && validDailyCashbookBinding(dailyCashbook)));
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
    queryDigest:digest(expected),identityDigest:digest({organizationId:DEMO_ORG,actorDigest,identities}),responseDigest:digest(payload),...(dailyCashbook ? {dailyCashbookQueryDigest:digest(dailyCashbook.request),dailyCashbookResponseDigest:digest(dailyCashbook.payload)}:{})};
  return {prompt:scenario.prompt,request:expected,payload,...(dailyCashbook ? {dailyCashbook}:{}),actorDigest,bindingDigest:digest(attestation),attestation};
}
