import { describe, expect, it, vi } from 'vitest';
import GoldenReporter from '../../../.e2e-fleet/goldenReporter';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import { readFileSync } from 'node:fs';
import { digest, DEMO_ORG } from '../../../scripts/copilot-golden-browser-evidence.mjs';

// Controlled canonical transport data only; these are never live fixture receipts.
import * as binder from '../../../scripts/copilot-financial-read-fixtures.mjs';
import * as oracle from '../../../.e2e-fleet/specs/copilotFinancialReadOracle';
const statsRpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: statsRpc } }));
const { TOOL_NGHIEP_VU } = await import('../tools/nghiepVuTools');
const scenario = (id: string) => JSON.parse(readFileSync('tooling/copilot-golden-scenarios.json','utf8')).cases.find((c:{id:string})=>c.id===id);
const actorDigest = 'b'.repeat(64);
const invoice = {id:'aaaa4000-0000-4000-8000-000000000081',invoice_number:'INV-G701',billing_month:'2026-07',total_amount:12000,status:'UNPAID',building_id:'aaaa4000-0000-4000-8000-000000000082',building_name:'DEMO Toà A',room_id:'aaaa4000-0000-4000-8000-000000000083',room_name:'G701'};
const pnl = {month:'2026-07-01',building_id:invoice.building_id,building_name:invoice.building_name,is_virtual:false,revenue:18000,expense:7000,net:11000};
const stats = {total_amount:12000,total_paid:2000,total_remaining:10000,total_refunded:0,total_count:1,rent_amount:9000,electric_amount:1000,water_amount:1000,pdv_amount:1000,total_collected:2000,payment_tm:1000,payment_tk:1000,payment_tt:0,payment_ct:0,change_amount:0,deposit_collected:0};
const ids=['C03','C05','C15','C17','C19','C24','C26'];
describe('independent stats transport matches the registered tool', () => {
  it.each(['C19', 'C26'])('derives exact %s bytes independently, including reordered RPC keys', async id => {
    for (const reverse of [false, true]) {
      const v = input(id);
      if (reverse) v.roles.stats.payload = Object.fromEntries(Object.entries(v.roles.stats.payload).reverse());
      const fixture = binder.bindFinancialReadScenario(scenario(id), v);
      statsRpc.mockResolvedValue({ data: v.roles.stats.payload, error: null });
      const actual = await TOOL_NGHIEP_VU.find(t => t.name === 'cong_no_tong_quan')!.execute(
        { thang: v.roles.stats.request.args.p_billing_month },
        { organizationId: DEMO_ORG, perms: undefined, threadId: null, generation: 0, isSuperAdmin: false },
      );
      expect(actual).toBe(oracle.financialToolText(fixture, 'stats'));
    }
  });
});
function input(id:string) {
  const period=['C15','C19'].includes(id)?'2099-01':'2026-07';
  const roles:Record<string,{request:{rpc:string;args:Record<string,unknown>};payload:unknown}>={};
  if(['C03','C15','C24','C26'].includes(id))roles.invoice={request:{rpc:'copilot_invoice_search_v1',args:{p_organization_id:DEMO_ORG,p_billing_month:period,p_payment_status:id==='C15'?'partial':'unpaid'}},payload:id==='C15'?[]:[structuredClone(invoice)]};
  if(['C05','C17','C24'].includes(id))roles.pnl={request:{rpc:'copilot_financial_pnl_v1',args:{p_organization_id:DEMO_ORG,p_start_date:'2026-07-01',p_end_date:'2026-07-31',p_accrual:id==='C17'}},payload:[structuredClone(pnl)]};
  if(['C19','C26'].includes(id))roles.stats={request:{rpc:'copilot_invoice_stats_v1',args:{p_organization_id:DEMO_ORG,p_billing_month:period}},payload:id==='C19'?Object.fromEntries(Object.keys(stats).map(k=>[k,0])):structuredClone(stats)};
  return {organizationId:DEMO_ORG,actorDigest,appOrigin:'https://golden.example',apiOrigin:'https://demo.supabase.co',roles};
}
describe('financial canonical binder',()=>{
  it.each(ids)('binds the literal period and full role payload for %s',id=>{
    const b=binder.bindFinancialReadScenario(scenario(id),input(id));
    expect(b.prompt).toBe(scenario(id).prompt);expect(b.attestation.organizationId).toBe(DEMO_ORG);
    expect(b.attestation.actorDigest).toBe(actorDigest);
    for(const [role,value] of Object.entries(input(id).roles))expect(b.attestation.roles[role].responseDigest).toBe(digest(value.payload));
  });
  it('rejects missing/extra roles, wrong actor/org, arguments, month and empty positive data',()=>{
    const changes=[v=>{v.organizationId='other'},v=>{v.actorDigest='wrong'},v=>{delete v.roles.invoice},v=>{v.roles.other=v.roles.invoice},v=>{v.roles.invoice.request.args.p_search=null},v=>{v.roles.invoice.request.args.p_billing_month='2026-08'},v=>{v.roles.invoice.payload=[]},v=>{v.roles.invoice.payload[0].billing_month='2026-08'},v=>{v.roles.invoice.payload[0].status='CANCELLED'},v=>{v.roles.invoice.payload[0].total_amount=Infinity},v=>{delete v.roles.invoice.payload[0].room_id},v=>{v.roles.invoice.payload[0].extra=1}];
    for(const mutate of changes){const v=input('C24');mutate(v);expect(()=>binder.bindFinancialReadScenario(scenario('C24'),v)).toThrow('fixture_unbound');}
  });
  it('requires exact empty schemas and a numeric count independent of money',()=>{
    for(const payload of [null,[],{},stats,{...Object.fromEntries(Object.keys(stats).map(k=>[k,0])),total_count:'0'}]){
      const v=input('C19');v.roles.stats.payload=payload;expect(()=>binder.bindFinancialReadScenario(scenario('C19'),v)).toThrow('fixture_unbound');
    }
    const v=input('C15');v.roles.invoice.payload=[{...invoice,billing_month:'2099-01',status:'PARTIAL_PAID'}];expect(()=>binder.bindFinancialReadScenario(scenario('C15'),v)).toThrow('fixture_unbound');
  });
  it('accepts every exact zero object key order but binds the original response bytes',()=>{
    const v=input('C19');v.roles.stats.payload=Object.fromEntries(Object.entries(v.roles.stats.payload).reverse());
    const b=binder.bindFinancialReadScenario(scenario('C19'),v);
    expect(binder.validFinancialReadAttestation('C19',b.attestation,actorDigest)).toBe(true);
    expect(b.attestation.roles.stats!.responseDigest).toBe(digest(v.roles.stats.payload));
  });
  it('rejects P&L basis/date swaps, invalid net, duplicate building identities and empty accrual',()=>{
    for(const mutate of [v=>{v.roles.pnl.request.args.p_accrual=false},v=>{v.roles.pnl.request.args.p_end_date='2026-07-30'},v=>{v.roles.pnl.payload[0].net=11001},v=>{v.roles.pnl.payload.push(v.roles.pnl.payload[0])},v=>{v.roles.pnl.payload=[]}]){
      const v=input('C17');mutate(v);expect(()=>binder.bindFinancialReadScenario(scenario('C17'),v)).toThrow('fixture_unbound');
    }
  });
  it('compares decimal P&L arithmetic exactly and renders VND with whole-dong rounding',()=>{
    const v=input('C05');Object.assign(v.roles.pnl.payload[0],{revenue:0.3,expense:0.1,net:0.2});
    const b=binder.bindFinancialReadScenario(scenario('C05'),v);
    expect(oracle.financialToolText(b,'pnl')).toContain('doanh thu 0 đ, chi phí 0 đ, lợi nhuận 0 đ');
    v.roles.pnl.payload[0].net=0.200000001;expect(()=>binder.bindFinancialReadScenario(scenario('C05'),v)).toThrow();
  });
});

