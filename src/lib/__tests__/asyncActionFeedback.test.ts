import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {FeedbackOptions,FriendlyError} from '../friendlyError';
const h=vi.hoisted(()=>({convert:vi.fn<(error:unknown,fallback:string,options?:FeedbackOptions)=>FriendlyError>(),error:vi.fn<(title:string,options:{description:string;id:string})=>unknown>(),report:vi.fn(),loads:vi.fn()}));
vi.mock('sonner',()=>({toast:{error:h.error}}));
vi.mock('@/components/errors/boundaryReporter',()=>({reportBoundaryError:h.report}));
beforeEach(()=>{
 vi.resetModules();vi.clearAllMocks();h.error.mockReset();h.report.mockReset();h.convert.mockReset();
 vi.doMock('../friendlyError',()=>{h.loads();return {friendlyError:h.convert};});
});
afterEach(()=>{vi.doUnmock('../friendlyError');});
const deliveredText=()=>h.error.mock.calls.map(([title,options])=>`${String(title)} ${String((options as {description?:unknown}|undefined)?.description??'')}`).join(' ');
describe('async action error delivery',()=>{
 it('loads the converter only for an error and delivers its exact title/description once',async()=>{
  const {notifyActionError}=await import('../asyncActionFeedback');
  expect(h.loads).not.toHaveBeenCalled();
  const error={code:'42501',message:'private SQL'};const options:FeedbackOptions={operation:'lưu phiếu',financial:true};
  h.convert.mockReturnValue({title:'Không đủ quyền',description:'Bạn không có quyền lưu phiếu.',fieldErrors:{}});
  expect(notifyActionError(error,'Chưa lưu được phiếu',options)).toBeUndefined();
  await vi.waitFor(()=>expect(h.error).toHaveBeenCalledOnce());
  expect(h.convert).toHaveBeenCalledOnce();expect(h.convert).toHaveBeenCalledWith(error,'Chưa lưu được phiếu',options);
  expect(h.error).toHaveBeenCalledWith('Không đủ quyền',{description:'Bạn không có quyền lưu phiếu.',id:expect.stringMatching(/^async-action-error-/)});
  expect(h.loads).toHaveBeenCalledOnce();expect(h.report).not.toHaveBeenCalled();
 });
 it('an import failure retains input/state guidance without exposing either raw error',async()=>{
  const failure=new Error('chunk private server trace');vi.doMock('../friendlyError',()=>{throw failure;});
  const {notifyActionError}=await import('../asyncActionFeedback');notifyActionError({message:'private policy SQL'},'Chưa lưu được ghi chú',{operation:'lưu ghi chú'});
  await vi.waitFor(()=>expect(h.error).toHaveBeenCalledOnce());
  expect(deliveredText()).toContain('lưu ghi chú');expect(deliveredText()).toMatch(/Giữ thông tin đang nhập/);expect(deliveredText()).toMatch(/kiểm tra.*trạng thái/i);expect(deliveredText()).not.toMatch(/private|SQL|trace/);
  expect(h.report).toHaveBeenCalledOnce();
 });
 it('financial fallback after import failure forbids another blind command',async()=>{
  vi.doMock('../friendlyError',()=>{throw new Error('private chunk path');});
  const {notifyActionError}=await import('../asyncActionFeedback');notifyActionError(new TypeError('Failed to fetch'),'Chưa chi được',{operation:'chi tiền',financial:true});
  await vi.waitFor(()=>expect(h.error).toHaveBeenCalledOnce());
  expect(deliveredText()).toMatch(/Chưa xác nhận/);expect(deliveredText()).toContain('chi tiền');expect(deliveredText()).toMatch(/đối chiếu/i);expect(deliveredText()).toMatch(/Không gửi thêm/);expect(deliveredText()).not.toMatch(/private|Failed to fetch/);
 });
 it('sink failure gets one safe fallback and preserves diagnostics without another conversion',async()=>{
  const sinkError=new Error('private toast sink');h.error.mockImplementationOnce(()=>{throw sinkError;});
  h.convert.mockReturnValue({title:'Không đủ quyền',description:'Bạn không có quyền sửa.'});
  const {notifyActionError}=await import('../asyncActionFeedback');notifyActionError({code:'42501'},'Chưa sửa được',{operation:'sửa ghi chú'});
  await vi.waitFor(()=>expect(h.error).toHaveBeenCalledTimes(2));
  expect(h.convert).toHaveBeenCalledOnce();expect(h.report).toHaveBeenCalledOnce();expect(deliveredText()).not.toMatch(/private toast sink/);
  expect(h.error.mock.calls[1]?.[1]).toMatchObject({description:expect.stringMatching(/Giữ thông tin đang nhập/)});
  expect(h.error.mock.calls[1]?.[1].id).toBe(h.error.mock.calls[0]?.[1].id);
 });
 it('a converter failure also uses safe fallback instead of raw diagnostics',async()=>{
  h.convert.mockImplementation(()=>{throw new Error('private converter stack');});
  const {notifyActionError}=await import('../asyncActionFeedback');notifyActionError({message:'raw backend'},'Chưa cập nhật được');
  await vi.waitFor(()=>expect(h.error).toHaveBeenCalledOnce());expect(h.report).toHaveBeenCalledOnce();expect(deliveredText()).not.toMatch(/private|raw backend|stack/);
 });
 it('two unavailable sinks settle without an unhandled rejection or repeat loop',async()=>{
  h.error.mockImplementation(()=>{throw new Error('sink unavailable');});h.convert.mockReturnValue({title:'Chưa lưu',description:'Giữ bản nháp.'});
  const {notifyActionError}=await import('../asyncActionFeedback');notifyActionError(new Error('original'),'Chưa lưu được');
  await vi.waitFor(()=>expect(h.report).toHaveBeenCalledTimes(2));expect(h.error).toHaveBeenCalledTimes(2);expect(h.convert).toHaveBeenCalledOnce();
 });
 it('the real converter keeps a financial transport failure uncertain',async()=>{
  vi.doMock('../friendlyError',async()=>await vi.importActual<typeof import('../friendlyError')>('../friendlyError'));
  const {notifyActionError}=await import('../asyncActionFeedback');notifyActionError(new TypeError('Failed to fetch'),'Chưa lập phiếu',{operation:'lập phiếu',financial:true});
  await vi.waitFor(()=>expect(h.error).toHaveBeenCalledOnce());expect(deliveredText()).toMatch(/Chưa xác nhận được kết quả lập phiếu/);expect(deliveredText()).toMatch(/Không gửi thêm giao dịch/);expect(deliveredText()).not.toMatch(/Failed to fetch/);expect(h.report).not.toHaveBeenCalled();
 });
});
