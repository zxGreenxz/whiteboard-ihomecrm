import { digest, DEMO_ORG } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { bindContractScenario, type ContractFixture } from '../../scripts/copilot-contract-fixtures.mjs';
import type { GoldenScenario } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { inspectModelStream, renderedAssistantText, type ReadonlyEvidence } from './copilotSmokeOracle';

export interface ContractRead { rpc: string; args: Record<string, unknown>; payload: unknown; ok: boolean }
const CONTRACT_ORACLE_MESSAGES = {
  contract_status_mismatch: "Contract lifecycle status contradicts canonical payload",
  invoice_status_mismatch: "Invoice payment status contradicts canonical payload",
  money_fact_mismatch: "Answer money assigned to wrong fact",
  absent_customer_needs_explicit_not_found: "Absent customer needs explicit not found",
  absent_answer_invented_contract_link_amount: "Absent answer invented contract/link/amount",
  absent_answer_invented_monetary_fact: "Absent answer invented monetary fact",
  absent_answer_invented_contract_facts: "Absent answer invented contract facts",
  answer_missing_canonical_identity: "Answer missing canonical identity",
  answer_linked_wrong_contract: "Answer linked wrong contract",
  answer_invented_contract_identifier: "Answer invented contract identifier",
  answer_term_differs_from_canonical_dates: "Answer term differs from canonical dates",
  answer_rent_deposit_missing: "Answer rent/deposit missing",
  answer_deposit_ratio_money_differs: "Answer deposit ratio money differs",
  answer_missing_empty_invoice_state: "Answer missing empty invoice state",
  answer_missing_invoice_identity_money: "Answer missing invoice identity/money",
  answer_invoice_period_differs: "Answer invoice period differs",
  answer_money_differs_from_canonical_payload: "Answer money differs from canonical payload",
  contract_fixture_prompt_drift: "Contract fixture/prompt drift",
  missing_complete_contract_model_cycle: "Missing complete contract model cycle",
  mounted_answer_differs_from_final_stream: "Mounted answer differs from final stream",
  submitted_prompt_not_in_model_request: "Submitted prompt not in model request",
  unexpected_contract_tool_calls: "Unexpected contract tool calls",
  unexpected_contract_rpc_count: "Unexpected contract RPC count",
  wrong_contract_identity_chain: "Wrong contract identity chain",
  wrong_contract_tool_query_identity: "Wrong contract tool query/identity",
  wrong_contract_rpc_org_query_identity: "Wrong contract RPC org/query/identity",
  canonical_contract_rpc_drift: "Canonical contract RPC drift",
  missing_or_wrong_linked_contract_tool_result: "Missing or wrong linked contract tool result",
  detail_did_not_consume_search_identity: "Detail did not consume search identity",
  absent_answer_invented_link: "Absent answer invented link",
} as const;
export type ContractOracleFailureCode = keyof typeof CONTRACT_ORACLE_MESSAGES;
const oracleFailures = new WeakSet<ContractOracleFailure>();
/** Only the oracle's static codes may cross into live diagnostics. */
export class ContractOracleFailure extends Error {
  readonly code: ContractOracleFailureCode;
  constructor(code: ContractOracleFailureCode) {
    if (typeof code !== 'string' || !Object.hasOwn(CONTRACT_ORACLE_MESSAGES, code)) throw new TypeError('Invalid contract oracle failure code');
    super(CONTRACT_ORACLE_MESSAGES[code]);
    this.name = 'ContractOracleFailure'; this.code = code;
    oracleFailures.add(this); Object.freeze(this);
  }
}
export function contractOracleDiagnostic(caseId: string, error: unknown): { caseId: string; code: ContractOracleFailureCode } | undefined {
  if (!['C31','C32','C33'].includes(caseId) || !(error instanceof ContractOracleFailure) || !oracleFailures.has(error)) return;
  return { caseId, code: error.code };
}
const check: (ok: unknown, code: ContractOracleFailureCode) => asserts ok = (ok, code) => { if (!ok) throw new ContractOracleFailure(code); };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
type Row = Record<string, string | number | null>;
const money = (value: unknown) => `${new Intl.NumberFormat('vi-VN').format(Number(value) || 0)} đ`;
const status = (value: unknown) => ({ DRAFT: 'nháp', ACTIVE: 'đang thuê', EXTENDED: 'đã gia hạn', TRANSFERRED: 'đã chuyển nhượng', TERMINATED: 'đã thanh lý', EXPIRED: 'hết hạn' })[String(value)] ?? String(value);
const normalize = (s: string) => s.normalize('NFC').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const token = (text: string, value: unknown) => {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_/-])${escaped}(?![\\p{L}\\p{N}_/-])`, 'iu').test(text);
};
/** Independent canonical tool rendering oracle, checked against live RPC bytes.
 * It is deliberately local to these three contracts, not a production mapper. */
export function contractToolText(fixture: ContractFixture, detail = false): string {
  const search = fixture.searchPayload as { hop_dong: Row[]; gioi_han: number };
  if (!search.hop_dong.length) return `Không tìm thấy hợp đồng nào khớp "${fixture.query}".`;
  const r = search.hop_dong[0];
  if (!detail) return `1 hợp đồng (tối đa ${search.gioi_han} dòng mỗi lần hỏi):\n- ${r.so_hop_dong} — ${r.khach_hang} — phòng ${r.phong}${r.toa_nha ? ` (${r.toa_nha})` : ''} — ${r.ngay_bat_dau} → ${r.ngay_ket_thuc} — ${status(r.trang_thai)} — thuê ${money(r.tien_thue)}, cọc ${money(r.tien_coc)} [link: /contracts/${r.hop_dong_id}]`;
  const payload = fixture.detailPayload as { hop_dong: Row; hoa_don: Row[] };
  const hd = payload.hop_dong;
  return [
    `Hợp đồng ${hd.so_hop_dong} — ${status(hd.trang_thai)}`,
    `- Khách đại diện: ${hd.khach_hang}${hd.so_nguoi_o ? ` (${hd.so_nguoi_o} người trên HĐ)` : ''}`,
    `- Phòng: ${hd.phong}${hd.toa_nha ? ` (${hd.toa_nha})` : ''}`,
    `- Kỳ hạn: ${hd.ngay_bat_dau} → ${hd.ngay_ket_thuc}${hd.ngay_ket_thuc_thuc_te ? ` (kết thúc thực tế ${hd.ngay_ket_thuc_thuc_te})` : ''}`,
    `- Tiền thuê: ${money(hd.tien_thue)}${hd.chu_ky_thanh_toan ? ` / chu kỳ ${hd.chu_ky_thanh_toan}` : ''}`,
    `- Cọc: đang giữ ${money(hd.coc_da_thu)}/${money(hd.tien_coc)}${Number(hd.coc_con_thieu) > 0 ? `, còn thiếu ${money(hd.coc_con_thieu)}` : ''}`,
    `[link: /contracts/${hd.hop_dong_id}]`,
    payload.hoa_don.length ? `\n${payload.hoa_don.length} hoá đơn gần nhất:\n${payload.hoa_don.map(i => `- ${i.so_hoa_don ?? String(i.hoa_don_id).slice(0,8)} — kỳ ${i.ky ?? '?'} — tổng ${money(i.tong_tien)}, đã trả ${money(i.da_tra)}, còn ${money(i.con_lai)} — ${i.trang_thai ?? '?'}`).join('\n')}` : '\nHợp đồng này chưa có hoá đơn nào.',
  ].join('\n');
}
function amounts(text: string): number[] {
  return [...text.matchAll(/(?<![\p{L}\p{N}])([0-9]+(?:[.,][0-9]+)*)\s*(triệu|tr|nghìn|ngàn|k|đồng|vnd|vnđ|₫|đ)(?!\p{L})/giu)].map(m => {
    const unit = m[2].toLowerCase();
    return /triệu|^tr$|nghìn|ngàn|^k$/.test(unit) ? Number(m[1].replace(',', '.')) * (/triệu|^tr$/.test(unit) ? 1e6 : 1e3) : Number(m[1].replace(/[.,]/g, ''));
  });
}
const MONEY_VALUE = String.raw`([0-9]+(?:[.,][0-9]+)*)\s*(triệu|tr|nghìn|ngàn|k|đồng|vnd|vnđ|₫|đ)(?!\p{L})(?:\s*đồng)?`;
/** A value must immediately follow its semantic label. Other fields or another
 * invoice cannot supply it. Every repeated assertion must agree, not just one. */
function assertMoneyFact(text: string, label: string, expected: unknown, optional = false) {
  const value = String.raw`[0-9]+(?:[.,][0-9]+)*(?:\s*(?:triệu|tr|nghìn|ngàn|k|đồng|vnd|vnđ|₫|đ)(?!\p{L})(?:\s*đồng)?)?`;
  const matches = [...text.matchAll(new RegExp(`(?:${label})\\s*(?:[:：|–—=-]\\s*)?${value}`, 'giu'))];
  check((optional || matches.length > 0) && matches.every(m => (amounts(m[0])[0] ?? Number(m[0].match(/[0-9]+(?:[.,][0-9]+)*/)?.[0].replace(/[.,]/g,''))) === Number(expected)), 'money_fact_mismatch');
}
function invoiceSections(text: string, invoices: Row[]) {
  const found = invoices.flatMap(invoice => {
    const code = String(invoice.so_hoa_don ?? String(invoice.hoa_don_id).slice(0,8));
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_/-])${escaped}(?![\\p{L}\\p{N}_/-])`, 'giu'))]
      .map(m => ({ invoice, start: m.index! }));
  }).sort((a,b) => a.start - b.start);
  return found.map((item,index) => {
    const next = found[index+1]?.start ?? text.length;
    const candidate = text.slice(item.start,next);
    // A later explicitly labeled contract section is not part of this invoice.
    // This keeps invoice-first answers usable without borrowing their money.
    const boundary = /(?:tiền thuê|(?:đã thu|đã nộp)(?: tiền)? cọc|(?:tiền )?cọc|đang giữ|kỳ hạn|khách đại diện|phòng:|hợp đồng\s+)/iu.exec(candidate);
    const end = boundary ? item.start + boundary.index : next;
    return { ...item, end, text: text.slice(item.start,end) };
  });
}
/** Optional status prose is checked only when explicitly asserted. Negated
 * and conditional statements must not become positive lifecycle claims. */
