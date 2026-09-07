import { describe, expect, it, vi } from 'vitest';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import GoldenReporter from '../../../.e2e-fleet/goldenReporter';
import { assertIncomeApprovalResult, dailyCashbookToolText, IncomeApprovalOracleFailure, incomeApprovalOracleDiagnostic, incomeApprovalFixtureFailureReason, isIncomeApprovalOracleFailureCode, isIncomeApprovalReadonlyRequest } from '../../../.e2e-fleet/specs/copilotIncomeApprovalOracle';
import { bindIncomeApprovalScenario, incomeApprovalRequest } from '../../../scripts/copilot-income-approval-fixtures.mjs';
import { inspectModelStream, assertReadonlyResult, unexpectedReadonlyMutation, renderedAssistantText } from '../../../.e2e-fleet/specs/copilotSmokeOracle';
const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
const answer = chunk({ content: 'Có 1 phòng trống ngay: A101.' }, 'stop') + 'data: [DONE]\n\n';
const call = chunk({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'phong_', arguments: '' } }] }, null) +
  chunk({ tool_calls: [{ index: 0, function: { name: 'trong', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n';
const payload = { buildings: [{ id: 'b1' }], rooms: [{ id: 'r1', building_id: 'b1', code: 'A101', name: '101', status_public: 'free' }] };
interface FixtureMessage { role: string; content: string; tool_call_id?: string }
const evidence = () => ({ prompt: 'Liệt kê phòng', answer: 'Có 1 phòng trống ngay: A101.',
  rounds: [{ body: call, messages: [{ role: 'user', content: 'Liệt kê phòng' }] },
    { body: answer, messages: [{ role: 'user', content: 'Liệt kê phòng' }, { role: 'tool', tool_call_id: 'call-1', content: 'Tổng 1 phòng trống ngay.\n\nDEMO Toà A (Địa chỉ):\n  Trống ngay (1):\n  - A101: 3 triệu/tháng, 20m², tầng 1' }] }], payload: structuredClone(payload) });

const ieVoucher = {phieu_id:'aaaa4000-0000-4000-8000-000000000021',ma_phieu:'PC001',loai:'EXPENSE',ten:'Sửa chữa',so_tien:11000,ngay:'2026-07-12',hang_muc:'Sửa nhà',so_quy:'TK 1234567890123',trang_thai:'UNAPPROVED',trang_thai_ghi_nhan:'UNPOSTED',nguoi_tao:'Demo An',toa_nha:'DEMO Toà A'};
const ieIncome = {...ieVoucher,phieu_id:'aaaa4000-0000-4000-8000-000000000023',ma_phieu:'PT002',loai:'INCOME',ten:'Thu khác',so_tien:1000,trang_thai:'CANCELLED',nguoi_tao:'Demo Bình'};
it('binds an introductory voucher type to the sole pending row',()=>{
  const e=incomeEvidence('C36');
  const text=e.answer.replace('Có 1 phiếu đang chờ bạn duyệt:','Có 1 phiếu chi đang chờ bạn duyệt:').replace('PC001 — phiếu chi,','PC001 —');
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,text))).not.toThrow();
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,text.replace('1 phiếu chi','1 phiếu thu')))).toThrow();
});
it('does not use a global introductory type for multiple voucher rows',()=>{
  const e=incomeEvidence();
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,'Phiếu chi: '+e.answer.replace('PC001 — phiếu chi,','PC001 —')))).toThrow();
});
it('accepts pending inbox wording chờ xử lý tied to the actual pending RPC',()=>{
  const e=incomeEvidence('C36');
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('đang chờ bạn duyệt','đang chờ xử lý')))).not.toThrow();
});
it.each(['không còn chờ xử lý','không chờ xử lý','đã xử lý','nếu chờ xử lý','chờ xử lý nhưng đã duyệt'])('rejects non-pending inbox assertion %s',phrase=>{
  const e=incomeEvidence('C36');
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('đang chờ bạn duyệt',phrase)))).toThrow();
});
it('rejects a repeated denial of pending processing after a correct inbox statement',()=>{
  const e=incomeEvidence('C36');
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' Phiếu PC001 không còn chờ xử lý.'))).toThrow();
});
it('rejects repeated completed processing after a correct pending inbox statement',()=>{
  const e=incomeEvidence('C36');
  expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' Phiếu PC001 đã xử lý.'))).toThrow();
});
it('allows negated and conditional completed processing after a correct pending inbox statement',()=>{
  const e=incomeEvidence('C36');
  for(const statement of ['Phiếu PC001 chưa được xử lý.','Nếu đã xử lý thì cần kiểm tra lại.'])
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' '+statement))).not.toThrow();
});
function incomeEvidence(id='C34') {
  const scenario={id,fixture:'readonly',kind:'read',acceptance:['facts'],oracle:id==='C34'?'vouchers-2026-07-v1':id==='C35'?'empty-expenses-2099-01-v1':'pending-approval-inbox-v1',prompt:id==='C34'?'Phiếu thu chi tháng 07/2026':id==='C35'?'Phiếu chi kỳ 2099-01':'Có gì đang chờ tôi duyệt không?'};
  const request=incomeApprovalRequest(id), actorDigest='b'.repeat(64);
  const data=id==='C36'?{gioi_han:20,so_luong:1,hop_cho:[{yeu_cau_id:'aaaa4000-0000-4000-8000-000000000024',lan_gui:1,gui_luc:'2026-09-07T00:00:00+00:00',so_tien:11000,phieu_id:ieVoucher.phieu_id,ma_phieu:'PC001',ten_phieu:'Sửa chữa',loai:'EXPENSE',nguoi_lap:' Demo An ',buoc:1}]}:{gioi_han:20,so_luong:id==='C35'?0:2,phieu:id==='C35'?[]:[ieVoucher,ieIncome]};
  const fixture=bindIncomeApprovalScenario(scenario,{request,payload:data,actorDigest});
  const toolArgs=id==='C36'?{}:{tu_ngay:id==='C35'?'2099-01-01':'2026-07-01',den_ngay:id==='C35'?'2099-01-31':'2026-07-31',...(id==='C35'?{loai:'chi'}:{})};
  const toolText=id==='C35'?'Không tìm thấy phiếu thu chi nào khớp điều kiện.\n[link: /income-expense]':id==='C36'?'1 phiếu đang chờ bạn duyệt (tối đa 20 dòng):\n- [CHI] PC001 — Sửa chữa — 11.000 đ — gửi 2026-09-07 — lập bởi  Demo An \n[link: /approvals]':'2 phiếu thu chi (tối đa 20 dòng mỗi lần hỏi):\n- [CHI] PC001 — Sửa chữa — 11.000 đ — 2026-07-12 — Sửa nhà — sổ TK [STK đã ẩn] — chờ duyệt, chưa vào sổ — lập bởi Demo An\n- [THU] PT002 — Thu khác — 1.000 đ — 2026-07-12 — Sửa nhà — sổ TK [STK đã ẩn] — đã huỷ, chưa vào sổ — lập bởi Demo Bình\n[link: /income-expense]';
  const text=id==='C35'?'Không tìm thấy phiếu chi nào trong tháng 01/2099.':id==='C36'?'Có 1 phiếu đang chờ bạn duyệt: PC001 — phiếu chi, số tiền 11.000 đồng, lập bởi Demo An. Bạn có thể xem tại trang phê duyệt.':'Có 2 phiếu tháng 07/2026:\nPC001 — phiếu chi, 11.000 đồng, chờ duyệt, chưa vào sổ.\nPT002 — phiếu thu, 1.000 đồng, đã huỷ, chưa vào sổ.';
  const messages: FixtureMessage[]=[{role:'user',content:scenario.prompt}];
  const rounds=[{body:chunk({tool_calls:[{index:0,id:'ie-read-1',function:{name:id==='C36'?'hop_cho_duyet':'tim_phieu_thu_chi',arguments:JSON.stringify(toolArgs)}}]},'tool_calls')+'data: [DONE]\n\n',messages},
    {body:chunk({content:text},'stop')+'data: [DONE]\n\n',messages:[...messages,{role:'tool',tool_call_id:'ie-read-1',content:toolText}]}];
  return {scenario,fixture,prompt:scenario.prompt,answer:text,rounds,actorDigest,reads:[{rpc:request.rpc as string,args:{...request.args} as Record<string,unknown>,payload:structuredClone(data) as unknown,ok:true,exactEndpoint:true,actorDigest}]};
}
function changeIncomeAnswer(e:ReturnType<typeof incomeEvidence>,text:string) {
  e.answer=text;e.rounds.at(-1)!.body=chunk({content:text},'stop')+'data: [DONE]\n\n';return e;
}
describe('income approval golden actual facts',()=>{
  it.each(['C34','C35','C36'])('accepts %s exact actor/RPC/tool/answer chain',id=>expect(()=>assertIncomeApprovalResult(incomeEvidence(id))).not.toThrow());
  it('rejects the unsupported plural cashbook route in the actual C35 tool chain',()=>{
    const e=incomeEvidence('C35');
    e.rounds[1].messages[1].content=e.rounds[1].messages[1].content.replace('/income-expense','/income-expenses');
    expect(()=>assertIncomeApprovalResult(e)).toThrow(/linked financial tool result/i);
  });
  it.each(['p_organization_id','p_tu','p_den','p_loai','p_query','p_trang_thai','p_limit'])('rejects observed filter drift %s',key=>{
    const e=incomeEvidence();e.reads[0].args[key]='wrong';expect(()=>assertIncomeApprovalResult(e)).toThrow();
  });
  it('rejects changed actor, fixture payload and a tool result never consumed',()=>{
    const actor=incomeEvidence('C36');actor.actorDigest='c'.repeat(64);expect(()=>assertIncomeApprovalResult(actor)).toThrow();
    const drift=incomeEvidence();drift.reads[0].payload={gioi_han:20,so_luong:0,phieu:[]};expect(()=>assertIncomeApprovalResult(drift)).toThrow();
    const lost=incomeEvidence();lost.rounds[1].messages=[{role:'user',content:lost.prompt}];expect(()=>assertIncomeApprovalResult(lost)).toThrow();
    const wrong=incomeEvidence();wrong.rounds[1].messages[1].tool_call_id='other';expect(()=>assertIncomeApprovalResult(wrong)).toThrow();
    const raw=incomeEvidence();raw.rounds[1].messages[1].content=raw.rounds[1].messages[1].content.replace('[STK đã ẩn]','1234567890123');expect(()=>assertIncomeApprovalResult(raw)).toThrow();
  });
  it('rejects a successful read carrying another authenticated actor',()=>{
    const e=incomeEvidence('C36');e.reads[0].actorDigest='c'.repeat(64);expect(()=>assertIncomeApprovalResult(e)).toThrow();
  });
  it('only exempts the current scenario exact known endpoint at the attested origin',()=>{
    const f=incomeEvidence().fixture, origin='https://demo.supabase.co';
    expect(isIncomeApprovalReadonlyRequest(f,origin,'POST',origin+'/rest/v1/rpc/copilot_income_expense_search_v1')).toBe(true);
    for(const [method,url] of [['DELETE',origin+'/rest/v1/rpc/copilot_income_expense_search_v1'],['POST','https://other.supabase.co/rest/v1/rpc/copilot_income_expense_search_v1'],['POST',origin+'/rest/v1/rpc/copilot_pending_requests_v1'],['POST',origin+'/rest/v1/rpc/copilot_income_expense_search_v1/extra'],['POST',origin+'/rest/v1/rpc/copilot_income_expense_search_v1?other=1'],['POST',origin+'/rest/v1/rpc/ie_compat_cancel_v2']])expect(isIncomeApprovalReadonlyRequest(f,origin,method,url)).toBe(false);
    expect(isIncomeApprovalReadonlyRequest(undefined,origin,'POST',origin+'/rest/v1/rpc/copilot_income_expense_search_v1')).toBe(false);
  });
  it('emits only static typed financial diagnostic codes',()=>{
    const e=incomeEvidence();let failure:unknown;
    try{assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('11.000 đồng','12.000 đồng')));}catch(error){failure=error;}
    expect(incomeApprovalOracleDiagnostic('C34',failure)).toEqual({caseId:'C34',code:'financial_money'});
    for(const error of [new Error('private payload'),{code:'financial_money'},Object.assign(Object.create(IncomeApprovalOracleFailure.prototype),{code:'financial_money'})])expect(incomeApprovalOracleDiagnostic('C34',error)).toBeUndefined();
    expect(incomeApprovalOracleDiagnostic('private-case',failure)).toBeUndefined();
    expect(isIncomeApprovalOracleFailureCode('financial_money')).toBe(true);
    for(const code of ['private payload',null,['financial_money'],{}])expect(isIncomeApprovalOracleFailureCode(code)).toBe(false);
  });
  it('classifies snapshot drift as a blocked fixture while answer corruption remains an oracle failure',()=>{
    const e=incomeEvidence('C36');e.reads[0].payload={gioi_han:20,so_luong:0,hop_cho:[]};let failure:unknown;
    try{assertIncomeApprovalResult(e);}catch(error){failure=error;}
    expect(incomeApprovalFixtureFailureReason(failure)).toBe('fixture_unbound');
    expect(incomeApprovalFixtureFailureReason(new IncomeApprovalOracleFailure('financial_money'))).toBeUndefined();
    expect(incomeApprovalFixtureFailureReason(new Error('financial_rpc_drift'))).toBeUndefined();
  });
  it.each([
    ['11.000 đồng','1.000 đồng'],['PC001','PC0010'],['phiếu chi','phiếu thu'],['chờ duyệt','đã duyệt'],['đã huỷ','đã duyệt'],['chưa vào sổ','đã vào sổ'],
  ])('rejects per-voucher corrupt facts %s -> %s',(from,to)=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace(from,to)))).toThrow();
  });
  it('rejects money swapped between two voucher identities even though global amounts are unchanged',()=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('11.000 đồng','SWAP').replace('1.000 đồng','11.000 đồng').replace('SWAP','1.000 đồng')))).toThrow();
  });
  it('accepts faithful labeled prose, bare amounts and bullet prefixes',()=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,'Có 2 phiếu:\n- Phiếu chi PC001, số tiền: 11000; chưa duyệt; chưa ghi sổ.\n- [THU] PT002, số tiền: 1000; đã hủy; chưa hạch toán.'))).not.toThrow();
  });
  it('checks faithful aggregate totals separately from each voucher amount',()=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' Tổng cộng: 12.000 đồng. Tổng thu: 1.000 đồng. Tổng chi: 11.000 đồng.'))).not.toThrow();
    const bad=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(bad,bad.answer+' Tổng cộng: 1.000 đồng.'))).toThrow();
  });
  it.each(['before','after'])('rejects wrong common total equal to one row amount %s the voucher list',position=>{
    const e=incomeEvidence(), total='Tổng tiền: 11.000 đồng. ';
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,position==='before'?total+e.answer:e.answer+' '+total))).toThrow();
  });
  it.each(['before','after'])('accepts the correct common total %s the voucher list',position=>{
    const e=incomeEvidence(), total='Tổng tiền: 12.000 đồng. ';
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,position==='before'?total+e.answer:e.answer+' '+total))).not.toThrow();
  });
  it.each(['không phải phiếu chi','không phải là phiếu chi','chẳng phải phiếu chi'])('rejects explicit denial of the canonical voucher type: %s',type=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('phiếu chi',type)))).toThrow();
  });
  it('allows truthful opposite-type denial only alongside a positive canonical type',()=>{
    const good=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(good,good.answer.replace('phiếu chi','phiếu chi, không phải phiếu thu')))).not.toThrow();
    const missing=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(missing,missing.answer.replace('phiếu chi','không phải phiếu thu')))).toThrow();
  });
  it('preserves negation when the voucher type label precedes its identity',()=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('PC001 — phiếu chi','không phải phiếu chi PC001 —')))).toThrow();
    const positive=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(positive,positive.answer.replace('PC001 — phiếu chi','Phiếu chi PC001 —')))).not.toThrow();
  });
  it.each(['Sổ quỹ TK 1234567890123.','Sổ quỹ TK 1234 5678 90123.'])('rejects canonical cashbook material stripped by the tool masker in mounted prose: %s',addition=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' '+addition))).toThrow();
  });
  it('accepts the canonical masked cashbook label in mounted prose',()=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' Sổ quỹ TK [STK đã ẩn].'))).not.toThrow();
  });
  it('does not treat a canonical numeric cashbook reference left intact by maskPii as removed material',()=>{
    const e=incomeEvidence();const data=structuredClone(e.fixture.payload);data.phieu!.forEach(row=>{row.so_quy='Quỹ số 12345678';});
    e.fixture=bindIncomeApprovalScenario(e.scenario,{request:e.fixture.request,payload:data,actorDigest:e.actorDigest});e.reads[0].payload=data;
    e.rounds[1].messages[1].content=e.rounds[1].messages[1].content.split('TK [STK đã ẩn]').join('Quỹ số 12345678');
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' Sổ quỹ Quỹ số 12345678.'))).not.toThrow();
  });
  it.each([' PC999: 1000 đồng.',' Mã phiếu: XYZ-9.',' Phiếu XYZ-9.',' Tổng tiền: 1000.',' Số tiền: 0.',' Tiền chi: 9000.',' Giá trị phiếu: 9000.',' Có 1 phiếu.',' Có một phiếu.',' Có vài phiếu.',' Phiếu đã duyệt.',' Đã ghi sổ.'])('rejects empty-query hallucination %s',addition=>{
    const e=incomeEvidence('C35');expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+addition))).toThrow();
  });
  it.each(['đã được duyệt','đã vào sổ','đã từ chối','đã hủy','APPROVED','REJECTED'])('rejects pending inbox decision claim %s',addition=>{
    const e=incomeEvidence('C36');expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' Phiếu '+addition+'.'))).toThrow();
  });
  it('rejects wrong inbox maker and amount and permits explicit no-decision language',()=>{
    const e=incomeEvidence('C36');expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('Demo An','Demo Bình')))).toThrow();
    const good=incomeEvidence('C36');expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(good,good.answer+' Phiếu chưa được duyệt. Bạn có thể duyệt hoặc từ chối bằng tay.'))).not.toThrow();
  });
  it.each([' PC001 là phiếu thu.',' PC001 không chờ duyệt.',' PC001 đã được ghi sổ.',' PC001 số tiền: 11000, phiếu chi, chờ duyệt, chưa vào sổ; người lập: Người Khác.'])('rejects contradictory repeated voucher facts %s',addition=>{
    const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+addition))).toThrow();
  });
  it('does not mistake the maker name for a voucher type assertion',()=>{
    const e=incomeEvidence('C36');const data=structuredClone(e.fixture.payload);data.hop_cho![0].nguoi_lap='Demo Thu';
    e.fixture=bindIncomeApprovalScenario(e.scenario,{request:e.fixture.request,payload:data,actorDigest:e.actorDigest});e.reads[0].payload=data;
    e.rounds[1].messages[1].content=e.rounds[1].messages[1].content.replace(' Demo An ','Demo Thu');
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('Demo An','Demo Thu')))).not.toThrow();
  });
  it('does not infer an unposted state from pending approval alone',()=>{
    const e=incomeEvidence('C36');expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' PC001 chưa ghi sổ.'))).toThrow();
  });
  it('accepts pending code fallback from the actual request identity',()=>{
    const e=incomeEvidence('C36');const data=structuredClone(e.fixture.payload);data.hop_cho![0].ma_phieu=null;data.hop_cho![0].phieu_id=null;
    e.fixture=bindIncomeApprovalScenario(e.scenario,{request:e.fixture.request,payload:data,actorDigest:e.actorDigest});e.reads[0].payload=data;
    e.rounds[1].messages[1].content=e.rounds[1].messages[1].content.replace('PC001','aaaa4000');
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('PC001','aaaa4000')))).not.toThrow();
  });
});
describe('readonly smoke failure oracle', () => {
  it('accepts a complete model/tool cycle with DEMO-consistent answer', () => { expect(() => assertReadonlyResult(evidence())).not.toThrow(); });
  it('reassembles fragmented tool names', () => { expect(inspectModelStream(call).tools).toEqual([{ id: 'call-1', name: 'phong_trong', arguments: '{}' }]); });
  it.each([
    ['empty', 'data: [DONE]\n\n'], ['missing DONE', answer.replace('data: [DONE]', '')],
    ['incomplete', chunk({ content: 'half an answer' }, null) + 'data: [DONE]\n\n'],
    ['length limit', chunk({ content: 'cut short' }, 'length') + 'data: [DONE]\n\n'],
    ['provider error', 'data: {"error":{"code":"daily_quota"}}\n\ndata: [DONE]\n\n'],
  ])('rejects %s stream', (_, body) => { expect(() => inspectModelStream(body)).toThrow(); });
  it('rejects the old prompt-only green even with a completed generic model response', () => {
    expect(() => assertReadonlyResult({ ...evidence(), rounds: [{ body: answer, messages: [] }], answer: 'Phòng nào đang trống?' })).toThrow();
  });
  it('rejects a read call never returned to the model', () => {
    const e = evidence(); e.rounds[1].messages = [{ role: 'user', content: e.prompt }]; expect(() => assertReadonlyResult(e)).toThrow(/tool result/);
  });
  it('rejects a tool error returned to the model', () => {
    const e = evidence(); e.rounds[1].messages[1].content = 'Lỗi: unavailable'; expect(() => assertReadonlyResult(e)).toThrow(/tool result/);
  });
  it('rejects mounted answer unrelated to its final stream', () => { expect(() => assertReadonlyResult({ ...evidence(), answer: 'Có 1 phòng trống ngay: Z999.' })).toThrow(); });
  it('rejects missing RPC payload instead of pretending it means empty', () => { expect(() => assertReadonlyResult({ ...evidence(), payload: null })).toThrow(); });
  it('accepts explicit empty state only when the read response is empty', () => {
    const text = 'Hiện không có phòng trống nào.';
    const e = evidence(); e.answer = text; e.payload.rooms = [];
    e.rounds[1].body = chunk({ content: text }, 'stop') + 'data: [DONE]\n\n'; e.rounds[1].messages[1].content = text;
    expect(() => assertReadonlyResult(e)).not.toThrow();
    e.payload.rooms = payload.rooms; expect(() => assertReadonlyResult(e)).toThrow();
  });
  it.each(['income_expenses', 'profiles', 'rpc/copilot_plan_execute_step_v1', 'rpc/unknown_write'])('rejects mutation to %s', path => {
    expect(unexpectedReadonlyMutation('POST', `https://demo/rest/v1/${path}`)).toBe(true);
  });
  it('allows only explicitly known read RPCs and chat persistence', () => {
    expect(unexpectedReadonlyMutation('POST', 'https://demo/rest/v1/rpc/copilot_available_rooms_v1')).toBe(false);
    expect(unexpectedReadonlyMutation('POST', 'https://demo/rest/v1/ai_chat_messages')).toBe(false);
    expect(unexpectedReadonlyMutation('GET', 'https://demo/rest/v1/income_expenses')).toBe(false);
    expect(unexpectedReadonlyMutation('DELETE', 'https://demo/rest/v1/ai_chat_messages')).toBe(true);
  });
});

