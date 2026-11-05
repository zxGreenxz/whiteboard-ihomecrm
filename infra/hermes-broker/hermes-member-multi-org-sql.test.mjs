import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
import { fixture, id, USER, ORG, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';

// hermes_member_v1 sau 20261104231450: người thường ở nhiều công ty dùng được Hermes ở công ty mình đang là thành viên ACTIVE.
// Hai lớp bằng chứng trên PGlite (không chứng minh RLS production, MVCC đồng thời hay PostgREST):
//  1. Thân mới so với thân đang chạy (20261012061447) trên cùng ma trận trạng thái: người một công ty và super admin nhận ĐÚNG kết quả
//     cũ (giá trị lẫn SQLSTATE/câu báo) ⇒ 64 hàm gọi hermes_member_v1 không đổi hành vi với họ; chỉ người thường nhiều công ty khác.
//  2. Đầu-cuối trang "Bài học chờ duyệt" (thân thật của 20261031041523): quản trị viên thuộc hai công ty đọc/duyệt đúng công ty đang
//     chọn, không thấy và không ghi được đề xuất của công ty kia; lỗi quyền và lỗi thành viên mang câu báo khác nhau.
const directory = new URL('../../supabase/migrations/', import.meta.url);
const find = pattern => readdirSync(directory).find(name => pattern.test(name));
// HERMES_MEMBER_SQL: chỉ để chạy kiểm đột biến trên bản sao đã sửa của migration.
const memberSql = readFileSync(process.env.HERMES_MEMBER_SQL ?? new URL(find(/_hermes_member_nhieu_cong_ty_v1\.sql$/), directory), 'utf8');
const foundation = readFileSync(new URL('20261012061447_hermes_assistant_identity_policy_v1.sql', directory), 'utf8');
const learningSql = readFileSync(new URL(find(/_hermes_learning_proposals_v1\.sql$/), directory), 'utf8');
const definition = sql => splitSqlStatements(sql).map(s => s.replace(/--[^\n]*/g, '').trim())
  .find(s => /^CREATE OR REPLACE FUNCTION app_private\.hermes_member_v1\(/i.test(s));
const OLD = definition(foundation), NEW = definition(memberSql);
const code = (expected, message) => error => {
  assert.equal(error.code, expected, error.message);
  if (message) assert.match(error.message, message);
  return true;
};
const BASE = `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
  CREATE SCHEMA app_private;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text,authorization_version bigint DEFAULT 1);
  CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,revoked_at timestamptz,
    valid_from timestamptz,valid_to timestamptz);
  CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);`;

test('thân mới so với thân đang chạy: người một công ty và super admin y hệt; người thường nhiều công ty được nhận đúng công ty', async t => {
  assert(OLD && NEW, 'đọc được hai định nghĩa hermes_member_v1');
  assert.match(OLD, /hermes_ordinary_org_ambiguous/, 'thân cũ còn luật một công ty');
  const db = new PGlite(); t.after(() => db.close());
  const [A, B, C, U1, U2, SA, M1, M2A, M2B, MSA_A, MSA_B, DUP] = Array.from({ length: 12 }, (_, n) => id((n + 1).toString(16)));
  await db.exec(BASE);
  await db.exec(`INSERT INTO public.organizations VALUES('${A}','ACTIVE',7),('${B}','ACTIVE',3),('${C}','ACTIVE',1);`);
  await db.exec(OLD.replace('app_private.hermes_member_v1(', 'app_private.hermes_member_cu('));
  await db.exec(OLD);
  // Migration thật, hai lượt: lượt một ghim md5 thân đang chạy, lượt hai chấp nhận thân mới.
  await db.exec(memberSql); await db.exec(memberSql);
  const meta = (await db.query(`SELECT prosecdef,provolatile,proconfig,proacl::text acl,pg_get_userbyid(proowner) owner
    FROM pg_proc WHERE oid='app_private.hermes_member_v1(uuid,uuid)'::regprocedure`)).rows[0];
  assert.deepEqual(meta, { prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, public, app_private'],
    acl: '{postgres=X/postgres}', owner: 'postgres' });
  const outcome = async (fn, user, org) => {
    await db.exec('SAVEPOINT c');
    try { return { ok: (await db.query(`SELECT app_private.${fn}($1,$2) v`, [user, org])).rows[0].v }; }
    catch (error) { return { code: error.code, message: error.message }; }
    finally { await db.exec('ROLLBACK TO SAVEPOINT c; RELEASE SAVEPOINT c'); }
  };
  const both = async (user, org) => ({ cu: await outcome('hermes_member_cu', user, org), moi: await outcome('hermes_member_v1', user, org) });
  const scenarios = [
    ['thành viên ACTIVE', ''],
    ['bị tạm dừng', `UPDATE public.organization_memberships SET status='SUSPENDED' WHERE id='${M1}'`],
    ['đã thu hồi', `UPDATE public.organization_memberships SET revoked_at=clock_timestamp() WHERE id='${M1}'`],
    ['hết hạn', `UPDATE public.organization_memberships SET valid_to=clock_timestamp()-interval '1 second' WHERE id='${M1}'`],
    ['chưa tới hạn', `UPDATE public.organization_memberships SET valid_from=clock_timestamp()+interval '1 hour' WHERE id='${M1}'`],
    ['công ty ngừng', `UPDATE public.organizations SET status='INACTIVE' WHERE id='${A}'`],
    ['hai dòng ACTIVE cùng công ty', `INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${DUP}','${U1}','${A}','ACTIVE')`],
    ['thêm membership đã thu hồi ở công ty khác', `INSERT INTO public.organization_memberships(id,user_id,organization_id,status,revoked_at)
      VALUES('${DUP}','${U1}','${B}','ACTIVE',clock_timestamp())`],
  ];
  await db.exec(`INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES
    ('${M1}','${U1}','${A}','ACTIVE'),('${M2A}','${U2}','${A}','ACTIVE'),('${M2B}','${U2}','${B}','ACTIVE'),
    ('${MSA_A}','${SA}','${A}','ACTIVE'),('${MSA_B}','${SA}','${B}','ACTIVE');
    INSERT INTO public.super_admins VALUES('${SA}');`);
  for (const [label, sql] of scenarios) {
    await t.test(`một công ty — ${label}: thân mới y hệt thân cũ`, async () => {
      await db.exec('BEGIN'); try {
        if (sql) await db.exec(sql);
        for (const [user, org] of [[U1, A], [U1, B], [U1, C], [null, A], [U1, null], [SA, A], [SA, B], [SA, C]]) {
          const { cu, moi } = await both(user, org);
          assert.deepEqual(moi, cu, `${label}: ${user === SA ? 'super admin' : 'người một công ty'} → ${org === A ? 'A' : org === B ? 'B' : org ?? 'NULL'}`);
        }
      } finally { await db.exec('ROLLBACK'); }
    });
  }
  await t.test('người thường thuộc hai công ty: thân cũ chặn sai, thân mới nhận đúng membership và phiên bản của công ty được hỏi', async () => {
    await db.exec('BEGIN'); try {
      const a = await both(U2, A), b = await both(U2, B), c = await both(U2, C);
      assert.deepEqual(a.cu, { code: '42501', message: 'hermes_ordinary_org_ambiguous' });
      assert.deepEqual(a.moi.ok, { membershipId: M2A, authorizationVersion: 7, isSuperadmin: false });
      assert.deepEqual(b.moi.ok, { membershipId: M2B, authorizationVersion: 3, isSuperadmin: false });
      assert.deepEqual(c.moi, { code: '42501', message: 'hermes_membership_required' }, 'không là thành viên công ty C ⇒ vẫn từ chối');
      await db.exec(`UPDATE public.organization_memberships SET status='SUSPENDED' WHERE id='${M2B}'`);
      assert.deepEqual((await both(U2, B)).moi, { code: '42501', message: 'hermes_membership_required' }, 'membership công ty B ngừng ⇒ B bị từ chối');
      assert.deepEqual((await both(U2, A)).moi.ok.membershipId, M2A, 'A vẫn dùng được');
    } finally { await db.exec('ROLLBACK'); }
  });
});

test('migration ghim thân đang chạy: thân lạ thì dừng, không ghi đè bản vá của người khác', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(BASE);
  await assert.rejects(db.exec(memberSql), code('P0001', /hermes_member_v1_body_drift: missing/));
  await db.exec('ROLLBACK');
  await db.exec(OLD.replace("RAISE EXCEPTION 'hermes_ordinary_org_ambiguous'", "RAISE EXCEPTION 'hermes_ordinary_org_ambiguous_khac'"));
  await assert.rejects(db.exec(memberSql), code('P0001', /hermes_member_v1_body_drift: [0-9a-f]{32}/));
  await db.exec('ROLLBACK');
  assert.match((await db.query("SELECT prosrc FROM pg_proc WHERE proname='hermes_member_v1'")).rows[0].prosrc, /_khac/, 'thân lạ giữ nguyên');
});

// Cùng khung với learning-proposals-sql.test.mjs: nền danh tính/thành viên thật của Hermes (fixture), cổng quyền CRM giả (users.edit).
const ADMIN = id('e'), MEMBER = id('f'), OUTSIDER = id('0'), OUTSIDER_ASSISTANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
// Membership thứ hai (công ty kia) của quản trị viên, thành viên thường và chủ trợ lý.
const ADMIN_FOREIGN = '1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a', MEMBER_FOREIGN = '1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b';
const USER_FOREIGN = '1c1c1c1c-1c1c-41c1-81c1-1c1c1c1c1c1c';
const isoAgo = ms => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const proposal = n => ({ dedupeKey: n.toString(16).padStart(64, '0'), kind: 'skill_crm_write', title: `Đề xuất ${n}`, content: `Nội dung ${n}`,
  source: { type: 'curator_ledger', ledgerId: `ledger${n}` }, detectedAt: isoAgo(3_600_000) });

test('Bài học chờ duyệt: quản trị viên thuộc hai công ty đọc/duyệt đúng công ty đang chọn, không lẫn công ty kia', async t => {
  const { db } = await fixture(t);
  await db.exec(`
    CREATE TABLE public.fixture_offboarded(user_id uuid PRIMARY KEY);
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql AS
      $$SELECT EXISTS(SELECT 1 FROM public.fixture_offboarded WHERE user_id=auth.uid())$$;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, full_name text NOT NULL);
    CREATE TABLE public.fixture_perm(user_id uuid, organization_id uuid, permission text);
    CREATE FUNCTION app_private.require_perm_v1(p_org uuid, p_key text, p_viec text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM public.fixture_perm WHERE user_id=auth.uid() AND organization_id=p_org AND permission=p_key)
        THEN RAISE EXCEPTION 'Bạn không có quyền %.', p_viec USING ERRCODE='42501'; END IF;
    END $$;
    INSERT INTO auth.users VALUES('${ADMIN}'),('${MEMBER}'),('${OUTSIDER}');
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES
      ('${ADMIN}','${ADMIN}','${ORG}','ACTIVE'),('${ADMIN_FOREIGN}','${ADMIN}','${FOREIGN}','ACTIVE'),
      ('${MEMBER}','${MEMBER}','${ORG}','ACTIVE'),('${MEMBER_FOREIGN}','${MEMBER}','${FOREIGN}','ACTIVE'),
      ('${OUTSIDER}','${OUTSIDER}','${FOREIGN}','ACTIVE'),('${USER_FOREIGN}','${USER}','${FOREIGN}','ACTIVE');
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${OUTSIDER_ASSISTANT}','${FOREIGN}','${OUTSIDER}');
    INSERT INTO public.profiles VALUES('${USER}','Chủ trợ lý'),('${ADMIN}','Quản trị viên'),('${OUTSIDER}','Người công ty kia');
    INSERT INTO public.fixture_perm VALUES('${ADMIN}','${ORG}','users.edit'),('${ADMIN}','${FOREIGN}','users.edit'),
      ('${MEMBER}','${ORG}','users.view');`);
  await db.exec(learningSql); await db.exec(learningSql);
  async function as(role, actor, query, params) {
    await db.exec('BEGIN');
    try {
      await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)", [role, actor ?? '']);
      await db.exec(`SET LOCAL ROLE ${role}`);
      const result = (await db.query(query, params)).rows[0].result;
      await db.exec('COMMIT'); return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  const ingest = payload => as('hermes_learning_ingest', null, 'SELECT app_private.hermes_store_learning_ingest_v1($1::jsonb) result', [JSON.stringify(payload)]);
  const review = (actor, organizationId) => as('authenticated', actor, 'SELECT public.hermes_learning_review_v1($1::jsonb) result',
    [JSON.stringify({ organizationId, historyCursor: null, pendingAfterSeq: null })]);
  const decide = (actor, organizationId, proposalIds) => as('authenticated', actor, 'SELECT public.hermes_learning_decide_v1($1::jsonb) result',
    [JSON.stringify({ organizationId, requestId: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', proposalIds, decision: 'approve', note: null })]);
  const batch = (organizationId, userId, profile, proposals) => ({ organizationId, userId, profile, auditGeneratedAt: isoAgo(60_000), proposals });

  // Thân đang chạy: chủ trợ lý thuộc hai công ty không nạp được, quản trị viên thuộc hai công ty bị báo sai ngữ cảnh.
  await assert.rejects(ingest(batch(ORG, USER, 'owner', [proposal(1)])), code('42501', /hermes_ordinary_org_ambiguous/));
  await assert.rejects(review(ADMIN, ORG), code('42501', /hermes_ordinary_org_ambiguous/));

  await db.exec(memberSql); await db.exec(memberSql);
  let mine, theirs;
  await t.test('nạp theo đúng công ty của trợ lý; người thuộc hai công ty không nạp được vào công ty không có trợ lý của họ', async () => {
    mine = (await ingest(batch(ORG, USER, 'owner', [proposal(1), proposal(2)]))).inserted.map(item => item.id);
    theirs = (await ingest(batch(FOREIGN, OUTSIDER, 'tkt', [proposal(1)]))).inserted.map(item => item.id);
    assert.equal(mine.length, 2); assert.equal(theirs.length, 1);
    await assert.rejects(ingest(batch(FOREIGN, USER, 'owner', [proposal(3)])), code('42501', /hermes_learning_denied/), 'USER không có trợ lý ở công ty kia');
  });
  await t.test('đọc: mỗi công ty chỉ thấy đề xuất của chính nó', async () => {
    const org = await review(ADMIN, ORG), foreign = await review(ADMIN, FOREIGN);
    assert.equal(org.organizationId, ORG); assert.equal(foreign.organizationId, FOREIGN);
    assert.deepEqual(org.pending.map(item => item.id).sort(), [...mine].sort());
    assert.deepEqual(foreign.pending.map(item => item.id), theirs);
    assert(org.pending.every(item => item.userId === USER) && foreign.pending.every(item => item.userId === OUTSIDER));
  });
  await t.test('ghi: không duyệt được đề xuất của công ty này bằng công ty kia', async () => {
    await assert.rejects(decide(ADMIN, FOREIGN, [mine[0]]), code('22023', /hermes_learning_not_found/));
    const done = await decide(ADMIN, ORG, [mine[0]]);
    assert.deepEqual(done.proposals.map(item => [item.id, item.status]), [[mine[0], 'approved']]);
    assert.equal((await db.query("SELECT count(*)::int n FROM app_private.hermes_learning_proposals WHERE status<>'pending'")).rows[0].n, 1);
  });
  await t.test('lỗi quyền và lỗi thành viên khác câu báo (để trang web nói đúng ngữ cảnh)', async () => {
    await assert.rejects(review(MEMBER, ORG), code('42501', /Bạn không có quyền/), 'thiếu users.edit là lỗi quyền');
    await db.exec(`UPDATE public.organization_memberships SET status='REVOKED',revoked_at=clock_timestamp() WHERE id='${ADMIN_FOREIGN}'`);
    await assert.rejects(review(ADMIN, FOREIGN), code('42501', /hermes_membership_required/), 'có quyền nhưng không còn là thành viên');
    assert.equal((await review(ADMIN, ORG)).organizationId, ORG, 'công ty còn là thành viên vẫn dùng được');
  });
});