function assertStatusClaim(text: string, pattern: string, expected: boolean, code: 'contract_status_mismatch' | 'invoice_status_mismatch') {
  for (const match of text.matchAll(new RegExp(pattern,'giu'))) {
    const prefix = text.slice(0,match.index);
    if (code === 'contract_status_mismatch' && /(?:ngày|mốc|thời điểm)\s*$/iu.test(prefix)) continue;
    if (/(?:nếu|khi|cần|muốn|có thể|dự kiến|sẽ)\s*(?:(?:hợp đồng|hoá đơn|hóa đơn)\s*)?$/iu.test(prefix)) continue;
    const negated = /(?:không|chưa)(?:\s+(?:phải|đã|đang|được|còn|bị)){0,3}\s*$/iu.test(prefix);
    check(negated ? !expected : expected,code);
  }
}
function assertContractStatus(text: string, canonical: unknown) {
  const patterns: Record<string,string> = {
    DRAFT: '(?:bản )?nháp|\\bDRAFT\\b', ACTIVE: 'đang thuê|(?:đang|còn) hiệu lực|\\bACTIVE\\b',
    EXTENDED: '(?:đã )?gia hạn|\\bEXTENDED\\b', TRANSFERRED: '(?:đã )?chuyển nhượng|\\bTRANSFERRED\\b',
    TERMINATED: '(?:đã )?thanh lý|\\bTERMINATED\\b', EXPIRED: '(?:đã )?hết hạn|\\bEXPIRED\\b',
  };
  for (const [state,pattern] of Object.entries(patterns)) assertStatusClaim(text,pattern,state === canonical,'contract_status_mismatch');
}
function assertInvoiceStatus(text: string, invoice: Row) {
  const remaining = Number(invoice.con_lai), paid = Number(invoice.da_tra);
  const canceled = ['CANCELLED','CANCELED'].includes(String(invoice.trang_thai));
  assertStatusClaim(text,'(?:đã )?(?:thanh toán|trả|đóng) (?:đầy đủ|toàn bộ|hết|xong)|(?:đã )?tất toán|\\bPAID\\b',remaining === 0 && !canceled,'invoice_status_mismatch');
  assertStatusClaim(text,'(?:đã )?(?:thanh toán|trả|đóng) một phần|\\bPARTIAL\\b',paid > 0 && remaining > 0 && !canceled,'invoice_status_mismatch');
  assertStatusClaim(text,'còn (?:dư nợ|nợ)',remaining > 0 && !canceled,'invoice_status_mismatch');
  assertStatusClaim(text,'(?:đã )?h[ủu]ỷ|(?:đã )?hủy|\\bCANCELLED\\b|\\bCANCELED\\b',canceled,'invoice_status_mismatch');
  // "Chưa thanh toán đầy đủ" means partial, not zero paid.
  assertStatusClaim(text,'chưa (?:thanh toán|trả|đóng)(?! (?:đầy đủ|toàn bộ|hết|xong|một phần))|\\bUNPAID\\b',paid === 0 && !canceled,'invoice_status_mismatch');
}
const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})`;
function canonicalDate(value: string): string {
  if (!value.includes('/')) return value;
  const [day,month,year] = value.split('/');
  return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;
}
function assertTerm(text: string, contract: Row) {
  const patterns: [string,unknown][] = [
    ['(?:ngày )?bắt đầu',contract.ngay_bat_dau],
    ['(?:ngày )?kết thúc(?! thực tế)',contract.ngay_ket_thuc],
    ['ngày hết hạn(?: theo hợp đồng)?',contract.ngay_ket_thuc],
    ['(?:ngày )?kết thúc thực tế',contract.ngay_ket_thuc_thuc_te],
  ];
  for (const [label,expected] of patterns) {
    for (const match of text.matchAll(new RegExp(`${label}\\s*[:：]?\\s*(${DATE_TOKEN})`,'giu'))) {
      check(canonicalDate(match[1]) === expected,'answer_term_differs_from_canonical_dates');
    }
  }
  for (const match of text.matchAll(new RegExp(`(?:kỳ hạn\\s*[:：]?\\s*(?:từ\\s*)?|từ\\s+)(${DATE_TOKEN})\\s*(?:đến|tới|→|–|—|-)\\s*(${DATE_TOKEN})`,'giu'))) {
    check(canonicalDate(match[1]) === contract.ngay_bat_dau && canonicalDate(match[2]) === contract.ngay_ket_thuc,'answer_term_differs_from_canonical_dates');
  }
}
function assertFacts(answer: string, fixture: ContractFixture, detail: boolean) {
  const row = (fixture.searchPayload as { hop_dong: Row[] }).hop_dong[0];
  const text = normalize(answer);
  if (!row) {
    check(/không (?:tìm thấy|có).*hợp đồng|hợp đồng.*không (?:tồn tại|tìm thấy)/iu.test(text), 'absent_customer_needs_explicit_not_found');
    check(!/\/contracts\/|\]\(|\bHD[-_\d]|\b[0-9a-f]{8}-[0-9a-f-]{27}\b/iu.test(answer) && !amounts(answer).length, 'absent_answer_invented_contract_link_amount');
    check(!/(?:tiền\s*)?(?:thuê|cọc|tổng(?: tiền)?|đã trả|còn thiếu|còn lại)\s*[:：]?\s*\d/iu.test(text), 'absent_answer_invented_monetary_fact');
    check(!/hợp đồng\s+(?:số|mã)\s*[:#]?\s*\S+|phòng\s+[\p{L}\p{N}]*\d/iu.test(text), 'absent_answer_invented_contract_facts');
    return;
  }
  for (const field of ['so_hop_dong','khach_hang','phong']) check(token(text, normalize(String(row[field]))), 'answer_missing_canonical_identity');
  for (const m of answer.matchAll(/\/contracts\/([^\s)\]]+)/g)) check(m[1] === row.hop_dong_id, 'answer_linked_wrong_contract');
  for (const m of text.matchAll(/\bHD[-_A-Z0-9]+\b/giu)) check(token(String(row.so_hop_dong),m[0]), 'answer_invented_contract_identifier');
  const known = detail ? (fixture.detailPayload as { hop_dong: Row }).hop_dong : row;
  for (const date of [known.ngay_bat_dau, known.ngay_ket_thuc]) {
    const [y,m,d] = String(date).split('-');
    check(token(text,date) || token(text,`${d}/${m}/${y}`) || token(text,`${Number(d)}/${Number(m)}/${y}`), 'answer_term_differs_from_canonical_dates');
  }
  const required = [Number(known.tien_thue), Number(known.tien_coc)];
  check(amounts(text).includes(required[0]) && amounts(text).includes(required[1]), 'answer_rent_deposit_missing');
  const invoices = detail ? (fixture.detailPayload as { hoa_don: Row[] }).hoa_don : [];
  const sections = invoiceSections(text,invoices);
  let contractText = text;
  for (const section of [...sections].reverse()) contractText = contractText.slice(0,section.start) + ' ' + contractText.slice(section.end);
  assertContractStatus(contractText,known.trang_thai);
  assertTerm(contractText,known);
  assertMoneyFact(contractText, '(?:tiền\\s*)?thuê', known.tien_thue);
  // A nominal deposit can be stated directly or as held/nominal in the
  // product's ordinary compact deposit notation.
  const depositRatio = [...contractText.matchAll(new RegExp(`cọc[^;]{0,30}?(?:đang giữ|đã thu)\\s*${MONEY_VALUE}\\s*/\\s*${MONEY_VALUE}`, 'giu'))];
  if (depositRatio.length) check(depositRatio.every(m => same(amounts(m[0]),[Number(known.coc_da_thu),Number(known.tien_coc)])), 'answer_deposit_ratio_money_differs');
  const nominalText = contractText.replace(/(?:đang giữ|đã thu|đã nộp)\s*(?:tiền\s*)?cọc/giu, 'đã thu');
  assertMoneyFact(nominalText, '(?:tiền\\s*)?cọc(?:\\s*(?:yêu cầu|theo hợp đồng|phải đóng))?', known.tien_coc, depositRatio.length > 0);
  if (detail) {
    assertMoneyFact(contractText, '(?:đang giữ|đã thu|đã nộp)(?:\\s*(?:tiền )?cọc)?', known.coc_da_thu);
    assertMoneyFact(contractText, '(?:cọc\\s*)?còn thiếu', known.coc_con_thieu, Number(known.coc_con_thieu) === 0);
    required.push(Number(known.coc_da_thu));
    if (Number(known.coc_con_thieu) > 0) required.push(Number(known.coc_con_thieu));
    if (!invoices.length) check(/(?:chưa|không) có ho[áa] đơn|0 ho[áa] đơn/iu.test(text), 'answer_missing_empty_invoice_state');
    for (const i of invoices) {
      for (const section of sections.filter(section => section.invoice === i)) assertInvoiceStatus(section.text,i);
      const scoped = sections.filter(section => section.invoice === i && (amounts(section.text).length > 0
        || /(?:tổng(?:\s*(?:tiền|cộng|phải trả))?|đã\s*(?:trả|thanh toán|thu)|còn(?:\s*(?:lại|nợ|phải trả|phải thanh toán))?)\s*[:：|–—=-]?\s*\d/iu.test(section.text)));
      check(scoped.length > 0, 'answer_missing_invoice_identity_money');
      for (const section of scoped) {
        if (i.ky) check(token(section.text.replace(/kỳ(?=\d)/giu, 'kỳ '),i.ky), 'answer_invoice_period_differs');
        assertMoneyFact(section.text, 'tổng(?:\\s*(?:tiền|cộng|phải trả))?', i.tong_tien);
        assertMoneyFact(section.text, 'đã\\s*(?:trả|thanh toán|thu)', i.da_tra);
        assertMoneyFact(section.text, 'còn(?:\\s*(?:lại|nợ|phải trả|phải thanh toán))?', i.con_lai);
      }
      required.push(Number(i.tong_tien),Number(i.da_tra),Number(i.con_lai));
    }
  }
  const actual = amounts(text);
  check(required.every(n => actual.includes(n)) && actual.every(n => required.includes(n)), 'answer_money_differs_from_canonical_payload');
}
export function assertContractResult(e: Pick<ReadonlyEvidence,'prompt'|'answer'|'rounds'> & { scenario: GoldenScenario; fixture: ContractFixture; reads: ContractRead[] }): void {
  const rebound = bindContractScenario(e.scenario, e.fixture);
  check(same(rebound.attestation,e.fixture.attestation) && e.prompt === rebound.prompt, 'contract_fixture_prompt_drift');
  const detail = e.scenario.id === 'C33';
  const streams = e.rounds.map(r => inspectModelStream(r.body));
  check(streams.length >= (detail ? 3 : 2), 'missing_complete_contract_model_cycle');
  const last = streams.at(-1)!;
  check(last.finish === 'stop' && last.text.trim() && e.answer.trim() === renderedAssistantText(last.text), 'mounted_answer_differs_from_final_stream');
  check(e.rounds[0].messages.some(m => m.role === 'user' && m.content === e.prompt), 'submitted_prompt_not_in_model_request');
  const calls = streams.flatMap((s, round) => s.tools.map(t => ({ ...t, round })));
  check(calls.length === (detail ? 2 : 1), 'unexpected_contract_tool_calls');
  const names = detail ? ['tim_hop_dong','chi_tiet_hop_dong'] : ['tim_hop_dong'];
  check(e.reads.length === names.length, 'unexpected_contract_rpc_count');
  for (const [index,name] of names.entries()) {
    const call = calls[index]; const rpc = e.reads[index];
    check(call.name === name && call.id && (index === 0 || call.round > calls[0].round), 'wrong_contract_identity_chain');
    const args = JSON.parse(call.arguments);
    check(index === 0 ? args.tu_khoa?.trim() === e.fixture.query && args.trang_thai === undefined && (args.so_luong === undefined || args.so_luong === 20) : args.hop_dong_id === e.fixture.contractId, 'wrong_contract_tool_query_identity');
    const expectedArgs = index === 0 ? { p_organization_id: DEMO_ORG, p_query: e.fixture.query, p_status: null, p_limit: 20 } : { p_organization_id: DEMO_ORG, p_contract_id: e.fixture.contractId };
    check(rpc.ok && rpc.rpc === (index === 0 ? 'copilot_contract_search_v1' : 'copilot_contract_detail_v1') && same(rpc.args, expectedArgs), 'wrong_contract_rpc_org_query_identity');
    check(same(rpc.payload,index === 0 ? e.fixture.searchPayload : e.fixture.detailPayload), 'canonical_contract_rpc_drift');
    const expectedText = contractToolText(e.fixture,index === 1);
    const messages = e.rounds.slice(call.round + 1).flatMap(r => r.messages).filter(m => m.role === 'tool' && m.tool_call_id === call.id);
    check(messages.length > 0 && messages.every(m => typeof m.content === 'string' && m.content.trim() === expectedText.trim()), 'missing_or_wrong_linked_contract_tool_result');
    if (detail && index === 0) check(e.rounds[calls[1].round].messages.some(m => m.role === 'tool' && m.tool_call_id === call.id && m.content === expectedText), 'detail_did_not_consume_search_identity');
  }
  assertFacts(e.answer, e.fixture, detail);
  if (e.scenario.id === 'C32') check(!/\]\(|\/contracts\//.test(last.text), 'absent_answer_invented_link');
  for (const m of last.text.matchAll(/\/contracts\/([^\s)\]]+)/g)) check(m[1] === e.fixture.contractId, 'answer_linked_wrong_contract');
}
