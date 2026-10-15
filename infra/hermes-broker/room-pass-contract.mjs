import { domainExact, domainId } from './domain-contract.mjs';
import { REQUEST_ID_GUIDANCE, REQUEST_ID_PROPERTY, REQUEST_ID_STATUS_GUIDANCE } from './request-id-contract.mjs';
export const ROOM_PASS_ACTION='sale_phong.manage_pass_listings';
export function roomPassOperation(name) {
  if (name === 'crm_room_pass_observe') return 'observe';
  if (name === 'crm_room_pass_set_active') return 'set_active';
  if (name === 'crm_room_pass_status') return 'status';
  return null;
}
const revision=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw new TypeError('invalid_room_pass_action');};
export const mayUseRoomPass=(effective,operation)=>['observe','set_active','status'].includes(operation)&&effective?.action?.includes(ROOM_PASS_ACTION)===true;
export function roomPassInput(operation,input){
  const keys=operation==='observe'?['listingId']:operation==='status'?['requestId']:operation==='set_active'?['requestId','listingId','active','expectedRevision']:[];
  if(!keys.length||!domainExact(input,keys)||keys.filter(k=>k.endsWith('Id')).some(k=>!domainId(input[k]))||
    operation==='set_active'&&(typeof input.active!=='boolean'||!revision(input.expectedRevision)))fail();
  return {...input};
}
const snapshot=value=>{
  if(!domainExact(value,['listingId','buildingId','roomId','active','revision'])||!domainId(value.listingId)||!domainId(value.buildingId)||!domainId(value.roomId)||
    typeof value.active!=='boolean'||!revision(value.revision))fail();return {...value};
};
export function roomPassResult(operation,result,identity,input){
  if(operation==='observe'){
    if(!domainExact(result,['organizationId','listing'])||result.organizationId!==identity.row.organizationId)fail();
    const listing=snapshot(result.listing);if(listing.listingId!==input.listingId)fail();return{organizationId:result.organizationId,listing};
  }
  if(!domainExact(result,['requestId','outcome','listing'])||result.requestId!==input.requestId||!['applied','not_found'].includes(result.outcome))fail();
  if(result.outcome==='not_found'){if(operation!=='status'||result.listing!==null)fail();return {...result};}
  const listing=snapshot(result.listing);
  if(operation==='set_active'&&(listing.listingId!==input.listingId||listing.active!==input.active))fail();
  return{requestId:result.requestId,outcome:'applied',listing};
}
export const ROOM_PASS_TOOLS=Object.freeze([
  {name:'crm_room_pass_observe',description:'Xem trạng thái và revision của tin khách nhờ sale trước khi đổi hiển thị công khai.',inputSchema:{type:'object',additionalProperties:false,required:['listingId'],properties:{listingId:{type:'string',format:'uuid'}}}},
  {name:'crm_room_pass_set_active',description:`Bật hoặc ẩn tin khách nhờ sale trên kênh công khai. Cần revision vừa đọc; không đổi hợp đồng hay gửi tin nhắn. ${REQUEST_ID_GUIDANCE}`,inputSchema:{type:'object',additionalProperties:false,required:['requestId','listingId','active','expectedRevision'],properties:{requestId:REQUEST_ID_PROPERTY,listingId:{type:'string',format:'uuid'},active:{type:'boolean'},expectedRevision:{type:'string',pattern:'^[a-f0-9]{64}$'}}}},
  {name:'crm_room_pass_status',description:`Đối soát requestId sau khi mất phản hồi. not_found chỉ nghĩa chưa thấy biên nhận; không tự thử ghi lại. ${REQUEST_ID_STATUS_GUIDANCE}`,inputSchema:{type:'object',additionalProperties:false,required:['requestId'],properties:{requestId:{type:'string',format:'uuid'}}}},
]);
