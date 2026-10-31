import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fixture, id, USER, ORG, ASSISTANT, FOREIGN } from '../hermes-zalo-router/private-command-fixture.mjs';

// Kho đề xuất bài học Hermes trên PGlite: nền danh tính/thành viên thật của Hermes, cổng quyền CRM giả (users.edit),
// một instance cho cả file. Không chứng minh RLS production, MVCC đồng thời hay PostgREST.
const directory = new URL('../../supabase/migrations/', import.meta.url);
const filename = readdirSync(directory).find(name => /_hermes_learning_proposals_v1\.sql$/.test(name));
// HERMES_LEARNING_SQL: chỉ để chạy kiểm đột biến trên bản sao đã sửa của migration.
const sql = readFileSync(process.env.HERMES_LEARNING_SQL ?? new URL(filename, directory), 'utf8');
const ADMIN = id('e'), MEMBER = id('f'), OUTSIDER = id('0'), OUTSIDER_ASSISTANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const LEFT = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
// Mốc tương đối (không ghim ngày): cửa sổ hợp lệ của detectedAt là [now - 400 ngày, now + 1 ngày].
const isoAgo = ms => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const key = n => n.toString(16).padStart(64, '0');
const proposal = (n, extra = {}) => ({ dedupeKey: key(n), kind: 'skill_crm_write', title: `Đề xuất ${n}`,
  content: `Skill crm-task-management: gọi crm_action_run task.create (${n}).\nDòng hai.`,
  source: { type: 'curator_ledger', ledgerId: `ledger${n}`, sessionId: 'synthetic' }, detectedAt: isoAgo(3_600_000), ...extra });
const batch = (proposals, extra = {}) => ({ organizationId: ORG, userId: USER, profile: 'owner', auditGeneratedAt: isoAgo(600_000), proposals, ...extra });

