// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobWithRelations } from '@/types/jobs';
import TaskEditDialog from '../TaskEditDialog';

const mocks = vi.hoisted(() => ({
  save: vi.fn(), upload: vi.fn(), deleteFile: vi.fn(), mobile: false,
}));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: [] }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: () => ({ data: [] }) }));
vi.mock('@/hooks/useJobTypes', () => ({ useJobTypes: () => ({ data: [] }) }));
vi.mock('@/hooks/useJobs', () => ({
  useProfiles: () => ({ data: [] }),
  useUpdateJob: () => ({ mutateAsync: mocks.save, isPending: false }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: { id: 'user-1' } }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/lib/storage', () => ({ uploadFile: mocks.upload, deleteFile: mocks.deleteFile }));
vi.mock('@/components/ui/storage-image', () => ({
  StorageImage: ({ value, alt }: { value: string; alt: string }) => <img src={value} alt={alt} />,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const OLD_IMAGE = 'https://storage.test/job-attachments/old.png';
const NEW_IMAGE = 'https://storage.test/job-attachments/new.png';
const job: JobWithRelations = {
  id: 'job-1', code: 'JOB-001', title: 'Sửa cửa vân tay', description: 'Cửa bị gãy',
  building_id: null, room_id: null, job_type_id: null, priority: 'NORMAL',
  assignee_id: null, assignee_name: null, deadline: null, status: 'IN_PROGRESS',
  attachments: null, completion_time: null, completion_description: null,
  created_at: '2026-09-28T08:54:00Z', buildings: null, rooms: null,
  job_types: null, profiles: null,
};

function selectImage() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, 'Màn sửa phải có chỗ chọn ảnh').not.toBeNull();
  fireEvent.change(input!, { target: { files: [new File(['image'], 'door.png', { type: 'image/png' })] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.save.mockResolvedValue({});
  mocks.upload.mockResolvedValue(NEW_IMAGE);
});
afterEach(cleanup);

describe('bổ sung ảnh khi sửa công việc', () => {
  it.each([false, true])('thêm ảnh vào phiếu chưa có ảnh (mobile=%s)', async mobile => {
    mocks.mobile = mobile;
    const close = vi.fn();
    const success = vi.fn();
    render(<TaskEditDialog open job={job} onOpenChange={close} onSuccess={success} />);
    selectImage();
    await screen.findByRole('img', { name: 'Đính kèm' });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(mocks.upload).toHaveBeenCalledWith('job-attachments', expect.stringMatching(/^user-1\//), expect.any(File));
    expect(mocks.save).toHaveBeenCalledWith({ id: job.id, patch: expect.objectContaining({ attachments: [NEW_IMAGE], title: job.title }) });
    expect(close).toHaveBeenCalledWith(false);
  });

  it('giữ ảnh cũ khi thêm ảnh mới', async () => {
    render(<TaskEditDialog open job={{ ...job, attachments: [OLD_IMAGE] }} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Đính kèm' }).getAttribute('src')).toBe(OLD_IMAGE);
    selectImage();
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Đính kèm' })).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: job.id, patch: expect.objectContaining({ attachments: [OLD_IMAGE, NEW_IMAGE] }) }));
  });

  it('không ghi đè danh sách ảnh khi chỉ sửa tiêu đề', async () => {
    render(<TaskEditDialog open job={{ ...job, attachments: [OLD_IMAGE] }} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue(job.title), { target: { value: 'Sửa cửa mới' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[0][0].patch).not.toHaveProperty('attachments');
    expect(mocks.save.mock.calls[0][0].patch).not.toHaveProperty('completion_attachments');
  });

  it('gỡ ảnh vừa tải rồi lưu không thể lưu URL đang bị xóa khỏi kho', async () => {
    mocks.deleteFile.mockReturnValue(new Promise(() => {}));
    render(<TaskEditDialog open job={{ ...job, attachments: [OLD_IMAGE] }} onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    mocks.upload.mockResolvedValue('https://storage.test/storage/v1/object/public/job-attachments/user-1/new.png');
    selectImage();
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Đính kèm' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Gỡ tệp đính kèm' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][0].patch).not.toHaveProperty('attachments');
  });

  it('khóa lưu và đóng khi ảnh đang tải, mở lại khi tải xong', async () => {
    let finish!: (url: string) => void;
    mocks.upload.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    const close = vi.fn();
    render(<TaskEditDialog open job={job} onOpenChange={close} onSuccess={vi.fn()} />);
    selectImage();
    expect((screen.getByRole('button', { name: /Đang tải ảnh/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => finish(NEW_IMAGE));
    expect((screen.getByRole('button', { name: 'Lưu' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('huỷ việc gỡ ảnh không xóa ảnh đã lưu và mở lại vẫn thấy ảnh', async () => {
    const savedJob = { ...job, attachments: [OLD_IMAGE] };
    const close = vi.fn();
    const props = { job: savedJob, onOpenChange: close, onSuccess: vi.fn() };
    const view = render(<TaskEditDialog open {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Gỡ tệp đính kèm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Huỷ' }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    view.rerender(<TaskEditDialog open={false} {...props} />);
    view.rerender(<TaskEditDialog open {...props} />);
    expect(screen.getByRole('img', { name: 'Đính kèm' }).getAttribute('src')).toBe(OLD_IMAGE);
  });

  it('lưu thất bại vẫn giữ ảnh vừa tải để thử lại', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Không thể lưu')).mockResolvedValueOnce({});
    const close = vi.fn();
    render(<TaskEditDialog open job={job} onOpenChange={close} onSuccess={vi.fn()} />);
    selectImage();
    await screen.findByRole('img', { name: 'Đính kèm' });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Đính kèm' }).getAttribute('src')).toBe(NEW_IMAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith(false));
    expect(mocks.upload).toHaveBeenCalledOnce();
  });
});
