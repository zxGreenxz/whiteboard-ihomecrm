import { digest, DEMO_ORG } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { bindContractScenario, type ContractFixture } from '../../scripts/copilot-contract-fixtures.mjs';
import type { GoldenScenario } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { inspectModelStream, renderedAssistantText, type ReadonlyEvidence } from './copilotSmokeOracle';

export interface ContractRead { rpc: string; args: Record<string, unknown>; payload: unknown; ok: boolean }
const check: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
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
function assertFacts(answer: string, fixture: ContractFixture, detail: boolean) {
  const row = (fixture.searchPayload as { hop_dong: Row[] }).hop_dong[0];
  const text = normalize(answer);
  if (!row) {
    check(/không (?:tìm thấy|có).*hợp đồng|hợp đồng.*không (?:tồn tại|tìm thấy)/iu.test(text), 'Absent customer needs explicit not found');
    check(!/\/contracts\/|\]\(|\bHD[-_\d]|\b[0-9a-f]{8}-[0-9a-f-]{27}\b/iu.test(answer) && !amounts(answer).length, 'Absent answer invented contract/link/amount');
    check(!/hợp đồng\s+(?:số|mã)\s*[:#]?\s*\S+|phòng\s+[\p{L}\p{N}]*\d/iu.test(text), 'Absent answer invented contract facts');
    return;
  }
  for (const field of ['so_hop_dong','khach_hang','phong']) check(token(text, normalize(String(row[field]))), `Answer missing canonical ${field}`);
  for (const m of answer.matchAll(/\/contracts\/([^\s)\]]+)/g)) check(m[1] === row.hop_dong_id, 'Answer linked wrong contract');
  for (const m of text.matchAll(/\bHD[-_A-Z0-9]+\b/giu)) check(token(String(row.so_hop_dong),m[0]), 'Answer invented contract identifier');
  const known = detail ? (fixture.detailPayload as { hop_dong: Row }).hop_dong : row;
  for (const date of [known.ngay_bat_dau, known.ngay_ket_thuc]) {
    const [y,m,d] = String(date).split('-');
    check(token(text,date) || token(text,`${d}/${m}/${y}`) || token(text,`${Number(d)}/${Number(m)}/${y}`), 'Answer term differs from canonical dates');
  }
  const required = [Number(known.tien_thue), Number(known.tien_coc)];
  check(amounts(text).includes(required[0]) && amounts(text).includes(required[1]), 'Answer rent/deposit missing');
  for (const [label, value] of [['thuê', known.tien_thue], ['cọc', known.tien_coc]] as const) {
    const slices = [...text.matchAll(new RegExp(`${label}[^;\\n]{0,100}`, 'giu'))].map(m => m[0]);
    check(slices.some(s => label === 'thuê' ? amounts(s)[0] === Number(value) : amounts(s).slice(0,2).includes(Number(value))), 'Answer money assigned to wrong fact');
  }
  if (detail) {
    required.push(Number(known.coc_da_thu));
    if (Number(known.coc_con_thieu) > 0) required.push(Number(known.coc_con_thieu));
    const invoices = (fixture.detailPayload as { hoa_don: Row[] }).hoa_don;
    if (!invoices.length) check(/(?:chưa|không) có ho[áa] đơn|0 ho[áa] đơn/iu.test(text), 'Answer missing empty invoice state');
    for (const i of invoices) {
      check(token(text, i.so_hoa_don ?? String(i.hoa_don_id).slice(0,8)), 'Answer missing invoice identity');
      if (i.ky) check(token(text,i.ky), 'Answer missing invoice period');
      required.push(Number(i.tong_tien),Number(i.da_tra),Number(i.con_lai));
    }
  }
  const actual = amounts(text);
  check(required.every(n => actual.includes(n)) && actual.every(n => required.includes(n)), 'Answer money differs from canonical payload');
}
export function assertContractResult(e: Pick<ReadonlyEvidence,'prompt'|'answer'|'rounds'> & { scenario: GoldenScenario; fixture: ContractFixture; reads: ContractRead[] }): void {
  const rebound = bindContractScenario(e.scenario, e.fixture);
  check(same(rebound.attestation,e.fixture.attestation) && e.prompt === rebound.prompt, 'Contract fixture/prompt drift');
  const detail = e.scenario.id === 'C33';
  const streams = e.rounds.map(r => inspectModelStream(r.body));
  check(streams.length >= (detail ? 3 : 2), 'Missing complete contract model cycle');
  const last = streams.at(-1)!;
  check(last.finish === 'stop' && last.text.trim() && e.answer.trim() === renderedAssistantText(last.text), 'Mounted answer differs from final stream');
  check(e.rounds[0].messages.some(m => m.role === 'user' && m.content === e.prompt), 'Submitted prompt not in model request');
  const calls = streams.flatMap((s, round) => s.tools.map(t => ({ ...t, round })));
  check(calls.length === (detail ? 2 : 1), 'Unexpected contract tool calls');
  const names = detail ? ['tim_hop_dong','chi_tiet_hop_dong'] : ['tim_hop_dong'];
  check(e.reads.length === names.length, 'Unexpected contract RPC count');
  for (const [index,name] of names.entries()) {
    const call = calls[index]; const rpc = e.reads[index];
    check(call.name === name && call.id && (index === 0 || call.round > calls[0].round), 'Wrong contract identity chain');
    const args = JSON.parse(call.arguments);
    check(index === 0 ? args.tu_khoa?.trim() === e.fixture.query && args.trang_thai === undefined && (args.so_luong === undefined || args.so_luong === 20) : args.hop_dong_id === e.fixture.contractId, 'Wrong contract tool query/identity');
    const expectedArgs = index === 0 ? { p_organization_id: DEMO_ORG, p_query: e.fixture.query, p_status: null, p_limit: 20 } : { p_organization_id: DEMO_ORG, p_contract_id: e.fixture.contractId };
    check(rpc.ok && rpc.rpc === (index === 0 ? 'copilot_contract_search_v1' : 'copilot_contract_detail_v1') && same(rpc.args, expectedArgs), 'Wrong contract RPC org/query/identity');
    check(same(rpc.payload,index === 0 ? e.fixture.searchPayload : e.fixture.detailPayload), 'Canonical contract RPC drift');
    const expectedText = contractToolText(e.fixture,index === 1);
    const messages = e.rounds.slice(call.round + 1).flatMap(r => r.messages).filter(m => m.role === 'tool' && m.tool_call_id === call.id);
    check(messages.length > 0 && messages.every(m => typeof m.content === 'string' && m.content.trim() === expectedText.trim()), 'Missing or wrong linked contract tool result');
    if (detail && index === 0) check(e.rounds[calls[1].round].messages.some(m => m.role === 'tool' && m.tool_call_id === call.id && m.content === expectedText), 'Detail did not consume search identity');
  }
  assertFacts(e.answer, e.fixture, detail);
  if (e.scenario.id === 'C32') check(!/\]\(|\/contracts\//.test(last.text), 'Absent answer invented link');
  for (const m of last.text.matchAll(/\/contracts\/([^\s)\]]+)/g)) check(m[1] === e.fixture.contractId, 'Answer linked wrong contract');
}