// Stream and mounted answer are changed together: these must reach readback
// consistency checks, not fail early on a deliberately mismatched DOM string.
function setAnswer(e: ReturnType<typeof evidence>, text: string, rendered = text) {
  e.answer = rendered;
  e.rounds[1].body = chunk({ content: text }, 'stop') + 'data: [DONE]\n\n';
  return e;
}
describe('review regressions: read RPC → tool → rendered answer', () => {
  it.each(['Có 2 phòng trống: A101, Z999.', 'Có 1 phòng trống: A1010.'])('rejects invented or substring room IDs: %s', text => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), text))).toThrow(/room/);
  });
  it('rejects an extra non-free room asserted in the answer', () => {
    const e = evidence(); e.payload.rooms.push({ ...e.payload.rooms[0], id: 'r2', code: 'A102', status_public: 'rented' });
    expect(() => assertReadonlyResult(setAnswer(e, 'Phòng trống: A101, A102.'))).toThrow(/room/);
  });
  it('rejects an empty RPC paired with a nonempty matching tool result', () => {
    const e = evidence(); e.payload.rooms = [];
    expect(() => assertReadonlyResult(setAnswer(e, 'Hiện không có phòng trống nào.'))).toThrow(/tool/);
  });
  it('rejects an invented room in tool output even when the final answer is accurate', () => {
    const e = evidence(); e.rounds[1].messages[1].content += '\n  - Z999: 3 triệu/tháng, 20m², tầng 1';
    expect(() => assertReadonlyResult(e)).toThrow(/tool/);
  });
  it('accepts a supported link after its label is rendered', () => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), 'Có 1 phòng trống ngay: [A101](/apartments).', 'Có 1 phòng trống ngay: A101.'))).not.toThrow();
  });
  it('keeps unsafe links as visible literal markdown', () => {
    const text = 'Phòng trống: [A101](javascript:evil).';
    expect(() => assertReadonlyResult(setAnswer(evidence(), text))).not.toThrow();
    expect(() => assertReadonlyResult(setAnswer(evidence(), text, 'Phòng trống: A101.'))).toThrow(/Mounted/);
  });
  it('still rejects unrelated mounted text after link normalization', () => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), '[A101](/apartments)', 'Z999'))).toThrow(/Mounted/);
  });
});

