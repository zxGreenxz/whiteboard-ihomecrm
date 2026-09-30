// @vitest-environment jsdom
import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({rpc:vi.fn(),invalidate:vi.fn(),upload:vi.fn(),remove:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:h.invalidate})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc}}));
vi.mock('@/lib/storage',()=>({uploadFile:h.upload,deleteFile:h.remove,sanitizeStorageFileName:(name:string)=>name}));
vi.mock('@/components/income-expenses/AttachmentUpload',()=>({validateAttachmentFile:()=>null}));
import { useAttachPostingEvidence, useRemovePostingAttachment } from '../financeV2Mutations';
import { VoucherPartialError } from '@/lib/voucherFeedback';
beforeEach(()=>{vi.clearAllMocks();h.upload.mockResolvedValue('https://files.example/receipt.png');});
afterEach(cleanup);
it('đã đính ảnh nhưng kiểm chứng từ lỗi giữ file và báo bước đã lưu',async()=>{
  const denied={code:'42501',message:'permission denied'};
  h.rpc.mockResolvedValueOnce({data:{changed:true},error:null}).mockResolvedValueOnce({data:null,error:denied});
  const {result}=renderHook(()=>useAttachPostingEvidence());
  let caught:unknown;
  try {await result.current(new File(['x'],'receipt.png'),{voucherId:'v1',userId:'u1'});}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(VoucherPartialError);
  expect(caught).toMatchObject({completedIds:['v1'],cause:denied,message:expect.stringContaining('Ảnh đã đính vào phiếu')});
  expect(h.remove).not.toHaveBeenCalled(); expect(h.invalidate).toHaveBeenCalled();
});
it('đã gỡ ảnh nhưng kiểm chứng từ lỗi báo đã gỡ và làm mới phiếu',async()=>{
  h.rpc.mockResolvedValueOnce({data:{changed:true},error:null}).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const {result}=renderHook(()=>useRemovePostingAttachment());
  await expect(result.current('v1','https://files.example/receipt.png')).rejects.toMatchObject({completedIds:['v1'],message:expect.stringContaining('Ảnh đã gỡ khỏi phiếu')});
  expect(h.invalidate).toHaveBeenCalled();
});
