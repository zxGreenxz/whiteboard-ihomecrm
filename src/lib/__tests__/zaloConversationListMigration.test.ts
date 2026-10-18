// zalo_conversation_list_v1 (20261018051900) so với ĐÚNG đường web cũ của màn Chat Zalo, trên cùng một
// database PGlite có RLS của zalo_conversations và rooms (chép từ migration 20260813100000 +
// 20260801040000; chưa đối chiếu pg_policies TEST trong phiên này):
//   web cũ = PostgREST zalo_conversations select(CONV_COLS).eq(org).order(last_message_at desc nullslast)
//            .limit(5000) + sắp ghim + bộ lọc `filtered` của ChatZaloPage (chép nguyên văn từ main).
// Một instance PGlite cho cả file, mỗi ca BEGIN…ROLLBACK.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterKey, ZaloConversation } from '@/components/chat-zalo/types';
import { conversationHasLabel, isTenantConversation } from '@/components/chat-zalo/conversationState';
import { CONV_FIELDS, PROFILE_FIELDS, parseZaloConversationList, zaloConversationListArgs, type ZaloConversationListArgs } from '@/lib/zaloConversationList';
import { mapConv } from '@/hooks/useZaloChat';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ organization: null }) }));

const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const [ORG_A, ORG_B, SANDBOX] = [1, 2, 3].map(id);
const [OWNER, STAFF, NOVIEW, OTHER, MULTI, SUPER, SANDBOXER] = [10, 11, 12, 13, 14, 15, 16].map(id);
const [AC1, AC2, AC3] = [20, 21, 22].map(id);
const [B1, B2, BX] = [30, 31, 32].map(id);
const [R1, R2, R3, RX, RDEL] = [40, 41, 42, 43, 44].map(id);
const [K1, K2, K3] = [50, 51, 52].map(id);
const [L1, L2, L3] = [60, 61, 62].map(id);
const Z = (n: number) => id(1000 + n);
const MIGRATION = 'supabase/migrations/20261018051900_zalo_conversation_list_v1.sql';

const grants: Array<[string, string, string | null]> = [
  [OWNER, 'member', ORG_A], [OWNER, 'chat_zalo.view', ORG_A], [OWNER, 'buildings.view', B1], [OWNER, 'buildings.view', B2],
  // Nhân viên: xem Zalo cả công ty nhưng chỉ thấy phòng toà B1 ⇒ thu hẹp theo B2 phải rỗng.
  [STAFF, 'member', ORG_A], [STAFF, 'chat_zalo.view', ORG_A], [STAFF, 'buildings.view', B1],
  [NOVIEW, 'member', ORG_A], [NOVIEW, 'buildings.view', B1],
  [OTHER, 'member', ORG_B], [OTHER, 'chat_zalo.view', ORG_B], [OTHER, 'buildings.view', BX],
  [MULTI, 'member', ORG_A], [MULTI, 'member', ORG_B], [MULTI, 'chat_zalo.view', ORG_A], [MULTI, 'chat_zalo.view', ORG_B],
  [MULTI, 'buildings.view', B1], [MULTI, 'buildings.view', BX],
  [SUPER, 'super', null],
  [SANDBOXER, 'member', SANDBOX], [SANDBOXER, 'chat_zalo.view', SANDBOX],
];

// [n, org, account, name, phone, sub, pinned, minute|null, unread, marked, contract, room, lead, label_ids, profile, thread]
type Seed = [number, string, string | null, string, string | null, string | null, boolean, number | null, number, boolean,
  string | null, string | null, string | null, unknown, unknown, string];
