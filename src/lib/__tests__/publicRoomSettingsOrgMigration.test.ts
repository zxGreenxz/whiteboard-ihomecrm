import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// public_room_settings luôn có organization_id (20261010141134): chủ 2 tổ chức vẫn lưu được (upsert),
// chủ không suy được tổ chức thì 23502, dòng thiếu org có sẵn được điền rồi chốt NOT NULL.
const sql = readFileSync('supabase/migrations/20261010141134_public_room_settings_dien_to_chuc.sql', 'utf8');
// Nối tiếp: bỏ NOT NULL (generated types bắt client gửi org); trigger là bảo đảm duy nhất.
const dropNotNullSql = readFileSync('supabase/migrations/20261010142330_public_room_settings_bo_not_null_to_chuc.sql', 'utf8');
const orgA = '00000000-0000-4000-8000-00000000000a';
const orgB = '00000000-0000-4000-8000-00000000000b';
const multi = '00000000-0000-4000-8000-000000000001'; // 2 tổ chức, toà ở cả A và B, đã có dòng cài đặt (A)
const legacy = '00000000-0000-4000-8000-000000000002'; // 1 tổ chức, dòng cài đặt thiếu org (dữ liệu thật 10/10)
const fresh = '00000000-0000-4000-8000-000000000003'; // 2 tổ chức, toà ở B, chưa có dòng cài đặt
const lonely = '00000000-0000-4000-8000-000000000004'; // 2 tổ chức, không toà ⇒ không suy được
const moved = '00000000-0000-4000-8000-000000000005'; // toà còn ở B nhưng chỉ còn là thành viên A
const db = new PGlite();

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${multi}'),('${legacy}'),('${fresh}'),('${lonely}'),('${moved}');
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);INSERT INTO public.organizations VALUES('${orgA}'),('${orgB}');
    CREATE TABLE public.organization_memberships(user_id uuid,organization_id uuid,status text);
    INSERT INTO public.organization_memberships VALUES('${multi}','${orgA}','ACTIVE'),('${multi}','${orgB}','ACTIVE'),
      ('${legacy}','${orgA}','ACTIVE'),('${fresh}','${orgA}','ACTIVE'),('${fresh}','${orgB}','ACTIVE'),('${lonely}','${orgA}','ACTIVE'),('${lonely}','${orgB}','ACTIVE'),('${moved}','${orgA}','ACTIVE'),('${moved}','${orgB}','LEFT');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,deleted_at timestamptz);
    INSERT INTO public.buildings(organization_id,user_id) VALUES('${orgA}','${multi}'),('${orgB}','${multi}'),('${orgA}','${legacy}'),('${orgB}','${fresh}'),('${orgB}','${moved}');
    CREATE TABLE public.public_room_settings(owner_id uuid PRIMARY KEY REFERENCES auth.users(id),soon_days integer NOT NULL DEFAULT 30,
      show_rented boolean NOT NULL DEFAULT false,hotline_id uuid,updated_at timestamptz NOT NULL DEFAULT now(),
      organization_id uuid REFERENCES public.organizations(id),sale_policy text);
    INSERT INTO public.public_room_settings(owner_id,soon_days,organization_id) VALUES('${multi}',16,'${orgA}');
    INSERT INTO public.public_room_settings(owner_id,sale_policy) VALUES('${legacy}','Chính sách');
  `);
  await db.exec(sql);
  await db.exec(dropNotNullSql);
  await db.exec(sql);
  await db.exec(dropNotNullSql);
}, 20000);
afterAll(async () => { await db.close(); });

async function orgOf(owner: string) {
  return (await db.query<{ o: string | null }>('SELECT organization_id o FROM public.public_room_settings WHERE owner_id=$1', [owner])).rows[0]?.o;
}
const upsert = (owner: string, policy: string) => db.query(
  `INSERT INTO public.public_room_settings(owner_id,soon_days,show_rented,hotline_id,sale_policy,updated_at)
   VALUES($1,30,false,NULL,$2,now()) ON CONFLICT(owner_id) DO UPDATE SET sale_policy=EXCLUDED.sale_policy,updated_at=EXCLUDED.updated_at`, [owner, policy]);

describe('public_room_settings luôn có tổ chức', () => {
  it('backfills the legacy NULL row; the column stays nullable for client types but a row cannot be nulled', async () => {
    expect(await orgOf(legacy)).toBe(orgA);
    const nullable = (await db.query<{ n: string }>("SELECT is_nullable n FROM information_schema.columns WHERE table_name='public_room_settings' AND column_name='organization_id'")).rows[0].n;
    expect(nullable).toBe('YES');
    await db.query('UPDATE public.public_room_settings SET organization_id=NULL WHERE owner_id=$1', [legacy]);
    expect(await orgOf(legacy)).toBe(orgA);
  });
  it('an owner in two organizations keeps saving: upsert reuses the existing row organization', async () => {
    await upsert(multi, 'Chính sách mới');
    expect(await orgOf(multi)).toBe(orgA);
  });
  it('a new row takes the single organization of the owner buildings, even with two memberships', async () => {
    await upsert(fresh, 'Lần đầu');
    expect(await orgOf(fresh)).toBe(orgB);
  });
  it('fails closed when nothing identifies one organization, and keeps an explicit value', async () => {
    await expect(upsert(lonely, 'Không đoán')).rejects.toMatchObject({ code: '23502' });
    await db.query('INSERT INTO public.public_room_settings(owner_id,organization_id) VALUES($1,$2)', [lonely, orgB]);
    expect(await orgOf(lonely)).toBe(orgB);
  });
  it('never picks a building organization the owner is no longer an active member of', async () => {
    await upsert(moved, 'Đã rời B');
    expect(await orgOf(moved)).toBe(orgA);
  });
  it('helpers stay private', async () => {
    const r = (await db.query<{ a: boolean }>("SELECT has_function_privilege('authenticated','app_private.public_room_settings_org_v1(uuid)','EXECUTE') a")).rows[0].a;
    expect(r).toBe(false);
  });
});
