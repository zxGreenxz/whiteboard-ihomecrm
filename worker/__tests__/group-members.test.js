import { describe, expect, it, vi } from 'vitest';
import { createGroupMemberSync } from '../lib/group-members.js';

function fixture() {
  const state = { profile: { kind: 'broker', tags: [{ l: 'giữ lại' }] }, writes: [], filters: [], messages: [{ sender_uid: '11' }, { sender_uid: '22' }] };
  const db = { from(table) {
    const filters = []; let patch;
    const q = { select: () => q, eq: (k, v) => { filters.push([k, v]); return q; }, is: (k, v) => { filters.push([k, v]); return q; }, order: () => q, limit: () => q,
      update: value => { patch = value; return q; },
      maybeSingle: async () => ({ data: { profile: state.profile }, error: null }),
      then: resolve => {
        state.filters.push({ table, filters });
        if (patch) { state.writes.push(patch); state.profile = patch.profile; }
        return Promise.resolve({ data: table === 'zalo_messages' ? state.messages : [{ id: 'c' }], error: null }).then(resolve);
      } };
    return q;
  } };
  const api = { getGroupMembersInfo: vi.fn(async ids => ({ profiles: Object.fromEntries(ids.map(id => [id, { id, displayName: `Tên ${id}`, avatar: `https://example.test/${id}.jpg` }])) })) };
  return { state, db, api, sync: createGroupMemberSync({ db }), args: { accountId: 'a', orgId: 'o', conversationId: 'c' } };
}

describe('group sender profiles', () => {
  it('resolves historical non-friends and preserves other profile fields', async () => {
    const f = fixture();
    await f.sync({ ...f.args, api: f.api, includeHistory: true });
    expect(f.api.getGroupMembersInfo).toHaveBeenCalledWith(['11', '22']);
    expect(f.state.profile).toMatchObject({ kind: 'broker', tags: [{ l: 'giữ lại' }], memberProfiles: { '11': { name: 'Tên 11', avatarUrl: 'https://example.test/11.jpg' }, '22': { name: 'Tên 22' } } });
    for (const query of f.state.filters) expect(query.filters).toEqual(expect.arrayContaining([['account_id', 'a'], ['organization_id', 'o']]));
    expect(f.state.filters.find(query => query.table === 'zalo_messages').filters).toContainEqual(['hidden_at', null]);
  });
  it('scopes the in-memory cache by account and skips repeat live senders', async () => {
    const f = fixture();
    await f.sync({ ...f.args, api: f.api, senderIds: ['11'] });
    await f.sync({ ...f.args, api: f.api, senderIds: ['11'] });
    expect(f.api.getGroupMembersInfo).toHaveBeenCalledTimes(1);
    await f.sync({ ...f.args, accountId: 'b', api: f.api, senderIds: ['33'] });
    expect(f.api.getGroupMembersInfo).toHaveBeenCalledTimes(2);
  });
  it('rejects mismatched provider IDs and unsafe image URLs', async () => {
    const f = fixture();
    f.api.getGroupMembersInfo.mockResolvedValue({ profiles: { '11_0': { id: '11', displayName: 'An', avatar: 'javascript:bad' }, '22': { id: '99', displayName: 'Sai người' } } });
    await f.sync({ ...f.args, api: f.api, includeHistory: true });
    expect(f.state.profile.memberProfiles['11']).toMatchObject({ name: 'An' });
    expect(f.state.profile.memberProfiles['11'].avatarUrl).toBeUndefined();
    expect(f.state.profile.memberProfiles['22']).toBeUndefined();
  });
  it('retains existing profiles when the provider fails, and surfaces the error', async () => {
    const f = fixture();
    f.state.profile.memberProfiles = { '11': { name: 'Đã lưu', avatarUrl: 'https://example.test/old.jpg' } };
    f.api.getGroupMembersInfo.mockRejectedValue(new Error('provider unavailable'));
    await expect(f.sync({ ...f.args, api: f.api, includeHistory: true })).rejects.toThrow('provider unavailable');
    expect(f.state.writes).toHaveLength(0);
    expect(f.state.profile.memberProfiles['11'].name).toBe('Đã lưu');
  });
  it('chunks requests and serializes concurrent writes without losing members', async () => {
    const f = fixture();
    const ids = Array.from({ length: 61 }, (_, i) => String(100 + i));
    await Promise.all([f.sync({ ...f.args, api: f.api, senderIds: ids }), f.sync({ ...f.args, api: f.api, senderIds: ['999'] })]);
    expect(f.api.getGroupMembersInfo.mock.calls.every(([batch]) => batch.length <= 50)).toBe(true);
    expect(Object.keys(f.state.profile.memberProfiles)).toHaveLength(62);
  });
  it('shares the write lock between live API and the history proxy', async () => {
    const f = fixture();
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const original = f.api.getGroupMembersInfo.getMockImplementation();
    f.api.getGroupMembersInfo.mockImplementation(async ids => { if (ids.includes('11')) await waiting; return original(ids); });
    const proxy = new Proxy(f.api, {});
    const live = f.sync({ ...f.args, api: f.api, senderIds: ['11'] });
    const history = f.sync({ ...f.args, api: proxy, senderIds: ['22'] });
    await vi.waitFor(() => expect(f.api.getGroupMembersInfo).toHaveBeenCalled());
    release();
    await Promise.all([live, history]);
    expect(Object.keys(f.state.profile.memberProfiles).sort()).toEqual(['11', '22']);
  });
  it('does not query or write without an organization boundary', async () => {
    const f = fixture();
    await expect(f.sync({ ...f.args, orgId: null, api: f.api, senderIds: ['11'] })).rejects.toThrow('scope');
    expect(f.state.filters).toHaveLength(0);
    expect(f.api.getGroupMembersInfo).not.toHaveBeenCalled();
  });
});