const seeds: Seed[] = [
  [1, ORG_A, AC1, 'Nguyễn Văn An', '0901 234 567', 'Khách trọ P101', true, 100, 2, false, K1, R1, null, [1, 2],
    { kind: 'tenant', room: 'P101', debt: { amount: '1', overdue: '0', note: '' }, memberProfiles: { 1: { name: 'x' } }, raw: 'big' }, 'user'],
  [2, ORG_A, AC1, 'NGUYỄN THỊ BÌNH', null, null, false, 99, 0, true, null, null, L1, [2], { kind: 'lead', stage: 'new', room: null }, 'user'],
  [3, ORG_A, AC2, 'Đặng Quốc Dũng', '0933', 'Sale', false, 98, 0, false, null, null, null, ['1'], { room: 'Phòng A1' }, 'user'],
  [4, ORG_A, null, 'Khách lạ', '0944', null, false, 97, 5, false, null, null, null, [], {}, 'user'],
  [5, ORG_A, AC1, 'Danh bạ Hoa', '0955', null, false, null, 0, false, null, null, null, [1], { isGroup: false }, 'user'],
  [6, ORG_A, AC2, 'Danh bạ Minh', null, 'Phòng 202 cũ', true, null, 0, false, null, R3, null, [3], { room: '202' }, 'user'],
  [7, ORG_A, AC1, 'Nhóm 100% _test_', null, null, false, 96, 1, false, null, null, null, { a: 1 }, [1, 2], 'group'],
  [8, ORG_A, AC2, 'Trần (Test) [x]', '+84.90*1', 'nhãn PHỤ Đặc biệt', false, 96, 0, false, K2, null, null, [1], { room: 'R.101' }, 'user'],
  [9, ORG_A, AC1, 'lê thị hoa', '0977', null, false, 95, 0, false, null, R2, null, [2, 1],
    { room: 'P-Hoa', tags: [{ l: 'T', t: 'info' }], members: null, stats: [{ label: 'a', value: 'b' }] }, 'group'],
  [10, ORG_A, AC1, 'Phạm Minh Đức', '0988', 'Chủ nhà', false, 94, 0, true, null, RDEL, L2, [5], { kind: 'broker', company: 'ABC', room: 'Toà Đức' }, 'user'],
  [11, ORG_A, AC2, 'đỗ thùy dương', null, null, false, 93, 3, false, K3, R1, null, [], { stats: [{ label: 'a', value: 'b' }] }, 'user'],
  [12, ORG_A, null, 'Danh bạ chưa gắn', '0912', null, false, null, 0, true, null, null, L3, [], {}, 'user'],
  ...Array.from({ length: 24 }, (_, i): Seed => {
    const n = 13 + i;
    return [n, ORG_A, [AC1, AC2, null][n % 3], `Khach ${n}`, `09100${n}`, n % 2 ? `Nhãn ${n % 3}` : null, n % 5 === 0,
      n % 4 === 0 ? null : 90 - (n % 9), n % 3 === 0 ? n % 7 : 0, n % 8 === 0, n % 7 === 0 ? K1 : null,
      // n = 30 gắn phòng của công ty B (dữ liệu cũ): thu hẹp toà không được kéo nó vào công ty A.
      n % 6 === 0 ? [R1, R3, RX][(n / 6) % 3] : null, n % 6 === 1 ? L1 : null, [n % 4, (n + 1) % 4], n % 5 === 1 ? { room: `P${n}` } : {}, 'user'];
  }),
  [40, ORG_B, AC3, 'Org B Nguyễn', '0900', null, false, 100, 1, false, null, RX, null, [1], {}, 'user'],
  [41, ORG_B, AC3, 'Org B Danh bạ', null, null, false, null, 0, false, null, null, null, [], {}, 'user'],
  [42, SANDBOX, null, 'Sandbox An', null, null, false, 80, 0, false, null, null, null, [], {}, 'user'],
];

const lit = (v: unknown): string => v === null || v === undefined ? 'NULL'
  : typeof v === 'boolean' || typeof v === 'number' ? String(v)
  : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  : `'${String(v).replace(/'/g, "''")}'`;
const values = (rows: unknown[][]) => rows.map(r => `(${r.map(lit).join(',')})`).join(',');
const at = (minute: number | null) => minute === null ? null : new Date(Date.UTC(2026, 9, 17, 0, minute)).toISOString();

