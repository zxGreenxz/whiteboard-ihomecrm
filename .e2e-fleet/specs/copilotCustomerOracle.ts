import { DEMO_ORG,digest,type GoldenScenario } from '../../scripts/copilot-golden-browser-evidence.mjs';
import { bindCustomerScenario,type CustomerFixture } from '../../scripts/copilot-customer-fixtures.mjs';
import { inspectModelStream,renderedAssistantText,type ReadonlyEvidence } from './copilotSmokeOracle';
export interface CustomerRead {rpc:string;args:Record<string,unknown>;payload:unknown;ok:boolean;actorDigest?:string;exactEndpoint:boolean}
const codes=['customer_binding','customer_cycle','customer_mounted','customer_prompt','customer_tool','customer_read','customer_payload','customer_linked_result','customer_pii','customer_facts','customer_link'] as const;
type Code=typeof codes[number];
export function isCustomerOracleFailureCode(value:unknown):value is Code{return typeof value==='string'&&(codes as readonly string[]).includes(value);}
const failures=new WeakSet<CustomerOracleFailure>();
class CustomerOracleFailure extends Error {readonly code:Code;constructor(code:Code){super(code);this.code=code;failures.add(this);Object.freeze(this);}}
const check:(ok:unknown,code:Code)=>asserts ok=(ok,code)=>{if(!ok)throw new CustomerOracleFailure(code);};
export function customerOracleDiagnostic(caseId:string,error:unknown):{caseId:string;code:Code}|undefined {
  if(['C02','C14'].includes(caseId) && error instanceof CustomerOracleFailure && failures.has(error))return {caseId,code:error.code};
}
export function isGoldenCustomerRead(caseId:string,method:string,url:string,apiOrigin:string):boolean {
  try {const parsed=new URL(url);return ['C02','C14'].includes(caseId) && method==='POST' && parsed.origin===apiOrigin && parsed.pathname==='/rest/v1/rpc/copilot_customer_search_v1' && !parsed.search && !parsed.hash;}catch{return false;}
}
export function customerToolText(fixture:CustomerFixture):string {
  return fixture.payload.length?fixture.payload.map(r=>`- ${r.customer_name} — ${r.phone.slice(0,3)}***${r.phone.slice(-4)} — phòng ${r.room_name} (${r.building_name}) [link: /customers/${r.customer_id}]`).join('\n'):`Không tìm thấy khách hàng nào khớp "${fixture.query}".`;
}
const normal=(text:string)=>text.normalize('NFC').toLowerCase();
function facts(answer:string,stream:string,fixture:CustomerFixture) {
  const row=fixture.payload[0];
  const urls=[...stream.matchAll(/\]\(([^)]+)\)|\[link:\s*([^\]]+)\]|(?:https?:\/\/[^\s)\]]+)|(?:\/(?:customers|contracts|apartments)[^\s)\]]*)/giu)];
  for(const match of urls)check(Boolean(row) && (match[1]??match[2]??match[0])===`/customers/${row.customer_id}`,'customer_link');
  // Exact annotation of the already-proven tool is metadata, not a new fact.
  let text=normal(answer).replace(/\(\s*nguồn:\s*tim_khach_hang\s*\)/gu,'').replace(/\*\*(.*?)\*\*/g,'$1').replace(/[`_]/g,'');
  if(!row) {
    // Consume only the scope qualifier and a negated profile noun phrase.
    // Do not add their individual words to the bag: that admits "Có hồ sơ".
    text=text.replace(/(?<![\p{L}\p{N}])trong phạm vi bạn được xem(?![\p{L}\p{N}])/gu,'')
      .replace(/(?<![\p{L}\p{N}])(không|chưa) (tìm thấy|có) hồ sơ khách hàng(?![\p{L}\p{N}])/gu,'$1 $2 khách hàng');
    check(/không (?:tìm thấy|có).*khách|khách.*không (?:tồn tại|tìm thấy)/iu.test(text) && text.includes(fixture.query),'customer_facts');
    for(const claim of text.matchAll(/(?:tìm thấy|có|tồn tại)\s+khách/giu))check(/(?:không|chưa)\s*$/.test(text.slice(0,claim.index)),'customer_facts');
    const informationRequest=/(?:^|[.!?\n])\s*nếu(?:\s+bạn)?\s+(?:có|tìm thấy)\s+thông tin(?:\s+khách hàng)?\s*,\s*(?:bạn\s+)?vui lòng cung cấp/giu;
    const conditionalRequests=[...text.matchAll(informationRequest)];
    for(const claim of text.matchAll(/(?:tìm thấy|có|tồn tại)\s+(?:thông tin|dữ liệu|kết quả)/giu)) {
      const negated=/(?:không|chưa)\s*$/.test(text.slice(0,claim.index));
      check(negated || conditionalRequests.some(request=>claim.index!>=request.index! && claim.index!<request.index!+request[0].length),'customer_facts');
    }
    // Only the validated if-information-is-available request may consume "nếu";
    // arbitrary condition words cannot hide a later affirmative result.
    const rest=text.split(fixture.query).join('').replace(informationRequest,request=>request.replace('nếu',''));
    check(!/\d|phòng|toà|tòa|hợp đồng|khách hàng\s*[:：]|khách hàng\s+(?:là|tên|có tên)|\]\(|\[link:|https?:|\/[a-z]/iu.test(rest),'customer_facts');
    const absentWords=new Set('không chưa tìm thấy có khách hàng nào khớp với số điện thoại sđt này trong hệ thống dữ liệu hiện tại bạn vui lòng kiểm tra lại hoặc cung cấp thông tin chính xác để tôi hỗ trợ tìm kiếm kết quả theo yêu cầu'.split(' '));
    check((rest.match(/[\p{L}\p{N}]+/gu)??[]).every(w=>absentWords.has(w)),'customer_facts');
    return;
  }
  check(!/không (?:tìm thấy|có).*khách|khách.*không (?:tồn tại|tìm thấy)/iu.test(text),'customer_facts');
  for(const value of [row.customer_name,row.room_name,row.building_name])check(text.includes(normal(value)),'customer_facts');
  // Bind criterion metadata to the exact query, not another grounded row atom.
  const escapedQuery=normal(fixture.query).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  text=text.replace(new RegExp(`(?<![\\p{L}\\p{N}])từ (?:khóa|khoá)\\s*[:：]?\\s*["“]?${escapedQuery}["”]?(?=$|[\\s.,:;!?])`,'gu'),'');
  const masked=`${row.phone.slice(0,3)}***${row.phone.slice(-4)}`;
  // Consume grounded atoms before inspecting remaining prose. Unrecognized
  // names, identifiers, amounts and locations cannot borrow a correct atom.
  text=text.split(`/customers/${row.customer_id}`).join('');
  for(const value of [row.customer_name,row.building_name,row.room_name,masked])text=text.split(normal(value)).join('');
  const allowed=new Set('tìm thấy có một khách hàng cư dân tên là họ và thông tin số điện thoại sđt được đã che ẩn phần phòng đang thuê ở tòa toà nhà thuộc tại kết quả khớp với yêu cầu bạn xem chi tiết hồ sơ nhấn vào đường dẫn liên bấm đây hiện hệ thống của trong mã link'.split(' '));
  const words=text.match(/[\p{L}\p{N}]+/gu)??[];
  check(words.every(w=>allowed.has(w) || w==='1'),'customer_facts');
}
export function assertCustomerResult(e:Pick<ReadonlyEvidence,'prompt'|'answer'|'rounds'> & {scenario:GoldenScenario;fixture:CustomerFixture;actorDigest:string;reads:CustomerRead[]}):void {
  let rebound:CustomerFixture;
  try{rebound=bindCustomerScenario(e.scenario,e.fixture);}catch{throw new CustomerOracleFailure('customer_binding');}
  check(digest(rebound.attestation)===digest(e.fixture.attestation) && e.actorDigest===e.fixture.actorDigest,'customer_binding');
  const streams=e.rounds.map(r=>inspectModelStream(r.body));
  check(streams.length===2 && streams[0].finish==='tool_calls' && streams[1].finish==='stop','customer_cycle');
  check(Boolean(streams[1].text.trim()) && e.answer.trim()===renderedAssistantText(streams[1].text),'customer_mounted');
  check(e.prompt===rebound.prompt && e.rounds[0].messages.some(m=>m.role==='user' && m.content===e.prompt),'customer_prompt');
  const calls=streams.flatMap(s=>s.tools);
  check(calls.length===1 && calls[0].name==='tim_khach_hang' && typeof calls[0].id==='string' && calls[0].id.trim().length>0,'customer_tool');
  let args:unknown;try{args=JSON.parse(calls[0].arguments);}catch{throw new CustomerOracleFailure('customer_tool');}
  check(digest(args)===digest({tu_khoa:e.fixture.query}),'customer_tool');
  check(e.reads.length===1,'customer_read');
  const read=e.reads[0];
  check(read.ok && read.exactEndpoint===true && read.actorDigest===e.actorDigest && read.rpc==='copilot_customer_search_v1'
    && digest(read.args)===digest({p_organization_id:DEMO_ORG,p_search:e.fixture.query}),'customer_read');
  check(digest(read.payload)===e.fixture.attestation.responseDigest,'customer_payload');
  const results=e.rounds.flatMap((r,round)=>r.messages.filter(m=>m.role==='tool').map(m=>({...m,round})));
  check(results.length===1 && results[0].round===1 && results[0].tool_call_id===calls[0].id && results[0].content===customerToolText(e.fixture),'customer_linked_result');
  for(const row of e.fixture.payload) {
    const escaped=row.phone.split('').join('[\\s.\\-]*');
    const raw=new RegExp(escaped);
    check(!e.rounds.some(r=>r.messages.some(m=>typeof m.content==='string' && raw.test(m.content))) && !streams.some(s=>raw.test(s.text)) && !raw.test(e.answer),'customer_pii');
  }
  facts(e.answer,streams[1].text,e.fixture);
}
