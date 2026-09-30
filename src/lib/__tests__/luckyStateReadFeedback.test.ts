import { describe, expect, it } from 'vitest';
import { parseLuckyState } from '@/lib/publicFeedback';
import type {LuckyEventPublic,LuckyTeamPublic,LuckyRoundPublic} from '@/lib/luckyDrawApi';
// The transport boundary intentionally contains invalid/missing model fields.
interface LuckyStatePayload {
 ok: boolean;
 event: Partial<Record<keyof LuckyEventPublic,unknown>>;
 teams: Partial<Record<keyof LuckyTeamPublic,unknown>>[];
 rounds: Partial<Record<keyof LuckyRoundPublic,unknown>>[];
}


const event:LuckyEventPublic = { id: 'event-1', slug: null, title: 'Trao thưởng', prizeLabel: 'Giải', prizeAmount: 100, drawAt: null, status: 'open', drawnAt: null, winnerTeamId: null, game: 'wheel', raceSeconds: 20, serverNow: '2026-09-30T05:00:00Z' };
const team:LuckyTeamPublic = { id: 'team-1', name: 'Đội A', sale: null, deals: 1, topRank: null, topPrizeAmount: null, inWheel: true, checkedIn: true, checkedInAt: '2026-09-30T04:00:00Z', isMine: null, payoutAccount: null, payoutBank: null, payoutHolder: null, proofs: [], proofCount: 0 };
const round:LuckyRoundPublic = { id: 'round-1', ordinal: 1, label: 'Lượt 1', amount: 100, winnersCount: 1, status: 'pending', drawnAt: null, winners: [] };
const state = ():LuckyStatePayload => ({ ok: true, event: { ...event }, teams: [{ ...team }], rounds: [{ ...round }] });

describe('lucky state authoritative read', () => {
  it('accepts the actual SQL nullable slug and viewer with complete sources', () => {
    expect(parseLuckyState(state())).toMatchObject({ ok: true, event: { slug: null }, teams: [{ isMine: null }] });
  });
  it.each([
    ['missing prize', (s: LuckyStatePayload) => { delete s.event.prizeAmount; }],
    ['invalid prize', (s: LuckyStatePayload) => { s.event.prizeAmount = 'SQL numeric'; }],
    ['missing count', (s: LuckyStatePayload) => { delete s.teams[0].proofCount; }],
    ['invalid checkin time', (s: LuckyStatePayload) => { s.teams[0].checkedInAt = 'yesterday'; }],
    ['invalid proof', (s: LuckyStatePayload) => { s.teams[0].proofs = [{ name: 'Ảnh', path: '' }]; }],
    ['missing winners', (s: LuckyStatePayload) => { delete s.rounds[0].winners; }],
    ['invalid round amount', (s: LuckyStatePayload) => { s.rounds[0].amount = null; }],
    ['invalid ordinal', (s: LuckyStatePayload) => { s.rounds[0].ordinal = 0; }],
    ['pending round with winners', (s: LuckyStatePayload) => { s.rounds[0].winners = [{ teamId: 'team-1', position: 1, amount: 100 }]; }],
    ['drawn round without confirmation time', (s: LuckyStatePayload) => { s.rounds[0].status = 'drawn'; }],
    ['winner outside event', (s: LuckyStatePayload) => { s.rounds[0] = { ...round, status: 'drawn', drawnAt: '2026-09-30T05:00:00Z', winners: [{ teamId: 'other-team', position: 1, amount: 100 }] }; }],
    ['drawn event without result', (s: LuckyStatePayload) => { s.event.status = 'drawn'; }],
  ])('rejects %s instead of rendering an invented complete result', (_, mutate) => {
    const s = state(); mutate(s); expect(() => parseLuckyState(s)).toThrow();
  });
  it('reads SQL results after a winning team is deleted without inventing a new winner', () => {
    const s = state(); s.event.status = 'drawn'; s.event.drawnAt = '2026-09-30T05:00:00Z';
    s.rounds[0].status = 'drawn'; s.rounds[0].drawnAt = s.event.drawnAt; s.teams = [];
    expect(parseLuckyState(s)).toMatchObject({ ok: true, event: { winnerTeamId: null }, rounds: [{ winners: [] }] });
  });
  it('accepts fewer winners than planned when there are fewer checked-in tickets', () => {
    const s = state(); s.rounds[0] = { ...round, winnersCount: 2, status: 'drawn', drawnAt: '2026-09-30T05:00:00Z', winners: [{ teamId: 'team-1', position: 1, amount: 100 }] };
    s.event = { ...event, status: 'drawn', drawnAt: '2026-09-30T05:00:00Z', winnerTeamId: 'team-1' };
    expect(parseLuckyState(s).ok).toBe(true);
  });
});
