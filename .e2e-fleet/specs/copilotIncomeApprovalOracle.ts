import { digest, type GoldenScenario } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { bindIncomeApprovalScenario, validDailyCashbookBinding, type IncomeApprovalFixture, type VoucherRow, type PendingRow } from '../../scripts/copilot-income-approval-fixtures.mjs';
import { maskPii } from '../../src/copilot/maskPii';
import { inspectModelStream, renderedAssistantText, type ReadonlyEvidence } from './copilotSmokeOracle';

export interface IncomeApprovalRead { rpc:string; args:Record<string,unknown>; payload:unknown; ok:boolean; actorDigest:string; exactEndpoint:boolean }
export function isIncomeApprovalReadonlyRequest(fixture:IncomeApprovalFixture|undefined,origin:string,method:string,url:string):boolean {
  if(!fixture || method!=='POST' || !['copilot_income_expense_search_v1','copilot_pending_requests_v1'].includes(fixture.request.rpc))return false;
  let target:URL;try {target=new URL(url);}catch{return false;}
  const daily=fixture.attestation.kind==='voucher-search' && validDailyCashbookBinding(fixture.dailyCashbook)
    && fixture.attestation.dailyCashbookQueryDigest===digest(fixture.dailyCashbook.request)
    && fixture.attestation.dailyCashbookResponseDigest===digest(fixture.dailyCashbook.payload);
  return target.origin===origin && (target.pathname===`/rest/v1/rpc/${fixture.request.rpc}`
    || daily && target.pathname==='/rest/v1/rpc/copilot_report_daily_cashbook_v1') && !target.search && !target.hash;
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
  financial_daily_facts:'Unbound or unfaithful daily cashbook facts',
  financial_cashbook_privacy:'Answer exposes canonical cashbook material removed by masking',
} as const;
export type IncomeApprovalOracleFailureCode = keyof typeof MESSAGES;
export function isIncomeApprovalOracleFailureCode(code:unknown):code is IncomeApprovalOracleFailureCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES,code);
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
    if(!rows.length)return 'Không tìm thấy phiếu thu chi nào khớp điều kiện.\n[link: /income-expense]';
    const lines=rows.map(r=>`- [${TYPE[r.loai]}] ${identifier(r)} — ${r.ten ?? '?'} — ${money(r.so_tien)} — ${r.ngay}`
      +`${r.hang_muc ? ` — ${r.hang_muc}`:''}${r.so_quy ? ` — sổ ${maskPii(r.so_quy)}`:''} — ${APPROVAL[r.trang_thai]}, ${POSTING[r.trang_thai_ghi_nhan]}${r.nguoi_tao ? ` — lập bởi ${r.nguoi_tao}`:''}`);
    return `${rows.length} phiếu thu chi (tối đa 20 dòng mỗi lần hỏi):\n${lines.join('\n')}\n[link: /income-expense]`;
  }
  const rows=f.payload.hop_cho!;
  const lines=rows.map(r=>`- [${TYPE[r.loai]}] ${identifier(r)} — ${r.ten_phieu ?? '?'} — ${money(r.so_tien)}${r.gui_luc ? ` — gửi ${r.gui_luc.slice(0,10)}`:''} — lập bởi ${r.nguoi_lap}`);
  return `${rows.length} phiếu đang chờ bạn duyệt (tối đa 20 dòng):\n${lines.join('\n')}\n[link: /approvals]`;
}
/** Independent reconstruction of the supplementary product result, including empty and truncation behavior. */
export function dailyCashbookToolText(f:IncomeApprovalFixture):string {
  const p=f.dailyCashbook!.payload, th=p.tong_hop;
  const money=(n:number)=>`${new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0}).format(n)} đ`;
  if(!p.theo_ngay.length)return `${p.tu} → ${p.den}: không có phát sinh nào trong sổ quỹ bạn được xem.`;
  const parts=[`Thu chi ${p.tu} → ${p.den}: thu ${money(th.tong_thu)}, chi ${money(th.tong_chi)}, ròng ${money(th.rong)} trên ${th.so_ngay_co_phat_sinh} ngày có phát sinh.`];
  if(th.phieu_han_che_bi_loai>0)parts.push(`⚠ ${th.phieu_han_che_bi_loai} phiếu thuộc hạng mục hạn chế KHÔNG nằm trong các con số trên, nên tổng này chưa đầy đủ.`);
  parts.push(`\n${p.theo_ngay.length} ngày gần nhất (tối đa ${p.gioi_han} dòng):\n${p.theo_ngay.map(r=>`- ${r.ngay}: thu ${money(r.thu)}, chi ${money(r.chi)}, ròng ${money(r.rong)}`).join('\n')}`);
  return `${parts.join('\n')}\n[link: /reports/finance/daily-cashbook]`;
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
  const asserted=[...text.matchAll(/(?:phiếu\s+|loại\s*[:：]?\s*|là\s+)(thu|chi)(?![\p{L}\p{N}])|\[(thu|chi)\]|(?<![\p{L}\p{N}])(income|expense)(?![\p{L}\p{N}])|(?:^|[|–—;,])\s*(thu|chi)\s*(?=$|[|–—;,])/giu)].map(m=>({
    type:m[1]??m[2]??m[3]??m[4],
    negated:/(?:không|chưa|chẳng)(?:\s+(?:phải|là|thuộc|được|có)){0,3}\s*$/iu.test(text.slice(0,m.index)),
  }));
  const expected=row.loai==='INCOME'?['thu','income']:['chi','expense'];
  check((!required || asserted.some(t=>!t.negated && expected.includes(t.type)))
    && asserted.every(t=>t.negated ? !expected.includes(t.type) : expected.includes(t.type)),'financial_type');
}
function assertMaker(text:string,row:VoucherRow|PendingRow) {
  const maker='nguoi_lap' in row?row.nguoi_lap:row.nguoi_tao;
  for(const m of text.matchAll(/(?:lập bởi|tạo bởi|người lập|người tạo)\s*[:：]?\s*/giu)) {
    check(maker && new RegExp(`^${identifierPattern(normalize(maker))}`,'iu').test(text.slice(m.index!+m[0].length)),'financial_maker');
  }
}
/** This is a bounded readback check, not a general PII detector. Only numeric
 * material in the canonical cashbook label which maskPii actually removes is
 * forbidden in the mounted answer, including ordinary separator changes. */
