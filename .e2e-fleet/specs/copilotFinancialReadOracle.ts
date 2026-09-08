import { z } from 'zod';
import { digest, type GoldenScenario } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { bindFinancialReadScenario, sameFinancialArgs, FINANCIAL_READ_CASES, type FinancialReadFixture, type FinancialRole, type FinancialRpc } from '../../scripts/copilot-financial-read-fixtures.mjs';
import { inspectModelStream, renderedAssistantText, type ReadonlyEvidence } from './copilotSmokeOracle';

export interface FinancialRead {rpc:string;args:Record<string,unknown>;payload:unknown;status:number;actorDigest?:string;exactEndpoint:boolean;modelRound:number}
export interface FinancialReadObservation {role:FinancialRole;rpc:FinancialRpc;argsDigest:string;responseDigest:string;factDigest:string;actorDigest:string;httpStatus:200;exactEndpoint:true;toolCallId:string;modelRound:number;resultRound:number}
export interface FinancialReadEvidence extends Pick<ReadonlyEvidence,'prompt'|'answer'|'rounds'> {scenario:GoldenScenario;fixture:FinancialReadFixture;actorDigest:string;reads:FinancialRead[];businessWrites:number;networkErrors:number;consoleErrors:number}
const CODES=['financial_binding','financial_cycle','financial_mounted','financial_prompt','financial_tool','financial_read','financial_payload','financial_link','financial_facts','financial_guards'] as const;
const FACT_RULES={
  period_required:['missing'],period_conflict:['mismatch'],link_forbidden:['unsupported'],atom_marker_forbidden:['unsupported'],
  claim_binding:['unsupported'],claim_money:['missing','mismatch'],claim_count:['missing','mismatch','unit'],claim_limit:['mismatch'],residual_grammar:['unsupported'],
  stats_raw:['mismatch','unit'],absence_required:['missing'],partial_scope_required:['missing'],
  empty_count:['missing','mismatch','unit'],empty_due:['missing','mismatch'],empty_paid:['missing','mismatch'],empty_remaining:['missing','mismatch'],empty_debt_absence:['missing'],
  empty_nonzero:['mismatch'],empty_entity:['unsupported'],empty_affirmative:['mismatch'],
  positive_absence:['mismatch'],invoice_header:['missing'],invoice_limit:['mismatch'],invoice_row:['missing'],invoice_negation:['mismatch'],invoice_identity:['mismatch'],invoice_status:['mismatch'],invoice_status_conflict:['mismatch'],invoice_unknown:['unsupported'],
  pnl_basis:['mismatch'],pnl_basis_negation:['mismatch'],pnl_cash_claim:['mismatch'],pnl_totals:['missing'],pnl_row:['missing'],stats_header:['missing'],
} as const;
type FactRule=keyof typeof FACT_RULES;
type FailureKind=typeof FACT_RULES[FactRule][number];
type ResidualFlags={hasResidualDigits:boolean;hasResidualCurrency:boolean;hasResidualWords:boolean};
type FactDetail={factRule:FactRule;failureKind:FailureKind}&Partial<ResidualFlags>;
type FinancialDiagnostic={caseId:string;code:Code}&Partial<FactDetail>;
type Code=typeof CODES[number];
export function isFinancialReadFailureCode(value:unknown):value is Code {
  return typeof value==='string' && CODES.some(code=>code===value);
}
const failures=new WeakSet<FinancialReadFailure>();
class FinancialReadFailure extends Error {constructor(readonly code:Code,readonly detail?:FactDetail){super(code);if(detail)Object.freeze(detail);failures.add(this);Object.freeze(this);}}
const check:(ok:unknown,code:Code)=>asserts ok=(ok,code)=>{if(!ok)throw new FinancialReadFailure(code);};
const fact:(ok:unknown,factRule:FactRule,failureKind:FailureKind,residual?:ResidualFlags)=>asserts ok=(ok,factRule,failureKind,residual)=>{
  if(!ok)throw new FinancialReadFailure('financial_facts',{factRule,failureKind,...residual});
};
export function financialReadDiagnostic(caseId:string,error:unknown):FinancialDiagnostic|undefined {
  if(error instanceof FinancialReadFailure && failures.has(error))return {caseId,code:error.code,...error.detail};
}
/** Reconstruct static diagnostics only. No arbitrary keys or text cross stdout. */
export function safeFinancialReadDiagnostic(value:unknown):FinancialDiagnostic|undefined {
  if(!value || typeof value!=='object' || Array.isArray(value))return;
  const v=value as Record<string,unknown>,keys=Object.keys(v);
  if(typeof v.caseId!=='string' || !Object.prototype.hasOwnProperty.call(FINANCIAL_READ_CASES,v.caseId) || !isFinancialReadFailureCode(v.code))return;
  if(keys.length===2 && keys.every(k=>['caseId','code'].includes(k)))return {caseId:v.caseId,code:v.code};
  if(v.code!=='financial_facts' || typeof v.factRule!=='string' || !Object.prototype.hasOwnProperty.call(FACT_RULES,v.factRule))return;
  const factRule=v.factRule as FactRule;
  if(typeof v.failureKind!=='string' || !(FACT_RULES[factRule] as readonly string[]).includes(v.failureKind))return;
  const base={caseId:v.caseId,code:v.code,factRule,failureKind:v.failureKind as FailureKind};
  const fields=['caseId','code','factRule','failureKind'];
  if(factRule==='residual_grammar') {
    const flags=['hasResidualDigits','hasResidualCurrency','hasResidualWords'];fields.push(...flags);
    if(!flags.every(k=>typeof v[k]==='boolean') || !flags.some(k=>v[k]===true))return;
    if(keys.length!==fields.length || !keys.every(k=>fields.includes(k)))return;
    return {...base,hasResidualDigits:v.hasResidualDigits as boolean,hasResidualCurrency:v.hasResidualCurrency as boolean,hasResidualWords:v.hasResidualWords as boolean};
  }
  if(keys.length!==fields.length || !keys.every(k=>fields.includes(k)))return;
  return base;
}
export function financialReadFailureReason(error:unknown):'fixture_unbound'|undefined {
  if(error instanceof FinancialReadFailure && failures.has(error) && ['financial_binding','financial_payload'].includes(error.code))return 'fixture_unbound';
}
/** Financial model evidence must come from the exact proxy wire endpoint. */
export function isFinancialModelEndpoint(apiOrigin:string,method:string,url:string):boolean {
  try {
    const parsed=new URL(url);
    return method==='POST' && parsed.origin===apiOrigin && parsed.pathname==='/functions/v1/llm-proxy/chat/completions' && !parsed.search && !parsed.hash;
  }catch{return false;}
}
/** Only the selected fixture's exact endpoint AND argument set is a read exemption. */
export function classifyFinancialRead(fixture:FinancialReadFixture|undefined,apiOrigin:string,method:string,url:string,args:unknown):FinancialRole|undefined {
  if(!fixture || method!=='POST' || apiOrigin!==fixture.apiOrigin)return;
  try {
    const parsed=new URL(url);
    if(parsed.origin!==apiOrigin || parsed.search || parsed.hash)return;
    return (Object.keys(fixture.roles) as FinancialRole[]).find(role=>{
      const request=fixture.roles[role]!.request;
      return parsed.pathname===`/rest/v1/rpc/${request.rpc}` && sameFinancialArgs(args,request.args);
    });
  }catch{return;}
}
const money=(v:number)=>`${new Intl.NumberFormat('vi-VN',{maximumFractionDigits:0}).format(v)} đ`;
const displayed=(v:number)=>Number(new Intl.NumberFormat('en-US',{useGrouping:false,maximumFractionDigits:0}).format(v));
/** Independent rendering contract. The stats formatter's count-as-currency bug
 * is reproduced ONLY for transport equality; answer count semantics stay typed. */