async function setup(t) {
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
    INSERT INTO auth.users VALUES('${ADMIN}'),('${MEMBER}'),('${OUTSIDER}'),('${LEFT}');
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status)
      VALUES('${ADMIN}','${ADMIN}','${ORG}','ACTIVE'),('${MEMBER}','${MEMBER}','${ORG}','ACTIVE'),('${OUTSIDER}','${OUTSIDER}','${FOREIGN}','ACTIVE'),
        ('${LEFT}','${LEFT}','${ORG}','ACTIVE');
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${OUTSIDER_ASSISTANT}','${FOREIGN}','${OUTSIDER}');
    INSERT INTO public.profiles VALUES('${USER}','Chủ trợ lý'),('${ADMIN}','Quản trị viên');
    INSERT INTO public.fixture_perm VALUES('${ADMIN}','${ORG}','users.edit'),('${MEMBER}','${ORG}','users.view'),('${ADMIN}','${FOREIGN}','users.edit'),
      ('${LEFT}','${ORG}','users.edit');
    INSERT INTO public.fixture_offboarded VALUES('${LEFT}');`);
  // Chạy hai lần: migration phải idempotent.
  await db.exec(sql); await db.exec(sql);
  async function as(role, actor, query, params) {
    await db.exec('BEGIN');
    try {
      await db.query("SELECT set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)", [role, actor ?? '']);
      await db.exec(`SET LOCAL ROLE ${role}`);
      const result = (await db.query(query, params)).rows[0].result;
      await db.exec('COMMIT'); return result;
    } catch (error) { await db.exec('ROLLBACK'); throw error; } finally { await db.exec('RESET ROLE'); }
  }
  const ingestAs = (role, payload) => as(role, null, 'SELECT app_private.hermes_store_learning_ingest_v1($1::jsonb) result', [JSON.stringify(payload)]);
  const ingest = payload => ingestAs('hermes_learning_ingest', payload);
  const review = (actor, historyCursor = null, organizationId = ORG, pendingAfterSeq = null) => as('authenticated', actor,
    'SELECT public.hermes_learning_review_v1($1::jsonb) result', [JSON.stringify({ organizationId, historyCursor, pendingAfterSeq })]);
  const decide = (actor, payload) => as('authenticated', actor, 'SELECT public.hermes_learning_decide_v1($1::jsonb) result',
    [JSON.stringify({ organizationId: ORG, note: null, ...payload })]);
  return { db, as, ingest, ingestAs, review, decide };
}

const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };

test('Kho đề xuất bài học Hermes: nạp từ job host, chủ/admin đọc và duyệt một lần', async t => {
  const { db, as, ingest, ingestAs, review, decide } = await setup(t);
  let first, second;

  await t.test('bảng và hàm không mở cho vai khác ngoài đúng cổng; vai nạp riêng, không đăng nhập', async () => {
    const privileges = (await db.query(`SELECT
      has_table_privilege('authenticated','app_private.hermes_learning_proposals','SELECT') a_read,
      has_table_privilege('hermes_learning_ingest','app_private.hermes_learning_proposals','INSERT') i_insert,
      has_table_privilege('authenticated','app_private.hermes_learning_audit_runs','SELECT') a_runs,
      has_function_privilege('authenticated','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE') a_ingest,
      has_function_privilege('service_role','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE') w_ingest,
      has_function_privilege('hermes_store_executor','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE') s_ingest,
      has_function_privilege('hermes_learning_ingest','app_private.hermes_store_learning_ingest_v1(jsonb)','EXECUTE') i_ingest,
      has_function_privilege('hermes_learning_ingest','public.hermes_learning_decide_v1(jsonb)','EXECUTE') i_decide,
      has_function_privilege('hermes_store_executor','public.hermes_learning_decide_v1(jsonb)','EXECUTE') s_decide,
      has_function_privilege('anon','public.hermes_learning_review_v1(jsonb)','EXECUTE') anon_review,
      has_function_privilege('authenticated','app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)','EXECUTE') a_apply,
      has_function_privilege('authenticated','public.hermes_learning_review_v1(jsonb)','EXECUTE') a_review,
      (SELECT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit FROM pg_roles WHERE rolname='hermes_learning_ingest') role_wide,
      (SELECT relrowsecurity FROM pg_class WHERE oid='app_private.hermes_learning_proposals'::regclass) rls`)).rows[0];
    assert.deepEqual(privileges, { a_read: false, i_insert: false, a_runs: false, a_ingest: false, w_ingest: false, s_ingest: false,
      i_ingest: true, i_decide: false, s_decide: false, anon_review: false, a_apply: false, a_review: true, role_wide: false, rls: true });
    await assert.rejects(as('authenticated', ADMIN, 'SELECT app_private.hermes_store_learning_ingest_v1($1::jsonb) result',
      [JSON.stringify(batch([proposal(1)]))]), code('42501'));
    await assert.rejects(ingestAs('hermes_store_executor', batch([proposal(1)])), code('42501')); // kho bền connector không còn quyền nạp
  });

  await t.test('nạp đánh số theo công ty, trùng khoá thì bỏ qua, ghi lần kiểm cuối kể cả lô rỗng', async () => {
    const empty = await ingest(batch([], { auditGeneratedAt: isoAgo(7_200_000) }));
    assert.deepEqual(empty, { organizationId: ORG, inserted: [], duplicates: 0, rejectedDuplicates: [] });
    const result = await ingest(batch([proposal(1), proposal(2, { kind: 'memory_crm_write' })]));
    assert.deepEqual(result.inserted.map(item => item.seq), [1, 2]);
    assert.equal(result.duplicates, 0);
    [first, second] = result.inserted.map(item => item.id);
    const again = await ingest(batch([proposal(1), proposal(2), proposal(3)]));
    assert.deepEqual(again.inserted.map(item => item.seq), [3]);
    assert.equal(again.duplicates, 2);
    const row = (await db.query('SELECT assistant_id,user_id,profile,status FROM app_private.hermes_learning_proposals WHERE id=$1', [first])).rows[0];
    assert.deepEqual(row, { assistant_id: ASSISTANT, user_id: USER, profile: 'owner', status: 'pending' });
    // Lần kiểm cũ hơn gửi muộn không kéo lùi mốc.
    await ingest(batch([], { auditGeneratedAt: isoAgo(86_400_000) }));
    const runs = (await db.query("SELECT count(*)::int n, max(audit_generated_at) > clock_timestamp()-interval '1 hour' recent FROM app_private.hermes_learning_audit_runs")).rows[0];
    assert.deepEqual(runs, { n: 1, recent: true });
  });

  await t.test('nạp từ chối đầu vào lệch khuôn', async () => {
    for (const bad of [
      batch([proposal(9, { dedupeKey: 'abc' })]), batch([proposal(9, { kind: 'preference' })]),
      batch([{ ...proposal(9), extra: true }]), batch([proposal(9, { detectedAt: '2026-10-31 01:30:00' })]),
      batch([proposal(9, { detectedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() })]),
      batch(Array.from({ length: 26 }, (_, n) => proposal(100 + n))),
      batch([proposal(9)], { profile: 'Owner Profile' }), { ...batch([proposal(9)]), extra: 1 },
      batch([proposal(9)], { auditGeneratedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
      batch([proposal(9)], { auditGeneratedAt: 'hôm nay' }),
    ]) await assert.rejects(ingest(bad), code('22023'), JSON.stringify(bad).slice(0, 120));
    await assert.rejects(ingest(batch([proposal(9, { title: 'x'.repeat(201) })])), code('23514'));
    await assert.rejects(ingest(batch([proposal(9, { content: 'a\u0001b' })])), code('23514'));
    // Chỉ khoảng trắng (kể cả xuống dòng/tab mà btrim không cắt) ⇒ không thành dòng bất biến không đọc được.
    await assert.rejects(ingest(batch([proposal(9, { content: '\n\n\t' })])), code('23514'));
    await assert.rejects(ingest(batch([proposal(9, { title: ' \t ' })])), code('23514'));
    // NUL trong jsonb bị PostgreSQL từ chối ngay lúc phân tích ⇒ cả lời gọi hỏng: bộ nạp phải tự tách mục xấu.
    await assert.rejects(ingest(batch([proposal(9, { source: { skill: 'abc\u0000' } })])), code('22P05'));
  });

  await t.test('nạp chỉ cho thành viên đang hoạt động có trợ lý ACTIVE của đúng công ty', async () => {
    await assert.rejects(ingest(batch([proposal(10)], { organizationId: FOREIGN })), code('42501'));
    await assert.rejects(ingest(batch([proposal(10)], { userId: MEMBER })), code('42501')); // thành viên chưa có trợ lý
    await db.exec(`UPDATE app_private.hermes_assistants SET state='DISABLED' WHERE id='${ASSISTANT}'`);
    await assert.rejects(ingest(batch([proposal(10)])), code('42501'));
    await db.exec(`UPDATE app_private.hermes_assistants SET state='ACTIVE' WHERE id='${ASSISTANT}'`);
    // Trợ lý còn ACTIVE nhưng tư cách thành viên đã thu hồi ⇒ vẫn từ chối.
    await db.exec(`UPDATE public.organization_memberships SET status='REVOKED',revoked_at=clock_timestamp() WHERE id='${USER}'`);
    await assert.rejects(ingest(batch([proposal(10)])), code('42501'));
    await db.exec(`UPDATE public.organization_memberships SET status='ACTIVE',revoked_at=NULL WHERE id='${USER}'`);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_learning_proposals')).rows[0].n, 3);
  });

  await t.test('công ty khác có dãy số riêng và không lọt sang người duyệt của công ty này', async () => {
    const foreign = await ingest({ organizationId: FOREIGN, userId: OUTSIDER, profile: 'tkt', auditGeneratedAt: isoAgo(60_000), proposals: [proposal(1)] });
    assert.deepEqual(foreign.inserted.map(item => item.seq), [1]); // cùng dedupeKey với công ty kia vẫn là đề xuất riêng
    const foreignId = foreign.inserted[0].id;
    const view = await review(ADMIN);
    assert.equal(view.pending.some(item => item.id === foreignId), false);
    assert.equal(view.audits.some(item => item.profile === 'tkt'), false);
    await assert.rejects(decide(ADMIN, { requestId: id('9'), proposalIds: [foreignId], decision: 'approve' }), code('22023'));
    assert.equal((await db.query('SELECT status FROM app_private.hermes_learning_proposals WHERE id=$1', [foreignId])).rows[0].status, 'pending');
  });

  await t.test('đọc: chỉ người giữ users.edit của đúng công ty, chưa nghỉ việc', async () => {
    await assert.rejects(review(MEMBER), code('42501'));
    await assert.rejects(review(null), code('42501'));
    await assert.rejects(review(LEFT), code('42501')); // có users.edit nhưng đã nghỉ việc
    await assert.rejects(decide(LEFT, { requestId: id('8'), proposalIds: [first], decision: 'approve' }), code('42501'));
    await assert.rejects(review(ADMIN, null, FOREIGN), code('42501')); // có khoá ở công ty kia nhưng không là thành viên
    await assert.rejects(as('anon', ADMIN, 'SELECT public.hermes_learning_review_v1($1::jsonb) result',
      [JSON.stringify({ organizationId: ORG, historyCursor: null, pendingAfterSeq: null })]), code('42501'));
    const view = await review(ADMIN);
    assert.equal(view.canDecide, true);
    assert.equal(view.pendingCount, 3);
    assert.deepEqual(view.pending.map(item => item.seq), [1, 2, 3]);
    assert.equal(view.nextPendingAfterSeq, null);
    assert.equal(view.pending[0].userName, 'Chủ trợ lý');
    assert.equal(view.pending[0].content.includes('\n'), true);
    assert.equal(view.pending[0].redactedAt, null);
    assert.deepEqual(view.history, []);
    assert.equal(view.nextHistoryCursor, null);
    assert.deepEqual(view.audits.map(item => [item.profile, item.userName]), [['owner', 'Chủ trợ lý']]);
    assert.match(view.audits[0].generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    await assert.rejects(review(ADMIN, { decidedAt: 'hôm qua', id: first }), code('22023'));
    await assert.rejects(review(ADMIN, null, ORG, 0), code('22023'));
  });

  await t.test('duyệt một lần, lặp lại cùng requestId trả kết quả cũ, đổi nội dung là xung đột', async () => {
    const requestId = id('a');
    const approved = await decide(ADMIN, { requestId, proposalIds: [first], decision: 'approve', note: '  Đúng, giữ bài học này.  ' });
    assert.equal(approved.replayed, false);
    assert.equal(approved.proposals[0].status, 'approved');
    assert.equal(approved.proposals[0].note, 'Đúng, giữ bài học này.');
    assert.equal(approved.proposals[0].decidedByName, 'Quản trị viên');
    assert.equal(approved.proposals[0].via, 'crm_ui');
    const replay = await decide(ADMIN, { requestId, proposalIds: [first], decision: 'approve', note: 'Đúng, giữ bài học này.' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.proposals[0].decidedAt, approved.proposals[0].decidedAt);
    await assert.rejects(decide(ADMIN, { requestId, proposalIds: [first], decision: 'reject' }), code('PT409'));
    await assert.rejects(decide(ADMIN, { requestId: id('b'), proposalIds: [first, second], decision: 'reject' }), code('PT409'));
    assert.equal((await db.query('SELECT status FROM app_private.hermes_learning_proposals WHERE id=$1', [second])).rows[0].status, 'pending');
    const rejected = await decide(ADMIN, { requestId: id('b'), proposalIds: [second], decision: 'reject', note: ' \n\t ' });
    assert.deepEqual(rejected.proposals.map(item => [item.seq, item.status, item.note]), [[2, 'rejected', null]]); // ghi chú chỉ khoảng trắng ⇒ không ghi chú
    await assert.rejects(decide(MEMBER, { requestId: id('c'), proposalIds: [first], decision: 'approve' }), code('42501'));
    // Trợ lý học lại đúng bài học đã bị bỏ: không quay lại hàng duyệt, nhưng được báo riêng.
    const relearned = await ingest(batch([proposal(2, { kind: 'memory_crm_write' }), proposal(1)]));
    assert.deepEqual(relearned, { organizationId: ORG, inserted: [], duplicates: 2, rejectedDuplicates: [key(2)] });
  });

  await t.test('duyệt từ chối đầu vào sai và đề xuất ngoài công ty', async () => {
    const third = (await db.query('SELECT id FROM app_private.hermes_learning_proposals WHERE seq=3 AND organization_id=$1', [ORG])).rows[0].id;
    for (const bad of [
      { requestId: id('c'), proposalIds: [], decision: 'approve' },
      { requestId: id('c'), proposalIds: [third, third], decision: 'approve' },
      { requestId: id('c'), proposalIds: [third], decision: 'maybe' },
      { requestId: id('c'), proposalIds: [third], decision: 'approve', note: 'x'.repeat(501) },
      { requestId: id('c'), proposalIds: [third], decision: 'approve', note: 5 },
      { requestId: 'không-phải-uuid', proposalIds: [third], decision: 'approve' },
      { requestId: id('c'), proposalIds: [id('d')], decision: 'approve' },
    ]) await assert.rejects(decide(ADMIN, bad), code('22023'), JSON.stringify(bad));
    await assert.rejects(as('authenticated', ADMIN, 'SELECT public.hermes_learning_decide_v1($1::jsonb) result',
      [JSON.stringify({ organizationId: ORG, requestId: id('c'), proposalIds: [third], decision: 'approve' })]), code('22023')); // thiếu note
  });

  await t.test('quyết định một lần; nội dung chỉ được che một lần sau quyết định; xoá chưa bị trigger chặn (chờ chính sách)', async () => {
    const third = (await db.query('SELECT id FROM app_private.hermes_learning_proposals WHERE seq=3 AND organization_id=$1', [ORG])).rows[0].id;
    await assert.rejects(db.query('UPDATE app_private.hermes_learning_proposals SET content=$2 WHERE id=$1', [first, 'sửa lén']), code('55000'));
    await assert.rejects(db.query("UPDATE app_private.hermes_learning_proposals SET status='rejected' WHERE id=$1", [first]), code('55000'));
    await assert.rejects(db.query('UPDATE app_private.hermes_learning_proposals SET title=$2 WHERE id=$1', [third, 'đổi tiêu đề']), code('55000'));
    await assert.rejects(db.query('UPDATE app_private.hermes_learning_proposals SET seq=99 WHERE id=$1', [third]), code('55000'));
    // Che nội dung khi còn chờ duyệt ⇒ CHECK từ chối.
    await assert.rejects(db.query(`UPDATE app_private.hermes_learning_proposals SET content='[đã che]',redacted_at=clock_timestamp(),redacted_by=$2 WHERE id=$1`,
      [third, ADMIN]), code('23514'));
    await db.query(`UPDATE app_private.hermes_learning_proposals SET title='[đã che]',content='[đã che]',source='{}',redacted_at=clock_timestamp(),redacted_by=$2 WHERE id=$1`,
      [first, ADMIN]);
    await assert.rejects(db.query(`UPDATE app_private.hermes_learning_proposals SET content='che lần hai' WHERE id=$1`, [first]), code('55000'));
    await assert.rejects(db.query(`UPDATE app_private.hermes_learning_proposals SET redacted_at=clock_timestamp() WHERE id=$1`, [first]), code('55000'));
    const after = (await db.query('SELECT status,content,redacted_by FROM app_private.hermes_learning_proposals WHERE id=$1', [first])).rows[0];
    assert.deepEqual(after, { status: 'approved', content: '[đã che]', redacted_by: ADMIN });
    await db.exec('BEGIN');
    try { assert.equal((await db.query('DELETE FROM app_private.hermes_learning_proposals WHERE id=$1 RETURNING id', [second])).rows.length, 1); }
    finally { await db.exec('ROLLBACK'); }
    await assert.rejects(as('authenticated', ADMIN, 'DELETE FROM app_private.hermes_learning_proposals RETURNING 1 AS result', []), code('42501'));
  });

  await t.test('đề xuất chờ phân trang 20; lịch sử phân trang 20 theo lúc quyết định, nội dung rút gọn', async () => {
    const more = await ingest(batch(Array.from({ length: 25 }, (_, n) => proposal(200 + n, { content: `${'ệ'.repeat(400)} ${n}` }))));
    const ids = more.inserted.map(item => item.id);
    const firstPage = await review(ADMIN);
    assert.equal(firstPage.pendingCount, 26);
    assert.equal(firstPage.pending.length, 20);
    assert.equal(firstPage.nextPendingAfterSeq, firstPage.pending[19].seq);
    const secondPage = await review(ADMIN, null, ORG, firstPage.nextPendingAfterSeq);
    assert.equal(secondPage.pending.length, 6);
    assert.equal(secondPage.nextPendingAfterSeq, null);
    assert.equal(new Set([...firstPage.pending, ...secondPage.pending].map(item => item.id)).size, 26);
    await decide(ADMIN, { requestId: id('5'), proposalIds: ids.slice(0, 20), decision: 'approve' });
    await decide(ADMIN, { requestId: id('6'), proposalIds: ids.slice(20, 22), decision: 'reject', note: 'Không đúng nghiệp vụ' });
    const page = await review(ADMIN);
    assert.equal(page.pendingCount, 4);
    assert.equal(page.history.length, 20);
    assert.ok(page.nextHistoryCursor);
    assert.deepEqual(page.history.slice(0, 2).map(item => item.status), ['rejected', 'rejected']);
    assert.equal(page.history[0].contentTruncated, true);
    assert.equal([...page.history[0].content].length, 300);
    assert.deepEqual(page.history[0].source, {});
    const rest = await review(ADMIN, page.nextHistoryCursor);
    assert.equal(rest.history.length, 4);
    assert.equal(rest.nextHistoryCursor, null);
    const seen = new Set([...page.history, ...rest.history].map(item => item.id));
    assert.equal(seen.size, 24);
  });

  await t.test('nguồn đo theo dạng chữ đúng 4096 byte; trang 20 đề xuất dài tối đa vẫn dưới trần 1 MiB', async () => {
    // {"note": "x…x"} = 12 byte khung + N.
    await assert.rejects(ingest(batch([proposal(300, { source: { note: 'x'.repeat(4085) } })])), code('23514'));
    const wide = '\u{1D54F}'; // 4 byte UTF-8, một ký tự với PostgreSQL
    const max = Array.from({ length: 20 }, (_, n) => proposal(400 + n, { title: wide.repeat(199) + n % 10,
      content: wide.repeat(4000), source: { note: 'x'.repeat(4084) } }));
    // Một lời gọi nhận tối đa 128 KiB (hermes_request_v1) ⇒ bộ nạp chia lô; ở đây 5 đề xuất tối đa một lô.
    const inserted = [];
    for (let at = 0; at < max.length; at += 5) inserted.push(...(await ingest(batch(max.slice(at, at + 5)))).inserted);
    assert.equal(inserted.length, 20);
    const lastSmall = Math.min(...inserted.map(item => item.seq)) - 1;
    const view = await review(ADMIN, null, ORG, lastSmall);
    assert.equal(view.pending.length, 20);
    assert.equal([...view.pending[0].content].length, 4000);
    const bytes = Buffer.byteLength(JSON.stringify(view));
    assert.ok(bytes > 400_000 && bytes < 1_048_576, String(bytes));
  });
});
