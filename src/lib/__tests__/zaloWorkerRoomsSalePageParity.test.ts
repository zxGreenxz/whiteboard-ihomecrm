import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Worker Zalo đọc đúng trang Sale Phòng (20261016102533). public.get_public_available_rooms là
// CỔNG giả lập theo token (trang thật không đổi trong migration này); test đo phần gộp: chủ nào
// được đọc, toà/phòng nào giữ lại, liên hệ/khu/số trang, và ACL.
const MIGRATION = 'supabase/migrations/20261016102533_zalo_worker_rooms_sale_page_parity_v1.sql';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), OTHER_ORG = id(2), OWNER_A = id(3), OWNER_B = id(4), OWNER_NO_LINK = id(5), OWNER_REVOKED = id(6);
const BA = id(11), BA_FULL = id(12), BA_FOREIGN = id(13), BB = id(14), BNOLINK = id(15), BREVOKED = id(16);
const AREA_1 = id(21), AREA_2 = id(22);

type Payload = { areas: { id: string }[]; buildings: { id: string; floor_layouts?: unknown }[]; rooms: { id: string; status_public: string; building_id: string }[];
  contact: { name: string } | null; sale_policy: string | null; pages: number };
const room = (rid: string, building: string, status: string) => ({ id: rid, building_id: building, status_public: status, floor: 1, name: rid });
const building = (bid: string, name: string) => ({ id: bid, name, floor_layouts: { big: true }, images: [] });

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA app_private;
    GRANT USAGE ON SCHEMA public TO authenticated,anon,service_role;
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,user_id uuid);
    CREATE TABLE public.public_room_share_tokens(token text PRIMARY KEY,owner_id uuid,organization_id uuid,revoked boolean DEFAULT false,created_at timestamptz DEFAULT now());
    CREATE TABLE public.fixture_pages(token text PRIMARY KEY,page jsonb);
    CREATE FUNCTION public.get_public_available_rooms(p_token text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT page FROM public.fixture_pages WHERE token=p_token $$;
    INSERT INTO public.buildings VALUES('${BA}','${ORG}','${OWNER_A}'),('${BA_FULL}','${ORG}','${OWNER_A}'),('${BA_FOREIGN}','${OTHER_ORG}','${OWNER_A}'),
      ('${BB}','${ORG}','${OWNER_B}'),('${BNOLINK}','${ORG}','${OWNER_NO_LINK}'),('${BREVOKED}','${ORG}','${OWNER_REVOKED}');
  `);
  const migration = readFileSync(MIGRATION, 'utf8');
  await db.exec(migration);
  await db.exec(migration);
}, 60_000);
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec('DELETE FROM public.public_room_share_tokens; DELETE FROM public.fixture_pages;');
  await db.query(`INSERT INTO public.public_room_share_tokens(token,owner_id,organization_id,revoked,created_at) VALUES
    ('a-new',$1,$5,false,now()),('a-old',$1,$5,false,now()-interval '1 day'),('b',$2,$5,false,now()),('revoked',$3,$5,true,now()),('foreign',$4,$6,false,now())`,
  [OWNER_A, OWNER_B, OWNER_REVOKED, OWNER_NO_LINK, ORG, OTHER_ORG]);
  const pages: Record<string, unknown> = {
    'a-old': { areas: [{ id: AREA_1, name: 'Khu 1' }], contact: { name: 'Chủ A', phone: '0901' }, sale_policy: 'Chính sách A',
      buildings: [building(BA, 'A1'), building(BA_FULL, 'A2'), building(BA_FOREIGN, 'A3')],
      rooms: [room('r-free', BA, 'free'), room('r-rented', BA, 'rented'), room('r-pass', BA, 'pass'), room('r-full', BA_FULL, 'rented'), room('r-foreign', BA_FOREIGN, 'free')] },
    'a-new': null,
    b: { areas: [{ id: AREA_1, name: 'Khu 1' }, { id: AREA_2, name: 'Khu 2' }], contact: { name: 'Chủ B', phone: '0902' }, sale_policy: 'Chính sách B',
      buildings: [building(BB, 'B1')], rooms: [room('r-soon', BB, 'soon')] },
    revoked: { areas: [], contact: null, sale_policy: null, buildings: [building(BREVOKED, 'R')], rooms: [room('r-revoked', BREVOKED, 'free')] },
    foreign: { areas: [], contact: null, sale_policy: null, buildings: [building(BNOLINK, 'N')], rooms: [room('r-nolink', BNOLINK, 'free')] },
  };
  for (const [token, page] of Object.entries(pages)) await db.query('INSERT INTO public.fixture_pages VALUES($1,$2::jsonb)', [token, page === null ? null : JSON.stringify(page)]);
});

async function read(org: string | null, role = 'service_role') {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role}`);
  try { return (await db.query<{ v: Payload }>('SELECT public.zalo_phong_trong_cho_worker_v1($1) v', [org])).rows[0].v; }
  finally { await db.exec('ROLLBACK'); }
}

describe('zalo_phong_trong_cho_worker_v1 = trang Sale Phòng', () => {
  it('chỉ đọc trang của chủ có link còn hiệu lực (một link/chủ), giữ toà thuộc công ty và phòng còn chào được', async () => {
    const p = await read(ORG);
    expect(p.pages).toBe(2);
    expect(p.rooms.map(r => r.id).sort()).toEqual(['r-free', 'r-pass', 'r-soon']);
    // Toà không link (chủ chỉ có link ở công ty khác), link bị thu hồi, toà công ty khác, toà hết phòng: không có.
    expect(p.buildings.map(b => b.id)).toEqual([BA, BB]);
    expect(p.buildings.every(b => b.floor_layouts === undefined)).toBe(true);
    expect(p.areas.map(a => a.id)).toEqual([AREA_1, AREA_2]);
    expect(p.contact).toMatchObject({ name: 'Chủ A' });
    expect(p.sale_policy).toBe('Chính sách A');
    expect(JSON.stringify(p)).not.toContain('a-old');
  });

  it('công ty chưa có link: rỗng với pages=0 (không phải hết phòng)', async () => {
    await db.exec('UPDATE public.public_room_share_tokens SET revoked=true');
    expect(await read(ORG)).toEqual({ areas: [], buildings: [], rooms: [], contact: null, sale_policy: null, pages: 0 });
    expect(await read(null)).toMatchObject({ rooms: [], pages: 0 });
  });

  it('trang không đọc được hoặc trùng toà thì dừng (55000), không gộp đoán', async () => {
    await db.exec("UPDATE public.fixture_pages SET page=NULL WHERE token='b'");
    await expect(read(ORG)).rejects.toMatchObject({ code: '55000' });
    await db.query("UPDATE public.fixture_pages SET page=(SELECT page FROM public.fixture_pages WHERE token='a-old') WHERE token='b'");
    await expect(read(ORG)).rejects.toMatchObject({ code: '55000' });
  });

  it('chỉ service_role gọi được', async () => {
    await expect(read(ORG, 'authenticated')).rejects.toMatchObject({ code: '42501' });
    await expect(read(ORG, 'anon')).rejects.toMatchObject({ code: '42501' });
  });
});