function assertMaskedCashbooks(answer:string,rows:VoucherRow[]) {
  const numericTokens=(s:string)=>[...s.matchAll(/\+?\d(?:[\s.-]?\d){7,}/g)].map(m=>m[0]);
  const removed=rows.flatMap(row=>{
    if(!row.so_quy)return [];
    const masked=maskPii(row.so_quy);
    return numericTokens(row.so_quy).filter(raw=>!masked.includes(raw)).map(raw=>raw.replace(/\D/g,''));
  });
  check(numericTokens(answer).every(raw=>!removed.includes(raw.replace(/\D/g,''))),'financial_cashbook_privacy');
}
function assertFacts(answer:string,f:IncomeApprovalFixture) {
  assertMaskedCashbooks(answer,f.payload.phieu ?? []);
  let text=normalize(answer);
  const pending=Boolean(f.payload.hop_cho), rows=f.payload.phieu ?? f.payload.hop_cho!;
  // In the caller-bound pending inbox, "chờ xử lý" describes the same pending
  // request. It cannot establish voucher approval/posting states in C34/C35.
  if(pending)for(const match of text.matchAll(/đã (?:được )?xử lý/giu)){
    const prefix=text.slice(0,match.index);
    check(/(?:nếu|khi|không|chưa|chẳng)\s*(?:phải\s*)?$/iu.test(prefix),'financial_status');
  }
  if(pending)text=text.replace(/chờ xử lý/giu,(match:string,offset:number)=>{
    const prefix=text.slice(0,offset);
    check(!/(?:không|chưa|chẳng)(?:\s+(?:còn|phải|là|đang)){0,3}\s*$/iu.test(prefix),'financial_status');
    return /(?:nếu|khi|muốn|có thể|sẽ)\s*(?:đang\s*)?$/iu.test(prefix)?match:'chờ duyệt';
  });
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
  text=text.replace(new RegExp(`tổng (cộng|thu|chi|số tiền|tiền)\\s*[:：]?\\s*(${NUMBER})(?:\\s*(${UNIT}))?`,'giu'),(_match:string,label:string,value:string,unit:string)=>{
    const selected=label==='thu'?rows.filter(r=>r.loai==='INCOME'):label==='chi'?rows.filter(r=>r.loai==='EXPENSE'):rows;
    check(amount(value,unit)===selected.reduce((sum,r)=>sum+r.so_tien,0),'financial_money');
    return ' ';
  });
  const occurrences=rows.flatMap(row=>[...text.matchAll(new RegExp(identifierPattern(normalize(identifier(row))),'giu'))].map(m=>{
    const prefix=text.slice(0,m.index), label=/(?:(?:không|chưa|chẳng)(?:\s+(?:phải|là|thuộc|được|có)){0,3}\s+)?(?:phiếu (?:thu|chi)|\[(?:thu|chi)\])\s*$/iu.exec(prefix);
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
    // A single returned row gives an introductory type exactly one referent.
    // Multiple rows still require their own type claims to avoid cross-row swaps.
    assertType(rows.length===1 ? introduction+' '+section : section,row,actual.length>0);
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
/** Remove only separately proved report clauses. A report amount can never become
 * an acceptable voucher amount merely because both appeared in RPC responses. */
function voucherAnswerWithoutDailyFacts(answer:string,f:IncomeApprovalFixture,called:boolean):string {
  const p=f.dailyCashbook?.payload;
  const clauses=answer.normalize('NFC').replace(/[*_`]/g,'').split(/\n|(?<=\.)(?=\s|$)/u);
  return clauses.map(clause=>{
    let text=clause.trim().toLowerCase();
    if(p && text===`${p.tu} → ${p.den}: không có phát sinh nào trong sổ quỹ bạn được xem.`) {
      check(called && !p.theo_ngay.length,'financial_daily_facts');return ' ';
    }
    const count=/^(\d+) ngày gần nhất \(tối đa (\d+) dòng\)[:.]?$/.exec(text);
    if(count) {
      check(called && p && Number(count[1])===p.theo_ngay.length && Number(count[2])===p.gioi_han,'financial_daily_facts');return ' ';
    }
    check(!/ngày gần nhất/u.test(text),'financial_daily_facts');
    const report=/^(?:[-•]\s*)?(?:sổ quỹ|thu chi đã vào sổ|tổng (?:thu|chi|ròng).*?(?:sổ quỹ|đã vào sổ)|(?:ngày\s+)?\d{4}-\d{2}-\d{2}\s*:)/u.test(text);
    const cashflow=/(?:thu|chi|ròng)\s*[:：]?\s*[-+]?\d/u.test(text);
    if(!report) {
      check(!/ròng|dòng tiền|thu chi theo ngày|phát sinh.*sổ quỹ|^ngày\s+\d.*(?:thu|chi)\s*[:：]?\s*[-+]?\d/u.test(text),'financial_daily_facts');
      return clause;
    }
    // A cashbook label alone remains subject to the original privacy/fact checks.
    if(!cashflow && !/(?:không|chưa) có phát sinh/u.test(text)){
      check(!amounts(text).length && !labeledAmounts(text).length,'financial_daily_facts');return clause;
    }
    check(called && p,'financial_daily_facts');
    check(!/phiếu|\b(?:pc|pt)[-_\d]|\b[0-9a-f]{8}-[0-9a-f-]{27}\b/u.test(text),'financial_daily_facts');
    const dates=[...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m=>m[0]);
    const daily=/^(?:[-•]\s*)?(?:ngày\s+)?\d{4}-\d{2}-\d{2}\s*:/u.test(text);
    const row=daily?p.theo_ngay.find(r=>r.ngay===dates[0]):undefined;
    check(daily ? dates.length===1 && row : /sổ quỹ|đã vào sổ/u.test(text) && dates.every(d=>d===p.tu || d===p.den),'financial_daily_facts');
    if(/(?:không|chưa) có phát sinh/u.test(text)) {
      check(!p.theo_ngay.length && !cashflow && !amounts(text).length,'financial_daily_facts');
      text=text.replace(/(?:không|chưa) có phát sinh/u,'');
    } else {
      const expected=row?{thu:row.thu,chi:row.chi,'ròng':row.rong}:{thu:p.tong_hop.tong_thu,chi:p.tong_hop.tong_chi,'ròng':p.tong_hop.rong};
      let matched=0;
      text=text.replace(new RegExp(`(?:tổng\\s+)?(thu|chi|ròng)\\s*[:：]?\\s*(${NUMBER})(?:\\s*(${UNIT}))?`,'giu'),(_m:string,label:string,value:string,unit:string)=>{
        check(amount(value,unit)===expected[label as keyof typeof expected],'financial_daily_facts');matched++;return ' ';
      });
      check(matched>0,'financial_daily_facts');
    }
    text=text.replace(/trên (\d+) ngày có phát sinh/g,(_m:string,count:string)=>{
      check(!daily && Number(count)===p.tong_hop.so_ngay_co_phat_sinh,'financial_daily_facts');return ' ';
    });
    text=text.replace(/\d{4}-\d{2}-\d{2}/g,'').replace(/(?:tháng|kỳ)\s+07\/2026/g,'');
    // Only known contextual wording may accompany a consumed report clause.
    // Extra numbers, statuses, identities, links or money survive and fail.
    text=text.replace(/sổ quỹ|đã vào sổ|thu chi|tổng|tháng|kỳ|ngày|bạn được xem|nào trong|trong/g,'').replace(/[\s:：,;.→–—-]/g,'');
    check(text==='','financial_daily_facts');
    return ' ';
  }).join('\n');
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
  const primaryName=pending?'hop_cho_duyet':'tim_phieu_thu_chi';
  const dailyCalls=calls.filter(c=>c.name==='bao_cao_thu_chi_theo_ngay');
  check(calls.every(c=>typeof c.id==='string' && c.id.trim()) && new Set(calls.map(c=>c.id)).size===calls.length
    && calls.filter(c=>c.name===primaryName).length===1 && dailyCalls.length<=1
    && calls.length===1+dailyCalls.length && (!dailyCalls.length || e.scenario.id==='C34' && rebound.dailyCashbook),'financial_tool_query');
  check(e.reads.length===calls.length,'financial_rpc_query');
  for(const call of calls) {
    const daily=call.name==='bao_cao_thu_chi_theo_ngay';
    let args:Record<string,unknown>;
    try {args=JSON.parse(call.arguments);}catch{throw new IncomeApprovalOracleFailure('financial_tool_query');}
    check(args && typeof args==='object' && !Array.isArray(args),'financial_tool_query');
    const expectedArgs=daily?{ky:'2026-07'}:pending?{}:{tu_ngay:empty?'2099-01-01':'2026-07-01',den_ngay:empty?'2099-01-31':'2026-07-31',...(empty?{loai:'chi'}:{})};
    const boundedArgs={...args};if(boundedArgs.so_luong===20)delete boundedArgs.so_luong;
    check(sameArgs(boundedArgs,expectedArgs),'financial_tool_query');
    const binding=daily?rebound.dailyCashbook!:rebound;
    const reads=e.reads.filter(r=>r.rpc===binding.request.rpc);
    check(reads.length===1 && reads[0].ok && reads[0].exactEndpoint===true && reads[0].actorDigest===e.actorDigest
      && sameArgs(reads[0].args,binding.request.args),'financial_rpc_query');
    check(same(reads[0].payload,binding.payload),'financial_rpc_drift');
    const messages=e.rounds.slice(call.round+1).flatMap(r=>r.messages).filter(m=>m.role==='tool' && m.tool_call_id===call.id);
    const expectedText=daily?dailyCashbookToolText(rebound):incomeApprovalToolText(rebound);
    check(messages.length>0 && messages.every(m=>typeof m.content==='string' && (daily?m.content===expectedText:m.content.trim()===expectedText.trim())),'financial_tool_result');
  }
  for(const [round,r] of e.rounds.entries())for(const m of r.messages.filter(m=>m.role==='tool'))
    check(calls.some(c=>c.id===m.tool_call_id && c.round<round),'financial_tool_result');
  assertMaskedCashbooks(e.answer,rebound.payload.phieu ?? []);
  const voucherAnswer=e.scenario.id==='C34'?voucherAnswerWithoutDailyFacts(e.answer,rebound,dailyCalls.length===1):e.answer;
  assertFacts(voucherAnswer,rebound);
  if(e.scenario.id==='C34')for(const m of voucherAnswer.matchAll(/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/g)) {
    const canonical=m[0].includes('/')?m[0].split('/').reverse().join('-'):m[0];
    check(rebound.payload.phieu!.some(r=>r.ngay===canonical) || [rebound.request.args.p_tu,rebound.request.args.p_den].includes(canonical),'financial_daily_facts');
  }
  // Route links are navigation only. A fabricated detail target can hide behind
  // a faithful label after MiniMarkdown strips the destination from innerText.
  for(const m of final.text.matchAll(/\]\(([^)\s]+)\)|\[link:\s*([^\]]+)\]/g)) check((m[1]??m[2])===(pending?'/approvals':'/income-expense') || dailyCalls.length===1 && (m[1]??m[2])==='/reports/finance/daily-cashbook','financial_identity');
}
