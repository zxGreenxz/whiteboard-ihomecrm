import { describe, expect, it, vi } from 'vitest';
import { readPostingCashbooks } from '../postingCashbooks';

describe('posting cashbooks authority and RLS metadata', () => {
  const book = (id: string, patch = {}) => ({ id, name: id, organization_id: 'org', is_virtual: false, deleted_at: null, ...patch });
  it('intersects real custody IDs with same-org, undeleted, nonvirtual RLS metadata', async () => {
    const result = await readPostingCashbooks('org', async () => ['valid', 'virtual', 'other', 'deleted', 'hidden'].map(id => ({ id, name: id })),
      async () => [book('valid'), book('virtual', { is_virtual: true }), book('other', { organization_id: 'other' }), book('deleted', { deleted_at: '2026-09-21' })]);
    expect(result).toEqual([{ id: 'valid', name: 'valid', organizationId: 'org' }]);
  });
  it('distinguishes no custody from read error and malformed data', async () => {
    const meta = vi.fn(async () => []);
    expect(await readPostingCashbooks('org', async () => [], meta)).toEqual([]); expect(meta).not.toHaveBeenCalled();
    await expect(readPostingCashbooks('org', async () => { throw new Error('network'); }, meta)).rejects.toThrow();
    await expect(readPostingCashbooks('org', async () => null, meta)).rejects.toThrow();
    await expect(readPostingCashbooks('org', async () => [{ id: 'x', name: 'X' }], async () => [book('x', { is_virtual: null })])).rejects.toThrow();
  });
  it('reads all IDs in bounded chunks and rejects unsolicited metadata', async () => {
    const ids = Array.from({ length: 1105 }, (_, i) => `id${i}`);
    const meta = vi.fn(async (requested: string[]) => requested.map(id => book(id)));
    expect(await readPostingCashbooks('org', async () => ids.map(id => ({ id, name: id })), meta)).toHaveLength(ids.length);
    expect(meta).toHaveBeenCalledTimes(12);
    await expect(readPostingCashbooks('org', async () => [{ id: 'x', name: 'X' }], async () => [book('z')])).rejects.toThrow();
  });
});
