// Máy chủ giả cho Quay số (đợt 9): giữ sự kiện / đội / lượt như các hàm `lucky_*` trên production (đọc thân hàm 26/11/2026)
// và ĐẾM SỐ LẦN BỐC THĂM THẬT (`realDraws`), để test chứng minh không lượt nào bị quay hai lần.
//   - `lucky_draw_v1`, `lucky_draw_round_v1`, `lucky_admin_force_draw_v1`: khoá sự kiện rồi mới xét «đã quay»; đã quay thì
//     trả lại kết quả cũ (không bốc lại), đúng như thân hàm production.
//   - Rớt mạng: `server.failNext('<tên hàm>', 'rpc', 'drop-before' | 'drop-after')` của `fakeRecordServer`.
//   - Trang công khai gọi bằng `fetch` thuần: `publicFetch` chuyển tới cùng máy chủ; tải giấy cọc lên kho cũng qua đây.
import { NETWORK_ERROR, fakeRecordServer, type FakeRecordServer } from '@/hooks/__tests__/fakeRecordServer';

type Row = Record<string, unknown>;
export interface FakeProof { path: string; name: string; at?: string }
export interface FakeTeam {
  id: string; name: string; sale: string | null; deals: number; topRank: number | null; topPrizeAmount: number | null;
  inWheel: boolean; checkedInAt: string | null; code: string; payoutAccount: string | null; payoutBank: string | null;
  payoutHolder: string | null; proofs: FakeProof[]; proofUploadedAt: string | null;
}
export interface FakeRound {
  id: string; ordinal: number; label: string; amount: number; winnersCount: number; status: 'pending' | 'drawn';
  drawnAt: string | null; winners: { teamId: string; position: number; amount: number }[];
}
export interface FakeEvent {
  id: string; slug: string | null; title: string; prizeLabel: string; prizeAmount: number; drawAt: string | null;
  status: 'open' | 'drawn' | 'closed'; drawnAt: string | null; winnerTeamId: string | null; game: 'wheel' | 'race';
  raceSeconds: number; createdAt: string; teams: FakeTeam[]; rounds: FakeRound[];
}
export interface LuckyWorld {
  server: FakeRecordServer;
  events: FakeEvent[];
  /** Số lần máy chủ THẬT SỰ bốc thăm (một lượt / một sự kiện được quay). */
  realDraws: number;
  /** Đường dẫn đã ghi vào kho `lucky-proofs` (kể cả lần ghi mà phản hồi bị mất). */
  stored: string[];
  /** Lần tải lên kế tiếp hỏng theo kiểu đã chọn (`drop-before`: không tới; `drop-after`: đã lưu, mất phản hồi). */
  failNextUpload: (failure: 'drop-before' | 'drop-after' | number) => void;
  publicFetch: (url: string, init?: { body?: unknown }) => Promise<unknown>;
  calls: (name: string) => number;
  addEvent: (patch?: Partial<FakeEvent>) => FakeEvent;
  addTeam: (event: FakeEvent, patch?: Partial<FakeTeam>) => FakeTeam;
  addRounds: (event: FakeEvent, ...rounds: { amount: number; winnersCount: number }[]) => FakeRound[];
}

const T0 = Date.UTC(2026, 10, 26, 2, 0, 0);

