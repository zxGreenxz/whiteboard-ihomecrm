import { domainExact, domainId, domainRecord } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE } from './request-id-contract.mjs';
export const ROOM_PASS_ACTION='sale_phong.manage_pass_listings';
// observe/set_active stay on the applied hermes_room_pass_action_v1; lookup/upsert
// (and status, which also reconciles upsert receipts) use hermes_room_pass_upsert_v1.
const TOOL_OPERATIONS=Object.freeze({crm_room_pass_observe:'observe',crm_room_pass_set_active:'set_active',crm_room_pass_status:'status',
  crm_room_pass_upsert:'upsert',crm_room_lookup:'lookup'});
const OPERATIONS=Object.freeze(Object.values(TOOL_OPERATIONS));
export const roomPassOperation=name=>typeof name==='string'&&Object.hasOwn(TOOL_OPERATIONS,name)?TOOL_OPERATIONS[name]:null;
export const ROOM_PASS_UPSERT_OPERATIONS=Object.freeze(['lookup','upsert']);
const revision=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw new TypeError('invalid_room_pass_action');};
export const mayUseRoomPass=(effective,operation)=>OPERATIONS.includes(operation)&&effective?.action?.includes(ROOM_PASS_ACTION)===true;
// SQL char_length/left() count code points; never compare with UTF-16 .length.
const points=value=>[...value].length;
const CONTROL=/[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
const POLICY_CONTROL=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
export const ROOM_PASS_LIMITS=Object.freeze({customerName:120,salePolicy:2000,passPrice:1000000000,buildingName:120,roomCode:40,buildingTokens:8});
const UPSERT_KEYS=Object.freeze(['requestId','roomId','customerPhone','customerName','contactManager','passPrice','availDate','salePolicy','active']);
const calendarDate=value=>typeof value==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)&&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
// Input bound mirrors SQL: years 2000–2100 only.
const isDate=value=>calendarDate(value)&&/^(20[0-9]{2}|2100)-/.test(value);
// Only an explicit null clears a stored value. An empty or blank string is what a
// model sends for "không có thông tin", so it is treated as ABSENT (keep as is),
// never as a clear.
const ABSENT=Symbol('absent');
function optionalText(value,max,control){
  if(value===null)return null;
  if(typeof value!=='string')fail();
  const text=value.trim();
  if(!text)return ABSENT;
  if(points(text)>max||control.test(text))fail();
  return text;
}
// Vietnamese phone, written as digits like customers.phone (10–11 digits);
// separators are dropped and +84 becomes 0.
function phone(value){
  if(value===null)return null;
  if(typeof value!=='string'||value.length>40)fail();
  let digits=value.replace(/[\s.\-()]/g,'');
  if(!digits)return ABSENT;
  if(digits.startsWith('+84'))digits=`0${digits.slice(3)}`;
  if(!/^[0-9]{10,11}$/.test(digits))fail();
  return digits;
}
const keep=(out,key,value)=>{if(value!==ABSENT)out[key]=value;};
const query=(value,max)=>{
  if(typeof value!=='string')fail();
  const text=value.trim().replace(/\s+/g,' ');
  if(!text||points(text)>max||CONTROL.test(text))fail();
  return text;
};
export function roomPassInput(operation,input){
  if(operation==='upsert'){
    if(!domainRecord(input)||!Object.keys(input).every(key=>UPSERT_KEYS.includes(key))||!domainId(input.requestId)||!domainId(input.roomId))fail();
    const out={requestId:input.requestId,roomId:input.roomId};
    if(Object.hasOwn(input,'customerPhone'))keep(out,'customerPhone',phone(input.customerPhone));
    if(Object.hasOwn(input,'customerName'))keep(out,'customerName',optionalText(input.customerName,ROOM_PASS_LIMITS.customerName,CONTROL));
    if(Object.hasOwn(input,'salePolicy'))keep(out,'salePolicy',optionalText(input.salePolicy,ROOM_PASS_LIMITS.salePolicy,POLICY_CONTROL));
    if(Object.hasOwn(input,'passPrice')){
      if(input.passPrice!==null&&!(Number.isSafeInteger(input.passPrice)&&input.passPrice>0&&input.passPrice<=ROOM_PASS_LIMITS.passPrice))fail();
      out.passPrice=input.passPrice;
    }
    if(Object.hasOwn(input,'availDate')){if(input.availDate!==null&&!isDate(input.availDate))fail();out.availDate=input.availDate;}
    for(const key of ['contactManager','active'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='boolean')fail();out[key]=input[key];}
    return out;
  }
  if(operation==='lookup'){
    if(!domainExact(input,['buildingName','roomCode']))fail();
    const out={buildingName:query(input.buildingName,ROOM_PASS_LIMITS.buildingName),roomCode:query(input.roomCode,ROOM_PASS_LIMITS.roomCode)};
    if(out.buildingName.split(' ').length>ROOM_PASS_LIMITS.buildingTokens)fail();
    return out;
  }
  const keys=operation==='observe'?['listingId']:operation==='status'?['requestId']:operation==='set_active'?['requestId','listingId','active','expectedRevision']:[];
  if(!keys.length||!domainExact(input,keys)||keys.filter(k=>k.endsWith('Id')).some(k=>!domainId(input[k]))||
    operation==='set_active'&&(typeof input.active!=='boolean'||!revision(input.expectedRevision)))fail();
  return {...input};
}
const snapshot=value=>{
  if(!domainExact(value,['listingId','buildingId','roomId','active','revision'])||!domainId(value.listingId)||!domainId(value.buildingId)||!domainId(value.roomId)||
    typeof value.active!=='boolean'||!revision(value.revision))fail();return {...value};
};
// Display text produced by SQL hermes_domain_text_v1 (≤200 code points, no controls).
const label=value=>typeof value==='string'&&value.length<=400&&points(value)<=200&&!CONTROL.test(value);
const nullableLabel=value=>value===null||label(value);
// Masked only: three stars and at most the last four digits; a full phone fails.
const masked=value=>value===null||typeof value==='string'&&/^\*{3}[0-9]{0,4}$/.test(value);
const contact=value=>{
  if(!domainExact(value,['name','phoneMasked'])||!nullableLabel(value.name)||!masked(value.phoneMasked))fail();
  return {...value};
};
// provided = input carried customerPhone/customerName; representative = new listing
// auto-filled from the active contract (public page then shows the manager);
// unchanged = contact kept (or left empty when no representative exists).
const CONTACT_SOURCES=Object.freeze(['provided','representative','unchanged']);
const upsertResult=(result,requestId)=>{
  if(!domainExact(result,['requestId','outcome','change','listing','contact','contactSource'])||result.requestId!==requestId||result.outcome!=='applied'||
    !['created','updated'].includes(result.change)||!CONTACT_SOURCES.includes(result.contactSource)||
    result.contactSource==='representative'&&result.change!=='created')fail();
  return{requestId:result.requestId,outcome:'applied',change:result.change,listing:snapshot(result.listing),contact:contact(result.contact),
    contactSource:result.contactSource};
};
function lookupResult(result,identity){
  if(!domainExact(result,['organizationId','rooms','truncated'])||result.organizationId!==identity.row.organizationId||
    typeof result.truncated!=='boolean'||!Array.isArray(result.rooms)||result.rooms.length>10)fail();
  const seen=new Set();
  const rooms=result.rooms.map(room=>{
    if(!domainExact(room,['roomId','roomName','roomCode','roomStatus','buildingId','buildingName','hasActiveContract','representative','passListing'])||
      !domainId(room.roomId)||seen.has(room.roomId)||!label(room.roomName)||!nullableLabel(room.roomCode)||
      typeof room.roomStatus!=='string'||!/^[A-Z_]{1,32}$/.test(room.roomStatus)||!domainId(room.buildingId)||!label(room.buildingName)||
      typeof room.hasActiveContract!=='boolean')fail();
    seen.add(room.roomId);
    const pass=room.passListing;
    if(pass!==null&&(!domainExact(pass,['listingId','active','passPrice','availDate'])||!domainId(pass.listingId)||typeof pass.active!=='boolean'||
      !(pass.passPrice===null||typeof pass.passPrice==='number'&&Number.isFinite(pass.passPrice)&&pass.passPrice>=0&&pass.passPrice<=1e12)||
      !(pass.availDate===null||calendarDate(pass.availDate))))fail();
    return{...room,representative:room.representative===null?null:contact(room.representative),passListing:pass===null?null:{...pass}};
  });
  return{organizationId:result.organizationId,rooms,truncated:result.truncated};
}
export function roomPassResult(operation,result,identity,input){
  if(operation==='lookup')return lookupResult(result,identity);
  if(operation==='upsert'){
    const value=upsertResult(result,input.requestId);
    const provided=Object.hasOwn(input,'customerPhone')||Object.hasOwn(input,'customerName');
    if(value.listing.roomId!==input.roomId||Object.hasOwn(input,'active')&&value.listing.active!==input.active||
      (provided?value.contactSource!=='provided':value.contactSource==='provided'))fail();
    return value;
  }
  if(operation==='observe'){
    if(!domainExact(result,['organizationId','listing'])||result.organizationId!==identity.row.organizationId)fail();
    const listing=snapshot(result.listing);if(listing.listingId!==input.listingId)fail();return{organizationId:result.organizationId,listing};
  }
  // status reconciles either receipt kind: set_active (3 keys) or upsert (6 keys).
  if(operation==='status'&&domainRecord(result)&&Object.hasOwn(result,'change'))return upsertResult(result,input.requestId);
  if(!domainExact(result,['requestId','outcome','listing'])||result.requestId!==input.requestId||!['applied','not_found'].includes(result.outcome))fail();
  if(result.outcome==='not_found'){if(operation!=='status'||result.listing!==null)fail();return {...result};}
  const listing=snapshot(result.listing);
  if(operation==='set_active'&&(listing.listingId!==input.listingId||listing.active!==input.active))fail();
  return{requestId:result.requestId,outcome:'applied',listing};
}
const nullableString=(max,extra={})=>({type:['string','null'],maxLength:max,...extra});
export const ROOM_PASS_TOOLS=Object.freeze([
  {name:'crm_room_pass_observe',description:'Xem trạng thái và revision của tin khách nhờ sale trước khi đổi hiển thị công khai.',inputSchema:{type:'object',additionalProperties:false,required:['listingId'],properties:{listingId:{type:'string',format:'uuid'}}}},
  {name:'crm_room_pass_set_active',description:`Bật hoặc ẩn tin khách nhờ sale trên kênh công khai. Cần revision vừa đọc; không đổi hợp đồng hay gửi tin nhắn. ${REQUEST_ID_GUIDANCE}`,inputSchema:{type:'object',additionalProperties:false,required:['requestId','listingId','active','expectedRevision'],properties:{requestId:REQUEST_ID_PROPERTY,listingId:{type:'string',format:'uuid'},active:{type:'boolean'},expectedRevision:{type:'string',pattern:'^[a-f0-9]{64}$'}}}},
  {name:'crm_room_pass_status',description:`Đối soát requestId của crm_room_pass_set_active hoặc crm_room_pass_upsert sau khi mất phản hồi (room_pass_outcome_unknown). not_found chỉ nghĩa chưa thấy biên nhận; không tự thử ghi lại bằng mã mới. ${REQUEST_ID_STATUS_GUIDANCE}`,inputSchema:{type:'object',additionalProperties:false,required:['requestId'],properties:{requestId:{type:'string',format:'uuid'}}}},
  {name:'crm_room_lookup',description:'Tra phòng theo toà + tên/mã phòng để lấy roomId cho tin "Khách nhờ sale" (pass/sang phòng), GỒM CẢ phòng đang có khách thuê. Trả tên/mã phòng, trạng thái phòng, có hợp đồng đang hiệu lực không, khách đại diện (SĐT đã che, chỉ 4 số cuối) và tin pass hiện có của phòng (listingId, đang hiện/ẩn, giá, ngày trống). Chỉ đọc; chỉ các toà bạn vừa xem được vừa được quản lý tin pass. buildingName: tên, mã hoặc địa chỉ toà như người dùng viết (vd "417/57 Lê Văn Thọ"; khớp mọi từ, không phân biệt dấu). roomCode: tên/mã phòng (vd "103"). Có khớp chính xác thì chỉ trả phòng khớp chính xác; tối đa 10 phòng (truncated=true là còn nữa). Không thấy hoặc nhiều phòng ở các toà khác nhau thì hỏi lại người dùng, không đoán roomId.',
    inputSchema:{type:'object',additionalProperties:false,required:['buildingName','roomCode'],properties:{buildingName:{type:'string',minLength:1,maxLength:ROOM_PASS_LIMITS.buildingName},roomCode:{type:'string',minLength:1,maxLength:ROOM_PASS_LIMITS.roomCode}}},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:'crm_room_pass_upsert',description:`Dùng khi khách đang thuê muốn tìm người thay / nhượng lại phòng của mình (pass phòng, sang phòng, khách nhờ sale). Nếu chưa rõ người dùng muốn đăng tin pass phòng hay chuyển hợp đồng của khách sang phòng khác thì hỏi lại một câu ngắn; Hermes chưa có công cụ chuyển hợp đồng sang phòng khác. Tạo mới hoặc sửa tin "Khách nhờ sale" (pass phòng) của MỘT phòng trên trang Sale phòng, tab "Khách nhờ sale" — cùng đường lưu với form "Thêm phòng pass". Khi người dùng dán/nhắn tin pass phòng và muốn cập nhật lên CRM: (1) trích toà, phòng, giá, ngày trống, SĐT/tên liên hệ và các điều kiện; (2) gọi crm_room_lookup lấy roomId (không thấy hoặc nhiều phòng khớp thì hỏi lại); (3) lấy requestId bằng crm_new_request_id; (4) gọi tool này ngay, không cần hỏi xác nhận lại khi yêu cầu đã rõ; báo lại kết quả. passPrice: số nguyên VND/tháng (3.500.000 hoặc "3tr5" → 3500000). availDate: YYYY-MM-DD; tin thiếu năm (vd "1/11") thì chọn năm hiện tại, hoặc năm tới nếu ngày đó đã qua hơn một tháng, và nói rõ năm đã chọn khi báo lại. salePolicy: gom điện, nước, phí dịch vụ, nội thất, số người/xe tối đa, ưu đãi/thưởng sale thành một đoạn ngắn, giữ nguyên số liệu (vd "Điện 3.5k/số; nước 100k/người; phí DV 150k/phòng; đủ nội thất; tối đa 2 người 2 xe"). customerPhone: SĐT khách viết liền chữ số, chỉ gửi khi tin có SĐT liên hệ của khách; customerName: tên người liên hệ. contactManager=true khi khách muốn ẩn số và để quản lý nghe máy. active=false để lưu nhưng ẩn khỏi trang công khai. Không gửi trường = giữ nguyên khi sửa / mặc định khi tạo (contactManager=false, active=true); chuỗi rỗng cũng coi như không gửi; chỉ null mới xoá giá trị đó. Sửa áp vào tin ĐANG HIỆN của phòng; phòng chưa có tin đang hiện thì tạo tin mới (muốn hiện lại tin cũ đang ẩn thì dùng crm_room_pass_set_active). Tạo mới mà không gửi cả SĐT lẫn tên thì tự lấy khách đại diện của hợp đồng đang hiệu lực và LUÔN bật contactManager (trang công khai hiện SĐT quản lý, không lộ số khách). Kết quả contactSource: provided = liên hệ lấy từ tin; representative = tự điền khách đại diện, số khách đã ẩn; unchanged = giữ liên hệ cũ (hoặc để trống khi phòng không có khách đại diện) — báo rõ điều này cho người dùng. Không đổi hợp đồng, khách thuê hay trạng thái phòng. ${REQUEST_ID_GUIDANCE} Mất phản hồi (room_pass_outcome_unknown) thì tra crm_room_pass_status bằng đúng requestId đó, không gọi lại bằng mã mới.`,
    inputSchema:{type:'object',additionalProperties:false,required:['requestId','roomId'],properties:{requestId:REQUEST_ID_PROPERTY,roomId:{type:'string',format:'uuid'},
      customerPhone:nullableString(40,{description:'SĐT khách, vd 0354058160'}),customerName:nullableString(ROOM_PASS_LIMITS.customerName),
      contactManager:{type:'boolean'},passPrice:{type:['integer','null'],minimum:1,maximum:ROOM_PASS_LIMITS.passPrice},
      availDate:{type:['string','null'],pattern:'^\\d{4}-\\d{2}-\\d{2}$'},salePolicy:nullableString(ROOM_PASS_LIMITS.salePolicy),active:{type:'boolean'}}},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
]);
