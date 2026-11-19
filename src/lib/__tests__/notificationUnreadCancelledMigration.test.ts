import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boCommentSql } from './helpers/sqlTestUtils';
import { ID, MIGRATION, docMigration, maLoi, taoDbThongBao, voiNguoi, voiVai } from './fixtures/notificationPipelineDb';

/**
 * Migration 20261021171250_thong_bao_chua_doc_bo_cancelled_v1 (gói B mục B7): một định nghĩa "chưa đọc"
 * (status PENDING) cho chuông, Hermes notifications_inbox_v1 và Copilot feed; dòng CANCELLED (việc đã xong) ẩn.
 * Chạy THẬT trên PGlite (hai lượt), Hermes gọi dưới vai authenticated như production (hàm INVOKER).
 */
let db: PGlite;

beforeAll(async () => {
  db = await taoDbThongBao();
  await db.query("INSERT INTO test_permissions VALUES ($1, $2, null, 'notifications.view', true)", [ID.chu, ID.org]);
  for (const [status, tuoi] of [['PENDING', 1], ['PENDING', 2], ['READ', 3], ['CANCELLED', 4]] as const) {
    await db.query(`INSERT INTO public.notifications(user_id, organization_id, type, channel, status, content, created_at)
                    VALUES ($1, $2, 'CUSTOM', 'IN_APP', $3::public.notification_status, 'x', now() - make_interval(mins => $4::int))`,
      [ID.chu, ID.org, status, tuoi]);
  }
  // Dòng của công ty khác / người khác không bao giờ lẫn vào.
  await db.query(`INSERT INTO public.notifications(user_id, organization_id, type, channel, status, content)
                  VALUES ($1, $2, 'CUSTOM', 'IN_APP', 'PENDING', 'x'), ($3, $4, 'CUSTOM', 'IN_APP', 'PENDING', 'x')`,
    [ID.chu, ID.orgKhac, ID.nhanVien, ID.org]);
}, 60000);
afterAll(async () => {
  await db?.close();
});

describe('notification_is_unread_v1', () => {
  it('chỉ PENDING là chưa đọc', async () => {
    const r = await db.query<Record<string, boolean>>(`SELECT
      public.notification_is_unread_v1('PENDING') p, public.notification_is_unread_v1('READ') r,
      public.notification_is_unread_v1('CANCELLED') c, public.notification_is_unread_v1('SENT') s,
      public.notification_is_unread_v1(NULL) n`);
    expect(r.rows[0]).toEqual({ p: true, r: false, c: false, s: false, n: false });
  });
});

describe('Hermes notifications_inbox_v1', () => {
  type Dong = { status: string; total_count: number; unread_count: number };
  const inbox = (unreadOnly: boolean) => voiVai(db, 'authenticated', ID.chu, () =>
    db.query<Dong>('SELECT status, total_count::int, unread_count::int FROM public.notifications_inbox_v1($1, $2)', [ID.org, unreadOnly]));

  it('bỏ CANCELLED khỏi danh sách và cả hai số đếm; chưa đọc = PENDING', async () => {
    const all = (await inbox(false)).rows;
    expect(all.map((x) => x.status)).toEqual(['PENDING', 'PENDING', 'READ']);
    expect(all[0]).toMatchObject({ total_count: 3, unread_count: 2 });
    const unread = (await inbox(true)).rows;
    expect(unread.map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('giữ cổng: không phải authenticated ⇒ 42501; tham số sai ⇒ 22023; vẫn INVOKER + search_path rỗng', async () => {
    expect(await maLoi(voiNguoi(db, ID.chu, () => db.query('SELECT * FROM public.notifications_inbox_v1($1)', [ID.org])))).toBe('42501');
    expect(await maLoi(voiVai(db, 'authenticated', ID.chu, () => db.query('SELECT * FROM public.notifications_inbox_v1($1, false, null, 0)', [ID.org])))).toBe('22023');
    const p = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      "SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.notifications_inbox_v1(uuid,boolean,text,integer)'::regprocedure");
    expect(p.rows[0]).toEqual({ prosecdef: false, proconfig: ['search_path=""'] });
  });

  it('dòng đầu (chữ ký, kiểu trả về, INVOKER) y như bản Z 20261018080000 mà Hermes đang chép', () => {
    const head = (text: string) => {
      const start = text.lastIndexOf('CREATE OR REPLACE FUNCTION public.notifications_inbox_v1(');
      return text.slice(start, text.indexOf('AS $fn$', start)).replace(/\s+/g, ' ');
    };
    // Bản SỐNG (định nghĩa cuối) so với bản Z.
    const live = boCommentSql(docMigration('supabase/migrations/20261021171250_thong_bao_chua_doc_bo_cancelled_v1.sql'));
    expect(MIGRATION.unread).toBe('supabase/migrations/20261021171250_thong_bao_chua_doc_bo_cancelled_v1.sql');
    const z = boCommentSql(docMigration('supabase/migrations/20261018080000_hermes_w2z_shared_fixes_v1.sql'));
    expect(head(live)).toBe(head(z));
  });
});

describe('Copilot copilot_notification_feed_v1', () => {
  it('tong_chua_doc = PENDING, bỏ CANCELLED; unread_only chỉ PENDING', async () => {
    type Feed = { tong_chua_doc: number; so_luong: number; thong_bao: Array<{ trang_thai: string }> };
    const feed = async (unreadOnly: boolean) => (await voiNguoi(db, ID.chu, () =>
      db.query<{ v: Feed }>('SELECT public.copilot_notification_feed_v1($1, $2, 20) v', [ID.org, unreadOnly]))).rows[0].v;
    const all = await feed(false);
    expect(all.tong_chua_doc).toBe(2);
    expect(all.thong_bao.map((x) => x.trang_thai)).toEqual(['PENDING', 'PENDING', 'READ']);
    const unread = await feed(true);
    expect(unread.thong_bao.map((x) => x.trang_thai)).toEqual(['PENDING', 'PENDING']);
    expect(await maLoi(voiNguoi(db, ID.nhanVien, () => db.query('SELECT public.copilot_notification_feed_v1($1)', [ID.org])))).toBe('42501');
  });
});