beforeAll(async () => {
  await db.exec(`
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE TABLE public.test_grants(uid uuid, perm text, target uuid);
CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(array_agg(target), '{}') FROM public.test_grants WHERE uid = auth.uid() AND perm = 'member' $$;
CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.test_grants WHERE uid = auth.uid() AND perm = 'super') $$;
CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${SANDBOX}'::uuid] $$;
-- zalo_authorized_org_ids: các công ty của caller có quyền chat_zalo.<action> phạm vi toàn công ty.
CREATE FUNCTION public.zalo_authorized_org_ids(text) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT g.target FROM public.test_grants g WHERE g.uid = auth.uid() AND g.perm = 'chat_zalo.' || $1 AND g.target = ANY (public.my_org_ids()) $$;
CREATE FUNCTION public.accessible_building_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT target FROM public.test_grants WHERE uid = auth.uid() AND perm = 'buildings.view' $$;

CREATE TABLE public.rooms(id uuid PRIMARY KEY, building_id uuid, organization_id uuid, name text, deleted_at timestamptz);
CREATE TABLE public.zalo_conversations(id uuid PRIMARY KEY, user_id uuid, organization_id uuid NOT NULL, account_id uuid,
  thread_id text, thread_type text NOT NULL DEFAULT 'user', peer_name text NOT NULL, peer_avatar_url text, peer_phone text,
  peer_zalo_uid text, initials text, tone text NOT NULL DEFAULT 'emerald', kind text NOT NULL DEFAULT 'unknown',
  customer_id uuid, lead_id uuid, contract_id uuid, room_id uuid, assigned_staff_id uuid, sub_label text, sub_tone text,
  list_tag jsonb, header_tag jsonb, header_sub text, profile jsonb NOT NULL DEFAULT '{}'::jsonb, last_message_text text,
  last_message_at timestamptz, last_message_dir text, unread_count int NOT NULL DEFAULT 0, is_online boolean NOT NULL DEFAULT false,
  is_pinned boolean NOT NULL DEFAULT false, is_muted boolean NOT NULL DEFAULT false, marked_unread boolean NOT NULL DEFAULT false,
  is_sale_partner boolean NOT NULL DEFAULT false, label_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY rooms_select_rbac ON public.rooms FOR SELECT USING ((SELECT public.is_super_admin()) OR building_id IN (SELECT public.accessible_building_ids()));
CREATE POLICY rooms_org_boundary ON public.rooms AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
CREATE POLICY zalo_conversations_org_boundary ON public.zalo_conversations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))
  WITH CHECK ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())));
CREATE POLICY zalo_conversations_org_select ON public.zalo_conversations FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT public.zalo_authorized_org_ids('view')));
CREATE POLICY zalo_conversations_hide_sandbox_admin ON public.zalo_conversations AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT ((SELECT public.is_super_admin()) AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)));
GRANT SELECT ON public.rooms, public.zalo_conversations TO authenticated;
`);
  await db.exec(`
INSERT INTO public.test_grants(uid, perm, target) VALUES ${values(grants)};
INSERT INTO public.rooms(id, building_id, organization_id, name, deleted_at) VALUES ${values([[R1, B1, ORG_A, '101', null], [R2, B1, ORG_A, '102', null],
    [R3, B2, ORG_A, '201', null], [RX, BX, ORG_B, 'X1', null], [RDEL, B2, ORG_A, '299', '2026-10-01T00:00:00Z']])};
INSERT INTO public.zalo_conversations(id, organization_id, account_id, peer_name, peer_phone, sub_label, is_pinned, last_message_at,
  unread_count, marked_unread, contract_id, room_id, lead_id, label_ids, profile, thread_type, last_message_text, initials, list_tag)
VALUES ${values(seeds.map(([n, org, account, name, phone, sub, pinned, minute, unread, marked, contract, room, lead, labels, profile, thread]) =>
    [Z(n), org, account, name, phone, sub, pinned, at(minute), unread, marked, contract, room, lead, labels, profile, thread,
      minute === null ? null : `Tin ${n}`, n % 2 ? null : `K${n}`, n % 3 ? null : { l: 'Nợ', t: 'debt' }]))};
`);
  // Như Supabase: hàm mới trong public mặc định cấp EXECUTE cho anon/authenticated/service_role,
  // nên REVOKE của migration mới là thứ chặn anon/service_role.
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role');
  // Hai lượt: migration phải idempotent.
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
}, 60_000);
afterAll(() => db.close());
beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));

async function as(uid: string | null) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('test.uid', $1, true)", [uid ?? '']);
  await db.exec('SET LOCAL ROLE authenticated');
}

type Outcome<T> = { ok: true; value: T; code?: undefined } | { ok: false; code: string; value?: undefined };
async function attempt<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  await db.exec('SAVEPOINT attempt');
  try {
    const value = await run();
    await db.exec('RELEASE SAVEPOINT attempt');
    return { ok: true, value };
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return { ok: false, code: String((error as { code?: string }).code) };
  }
}

