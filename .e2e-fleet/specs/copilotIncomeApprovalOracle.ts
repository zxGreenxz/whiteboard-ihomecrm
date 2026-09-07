import { digest, type GoldenScenario } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { bindIncomeApprovalScenario, type IncomeApprovalFixture, type VoucherRow, type PendingRow } from '../../scripts/copilot-income-approval-fixtures.mjs';
import { maskPii } from '../../src/copilot/maskPii';
import { inspectModelStream, renderedAssistantText, type ReadonlyEvidence } from './copilotSmokeOracle';

export interface IncomeApprovalRead { rpc:string; args:Record<string,unknown>; payload:unknown; ok:boolean; actorDigest:string }
export function isIncomeApprovalReadonlyRequest(fixture:IncomeApprovalFixture|undefined,origin:string,method:string,url:string):boolean {
  if(!fixture || method!=='POST' || !['copilot_income_expense_search_v1','copilot_pending_requests_v1'].includes(fixture.request.rpc))return false;
  const target=new URL(url);
  return target.origin===origin && target.pathname===`/rest/v1/rpc/${fixture.request.rpc}` && !target.search && !target.hash;
}
const MESSAGES = {
  financial_fixture_drift:'Financial fixture, actor or prompt drift',
  financial_model_cycle:'Incomplete financial model cycle',
  financial_mounted_answer:'Mounted answer differs from final stream',
  financial_tool_query:'Unexpected financial tool or query',
  financial_rpc_query:'Unexpected financial RPC, org or filters',
  financial_rpc_drift:'Financial RPC payload drift',
  financial_tool_result:'Missing or wrong linked financial tool result',
  financial_empty_answer:'Empty query needs explicit absence without invented facts',
  financial_identity:'Answer voucher identity differs from canonical payload',
  financial_money:'Answer voucher money differs from canonical fact',
  financial_type:'Answer voucher type differs from canonical fact',
  financial_status:'Answer voucher status differs from canonical fact',
  financial_maker:'Answer pending maker differs from canonical fact',
  financial_count:'Answer voucher count differs from canonical payload',
} as const;
export type IncomeApprovalOracleFailureCode = keyof typeof MESSAGES;
export function isIncomeApprovalOracleFailureCode(code:unknown):code is IncomeApprovalOracleFailureCode {
  return typeof code === 'string' && Object.hasOwn(MESSAGES,code);
}
const failures = new WeakSet<IncomeApprovalOracleFailure>();
export class IncomeApprovalOracleFailure extends Error {
  readonly code:IncomeApprovalOracleFailureCode;
  constructor(code:IncomeApprovalOracleFailureCode) {
    if (!isIncomeApprovalOracleFailureCode(code)) throw new TypeError('Invalid financial oracle failure code');
    super(MESSAGES[code]); this.name='IncomeApprovalOracleFailure'; this.code=code; failures.add(this); Object.freeze(this);
  }
}
export function incomeApprovalOracleDiagnostic(caseId:string,error:unknown):{caseId:string;code:IncomeApprovalOracleFailureCode}|undefined {
  if (['C34','C35','C36'].includes(caseId) && error instanceof IncomeApprovalOracleFailure && failures.has(error)) return {caseId,code:error.code};
}
export function incomeApprovalFixtureFailureReason(error:unknown):'fixture_unbound'|undefined {
  if(error instanceof IncomeApprovalOracleFailure && failures.has(error)
    && ['financial_fixture_drift','financial_rpc_drift'].includes(error.code))return 'fixture_unbound';
}
const check:(ok:unknown,code:IncomeApprovalOracleFailureCode)=>asserts ok = (ok,code)=>{if(!ok)throw new IncomeApprovalOracleFailure(code);};
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const sameArgs=(a:Record<string,unknown>,b:Record<string,unknown>)=>Object.keys(a).length===Object.keys(b).length && Object.entries(b).every(([k,v])=>a[k]===v);
const normalize=(s:string)=>s.normalize('NFC').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const identifierPattern=(id:string)=>`(?<![\\p{L}\\p{N}_/-])${escape(id)}(?![\\p{L}\\p{N}_/-])`;
const token=(text:string,id:string)=>new RegExp(identifierPattern(normalize(id)),'iu').test(text);
const identifier=(r:VoucherRow|PendingRow)=>r.ma_phieu ?? (r.phieu_id ?? (r as PendingRow).yeu_cau_id).slice(0,8);
const money=(n:number)=>`${new Intl.NumberFormat('vi-VN').format(n)} đ`;
const TYPE={INCOME:'THU',EXPENSE:'CHI'};
const APPROVAL={UNAPPROVED:'chờ duyệt',APPROVED:'đã duyệt',CANCELLED:'đã huỷ'};
const POSTING={UNPOSTED:'chưa vào sổ',POSTED:'đã vào sổ',REVERSED:'đã đảo bút toán',NOT_APPLICABLE:'không áp dụng'};
/** Exact product rendering, including its cashbook-only masking boundary.
 * Expected facts come from independently observed RPC responses, never prompts. */
