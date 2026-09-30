// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { uploadProofBatch } from '@/lib/luckyProofUpload';
describe('proof upload result', () => {
  it('keeps successful file identity and failed File when the second upload fails', async () => {
    const files = [new File(['a'], 'a.png'), new File(['b'], 'b.png')];
    const upload = vi.fn().mockResolvedValueOnce({ path: 'stable-a', name: 'a.png' }).mockRejectedValueOnce(new Error('SQL secret'));
    const result = await uploadProofBatch('event', files, 0, upload);
    expect(result.uploaded[0].proof.path).toBe('stable-a');
    expect(result.failed[0].file).toBe(files[1]);
    expect(result.failed[0].message).toContain('b.png');
    expect(result.failed[0].message).not.toContain('SQL');
  });
  it('reports extra files instead of silently dropping them', async () => {
    const upload = vi.fn();
    const result = await uploadProofBatch('event', [new File(['a'], 'a.png')], 10, upload);
    expect(result.failed).toHaveLength(1);
    expect(upload).not.toHaveBeenCalled();
  });
});