describe('supported room result shapes', () => {
  it('accepts numeric room names with ordinary prices and area prose', () => {
    const e = evidence(); e.payload.rooms[0].code = ''; e.payload.rooms[0].name = '101';
    e.rounds[1].messages[1].content = 'Tổng 1 phòng trống ngay.\n\nDEMO Toà A (Địa chỉ):\n  Trống ngay (1):\n  - 101: 3 triệu/tháng, 20m², tầng 1';
    expect(() => assertReadonlyResult(setAnswer(e, 'Phòng 101 đang trống, giá 3 triệu/tháng, diện tích 20m2.'))).not.toThrow();
    expect(() => assertReadonlyResult(setAnswer(e, 'Phòng trống: 101, 999.'))).toThrow(/room/);
  });
  it('allows a soon-only tool response while correctly answering no rooms free now', () => {
    const e = evidence(); e.payload.rooms[0].status_public = 'soon';
    e.rounds[1].messages[1].content = 'Tổng 0 phòng trống ngay.\n\nDEMO Toà A (Địa chỉ):\n  Sắp trống (1):\n  - A101: 3 triệu/tháng, 20m², tầng 1, trống từ 10/09/2026';
    expect(() => assertReadonlyResult(setAnswer(e, 'Hiện không có phòng trống ngay.'))).not.toThrow();
  });
});

describe('review round 2: table column semantics', () => {
  const table = (room: string, price = '3', area = '20', floor = '1') =>
    `Có 1 phòng trống: A101.\n| Mã phòng | Giá (triệu/tháng) | Diện tích (m²) | Tầng |\n|---|---|---|---|\n| ${room} | ${price} | ${area} | ${floor} |`;
  it('accepts numeric price, area and floor columns in an ordinary Markdown table', () => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), table('A101')))).not.toThrow();
  });
  it.each(['Z999', '999'])('rejects invented room %s in the room column despite valid numeric metadata', room => {
    expect(() => assertReadonlyResult(setAnswer(evidence(), table(room)))).toThrow(/room/);
  });
  it('does not use a room identifier from a price column as evidence of an available room', () => {
    const text = table('999', 'A101').replace('Có 1 phòng trống: A101.', 'Danh sách phòng trống:');
    expect(() => assertReadonlyResult(setAnswer(evidence(), text))).toThrow(/room/);
  });
  it('accepts numeric room names but rejects another numeric identifier in the same table column', () => {
    const e = evidence(); e.payload.rooms[0].code = '101';
    e.rounds[1].messages[1].content = e.rounds[1].messages[1].content.replace('A101', '101');
    const valid = table('101').replace('Có 1 phòng trống: A101.', 'Có 1 phòng trống: 101.');
    expect(() => assertReadonlyResult(setAnswer(e, valid))).not.toThrow();
    expect(() => assertReadonlyResult(setAnswer(e, valid + '\n| 999 | 3 | 20 | 1 |'))).toThrow(/room/);
  });
});