type Raw = { total: number; rows: Array<Record<string, unknown> & { id: string }> };
type Call = Partial<Omit<ZaloConversationListArgs, 'p_organization_id'>> & { p_organization_id: string | null };
async function rpc(a: Call): Promise<Raw> {
  const r = await db.query<{ v: Raw }>('SELECT public.zalo_conversation_list_v1($1, $2, $3, $4::uuid[], $5, $6, $7::uuid[], $8, $9) v',
    [a.p_organization_id, a.p_filter ?? null, a.p_search ?? null, a.p_account_ids ?? null, a.p_label_account_id ?? null,
      a.p_label_id ?? null, a.p_building_ids ?? null, a.p_limit ?? null, a.p_offset === undefined ? 0 : a.p_offset]);
  return r.rows[0].v;
}
const ids = (result: Raw) => result.rows.map(r => r.id);

/** useZaloChat.ts trước 18/10: PostgREST select(CONV_COLS) + order + limit(5000) — max_rows 1000 cắt trước — rồi sắp ghim. */
async function webConversations(org: string): Promise<ZaloConversation[]> {
  const cols = [...CONV_FIELDS, ...PROFILE_FIELDS.map(key => `profile -> '${key}' AS "profile_${key}"`)].join(', ');
  // Web cũ không định thứ tự trong nhóm trùng giờ / chưa có tin; so theo id giảm dần như hàm mới.
  const rows = (await db.query<{ j: Record<string, unknown> }>(`SELECT to_jsonb(x) j FROM (SELECT ${cols} FROM public.zalo_conversations
    WHERE organization_id = $1 ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 1000) x`, [org])).rows.map(r => r.j);
  return rows.map(mapConv).sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

type View = { filter: FilterKey; search: string; selIds: string[]; accounts: Array<{ id: string }>; selectedLabel: string | null };
/** ChatZaloPage.tsx trước 18/10 (vùng hermes-parity zalo-conversations), chép nguyên văn. */
function webFilter(conversations: ZaloConversation[], { filter, search, selIds, accounts, selectedLabel }: View) {
  const q = search.trim().toLowerCase();
  const selSet = new Set(selIds);
  const allSelected = accounts.every(account => selSet.has(account.id));
  return conversations.filter((c) => {
    if (!allSelected && c.accountId && !selSet.has(c.accountId)) return false;
    if (!conversationHasLabel(c, selectedLabel)) return false;
    // 'Danh bạ' = đã sync từ bạn bè nhưng CHƯA từng có tin nhắn; các chip khác ẩn nhóm này
    if (filter === 'contacts') { if (c.hasMessages) return false; }
    else if (!c.hasMessages && !q) return false;
    if (filter === 'unread' && c.unread <= 0 && !c.markedUnread) return false;
    if (filter === 'tenant' && !isTenantConversation(c)) return false;
    if (filter === 'lead' && !c.leadId) return false;
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      c.sub.toLowerCase().includes(q) ||
      (c.profile.room || '').toLowerCase().includes(q)
    );
  });
}

const ACCOUNTS: Record<string, string[]> = { [ORG_A]: [AC1, AC2], [ORG_B]: [AC3], [SANDBOX]: [] };
type Page = { limit: number; offset: number };
async function expectParity(uid: string, org: string, view: Omit<View, 'accounts'>, page: Page = { limit: 300, offset: 0 }) {
  const accounts = (ACCOUNTS[org] ?? []).map(account => ({ id: account }));
  await as(uid);
  const old = webFilter(await webConversations(org), { ...view, accounts });
  const args = zaloConversationListArgs({ organizationId: org, filter: view.filter, search: view.search, selectedAccountIds: view.selIds,
    accountIds: accounts.map(account => account.id), label: view.selectedLabel, limit: page.limit, offset: page.offset });
  const parsed = parseZaloConversationList(await rpc(args), args);
  const label = JSON.stringify({ uid, org, view, page });
  expect(parsed.total, label).toBe(old.length);
  expect(parsed.rows.map(mapConv), label).toEqual(old.slice(page.offset, page.offset + page.limit));
  return parsed.total;
}

