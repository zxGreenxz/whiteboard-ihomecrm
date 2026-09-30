// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {LuckyEventAdmin,LuckyTeamAdmin,LuckyPublicState} from '@/lib/luckyDrawApi';
type AdminEventPayload = Omit<LuckyEventAdmin,'teams'> & {teams:LuckyTeamAdmin[]|null};
type LuckyAdminApi = typeof import('@/lib/luckyDrawApi').luckyAdminApi;
interface MockReply {data:unknown;error:unknown}

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: async () => ({ id: 'actor-1' }) }));
const time = '2026-09-30T05:00:00Z';
const team:LuckyTeamAdmin = { id: 'team-1', name: 'Đội A', sale: null, deals: 1, topRank: null, topPrizeAmount: null, inWheel: true, checkedIn: true, checkedInAt: time, payoutAccount: null, payoutBank: null, payoutHolder: null, proofs: [], code: '123456', proofUploadedAt: null };
const event:AdminEventPayload = { id: 'event-1', slug: null, title: 'Trao thưởng', prizeLabel: 'Giải', prizeAmount: 100, drawAt: null, status: 'open', drawnAt: null, winnerTeamId: null, game: 'wheel', raceSeconds: 20, serverNow: time, createdAt: time, teams: [team], rounds: [{ id: 'round-1', ordinal: 1, label: 'Lượt 1', amount: 100, winnersCount: 1, status: 'pending', drawnAt: null, winners: [] }] };
const admin = (e: AdminEventPayload = event) => ({ ok: true, organizationId: 'org-1', events: [e] });
const drawn = (e: AdminEventPayload = event): Required<Pick<LuckyPublicState,'ok'|'event'|'teams'|'rounds'>> => ({ ok: true, event: { ...e, status: 'drawn', drawnAt: time, winnerTeamId: 'team-1' }, teams: [{ ...team, isMine: null, proofCount: 0 }], rounds: [{ ...event.rounds[0], status: 'drawn', drawnAt: time, winners: [{ teamId: 'team-1', position: 1, amount: 100 }] }] });
type WritePayload = {ok:boolean;reason?:string;teamId?:string;code?:string} | ReturnType<typeof drawn>;
let reads:unknown; let writes:WritePayload|((fn:string)=>MockReply);
beforeEach(() => { vi.resetModules(); localStorage.clear(); reads = admin(); writes = { ok: true }; rpc.mockReset(); rpc.mockImplementation(async (fn: string) => fn === 'lucky_admin_get_v1' ? { data: reads, error: null } : typeof writes === 'function' ? writes(fn) : { data: writes, error: null }); });
describe('lucky admin result and retry feedback', () => {
  it('rejects incomplete admin sources instead of an empty dashboard', async () => {
    reads = { ok: true, organizationId: 'org-1' };
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(luckyAdminApi.get()).rejects.toThrow();
  });
  it('accepts SQL null teams in a confirmed empty event', async () => {
    reads = admin({ ...event, teams: null });
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    expect((await luckyAdminApi.get()).events[0].teams).toEqual([]);
  });
  it.each([
    ['update team', async (a: LuckyAdminApi) => a.updateTeam('team-1', { name: 'Mới' })],
    ['delete team', async (a: LuckyAdminApi) => a.deleteTeam('team-1')],
    ['set rules', async (a: LuckyAdminApi) => a.setRounds('event-1', [{ amount: 100, winnersCount: 1 }])],
    ['reset result', async (a: LuckyAdminApi) => a.resetDraw('event-1')],
  ])('never reports success for rejected %s', async (_, run) => {
    writes = { ok: false, reason: 'not_found' };
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(run(luckyAdminApi)).rejects.toThrow();
  });
  it('rejects an update receipt for another team', async () => {
    writes = { ok: true, teamId: 'other', code: '123456' };
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(luckyAdminApi.updateTeam('team-1', { name: 'Mới' })).rejects.toThrow();
  });
  it('requires reset readback, not only an acknowledgement', async () => {
    reads = admin({ ...event, status: 'drawn', drawnAt: time, winnerTeamId: 'team-1', rounds: drawn().rounds });
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(luckyAdminApi.resetDraw('event-1')).rejects.toThrow();
  });
  it('requires removal from the same authoritative event before deleted success', async () => {
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(luckyAdminApi.deleteTeam('team-1')).rejects.toThrow();
  });
  it('does not accept a result for another event or a pending selected round', async () => {
    writes = drawn({ ...event, id: 'other-event' });
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(luckyAdminApi.drawRound('event-1', 1)).rejects.toThrow();
  });
  it('retains an unknown draw across module remount and organization change, including other actions', async () => {
    writes = () => ({ data: null, error: { code: '', message: 'timeout', status: 504 } });
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    await expect(luckyAdminApi.drawRound('event-1', 1)).rejects.toThrow();
    vi.resetModules(); localStorage.setItem('ihomecrm.selectedOrganizationId', 'org-2');
    const remounted = (await import('@/lib/luckyDrawApi')).luckyAdminApi;
    await expect(remounted.resetDraw('event-1')).rejects.toThrow();
    expect(rpc.mock.calls.filter(([fn]) => fn !== 'lucky_admin_get_v1')).toHaveLength(1);
  });
  it('allows a known pre-write refusal to be corrected', async () => {
    writes = { ok: false, reason: 'not_time' };
    const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
    expect((await luckyAdminApi.drawRound('event-1', 1)).ok).toBe(false);
    writes = drawn();
    expect((await luckyAdminApi.drawRound('event-1', 1)).ok).toBe(true);
  });
});