describe('golden C13: building identity survives duplicate room codes', () => {
  const scoped = (toolBuilding = 'DEMO Toà A', resultBuilding = 'DEMO Toà A', answerBuilding = 'DEMO Toà A') => {
    const e = evidence();
    const prompt = 'Phòng trống ngay tòa DEMO Toà A?';
    const response = `Tại ${answerBuilding}, phòng 101 đang trống ngay.`;
    return { ...e, prompt, answer: response,
      buildingScope: { id: 'a', name: 'DEMO Toà A' },
      payload: { buildings: [{ id: 'a', name: 'DEMO Toà A', address: 'Địa chỉ A' }], rooms: [
        { id: 'a101', building_id: 'a', code: '101', status_public: 'free' },
        { id: 'b101', building_id: 'b', code: '101', status_public: 'free' },
      ] },
      rounds: [{ body: chunk({ tool_calls: [{ index: 0, id: 'read-1', function: { name: 'phong_trong', arguments: JSON.stringify({ toa_nha: toolBuilding }) } }] }, 'tool_calls') + 'data: [DONE]\n\n', messages: [{ role: 'user', content: prompt }] },
        { body: chunk({ content: response }, 'stop') + 'data: [DONE]\n\n', messages: [{ role: 'user', content: prompt },
          { role: 'tool', tool_call_id: 'read-1', content: `Tổng 1 phòng trống ngay.\n\n${resultBuilding} (Địa chỉ ${resultBuilding.endsWith('B') ? 'B' : 'A'}):\n  Trống ngay (1):\n  - 101: 3 triệu/tháng, 20m², tầng 1` }] }],
    };
  };
  it('accepts the intended building even when another building has the same room code', () => {
    const e = scoped();
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: 'Địa chỉ B' });
    expect(() => assertReadonlyResult(e)).not.toThrow();
  });
  it.each(['Khác', 'Quận 1', 'Khu A (phường cũ)'])('accepts the correct building with formatted fallback address %s', address => {
    const e = scoped();
    e.payload.buildings[0].address = '';
    e.rounds[1].messages[1].content = e.rounds[1].messages[1].content.replace('(Địa chỉ A):', `(${address}):`);
    expect(() => assertReadonlyResult(e)).not.toThrow();
  });
  it('still rejects a wrong building when both raw addresses are empty and rendered fallback is Khác', () => {
    const e = scoped('DEMO Toà A', 'DEMO Toà B');
    e.payload.buildings[0].address = '';
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: '' });
    e.rounds[1].messages[1].content = e.rounds[1].messages[1].content.replace('(Địa chỉ B):', '(Khác):');
    expect(() => assertReadonlyResult(e)).toThrow(/different building/i);
  });
  it('does not confuse a known building name suffix with the requested building address', () => {
    const e = scoped('DEMO Toà A', 'DEMO Toà A (Chi nhánh)');
    e.payload.buildings.push({ id: 'branch', name: 'DEMO Toà A (Chi nhánh)', address: 'Địa chỉ A' });
    expect(() => assertReadonlyResult(e)).toThrow(/building/i);
  });
  it.each([
    ['wrong argument', 'DEMO Toà B', 'DEMO Toà A', 'DEMO Toà A'],
    ['wrong tool result', 'DEMO Toà A', 'DEMO Toà B', 'DEMO Toà A'],
    ['wrong answer', 'DEMO Toà A', 'DEMO Toà A', 'DEMO Toà B'],
    ['all wrong but identical room code', 'DEMO Toà B', 'DEMO Toà B', 'DEMO Toà B'],
  ])('rejects %s instead of trusting the shared room code', (_, args, result, answer) => {
    expect(() => assertReadonlyResult(scoped(args, result, answer))).toThrow(/building/i);
  });
  it('resolves tool arguments against the full RPC building set, rejecting an ambiguous filter', () => {
    const e = scoped('DEMO');
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: 'Địa chỉ B' });
    expect(() => assertReadonlyResult(e)).toThrow(/building/i);
  });
  it('rejects missing tool arguments, even when every room code is correct', () => {
    const e = scoped(); e.rounds[0].body = e.rounds[0].body.replace(/\\"toa_nha\\":\\"DEMO Toà A\\"/, '');
    expect(() => assertReadonlyResult(e)).toThrow(/building/i);
  });
  it('rejects an answer that names the correct and wrong building together', () => {
    const e = scoped('DEMO Toà A', 'DEMO Toà A', 'DEMO Toà A và DEMO Toà B');
    e.payload.buildings.push({ id: 'b', name: 'DEMO Toà B', address: 'Địa chỉ B' });
    expect(() => assertReadonlyResult(e)).toThrow(/different building/i);
  });
  it('preserves fragmented building arguments across SSE chunks', () => {
    const e = scoped();
    e.rounds[0].body = chunk({ tool_calls: [{ index: 0, id: 'read-1', function: { name: 'phong_trong', arguments: '{"toa_' } }] }, null)
      + chunk({ tool_calls: [{ index: 0, function: { arguments: 'nha":"DEMO Toà A"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n';
    expect(() => assertReadonlyResult(e)).not.toThrow();
  });
});
import { assertContractResult, contractToolText, ContractOracleFailure, contractOracleDiagnostic } from '../../../.e2e-fleet/specs/copilotContractOracle';
import { bindContractScenario } from '../../../scripts/copilot-contract-fixtures.mjs';
import { DEMO_ORG } from '../../../scripts/copilot-golden-browser-evidence.mjs';
const contractRow = { hop_dong_id: 'aaaa4000-0000-4000-8000-000000000011', so_hop_dong: 'HD001', khach_hang: 'Demo An', phong: 'A101', toa_nha: 'DEMO Toà A', ngay_bat_dau: '2026-01-01', ngay_ket_thuc: '2026-12-31', trang_thai: 'ACTIVE', tien_thue: 3000000, tien_coc: 6000000, coc_da_thu: 5000000, coc_con_thieu: 1000000 };
function contractEvidence(id = 'C31', withInvoice = false) {
  const absent = id === 'C32', detail = id === 'C33';
  const query = absent ? 'GOLDEN_ABSENT_context-1' : 'HD001';
  const scenario = { id, fixture: 'contract', kind: 'read', acceptance: ['facts'], oracle: absent ? 'absent-customer-contract-v1' : detail ? 'contract-code-detail-v1' : 'contract-code-v1', prompt: absent ? 'Tìm hợp đồng của khách {{absent_customer.name}}' : `${detail ? 'Chi tiết' : 'Tìm'} hợp đồng {{contract.code}}` };
  const searchPayload = { gioi_han: 20, so_luong: absent ? 0 : 1, hop_dong: absent ? [] : [structuredClone(contractRow)] };
  const invoice = { hoa_don_id: 'bbbb4000-0000-4000-8000-000000000011', so_hoa_don: 'INV001', ky: '2026-09', tong_tien: 4000000, da_tra: 2000000, con_lai: 2000000, trang_thai: 'PARTIAL' };
  const detailPayload = detail ? { tim_thay: true, hop_dong: structuredClone(contractRow), hoa_don: withInvoice ? [invoice] : [] } : undefined;
  const fixture = bindContractScenario(scenario, { query, searchPayload, detailPayload, customerPayload: absent ? [] : undefined });
  const tool = (name: string, args: object, id: string) => chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls') + 'data: [DONE]\n\n';
  let text = absent ? 'Không tìm thấy hợp đồng nào của khách này.' : `Hợp đồng HD001 — Demo An — phòng A101. Kỳ hạn 01/01/2026 đến 31/12/2026. Tiền thuê 3 triệu đồng, cọc 6 triệu đồng.${detail ? ' Đang giữ 5 triệu đồng, còn thiếu 1 triệu đồng. Chưa có hoá đơn nào.' : ''}`;
  if (withInvoice) text = text.replace('Chưa có hoá đơn nào.', 'Hoá đơn INV001 kỳ 2026-09: tổng 4 triệu đồng, đã trả 2 triệu đồng, còn 2 triệu đồng.');
  const messages: FixtureMessage[] = [{ role: 'user', content: fixture.prompt }];
  const rounds = [{ body: tool('tim_hop_dong', { tu_khoa: query }, 'search-1'), messages }];
  const searchResult = { role: 'tool', tool_call_id: 'search-1', content: contractToolText(fixture) };
  if (detail) rounds.push({ body: tool('chi_tiet_hop_dong', { hop_dong_id: contractRow.hop_dong_id }, 'detail-1'), messages: [...messages, searchResult] });
  rounds.push({ body: chunk({ content: text }, 'stop') + 'data: [DONE]\n\n', messages: [...messages, searchResult, ...(detail ? [{ role: 'tool', tool_call_id: 'detail-1', content: contractToolText(fixture,true) }] : [])] });
  const reads = [{ rpc: 'copilot_contract_search_v1', ok: true, args: { p_organization_id: DEMO_ORG, p_query: query, p_status: null, p_limit: 20 } as Record<string,unknown>, payload: searchPayload as unknown, actorDigest: 'a'.repeat(64), exactEndpoint: true }];
  if (detail) reads.push({ rpc: 'copilot_contract_detail_v1', ok: true, args: { p_organization_id: DEMO_ORG, p_contract_id: contractRow.hop_dong_id }, payload: detailPayload, actorDigest: 'a'.repeat(64), exactEndpoint: true });
  return { scenario, fixture, prompt: fixture.prompt, answer: text, rounds, reads, actorDigest: 'a'.repeat(64) };
}
function changeContractAnswer(e: ReturnType<typeof contractEvidence>, text: string) {
  e.answer = renderedAssistantText(text); e.rounds.at(-1)!.body = chunk({ content: text }, 'stop') + 'data: [DONE]\n\n';
  return e;
}
describe('contract golden actual RPC and linked-result oracle', () => {
  it.each(['C31','C32','C33'])('accepts %s canonical fixture and actual tool chain', id => expect(() => assertContractResult(contractEvidence(id))).not.toThrow());
  it.each(['C31','C32','C33'])('rejects %s missing later-round tool result', id => {
    const e = contractEvidence(id); e.rounds.at(-1)!.messages = [{ role: 'user', content: e.prompt }];
    expect(() => assertContractResult(e)).toThrow(/linked|consume/);
  });
  it.each(['p_organization_id','p_query'])('rejects wrong search %s', key => {
    const e = contractEvidence(); e.reads[0].args[key] = 'wrong'; expect(() => assertContractResult(e)).toThrow(/RPC/);
  });
  it('rejects wrong detail identity, reordered reads, and fixture drift', () => {
    const e = contractEvidence('C33'); e.reads[1].args.p_contract_id = 'bbbb4000-0000-4000-8000-000000000011';
    expect(() => assertContractResult(e)).toThrow(/RPC/);
    const reversed = contractEvidence('C33'); reversed.reads.reverse(); expect(() => assertContractResult(reversed)).toThrow(/RPC/);
    const drift = contractEvidence(); drift.reads[0].payload = { hop_dong: [] }; expect(() => assertContractResult(drift)).toThrow(/drift/);
  });
  it('rejects a correct detail tool called before consuming search identity', () => {
    const e = contractEvidence('C33'); e.rounds[1].messages = [{ role: 'user', content: e.prompt }];
    expect(() => assertContractResult(e)).toThrow(/consume/);
  });
  it('rejects forged tool body and wrong linked call ID', () => {
    const e = contractEvidence(); e.rounds[1].messages[1].content += ' Other private data';
    expect(() => assertContractResult(e)).toThrow(/linked/);
    const other = contractEvidence(); other.rounds[1].messages[1] = { role: 'tool', content: contractToolText(other.fixture), tool_call_id: 'other-call' };
    expect(() => assertContractResult(other)).toThrow(/linked/);
  });
  it.each([['HD001','HD002'], ['Demo An','Other Customer'], ['A101','B101'], ['3 triệu','9 triệu'], ['6 triệu','8 triệu'], ['31/12/2026','31/12/2027']])('rejects wrong mounted fact %s', (from,to) => {
    const e = contractEvidence(); expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace(from,to)))).toThrow();
  });
  it.each([' Hợp đồng HD999 phòng B999.', ' [HD999](/contracts/other)', ' Tiền thuê 9 triệu đồng.'])('rejects absent-query hallucination %s', addition => {
    const e = contractEvidence('C32'); expect(() => assertContractResult(changeContractAnswer(e,e.answer + addition))).toThrow(/invented/);
  });
  it('rejects missing invoice empty state and deposit held fact', () => {
    for (const part of ['Chưa có hoá đơn nào.', 'Đang giữ 5 triệu đồng,']) {
      const e = contractEvidence('C33'); expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace(part,'')))).toThrow();
    }
  });
});

 it('contract detail validates actual invoice identity, period and money', () => {
   expect(() => assertContractResult(contractEvidence('C33',true))).not.toThrow();
   for (const [from,to] of [['INV001','INV002'],['2026-09','2026-08'],['tổng 4 triệu','tổng 9 triệu']]) {
     const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace(from,to)))).toThrow();
   }
 });
 it('contract money labels cannot be swapped or accompanied by invented identities', () => {
   const e = contractEvidence();
   expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace('thuê 3 triệu đồng, cọc 6 triệu đồng','thuê 6 triệu đồng, cọc 3 triệu đồng')))).toThrow(/money/);
   const extra = contractEvidence(); expect(() => assertContractResult(changeContractAnswer(extra,extra.answer + ' Hợp đồng HD002.'))).toThrow(/identifier/);
 });

