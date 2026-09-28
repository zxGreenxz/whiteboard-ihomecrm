import { describe,expect,it,vi } from 'vitest';
import { buildMeterBoundaryPayload,readMeterBoundarySet,reviseMeterBoundarySet,type MeterBoundaryInvoker } from '../contractMeterBoundaries';
const id='00000000-0000-4000-8000-000000000001';
const measuredAt='2026-09-28T09:00:00+07:00';
describe('physical handover meter DTO',()=>{
  it('keeps missing separate from a verified zero and rejects hidden money',()=>{
    expect(buildMeterBoundaryPayload({state:'MISSING',reason:'Chưa đo'})).toEqual({state:'MISSING',reason:'Chưa đo',readings:[]});
    expect(buildMeterBoundaryPayload({state:'VERIFIED',readings:[{meterId:id,reading:0,measuredAt}]})).toEqual({state:'VERIFIED',reason:null,readings:[{meter_id:id,reading:0,measured_at:measuredAt,evidence:null}]});
    expect(()=>buildMeterBoundaryPayload({state:'VERIFIED',readings:[{meterId:id,reading:-1,measuredAt}]})).toThrow();
    expect(()=>buildMeterBoundaryPayload({state:'MISSING',reason:'',depositRefund:1} as never)).toThrow();
  });
  it('dispatches selected org and immutable subject/CAS on read and revision',async()=>{
    const invoke=vi.fn<MeterBoundaryInvoker>().mockResolvedValue({data:null,error:null});
    expect(await readMeterBoundarySet(invoke,id,id,'MOVE_OUT')).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith('read_contract_meter_boundary_set_v1',{p_organization_id:id,p_contract_id:id,p_kind:'MOVE_OUT'});
    invoke.mockResolvedValueOnce({data:{id,organization_id:id,contract_id:id,room_id:id,building_id:id,kind:'MOVE_OUT',effective_on:'2026-09-28',state:'REVIEW',revision:2,reason:'Corrected',recorded_by:id,created_at:measuredAt,updated_at:measuredAt,readings:[],affected_invoice_ids:[]},error:null});
    await reviseMeterBoundarySet(invoke,id,{setId:id,expectedRevision:1,idempotencyKey:'meter-key-0001',reason:'Corrected',boundary:{state:'VERIFIED',readings:[]}});
    expect(invoke).toHaveBeenLastCalledWith('revise_contract_meter_boundary_set_v1',expect.objectContaining({p_organization_id:id,p_set_id:id,p_expected_revision:1,p_idempotency_key:'meter-key-0001',p_reason:'Corrected',p_payload:{state:'VERIFIED',reason:null,readings:[]}}));
  });
});