const USERS: Array<[string, string]> = [[OWNER, ORG_A], [STAFF, ORG_A], [NOVIEW, ORG_A], [OTHER, ORG_B], [OTHER, ORG_A],
  [MULTI, ORG_A], [MULTI, ORG_B], [SUPER, ORG_A], [SUPER, SANDBOX], [SANDBOXER, SANDBOX]];
const FILTERS: FilterKey[] = ['all', 'unread', 'tenant', 'lead', 'contacts'];
const SEARCHES = ['', '  ', 'an', 'nguyễn', 'NGUYỄN', 'nguyen', 'bình', 'BÌNH', '0901', '0901 234', '+84.90*1', '(test)', '[x]',
  '100%', '_test_', '%', '_', 'p101', 'phòng', 'PHÒNG A1', '202', 'r.101', 'nhãn phụ', 'đặc biệt', 'khach 1', 'danh bạ',
  'toà đức', 'p-hoa', 'zzz', 'é', '　an﻿', '\tan\n'];
const SELECTIONS = [[AC1, AC2], [AC1], [AC2], [], [AC1, id(999)], [AC3]];
const LABELS = [null, `${AC1}:1`, `${AC1}:2`, `${AC2}:1`, `${AC2}:3`, `${AC1}:9`, `${AC1}:0`];

/** PRNG tất định để lấy mẫu tổ hợp lặp lại được. */
function rng(seed: number) {
  let s = seed >>> 0;
  return <T>(items: readonly T[]): T => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return items[s % items.length];
  };
}

describe('zalo_conversation_list_v1 khớp đường web cũ', () => {
  it('danh sách nền (p_filter NULL) = useZaloConversations cũ cho mọi người dùng × công ty', async () => {
    for (const [uid, org] of USERS) {
      await as(uid);
      const old = await webConversations(org);
      const args = zaloConversationListArgs({ organizationId: org, limit: 1000 });
      const parsed = parseZaloConversationList(await rpc(args), args);
      expect(parsed.rows.map(mapConv), JSON.stringify({ uid, org })).toEqual(old);
      expect(parsed.total).toBe(old.length);
    }
    await as(OWNER);
    expect((await rpc({ p_organization_id: ORG_A })).total).toBe(36);
  });

  it('mọi thẻ × mọi từ khoá (chủ + nhân viên)', async () => {
    let matched = 0;
    for (const uid of [OWNER, STAFF]) for (const filter of FILTERS) for (const search of SEARCHES) {
      const total = await expectParity(uid, ORG_A, { filter, search, selIds: [AC1, AC2], selectedLabel: null });
      if (search.trim() && total > 0) matched += 1;
    }
    expect(matched).toBeGreaterThan(60);
  }, 60_000);

  it('mọi thẻ × chọn tài khoản × nhãn', async () => {
    let nonEmpty = 0;
    for (const filter of FILTERS) for (const selIds of SELECTIONS) for (const selectedLabel of LABELS) {
      if (await expectParity(OWNER, ORG_A, { filter, search: '', selIds, selectedLabel }) > 0) nonEmpty += 1;
    }
    expect(nonEmpty).toBeGreaterThan(50);
  }, 60_000);

  it('250 tổ hợp lấy mẫu gồm công ty khác, sandbox, super admin, phân trang', async () => {
    const pick = rng(18102026);
    const pages: Page[] = [{ limit: 300, offset: 0 }, { limit: 3, offset: 0 }, { limit: 3, offset: 3 }, { limit: 4, offset: 40 }, { limit: 0, offset: 0 }];
    for (let i = 0; i < 250; i += 1) {
      const [uid, org] = pick(USERS);
      await expectParity(uid, org, { filter: pick(FILTERS), search: pick(SEARCHES), selIds: pick(SELECTIONS), selectedLabel: pick(LABELS) }, pick(pages));
    }
  }, 120_000);
});

