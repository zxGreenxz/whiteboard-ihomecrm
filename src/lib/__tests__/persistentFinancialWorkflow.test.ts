// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({userId:'actor',onRead:null as null|(()=>void)}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>{h.onRead?.();return {id:h.userId};}}));
import {persistentFinancialWorkflow} from '../persistentFinancialWorkflow';
beforeEach(()=>{localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','org-a');h.userId='actor';h.onRead=null;});
it('blocks the same unresolved workflow after remount and scopes it to the selected organization',async()=>{
 let calls=0;const task=async()=>{calls++;throw new TypeError('Failed to fetch');};
 await expect(persistentFinancialWorkflow('test').run('voucher','ghi phiếu',task)).rejects.toMatchObject({outcome:'unknown'});
 await expect(persistentFinancialWorkflow('test').run('voucher','ghi phiếu',task)).rejects.toMatchObject({outcome:'unknown'});
 expect(calls).toBe(1);
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(persistentFinancialWorkflow('test').run('voucher','ghi phiếu',task)).rejects.toMatchObject({outcome:'unknown'});
 expect(calls).toBe(2);
});
it('does not run a writer without a resolved organization',async()=>{
 localStorage.clear();const writer=vi.fn();
 await expect(persistentFinancialWorkflow('test').run('new','lập phiếu',writer)).rejects.toMatchObject({outcome:'failure'});
 expect(writer).not.toHaveBeenCalled();
});

it('isolates blocked state when the organization changes within the same guard',async()=>{
 const guard=persistentFinancialWorkflow('test');let calls=0;const task=async()=>{calls++;throw new TypeError('Failed to fetch');};
 await expect(guard.run('one','ghi tiền',task)).rejects.toMatchObject({outcome:'unknown'});
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(guard.run('one','ghi tiền',task)).rejects.toMatchObject({outcome:'unknown'});
 expect(calls).toBe(2);
});

it('blocks a submission when organization changes during identity lookup',async()=>{
 const writer=vi.fn();h.onRead=()=>localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(persistentFinancialWorkflow('test').run('draft','lập phiếu',writer)).rejects.toMatchObject({outcome:'failure'});
 expect(writer).not.toHaveBeenCalled();
});

it('blocks an old organization payload before writing or storing under another organization',async()=>{
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');const writer=vi.fn();
 await expect(persistentFinancialWorkflow('test').run('org-a:month','chốt lợi nhuận',writer,undefined,'org-a')).rejects.toMatchObject({outcome:'failure'});
 expect(writer).not.toHaveBeenCalled();
 expect(Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'))).toEqual([]);
});

it('explains a missing organization before comparing the submitted scope', async()=>{
 localStorage.clear(); const writer=vi.fn();
 await expect(persistentFinancialWorkflow('test').run('record','lưu phiếu',writer,undefined,'org-a')).rejects.toMatchObject({outcome:'failure', message:expect.stringContaining('Không xác định được tổ chức')});
 expect(writer).not.toHaveBeenCalled();
});

it('uses the actual row organization for an authorized multi-organization inbox',async()=>{
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');let writes=0;
 const guard=(persistentFinancialWorkflow as unknown as (namespace:string,options:{scope:string})=>ReturnType<typeof persistentFinancialWorkflow>)('inbox',{scope:'target'});
 await expect(guard.run('request-a','duyệt phiếu',async()=>{writes++;throw new TypeError('Failed to fetch');},undefined,'org-a')).rejects.toMatchObject({outcome:'unknown'});
 const marker=Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'));expect(marker).toHaveLength(1);expect(JSON.parse(localStorage.getItem(marker[0])!).organizationId).toBe('org-a');expect(writes).toBe(1);
});
it('does not run a target-scoped writer without an authoritative row organization',async()=>{
 const writer=vi.fn();const guard=(persistentFinancialWorkflow as unknown as (namespace:string,options:{scope:string})=>ReturnType<typeof persistentFinancialWorkflow>)('inbox',{scope:'target'});
 await expect(guard.run('missing','duyệt phiếu',writer)).rejects.toMatchObject({outcome:'failure'});expect(writer).not.toHaveBeenCalled();
});
it('keeps an actor-scoped multi-organization action blocked when the selected organization changes',async()=>{
 let writes=0;const options={scope:'actor'};const factory=persistentFinancialWorkflow as unknown as (namespace:string,options:{scope:string})=>ReturnType<typeof persistentFinancialWorkflow>;
 await expect(factory('global-payroll',options).run('owner-month','chốt lương',async()=>{writes++;throw new TypeError('Failed to fetch');})).rejects.toMatchObject({outcome:'unknown'});
 localStorage.setItem('ihomecrm.selectedOrganizationId','org-b');
 await expect(factory('global-payroll',options).run('owner-month','chốt lương',async()=>{writes++;})).rejects.toMatchObject({outcome:'unknown'});expect(writes).toBe(1);
});
