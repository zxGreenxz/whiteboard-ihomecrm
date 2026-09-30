// @vitest-environment jsdom
import {FinancialWorkflowGuard} from '../financialWorkflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { continueLeadConversion } from '../leadConversionProgress';

describe('continueLeadConversion', () => {
  it('resumes after a confirmed deposit without creating another tenant or deposit', async () => {
    const createTenant = vi.fn();
    const createDeposit = vi.fn();
    const markLead = vi.fn().mockResolvedValue(undefined);
    await continueLeadConversion({ tenantId: 'tenant-1', depositId: 'deposit-1' },
      { createTenant, createDeposit, markLead });
    expect(createTenant).not.toHaveBeenCalled();
    expect(createDeposit).not.toHaveBeenCalled();
    expect(markLead).toHaveBeenCalledOnce();
  });

  it('retains confirmed IDs when a later step fails', async () => {
    const progress: Array<{ tenantId?: string; depositId?: string }> = [];
    await expect(continueLeadConversion({}, {
      createTenant: vi.fn().mockResolvedValue('tenant-1'),
      createDeposit: vi.fn().mockResolvedValue('deposit-1'),
      markLead: vi.fn().mockRejectedValue(new Error('lead write failed')),
    }, value => progress.push(value))).rejects.toThrow('lead write failed');
    expect(progress).toEqual([{ tenantId: 'tenant-1' }, { tenantId: 'tenant-1', depositId: 'deposit-1' }]);
  });
});

beforeEach(()=>localStorage.clear());
const guard=()=>new FinancialWorkflowGuard({scope:async key=>({namespace:'lead-conversion',userId:'actor',organizationId:'org-a',businessKey:key})});
const options=()=>({guard:guard(),leadId:'l1',organizationId:'org-a',readTenant:async(id:string)=>({id,organization_id:'org-a',deleted_at:null}),readDeposit:async(id:string)=>({id,organization_id:'org-a',deleted_at:null,tenant_id:'t1',room_id:'r1'}),readLead:async()=>({id:'l1',organization_id:'org-a',deleted_at:null,status:'B1_LEAD'})});
it('whole conversion survives remount and resumes only a positively verified rejected lead step',async()=>{const steps={createTenant:vi.fn().mockResolvedValue('t1'),createDeposit:vi.fn().mockResolvedValue('d1'),markLead:vi.fn().mockRejectedValueOnce({code:'42501',message:'raw SQL'}).mockResolvedValue({id:'l1',organization_id:'org-a',deleted_at:null,status:'CONVERTED'})};await expect(continueLeadConversion({},steps,vi.fn(),options())).rejects.toThrow();await continueLeadConversion({},steps,vi.fn(),options());expect(steps.createTenant).toHaveBeenCalledTimes(1);expect(steps.createDeposit).toHaveBeenCalledTimes(1);expect(steps.markLead).toHaveBeenCalledTimes(2);});
it('unknown deposit cannot create a new tenant or deposit on remount',async()=>{const steps={createTenant:vi.fn().mockResolvedValue('t1'),createDeposit:vi.fn().mockRejectedValue(new TypeError('Network request failed')),markLead:vi.fn()};await expect(continueLeadConversion({},steps,vi.fn(),options())).rejects.toThrow();await expect(continueLeadConversion({},steps,vi.fn(),options())).rejects.toThrow();expect(steps.createTenant).toHaveBeenCalledTimes(1);expect(steps.createDeposit).toHaveBeenCalledTimes(1);expect(steps.markLead).not.toHaveBeenCalled();});
it('tenant positive read in another organization blocks recovery',async()=>{const steps={createTenant:vi.fn().mockResolvedValue('t1'),createDeposit:vi.fn().mockRejectedValue({code:'42501',message:'rejected'}),markLead:vi.fn()};await expect(continueLeadConversion({},steps,vi.fn(),options())).rejects.toThrow();await expect(continueLeadConversion({},steps,vi.fn(),{...options(),readTenant:async()=>({id:'t1',organization_id:'other',deleted_at:null})})).rejects.toThrow();expect(steps.createDeposit).toHaveBeenCalledTimes(1);});