it.each([
 ['tổng 4 triệu đồng, đã trả 2 triệu đồng', 'tổng 2 triệu đồng, đã trả 4 triệu đồng'],
 ['Đang giữ 5 triệu đồng, còn thiếu 1 triệu đồng', 'Đang giữ 1 triệu đồng, còn thiếu 5 triệu đồng'],
])('rejects contract detail semantic money swap: %s', (from,to) => {
 const e = contractEvidence('C33',true);
 expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace(from,to)))).toThrow(/money/);
});
it('rejects money reassignment between individual invoices', () => {
 const e = contractEvidence('C33',true);
 const detail = e.fixture.detailPayload as { hop_dong: typeof contractRow; hoa_don: Record<string,unknown>[]; tim_thay: boolean };
 detail.hoa_don.push({ ...detail.hoa_don[0], hoa_don_id:'cccc4000-0000-4000-8000-000000000011', so_hoa_don:'INV002', ky:'2026-08', tong_tien:6000000, da_tra:1000000, con_lai:5000000 });
 e.fixture = bindContractScenario(e.scenario,{ query:e.fixture.query,searchPayload:e.fixture.searchPayload,detailPayload:detail });
 e.rounds.at(-1)!.messages.at(-1)!.content = contractToolText(e.fixture,true);
 const correct = e.answer + ' Hoá đơn INV002 kỳ 2026-08: tổng 6 triệu đồng, đã trả 1 triệu đồng, còn 5 triệu đồng.';
 expect(() => assertContractResult(changeContractAnswer(e,correct))).not.toThrow();
 const swapped = correct.replace('INV001 kỳ 2026-09: tổng 4 triệu đồng, đã trả 2 triệu đồng, còn 2 triệu đồng','INV001 kỳ 2026-09: tổng 6 triệu đồng, đã trả 1 triệu đồng, còn 5 triệu đồng').replace('INV002 kỳ 2026-08: tổng 6 triệu đồng, đã trả 1 triệu đồng, còn 5 triệu đồng','INV002 kỳ 2026-08: tổng 4 triệu đồng, đã trả 2 triệu đồng, còn 2 triệu đồng');
 expect(() => assertContractResult(changeContractAnswer(e,swapped))).toThrow(/money/);
});
it('absent customer rejects invented monetary facts without a currency suffix', () => {
 const e = contractEvidence('C32'); expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' Tiền thuê: 9000000.'))).toThrow(/invented/);
});
it('accepts equivalent labeled monetary prose with punctuation, units and reordered invoice facts', () => {
 const e = contractEvidence('C33',true);
 const text = e.answer.replace('Tiền thuê 3 triệu đồng, cọc 6 triệu đồng.', 'Tiền thuê: 3.000.000 đ; tiền cọc yêu cầu: 6.000.000 VND.')
   .replace('Đang giữ 5 triệu đồng, còn thiếu 1 triệu đồng.', 'Đã thu cọc: 5.000.000 ₫; cọc còn thiếu: 1.000.000 đồng.')
   .replace('tổng 4 triệu đồng, đã trả 2 triệu đồng, còn 2 triệu đồng.', 'còn lại: 2.000.000 đ; đã thanh toán: 2.000.000 đ; tổng tiền: 4.000.000 đ.');
 expect(() => assertContractResult(changeContractAnswer(e,text))).not.toThrow();
});
it('accepts canonical held/nominal deposit notation but rejects swapped ratio', () => {
 const e = contractEvidence('C33',true);
 const text = e.answer.replace('cọc 6 triệu đồng. Đang giữ 5 triệu đồng,', 'cọc: đang giữ 5 triệu đồng/6 triệu đồng,');
 expect(() => assertContractResult(changeContractAnswer(e,text))).not.toThrow();
 expect(() => assertContractResult(changeContractAnswer(e,text.replace('5 triệu đồng/6 triệu đồng','6 triệu đồng/5 triệu đồng')))).toThrow(/money/);
});
it('rejects contradictory repeat monetary assertions, even after a correct assertion', () => {
 const e = contractEvidence('C33',true);
 expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' Tổng tiền: 2 triệu đồng.'))).toThrow(/money/);
});
it('rejects a contradictory repeated labeled value without a currency suffix', () => {
 const e = contractEvidence('C33',true);
 expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' Tổng tiền: 2000000.'))).toThrow(/money/);
});
it('accepts invoice facts before the contract facts without imposing answer order', () => {
 const e = contractEvidence('C33',true);
 const invoiceStart = e.answer.indexOf('Hoá đơn INV001');
 const reordered = e.answer.slice(invoiceStart) + '\n' + e.answer.slice(0,invoiceStart);
 expect(() => assertContractResult(changeContractAnswer(e,reordered))).not.toThrow();
});
it.each([
 'Hoá đơn INV001 kỳ 2026-09: tổng 2000000, đã trả 4000000, còn 2000000.',
 'Hoá đơn INV001 kỳ2026-09: tổng2000000, đãtrả4000000, còn2000000.',
])('rejects currencyless repeated invoice section: %s', repeated => {
 const e = contractEvidence('C33',true);
 expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' ' + repeated))).toThrow(/money/);
});
it('accepts a repeated complete invoice with consistent labeled values without currency units', () => {
 const e = contractEvidence('C33',true);
 expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' Hoá đơn INV001 kỳ 2026-09: tổng4000000, đãtrả2000000, còn2000000.'))).not.toThrow();
});

it('exposes only a typed static oracle code for live diagnostics', () => {
 const e = contractEvidence('C33',true);
 let failure: unknown;
 try { assertContractResult(changeContractAnswer(e,e.answer.replace('tổng 4 triệu','tổng 2 triệu'))); } catch (error) { failure = error; }
 expect(failure).toBeInstanceOf(ContractOracleFailure);
 expect(contractOracleDiagnostic('C33',failure)).toEqual({ caseId:'C33',code:'money_fact_mismatch' });
 expect(JSON.stringify(contractOracleDiagnostic('C33',failure))).not.toMatch(/INV001|HD001|Demo An|triệu/);
});
it('does not log untyped exceptions, payload-shaped objects, or invalid oracle codes', () => {
 for (const error of [new Error('private JWT and customer payload'),Object.assign(Object.create(ContractOracleFailure.prototype),{code:'money_fact_mismatch',message:'raw'}),{code:'money_fact_mismatch',message:'raw'},'raw',null]) expect(contractOracleDiagnostic('C33',error)).toBeUndefined();
 expect(contractOracleDiagnostic('PRIVATE_CUSTOMER',new ContractOracleFailure('money_fact_mismatch'))).toBeUndefined();
 for (const code of ['private payload',['money_fact_mismatch'],null,{toString:() => 'money_fact_mismatch'}]) expect(() => new ContractOracleFailure(code as never)).toThrow('Invalid contract oracle failure code');
 const failure = new ContractOracleFailure('money_fact_mismatch');
 expect(Object.isFrozen(failure)).toBe(true);
 expect(() => Object.assign(failure,{code:'private payload'})).toThrow();
});
it.each([' Hợp đồng đã thanh lý.',' Hợp đồng đã hết hạn.',' Hợp đồng đã chuyển nhượng.'])('rejects explicit lifecycle contradiction against ACTIVE: %s', addition => {
 const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer + addition))).toThrow(/status/);
});
it.each([' Hợp đồng đang thuê.',' Hợp đồng chưa thanh lý.',' Hợp đồng không phải đã thanh lý.',' Nếu gia hạn, cần kiểm tra lại ngày kết thúc.'])('accepts truthful or negated lifecycle statement: %s', addition => {
 const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer + addition))).not.toThrow();
});
it.each([' Hoá đơn INV001 đã thanh toán đầy đủ.',' Hoá đơn INV001 không còn nợ.',' Hoá đơn INV001 đã hủy.'])('rejects contradictory status-only invoice repeat: %s', addition => {
 const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer + addition))).toThrow(/status/);
});
it.each([' Hoá đơn INV001 chưa thanh toán đầy đủ.',' Hoá đơn INV001 đã thanh toán một phần.',' Hoá đơn INV001 chưa hủy.'])('accepts truthful or negated invoice status-only repeat: %s', addition => {
 const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer + addition))).not.toThrow();
});
it.each([
 ['Kỳ hạn 01/01/2026 đến 31/12/2026.','Kỳ hạn từ 31/12/2026 đến 01/01/2026.'],
 ['Kỳ hạn 01/01/2026 đến 31/12/2026.','Bắt đầu 31/12/2026, kết thúc 01/01/2026.'],
])('rejects reversed canonical term labels/range: %s', (from,to) => {
 const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace(from,to)))).toThrow(/term/);
});
it('uses detail contractual term while separately preserving actual end semantics', () => {
 const e = contractEvidence('C33',true);
 const search = e.fixture.searchPayload as { hop_dong: (typeof contractRow)[] };
 const detail = e.fixture.detailPayload as { hop_dong: typeof contractRow & { ngay_ket_thuc_thuc_te?:string }; hoa_don: unknown[] };
 search.hop_dong[0].ngay_ket_thuc='2026-09-01'; detail.hop_dong.ngay_ket_thuc_thuc_te='2026-09-01';
 e.fixture = bindContractScenario(e.scenario,{query:e.fixture.query,searchPayload:search,detailPayload:detail});
 e.rounds[1].messages[1].content = contractToolText(e.fixture);
 e.rounds.at(-1)!.messages[1].content = contractToolText(e.fixture);
 e.rounds.at(-1)!.messages.at(-1)!.content = contractToolText(e.fixture,true);
 expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' Kết thúc thực tế 01/09/2026.'))).not.toThrow();
 expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace('31/12/2026','01/09/2026')))).toThrow(/term/);
});
it('does not treat a date-field label as an asserted expired lifecycle', () => {
 const e = contractEvidence('C31');
 expect(() => assertContractResult(changeContractAnswer(e,e.answer + ' Ngày hết hạn theo hợp đồng: 31/12/2026.'))).not.toThrow();
});
it('accepts canonical ISO range and individually labeled dates', () => {
 for (const term of ['Kỳ hạn từ 2026-01-01 đến 2026-12-31.','Bắt đầu: 1/1/2026; kết thúc: 31/12/2026.']) {
  const e = contractEvidence('C33',true); expect(() => assertContractResult(changeContractAnswer(e,e.answer.replace('Kỳ hạn 01/01/2026 đến 31/12/2026.',term)))).not.toThrow();
 }
});