describe('quyền và phạm vi', () => {
  it('đúng tập dòng theo RLS: không có chat_zalo.view, công ty khác, sandbox, super admin', async () => {
    await as(NOVIEW);
    expect(await rpc({ p_organization_id: ORG_A })).toEqual({ total: 0, rows: [] });
    await as(OTHER);
    expect(await rpc({ p_organization_id: ORG_A })).toEqual({ total: 0, rows: [] });
    expect((await rpc({ p_organization_id: ORG_B })).total).toBe(2);
    await as(MULTI);
    // Thuộc hai công ty: p_organization_id lọc tường minh, không trộn.
    expect(ids(await rpc({ p_organization_id: ORG_A })).every(row => seeds.find(s => Z(s[0]) === row)?.[1] === ORG_A)).toBe(true);
    expect(ids(await rpc({ p_organization_id: ORG_B }))).toEqual([Z(40), Z(41)]);
    await as(SUPER);
    expect((await rpc({ p_organization_id: ORG_A })).total).toBe(36);
    expect(await rpc({ p_organization_id: SANDBOX })).toEqual({ total: 0, rows: [] });
    await as(SANDBOXER);
    expect(ids(await rpc({ p_organization_id: SANDBOX }))).toEqual([Z(42)]);
  });

  it('chỉ chạy bằng JWT người dùng: anon, thiếu uid, postgres, gọi từ thân hàm DEFINER đều bị chặn', async () => {
    await db.exec('RESET ROLE');
    await db.exec(`CREATE FUNCTION public.test_definer_wrapper(uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT public.zalo_conversation_list_v1($1) $$;
      GRANT EXECUTE ON FUNCTION public.test_definer_wrapper(uuid) TO authenticated`);
    await as(OWNER);
    expect(await attempt(() => db.query('SELECT public.test_definer_wrapper($1)', [ORG_A]))).toMatchObject({ ok: false, code: '42501' });
    await as(null);
    expect(await attempt(() => rpc({ p_organization_id: ORG_A }))).toMatchObject({ ok: false, code: '42501' });
    await db.exec('RESET ROLE');
    await db.exec('SET LOCAL ROLE anon');
    expect(await attempt(() => rpc({ p_organization_id: ORG_A }))).toMatchObject({ ok: false, code: '42501' });
    await db.exec('RESET ROLE');
    await db.exec('SET LOCAL ROLE service_role');
    expect(await attempt(() => rpc({ p_organization_id: ORG_A }))).toMatchObject({ ok: false, code: '42501' });
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('test.uid', $1, true)", [OWNER]);
    expect(await attempt(() => rpc({ p_organization_id: ORG_A }))).toMatchObject({ ok: false, code: '42501' });
  });

  it('INVOKER và ACL: không SECURITY DEFINER, search_path rỗng, chỉ authenticated được EXECUTE', async () => {
    const fn = (await db.query<{ secdef: boolean; config: string[]; vol: string; anon: boolean; auth: boolean; pub: boolean; svc: boolean }>(`
      SELECT p.prosecdef secdef, p.proconfig config, p.provolatile vol,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) pub
      FROM pg_proc p WHERE p.proname = 'zalo_conversation_list_v1'`)).rows;
    expect(fn).toEqual([{ secdef: false, config: ['search_path=""'], vol: 's', anon: false, auth: true, pub: false, svc: false }]);
  });

  it('p_building_ids chỉ thu hẹp: tập con của không lọc, theo phòng thấy được qua RLS', async () => {
    const pick = rng(99);
    const pool = [B1, B2, BX, id(998)];
    for (const uid of [OWNER, STAFF, SUPER]) {
      await as(uid);
      const rooms = new Map((await db.query<{ id: string; building_id: string }>(
        'SELECT id, building_id FROM public.rooms WHERE organization_id = $1', [ORG_A])).rows.map(r => [r.id, r.building_id]));
      for (let i = 0; i < 12; i += 1) {
        const filter = pick([undefined, ...FILTERS]);
        const subset = pool.filter(() => pick([true, false]));
        const all = await rpc({ p_organization_id: ORG_A, p_filter: filter });
        const narrowed = await rpc({ p_organization_id: ORG_A, p_filter: filter, p_building_ids: subset });
        const expected = all.rows.filter(row => typeof row.room_id === 'string' && subset.includes(rooms.get(row.room_id) ?? '')).map(row => row.id);
        expect(ids(narrowed), JSON.stringify({ uid, filter, subset })).toEqual(expected);
        expect(narrowed.total).toBe(expected.length);
      }
    }
    await as(STAFF);
    expect((await rpc({ p_organization_id: ORG_A, p_building_ids: [B2] })).total).toBe(0);
    await as(OWNER);
    // Phòng đã xoá mềm vẫn thuộc toà của nó; toà công ty khác không thêm gì.
    expect(ids(await rpc({ p_organization_id: ORG_A, p_building_ids: [B2] }))).toEqual(expect.arrayContaining([Z(6), Z(10)]));
    expect((await rpc({ p_organization_id: ORG_A, p_building_ids: [BX] })).total).toBe(0);
    await as(MULTI);
    expect(ids(await rpc({ p_organization_id: ORG_B, p_building_ids: [BX] }))).toEqual([Z(40)]);
    expect((await rpc({ p_organization_id: ORG_A, p_building_ids: [BX] })).total).toBe(0);
  });

  it('p_building_ids: NULL = toàn phạm vi RLS, mảng rỗng = 0 dòng (caller thu hẹp phải COALESCE)', async () => {
    for (const uid of [OWNER, STAFF, SUPER]) {
      await as(uid);
      for (const filter of [undefined, ...FILTERS]) {
        const none = await rpc({ p_organization_id: ORG_A, p_filter: filter });
        expect(await rpc({ p_organization_id: ORG_A, p_filter: filter, p_building_ids: null as unknown as undefined })).toEqual(none);
        const rls = (await db.query<{ id: string }>('SELECT id FROM public.zalo_conversations WHERE organization_id = $1', [ORG_A])).rows.map(r => r.id);
        if (filter === undefined) expect(ids(none).sort()).toEqual(rls.sort());
        expect(await rpc({ p_organization_id: ORG_A, p_filter: filter, p_building_ids: [] })).toEqual({ total: 0, rows: [] });
      }
    }
  });

  it('tham số sai báo 22023 thay vì trả rỗng', async () => {
    await as(OWNER);
    for (const bad of [{ p_filter: 'pinned' }, { p_limit: -1 }, { p_offset: -1 }, { p_offset: null }, { p_search: 'a'.repeat(201) },
      { p_label_id: 1 }, { p_label_account_id: AC1 }, { p_account_ids: [AC1, null] }, { p_building_ids: [B1, null] },
      { p_account_ids: Array.from({ length: 501 }, (_, i) => id(5000 + i)) }, { p_organization_id: null }] as unknown as Call[]) {
      expect(await attempt(() => rpc({ p_organization_id: ORG_A, ...bad })), JSON.stringify(bad).slice(0, 60)).toMatchObject({ ok: false, code: '22023' });
    }
    // Đúng 200 ký tự vẫn tìm được (trần, không phải cắt); khoá nhãn hỏng không bị bỏ lọc trong im lặng.
    expect(await attempt(() => rpc({ p_organization_id: ORG_A, p_search: 'ă'.repeat(200) }))).toMatchObject({ ok: true, value: { total: 0 } });
    const broken = zaloConversationListArgs({ organizationId: ORG_A, filter: 'all', label: `${AC1}:x` });
    expect(await attempt(() => rpc({ ...broken, p_label_id: Number.isNaN(broken.p_label_id) ? undefined : broken.p_label_id })))
      .toMatchObject({ ok: false, code: '22023' });
  });
});

