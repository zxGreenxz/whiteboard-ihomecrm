// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
import {persistentFinancialWorkflow} from '../persistentFinancialWorkflow';
import {financialPending} from '../financialPending';
import {runBuildingSaveWorkflow} from '../buildingSaveWorkflow';
const scope={namespace:'building-form-save',userId:'actor',organizationId:'org-a',businessKey:'create'};
const core={id:'b1',organization_id:'org-a',name:'Tòa A',code:'TA'};
function fixture(){return {key:'create',organizationId:'org-a',expectedCore:{name:'Tòa A',code:'TA'},writeCore:vi.fn().mockResolvedValue(core),readCore:vi.fn().mockResolvedValue([core]),saveRelated:vi.fn().mockResolvedValue(undefined)};}
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');});
it('reload after a related failure verifies the core before resuming and never creates it twice',async()=>{
 const io=fixture();io.saveRelated.mockRejectedValueOnce({code:'42501',message:'raw SQL'});
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'partial',completed:[{id:'b1'}]});
 expect(financialPending.read(scope)?.completedIds).toEqual(['b1']);
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).resolves.toBe('b1');
 expect(io.writeCore).toHaveBeenCalledTimes(1);expect(io.readCore).toHaveBeenCalledWith(['b1']);expect(io.saveRelated).toHaveBeenCalledTimes(2);expect(financialPending.read(scope)).toBeNull();
});
it('child IDs are not mistaken for the building ID during recovery',async()=>{
 const io=fixture();io.saveRelated.mockImplementationOnce(async(_id,progress)=>{progress.completed.push({id:'child',label:'Dịch vụ'});throw new Error('offline');});
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'partial'});
 io.readCore.mockResolvedValue([{id:'child',organization_id:'org-a',name:'Wrong',code:'CHILD'},core]);
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).resolves.toBe('b1');
 expect(io.saveRelated).toHaveBeenLastCalledWith('b1',expect.objectContaining({completed:expect.arrayContaining([{id:'child',label:expect.any(String)}])}),true);
});
it.each([[{...core,organization_id:'org-b'}],[{...core,name:'Another'}],[]])('mismatch or absence cannot release the marker or replay the core: %j',async(rows)=>{
 const io=fixture();io.saveRelated.mockRejectedValueOnce(new Error('offline'));
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'partial'});io.readCore.mockResolvedValue(rows);
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'partial'});
 expect(io.writeCore).toHaveBeenCalledTimes(1);expect(io.saveRelated).toHaveBeenCalledTimes(1);expect(financialPending.read(scope)).not.toBeNull();
});
it('a core response without an ID cannot be replayed after reload',async()=>{
 const io=fixture();io.writeCore.mockResolvedValue({});
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'unknown'});
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'unknown'});expect(io.writeCore).toHaveBeenCalledTimes(1);expect(io.readCore).not.toHaveBeenCalled();
});
it('recovery read error keeps the prior receipt even if SQL rejected the read',async()=>{
 const io=fixture();io.saveRelated.mockRejectedValueOnce(new Error('offline'));
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'partial'});io.readCore.mockRejectedValue({code:'42501',message:'raw SQL'});
 await expect(runBuildingSaveWorkflow(persistentFinancialWorkflow('building-form-save'),io)).rejects.toMatchObject({outcome:'partial'});expect(financialPending.read(scope)?.completedIds).toEqual(['b1']);expect(io.writeCore).toHaveBeenCalledTimes(1);
});