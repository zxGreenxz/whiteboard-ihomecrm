import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('../storage', () => ({ uploadFile: m.upload }));
import { saveCompanyLogo } from '../companyLogo';
const file = { name: 'logo.png', type: 'image/png', size: 100 } as File;
describe('lưu logo bền vững', () => {
  it('chỉ lưu URL tải thành công, không lưu blob preview', async () => {
    m.upload.mockResolvedValue('https://storage.example/logo.png');
    const persist = vi.fn(async () => undefined);
    const result = await saveCompanyLogo(file, 'user-a', persist);
    expect(persist).toHaveBeenCalledWith('https://storage.example/logo.png');
    expect(result).toMatchObject({ status: 'saved', url: 'https://storage.example/logo.png' });
  });
  it('giữ URL đã tải khi cập nhật cài đặt chưa được xác nhận', async () => {
    m.upload.mockResolvedValue('https://storage.example/logo.png');
    const result = await saveCompanyLogo(file, 'user-a', async () => { throw new Error('timeout'); });
    expect(result).toMatchObject({ status: 'uploaded', url: 'https://storage.example/logo.png' });
  });
});
