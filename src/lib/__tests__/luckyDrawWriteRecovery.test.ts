// @vitest-environment jsdom
// Đợt 9 (plan sửa khoá vĩnh viễn sau rớt mạng): Quay số. Ba kịch bản cho mỗi loại thao tác — lệnh không tới máy chủ, tới
// nhưng mất phản hồi, dấu bản trước gieo sẵn — trên máy chủ giả mô phỏng đúng thân hàm production (khoá sự kiện rồi mới xét
// «đã quay»). Máy chủ giả đếm số lần bốc thăm THẬT: không kịch bản nào được làm một lượt bị quay hai lần.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedLegacyPending, pendingKeys } from '@/hooks/__tests__/fakeRecordServer';
import { luckyWorld, TEN_MINUTES_AGO, type LuckyWorld } from './helpers/luckyFakeServer';

const h = vi.hoisted(() => ({ world: null as unknown as LuckyWorld }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { get rpc() { return h.world.server.rpc; } } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-1' }) }));

type Api = typeof import('@/lib/luckyDrawApi');
const load = async (): Promise<Api> => { vi.resetModules(); return import('@/lib/luckyDrawApi'); };
const legacyAdmin = (businessKey: string) => ({ namespace: 'lucky-admin', userId: 'actor-1', organizationId: 'actor-scope', businessKey });
const legacyPublic = (businessKey: string) => ({ namespace: 'lucky-public-draw', userId: 'public-viewer', organizationId: 'public-event', businessKey });
const caught = async (work: Promise<unknown>) => { try { await work; } catch (error) { return error as Record<string, unknown>; } throw new Error('expected rejection'); };
const writes = (world: LuckyWorld) => world.server.rpcCalls.filter(call => !['lucky_admin_get_v1', 'lucky_public_state_v1'].includes(call.name)).length;

let world: LuckyWorld;
beforeEach(() => {
  localStorage.clear();
  world = luckyWorld();
  h.world = world;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { body?: unknown }) => world.publicFetch(url, init)));
});

function publicEvent() {
  const event = world.addEvent({ drawAt: new Date(Date.now() - 60_000).toISOString() });
  world.addTeam(event); world.addTeam(event);
  return event;
}
function roundsEvent() {
  const event = world.addEvent();
  world.addTeam(event); world.addTeam(event);
  world.addRounds(event, { amount: 100, winnersCount: 1 }, { amount: 200, winnersCount: 1 });
  return event;
}

