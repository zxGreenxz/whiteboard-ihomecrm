import { DEMO_ORG, digest } from './copilot-golden-browser-evidence.mjs';

export const CONTRACT_CASES = { C31: 'contract-code-v1', C32: 'absent-customer-contract-v1', C33: 'contract-code-detail-v1' };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = value => typeof value === 'string' && value.trim().length > 0;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const requireFixture = ok => { if (!ok) throw new Error('fixture_unbound'); };
export function contractQuery(caseId, contextId, listingPayload) {
  requireFixture(Object.hasOwn(CONTRACT_CASES, caseId));
  if (caseId === 'C32') {
    requireFixture(typeof contextId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(contextId));
    return `GOLDEN_ABSENT_${contextId}`;
  }
  requireFixture(Array.isArray(listingPayload?.hop_dong));
  const rows = listingPayload.hop_dong;
  const candidates = rows.filter(r => text(r?.so_hop_dong) && UUID.test(r?.hop_dong_id)
    && rows.filter(other => other?.so_hop_dong === r.so_hop_dong).length === 1);
  candidates.sort((a,b) => a.so_hop_dong < b.so_hop_dong ? -1 : a.so_hop_dong > b.so_hop_dong ? 1 : 0);
  requireFixture(candidates.length > 0);
  return candidates[0].so_hop_dong;
}
export function bindContractScenario(scenario, { query, searchPayload, detailPayload, customerPayload }) {
  requireFixture(Object.hasOwn(CONTRACT_CASES, scenario?.id) && scenario.oracle === CONTRACT_CASES[scenario.id]);
  requireFixture(text(query) && query === query.trim() && Array.isArray(searchPayload?.hop_dong));
  const absent = scenario.id === 'C32', detail = scenario.id === 'C33';
  requireFixture(absent ? Array.isArray(customerPayload) && customerPayload.length === 0 : customerPayload === undefined);
  const rows = searchPayload.hop_dong;
  requireFixture(searchPayload.so_luong === rows.length && searchPayload.gioi_han === 20);
  requireFixture(absent ? /^GOLDEN_ABSENT_[a-zA-Z0-9-]{1,100}$/.test(query) && rows.length === 0 : rows.length === 1);
  const row = absent ? null : rows[0];
  if (row) {
    requireFixture(text(row.hop_dong_id) && UUID.test(row.hop_dong_id) && row.so_hop_dong === query);
    requireFixture(['khach_hang','phong'].every(k => text(row[k])));
    requireFixture(['ngay_bat_dau','ngay_ket_thuc'].every(k => validDate(row[k])));
    requireFixture(['DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED'].includes(row.trang_thai));
    requireFixture(['tien_thue','tien_coc'].every(k => typeof row[k] === 'number' && Number.isFinite(row[k]) && row[k] >= 0));
  }
  if (detail) {
    requireFixture(detailPayload?.tim_thay === true && Array.isArray(detailPayload.hoa_don));
    const hd = detailPayload.hop_dong;
    requireFixture(hd && ['hop_dong_id','so_hop_dong','khach_hang','phong','ngay_bat_dau','trang_thai','tien_thue','tien_coc'].every(k => hd[k] === row[k]));
    // Search exposes COALESCE(actual_end_date,end_date); detail exposes both
    // fields separately (hardening v2 search / original contract detail SQL).
    requireFixture(validDate(hd.ngay_ket_thuc) && (hd.ngay_ket_thuc_thuc_te == null || validDate(hd.ngay_ket_thuc_thuc_te)));
    requireFixture(row.ngay_ket_thuc === (hd.ngay_ket_thuc_thuc_te ?? hd.ngay_ket_thuc));
    requireFixture(['coc_da_thu','coc_con_thieu'].every(k => typeof hd[k] === 'number' && Number.isFinite(hd[k]) && hd[k] >= 0));
    requireFixture(detailPayload.hoa_don.every(i => text(i?.hoa_don_id) && UUID.test(i.hoa_don_id)
      && ['tong_tien','da_tra','con_lai'].every(k => typeof i[k] === 'number' && Number.isFinite(i[k]) && i[k] >= 0)));
  } else requireFixture(detailPayload === undefined);
  const placeholder = absent ? '{{absent_customer.name}}' : '{{contract.code}}';
  requireFixture(typeof scenario.prompt === 'string' && scenario.prompt.includes(placeholder));
  const prompt = scenario.prompt.replace(placeholder, query);
  requireFixture(!prompt.includes('{{'));
  const attestation = {
    kind: absent ? 'contract-absent' : detail ? 'contract-detail' : 'contract-search', organizationId: DEMO_ORG,
    queryDigest: digest(query), identityDigest: digest({ organizationId: DEMO_ORG, contractId: row?.hop_dong_id ?? null, code: row?.so_hop_dong ?? null }),
    searchDigest: digest(searchPayload), ...(absent ? { customerDigest: digest(customerPayload) } : {}), ...(detail ? { detailDigest: digest(detailPayload) } : {}),
  };
  return { prompt, query, contractId: row?.hop_dong_id, bindingDigest: digest(attestation), attestation, searchPayload, detailPayload, customerPayload };
}
