// Map dòng zalo_* → shape giao diện cho tin thẻ và nhịp tim worker (10/2026). Đo production
// 09/10/2026: 484 tin chỉ có chữ "sendBubbleMessage", và worker dừng 05/09 mà web vẫn báo xanh.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ organization: null }) }));

import { mapConv, mapGroupMembers, mapMsg, mapWorkerStatus } from '@/hooks/useZaloChat';
import { CONV_FIELDS, PROFILE_FIELDS } from '@/lib/zaloConversationList';
import { CHU_TIN_THE_CU } from '@/lib/zaloContent';

const dong = (over: Record<string, unknown>) => ({
  id: 'm1', msg_type: 'text', body: 'xin chào', direction: 'in', media_label: null, media_url: null,
  media_tone: null, media_meta: null, created_at: '2026-10-10T01:00:00Z', status: 'delivered',
  reaction_emoji: null, reply_to: null, cli_msg_id: null, ...over,
});

describe('mapMsg — tin dạng thẻ', () => {
  it('keeps the sender name projected from new provider messages', () => {
    expect(mapMsg(dong({ sender_name: '  An  ' })).senderName).toBe('An');
  });
  it('giữ UID người gửi từ JSON projection, không cần tải toàn bộ zalo_raw', () => {
    expect(mapMsg(dong({ sender_uid: 'member-42' })).senderId).toBe('member-42');
    expect(mapMsg(dong({ sender_uid: null })).senderId).toBeUndefined();
  });
  it('tin thẻ cũ chỉ có tên hàm Zalo thì hiện câu đọc được, không có thẻ', () => {
    const m = mapMsg(dong({ body: 'sendBubbleMessage' }));
    expect(m.text).toBe(CHU_TIN_THE_CU);
    expect(m.card).toBeNull();
  });

  it('tin thẻ mới mang card từ media_meta', () => {
    const m = mapMsg(dong({
      body: 'Phòng Q7',
      media_meta: { card: { kind: 'link', title: 'Phòng Q7', description: 'Còn 2 phòng', href: 'https://a.vn/p', thumb: null } },
    }));
    expect(m.text).toBe('Phòng Q7');
    expect(m.card).toEqual({ kind: 'link', title: 'Phòng Q7', description: 'Còn 2 phòng', href: 'https://a.vn/p', thumb: null });
  });

  it('tin media không đọc card và giữ nhãn như cũ', () => {
    const m = mapMsg(dong({ msg_type: 'image', body: '[Hình ảnh]', media_url: 'https://photo-stal-1.zdn.vn/a.jpg', media_meta: { card: { kind: 'link' } } }));
    expect(m.type).toBe('image');
    expect(m.card).toBeNull();
    expect(m.text).toBe('[Hình ảnh]');
  });
});

describe('group member projection', () => {
  it('does not load member maps with the conversation list and preserves small profile fields', () => {
    expect(CONV_FIELDS).not.toContain('profile');
    expect(PROFILE_FIELDS).not.toContain('memberProfiles');
    expect(mapConv({ id: 'c', peer_name: 'Nhóm', thread_type: 'group', profile_kind: 'broker', profile_members: 30, profile_tags: [{ l: 'T', t: 'info' }], profile_room: 'P1' }).profile)
      .toEqual({ kind: 'broker', members: 30, tags: [{ l: 'T', t: 'info' }], room: 'P1' });
  });
  it('validates member maps and refuses unsafe avatars', () => {
    expect(mapGroupMembers({ '42': { name: ' An ', avatarUrl: 'https://example.test/an.jpg' }, '43': { name: 'Bình', avatarUrl: 'javascript:bad' }, bad: 'broken' }))
      .toEqual({ '42': { name: 'An', avatarUrl: 'https://example.test/an.jpg' }, '43': { name: 'Bình', avatarUrl: undefined } });
  });
});

describe('mapWorkerStatus', () => {
  it('đọc kết quả RPC zalo_worker_status_v1', () => {
    expect(mapWorkerStatus({ online: true, heartbeat_at: '2026-10-10T01:00:00+00:00', seconds_since: 3 }))
      .toEqual({ online: true, heartbeatAt: '2026-10-10T01:00:00+00:00', secondsSince: 3 });
  });

  it('dữ liệu lạ thì coi như offline, không ném', () => {
    expect(mapWorkerStatus(null)).toEqual({ online: false, heartbeatAt: null, secondsSince: null });
    expect(mapWorkerStatus({ online: 'true' }).online).toBe(false);
  });
});