describe('ngữ nghĩa giữ nguyên của web', () => {
  it('thứ tự: ghim trước, tin mới nhất trước, chưa có tin cuối, trùng giờ theo id giảm dần; ghép trang bằng danh sách đầy đủ', async () => {
    await as(OWNER);
    const full = await rpc({ p_organization_id: ORG_A });
    const keys = full.rows.map(r => [r.is_pinned ? 1 : 0, r.last_message_at ? Date.parse(String(r.last_message_at)) : -Infinity, r.id] as const);
    for (let i = 1; i < keys.length; i += 1) {
      const [p0, t0, i0] = keys[i - 1];
      const [p1, t1, i1] = keys[i];
      expect(p0 > p1 || (p0 === p1 && (t0 > t1 || (t0 === t1 && i0 > i1))), String(i)).toBe(true);
    }
    const pages: string[] = [];
    for (let offset = 0; offset < full.total; offset += 7) pages.push(...ids(await rpc({ p_organization_id: ORG_A, p_limit: 7, p_offset: offset })));
    expect(pages).toEqual(ids(full));
    expect(await rpc({ p_organization_id: ORG_A, p_limit: 5, p_offset: 400 })).toEqual({ total: full.total, rows: [] });
  });

  it('ẩn hội thoại chưa có tin khi không tìm; tìm thì hiện; Danh bạ chỉ hội thoại chưa có tin; danh sách nền gồm cả hai', async () => {
    await as(OWNER);
    const noMessage = seeds.filter(s => s[1] === ORG_A && s[7] === null).map(s => Z(s[0]));
    expect(noMessage.length).toBeGreaterThan(5);
    const all = ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all' }));
    expect(all.some(row => noMessage.includes(row))).toBe(false);
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: 'danh bạ' }))).toEqual(expect.arrayContaining([Z(5), Z(6), Z(12)]));
    expect(new Set(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'contacts' })))).toEqual(new Set(noMessage));
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'contacts', p_search: 'nguyễn' }))).toEqual([]);
    const base = ids(await rpc({ p_organization_id: ORG_A }));
    expect(noMessage.every(row => base.includes(row)) && all.every(row => base.includes(row))).toBe(true);
    // Danh sách nền + từ khoá (Hermes): tìm cả danh bạ chưa có tin.
    expect(ids(await rpc({ p_organization_id: ORG_A, p_search: 'Danh bạ Hoa' }))).toEqual([Z(5)]);
  });

  it('gọi thẳng SQL (Hermes) với chuỗi thô: trim đúng tập khoảng trắng của String.prototype.trim', async () => {
    const spaces = [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239,
      8287, 12288, 65279].map(code => String.fromCharCode(code));
    await as(OWNER);
    const an = await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: 'an' });
    const none = await rpc({ p_organization_id: ORG_A, p_filter: 'all' });
    expect(an.total).toBeGreaterThan(0);
    for (const ws of spaces) {
      expect(`${ws}an${ws}`.trim(), String(ws.charCodeAt(0))).toBe('an');
      expect(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: `${ws}an${ws}` }), String(ws.charCodeAt(0))).toEqual(an);
      // Chỉ khoảng trắng = không tìm ⇒ vẫn ẩn hội thoại chưa có tin.
      expect(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: ws.repeat(3) }), String(ws.charCodeAt(0))).toEqual(none);
    }
  });

  it('tìm tên phòng trong profile (chuỗi), không theo dấu; profile.room không phải chuỗi thì bỏ qua thay vì ném như web cũ', async () => {
    await as(OWNER);
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: 'phòng a1' }))).toEqual([Z(3)]);
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: 'phong a1' }))).toEqual([]);
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: '100%' }))).toEqual([Z(7)]);
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: '%' }))).toEqual([Z(7)]);
    await db.exec('RESET ROLE');
    await db.exec(`UPDATE public.zalo_conversations SET profile = '{"room": 4242}' WHERE id = '${Z(4)}'`);
    await as(OWNER);
    expect(ids(await rpc({ p_organization_id: ORG_A, p_filter: 'all', p_search: '4242' }))).toEqual([]);
    const legacy = await webConversations(ORG_A);
    expect(() => webFilter(legacy, { filter: 'all', search: '4242', selIds: [AC1, AC2], accounts: [{ id: AC1 }, { id: AC2 }], selectedLabel: null })).toThrow(TypeError);
  });

  it('dòng trả đúng cột danh sách và profile thu gọn: không memberProfiles, không khoá lạ, không null', async () => {
    await as(OWNER);
    const rows = (await rpc({ p_organization_id: ORG_A })).rows;
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...CONV_FIELDS, 'profile'].sort());
      const profile = row.profile as Record<string, unknown>;
      expect(Object.keys(profile).every(key => (PROFILE_FIELDS as readonly string[]).includes(key))).toBe(true);
      expect(Object.values(profile).includes(null)).toBe(false);
    }
    expect(rows.find(r => r.id === Z(1))?.profile).toEqual({ kind: 'tenant', room: 'P101', debt: { amount: '1', overdue: '0', note: '' } });
    expect(rows.find(r => r.id === Z(7))?.profile).toEqual({});
    expect(rows.find(r => r.id === Z(9))?.profile).toEqual({ room: 'P-Hoa', tags: [{ l: 'T', t: 'info' }], stats: [{ label: 'a', value: 'b' }] });
  });
});