describe('golden reporter static diagnostic boundary', () => {
  it.each(['C34','C35','C36'])('forwards only financial static codes for %s', caseId => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const value = { caseId, code: 'financial_cashbook_privacy' };
    try {
      new GoldenReporter().onTestEnd({} as TestCase, { status: 'failed', stdout: [JSON.stringify(value) + '\n'] } as TestResult);
      expect(log.mock.calls).toEqual([[JSON.stringify(value)], ['golden browser: failed']]);
    } finally { log.mockRestore(); }
  });
  it('forwards a fragmented allowlisted diagnostic without worker payloads', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new GoldenReporter().onTestEnd({} as TestCase, {
        status: 'failed', stdout: ['private transcript\n{"caseId":"C32",', '"code":"unexpected_contract_tool_calls"}\n'],
      } as TestResult);
      expect(log.mock.calls).toEqual([[JSON.stringify({ caseId: 'C32', code: 'unexpected_contract_tool_calls' })], ['golden browser: failed']]);
    } finally { log.mockRestore(); }
  });
  it.each([
    { caseId: 'C32', code: 'financial_money' },
    { caseId: 'C35', code: 'unexpected_contract_tool_calls' },
    { caseId: 'C36', code: 'financial_private_payload' },
    { caseId: 'C34', code: 'financial_money', message: 'private payload' },
    { caseId: 'C32', code: 'private transcript' },
    { caseId: 'C32', code: 'unexpected_contract_tool_calls', message: 'private transcript' },
    { caseId: ['C32'], code: 'unexpected_contract_tool_calls' },
    { caseId: 'C99', code: 'unexpected_contract_tool_calls' },
    ['C32', 'unexpected_contract_tool_calls'],
  ])('suppresses untrusted worker diagnostics %j', value => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new GoldenReporter().onTestEnd({} as TestCase, { status: 'failed', stdout: [JSON.stringify(value) + '\n'] } as TestResult);
      expect(log.mock.calls).toEqual([['golden browser: failed']]);
    } finally { log.mockRestore(); }
  });
});

describe('golden reporter failure metadata boundary', () => {
  const diagnostic = { kind: 'golden-case-failure', caseId: 'C32', phase: 'send', modelRequests: 0, readResponses: 0, modelHttpStatuses: [], businessWrites: 0, networkErrors: 0, consoleErrors: 0 };
  it('retains only bounded phase and counters for a failed browser case', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new GoldenReporter().onTestEnd({} as TestCase, { status: 'failed', stdout: [JSON.stringify(diagnostic) + '\n'] } as TestResult);
      expect(log.mock.calls).toEqual([[JSON.stringify(diagnostic)], ['golden browser: failed']]);
    } finally { log.mockRestore(); }
  });
  it.each([
    { ...diagnostic, phase: 'private transcript' },
    { ...diagnostic, modelRequests: 'private transcript' },
    { ...diagnostic, modelHttpStatuses: ['private transcript'] },
    { ...diagnostic, modelHttpStatuses: [200, 9999] },
    { ...diagnostic, message: 'private transcript' },
    { ...diagnostic, businessWrites: -1 },
  ])('suppresses unsafe failure metadata %j', value => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      new GoldenReporter().onTestEnd({} as TestCase, { status: 'failed', stdout: [JSON.stringify(value) + '\n'] } as TestResult);
      expect(log.mock.calls).toEqual([['golden browser: failed']]);
    } finally { log.mockRestore(); }
  });
});

import { diagnosticToolName, diagnosticEndpoint } from '../../../.e2e-fleet/specs/copilotGoldenDiagnostics';
describe('golden call diagnostics expose only source-known names and fixed endpoints', () => {
 it('classifies registry tool names and maps everything else to other', () => {
  for (const name of ['tim_hop_dong','chi_tiet_hop_dong','tim_khach_hang','phong_trong','ghi_nho','lap_ke_hoach']) expect(diagnosticToolName(name)).toBe(name);
  for (const name of ['private transcript','tim_hop_dong jwt',[],{},null,17]) expect(diagnosticToolName(name)).toBe('other');
 });
 it('does not preserve raw endpoint identifiers, query strings, or credentials', () => {
  expect(diagnosticEndpoint('https://demo/rest/v1/rpc/copilot_customer_search_v1?private=secret')).toBe('customer_search');
  expect(diagnosticEndpoint('https://demo/rest/v1/rpc/copilot_contract_search_v1')).toBe('contract_search');
  expect(diagnosticEndpoint('https://demo/rest/v1/rpc/private_customer_name')).toBe('other_rpc');
  expect(diagnosticEndpoint('https://demo/functions/v1/private_secret')).toBe('other_edge');
  expect(diagnosticEndpoint('https://demo/rest/v1/private_table?token=secret')).toBe('other_rest');
  for (const url of [null,[],{},'not a URL']) expect(diagnosticEndpoint(url)).toBe('other');
 });
});
describe('golden reporter call metadata boundary', () => {
 const diagnostic = { kind:'golden-call-diagnostics',caseId:'C32',tools:['tim_hop_dong','tim_khach_hang','other'],calls:[{endpoint:'contract_search',httpStatus:200,countedAsMutation:false},{endpoint:'customer_search',httpStatus:403,countedAsMutation:true},{endpoint:'other_rpc',httpStatus:null,countedAsMutation:true}],truncated:false };
 it.each([false,true])('retains bounded exact names, endpoint classes and HTTP statuses with truncated=%s', truncated => {
  const log = vi.spyOn(console,'log').mockImplementation(() => undefined);
  try {
   new GoldenReporter().onTestEnd({} as TestCase,{status:'failed',stdout:[JSON.stringify({...diagnostic,truncated})+'\n']} as TestResult);
   expect(log.mock.calls).toEqual([[JSON.stringify({...diagnostic,truncated})],['golden browser: failed']]);
  } finally {log.mockRestore();}
 });
 it.each([
  {...diagnostic,tools:['private transcript']}, {...diagnostic,tools:[['tim_hop_dong']]},
  {...diagnostic,tools:Array(41).fill('tim_hop_dong')}, {...diagnostic,calls:Array(61).fill(diagnostic.calls[0])},
  {...diagnostic,calls:[{...diagnostic.calls[0],endpoint:'copilot_private_customer_v1'}]},
  {...diagnostic,calls:[{...diagnostic.calls[0],httpStatus:'403'}]}, {...diagnostic,calls:[{...diagnostic.calls[0],httpStatus:999}]},
  {...diagnostic,calls:[{...diagnostic.calls[0],countedAsMutation:1}]}, {...diagnostic,calls:[{...diagnostic.calls[0],url:'https://private'}]},
  {...diagnostic,caseId:'private'}, {...diagnostic,truncated:'yes'}, {...diagnostic,args:{private:'data'}},
 ])('rejects malformed or arbitrary diagnostic strings %j', value => {
  const log = vi.spyOn(console,'log').mockImplementation(() => undefined);
  try {
   new GoldenReporter().onTestEnd({} as TestCase,{status:'failed',stdout:[JSON.stringify(value)+'\n']} as TestResult);
   expect(log.mock.calls).toEqual([['golden browser: failed']]);
  } finally {log.mockRestore();}
 });
});

function absentChain(names = ['tim_hop_dong','tim_khach_hang','tim_hop_dong','tim_khach_hang','tim_hop_dong']) {
 const e = contractEvidence('C32');
 const messages: {role:string;content:string;tool_call_id?:string}[] = [{role:'user',content:e.prompt}];
 e.rounds = []; e.reads = [];
 for (const [i,name] of names.entries()) {
  const id = `absent-${i}`;
  e.rounds.push({messages:[...messages],body:chunk({tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify({tu_khoa:` ${e.fixture.query} `})}}]},'tool_calls')+'data: [DONE]\n\n'});
  const customer = name === 'tim_khach_hang';
  messages.push({role:'tool',tool_call_id:id,content:customer ? `Không tìm thấy khách hàng nào khớp "${e.fixture.query}".` : contractToolText(e.fixture)});
  e.reads.push({rpc:customer?'copilot_customer_search_v1':'copilot_contract_search_v1',ok:true,args:customer?{p_organization_id:DEMO_ORG,p_search:e.fixture.query}:{p_organization_id:DEMO_ORG,p_query:e.fixture.query,p_status:null,p_limit:20},payload:customer?[]:e.fixture.searchPayload,actorDigest:e.actorDigest,exactEndpoint:true});
 }
 e.rounds.push({messages,body:chunk({content:e.answer},'stop')+'data: [DONE]\n\n'});
 return e;
}
describe('C32 bounded empty read chains', () => {
 it.each([['alternating',undefined],['single',['tim_hop_dong']],['repeated contract',['tim_hop_dong','tim_hop_dong']],['customer first',['tim_khach_hang','tim_hop_dong']]])('accepts %s with distinct actual reads', (_label,names) => {
  const e=absentChain(names as string[]|undefined); e.reads.reverse(); expect(()=>assertContractResult(e)).not.toThrow();
 });
 it.each(['query','org','actor','endpoint','payload','extra-arg','missing-read','missing-result','orphan','duplicate-id','unknown-tool','no-contract','overflow'])('rejects %s', mutation => {
  const e=absentChain();
  if(mutation==='query') e.reads[1].args.p_search='wrong';
  if(mutation==='org') e.reads[1].args.p_organization_id='wrong';
  if(mutation==='actor') e.reads[1].actorDigest='b'.repeat(64);
  if(mutation==='endpoint') e.reads[1].exactEndpoint=false;
  if(mutation==='payload') e.reads[1].payload=[{name:'invented'}];
  if(mutation==='extra-arg') e.reads[1].args.p_limit=20;
  if(mutation==='missing-read') e.reads.pop();
  if(mutation==='missing-result') for(const r of e.rounds) r.messages=r.messages.filter(m=>m.tool_call_id!=='absent-1');
  if(mutation==='orphan') e.rounds.at(-1)!.messages.push({role:'tool',tool_call_id:'orphan',content:'empty'});
  if(mutation==='duplicate-id') e.rounds[1].body=e.rounds[1].body.replace('absent-1','absent-0');
  if(mutation==='unknown-tool') e.rounds[1].body=e.rounds[1].body.replace('tim_khach_hang','phong_trong');
  if(mutation==='no-contract') {expect(()=>assertContractResult(absentChain(['tim_khach_hang']))).toThrow();return;}
  if(mutation==='overflow') {expect(()=>assertContractResult(absentChain(Array(11).fill('tim_hop_dong')))).toThrow();return;}
  expect(()=>assertContractResult(e)).toThrow();
 });
 it.each(['golden_absent_context-1','GOLDEN ABSENT context-1','GOLDEN_ABSENT_context-2'])('rejects rewritten tool query %s', query => {
  const e=absentChain(); e.rounds[1].body=e.rounds[1].body.replace(e.fixture.query,query); expect(()=>assertContractResult(e)).toThrow();
 });
});