describe('quay công khai (lucky-public-draw): người xem ẩn danh không bao giờ bị khoá', () => {
  it('lệnh quay không tới máy chủ: tải lại trang thì quay đúng một lần, không còn dấu', async () => {
    const event = publicEvent();
    world.server.failNext('lucky_draw_v1', 'rpc', 'drop-before');
    let api = await load();
    expect(await caught(api.luckyDraw(event.id))).toMatchObject({ outcome: 'unknown' });
    expect(world.realDraws).toBe(0);
    api = await load();
    const state = await api.luckyDraw(event.id);
    expect(state).toMatchObject({ ok: true, event: { status: 'drawn', winnerTeamId: event.teams[0]!.id } });
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tới nhưng mất phản hồi: tải lại trang đọc trạng thái, nhận đúng kết quả đã quay, không gửi lệnh quay thứ hai', async () => {
    const event = publicEvent();
    world.server.failNext('lucky_draw_v1', 'rpc', 'drop-after');
    let api = await load();
    await caught(api.luckyDraw(event.id));
    expect(world.realDraws).toBe(1);
    api = await load();
    expect(await api.luckyDraw(event.id)).toMatchObject({ ok: true, event: { status: 'drawn', drawnAt: event.drawnAt } });
    expect(world.calls('lucky_draw_v1')).toBe(1);
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('mất phản hồi và lần đọc lại cũng hỏng: không gửi lệnh quay mới; lần sau đọc được thì nhận kết quả', async () => {
    const event = publicEvent();
    world.server.failNext('lucky_draw_v1', 'rpc', 'drop-after');
    let api = await load();
    await caught(api.luckyDraw(event.id));
    api = await load();
    world.server.failNext('lucky_public_state_v1', 'rpc', 'drop-before');
    await caught(api.luckyDraw(event.id));
    expect(world.calls('lucky_draw_v1')).toBe(1);
    expect(pendingKeys()).toHaveLength(1);
    expect((await api.luckyDraw(event.id)).ok).toBe(true);
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('dấu bản trước gieo sẵn (10 phút, không tên thao tác) không chặn: quay đúng một lần rồi gỡ dấu', async () => {
    const event = publicEvent();
    seedLegacyPending(legacyPublic(event.id), TEN_MINUTES_AGO());
    const api = await load();
    expect(await api.luckyDraw(event.id)).toMatchObject({ ok: true, event: { status: 'drawn' } });
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('lời từ chối rõ (chưa tới giờ) không để lại dấu; tới giờ thì quay được', async () => {
    const event = publicEvent();
    event.drawAt = new Date(Date.now() + 60_000).toISOString();
    const api = await load();
    expect(await api.luckyDraw(event.id)).toMatchObject({ ok: false, reason: 'not_time' });
    expect(pendingKeys()).toEqual([]);
    event.drawAt = new Date(Date.now() - 1000).toISOString();
    expect((await api.luckyDraw(event.id)).ok).toBe(true);
  });
});

describe('quay quản trị: chỉ lệnh quay giữ dấu, mỗi lượt quay đúng một lần', () => {
  it('mở lượt không tới máy chủ: bấm lại (kể cả sau khi tải lại trang) quay đúng một lần', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-before');
    let api = await load();
    expect(await caught(api.luckyAdminApi.drawRound(event.id, 1))).toMatchObject({ outcome: 'unknown' });
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(true);
    api = await load();
    expect(await api.luckyAdminApi.drawRound(event.id, 1)).toMatchObject({ ok: true });
    expect(event.rounds[0]!.status).toBe('drawn');
    expect(world.realDraws).toBe(1);
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(false);
    expect(pendingKeys()).toEqual([]);
  });

  it('mở lượt mất phản hồi: bấm lại đọc trạng thái, nhận kết quả đã quay, không gửi lệnh quay thứ hai', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-after');
    let api = await load();
    await caught(api.luckyAdminApi.drawRound(event.id, 1));
    const winners = event.rounds[0]!.winners.map(w => w.teamId);
    api = await load();
    const state = await api.luckyAdminApi.drawRound(event.id, 1);
    expect(state.rounds?.[0]?.winners.map(w => w.teamId)).toEqual(winners);
    expect(world.calls('lucky_draw_round_v1')).toBe(1);
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('mở lượt 1 mất phản hồi rồi bấm mở lượt 2: không bị chặn, mỗi lượt quay đúng một lần', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-after');
    const api = await load();
    await caught(api.luckyAdminApi.drawRound(event.id, 1));
    expect((await api.luckyAdminApi.drawRound(event.id, 2)).ok).toBe(true);
    expect(event.rounds.map(r => r.status)).toEqual(['drawn', 'drawn']);
    expect(world.realDraws).toBe(2);
    expect(pendingKeys()).toEqual([]);
  });

  it('bấm lại mà đọc trạng thái hỏng: không gửi lệnh quay, dấu giữ để lần sau đối chiếu', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-after');
    const api = await load();
    await caught(api.luckyAdminApi.drawRound(event.id, 1));
    world.server.failNext('lucky_admin_get_v1', 'rpc', 'drop-before');
    await caught(api.luckyAdminApi.drawRound(event.id, 1));
    expect(world.calls('lucky_draw_round_v1')).toBe(1);
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(true);
    expect((await api.luckyAdminApi.drawRound(event.id, 1)).ok).toBe(true);
    expect(world.realDraws).toBe(1);
  });

  it.each(['drop-before', 'drop-after'] as const)('quay cả sự kiện (%s): bấm lại ra đúng một kết quả', async failure => {
    const event = world.addEvent(); world.addTeam(event); world.addTeam(event);
    world.server.failNext('lucky_admin_force_draw_v1', 'rpc', failure);
    let api = await load();
    await caught(api.luckyAdminApi.forceDraw(event.id));
    api = await load();
    expect(await api.luckyAdminApi.forceDraw(event.id)).toMatchObject({ ok: true, event: { status: 'drawn', winnerTeamId: event.teams[0]!.id } });
    expect(world.realDraws).toBe(1);
    expect(world.calls('lucky_admin_force_draw_v1')).toBe(failure === 'drop-after' ? 1 : 2);
    expect(pendingKeys()).toEqual([]);
  });

  it('điểm danh chưa rõ kết quả KHÔNG chặn nút quay', async () => {
    const event = roundsEvent();
    const late = world.addTeam(event, { checkedInAt: null });
    world.server.failNext('lucky_admin_update_team_v1', 'rpc', 'drop-after');
    const api = await load();
    expect(await caught(api.luckyAdminApi.updateTeam(late.id, { checkedIn: true }))).toMatchObject({ outcome: 'unknown', repeatable: true });
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(false);
    expect(pendingKeys()).toEqual([]);
    expect((await api.luckyAdminApi.drawRound(event.id, 1)).ok).toBe(true);
    expect(world.realDraws).toBe(1);
  });

  it('dấu chung lucky-admin bản trước gieo sẵn: không bật cảnh báo, không chặn quay, gỡ sau lần quay thành công', async () => {
    const event = roundsEvent();
    seedLegacyPending(legacyAdmin(event.id), TEN_MINUTES_AGO());
    localStorage.setItem('ihome:lucky-draw-intent:v1:legacy-attempt', JSON.stringify({ eventId: event.id, ordinal: 1 }));
    const api = await load();
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(false);
    expect((await api.luckyAdminApi.drawRound(event.id, 1)).ok).toBe(true);
    expect(world.realDraws).toBe(1);
    expect(pendingKeys()).toEqual([]);
    expect(localStorage.getItem('ihome:lucky-draw-intent:v1:legacy-attempt')).toBeNull();
  });

  it('đối chiếu kết quả quay luôn kết luận được: đã quay, chưa quay, không còn gì; đọc hỏng thì giữ dấu', async () => {
    const event = roundsEvent();
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-before');
    let api = await load();
    await caught(api.luckyAdminApi.drawRound(event.id, 1));
    api = await load();
    world.server.failNext('lucky_admin_get_v1', 'rpc', 'drop-before');
    await caught(api.luckyAdminApi.reconcileDraw(event.id));
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(true);
    expect(await api.luckyAdminApi.reconcileDraw(event.id)).toMatchObject({ outcome: 'not-drawn', ordinal: 1 });
    expect(await api.luckyAdminApi.hasPendingAction(event.id)).toBe(false);
    expect(await api.luckyAdminApi.reconcileDraw(event.id)).toMatchObject({ outcome: 'none' });
    world.server.failNext('lucky_draw_round_v1', 'rpc', 'drop-after');
    await caught(api.luckyAdminApi.drawRound(event.id, 1));
    api = await load();
    expect(await api.luckyAdminApi.reconcileDraw(event.id)).toMatchObject({ outcome: 'drawn', ordinal: 1, state: { ok: true } });
    expect(pendingKeys()).toEqual([]);
    expect(world.realDraws).toBe(1);
    expect(world.calls('lucky_draw_round_v1')).toBe(2);
  });

  it('không nhận biên nhận quay của sự kiện khác', async () => {
    const event = roundsEvent();
    const other = roundsEvent();
    world.server.rpcHandlers.lucky_draw_round_v1 = () => world.server.rpcHandlers.lucky_public_state_v1!({ p_event: other.id });
    const api = await load();
    expect(await caught(api.luckyAdminApi.drawRound(event.id, 1))).toMatchObject({ outcome: 'unknown' });
  });
});

describe('thao tác quản trị lặp lại được: không giữ dấu, bấm lại ra đúng một kết quả', () => {
  type Case = [string, string, (api: Api, ids: { event: string; team: string }) => Promise<unknown>, (ids: { event: string; team: string }) => void];
  const cases: Case[] = [
    ['lưu sự kiện', 'lucky_admin_upsert_event_v1', (api, ids) => api.luckyAdminApi.upsertEvent({ id: ids.event, title: 'Tên mới' }), () => expect(world.events[0]!.title).toBe('Tên mới')],
    ['thể lệ', 'lucky_admin_set_rounds_v1', (api, ids) => api.luckyAdminApi.setRounds(ids.event, [{ amount: 300, winnersCount: 2 }]), () => expect(world.events[0]!.rounds.map(r => [r.amount, r.winnersCount])).toEqual([[300, 2]])],
    ['sửa đội', 'lucky_admin_update_team_v1', (api, ids) => api.luckyAdminApi.updateTeam(ids.team, { name: 'Đội mới', deals: 3 }), () => expect(world.events[0]!.teams[0]).toMatchObject({ name: 'Đội mới', deals: 3 })],
    ['điểm danh', 'lucky_admin_update_team_v1', (api, ids) => api.luckyAdminApi.updateTeam(ids.team, { checkedIn: false }), () => expect(world.events[0]!.teams[0]!.checkedInAt).toBeNull()],
    ['xoá đội', 'lucky_admin_delete_team_v1', (api, ids) => api.luckyAdminApi.deleteTeam(ids.team, ids.event), () => expect(world.events[0]!.teams).toHaveLength(1)],
    ['đặt lại kết quả', 'lucky_admin_reset_draw_v1', (api, ids) => api.luckyAdminApi.resetDraw(ids.event), () => expect(world.events[0]).toMatchObject({ status: 'open', drawnAt: null, winnerTeamId: null })],
  ];
  function seedEvent() {
    const event = world.addEvent(); world.addTeam(event); world.addTeam(event);
    return { event: event.id, team: event.teams[0]!.id };
  }
  async function drawnEvent(ids: { event: string }) {
    const api = await load();
    await api.luckyAdminApi.forceDraw(ids.event);
  }

  it.each(cases)('%s: lệnh không tới máy chủ ⇒ báo chưa rõ, không dấu, bấm lại ghi được', async (name, rpc, run, check) => {
    const ids = seedEvent();
    if (name === 'đặt lại kết quả') await drawnEvent(ids);
    world.server.failNext(rpc, 'rpc', 'drop-before');
    const api = await load();
    expect(await caught(run(api, ids))).toMatchObject({ outcome: 'unknown', repeatable: true });
    expect(pendingKeys()).toEqual([]);
    expect(await run(api, ids)).toMatchObject({ ok: true });
    check(ids);
    expect(pendingKeys()).toEqual([]);
  });

  it.each(cases)('%s: tới nhưng mất phản hồi ⇒ bấm lại ra đúng một kết quả', async (name, rpc, run, check) => {
    const ids = seedEvent();
    if (name === 'đặt lại kết quả') await drawnEvent(ids);
    world.server.failNext(rpc, 'rpc', 'drop-after');
    const api = await load();
    expect(await caught(run(api, ids))).toMatchObject({ outcome: 'unknown', repeatable: true });
    check(ids);
    expect(await run(api, ids)).toMatchObject({ ok: true });
    check(ids);
    expect(pendingKeys()).toEqual([]);
  });

  it.each(cases)('%s: dấu chung bản trước gieo sẵn ⇒ không chặn, gỡ sau lần ghi thành công', async (name, _rpc, run, check) => {
    const ids = seedEvent();
    if (name === 'đặt lại kết quả') await drawnEvent(ids);
    seedLegacyPending(legacyAdmin(ids.event), TEN_MINUTES_AGO());
    const api = await load();
    expect(await run(api, ids)).toMatchObject({ ok: true });
    check(ids);
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm đội: không tới máy chủ ⇒ bấm lại thêm đúng một đội; dấu bản trước được gỡ', async () => {
    const ids = seedEvent();
    seedLegacyPending(legacyAdmin(ids.event), TEN_MINUTES_AGO());
    world.server.failNext('lucky_admin_add_team_v1', 'rpc', 'drop-before');
    const api = await load();
    expect(await caught(api.luckyAdminApi.addTeam({ eventId: ids.event, name: 'Đội C' }))).toMatchObject({ outcome: 'unknown', repeatable: true });
    expect(await api.luckyAdminApi.addTeam({ eventId: ids.event, name: 'Đội C' })).toMatchObject({ ok: true });
    expect(world.events[0]!.teams.filter(t => t.name === 'Đội C')).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('thêm đội: mất phản hồi ⇒ bấm lại không thêm đội thứ hai, báo «có thể đã được thêm» kèm mã điểm danh', async () => {
    const ids = seedEvent();
    world.server.failNext('lucky_admin_add_team_v1', 'rpc', 'drop-after');
    const api = await load();
    await caught(api.luckyAdminApi.addTeam({ eventId: ids.event, name: 'Đội C' }));
    const added = world.events[0]!.teams.find(t => t.name === 'Đội C')!;
    const error = await caught(api.luckyAdminApi.addTeam({ eventId: ids.event, name: 'Đội C' }));
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(String(error.message)).toContain('có thể đã được thêm');
    expect(String(error.message)).toContain(added.code);
    expect(world.events[0]!.teams.filter(t => t.name === 'Đội C')).toHaveLength(1);
    expect(world.calls('lucky_admin_add_team_v1')).toBe(1);
  });

  it('tạo sự kiện: không tới máy chủ ⇒ bấm lại tạo đúng một sự kiện; dấu bản trước «new-event» được gỡ', async () => {
    seedLegacyPending(legacyAdmin('new-event'), TEN_MINUTES_AGO());
    world.server.failNext('lucky_admin_upsert_event_v1', 'rpc', 'drop-before');
    const api = await load();
    expect(await caught(api.luckyAdminApi.upsertEvent({ title: 'IHOME · Trao thưởng' }))).toMatchObject({ outcome: 'unknown', repeatable: true });
    const created = await api.luckyAdminApi.upsertEvent({ title: 'IHOME · Trao thưởng' });
    expect(created).toMatchObject({ ok: true, eventId: world.events[0]!.id });
    expect(world.events).toHaveLength(1);
    expect(pendingKeys()).toEqual([]);
  });

  it('tạo sự kiện: mất phản hồi ⇒ bấm lại không tạo sự kiện thứ hai, báo đã tạo ở lần bấm trước kèm mã', async () => {
    world.server.failNext('lucky_admin_upsert_event_v1', 'rpc', 'drop-after');
    const api = await load();
    await caught(api.luckyAdminApi.upsertEvent({ title: 'IHOME · Trao thưởng' }));
    expect(world.events).toHaveLength(1);
    expect(await api.luckyAdminApi.upsertEvent({ title: 'IHOME · Trao thưởng' })).toMatchObject({ ok: true, eventId: world.events[0]!.id, replayed: true });
    expect(world.events).toHaveLength(1);
    // Lần tạo kế tiếp (sau khi lần trước đã được nhận) là một sự kiện mới thật, với đường dẫn mới.
    const next = await api.luckyAdminApi.upsertEvent({ title: 'IHOME · Trao thưởng' });
    expect(next.replayed).toBeUndefined();
    expect(world.events).toHaveLength(2);
    expect(world.events[1]!.slug).not.toBe(world.events[0]!.slug);
  });

  it('cấp lại mã điểm danh mất phản hồi: đọc lại mã hiện tại, không cấp thêm mã thứ hai', async () => {
    const ids = seedEvent();
    const before = world.events[0]!.teams[0]!.code;
    world.server.failNext('lucky_admin_update_team_v1', 'rpc', 'drop-after');
    const api = await load();
    const result = await api.luckyAdminApi.updateTeam(ids.team, { regenCode: true });
    expect(result).toMatchObject({ ok: true, teamId: ids.team, code: world.events[0]!.teams[0]!.code });
    expect(result.code).not.toBe(before);
    expect(world.calls('lucky_admin_update_team_v1')).toBe(1);
  });

  it('cấp lại mã điểm danh không tới máy chủ: báo mã hiện tại vẫn là mã cũ, bấm lại cấp được', async () => {
    const ids = seedEvent();
    world.server.failNext('lucky_admin_update_team_v1', 'rpc', 'drop-before');
    const api = await load();
    const error = await caught(api.luckyAdminApi.updateTeam(ids.team, { regenCode: true }));
    expect(error).toMatchObject({ outcome: 'unknown', repeatable: true });
    expect(String(error.message)).toContain('mã cũ');
    expect((await api.luckyAdminApi.updateTeam(ids.team, { regenCode: true })).ok).toBe(true);
  });

  it('xoá đội đã bị xoá ở lần bấm trước: báo đã xoá, không xoá gì thêm', async () => {
    const ids = seedEvent();
    world.server.failNext('lucky_admin_delete_team_v1', 'rpc', 'drop-after');
    const api = await load();
    await caught(api.luckyAdminApi.deleteTeam(ids.team, ids.event));
    expect(await api.luckyAdminApi.deleteTeam(ids.team, ids.event)).toMatchObject({ ok: true, alreadyDeleted: true });
    expect(world.calls('lucky_admin_delete_team_v1')).toBe(1);
  });

  it('đặt lại kết quả: kết quả trên máy chủ đã khác kết quả đang xem ⇒ không huỷ', async () => {
    const ids = seedEvent();
    await drawnEvent(ids);
    const api = await load();
    const error = await caught(api.luckyAdminApi.resetDraw(ids.event, '2026-01-01T00:00:00.000Z'));
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(world.calls('lucky_admin_reset_draw_v1')).toBe(0);
    expect(world.events[0]!.status).toBe('drawn');
  });

  it('đặt lại kết quả xong mà sự kiện vừa được quay lại: báo rõ, không mời bấm huỷ lần nữa', async () => {
    const ids = seedEvent();
    await drawnEvent(ids);
    const reset = world.server.rpcHandlers.lucky_admin_reset_draw_v1!;
    world.server.rpcHandlers.lucky_admin_reset_draw_v1 = args => {
      const reply = reset(args);
      world.server.rpcHandlers.lucky_admin_force_draw_v1!({ p_event: ids.event });
      return reply;
    };
    const api = await load();
    const error = await caught(api.luckyAdminApi.resetDraw(ids.event, world.events[0]!.drawnAt));
    expect(error).toMatchObject({ outcome: 'failure' });
    expect(String(error.message)).toContain('quay lại');
  });
});