const invoiceText='Tìm thấy 1 hoá đơn (hiện 10 đầu):\n- HĐ INV-G701 — phòng G701 (DEMO Toà A) — kỳ 2026-07 — tổng 12.000 đ — trạng thái UNPAID';
const pnlText=(accrual=false)=>`KQKD tháng 2026-07 (${accrual?'dồn tích':'tiền mặt'}):\nTỔNG: doanh thu 18.000 đ, chi phí 7.000 đ, lợi nhuận 11.000 đ\n- DEMO Toà A: thu 18.000 đ, chi 7.000 đ, ròng 11.000 đ`;
const statsText=(empty=false)=>`Thống kê hoá đơn kỳ ${empty?'2099-01':'2026-07'}: ${empty?'0':'1'} hóa đơn.\nTổng phải thu: ${empty?'0':'12.000'} đ; đã trả: ${empty?'0':'2.000'} đ; còn nợ: ${empty?'0':'10.000'} đ.\n${empty?'Không có hóa đơn và không có công nợ trong phạm vi truy vấn này.\n':''}- total_amount: ${empty?'0':'12.000'} đ\n- total_paid: ${empty?'0':'2.000'} đ\n- total_remaining: ${empty?'0':'10.000'} đ\n- total_refunded: 0 đ\n- total_count: ${empty?'0':'1'}\n- rent_amount: ${empty?'0':'9.000'} đ\n- electric_amount: ${empty?'0':'1.000'} đ\n- water_amount: ${empty?'0':'1.000'} đ\n- pdv_amount: ${empty?'0':'1.000'} đ\n- total_collected: ${empty?'0':'2.000'} đ\n- payment_tm: ${empty?'0':'1.000'} đ\n- payment_tk: ${empty?'0':'1.000'} đ\n- payment_tt: 0 đ\n- payment_ct: 0 đ\n- change_amount: 0 đ\n- deposit_collected: 0 đ`;
const statsAnswer=(empty=false)=>`Công nợ kỳ ${empty?'2099-01':'2026-07'}: ${empty?'0':'1'} hóa đơn.\nTổng phải thu: ${empty?'0':'12.000'} đ; đã trả: ${empty?'0':'2.000'} đ; còn nợ: ${empty?'0':'10.000'} đ.${empty?' Không có hóa đơn và không có công nợ.':''}`;
const chunk=(delta:object,finish_reason:string)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\ndata: [DONE]\n\n`;
function financialEvidence(id='C24',reverse=false) {
  const fixture=binder.bindFinancialReadScenario(scenario(id),input(id));
  const definitions=[...(fixture.roles.invoice?[{role:'invoice',name:'tim_hoa_don',args:{thang:id==='C15'?'2099-01':'2026-07',trang_thai:id==='C15'?'partial':'unpaid'},text:id==='C15'?'Không tìm thấy hoá đơn nào khớp điều kiện.':invoiceText}]:[]),...(fixture.roles.pnl?[{role:'pnl',name:'doanh_thu_thang',args:{thang:'2026-07',accrual:id==='C17'},text:pnlText(id==='C17')}]:[]),...(fixture.roles.stats?[{role:'stats',name:'cong_no_tong_quan',args:{thang:id==='C19'?'2099-01':'2026-07'},text:statsText(id==='C19')}]:[])];
  if(reverse)definitions.reverse();
  const calls=definitions.map((d,index)=>({index,id:`financial-${d.role}`,function:{name:d.name,arguments:JSON.stringify(d.args)}}));
  const answer=definitions.map(d=>d.role==='stats'?statsAnswer(id==='C19'):id==='C15'?'Không tìm thấy hóa đơn thanh toán một phần (partial) kỳ 2099-01.':d.text).join('\n');
  return {scenario:scenario(id),fixture,actorDigest,prompt:fixture.prompt,answer,
    rounds:[{body:chunk({tool_calls:calls},'tool_calls'),messages:[{role:'user',content:fixture.prompt}]},{body:chunk({content:answer},'stop'),messages:[{role:'user',content:fixture.prompt},...definitions.map(d=>({role:'tool',tool_call_id:`financial-${d.role}`,content:d.text}))]}],
    reads:definitions.map(d=>({...fixture.roles[d.role].request,payload:fixture.roles[d.role].payload,status:200,actorDigest,exactEndpoint:true,modelRound:0})),businessWrites:0,networkErrors:0,consoleErrors:0};
}
function withAnswer(e:ReturnType<typeof financialEvidence>,answer:string) { e.answer=answer;e.rounds.at(-1)!.body=chunk({content:answer},'stop');return e; }
describe('financial fact diagnostics',()=>{
  it.each([
    ['C15','period_required','missing',(s:string)=>s.replace('2099-01','')],
    ['C15','period_conflict','mismatch',(s:string)=>s+' 2026-07'],
    ['C15','link_forbidden','unsupported',(s:string)=>s+' https://private.test'],
    ['C15','atom_marker_forbidden','unsupported',(s:string)=>s+' factatom'],
    ['C15','claim_binding','unsupported',(s:string)=>s+' Tổng phải thu: 0 đ.'],
    ['C19','claim_money','mismatch',(s:string)=>s+' Tiền điện: 1 đ.'],
    ['C19','claim_count','unit',(s:string)=>s+' Số hóa đơn: 0 đ.'],
    ['C19','claim_count','mismatch',(s:string)=>s+' Số hóa đơn: 1.'],
    ['C15','claim_limit','mismatch',(s:string)=>s+' (hiện 10 đầu)'],
    ['C19','absence_required','missing',(s:string)=>s.replace(' Không có hóa đơn và không có công nợ.','')],
    ['C15','partial_scope_required','missing',(s:string)=>s.replace('thanh toán một phần (partial) ','')],
    ['C19','empty_count','missing',(s:string)=>s.replace('0 hóa đơn','')],
    ['C19','empty_due','missing',(s:string)=>s.replace('Tổng phải thu: 0 đ; ','')],
    ['C19','empty_paid','missing',(s:string)=>s.replace('đã trả: 0 đ; ','')],
    ['C19','empty_remaining','missing',(s:string)=>s.replace('còn nợ: 0 đ.','')],
    ['C19','empty_debt_absence','missing',(s:string)=>s.replace(' và không có công nợ','')],
  ] as const)('reports first failure %s %s without changing rejection',(id,factRule,failureKind,change)=>{
    const e=financialEvidence(id);let caught:unknown;
    try{oracle.assertFinancialReadResult(withAnswer(e,change(e.answer)));}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(Error);expect((caught as Error).message).toBe('financial_facts');
    expect(oracle.financialReadDiagnostic(id,caught)).toEqual({caseId:id,code:'financial_facts',factRule,failureKind});
  });
  it.each([
    [' Có dữ liệu.',false,false,true],[' 9',true,false,false],[' $',false,true,false],[' ９',false,false,true],
  ] as const)('reports only residual categories for %s',(addition,hasResidualDigits,hasResidualCurrency,hasResidualWords)=>{
    const e=financialEvidence('C15');let caught:unknown;
    try{oracle.assertFinancialReadResult(withAnswer(e,e.answer+addition));}catch(error){caught=error;}
    expect(oracle.financialReadDiagnostic('C15',caught)).toEqual({caseId:'C15',code:'financial_facts',factRule:'residual_grammar',failureKind:'unsupported',hasResidualDigits,hasResidualCurrency,hasResidualWords});
  });
  it('forwards exact diagnostic shapes and rejects arbitrary or misplaced fields',()=>{
    const valid=[{caseId:'C15',code:'financial_facts',factRule:'period_required',failureKind:'missing'},
      {caseId:'C19',code:'financial_facts',factRule:'residual_grammar',failureKind:'unsupported',hasResidualDigits:false,hasResidualCurrency:false,hasResidualWords:true},
      {caseId:'C15',code:'financial_facts'},{caseId:'C03',code:'financial_payload'}];
    const denied=[...['answer','message','stack','token','args','amount','url'].map(key=>({...valid[0],[key]:'private'})),
      {...valid[0],caseId:'C02'},{...valid[0],code:'financial_payload'},{...valid[0],factRule:'private prose'},
      {...valid[0],factRule:'__proto__'},{...valid[0],failureKind:'private prose'}, {...valid[0],failureKind:'mismatch'},
      {...valid[0],hasResidualWords:true},{...valid[1],hasResidualDigits:'false'},{...valid[1],hasResidualWords:undefined},
      {...valid[1],hasResidualWords:false},{...valid[0],failureKind:undefined},
      {caseId:'C15',code:'financial_facts',factRule:'residual_grammar',failureKind:'unsupported'}];
    const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
    try{
      new GoldenReporter().onTestEnd({} as TestCase,{status:'failed',stdout:[[...valid,...denied].map(x=>JSON.stringify(x)).join('\n')]} as TestResult);
      expect(log.mock.calls).toEqual([...valid.map(v=>[JSON.stringify(v)]),['golden browser: failed']]);
    }finally{log.mockRestore();}
    expect(oracle.financialReadDiagnostic('C15',new Error('financial_facts'))).toBeUndefined();
    expect(oracle.financialReadDiagnostic('C15',{code:'financial_facts',factRule:'period_required',failureKind:'missing'})).toBeUndefined();
  });
});
describe('independent financial oracle',()=>{
  it.each([
    ['C05','Doanh thu: 7.000 đ.'],['C05','Doanh thu: 7.000.'],['C05','Chi phí: 18.000 đ.'],
    ['C26','Tiền điện: 1 đ.'],['C26','Tiền điện: 1.'],['C26','Tiền nước: 9.000 đ.'],
    ['C05','DEMO Toà B: thu 18.000 đ, chi 7.000 đ, ròng 11.000 đ.'],
    ['C05','Tòa nhà Bí Mật.'],['C03','Hóa đơn INV-UNKNOWN.'],['C26','Khách hàng Nguyễn Bình.'],
    ['C15','Khách hàng Nguyễn Bình.'],['C15','Có dữ liệu.'],['C15','Đã tìm thấy kết quả.'],
    ['C19','Có dữ liệu.'],['C19','Có thông tin hóa đơn.'],['C19','Khách hàng Nguyễn Bình.'],
    ['C03','Hóa đơn invoiceatom.'],['C05','Tòa buildingatom: thu 18.000 đ.'],
    ['C05','18.000 đ.'],['C05','Doanh thu: 18.000 USD.'],['C26','Số hóa đơn: 1 đ.'],
  ])('R1 rejects an unsupported extra claim after a correct %s answer: %s',(id,addition)=>{
    const e=financialEvidence(id);expect(()=>oracle.assertFinancialReadResult(withAnswer(e,e.answer+'\n'+addition))).toThrow('financial_facts');
  });
  it.each([
    ['C05','Doanh thu: 18.000 đ. Chi phí: 7.000. Lợi nhuận: 11.000 đ.'],
    ['C05','DEMO Toà A: doanh thu 18.000 đ.'],
    ['C26','Tiền điện: 1.000 đ; tiền nước: 1.000; tiền thuê: 9.000 đ.'],
    ['C24','Dưới đây là kết quả theo dữ liệu hệ thống. Doanh thu: 18.000 đ.'],
    ['C15','Bạn vui lòng kiểm tra lại kỳ hoặc trạng thái hóa đơn.'],
    ['C15','Không có dữ liệu hóa đơn khớp điều kiện.'],
    ['C19','Theo dữ liệu hiện có, không có công nợ trong kỳ này.'],
    ['C15','Hóa đơn kỳ 2099-01 trạng thái partial: Không tìm thấy hóa đơn nào khớp điều kiện.'],
    ['C03','Danh sách hóa đơn chưa thu tháng 2026-07:'],
    ['C05','Các số liệu trên được lấy từ dữ liệu hệ thống.'],
  ])('R1 retains ordinary grounded or clarification prose for %s: %s',(id,addition)=>{
    const e=financialEvidence(id);expect(()=>oracle.assertFinancialReadResult(withAnswer(e,e.answer+'\n'+addition))).not.toThrow();
  });
  it('R1 binds repeated financial values to their particular building',()=>{
    const v=input('C05');v.roles.pnl.payload=[pnl,{...pnl,building_id:'aaaa4000-0000-4000-8000-000000000099',building_name:'DEMO Toà B',revenue:7000,expense:2000,net:5000}];
    const e=financialEvidence('C05');e.fixture=binder.bindFinancialReadScenario(scenario('C05'),v);e.reads[0].payload=structuredClone(v.roles.pnl.payload);
    const text='KQKD tháng 2026-07 (tiền mặt):\nTỔNG: doanh thu 25.000 đ, chi phí 9.000 đ, lợi nhuận 16.000 đ\nDEMO Toà A: thu 18.000 đ, chi 7.000 đ, ròng 11.000 đ\nDEMO Toà B: thu 7.000 đ, chi 2.000 đ, ròng 5.000 đ';
    e.rounds[1].messages[1].content=text.replace('\nDEMO','\n- DEMO').replace('\nDEMO','\n- DEMO');withAnswer(e,text);
    expect(()=>oracle.assertFinancialReadResult(e)).not.toThrow();
    expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),text+'\nDEMO Toà A: doanh thu 18.000 đ.'))).not.toThrow();
    expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),text+'\nDEMO Toà A: doanh thu 7.000 đ.'))).toThrow('financial_facts');
    expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),text+'\nDoanh thu: 18.000 đ.'))).toThrow('financial_facts');
  });
  it('forwards only financial family static diagnostics through the privacy boundary',()=>{
    const valid=ids.map(caseId=>({caseId,code:'financial_payload'}));
    const denied=[{caseId:'C02',code:'financial_payload'},{caseId:'C03',code:'private-payload'},{caseId:'C03',code:'financial_payload',args:{secret:'private'}},{caseId:'C03',code:'financial_payload',message:'private'},{caseId:'C03',code:123},{caseId:'C03',code:'__proto__'}];
    const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
    try{
      new GoldenReporter().onTestEnd({} as TestCase,{status:'failed',stdout:[[...valid,...denied].map(x=>JSON.stringify(x)).join('\n')+'\nprivate assertion payload\n']} as TestResult);
      expect(log.mock.calls).toEqual([...valid.map(v=>[JSON.stringify(v)]),['golden browser: failed']]);
    }finally{log.mockRestore();}
  });
  it.each(ids)('accepts complete linked canonical evidence for %s',id=>expect(()=>oracle.assertFinancialReadResult(financialEvidence(id))).not.toThrow());
  it.each(['C24','C26'])('accepts either simultaneous role order for %s',id=>expect(()=>oracle.assertFinancialReadResult(financialEvidence(id,true))).not.toThrow());
  it('uses the actual formatter bytes while keeping total_count a count in the answer',()=>{
    for(const id of ['C19','C26']){const e=financialEvidence(id);expect(oracle.financialToolText(e.fixture,'stats')).toBe(statsText(id==='C19'));expect(()=>oracle.assertFinancialReadResult(withAnswer(e,e.answer.replace(`${id==='C19'?'0':'1'} hóa đơn`,`${id==='C19'?'0':'1'} đ hóa đơn`)))).toThrow();}
  });
  it('rejects every missing branch, duplicated role/call ID, unlinked result and third tool',()=>{
    for(const id of ['C24','C26'])for(const mutate of [e=>{e.reads.pop()},e=>{e.reads.push(e.reads[0])},e=>{e.rounds[1].messages.pop()},e=>{e.rounds[1].messages[1].tool_call_id='unlinked'},e=>{e.rounds[0].body=e.rounds[0].body.replace('financial-invoice','financial-stats')},e=>{e.rounds[0].body=chunk({tool_calls:[{index:0,id:'x',function:{name:'cong_no_tong_quan',arguments:'{"thang":"2026-07"}'}}]},'tool_calls')},e=>{e.reads[0].modelRound=1}]){
      const e=financialEvidence(id);mutate(e);expect(()=>oracle.assertFinancialReadResult(e)).toThrow();
    }
  });
  it('rejects actor/origin/http/read/write/network/mount/prompt drift',()=>{
    for(const mutate of [e=>{e.actorDigest='c'.repeat(64)},e=>{e.reads[0].actorDigest='c'.repeat(64)},e=>{e.reads[0].exactEndpoint=false},e=>{e.reads[0].status=201},e=>{e.businessWrites=1},e=>{e.networkErrors=1},e=>{e.consoleErrors=1},e=>{e.answer+=' drift'},e=>{e.prompt+=' '},e=>{e.reads[0].args.p_search=null},e=>{e.reads[0].payload[0].total_amount=13000}]){const e=structuredClone(financialEvidence());mutate(e);expect(()=>oracle.assertFinancialReadResult(e)).toThrow();}
  });
  it('rejects invoice identity/location/period/amount/status and P&L basis/amount answer corruption',()=>{
    const e=financialEvidence();
    for(const [from,to] of [['INV-G701','INV-WRONG'],['phòng G701','phòng X999'],['DEMO Toà A','DEMO Toà B'],['2026-07','2026-08'],['12.000','13.000'],['UNPAID','PAID'],['tiền mặt','dồn tích'],['18.000','19.000'],['7.000','8.000'],['11.000','10.000'],['1 hoá đơn','2 hoá đơn']])expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),e.answer.replace(from,to)))).toThrow();
    expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),invoiceText))).toThrow();
    expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),pnlText()))).toThrow();
  });
  it('rejects contradictory empty conclusions and debt inferred by summing invoice totals',()=>{
    for(const id of ['C15','C19']){const e=financialEvidence(id);expect(()=>oracle.assertFinancialReadResult(withAnswer(e,e.answer+' Có 1 hóa đơn còn nợ 12.000 đ.'))).toThrow();}
    const e=financialEvidence('C26');expect(()=>oracle.assertFinancialReadResult(withAnswer(e,e.answer.replace('còn nợ: 10.000','còn nợ: 12.000')))).toThrow();
  });
  it('classifies only selected roles with exact origin, endpoint, method and argument keys',()=>{
    const f=financialEvidence('C24').fixture,api='https://demo.supabase.co',url=`${api}/rest/v1/rpc/copilot_invoice_search_v1`,args=f.roles.invoice!.request.args;
    expect(oracle.classifyFinancialRead(f,api,'POST',url,args)).toBe('invoice');
    expect(oracle.classifyFinancialRead(undefined,api,'POST',url,args)).toBeUndefined();
    for(const [method,resource,body] of [['GET',url,args],['POST',url+'?x=1',args],['POST',url+'#x',args],['POST',url+'/',args],['POST',url.replace('demo.supabase.co','other.example'),args],['POST',url,{...args,p_search:null}],['POST',url,{...args,p_organization_id:'other'}],['POST',`${api}/rest/v1/rpc/copilot_invoice_stats_v1`,{p_organization_id:DEMO_ORG,p_billing_month:'2026-07'}]] as Array<[string,string,unknown]>)expect(oracle.classifyFinancialRead(f,api,method,resource,body)).toBeUndefined();
  });
  it.each(['C24','C26'])('accepts sequential calls only when both linked results reach the final round: %s',id=>{
    const e=financialEvidence(id),messages=e.rounds[1].messages;
    const definitions=JSON.parse(e.rounds[0].body.split('\n')[0].slice(6)).choices[0].delta.tool_calls;
    e.rounds=[{...e.rounds[0],body:chunk({tool_calls:[definitions[0]]},'tool_calls')},{body:chunk({tool_calls:[{...definitions[1],index:0}]},'tool_calls'),messages:messages.slice(0,2)},e.rounds[1]];
    e.reads[1].modelRound=1;expect(()=>oracle.assertFinancialReadResult(e)).not.toThrow();
    e.rounds[2].messages=e.rounds[2].messages.filter(m=>m!==messages[1]);expect(()=>oracle.assertFinancialReadResult(e)).toThrow();
  });
  it('rejects every stats payload field drift including fields not rendered as currency',()=>{
    for(const field of Object.keys(stats)){
      const e=financialEvidence('C26');e.reads=e.reads.map(r=>structuredClone(r));e.reads.find(r=>r.rpc==='copilot_invoice_stats_v1')!.payload[field]+=1;
      expect(()=>oracle.assertFinancialReadResult(e)).toThrow('financial_payload');
    }
  });
  it('binds every invoice identity, location, period, money and status byte',()=>{
    for(const [field,value] of Object.entries(invoice)){
      const e=financialEvidence('C03');e.reads=e.reads.map(r=>structuredClone(r));
      e.reads[0].payload[0][field]=typeof value==='number'?value+1:value+'changed';
      expect(()=>oracle.assertFinancialReadResult(e)).toThrow('financial_payload');
    }
  });
  it('binds all P&L building and monetary fields independently from the answer',()=>{
    for(const [field,value] of Object.entries(pnl)){
      const e=financialEvidence('C17');e.reads=e.reads.map(r=>structuredClone(r));
      e.reads[0].payload[0][field]=typeof value==='number'?value+1:typeof value==='boolean'?!value:value+'changed';
      expect(()=>oracle.assertFinancialReadResult(e)).toThrow('financial_payload');
    }
  });
  it('binds full invoice order/count and hidden rows while requiring a first-ten disclosure',()=>{
    const v=input('C03');v.roles.invoice.payload=Array.from({length:11},(_,i)=>({...invoice,id:`aaaa4000-0000-4000-8000-${String(81+i).padStart(12,'0')}`,invoice_number:`INV-L${i}`,room_name:`L${i}`}));
    const e=financialEvidence('C03');e.fixture=binder.bindFinancialReadScenario(scenario('C03'),v);e.reads[0].payload=structuredClone(v.roles.invoice.payload);
    // One-row formatter bytes are independently pinned above; this setup tests
    // the server's full result against the formatter's ten-row display limit.
    const text=oracle.financialToolText(e.fixture,'invoice');e.rounds[1].messages[1].content=text;withAnswer(e,text);
    expect(()=>oracle.assertFinancialReadResult(e)).not.toThrow();
    for(const mutate of [r=>r.payload.reverse(),r=>r.payload.pop(),r=>{r.payload[10].total_amount+=1}]){const bad=structuredClone(e);mutate(bad.reads[0]);expect(()=>oracle.assertFinancialReadResult(bad)).toThrow('financial_payload');}
    expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),text.replace('(hiện 10 đầu)','(danh sách đầy đủ)')))).toThrow('financial_facts');
  });
  it('rejects optional raw statistics claims whose typed value contradicts the response',()=>{
    for(const [field,value] of Object.entries(stats)){
      const e=financialEvidence('C26');
      expect(()=>oracle.assertFinancialReadResult(withAnswer(e,e.answer+`\n${field}: ${value===0?12000:0}`))).toThrow();
    }
  });
  it('materializes only the declared cash default and rejects defaulting an accrual call',()=>{
    for(const id of ['C05','C17']){
      const e=financialEvidence(id),call={index:0,id:'financial-pnl',function:{name:'doanh_thu_thang',arguments:'{"thang":"2026-07"}'}};
      e.rounds[0].body=chunk({tool_calls:[call]},'tool_calls');
      if(id==='C05')expect(()=>oracle.assertFinancialReadResult(e)).not.toThrow();else expect(()=>oracle.assertFinancialReadResult(e)).toThrow();
    }
  });
  it('rejects a third business tool even if both financial results remain linked',()=>{
    const e=financialEvidence(),calls=JSON.parse(e.rounds[0].body.split('\n')[0].slice(6)).choices[0].delta.tool_calls;
    calls.push({index:2,id:'extra',function:{name:'cong_no_tong_quan',arguments:'{"thang":"2026-07"}'}});
    e.rounds[0].body=chunk({tool_calls:calls},'tool_calls');expect(()=>oracle.assertFinancialReadResult(e)).toThrow();
  });
  it('rejects negated or conditional positive facts and contradictory later period claims',()=>{
    const e=financialEvidence();
    for(const text of [e.answer.replace('(tiền mặt)','(không phải tiền mặt)'),e.answer.replace('trạng thái UNPAID','không phải trạng thái UNPAID'),e.answer+' Kỳ 2026-08 cũng có 1 hóa đơn.'])expect(()=>oracle.assertFinancialReadResult(withAnswer(structuredClone(e),text))).toThrow();
  });
});