import { isC32CustomerRead } from '../../../.e2e-fleet/specs/copilotContractOracle';
import { diagnosticRequestFailure, safeGoldenRequestFailures } from '../../../.e2e-fleet/specs/copilotGoldenDiagnostics';
it('customer read exemption applies only to exact C32 POST on the attested origin',()=>{
 const url='https://api.example/rest/v1/rpc/copilot_customer_search_v1';
 expect(isC32CustomerRead('C32','POST',url,'https://api.example')).toBe(true);
 for(const [id,method,other] of [['C31','POST',url],['C33','POST',url],['C32','GET',url],['C32','POST',url+'?x=1'],['C32','POST',url+'#x'],['C32','POST',url+'/'],['C32','POST',url.replace('api.example','other.example')]]) expect(isC32CustomerRead(id,method,other,'https://api.example')).toBe(false);
});
it('failed request metadata maps exact static enums without raw values',()=>{
 expect(diagnosticRequestFailure('https://api.example/functions/v1/llm-proxy?token=private','fetch','net::ERR_ABORTED','https://api.example','https://app.example')).toEqual({endpoint:'model',resource:'fetch',origin:'attested_api',failure:'aborted'});
 expect(diagnosticRequestFailure('https://app.example/private.png','image','net::ERR_TIMED_OUT','https://api.example','https://app.example')).toEqual({endpoint:'other',resource:'image',origin:'app',failure:'timeout'});
 expect(diagnosticRequestFailure('https://private.example/secret','private','secret error','https://api.example','https://app.example')).toEqual({endpoint:'other',resource:'other',origin:'other',failure:'other'});
});
it('failed request reporter rejects raw fields and dishonest truncation',()=>{
 const item={endpoint:'model',resource:'fetch',origin:'attested_api',failure:'aborted'};
 const event={kind:'golden-request-failures',caseId:'C32',count:1,failures:[item],truncated:false};
 expect(safeGoldenRequestFailures(event)).toEqual(event);
 for(const mutation of [{...event,count:2},{...event,truncated:true},{...event,url:'secret'},{...event,failures:[{...item,failure:'secret'}]},{...event,failures:[{...item,origin:'https://secret'}]},{...event,failures:[{...item,resource:'private'}]},{...event,failures:[{...item,endpoint:'secret'}]},{...event,failures:[{...item,errorText:'private'}]},{...event,failures:Array(61).fill(item),count:61}]) expect(safeGoldenRequestFailures(mutation)).toBeUndefined();
 expect(safeGoldenRequestFailures({...event,failures:Array(60).fill(item),count:61,truncated:true})).toBeDefined();
});

it('C32 accepts parallel reads without inventing tool ordering',()=>{
 const e=absentChain(['tim_hop_dong','tim_khach_hang']);
 const body=chunk({tool_calls:['tim_hop_dong','tim_khach_hang'].map((name,index)=>({index,id:`absent-${index}`,function:{name,arguments:JSON.stringify({tu_khoa:e.fixture.query})}}))},'tool_calls')+'data: [DONE]\n\n';
 e.rounds=[{body,messages:[{role:'user',content:e.prompt}]},e.rounds.at(-1)!];
 e.reads.reverse(); expect(()=>assertContractResult(e)).not.toThrow();
});
it('C32 rejects substitutions and malformed tool arguments despite matching RPCs',()=>{
 for(const args of ['null','[]','{bad',JSON.stringify({tu_khoa:'GOLDEN_ABSENT_context-1',unknown:true})]) {
  const e=absentChain(['tim_hop_dong']); e.rounds[0].body=chunk({tool_calls:[{index:0,id:'absent-0',function:{name:'tim_hop_dong',arguments:args}}]},'tool_calls')+'data: [DONE]\n\n';
  expect(()=>assertContractResult(e)).toThrow();
 }
 const e=absentChain(); e.rounds.at(-1)!.messages.find(m=>m.tool_call_id==='absent-1')!.content=contractToolText(e.fixture); expect(()=>assertContractResult(e)).toThrow();
});
it('request failure reporter reconstructs safe metadata and suppresses private fields',()=>{
 const event={kind:'golden-request-failures',caseId:'C32',count:1,failures:[{endpoint:'model',resource:'fetch',origin:'attested_api',failure:'aborted'}],truncated:false};
 const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
 try {
  new GoldenReporter().onTestEnd({} as TestCase,{status:'failed',stdout:[JSON.stringify(event)+'\n'+JSON.stringify({...event,errorText:'secret'})+'\n']} as TestResult);
  expect(log.mock.calls).toEqual([[JSON.stringify(event)],['golden browser: failed']]);
 }finally{log.mockRestore();}
});

it.each([' Khách hàng: Demo An.',' Khách hàng tên là Demo An.',' SĐT: 0901234567.',' Mã khách hàng: CUSTOMERX.'])('C32 rejects invented customer facts: %s',addition=>{
 const e=absentChain(); expect(()=>assertContractResult(changeContractAnswer(e,e.answer+addition))).toThrow();
});
it('C32 permits absence and query repetition without requiring customer tool use',()=>{
 const e=absentChain(['tim_hop_dong']); expect(()=>assertContractResult(changeContractAnswer(e,`Không tìm thấy hợp đồng của khách hàng "${e.fixture.query}". Không tìm thấy khách hàng này.`))).not.toThrow();
});

const dailyRequest = {rpc:'copilot_report_daily_cashbook_v1' as const,args:{p_organization_id:'dddd0000-0000-4000-8000-000000000001',p_tu:'2026-07-01',p_den:'2026-07-31',p_building_id:null,p_limit:20}};
const dailyPayload = {gioi_han:20,so_luong:2,tu:'2026-07-01',den:'2026-07-31',tong_hop:{tong_thu:9000,tong_chi:17000,rong:-8000,so_ngay_co_phat_sinh:2,phieu_han_che_bi_loai:0},theo_ngay:[{ngay:'2026-07-20',thu:9000,chi:2000,rong:7000},{ngay:'2026-07-19',thu:0,chi:15000,rong:-15000}]};
const dailyText='Thu chi 2026-07-01 → 2026-07-31: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ trên 2 ngày có phát sinh.\n\n2 ngày gần nhất (tối đa 20 dòng):\n- 2026-07-20: thu 9.000 đ, chi 2.000 đ, ròng 7.000 đ\n- 2026-07-19: thu 0 đ, chi 15.000 đ, ròng -15.000 đ\n[link: /reports/finance/daily-cashbook]';
function dailyEvidence() {
  const e=incomeEvidence();
  e.fixture=bindIncomeApprovalScenario(e.scenario,{...e.fixture,dailyCashbook:{request:structuredClone(dailyRequest),payload:structuredClone(dailyPayload)}});
  const primary=inspectModelStream(e.rounds[0].body).tools[0];
  e.rounds[0].body=chunk({tool_calls:[{index:0,id:primary.id,function:{name:primary.name,arguments:primary.arguments}},{index:1,id:'daily-1',function:{name:'bao_cao_thu_chi_theo_ngay',arguments:'{"ky":"2026-07"}'}}]},'tool_calls')+'data: [DONE]\n\n';
  e.rounds[1].messages.push({role:'tool',tool_call_id:'daily-1',content:dailyText});
  e.reads.push({rpc:dailyRequest.rpc,args:{...dailyRequest.args},payload:structuredClone(dailyPayload),ok:true,exactEndpoint:true,actorDigest:e.actorDigest});
  return e;
}
describe('C34 supplementary daily cashbook',()=>{
  it('accepts independently bound primary plus parallel daily tool results',()=>expect(()=>assertIncomeApprovalResult(dailyEvidence())).not.toThrow());
  it('accepts response arrival in reverse order',()=>{const e=dailyEvidence();e.reads.reverse();expect(()=>assertIncomeApprovalResult(e)).not.toThrow();});
  it('accepts labeled posted report totals and dates independently of voucher amounts',()=>{
    const e=dailyEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+'\nSổ quỹ đã vào sổ tháng 07/2026: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.\nNgày 2026-07-20: thu 9.000 đ, chi 2.000 đ, ròng 7.000 đ.'))).not.toThrow();
  });
  it('checks daily actor',()=>{const e=dailyEvidence();e.reads[1].actorDigest='c'.repeat(64);expect(()=>assertIncomeApprovalResult(e)).toThrow();});
  it('checks full actual daily payload',()=>{const e=dailyEvidence();e.reads[1].payload={...dailyPayload,unexpected:1};expect(()=>assertIncomeApprovalResult(e)).toThrow();});
  it('checks later exact linked daily result',()=>{const e=dailyEvidence();e.rounds[1].messages.pop();expect(()=>assertIncomeApprovalResult(e)).toThrow();});
  it('exempts only the C34 bound daily endpoint',()=>{
    const origin='https://demo.supabase.co', url=origin+'/rest/v1/rpc/copilot_report_daily_cashbook_v1';
    expect(isIncomeApprovalReadonlyRequest(dailyEvidence().fixture,origin,'POST',url)).toBe(true);
    for(const f of [incomeEvidence().fixture,incomeEvidence('C35').fixture,incomeEvidence('C36').fixture])expect(isIncomeApprovalReadonlyRequest(f,origin,'POST',url)).toBe(false);
    for(const [method,target] of [['GET',url],['POST',url+'?x=1'],['POST',url+'#hash'],['POST',url+'/extra'],['POST',url.replace('demo.','evil.')],['POST',url.replace('daily_cashbook','other_report')]])expect(isIncomeApprovalReadonlyRequest(dailyEvidence().fixture,origin,method,target)).toBe(false);
  });
});

