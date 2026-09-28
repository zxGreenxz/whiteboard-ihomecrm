import { describe, expect, it } from 'vitest';
import { buildCreateTransferArgs, transferBrokerFeeLine, withTransferBrokerFee } from '../transfers';

const org='00000000-0000-4000-8000-000000000001';
const link='00000000-0000-4000-8000-000000000008';
const input={oldExitCaseId:org,newDraftId:link,expectedExitVersion:1,expectedDraftRevision:2,mode:'SELF_FOUND' as const,depositMode:'NEW_PAYMENT' as const,termMode:'NEW_TERM' as const,brokerName:null,reason:'Khách tự tìm người nhận',requestId:link};
describe('linked contract transfer inputs',()=>{
  it('builds only scoped operational link data, never payment options',()=>{
    expect(buildCreateTransferArgs(input,org)).toMatchObject({p_organization_id:org,p_expected_exit_version:1,p_expected_draft_revision:2,p_deposit_mode:'NEW_PAYMENT'});
    expect(()=>buildCreateTransferArgs({...input,mode:'BROKER',depositMode:'OLD_DEPOSIT_OFFSET',brokerName:'Broker'},org)).toThrow();
    expect(()=>buildCreateTransferArgs({...input,reason:''},org)).toThrow();
  });
  it('previews the exact 50% fee once and preserves other deductions',()=>{
    const fee=transferBrokerFeeLine({id:link,mode:'BROKER',broker_fee:2_000_000});
    expect(fee).toEqual({kind:'CUSTOM',description:`TRANSFER_BROKER_FEE:${link}`,amount:2_000_000});
    const charges=withTransferBrokerFee([{kind:'CLEANING',description:'Dọn',amount:100_000}],fee);
    expect(charges.reduce((sum,x)=>sum+x.amount,0)).toBe(2_100_000);
    expect(withTransferBrokerFee(charges,fee)).toEqual(charges);
    expect(()=>withTransferBrokerFee([{...fee!,amount:1}],fee)).toThrow();
    expect(transferBrokerFeeLine({id:link,mode:'SELF_FOUND',broker_fee:0})).toBeNull();
  });
});
