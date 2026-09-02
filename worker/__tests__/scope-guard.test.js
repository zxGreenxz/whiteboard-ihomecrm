// Guard phạm vi job Zalo (PZALO-C01 ×4, re-anchor 02/09/2026): forge job phải bị
// từ chối TRƯỚC khi chạm provider. Giả lập DB bằng bảng nhỏ, không gọi Supabase.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/ctx.js', () => ({ sb: null, log: () => {}, sessions: new Map(), orgOf: () => 'org-A' }));

import { validateZaloCommandScope, clampHistoryCount, formatScopeRejection } from '../lib/scope-guard.js';

const ACC_A = 'acc-A', ACC_B = 'acc-B';
const bang = {
  zalo_accounts: [
    { id: ACC_A, organization_id: 'org-A' },
    { id: ACC_B, organization_id: 'org-B' },
  ],
  zalo_conversations: [
    { id: 'conv-1', account_id: ACC_A, organization_id: 'org-A', thread_id: 'th-1', thread_type: 'user' },
    { id: 'conv-g', account_id: ACC_A, organization_id: 'org-A', thread_id: 'th-g', thread_type: 'group' },
    { id: 'conv-B', account_id: ACC_B, organization_id: 'org-B', thread_id: 'th-B', thread_type: 'user' },
  ],
  zalo_messages: [
    { id: 'm-out', account_id: ACC_A, conversation_id: 'conv-1', zalo_msg_id: '111', direction: 'out', sent_by: 'user-1' },
    { id: 'm-in', account_id: ACC_A, conversation_id: 'conv-1', zalo_msg_id: '222', direction: 'in', sent_by: null },
    { id: 'm-other', account_id: ACC_A, conversation_id: 'conv-g', zalo_msg_id: '333', direction: 'out', sent_by: 'user-2' },
  ],
};

/** Query builder giả: select().eq()...maybeSingle() lọc bằng AND trên các eq. */
function db() {
  return {
    from(table) {
      const loc = [];
      const q = {
        select: () => q,
        eq: (c, v) => { loc.push([c, v]); return q; },
        maybeSingle: () => {
          const rows = (bang[table] || []).filter((r) => loc.every(([c, v]) => String(r[c]) === String(v)));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
      };
      return q;
    },
  };
}

const jobA = (extra = {}) => ({ id: 'j1', account_id: ACC_A, organization_id: 'org-A', user_id: 'user-1', ...extra });

describe('validateZaloCommandScope', () => {
  it('cho qua job hợp lệ: conversation của account, thread_id khớp', async () => {
    const r = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { body: 'hi', thread_id: 'th-1' } }), db());
    expect(r.ok).toBe(true);
    expect(r.conv.id).toBe('conv-1');
  });

  it('từ chối payload.thread_id lệch conversation (forge gửi sang thread khác)', async () => {
    const r = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { body: 'x', thread_id: 'th-B' } }), db());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/thread_id lệch/);
    expect(formatScopeRejection(r)).toMatch(/^REJECTED_SCOPE:/);
  });

  it('từ chối job mượn account của org khác', async () => {
    const r = await validateZaloCommandScope({ id: 'j2', account_id: ACC_B, organization_id: 'org-A', payload: { body: 'x' } }, db());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/khác org/);
  });

  it('từ chối conversation thuộc account khác dù cùng job.account_id', async () => {
    const r = await validateZaloCommandScope(jobA({ conversation_id: 'conv-B', payload: {} }), db());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/account khác/);
  });

  it('không có conversation_id: thread_id phải thuộc một hội thoại của chính account', async () => {
    const ok = await validateZaloCommandScope(jobA({ payload: { action: 'typing', thread_id: 'th-1' } }), db());
    expect(ok.ok).toBe(true);
    const forge = await validateZaloCommandScope(jobA({ payload: { action: 'typing', thread_id: 'th-B' } }), db());
    expect(forge.ok).toBe(false);
  });

  it('load_history chỉ cho nhóm đã biết; count kẹp 1..200', async () => {
    const user = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { action: 'load_history', thread_id: 'th-1' } }), db());
    expect(user.ok).toBe(false);
    const group = await validateZaloCommandScope(jobA({ conversation_id: 'conv-g', payload: { action: 'load_history', thread_id: 'th-g', count: 99999 } }), db());
    expect(group.ok).toBe(true);
    expect(clampHistoryCount(99999)).toBe(200);
    expect(clampHistoryCount(0)).toBe(50);
    expect(clampHistoryCount('abc')).toBe(50);
  });

  it('react/recall: target_msg_id phải thuộc hội thoại; recall chỉ tin OUT của chính mình', async () => {
    const reactOk = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { action: 'react', thread_id: 'th-1', target_msg_id: '222', emoji: '👍' } }), db());
    expect(reactOk.ok).toBe(true);
    const reactForeign = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { action: 'react', thread_id: 'th-1', target_msg_id: '333' } }), db());
    expect(reactForeign.ok).toBe(false);
    const recallOwn = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { action: 'recall', thread_id: 'th-1', target_msg_id: '111' } }), db());
    expect(recallOwn.ok).toBe(true);
    const recallInbound = await validateZaloCommandScope(jobA({ conversation_id: 'conv-1', payload: { action: 'recall', thread_id: 'th-1', target_msg_id: '222' } }), db());
    expect(recallInbound.ok).toBe(false);
    const recallOthers = await validateZaloCommandScope(jobA({ conversation_id: 'conv-g', payload: { action: 'recall', thread_id: 'th-g', target_msg_id: '333' } }), db());
    expect(recallOthers.ok).toBe(false);
    expect(recallOthers.reason).toMatch(/chính mình/);
  });

  it('job không đụng thread (find_user, sticker_list) chỉ cần account hợp lệ', async () => {
    const r = await validateZaloCommandScope(jobA({ payload: { action: 'find_user', phone: '0900' } }), db());
    expect(r.ok).toBe(true);
    expect(r.conv).toBeNull();
  });
});