function setDailyCalls(e:ReturnType<typeof dailyEvidence>,calls:{id:string;name:string;arguments:string}[]) {
  e.rounds[0].body=chunk({tool_calls:calls.map((c,index)=>({index,id:c.id,function:{name:c.name,arguments:c.arguments}}))},'tool_calls')+'data: [DONE]\n\n';
}
describe('C34 supplementary proof adversarial cases',()=>{
  it.each(['missing primary','duplicate daily','third tool','duplicate IDs','empty ID','unknown tool'])('rejects %s',mode=>{
    const e=dailyEvidence(), calls=inspectModelStream(e.rounds[0].body).tools;
    if(mode==='missing primary')calls.shift();if(mode==='duplicate daily')calls.push({...calls[1],id:'daily-2'});if(mode==='third tool')calls.push({id:'third',name:'so_quy',arguments:'{}'});if(mode==='duplicate IDs')calls[1].id=calls[0].id;if(mode==='empty ID')calls[1].id=' ';if(mode==='unknown tool')calls[1].name='other';
    setDailyCalls(e,calls);expect(()=>assertIncomeApprovalResult(e)).toThrow();
  });
  it.each([{ky:'2026-08'},{tu:'2026-07-01',den:'2026-07-31'},{ky:'2026-07',toa_nha_id:null},{ky:'2026-07',so_luong:50},{ky:'2026-07',extra:1}])('rejects supplementary raw arguments %j',args=>{
    const e=dailyEvidence(),calls=inspectModelStream(e.rounds[0].body).tools;calls[1].arguments=JSON.stringify(args);setDailyCalls(e,calls);expect(()=>assertIncomeApprovalResult(e)).toThrow();
  });
  it('accepts explicit default limits and reversed parallel call order',()=>{const e=dailyEvidence(),calls=inspectModelStream(e.rounds[0].body).tools;calls[1].arguments='{"ky":"2026-07","so_luong":20}';calls.reverse();setDailyCalls(e,calls);expect(()=>assertIncomeApprovalResult(e)).not.toThrow();});
  it('accepts sequential daily then primary calls with later results',()=>{
    const e=dailyEvidence(),calls=inspectModelStream(e.rounds[0].body).tools,final=e.rounds[1];
    setDailyCalls(e,[calls[1]]);
    e.rounds.splice(1,0,{body:chunk({tool_calls:[{index:0,id:calls[0].id,function:{name:calls[0].name,arguments:calls[0].arguments}}]},'tool_calls')+'data: [DONE]\n\n',messages:[e.rounds[0].messages[0],final.messages[2]]});
    expect(()=>assertIncomeApprovalResult(e)).not.toThrow();
  });
  it.each(['missing response','duplicate response','failed response','endpoint','wrong result','orphan result','premature result','digest drift'])('rejects %s',mode=>{
    const e=dailyEvidence();
    if(mode==='missing response')e.reads.pop();if(mode==='duplicate response')e.reads[1]=structuredClone(e.reads[0]);if(mode==='failed response')e.reads[1].ok=false;if(mode==='endpoint')e.reads[1].exactEndpoint=false;if(mode==='wrong result')e.rounds[1].messages[2].content+=' forged';if(mode==='orphan result')e.rounds[1].messages.push({role:'tool',tool_call_id:'orphan',content:'other'});if(mode==='premature result'){e.rounds[0].messages.push(e.rounds[1].messages.pop()!);}if(mode==='digest drift')e.fixture.attestation.dailyCashbookResponseDigest='c'.repeat(64);
    expect(()=>assertIncomeApprovalResult(e)).toThrow();
  });
  it.each(['p_organization_id','p_tu','p_den','p_building_id','p_limit','extra'])('rejects wrong daily RPC %s',key=>{const e=dailyEvidence();e.reads[1].args[key]='wrong';expect(()=>assertIncomeApprovalResult(e)).toThrow();});
  it.each([
    'Sổ quỹ đã vào sổ tháng 07/2026: thu 1.000 đ, chi 11.000 đ, ròng -10.000 đ.',
    'Sổ quỹ đã vào sổ tháng 07/2026: thu 9.000 đ, chi 17.000 đ, ròng 8.000 đ.',
    'Ngày 2026-07-19: thu 9.000 đ, chi 2.000 đ, ròng 7.000 đ.',
    'Ngày 2026-07-18: thu 0 đ, chi 15.000 đ, ròng -15.000 đ.',
    'Sổ quỹ đã vào sổ tháng 07/2026: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ, khác 1.000 đ.',
    'Sổ quỹ đã vào sổ phiếu PC001: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
    'Tổng thu 9.000 đ, tổng chi 17.000 đ.',
    'Dòng tiền ròng 1.000 đ.',
    'Ngày 2026-07-20: thu 1.000 đ.',
    'Ngày 2026-07-12 chi 1.000 đ.',
    'Sổ quỹ: 1.000 đ.',
    'Sổ quỹ tháng 07/2026: chưa có phát sinh.',
  ])('rejects unfaithful or unscoped daily claims %s',text=>{const e=dailyEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+'\n'+text))).toThrow();});
  it('does not allow report money to replace voucher money',()=>{const e=dailyEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer.replace('11.000 đồng','17.000 đồng')))).toThrow();});
  it('does not allow report facts without an actual daily call',()=>{const e=incomeEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+'\nSổ quỹ đã vào sổ tháng 07/2026: thu 1.000 đ.'))).toThrow();});
  it('rejects unknown daily report links',()=>{const e=dailyEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+' [báo cáo](/reports/finance/daily-cashbook/private)'))).toThrow();});
  it('diagnoses only the exact daily endpoint and never leaks query strings',()=>{expect(diagnosticEndpoint('https://demo/rest/v1/rpc/copilot_report_daily_cashbook_v1?secret=hidden')).toBe('daily_cashbook');expect(diagnosticEndpoint('https://demo/rest/v1/rpc/copilot_report_daily_cashbook_v1/extra')).toBe('other_rpc');});
});

describe('C34 daily report limit and empty rendering',()=>{
  it('reconstructs restricted and truncated report counts without summing displayed rows',()=>{
    const e=dailyEvidence(),p=structuredClone(dailyPayload);p.tong_hop.so_ngay_co_phat_sinh=31;p.tong_hop.phieu_han_che_bi_loai=3;
    e.fixture=bindIncomeApprovalScenario(e.scenario,{...e.fixture,dailyCashbook:{request:dailyRequest,payload:p}});
    expect(dailyCashbookToolText(e.fixture)).toBe(dailyText.replace('trên 2 ngày','trên 31 ngày').replace('\n\n2 ngày','\n⚠ 3 phiếu thuộc hạng mục hạn chế KHÔNG nằm trong các con số trên, nên tổng này chưa đầy đủ.\n\n2 ngày'));
    e.reads[1].payload=p;e.rounds[1].messages[2].content=dailyCashbookToolText(e.fixture);
    const text=e.answer+'\nSổ quỹ đã vào sổ tháng 07/2026: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ trên 31 ngày có phát sinh.\n2 ngày gần nhất (tối đa 20 dòng):\nNgày 2026-07-20: thu 9.000 đ, chi 2.000 đ, ròng 7.000 đ.';
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,text))).not.toThrow();
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,text.replace('31 ngày','2 ngày')))).toThrow();
    expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,text.replace('2 ngày gần nhất','31 ngày gần nhất')))).toThrow();
  });
  it('reconstructs exact empty text and proves an explicit empty report independently',()=>{
    const e=dailyEvidence(),p=structuredClone(dailyPayload);p.theo_ngay=[];p.so_luong=0;p.tong_hop={tong_thu:0,tong_chi:0,rong:0,so_ngay_co_phat_sinh:0,phieu_han_che_bi_loai:0};
    e.fixture=bindIncomeApprovalScenario(e.scenario,{...e.fixture,dailyCashbook:{request:dailyRequest,payload:p}});
    expect(dailyCashbookToolText(e.fixture)).toBe('2026-07-01 → 2026-07-31: không có phát sinh nào trong sổ quỹ bạn được xem.');
    e.reads[1].payload=p;e.rounds[1].messages[2].content=dailyCashbookToolText(e.fixture);
    const original=e.answer;
    for(const statement of ['Sổ quỹ tháng 07/2026: không có phát sinh.','Sổ quỹ tháng 07/2026: chưa có phát sinh.','2026-07-01 → 2026-07-31: không có phát sinh nào trong sổ quỹ bạn được xem.'])expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,original+'\n'+statement))).not.toThrow();
  });
  it('matches the product whole-dong rendering for finite fractional report values',()=>{
    const e=dailyEvidence(),p=structuredClone(dailyPayload);p.tong_hop.tong_thu=9000.4;p.tong_hop.rong=p.tong_hop.tong_thu-p.tong_hop.tong_chi;
    e.fixture=bindIncomeApprovalScenario(e.scenario,{...e.fixture,dailyCashbook:{request:dailyRequest,payload:p}});
    expect(dailyCashbookToolText(e.fixture)).toBe(dailyText);
  });
  it.each(['C35','C36'])('does not allow C34 supplementary tools in %s',id=>{
    const e=incomeEvidence(id),calls=inspectModelStream(e.rounds[0].body).tools;calls.push({id:'daily-1',name:'bao_cao_thu_chi_theo_ngay',arguments:'{"ky":"2026-07"}'});setDailyCalls(e,calls);expect(()=>assertIncomeApprovalResult(e)).toThrow();
  });
});

it('C34 keeps a preflighted daily fixture optional when only the primary was actually called',()=>{
  const e=dailyEvidence(),calls=inspectModelStream(e.rounds[0].body).tools;setDailyCalls(e,[calls[0]]);e.reads.pop();e.rounds[1].messages.pop();expect(()=>assertIncomeApprovalResult(e)).not.toThrow();
});
it('C34 daily exemption rejects missing or drifting binding digests',()=>{
  for(const key of ['dailyCashbookQueryDigest','dailyCashbookResponseDigest'] as const) {
    const f=dailyEvidence().fixture;f.attestation[key]='c'.repeat(64);expect(isIncomeApprovalReadonlyRequest(f,'https://demo','POST','https://demo/rest/v1/rpc/copilot_report_daily_cashbook_v1')).toBe(false);
    delete f.attestation[key];expect(isIncomeApprovalReadonlyRequest(f,'https://demo','POST','https://demo/rest/v1/rpc/copilot_report_daily_cashbook_v1')).toBe(false);
  }
});

it('C34 validates daily report navigation in the stream after mounted text strips link destinations',()=>{
  for(const route of ['/reports/finance/daily-cashbook','/reports/finance/daily-cashbook/private']) {
    const e=dailyEvidence(),text=e.answer+'\n[link: '+route+']';changeIncomeAnswer(e,text);e.answer=renderedAssistantText(text);
    if(route==='/reports/finance/daily-cashbook')expect(()=>assertIncomeApprovalResult(e)).not.toThrow();
    else expect(()=>assertIncomeApprovalResult(e)).toThrow(/identity/);
  }
});

describe('C34 report date scope',()=>{
  it.each([
    'Sổ quỹ 2026-07-31 → 2026-07-01: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
    'Sổ quỹ ngày 2026-07-01: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
    'Sổ quỹ ngày 2026-07-20: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
    'Sổ quỹ 2026-07-01, 2026-07-31: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
  ])('rejects misplaced period totals: %s',statement=>{
    const e=dailyEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+'\n'+statement))).toThrow(/daily cashbook facts/);
  });
  it.each([
    'Sổ quỹ 2026-07-01 → 2026-07-31: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
    'Sổ quỹ tháng 07/2026: thu 9.000 đ, chi 17.000 đ, ròng -8.000 đ.',
    'Sổ quỹ ngày 2026-07-20: thu 9.000 đ, chi 2.000 đ, ròng 7.000 đ.',
    'Ngày 2026-07-19: thu 0 đ, chi 15.000 đ, ròng -15.000 đ.',
  ])('accepts independently scoped report facts: %s',statement=>{
    const e=dailyEvidence();expect(()=>assertIncomeApprovalResult(changeIncomeAnswer(e,e.answer+'\n'+statement))).not.toThrow();
  });
});