export function incomeApprovalToolText(f:IncomeApprovalFixture):string {
  if (f.payload.phieu) {
    const rows=f.payload.phieu;
    if(!rows.length)return 'Không tìm thấy phiếu thu chi nào khớp điều kiện.';
    const lines=rows.map(r=>`- [${TYPE[r.loai]}] ${identifier(r)} — ${r.ten ?? '?'} — ${money(r.so_tien)} — ${r.ngay}`
      +`${r.hang_muc ? ` — ${r.hang_muc}`:''}${r.so_quy ? ` — sổ ${maskPii(r.so_quy)}`:''} — ${APPROVAL[r.trang_thai]}, ${POSTING[r.trang_thai_ghi_nhan]}${r.nguoi_tao ? ` — lập bởi ${r.nguoi_tao}`:''}`);
    return `${rows.length} phiếu thu chi (tối đa 20 dòng mỗi lần hỏi):\n${lines.join('\n')}\n[link: /income-expense]`;
  }
  const rows=f.payload.hop_cho!;
  const lines=rows.map(r=>`- [${TYPE[r.loai]}] ${identifier(r)} — ${r.ten_phieu ?? '?'} — ${money(r.so_tien)}${r.gui_luc ? ` — gửi ${r.gui_luc.slice(0,10)}`:''} — lập bởi ${r.nguoi_lap}`);
  return `${rows.length} phiếu đang chờ bạn duyệt (tối đa 20 dòng):\n${lines.join('\n')}\n[link: /approvals]`;
}
const NUMBER=String.raw`[-+]?\d+(?:[.,]\d+)*`;
const UNIT=String.raw`(?:triệu(?:\s*(?:đồng|đ|₫|vnd))?|(?:nghìn|ngàn|k)(?:\s*(?:đồng|đ|₫|vnd))?|đồng|vnd|đ|₫)`;
const MONEY=String.raw`(?<![\p{L}\p{N}.,])(${NUMBER})\s*(${UNIT})(?![\p{L}\p{N}])`;
function amount(value:string,unit=''):number {
  const multiplier=/triệu/iu.test(unit)?1e6:/nghìn|ngàn|^k/iu.test(unit)?1e3:1;
  return Number(multiplier===1?value.replace(/[.,]/g,''):value.replace(',','.'))*multiplier;
}
const amounts=(text:string)=>[...text.matchAll(new RegExp(MONEY,'giu'))].map(m=>amount(m[1],m[2]));
const MONEY_LABEL=String.raw`(?:(?:số\s*tiền|giá\s*trị)(?:\s*(?:của\s*)?phiếu)?|tiền\s*(?:thu|chi)|tổng(?:\s*(?:số tiền|tiền|cộng|thu|chi))?|thành tiền|số dư|đã thanh toán|còn lại)`;
function labeledAmounts(text:string):number[] {
  return [...text.matchAll(new RegExp(`${MONEY_LABEL}\\s*[:：|–—=-]?\\s*(${NUMBER})(?:\\s*(${UNIT}))?`,'giu'))].map(m=>amount(m[1],m[2]));
}
const STATUS_PATTERNS:Record<string,string>={
  UNAPPROVED:'(?:đang )?chờ (?:bạn |tôi |xét |phê )?duyệt|chưa (?:được |phê )?duyệt|\\bUNAPPROVED\\b|\\bPENDING_APPROVAL\\b',
  APPROVED:'(?:đã|được) (?:được |phê )?duyệt|\\bAPPROVED\\b',
  CANCELLED:'(?:đã )?h[ủu][yỷ]|\\bCANCELLED\\b',
  REJECTED:'(?:đã|bị) từ chối|\\bREJECTED\\b',
  UNPOSTED:'chưa (?:vào sổ|ghi sổ|hạch toán)|\\bUNPOSTED\\b',
  POSTED:'(?:đã|được) (?:vào sổ|ghi sổ|hạch toán)|\\bPOSTED\\b',
  REVERSED:'(?:đã )?đảo (?:bút toán|ghi sổ)|\\bREVERSED\\b',
  NOT_APPLICABLE:'không áp dụng|\\bNOT_APPLICABLE\\b',
};
function statusClaims(text:string):{state:string;negated:boolean}[] {
  const result:{state:string;negated:boolean}[]=[];
  for(const [state,pattern] of Object.entries(STATUS_PATTERNS)) {
    for(const m of text.matchAll(new RegExp(pattern,'giu'))) {
      const prefix=text.slice(0,m.index);
      if (/(?:nếu|khi|cần|muốn|có thể|sẽ)\s*(?:phiếu\s*)?$/iu.test(prefix)) continue;
      const negated=/(?:không|chưa)(?:\s+(?:được|đã|bị|phải)){0,2}\s*$/iu.test(prefix);
      result.push({state,negated});
    }
  }
  return result;
}
const states=(text:string)=>new Set(statusClaims(text).filter(c=>!c.negated).map(c=>c.state));
function assertStatus(text:string,expected:string[],required:boolean) {
  const actual=states(text);
  check(statusClaims(text).every(c=>c.negated ? !expected.includes(c.state) : expected.includes(c.state))
    && (!required || expected.every(s=>actual.has(s))),'financial_status');
}
function assertType(text:string,row:VoucherRow|PendingRow,required:boolean) {
  const asserted=[...text.matchAll(/(?:phiếu\s+|loại\s*[:：]?\s*|là\s+)(thu|chi)(?![\p{L}\p{N}])|\[(thu|chi)\]|(?<![\p{L}\p{N}])(income|expense)(?![\p{L}\p{N}])|(?:^|[|–—;,])\s*(thu|chi)\s*(?=$|[|–—;,])/giu)].map(m=>m[1]??m[2]??m[3]??m[4]);
  const expected=row.loai==='INCOME'?['thu','income']:['chi','expense'];
  check((!required || asserted.some(t=>expected.includes(t))) && asserted.every(t=>expected.includes(t)),'financial_type');
}
function assertMaker(text:string,row:VoucherRow|PendingRow) {
  const maker='nguoi_lap' in row?row.nguoi_lap:row.nguoi_tao;
  for(const m of text.matchAll(/(?:lập bởi|tạo bởi|người lập|người tạo)\s*[:：]?\s*/giu)) {
    check(maker && new RegExp(`^${identifierPattern(normalize(maker))}`,'iu').test(text.slice(m.index!+m[0].length)),'financial_maker');
  }
}
function assertFacts(answer:string,f:IncomeApprovalFixture) {
  let text=normalize(answer);
  const pending=Boolean(f.payload.hop_cho), rows=f.payload.phieu ?? f.payload.hop_cho!;
  const ids=rows.map(identifier);
  if(!rows.length) {
    check(/(?:không|chưa) (?:tìm thấy|có).*phiếu (?:thu chi|chi)|phiếu chi.*không (?:tồn tại|tìm thấy)/iu.test(text),'financial_empty_answer');
    check(!amounts(text).length && !labeledAmounts(text).length && !states(text).size,'financial_empty_answer');
    check(!/\b(?:PC|PT)[-_\d][\w-]*\b|\b[0-9a-f]{8}-[0-9a-f-]{27}\b|mã\s*phiếu\s*[:#]?\s*\S+|phiếu\s+(?:số|mã)\s*[:#]?\s*\S+/iu.test(text),'financial_empty_answer');
    check(!/(?:vài|nhiều|một số)\s*phiếu/iu.test(text),'financial_empty_answer');
  }
  for(const m of text.matchAll(/(?<![\p{L}\p{N}])(?:pc|pt)[-_\d][\p{L}\p{N}_-]*|\b[0-9a-f]{8}-[0-9a-f-]{27}\b/giu)) check(ids.some(id=>normalize(id)===m[0]),'financial_identity');
  for(const m of text.matchAll(/(?:mã\s*phiếu|phiếu\s+(?:số|mã))\s*[:#]?\s*([\p{L}\p{N}_-]+)/giu)) check(ids.some(id=>normalize(id)===m[1]),'financial_identity');
  for(const m of text.matchAll(/phiếu\s+(?:(?:thu|chi)\s+)?([a-z][a-z0-9_-]*\d[a-z0-9_-]*)/giu)) check(ids.some(id=>normalize(id)===m[1]),'financial_identity');
  for(const m of text.matchAll(/(\d+|một|hai|ba|bốn|năm)\s*phiếu/giu)) {
    const prefix=text.slice(0,m.index);
    if (/tối đa\s*$/iu.test(prefix) && m[1]==='20') continue;
    const n=({một:1,hai:2,ba:3,bốn:4,năm:5} as Record<string,number>)[m[1]] ?? Number(m[1]);
    check(n===rows.length,'financial_count');
  }
  if(!rows.length)return;
  // Aggregate labels are separate facts, never evidence for a row's amount.
  text=text.replace(new RegExp(`tổng (cộng|thu|chi|số tiền)\\s*[:：]?\\s*(${NUMBER})(?:\\s*(${UNIT}))?`,'giu'),(_match:string,label:string,value:string,unit:string)=>{
    const selected=label==='thu'?rows.filter(r=>r.loai==='INCOME'):label==='chi'?rows.filter(r=>r.loai==='EXPENSE'):rows;
    check(amount(value,unit)===selected.reduce((sum,r)=>sum+r.so_tien,0),'financial_money');
    return ' ';
  });
  const occurrences=rows.flatMap(row=>[...text.matchAll(new RegExp(identifierPattern(normalize(identifier(row))),'giu'))].map(m=>{
    const prefix=text.slice(0,m.index), label=/(?:phiếu (?:thu|chi)|\[(?:thu|chi)\])\s*$/iu.exec(prefix);
    return {row,start:label?.index ?? m.index!};
  })).sort((a,b)=>a.start-b.start);
  for(const row of rows)check(occurrences.some(o=>o.row===row),'financial_identity');
  if(pending)check(states(text).has('UNAPPROVED'),'financial_status');
  // Prose before the first row must not assert a state contradicted by any row.
  const introduction=text.slice(0,occurrences[0].start);
  for(const row of rows) assertStatus(introduction,pending?['UNAPPROVED']:[(row as VoucherRow).trang_thai,(row as VoucherRow).trang_thai_ghi_nhan],false);
  for(const [i,o] of occurrences.entries()) {
    const section=text.slice(o.start,occurrences[i+1]?.start ?? text.length), row=o.row;
    const actual=[...amounts(section),...labeledAmounts(section)];
    assertType(section,row,actual.length>0);
    assertMaker(section,row);
    // Every mention carrying facts must bind those facts to this voucher. A
    // trailing link-only mention is permitted only after a full row was given.
    if(actual.length===0 && i>0 && occurrences.slice(0,i).some(p=>p.row===row)) {
      assertStatus(section,pending?['UNAPPROVED']:[(row as VoucherRow).trang_thai,(row as VoucherRow).trang_thai_ghi_nhan],false);continue;
    }
    check(actual.length>0 && actual.every(n=>n===row.so_tien),'financial_money');
    if(pending) {
      check(token(section,(row as PendingRow).nguoi_lap),'financial_maker');
      assertStatus(section,['UNAPPROVED'],false);
    } else assertStatus(section,[(row as VoucherRow).trang_thai,(row as VoucherRow).trang_thai_ghi_nhan],true);
  }
  check(amounts(text).every(n=>rows.some(r=>r.so_tien===n)) && labeledAmounts(text).every(n=>rows.some(r=>r.so_tien===n)),'financial_money');
}
export function assertIncomeApprovalResult(e:Pick<ReadonlyEvidence,'prompt'|'answer'|'rounds'> & {scenario:GoldenScenario;fixture:IncomeApprovalFixture;actorDigest:string;reads:IncomeApprovalRead[]}):void {
  const rebound=bindIncomeApprovalScenario(e.scenario,e.fixture);
  check(same(rebound.attestation,e.fixture.attestation) && e.prompt===rebound.prompt && e.actorDigest===rebound.actorDigest,'financial_fixture_drift');
  const streams=e.rounds.map(r=>inspectModelStream(r.body));
  check(streams.length>=2 && e.rounds[0].messages.some(m=>m.role==='user' && m.content===e.prompt),'financial_model_cycle');
  const final=streams.at(-1)!;
  check(final.finish==='stop' && final.text.trim() && renderedAssistantText(final.text)===e.answer.trim(),'financial_mounted_answer');
  const calls=streams.flatMap((s,round)=>s.tools.map(c=>({...c,round})));
  const pending=e.scenario.id==='C36', empty=e.scenario.id==='C35';
  check(calls.length===1 && calls[0].id && calls[0].name===(pending?'hop_cho_duyet':'tim_phieu_thu_chi'),'financial_tool_query');
  let args:Record<string,unknown>;
  try {args=JSON.parse(calls[0].arguments);}catch{throw new IncomeApprovalOracleFailure('financial_tool_query');}
  check(args && typeof args==='object' && !Array.isArray(args),'financial_tool_query');
  const expectedArgs=pending?{}:{tu_ngay:empty?'2099-01-01':'2026-07-01',den_ngay:empty?'2099-01-31':'2026-07-31',...(empty?{loai:'chi'}:{})};
  const boundedArgs={...args};if(boundedArgs.so_luong===20)delete boundedArgs.so_luong;
  check(sameArgs(boundedArgs,expectedArgs),'financial_tool_query');
  check(e.reads.length===1 && e.reads[0].ok && e.reads[0].actorDigest===e.actorDigest && e.reads[0].rpc===rebound.request.rpc && sameArgs(e.reads[0].args,rebound.request.args),'financial_rpc_query');
  check(same(e.reads[0].payload,rebound.payload),'financial_rpc_drift');
  const messages=e.rounds.slice(calls[0].round+1).flatMap(r=>r.messages).filter(m=>m.role==='tool' && m.tool_call_id===calls[0].id);
  const expectedText=incomeApprovalToolText(rebound);
  check(messages.length>0 && messages.every(m=>typeof m.content==='string' && m.content.trim()===expectedText.trim()),'financial_tool_result');
  assertFacts(e.answer,rebound);
  // Route links are navigation only. A fabricated detail target can hide behind
  // a faithful label after MiniMarkdown strips the destination from innerText.
  for(const m of final.text.matchAll(/\]\(([^)\s]+)\)|\[link:\s*([^\]]+)\]/g)) check((m[1]??m[2])===(pending?'/approvals':'/income-expense'),'financial_identity');
}
