import { describe, expect, it, vi } from 'vitest';
import { forwardZaloMedia, type ForwardMediaInput, type ForwardMediaRpc } from '../zaloForwardMedia';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input: ForwardMediaInput = { sourceMessageIds: [id(1), id(2)], conversationIds: [id(3), id(4)], requestId: id(5) };
const queued = (conversation: number, start: number) => ({ conversation_id: id(conversation), status: 'queued' as const, message_ids: [id(start), id(start + 1)], job_id: id(start + 2), reused: false });
const response = () => ({ recipients: [queued(3, 10), queued(4, 20)] });

describe('chuyển tiếp media qua nguồn đã lưu', () => {
  it('gửi ID nguồn theo thứ tự album và mã yêu cầu, không gửi URL hay định dạng từ trình duyệt', async () => {
    const rpc = vi.fn<ForwardMediaRpc>().mockResolvedValue({ data: response(), error: null });
    await expect(forwardZaloMedia(rpc, input)).resolves.toEqual(response());
    expect(rpc).toHaveBeenCalledExactlyOnceWith('zalo_forward_media_v1', {
      p_source_message_ids: input.sourceMessageIds, p_conversation_ids: input.conversationIds, p_client_request_id: input.requestId,
    });
  });
  it('giữ riêng kết quả tiếp nhận và từ chối từng hội thoại', async () => {
    const data = { recipients: [queued(3, 10), { conversation_id: id(4), status: 'rejected', error: 'Tài khoản chưa kết nối.' }] };
    const rpc = vi.fn<ForwardMediaRpc>().mockResolvedValue({ data, error: null });
    await expect(forwardZaloMedia(rpc, input)).resolves.toEqual(data);
  });
  it('album có chú thích giữ thêm biên nhận tin chú thích do Zalo tạo', async () => {
    const data = response();
    const first = { ...queued(3, 10), message_ids: [id(10), id(11), id(13)], caption_message_id: id(13) };
    const result = { recipients: [first, data.recipients[1]] };
    const rpc = vi.fn<ForwardMediaRpc>().mockResolvedValue({ data: result, error: null });
    await expect(forwardZaloMedia(rpc, input)).resolves.toEqual(result);
  });
  it.each([
    { recipients: [] },
    { recipients: [queued(3, 10)] },
    { recipients: [queued(3, 10), queued(3, 20)] },
    { recipients: [queued(3, 10), queued(99, 20)] },
    { recipients: [queued(3, 10), { ...queued(4, 20), message_ids: [id(20)] }] },
    { recipients: [queued(3, 10), { ...queued(4, 20), message_ids: [id(10), id(21)] }] },
    { recipients: [queued(3, 10), { ...queued(4, 20), job_id: id(12) }] },
    { recipients: [{ ...queued(3, 10), message_ids: [id(10), id(11), id(13)], caption_message_id: id(99) }, queued(4, 20)] },
    { recipients: [queued(3, 10), { ...queued(4, 20), status: 'sent' }] },
    null,
  ])('không nhận thành công khi biên nhận thiếu/sai/trùng: %j', async data => {
    const rpc = vi.fn<ForwardMediaRpc>().mockResolvedValue({ data, error: null });
    await expect(forwardZaloMedia(rpc, input)).rejects.toThrow(/Chưa xác nhận/);
  });
  it.each([
    { ...input, sourceMessageIds: [] },
    { ...input, sourceMessageIds: [id(1), id(1)] },
    { ...input, conversationIds: [id(3), id(3)] },
    { ...input, conversationIds: Array.from({ length: 101 }, (_, i) => id(i + 100)) },
    { ...input, requestId: '' },
  ])('chặn đầu vào sai trước khi gọi máy chủ', async value => {
    const rpc = vi.fn<ForwardMediaRpc>();
    await expect(forwardZaloMedia(rpc, value)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('mất phản hồi không tự gửi thêm, lần kiểm tra lại giữ nguyên mã yêu cầu', async () => {
    const rpc = vi.fn<ForwardMediaRpc>().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ data: response(), error: null });
    await expect(forwardZaloMedia(rpc, input)).rejects.toThrow('network');
    expect(rpc).toHaveBeenCalledTimes(1);
    await forwardZaloMedia(rpc, input);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
});