export function financialToolText(fixture:FinancialReadFixture,role:FinancialRole):string {
  if(role==='invoice') {
    const rows=fixture.roles.invoice!.payload;
    return rows.length?`Tìm thấy ${rows.length} hoá đơn (hiện 10 đầu):\n${rows.slice(0,10).map(r=>`- HĐ ${r.invoice_number??r.id.slice(0,8)} — phòng ${r.room_name} (${r.building_name}) — kỳ ${r.billing_month} — tổng ${money(r.total_amount)} — trạng thái ${r.status}`).join('\n')}`:'Không tìm thấy hoá đơn nào khớp điều kiện.';
  }
  if(role==='pnl') {
    const {request,payload}=fixture.roles.pnl!;
    const rev=payload.reduce((s,r)=>s+r.revenue,0),exp=payload.reduce((s,r)=>s+r.expense,0);
    return [`KQKD tháng 2026-07 (${request.args.p_accrual?'dồn tích':'tiền mặt'}):`,`TỔNG: doanh thu ${money(rev)}, chi phí ${money(exp)}, lợi nhuận ${money(rev-exp)}`,...payload.map(r=>`- ${r.building_name}: thu ${money(r.revenue)}, chi ${money(r.expense)}, ròng ${money(r.net)}`)].join('\n');
  }
  const {request,payload}=fixture.roles.stats!;
  return `Thống kê hoá đơn kỳ ${request.args.p_billing_month}:\n${Object.entries(payload).map(([k,v])=>`- ${k}: ${/amount|total|paid|unpaid|revenue|debt|thu|no/i.test(k)?money(v):JSON.stringify(v)}`).join('\n')}`;
}
const normal=(s:string)=>s.normalize('NFC').replace(/\*\*|`/g,'').replace(/hoá/giu,'hóa').toLowerCase();
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const token=(s:string,v:string)=>new RegExp(`(?<![\\p{L}\\p{N}_/-])${escape(normal(v))}(?![\\p{L}\\p{N}_/-])`,'u').test(s);
const monetary=String.raw`(-?\d+(?:[.,]\d+)*)\s*(triệu|tr|nghìn|ngàn|k|đồng|vnd|vnđ|₫|đ)(?!\p{L})`;
function amount(raw:string,unit:string) {
  return /triệu|^tr$|nghìn|ngàn|^k$/.test(unit)?Number(raw.replace(',','.'))*(/triệu|^tr$/.test(unit)?1e6:1e3):Number(raw.replace(/\./g,'').replace(',','.'));
}
function moneyFact(s:string,label:string,value:number,rule:FactRule='claim_money') {
  const matches=[...s.matchAll(new RegExp(`(?:${label})\\s*(?:[:：|–—=-]\\s*)?${monetary}`,'gu'))];
  fact(matches.length>0 && matches.every(m=>amount(m[1],m[2])===displayed(value)),rule,matches.length?'mismatch':'missing');
}
function countFact(s:string,value:number,rule:FactRule='claim_count') {
  const matches=[...s.matchAll(/(?<![\d.,])([0-9]+)\s+hóa đơn/gu)];
  fact(matches.length>0 && matches.every(m=>Number(m[1])===value),rule,matches.length?'mismatch':'missing');
  fact(!/\d+\s*(?:đ|đồng|vnd|vnđ|₫)\s*hóa đơn/u.test(s),rule,'unit');
}
/** Close every extra claim, not just the required core rows. A monetary atom
 * belongs to one labelled field in its invoice/building/company scope. Once
 * grounded atoms are consumed, only bounded connective/clarification prose may
 * remain; an unknown name or bare number cannot borrow a correct core fact. */
function closeFinancialClaims(text:string,fixture:FinancialReadFixture,empty:boolean) {
  fact(!/\b(?:factatom|invoiceatom|roomatom|statusatom|periodatom|buildingatom)\b/u.test(text),'atom_marker_forbidden','unsupported');
  const invoices=fixture.roles.invoice?.payload??[],buildings=fixture.roles.pnl?.payload??[],stats=fixture.roles.stats?.payload;
  const revenue=buildings.reduce((sum,r)=>sum+r.revenue,0),expense=buildings.reduce((sum,r)=>sum+r.expense,0);
  const totals=buildings.length?{revenue,expense,net:revenue-expense}:undefined;
  const buildingNames=[...new Set([...invoices.map(r=>r.building_name),...buildings.map(r=>r.building_name)])];
  const replaceAtom=(line:string,value:string,replacement:string)=>line.replace(new RegExp(`(?<![\\p{L}\\p{N}_/-])${escape(normal(value))}(?![\\p{L}\\p{N}_/-])`,'gu'),replacement);
  for(const line of text.split('\n')) {
    const invoiceRows=invoices.filter(r=>token(line,r.invoice_number??r.id.slice(0,8)));
    const namedBuildings=buildingNames.filter(name=>token(line,name));
    const pnlScope=invoiceRows.length?undefined:namedBuildings.length===0?totals:namedBuildings.length===1?buildings.find(r=>r.building_name===namedBuildings[0]):undefined;
    const invoiceScope=invoiceRows.length===1?invoiceRows[0]:undefined;
    const statsScope=invoiceRows.length===0 && namedBuildings.length===0?stats:undefined;
    const labels:Record<string,{value:number|undefined;count:boolean;raw:boolean}>={};
    const add=(names:string[],value:number|undefined,count=false,raw=false)=>names.forEach(name=>{labels[name]={value,count,raw};});
    add(['doanh thu','revenue','thu'],pnlScope?.revenue);add(['chi phí','expense','chi'],pnlScope?.expense);add(['lợi nhuận','ròng','net'],pnlScope?.net);
    add(['tổng tiền','tổng','số tiền'],invoiceScope?.total_amount);
    const aliases:Record<string,string[]>={total_amount:['tổng phải thu'],total_paid:['đã trả','đã thu'],total_remaining:['tổng công nợ','công nợ','còn nợ'],total_refunded:['tiền hoàn'],total_count:['số hóa đơn'],rent_amount:['tiền thuê'],electric_amount:['tiền điện'],water_amount:['tiền nước'],pdv_amount:['phí dịch vụ'],total_collected:['tổng đã thu'],payment_tm:[],payment_tk:[],payment_tt:[],payment_ct:[],change_amount:[],deposit_collected:['cọc đã thu']};
    for(const [key,names] of Object.entries(aliases)) {
      const value=statsScope?.[key as keyof typeof statsScope];
      add(names,value,key==='total_count');add([key],value,key==='total_count',true);
    }
    const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])(${Object.keys(labels).sort((a,b)=>b.length-a.length).map(escape).join('|')})\\s*(?:[:：|–—=-]\\s*)?(?:(?:là|đạt|bằng)\\s*)?(-?\\d+(?:[.,]\\d+)*)(?:\\s*(triệu|tr|nghìn|ngàn|k|đồng|vnd|vnđ|₫|đ)(?!\\p{L}))?`,'gu');
    let rest=line.replace(pattern,(_match,label:string,raw:string,unit:string|undefined)=>{
      const expected=labels[label];fact(expected.value!==undefined,'claim_binding','unsupported');
      if(expected.count)fact(!unit && /^\d+$/.test(raw) && Number(raw)===expected.value,'claim_count',unit?'unit':'mismatch');
      else {
        const actual=unit?amount(raw,unit):Number(raw.replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.'));
        fact(actual===(expected.raw && !unit?expected.value:displayed(expected.value)),'claim_money','mismatch');
      }
      return ' factatom ';
    });
    rest=rest.replace(/(?<![\d.,])(\d+)\s+hóa đơn/gu,(_match,count:string)=>{
      const value=stats && /công nợ|thống kê|tổng số/u.test(line)?stats.total_count:fixture.roles.invoice?invoices.length:stats?.total_count;
      fact(value!==undefined && Number(count)===value,'claim_count','mismatch');return ' factatom ';
    });
    rest=rest.replace(/\(?hiện 10 đầu\)?/gu,()=>{fact(invoices.length>0,'claim_limit','mismatch');return ' factatom ';});
    for(const row of invoices.slice(0,10)) {
      rest=replaceAtom(rest,row.invoice_number??row.id.slice(0,8),'invoiceatom');
      rest=replaceAtom(rest,row.room_name,'roomatom');rest=replaceAtom(rest,row.status,'statusatom');
    }
    for(const name of buildingNames)rest=replaceAtom(rest,name,'buildingatom');
    rest=rest.replace(/\b\d{4}-\d{2}\b|\b\d{2}\/\d{4}\b/gu,'periodatom');
    rest=rest.replace(/(?:hđ|hóa đơn)\s+invoiceatom|phòng\s+roomatom|(?:(?:tòa|toà)(?: nhà)?\s+)?buildingatom|trạng thái\s+statusatom/gu,' factatom ');
    rest=rest.replace(/(?:kqkd|doanh thu|công nợ|thống kê hóa đơn)\s*(?:(?:tháng|kỳ)\s*)?periodatom/gu,' factatom ');
    if(fixture.roles.invoice)rest=rest.replace(empty?/hóa đơn\s+(?:(?:kỳ|tháng)\s+)?periodatom\s+trạng thái partial/gu:/danh sách hóa đơn (?:chưa thu|chưa thanh toán) (?:tháng|kỳ) periodatom/gu,' factatom ');
    // These are whole neutral introductions/requests, never a bag of words
    // capable of assembling a new affirmative result or a named entity.
    rest=rest.replace(/(?:^|[.!?])\s*dưới đây là kết quả theo dữ liệu hệ thống\s*(?=[.!?]|$)/gu,' ');
    rest=rest.replace(/(?:^|[.!?])\s*các số liệu trên được lấy từ dữ liệu hệ thống\s*(?=[.!?]|$)/gu,' ');
    rest=rest.replace(/(?:^|[.!?])\s*(?:bạn\s+)?vui lòng kiểm tra lại (?:kỳ hoặc trạng thái hóa đơn|kỳ|trạng thái hóa đơn)\s*(?=[.!?]|$)/gu,' ');
    rest=rest.replace(/(?:^|[.!?])\s*theo dữ liệu (?:hiện có|hệ thống)\s*,/gu,' ');
    if(empty) {
      rest=rest.replace(/(?:không|chưa) (?:tìm thấy|có|còn) (?:dữ liệu hóa đơn|hóa đơn|công nợ|kết quả)(?: nào)?(?: (?:thanh toán một phần|thu một phần))?(?:\s*\(partial\))?(?: khớp (?:điều kiện|yêu cầu))?/gu,' factatom ');
    }
    // Whitelist only grammar joining already validated atoms. Identity nouns,
    // financial labels without a value, result/data assertions and digits are
    // intentionally absent, so unconsumed facts cannot silently survive.
    const connective=new Set('factatom invoiceatom roomatom statusatom periodatom tổng tìm thấy kỳ tháng trạng thái chưa thanh toán thu tiền mặt dồn tích và là có trong này theo hiện tại'.split(' '));
    fact(!/[\d$%€£¥]/u.test(rest) && (rest.match(/[\p{L}\p{N}_]+/gu)??[]).every(word=>connective.has(word)),'residual_grammar','unsupported',{
      hasResidualDigits:/\d/u.test(rest),hasResidualCurrency:/[$%€£¥]/u.test(rest),
      hasResidualWords:(rest.match(/[\p{L}\p{N}_]+/gu)??[]).some(word=>!/^[0-9]+$/u.test(word) && !connective.has(word)),
    });
  }
}
function assertFacts(answer:string,fixture:FinancialReadFixture) {
  const s=normal(answer),empty=fixture.roles.invoice?.payload.length===0 || fixture.roles.stats?.payload.total_count===0;
  const period=empty?'2099-01':'2026-07';
  fact(token(s,period) || token(s,empty?'01/2099':'07/2026'),'period_required','missing');
  for(const month of s.matchAll(/\b\d{4}-\d{2}\b|\b\d{2}\/\d{4}\b/gu))fact([period,empty?'01/2099':'07/2026'].includes(month[0]),'period_conflict','mismatch');
  fact(!/\]\(|\[link:|https?:|\/(?:contracts|invoices|customers)\//u.test(s),'link_forbidden','unsupported');
  const absence=/(?:không|chưa) (?:tìm thấy|có|còn)[^.\n]*(?:hóa đơn|công nợ|dữ liệu|doanh thu)/u;
  closeFinancialClaims(s,fixture,empty);
  if(fixture.roles.stats)for(const [key,value] of Object.entries(fixture.roles.stats.payload)) {
    const pattern=new RegExp(`\\b${key}\\s*[:：=]\\s*(-?\\d+(?:[.,]\\d+)*)(?:\\s*(triệu|tr|nghìn|ngàn|k|đồng|vnd|vnđ|₫|đ)(?!\\p{L}))?`,'gu');
    for(const m of s.matchAll(pattern)) {
      if(key==='total_count')fact(!m[2] && /^\d+$/.test(m[1]) && Number(m[1])===value,'stats_raw',m[2]?'unit':'mismatch');
      else {
        const parsed=m[2]?amount(m[1],m[2]):Number(m[1].replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.'));
        fact(parsed===(m[2]?displayed(value):value),'stats_raw','mismatch');
      }
    }
  }
  if(empty) {
    fact(absence.test(s),'absence_required','missing');
    if(fixture.roles.invoice)fact(/partial|thanh toán một phần|thu một phần/u.test(s),'partial_scope_required','missing');
    if(fixture.roles.stats) {
      countFact(s,0,'empty_count');moneyFact(s,'tổng phải thu|total_amount',0,'empty_due');moneyFact(s,'đã trả|đã thu|total_paid',0,'empty_paid');moneyFact(s,'còn nợ|công nợ|total_remaining',0,'empty_remaining');
      fact(/(?:không|chưa) (?:có|còn) (?:công )?nợ/u.test(s),'empty_debt_absence','missing');
    }
    const rest=s.split(period).join('').split(empty?'01/2099':'07/2026').join('');
    fact(!/[1-9]/u.test(rest) && !/phòng|tòa|toà|hợp đồng|mã hóa đơn/u.test(rest),/[1-9]/u.test(rest)?'empty_nonzero':'empty_entity',/[1-9]/u.test(rest)?'mismatch':'unsupported');
    for(const claim of rest.matchAll(/(?:có|tìm thấy|còn)\s+(?:hóa đơn|công nợ|nợ)/gu))fact(/(?:không|chưa)\s*$/.test(rest.slice(0,claim.index)) || /^\s*:\s*0\s*đ/u.test(rest.slice(claim.index!+claim[0].length)),'empty_affirmative','mismatch');
    return;
  }
  fact(!absence.test(s),'positive_absence','mismatch');
  const lines=s.split('\n');
  if(fixture.roles.invoice) {
    const rows=fixture.roles.invoice.payload;
    // Stats count can differ from unpaid list count: isolate the list header.
    const header=lines.find(line=>/(?:tìm thấy|danh sách|chưa thu|chưa thanh toán|hiện)/u.test(line) && /\d+\s+hóa đơn/u.test(line));
    fact(header,'invoice_header','missing');countFact(header,rows.length);
    if(rows.length>10)fact(/10\s*(?:đầu|hóa đơn đầu)|(?:đầu tiên|hiển thị|hiện)\s*10/u.test(s) && !/đầy đủ|toàn bộ danh sách/u.test(s),'invoice_limit','mismatch');
    for(const row of rows.slice(0,10)) {
      const code=row.invoice_number??row.id.slice(0,8),matching=lines.filter(line=>token(line,code));
      fact(matching.length>0,'invoice_row','missing');
      for(const line of matching) {
        fact(!/không|nếu|giả sử/u.test(line),'invoice_negation','mismatch');
        fact([row.room_name,row.building_name,row.billing_month].every(v=>token(line,v)),'invoice_identity','mismatch');
        moneyFact(line,'tổng(?: tiền)?|số tiền',row.total_amount);
        fact(token(line,row.status) || /chưa (?:thu|thanh toán)/u.test(line),'invoice_status','mismatch');
        fact(!/\bpaid\b|partial|đã (?:thu|trả|thanh toán)|hủy|huỷ/u.test(line),'invoice_status_conflict','mismatch');
      }
    }
    for(const id of s.matchAll(/(?:hđ|hóa đơn)\s+([\p{L}\p{N}][\p{L}\p{N}_/-]*\d[\p{L}\p{N}_/-]*)/gu))fact(rows.slice(0,10).some(r=>normal(r.invoice_number??r.id.slice(0,8))===id[1]),'invoice_unknown','unsupported');
  }
  if(fixture.roles.pnl) {
    const {request,payload}=fixture.roles.pnl,basis=request.args.p_accrual?'dồn tích':'tiền mặt';
    fact(s.includes(basis) && !s.includes(request.args.p_accrual?'tiền mặt':'dồn tích'),'pnl_basis','mismatch');
    for(const line of lines.filter(line=>line.includes(basis)))fact(!/không|nếu|giả sử/u.test(line),'pnl_basis_negation','mismatch');
    fact(!/tiền (?:đã )?thu được|tiền thực thu|đã thu tiền mặt/u.test(s),'pnl_cash_claim','mismatch');
    const totals=lines.filter(line=>/tổng.*doanh thu/u.test(line));
    fact(totals.length>0,'pnl_totals','missing');
    const rev=payload.reduce((sum,r)=>sum+r.revenue,0),exp=payload.reduce((sum,r)=>sum+r.expense,0);
    for(const line of totals){moneyFact(line,'doanh thu',rev);moneyFact(line,'chi phí',exp);moneyFact(line,'lợi nhuận',rev-exp);}
    for(const row of payload) {
      const matching=lines.filter(line=>token(line,row.building_name) && /(?:thu|doanh thu)\s*[:：|]?\s*\d/u.test(line) && /(?:chi|chi phí)\s*[:：|]?\s*\d/u.test(line) && /(?:ròng|lợi nhuận)\s*[:：|]?\s*-?\d/u.test(line));
      fact(matching.length>0,'pnl_row','missing');
      for(const line of matching){moneyFact(line,'doanh thu|thu',row.revenue);moneyFact(line,'chi phí|chi',row.expense);moneyFact(line,'lợi nhuận|ròng',row.net);}
    }
  }
  if(fixture.roles.stats) {
    const stats=fixture.roles.stats.payload;
    const head=lines.find(line=>/(?:công nợ|thống kê)/u.test(line) && /\d+\s+hóa đơn/u.test(line));
    fact(head,'stats_header','missing');countFact(head,stats.total_count);
    moneyFact(s,'tổng phải thu|total_amount',stats.total_amount);moneyFact(s,'đã trả|đã thu|total_paid',stats.total_paid);moneyFact(s,'còn nợ|tổng công nợ|total_remaining',stats.total_remaining);
  }
}
export function assertFinancialReadResult(e:FinancialReadEvidence):FinancialReadObservation[] {
  let rebound:FinancialReadFixture;
  try{rebound=bindFinancialReadScenario(e.scenario,e.fixture);}catch{throw new FinancialReadFailure('financial_binding');}
  check(e.actorDigest===e.fixture.actorDigest && digest(rebound.attestation)===digest(e.fixture.attestation) && rebound.bindingDigest===e.fixture.bindingDigest,'financial_binding');
  check(e.businessWrites===0 && e.networkErrors===0 && e.consoleErrors===0,'financial_guards');
  check(e.prompt===rebound.prompt && e.rounds[0]?.messages.some(m=>m.role==='user' && m.content===e.prompt),'financial_prompt');
  const streams=e.rounds.map(r=>inspectModelStream(r.body)),last=streams.at(-1);
  check(streams.length>=2 && streams.length<=3 && last?.finish==='stop' && streams.slice(0,-1).every(s=>s.finish==='tool_calls'),'financial_cycle');
  check(last.text.trim() && e.answer.trim()===renderedAssistantText(last.text),'financial_mounted');
  const calls=streams.flatMap((s,round)=>s.tools.map(t=>({...t,round}))),roles=Object.keys(rebound.roles) as FinancialRole[];
  check(calls.length===roles.length && new Set(calls.map(c=>c.id)).size===calls.length && calls.every(c=>typeof c.id==='string' && c.id.trim()),'financial_tool');
  check(e.reads.length===roles.length,'financial_read');
  const observation:FinancialReadObservation[]=[];
  for(const role of roles) {
    const binding=rebound.roles[role]!,name=role==='invoice'?'tim_hoa_don':role==='pnl'?'doanh_thu_thang':'cong_no_tong_quan';
    const matching=calls.filter(c=>c.name===name);check(matching.length===1,'financial_tool');
    const call=matching[0];let args:unknown;
    try {
      const schema=role==='pnl'?z.object({thang:z.literal('2026-07'),accrual:z.boolean().default(false)}).strict():role==='invoice'?z.object({thang:z.literal(e.scenario.id==='C15'?'2099-01':'2026-07'),trang_thai:z.literal(e.scenario.id==='C15'?'partial':'unpaid')}).strict():z.object({thang:z.literal(e.scenario.id==='C19'?'2099-01':'2026-07')}).strict();
      args=schema.parse(JSON.parse(call.arguments));
    }catch{throw new FinancialReadFailure('financial_tool');}
    if(role==='pnl')check((args as {accrual:boolean}).accrual===binding.request.args.p_accrual,'financial_tool');
    const reads=e.reads.filter(r=>r.rpc===binding.request.rpc);check(reads.length===1,'financial_read');
    const read=reads[0];check(read.status===200 && read.exactEndpoint===true && read.actorDigest===e.actorDigest && read.modelRound===call.round && sameFinancialArgs(read.args,binding.request.args),'financial_read');
    check(digest(read.payload)===rebound.attestation.roles[role]!.responseDigest,'financial_payload');
    const results=e.rounds.flatMap((r,round)=>r.messages.filter(m=>m.role==='tool' && m.tool_call_id===call.id).map(m=>({...m,round})));
    check(results.length>0 && results.every(m=>m.round>call.round && m.content===financialToolText(rebound,role)),'financial_link');
    // Both branches must coexist in the final model request, even if calls were sequential.
    check(e.rounds.at(-1)!.messages.some(m=>m.role==='tool' && m.tool_call_id===call.id && m.content===financialToolText(rebound,role)),'financial_link');
    observation.push({role,rpc:binding.request.rpc,argsDigest:rebound.attestation.roles[role]!.argsDigest,responseDigest:rebound.attestation.roles[role]!.responseDigest,factDigest:rebound.attestation.roles[role]!.factDigest,actorDigest:e.actorDigest,httpStatus:200,exactEndpoint:true,toolCallId:call.id!,modelRound:call.round,resultRound:results[0].round});
  }
  check(e.rounds.every(r=>r.messages.filter(m=>m.role==='tool').every(m=>calls.some(c=>c.id===m.tool_call_id))),'financial_link');
  assertFacts(e.answer,rebound);
  return observation;
}