export function luckyWorld(): LuckyWorld {
  const server = fakeRecordServer();
  let seq = 0;
  let tick = 0;
  const at = () => new Date(T0 + (tick += 1000)).toISOString();
  const uploads: ('drop-before' | 'drop-after' | number)[] = [];
  const world: LuckyWorld = {
    server, events: [], realDraws: 0, stored: [],
    failNextUpload: failure => { uploads.push(failure); },
    calls: name => server.rpcCalls.filter(call => call.name === name).length,
    addEvent: (patch = {}) => {
      const event: FakeEvent = {
        id: `event-${++seq}`, slug: null, title: 'Trao thưởng', prizeLabel: 'Giải', prizeAmount: 100, drawAt: null,
        status: 'open', drawnAt: null, winnerTeamId: null, game: 'wheel', raceSeconds: 20, createdAt: at(), teams: [], rounds: [],
        ...patch,
      };
      world.events.push(event);
      return event;
    },
    addTeam: (event, patch = {}) => {
      const n = ++seq;
      const team: FakeTeam = {
        id: `team-${n}`, name: `Đội ${n}`, sale: null, deals: 1, topRank: null, topPrizeAmount: null, inWheel: true,
        checkedInAt: at(), code: String(100000 + n), payoutAccount: null, payoutBank: null, payoutHolder: null, proofs: [],
        proofUploadedAt: null, ...patch,
      };
      event.teams.push(team);
      return team;
    },
    addRounds: (event, ...rounds) => {
      event.rounds = rounds.map((r, index) => ({ id: `round-${++seq}`, ordinal: index + 1, label: '', amount: r.amount, winnersCount: r.winnersCount, status: 'pending', drawnAt: null, winners: [] }));
      return event.rounds;
    },
    publicFetch: async (url, init = {}) => {
      const text = String(url);
      if (text.includes('/storage/v1/object/lucky-proofs/')) {
        const path = decodeURIComponent(text.split('/storage/v1/object/lucky-proofs/')[1] ?? '');
        const failure = uploads.shift();
        if (failure === 'drop-before') throw new TypeError('Failed to fetch');
        if (typeof failure === 'number') return { ok: false, status: failure, json: async () => ({}) };
        if (world.stored.includes(path)) return { ok: false, status: 409, json: async () => ({}) };
        world.stored.push(path);
        if (failure === 'drop-after') throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, json: async () => ({ Key: path }) };
      }
      // Cùng cổng `rpc` của máy chủ giả (ghi nhật ký lời gọi, rớt mạng theo `failNext`); tên hàm lấy từ đường dẫn REST.
      const { rpc: send } = server;
      const reply = await send(text.split('/rest/v1/rpc/')[1] ?? '', JSON.parse(String(init.body ?? '{}')) as Row);
      if (reply.error === NETWORK_ERROR) throw new TypeError('Failed to fetch');
      if (reply.error) return { ok: false, status: 400, json: async () => reply.error };
      return { ok: true, status: 200, json: async () => reply.data };
    },
  };

  const find = (id: unknown) => world.events.find(event => event.id === id);
  const teamOf = (id: unknown) => {
    for (const event of world.events) { const team = event.teams.find(t => t.id === id); if (team) return { event, team }; }
    return null;
  };
  const refusal = (reason: string) => ({ data: { ok: false, reason }, error: null });
  const sqlError = (code: string, message: string) => ({ data: null, error: { code, message } });
  const publicTeam = (team: FakeTeam, viewer: string | null) => ({
    id: team.id, name: team.name, sale: team.sale, deals: team.deals, topRank: team.topRank, topPrizeAmount: team.topPrizeAmount,
    inWheel: team.inWheel, checkedIn: team.checkedInAt !== null, checkedInAt: team.checkedInAt,
    isMine: viewer === null ? null : team.id === viewer,
    payoutAccount: team.id === viewer ? team.payoutAccount : null, payoutBank: team.id === viewer ? team.payoutBank : null,
    payoutHolder: team.id === viewer ? team.payoutHolder : null, proofs: team.id === viewer ? team.proofs.map(p => ({ ...p })) : [],
    proofCount: team.proofs.length,
  });
  const eventHead = (event: FakeEvent) => ({
    id: event.id, slug: event.slug, title: event.title, prizeLabel: event.prizeLabel, prizeAmount: event.prizeAmount,
    drawAt: event.drawAt, status: event.status, drawnAt: event.drawnAt, winnerTeamId: event.winnerTeamId, game: event.game,
    raceSeconds: event.raceSeconds, serverNow: new Date().toISOString(),
  });
  const rounds = (event: FakeEvent) => event.rounds.map(r => ({ ...r, winners: r.winners.map(w => ({ ...w })) }));
  const payload = (event: FakeEvent, viewer: string | null = null) => ({
    data: { ok: true, event: eventHead(event), teams: event.teams.map(t => publicTeam(t, viewer)), rounds: rounds(event) }, error: null,
  });
  const candidates = (event: FakeEvent) => event.teams.filter(t => t.inWheel && t.checkedInAt !== null);
  const drawEvent = (event: FakeEvent) => {
    const winner = candidates(event)[0];
    if (!winner) return refusal('no_checked_in_teams');
    world.realDraws += 1;
    Object.assign(event, { status: 'drawn', winnerTeamId: winner.id, drawnAt: at() });
    return payload(event);
  };

  server.rpcHandlers = {
    lucky_public_state_v1: args => {
      let event = args.p_event ? find(args.p_event) : world.events.find(e => e.slug === args.p_slug);
      let viewer: string | null = null;
      if (args.p_code) {
        const hit = world.events.flatMap(e => e.status === 'closed' ? [] : e.teams.map(t => ({ e, t }))).find(x => x.t.code === args.p_code);
        if (!hit) return refusal('bad_code');
        if (event && hit.e.id !== event.id) return refusal('code_other_event');
        event = hit.e; viewer = hit.t.id;
      }
      return event ? payload(event, viewer) : refusal('not_found');
    },
    lucky_draw_v1: args => {
      const event = find(args.p_event);
      if (!event) return refusal('not_found');
      if (event.status === 'drawn') return payload(event);
      if (event.status !== 'open') return refusal('closed');
      if (event.drawAt === null) return refusal('forbidden');
      if (Date.now() < Date.parse(event.drawAt)) return refusal('not_time');
      return drawEvent(event);
    },
    lucky_admin_force_draw_v1: args => {
      const event = find(args.p_event);
      if (!event) return sqlError('42501', 'Sự kiện không thuộc tổ chức của bạn.');
      if (event.status === 'drawn') return payload(event);
      if (event.status !== 'open') return refusal('closed');
      return drawEvent(event);
    },
    lucky_draw_round_v1: args => {
      const event = find(args.p_event);
      if (!event) return refusal('forbidden');
      if (event.status === 'closed') return refusal('closed');
      if (event.drawAt !== null && Date.now() < Date.parse(event.drawAt)) return refusal('not_time');
      const round = event.rounds.find(r => r.ordinal === args.p_ordinal);
      if (!round) return refusal('round_not_found');
      if (round.status === 'drawn') return payload(event);
      if (event.rounds.some(r => r.ordinal < round.ordinal && r.status !== 'drawn')) return refusal('previous_round_pending');
      const pool = candidates(event);
      if (!pool.length) return refusal('no_checked_in_teams');
      world.realDraws += 1;
      round.winners = pool.slice(0, Math.min(round.winnersCount, pool.length)).map((t, index) => ({ teamId: t.id, position: index + 1, amount: round.amount }));
      Object.assign(round, { status: 'drawn', drawnAt: at() });
      if (event.rounds.every(r => r.status === 'drawn')) {
        const last = [...event.rounds].sort((a, b) => b.ordinal - a.ordinal)[0]!;
        Object.assign(event, { status: 'drawn', drawnAt: at(), winnerTeamId: last.winners[0]?.teamId ?? null });
      }
      return payload(event);
    },
    lucky_admin_get_v1: () => ({
      data: {
        ok: true, organizationId: 'org-1',
        events: world.events.map(event => ({
          ...eventHead(event), createdAt: event.createdAt, rounds: rounds(event),
          teams: event.teams.map(t => ({ ...publicTeam(t, t.id), isMine: undefined, proofCount: undefined, code: t.code, proofUploadedAt: t.proofUploadedAt })),
        })),
      },
      error: null,
    }),
    lucky_admin_upsert_event_v1: args => {
      const p = args.p as Row;
      const slug = typeof p.slug === 'string' ? p.slug.trim().toLowerCase() : '';
      if (slug && world.events.some(e => e.slug === slug && e.id !== p.id)) return sqlError('23505', `Đường dẫn "${slug}" đã có sự kiện khác dùng rồi.`);
      let event = p.id ? find(p.id) : undefined;
      if (p.id && !event) return sqlError('42501', 'Sự kiện không thuộc tổ chức của bạn.');
      if (!event) event = world.addEvent({ title: String(p.title || 'IHOME · Trao thưởng'), slug: slug || null });
      else {
        if (typeof p.title === 'string' && p.title) event.title = p.title;
        if (slug) event.slug = slug;
        if (p.status === 'open' || p.status === 'closed') event.status = p.status;
        if ('drawAt' in p) event.drawAt = (p.drawAt as string | null) || null;
      }
      return { data: { ok: true, eventId: event.id, slug: event.slug, game: event.game }, error: null };
    },
    lucky_admin_set_rounds_v1: args => {
      const event = find(args.p_event);
      if (!event) return sqlError('42501', 'Sự kiện không thuộc tổ chức của bạn.');
      if (event.rounds.some(r => r.status === 'drawn')) return sqlError('22023', 'Sự kiện đã quay ít nhất một lượt.');
      world.addRounds(event, ...(args.p_rounds as { amount: number; winnersCount: number }[]));
      return { data: { ok: true, rounds: event.rounds.length }, error: null };
    },
    lucky_admin_add_team_v1: args => {
      const event = find(args.p_event);
      if (!event) return sqlError('42501', 'Sự kiện không thuộc tổ chức của bạn.');
      const name = String(args.p_name).replace(/^ +| +$/g, '');
      if (event.teams.some(t => t.name === name)) return sqlError('23505', 'duplicate key value violates unique constraint "lucky_event_teams_event_id_name_key"');
      const team = world.addTeam(event, { name, checkedInAt: null, deals: Number(args.p_deals ?? 1), sale: (args.p_sale as string | undefined) ?? null });
      return { data: { ok: true, teamId: team.id, code: team.code }, error: null };
    },
    lucky_admin_update_team_v1: args => {
      const hit = teamOf(args.p_team);
      if (!hit) return refusal('not_found');
      const p = args.p as Row;
      const { team } = hit;
      if (typeof p.name === 'string' && p.name.trim()) team.name = p.name.trim();
      if ('sale' in p) team.sale = (p.sale as string | null) || null;
      if (typeof p.deals === 'number') team.deals = p.deals;
      if (typeof p.inWheel === 'boolean') team.inWheel = p.inWheel;
      if ('checkedIn' in p) team.checkedInAt = p.checkedIn ? team.checkedInAt ?? at() : null;
      if (p.regenCode) team.code = String(200000 + ++seq);
      return { data: { ok: true, teamId: team.id, code: team.code }, error: null };
    },
    lucky_admin_delete_team_v1: args => {
      const hit = teamOf(args.p_team);
      if (!hit) return refusal('not_found');
      const { event, team } = hit;
      event.teams = event.teams.filter(t => t !== team);
      if (event.winnerTeamId === team.id) event.winnerTeamId = null;
      for (const round of event.rounds) round.winners = round.winners.filter(w => w.teamId !== team.id);
      return { data: { ok: true }, error: null };
    },
    lucky_admin_reset_draw_v1: args => {
      const event = find(args.p_event);
      if (!event) return sqlError('42501', 'Sự kiện không thuộc tổ chức của bạn.');
      for (const round of event.rounds) Object.assign(round, { status: 'pending', drawnAt: null, winners: [] });
      Object.assign(event, { status: 'open', winnerTeamId: null, drawnAt: null });
      return { data: { ok: true }, error: null };
    },
    lucky_save_payout_v1: args => {
      const hit = world.events.flatMap(e => e.status === 'closed' ? [] : e.teams.map(t => ({ e, t }))).find(x => x.t.code === args.p_code);
      if (!hit) return refusal('bad_code');
      if (!hit.t.checkedInAt) return refusal('not_checked_in');
      const p = args.p as Row;
      if (Array.isArray(p.proofs)) {
        hit.t.proofs = (p.proofs as FakeProof[]).filter(x => String(x.path).startsWith(hit.e.id + '/')).slice(0, 10).map(x => ({ path: x.path, name: x.name, at: x.at ?? at() }));
        hit.t.proofUploadedAt = hit.t.proofs.length ? at() : null;
      }
      for (const field of ['payoutAccount', 'payoutBank', 'payoutHolder'] as const) if (field in p) hit.t[field] = String(p[field] ?? '').trim() || null;
      return payload(hit.e, hit.t.id);
    },
  };
  return world;
}

/** Dấu «chờ đối chiếu» của bản trước mà nơi gọi không còn ghi nữa (khoá chung, không tên thao tác), gieo sẵn 10 phút. */
export const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);