it('does not release an unknown selected round on a generic successful refresh', async () => {
  writes = () => ({ data: null, error: { code: '', message: 'timeout', status: 504 } });
  const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
  await expect(luckyAdminApi.drawRound('event-1', 1)).rejects.toThrow();
  vi.resetModules(); const remounted = (await import('@/lib/luckyDrawApi')).luckyAdminApi;
  await expect(remounted.reconcileDraw('event-1')).rejects.toThrow();
  await expect(remounted.drawRound('event-1', 2)).rejects.toThrow();
  expect(rpc.mock.calls.filter(([fn]) => fn !== 'lucky_admin_get_v1')).toHaveLength(1);
});
it('releases only after the original selected round has a positively verified result', async () => {
  writes = () => ({ data: null, error: { code: '', message: 'timeout', status: 504 } });
  const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
  await expect(luckyAdminApi.drawRound('event-1', 1)).rejects.toThrow();
  reads = admin({ ...event, status: 'drawn', drawnAt: time, winnerTeamId: 'team-1', rounds: drawn().rounds });
  vi.resetModules(); const remounted = (await import('@/lib/luckyDrawApi')).luckyAdminApi;
  expect((await remounted.reconcileDraw('event-1'))?.ok).toBe(true);
  expect(rpc.mock.calls.filter(([fn]) => fn !== 'lucky_admin_get_v1')).toHaveLength(1);
  expect(await remounted.reconcileDraw('event-1')).toBeNull();
});
it('accepts a confirmed reset and a confirmed team deletion from the original event', async () => {
  reads = admin({ ...event, status: 'drawn', drawnAt: time, winnerTeamId: 'team-1', rounds: drawn().rounds });
  writes = (fn: string) => { reads = fn === 'lucky_admin_reset_draw_v1' ? admin() : admin({ ...event, teams: null }); return { data: { ok: true }, error: null }; };
  const { luckyAdminApi } = await import('@/lib/luckyDrawApi');
  expect((await luckyAdminApi.resetDraw('event-1')).ok).toBe(true);
  expect((await luckyAdminApi.deleteTeam('team-1')).ok).toBe(true);
});
