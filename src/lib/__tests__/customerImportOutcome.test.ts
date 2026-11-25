// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:io.from}}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'actor'})}));
import {importCustomerBatch,saveImportedCustomerImages} from '../customerImportOutcome';
import {FinancialWorkflowError} from '../financialWorkflow';
import type {CustomerImportRow} from '../customerExcelHelpers';
function chain(data:unknown){const q:Record<string,unknown>={then:(r:(v:unknown)=>void)=>r({data,error:null})};for(const m of ['update','eq','select','single'])q[m]=vi.fn(()=>q);return q;}
const pendingKeys=()=>Object.keys(localStorage).filter(key=>key.startsWith('ihome:financial-pending:'));
beforeEach(()=>{vi.resetAllMocks();localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId','o1');});
it('image update needs an exact receipt, rather than zero affected rows',async()=>{io.from.mockReturnValue(chain(null));await expect(saveImportedCustomerImages('c1',{front:'stored'})).rejects.toBeInstanceOf(FinancialWorkflowError);});
// Đợt 4: ảnh chưa xong là kết quả rõ của dòng đó (khách đã tạo): báo theo dòng, không giữ dấu chặn lượt nhập sau.
it('partial image result keeps the created customer ID per row and does not block another batch',async()=>{io.from.mockReturnValue(chain(null));const steps={create:vi.fn().mockResolvedValue('c1'),uploadImages:vi.fn().mockResolvedValue({front:'stored'})};const report=vi.fn();const rows=[{full_name:'Khách',phone:'0900',id_image_urls:['external']}];await importCustomerBatch(rows,steps,report);expect(report.mock.lastCall?.[0].partialRows[0].id).toBe('c1');expect(pendingKeys()).toEqual([]);await importCustomerBatch([{full_name:'Khách khác',phone:'0901'}],steps,report);expect(steps.create).toHaveBeenCalledTimes(2);});
// Đợt 4: dòng chưa rõ kết quả và các dòng sau nằm ở `retryRows` (cùng mã khách của từng dòng); dòng đã tạo không bị gửi lại.
it('later unknown keeps earlier customer IDs and only the unfinished rows are offered for retry',async()=>{const steps={create:vi.fn().mockResolvedValueOnce('c1').mockRejectedValueOnce(new FinancialWorkflowError('Chưa xác nhận khách mới.','unknown',[{id:'c2',label:'Khách cần đối chiếu'}])),uploadImages:vi.fn()};const report=vi.fn();const rows:CustomerImportRow[]=[{full_name:'A',phone:'0900'},{full_name:'B',phone:'0901'}];const result=await importCustomerBatch(rows,steps,report);expect(result.successRows.map(row=>row.id)).toEqual(['c1']);expect(report.mock.lastCall?.[0].unknownRows[0].reason).toContain('c2');expect(result.retryRows.map(row=>row.full_name)).toEqual(['B']);expect(result.retryRows[0].client_id).toEqual(expect.any(String));expect(result.retryRows[0].client_id).toBe(rows[1].client_id);expect(pendingKeys()).toEqual([]);});

it('all rows rejected are reported per row and a corrected retry is not blocked',async()=>{const steps={create:vi.fn().mockRejectedValue({code:'23505',message:'SQL secret'}),uploadImages:vi.fn()};const rows=[{full_name:'A',phone:'0900'}];const report=vi.fn();const first=await importCustomerBatch(rows,steps,report);expect(first.failRows).toHaveLength(1);expect(first.retryRows).toEqual([]);await importCustomerBatch(rows,steps,report);expect(steps.create).toHaveBeenCalledTimes(2);expect(report.mock.lastCall?.[0].failRows).toHaveLength(1);expect(report.mock.lastCall?.[0].failRows[0].reason).not.toContain('SQL secret');});
