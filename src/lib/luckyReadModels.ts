import { z } from 'zod';

// Shapes are derived from lucky_event_payload_v1 and lucky_admin_get_v1.
const id = z.string().trim().min(1);
const money = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const proof = z.object({ path: id, name: z.string().min(1), at: timestamp.optional() });
const event = z.object({
  id, slug: z.string().nullable(), title: z.string().min(1), prizeLabel: z.string(),
  prizeAmount: money, drawAt: timestamp.nullable(), status: z.enum(['open', 'closed', 'drawn']),
  drawnAt: timestamp.nullable(), winnerTeamId: id.nullable(),
  game: z.enum(['wheel', 'race']).nullable(), raceSeconds: z.number().int().min(8).max(45).nullable(),
  serverNow: timestamp,
});
const team = z.object({
  id, name: z.string().min(1), sale: z.string().nullable(), deals: count,
  topRank: z.number().int().positive().nullable(), topPrizeAmount: money.nullable(),
  inWheel: z.boolean(), checkedIn: z.boolean(), checkedInAt: timestamp.nullable(),
  payoutAccount: z.string().nullable(), payoutBank: z.string().nullable(), payoutHolder: z.string().nullable(),
  proofs: z.array(proof),
});
const round = z.object({
  id, ordinal: z.number().int().positive(), label: z.string(), amount: money,
  winnersCount: z.number().int().positive(), status: z.enum(['pending', 'drawn']),
  drawnAt: timestamp.nullable(),
  winners: z.array(z.object({ teamId: id, position: z.number().int().positive(), amount: money })),
});
type DrawSources = { event: z.infer<typeof event>; teams: z.infer<typeof team>[]; rounds: z.infer<typeof round>[] };
// Deleting a winning team is allowed by SQL (SET NULL/CASCADE). Read it faithfully;
// a writer must separately confirm a nonempty result before claiming a successful draw.
function sourcesAgree(s: DrawSources): boolean {
  const teamIds = new Set(s.teams.map(t => t.id));
  if (teamIds.size !== s.teams.length || new Set(s.rounds.map(r => r.id)).size !== s.rounds.length ||
      new Set(s.rounds.map(r => r.ordinal)).size !== s.rounds.length) return false;
  if (s.teams.some(t => t.checkedIn !== (t.checkedInAt !== null))) return false;
  if (s.rounds.some(r => r.winners.some(w => !teamIds.has(w.teamId) || w.amount !== r.amount) ||
      new Set(r.winners.map(w => w.teamId)).size !== r.winners.length ||
      new Set(r.winners.map(w => w.position)).size !== r.winners.length ||
      r.winners.some(w => w.position > r.winnersCount) ||
      r.winners.length > r.winnersCount ||
      (r.status === 'pending' ? r.winners.length !== 0 || r.drawnAt !== null : r.drawnAt === null))) return false;
  if (s.event.winnerTeamId !== null && !teamIds.has(s.event.winnerTeamId)) return false;
  if (s.event.status === 'drawn' && (!s.event.drawnAt ||
      s.rounds.some(r => r.status !== 'drawn'))) return false;
  return true;
}
export const luckyPublicStateSchema = z.union([
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
  z.object({
    ok: z.literal(true), event,
    // SQL comparison with a null viewer produces null, not false.
    teams: z.array(team.extend({ isMine: z.boolean().nullable(), proofCount: count })),
    rounds: z.array(round),
  }).refine(sourcesAgree, 'Unconfirmed draw sources'),
]);
const adminEvent = event.extend({
  createdAt: timestamp,
  // This RPC uses jsonb_agg without COALESCE for teams. Successful null means zero teams.
  teams: z.array(team.extend({ code: z.string().regex(/^\d{6,8}$/), proofUploadedAt: timestamp.nullable() })).nullable().transform(value => value ?? []),
  rounds: z.array(round),
}).refine(s => sourcesAgree({ event: s, teams: s.teams, rounds: s.rounds }), 'Unconfirmed draw sources');
export const luckyAdminStateSchema = z.object({ ok: z.literal(true), organizationId: id, events: z.array(adminEvent) })
  .refine(s => new Set(s.events.map(e => e.id)).size === s.events.length, 'Duplicate event');
