import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { setup, binding, id, ORG, USER, FOREIGN } from './finance-fixture.mjs';
import { presentLearningDigest } from './learning-action-contract.mjs';
import { LEARNING_DIGEST_MAX_ITEMS } from './learning-digest.mjs';

// Đợt 3 học có kiểm duyệt (docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4) trên PGlite: nền binding / phiên / chính sách công ty thật
// của Hermes (finance-fixture), khung thao tác ghi chung THẬT (20261021133823), kho đề xuất THẬT (20261031041523) và file của đợt này.
// Quyền CRM giả qua fixture_acl (ảnh chụp quyền của guard) + require_perm_v1 giả (cổng người của web, đọc thêm fixture_perm_denied).
// Kiểm: khoá seed TẮT + chưa có dòng chính sách ⇒ đóng; learning.digest (đề xuất chờ chưa báo của đúng công ty, đánh dấu một lần,
// tối đa LEARNING_DIGEST_MAX_ITEMS = số dòng tin tối — mục nào đánh dấu cũng có số trong tin dựng bằng presenter THẬT của connector,
// bỏ qua đề xuất đã quyết định trước khi được báo, phát lại theo requestId); learning.decide (luôn xem trước, basis lệch ⇒ state_changed,
// ghi qua lõi dùng chung với via hermes_connector); guard bất biến cho đúng bước "đã báo"; khối $requires$ ghim md5 thân guard (thân
// 20261031041523 đang chạy hoặc thân mới; thân khác ⇒ dừng). Không chứng minh RLS production, MVCC đồng thời hay PostgREST.
// Kiểm đột biến: HERMES_LEARNING_ACTION_SQL_MUTATION=<tên trong MUTATIONS> sửa SQL CHỈ trong bộ nhớ của lần chạy này ⇒ test phải đỏ.
const migration = slug => {
  const found = readdirSync('supabase/migrations').filter(name => new RegExp(`^\\d{14}_${slug}\\.sql$`).test(name));
  assert.equal(found.length, 1, slug);
  return readFileSync(`supabase/migrations/${found[0]}`, 'utf8').replaceAll('\r\n', '\n');
};
const MUTATIONS = {
  // Bỏ cổng người của web (require_perm_v1 sau khoá công ty): chỉ còn ảnh chụp quyền của guard.
  'skip-web-gate': ['v_actor:=app_private.hermes_learning_admin_v1(v_org);', 'v_actor:=(ctx->>\'userId\')::uuid;'],
  // Lượt 2 không so basis / không so bản đã giải.
  'skip-basis': ['OR p_expected_basis IS DISTINCT FROM v_basis OR p_resolved->\'proposalIds\'', 'OR p_resolved->\'proposalIds\''],
  'skip-resolved': [' OR p_resolved->\'proposalIds\' IS DISTINCT FROM to_jsonb(v_ids)\n        OR p_resolved->\'numbers\' IS DISTINCT FROM to_jsonb(v_seqs)', ''],
  'note-outside-basis': ['jsonb_build_array(p_action,v_decision,v_note,to_jsonb(v_ids)', 'jsonb_build_array(p_action,v_decision,to_jsonb(v_ids)'],
  // Phát lại theo requestId sau phép so basis: lượt đã ghi đổi trạng thái ⇒ gọi lại cùng requestId thành state_changed.
  'skip-replay-first': ['IF v_write AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts', 'IF false AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts'],
  // learning.decide theo chính sách (never ⇒ ghi thẳng) thay vì luôn xem trước.
  'decide-follows-policy': ['    ELSE\n      IF cardinality(v_ids)=0 THEN', '    ELSIF NOT (p_phase=\'auto\' AND ctx->>\'confirm\'=\'never\') THEN\n      IF cardinality(v_ids)=0 THEN'],
  'decide-any-status': ['r.seq=ANY(v_numbers) AND r.status=\'pending\';', 'r.seq=ANY(v_numbers);'],
  'decide-any-org': ['WHERE r.organization_id=v_org AND r.seq=ANY(v_numbers) AND r.status=\'pending\';', 'WHERE r.seq=ANY(v_numbers) AND r.status=\'pending\';'],
  'digest-any-org': ['WHERE r.organization_id=v_org AND r.status=\'pending\' AND r.announced_at IS NULL', 'WHERE r.status=\'pending\' AND r.announced_at IS NULL'],
  // Review #391: chọn cả đề xuất đã quyết định trên web trước khi được báo ⇒ guard cấm đánh dấu nó ⇒ digest hỏng (mọi tối sau).
  'digest-any-status': [' AND r.status=\'pending\' AND r.announced_at IS NULL ORDER BY r.seq', ' AND r.announced_at IS NULL ORDER BY r.seq'],
  'digest-again': [' AND r.announced_at IS NULL ORDER BY r.seq LIMIT 10', ' ORDER BY r.seq LIMIT 10'],
  'digest-no-mark': ['UPDATE app_private.hermes_learning_proposals SET announced_at=v_now WHERE organization_id=v_org AND id=ANY(v_ids);', ''],
  'digest-no-cap': ['ORDER BY r.seq LIMIT 10) c;', 'ORDER BY r.seq) c;'],
  // Review #391: trần cũ 20 đánh dấu nhiều hơn số dòng tin liệt kê được ⇒ mục đã đánh dấu mà không có số trong tin.
  'digest-cap-20': ['ORDER BY r.seq LIMIT 10) c;', 'ORDER BY r.seq LIMIT 20) c;'],
  // Review #391: không ghim md5 thân guard ⇒ guard bị sửa ngoài migration vẫn bị đè im lặng.
  'guard-no-pin': [' OR v_guard NOT IN (\'54e4b8fc6831348bd4e2df411bde6fdb\',\'e55ad2c8914b850b1c335fdd7ed224f3\')', ''],
  // Chỉ nhận thân đang chạy ⇒ lượt hai (thân mới) bị chặn: file không còn chạy lại được.
  'guard-pin-only-running': ['\'54e4b8fc6831348bd4e2df411bde6fdb\',\'e55ad2c8914b850b1c335fdd7ed224f3\')', '\'54e4b8fc6831348bd4e2df411bde6fdb\')'],
  'digest-ignores-policy': ['\n    AND COALESCE(ctx->>\'actionClass\'=\'reversible\' AND ctx->>\'confirm\'=\'never\',false));', ');'],
  'guard-reannounce': ['(OLD.announced_at IS NOT NULL OR NEW.announced_at IS NULL)', '(NEW.announced_at IS NULL)'],
  'guard-decided-announce': ['    OR (NEW.status<>\'pending\' AND NEW.announced_at IS DISTINCT FROM OLD.announced_at)\n', ''],
  'grant-anon': ['GRANT EXECUTE ON FUNCTION public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;',
    'GRANT EXECUTE ON FUNCTION public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated,anon;'],
  // Sau C1 hàm mới không còn EXECUTE của PUBLIC: thiếu GRANT tường minh cho vai gọi ⇒ vỏ INVOKER không tới được bước DEFINER.
  'step-no-grant': ['GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;', ''],
  'step-grant-public': ['GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;',
    'GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated,PUBLIC;'],
  'seed-enabled': ['VALUES(\'assistant.learning_review\',\'action\',false)', 'VALUES(\'assistant.learning_review\',\'action\',true)'],
};
const mutationName = process.env.HERMES_LEARNING_ACTION_SQL_MUTATION;
assert(!mutationName || Object.hasOwn(MUTATIONS, mutationName), `unknown mutation ${mutationName}`);
// Thân guard (prosrc, bỏ CR) và md5 của nó — khối $requires$ ghim md5 thân đang chạy (041523) và thân mới của file này.
const guardBody = sql => /CREATE OR REPLACE FUNCTION app_private\.hermes_learning_guard_v1\(\)[\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/.exec(sql)[1];
const md5 = text => createHash('md5').update(text.replaceAll('\r', '')).digest('hex');
// Đo trên production và TEST 05/11 (review #391): md5 thân guard đang chạy = thân của 20261031041523.
const RUNNING_GUARD = '54e4b8fc6831348bd4e2df411bde6fdb';
const mutate = sql => {
  if (!mutationName) return sql;
  const [from, to] = MUTATIONS[mutationName];
  assert.equal(sql.split(from).length, 2, `${mutationName}: chuỗi gốc phải xuất hiện đúng một lần`);
  const mutated = sql.replace(from, () => to);
  // Đột biến thân guard (guard-*) mô phỏng người sửa guard CÓ cập nhật ghim "thân mới" ở $requires$: phải đỏ ở test hành vi của guard,
  // không phải ở ghim md5 (ghim có test và đột biến riêng: guard-no-pin, guard-pin-only-running).
  const before = md5(guardBody(sql)), after = md5(guardBody(mutated));
  return before === after ? mutated : mutated.replace(`'${before}')`, () => `'${after}')`);
};
const RESOLVE = migration('hermes_write_name_resolve_v1'), FOUNDATION = migration('hermes_action_foundation_v1');
const STORE = migration('hermes_learning_proposals_v1'), ACTION = mutate(migration('hermes_learning_action_v1'));
const KEY = 'assistant.learning_review';
const SHELL = 'public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)';
const STEP = 'app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)';
// Đúng hai dòng mà migration bật (PR riêng) sẽ chèn — mục 4.4 thiết kế.
const POLICIES = `INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only) VALUES
  ('learning.digest','${KEY}','users.edit','reversible','never',true),('learning.decide','${KEY}','users.edit','reversible','always',true)`;
const OUTSIDER = id('e'), OUTSIDER_ASSISTANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const rid = n => `00000000-0000-4000-8000-${String(700 + n).padStart(12, '0')}`;
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
const isoAgo = ms => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const key = n => n.toString(16).padStart(64, '0');
const proposal = (n, extra = {}) => ({ dedupeKey: key(n), kind: 'skill_crm_write', title: `Đề xuất ${n}`,
  content: `Skill crm-task-management: gọi crm_action_run task.create (${n}).`, source: { type: 'curator_ledger', ledgerId: `ledger${n}` },
  detectedAt: isoAgo(3_600_000), ...extra });
// Như production và TEST: authenticated KHÔNG có USAGE trên app_private; vỏ tới bước DEFINER qua OID gắn lúc tạo.
const SUPPORT = `CREATE TABLE IF NOT EXISTS public.building_common_names(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,building_id uuid,name text);
  CREATE TABLE IF NOT EXISTS public.job_types(id uuid PRIMARY KEY,organization_id uuid,name text,is_active boolean);
  CREATE TABLE IF NOT EXISTS public.profiles(id uuid PRIMARY KEY,full_name text);
  ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS code text;
  REVOKE USAGE ON SCHEMA app_private FROM authenticated, PUBLIC;
  GRANT SELECT ON public.building_common_names,public.job_types,public.profiles,public.buildings,public.rooms TO authenticated;
  CREATE OR REPLACE FUNCTION app_private.hermes_task_assignee_member_v1(p_user uuid,p_org uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $f$ SELECT p_user=auth.uid() $f$;
  CREATE OR REPLACE FUNCTION app_private.hermes_web_building_ids_v1(p_org uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) FROM public.buildings b WHERE p_org IS NOT NULL AND b.organization_id=p_org AND b.deleted_at IS NULL $f$;
  REVOKE ALL ON FUNCTION app_private.hermes_web_building_ids_v1(uuid) FROM PUBLIC,authenticated;
  -- Cổng người của web: khoá công ty rồi hỏi quyền (như require_perm_v1 thật); fixture_perm_denied mô phỏng quyền bị thu sau ảnh chụp.
  CREATE TABLE IF NOT EXISTS public.fixture_perm_denied(permission text PRIMARY KEY);
  CREATE OR REPLACE FUNCTION app_private.require_perm_v1(p_org uuid,p_key text,p_viec text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,public,app_private AS $f$
    BEGIN
      IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập.' USING ERRCODE='42501'; END IF;
      PERFORM app_private.lock_org_for_decision_v1(p_org);
      IF p_org IS DISTINCT FROM '${ORG}'::uuid OR NOT EXISTS(SELECT 1 FROM public.fixture_acl WHERE permission=p_key AND allowed)
        OR EXISTS(SELECT 1 FROM public.fixture_perm_denied WHERE permission=p_key)
        THEN RAISE EXCEPTION 'Bạn không có quyền %.', p_viec USING ERRCODE='42501'; END IF;
    END $f$;`;

async function learningSetup(t) {
  const f = await setup(t, { action: `${SUPPORT}\n${RESOLVE}` });
  const { db, call } = f;
  await db.exec(FOUNDATION);
  await db.exec(STORE);
  // Như production sau C1 (20261104173640, PR #392): hàm postgres tạo SAU đó không tự cấp EXECUTE cho PUBLIC — mọi vai gọi phải được
  // GRANT tường minh. File của đợt này tạo hàm sau mốc đó.
  await db.exec('ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  // File của đợt này chạy hai lần: phải idempotent.
  await db.exec(ACTION); await db.exec(ACTION);
  await db.exec(`INSERT INTO auth.users VALUES('${OUTSIDER}');
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${OUTSIDER}','${OUTSIDER}','${FOREIGN}','ACTIVE');
    INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${OUTSIDER_ASSISTANT}','${FOREIGN}','${OUTSIDER}');
    INSERT INTO public.profiles VALUES('${USER}','Chủ trợ lý') ON CONFLICT DO NOTHING;
    INSERT INTO public.fixture_acl(permission,org_wide,building_ids) VALUES('users.edit',true,'{}') ON CONFLICT(permission) DO UPDATE SET allowed=true;`);
  const learning = (action, phase, requestId, params = {}, extra = {}, b = binding, options) => call(
    'SELECT public.hermes_learning_action_v1($1::jsonb,$2,$3,$4::uuid,$5::jsonb,$6::jsonb,$7) result',
    [JSON.stringify(b), action, phase, requestId, JSON.stringify(params), extra.resolved ? JSON.stringify(extra.resolved) : null, extra.basis ?? null], options);
  const digest = (requestId, phase = 'auto', extra = {}) => learning('learning.digest', phase, requestId, {}, extra);
  const decide = (phase, requestId, params, extra) => learning('learning.decide', phase, requestId, params, extra);
  const status = requestId => call('SELECT public.hermes_action_status_v1($1::jsonb,$2::uuid) result', [JSON.stringify(binding), requestId]);
  const ingest = (proposals, extra = {}) => call('SELECT app_private.hermes_store_learning_ingest_v1($1::jsonb) result',
    [JSON.stringify({ organizationId: ORG, userId: USER, profile: 'owner', auditGeneratedAt: isoAgo(600_000), proposals, ...extra })], { role: 'hermes_learning_ingest', actor: '' });
  const webDecide = (requestId, proposalIds, decision, note = null) => call('SELECT public.hermes_learning_decide_v1($1::jsonb) result',
    [JSON.stringify({ organizationId: ORG, requestId, proposalIds, decision, note })]);
  const rows = async () => (await db.query(`SELECT seq::int,status,announced_at IS NOT NULL announced,decision_via via,decision_note note
    FROM app_private.hermes_learning_proposals WHERE organization_id=$1 ORDER BY seq`, [ORG])).rows;
  const idOf = async seq => (await db.query('SELECT id FROM app_private.hermes_learning_proposals WHERE organization_id=$1 AND seq=$2', [ORG, seq])).rows[0].id;
  const receipts = async () => (await db.query("SELECT request_id,action,state FROM app_private.hermes_action_receipts WHERE action LIKE 'learning.%' ORDER BY created_at,request_id")).rows;
  const activate = async () => {
    await db.exec(POLICIES);
    await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=$1', [KEY]);
    await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=array_append(action_capabilities,$1)', [KEY]);
    await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_append(action_capabilities,$1)', [KEY]);
  };
  return { ...f, learning, digest, decide, status, ingest, webDecide, rows, idOf, receipts, activate };
}

test('đợt 3 học có kiểm duyệt: learning.digest / learning.decide trên khung thao tác chung', { timeout: 240000 }, async t => {
  const f = await learningSetup(t);
  const { db, call, digest, decide, status, ingest, webDecide, rows, idOf, receipts } = f;

  await t.test('seed: khoá TẮT, chưa có dòng chính sách ⇒ đóng (42501) kể cả khi bật khoá; vỏ INVOKER gắn OID bước DEFINER; quyền EXECUTE đúng', async () => {
    assert.deepEqual((await db.query('SELECT mode,enabled FROM app_private.hermes_capabilities WHERE capability=$1', [KEY])).rows, [{ mode: 'action', enabled: false }]);
    assert.deepEqual((await db.query("SELECT action FROM app_private.hermes_action_policies WHERE action LIKE 'learning.%'")).rows, []);
    await ingest([proposal(1)]);
    await assert.rejects(digest(rid(1)), code('42501'));
    await f.rollbackCase(async () => {
      // Khoá bật + có trên kết nối và trần công ty, nhưng thiếu dòng chính sách ⇒ thao tác không tồn tại (guard chung).
      await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=$1', [KEY]);
      await db.query('UPDATE app_private.hermes_org_policies SET action_capabilities=array_append(action_capabilities,$1)', [KEY]);
      await db.query('UPDATE app_private.hermes_connections SET action_capabilities=array_append(action_capabilities,$1)', [KEY]);
      await assert.rejects(digest(rid(1)), code('42501'));
      await assert.rejects(decide('auto', rid(2), { numbers: [1], decision: 'approve' }), code('42501'));
    });
    assert.deepEqual(await receipts(), []);
    assert.deepEqual((await rows()).map(row => row.announced), [false]);
    const catalog = (await db.query(`SELECT
      (SELECT prosecdef FROM pg_proc WHERE oid='${SHELL}'::regprocedure) shell_definer,
      (SELECT prosqlbody IS NOT NULL FROM pg_proc WHERE oid='${SHELL}'::regprocedure) shell_bound,
      (SELECT prosecdef FROM pg_proc WHERE oid='${STEP}'::regprocedure) step_definer,
      has_function_privilege('authenticated','${SHELL}','EXECUTE') a_shell, has_function_privilege('authenticated','${STEP}','EXECUTE') a_step,
      has_function_privilege('anon','${SHELL}','EXECUTE') anon_shell, has_function_privilege('anon','${STEP}','EXECUTE') anon_step,
      has_function_privilege('hermes_learning_ingest','${SHELL}','EXECUTE') ingest_shell,
      has_function_privilege('hermes_store_executor','${STEP}','EXECUTE') store_step,
      has_function_privilege('authenticated','app_private.hermes_learning_apply_v1(uuid,uuid,uuid[],text,text,uuid,text)','EXECUTE') a_apply,
      has_table_privilege('authenticated','app_private.hermes_learning_proposals','UPDATE') a_update,
      has_schema_privilege('authenticated','app_private','USAGE') usage,
      (SELECT atttypid='timestamptz'::regtype FROM pg_attribute WHERE attrelid='app_private.hermes_learning_proposals'::regclass AND attname='announced_at') column_type`)).rows[0];
    assert.deepEqual(catalog, { shell_definer: false, shell_bound: true, step_definer: true, a_shell: true, a_step: true, anon_shell: false, anon_step: false,
      ingest_shell: false, store_step: false, a_apply: false, a_update: false, usage: false, column_type: true });
    // C1: không hàm nào của file cấp EXECUTE cho PUBLIC; EXECUTE chỉ tới đúng vai gọi (authenticated) + chủ hàm.
    const grantees = (await db.query(`SELECT p.pronamespace::regnamespace::text||'.'||p.proname fn, COALESCE(string_agg(g.role, ',' ORDER BY g.role),'') roles FROM pg_proc p
      LEFT JOIN LATERAL (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role FROM aclexplode(p.proacl) a
        WHERE a.privilege_type='EXECUTE') g ON true
      WHERE p.oid IN ('${SHELL}'::regprocedure,'${STEP}'::regprocedure,'app_private.hermes_learning_guard_v1()'::regprocedure) GROUP BY 1 ORDER BY 1`)).rows;
    assert.deepEqual(grantees, [{ fn: 'app_private.hermes_learning_action_step_v1', roles: 'authenticated,postgres' },
      { fn: 'app_private.hermes_learning_guard_v1', roles: 'postgres' }, { fn: 'public.hermes_learning_action_v1', roles: 'authenticated,postgres' }]);
    // Client không gọi thẳng được bước DEFINER bằng tên (không USAGE app_private).
    await assert.rejects(call(`SELECT app_private.hermes_learning_action_step_v1($1::jsonb,'learning.digest','auto',$2::uuid,'{}'::jsonb,NULL,NULL) result`,
      [JSON.stringify(binding), rid(3)]), error => error.code === '42501' && /schema app_private/.test(error.message));
  });

  await t.test('$requires$ ghim md5 thân guard trước khi đè (khuôn C2): thân 041523 đang chạy hoặc thân mới (chạy lại) qua; thân khác ⇒ dừng', async () => {
    const requires = /DO \$requires\$[\s\S]*?END \$requires\$;/.exec(ACTION)[0];
    const guardOf = sql => /CREATE OR REPLACE FUNCTION app_private\.hermes_learning_guard_v1\(\)[\s\S]*?\$fn\$;/.exec(sql)[0];
    const guardMd5 = async () => (await db.query(
      "SELECT md5(replace(prosrc,chr(13),'')) md5 FROM pg_proc WHERE oid='app_private.hermes_learning_guard_v1()'::regprocedure")).rows[0].md5;
    assert.equal(md5(guardBody(STORE)), RUNNING_GUARD, 'thân guard của 20261031041523 = thân đo trên production và TEST');
    await f.rollbackCase(async () => {
      // Setup đã chạy file hai lần: lượt hai thấy thân mới của chính file và qua.
      assert.equal(await guardMd5(), md5(guardBody(ACTION)), 'thân mới của file này');
      await db.exec(requires);
      // Lượt đầu trên production / TEST: thân 041523 đang chạy.
      await db.exec(guardOf(STORE));
      assert.equal(await guardMd5(), RUNNING_GUARD);
      await db.exec(requires);
      // Có người sửa guard ngoài migration (ở đây chỉ thêm một chú thích) ⇒ dừng trước khi đè, nêu md5 lạ.
      await db.exec(guardOf(STORE).replace('RETURN NEW;', 'RETURN NEW; -- sửa tay'));
      await db.exec('SAVEPOINT drift');
      await assert.rejects(db.exec(requires), /hermes_learning_guard_body_drift: [0-9a-f]{32}/);
      await db.exec('ROLLBACK TO SAVEPOINT drift');
    });
    assert.equal(await guardMd5(), md5(guardBody(ACTION)));
  });

  await f.activate();

  await t.test('digest: đề xuất chờ chưa báo của đúng công ty theo số, đánh dấu một lần, phát lại theo requestId, tra trạng thái', async () => {
    await ingest([proposal(2, { kind: 'memory_crm_write', content: `${'ệ'.repeat(400)}` }), proposal(3, { kind: 'audit_warning' })]);
    await ingest([proposal(1)], { organizationId: FOREIGN, userId: OUTSIDER, profile: 'tkt' });
    const first = await digest(rid(10));
    assert.equal(first.kind, 'applied');
    assert.equal(first.link, '/settings/hermes?tab=bai-hoc');
    assert.deepEqual(Object.keys(first.result).sort(), ['announcedAt', 'items', 'pendingTotal']);
    assert.match(first.result.announcedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.equal(first.result.pendingTotal, 3);
    assert.deepEqual(first.result.items.map(item => [item.seq, item.kind, item.title]), [[1, 'skill_crm_write', 'Đề xuất 1'],
      [2, 'memory_crm_write', 'Đề xuất 2'], [3, 'audit_warning', 'Đề xuất 3']]);
    assert.equal([...first.result.items[1].content].length, 300, 'nội dung cắt 300 ký tự (tin chỉ hiện 140)');
    assert.deepEqual((await rows()).map(row => row.announced), [true, true, true]);
    const foreign = (await db.query('SELECT announced_at FROM app_private.hermes_learning_proposals WHERE organization_id=$1', [FOREIGN])).rows;
    assert.deepEqual(foreign, [{ announced_at: null }], 'công ty khác không bị đánh dấu');
    assert.deepEqual(await digest(rid(10)), first, 'cùng requestId ⇒ phát lại y nguyên');
    assert.deepEqual(await status(rid(10)), { kind: 'status', outcome: 'applied', action: 'learning.digest', result: first.result });
    const none = await digest(rid(11));
    assert.deepEqual([none.kind, none.result.items, none.result.pendingTotal], ['applied', [], 3], 'không có mục mới ⇒ items rỗng (tin null)');
    await ingest([proposal(4), proposal(5)]);
    await webDecide(rid(12), [await idOf(1)], 'approve');
    const next = await digest(rid(13));
    assert.deepEqual([next.result.items.map(item => item.seq), next.result.pendingTotal], [[4, 5], 4]);
    await f.rollbackCase(async () => {
      // Review #391: đề xuất được quyết định trên web TRƯỚC khi được báo (chưa có announced_at) ⇒ digest không chọn nó (guard cấm đánh dấu
      // đề xuất đã quyết định — chọn nó làm digest hỏng mọi tối sau), vẫn báo đề xuất còn chờ khác; tối sau digest vẫn chạy.
      const [early, later] = (await ingest([proposal(40), proposal(41)])).inserted;
      await webDecide(rid(14), [early.id], 'reject', 'sai từ đầu');
      const after = await digest(rid(16));
      assert.equal(after.kind, 'applied', JSON.stringify(after));
      assert.deepEqual([after.result.items.map(item => item.seq), after.result.pendingTotal], [[later.seq], 5]);
      assert.deepEqual((await rows()).filter(row => row.seq >= early.seq).map(row => [row.seq, row.status, row.announced]),
        [[early.seq, 'rejected', false], [later.seq, 'pending', true]]);
      const quiet = await digest(rid(17));
      assert.deepEqual([quiet.kind, quiet.result.items], ['applied', []]);
    });
    assert.deepEqual((await receipts()).map(row => [row.action, row.state]), [['learning.digest', 'applied'], ['learning.digest', 'applied'], ['learning.digest', 'applied']]);
    await assert.rejects(f.learning('learning.digest', 'auto', rid(15), { force: true }), code('22023'), 'digest không nhận tham số');
  });

  await t.test('digest: tối đa LEARNING_DIGEST_MAX_ITEMS mục theo số = số dòng tin; đề xuất dài vẫn có đủ số trong tin; phần còn lại sang tối sau; chính sách siết always ⇒ xem trước, không đánh dấu', async () => {
    // Review #391: 25 đề xuất dài như production (tiêu đề 136, nội dung 867 ký tự). Trần cũ 20 đánh dấu 20 mà tin chỉ liệt kê 6 số ⇒ 14 số
    // không bao giờ hiện lại theo số. Nay: mục nào vừa được đánh dấu đều có số trong tin dựng bằng presenter THẬT của connector.
    const long = n => proposal(100 + n, { kind: ['skill_crm_write', 'memory_crm_write', 'audit_warning'][n % 3],
      title: `Skill crm-task-management: curator sửa cách ghi phiếu ${n} — ${'tiêu đề rất dài '.repeat(9)}`.slice(0, 136),
      content: `${'Gọi crm_action_run expense.create với đủ tham số rồi xác nhận theo bản xem trước. '.repeat(12)}`.slice(0, 867) });
    await ingest(Array.from({ length: 25 }, (_, n) => long(n)));
    const announced = async () => (await rows()).filter(row => row.announced).map(row => row.seq);
    const evening = async (requestId, phase, extra) => {
      const before = new Set(await announced());
      const outcome = await digest(requestId, phase, extra);
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome).slice(0, 200));
      const marked = (await announced()).filter(seq => !before.has(seq));
      assert.ok(outcome.result.items.length <= LEARNING_DIGEST_MAX_ITEMS,
        `SQL đánh dấu ${outcome.result.items.length} mục, tin chỉ liệt kê được ${LEARNING_DIGEST_MAX_ITEMS}`);
      const shown = presentLearningDigest(outcome.result, { webOrigin: 'https://crm.example.vn' });
      assert.deepEqual(shown.numbers, marked, 'số trong kết quả = đúng các mục vừa đánh dấu');
      if (marked.length === 0) { assert.equal(shown.message, null, 'không mục mới ⇒ không tin'); return outcome; }
      assert.ok([...shown.message].length <= 1800);
      for (const seq of marked) assert.match(shown.message, new RegExp(`^#${seq} `, 'm'), `#${seq} đã đánh dấu phải có dòng trong tin`);
      return outcome;
    };
    const page = await evening(rid(20));
    assert.deepEqual(page.result.items.map(item => item.seq), Array.from({ length: LEARNING_DIGEST_MAX_ITEMS }, (_, n) => 6 + n));
    assert.equal(page.result.pendingTotal, 29);
    assert.equal([...page.result.items[0].content].length, 300, 'SQL cắt nội dung 300 ký tự');
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='learning.digest'");
      const preview = await digest(rid(21));
      assert.deepEqual([preview.kind, preview.confirm, preview.preview], ['preview', 'required', { action: 'learning.digest', newCount: 10 }]);
      assert.equal((await rows()).filter(row => !row.announced).length, 15, 'xem trước không đánh dấu');
      assert.deepEqual(await digest(rid(21), 'apply', { resolved: {}, basis: 'khác' }), { kind: 'rejected', reason: 'state_changed' });
      const applied = await evening(rid(21), 'apply', { resolved: preview.resolved, basis: preview.basis });
      assert.deepEqual(applied.result.items.map(item => item.seq), Array.from({ length: 10 }, (_, n) => 16 + n));
    });
    // Tối sau: 10 mục tiếp theo; tối sau nữa: phần cuối.
    assert.deepEqual((await evening(rid(22))).result.items.map(item => item.seq), Array.from({ length: 10 }, (_, n) => 16 + n));
    assert.deepEqual((await evening(rid(23))).result.items.map(item => item.seq), [26, 27, 28, 29, 30]);
    assert.deepEqual((await evening(rid(24))).result.items, []);
  });

  await t.test('decide: luôn xem trước (cả khi chính sách never), số không còn chờ vào cảnh báo; lượt 2 ghi qua lõi chung, via hermes_connector', async () => {
    const before = await receipts();
    const preview = await decide('auto', rid(30), { numbers: [3, 2, 999], decision: 'approve', note: '  Đúng quy trình mới.  ' });
    assert.equal(preview.kind, 'preview');
    assert.equal(preview.confirm, 'required');
    assert.match(preview.basis, /^[0-9a-f]{32}$/);
    assert.deepEqual(preview.resolved, { proposalIds: [await idOf(2), await idOf(3)], numbers: [2, 3] });
    assert.deepEqual(preview.preview, { action: 'learning.decide', decision: 'DUYỆT', note: 'Đúng quy trình mới.',
      effect: 'Duyệt chỉ ghi nhận bài học đúng; điều phối viên đưa vào hướng dẫn chuẩn.',
      items: [{ number: 2, kind: 'Bộ nhớ', title: 'Đề xuất 2' }, { number: 3, kind: 'Cảnh báo kiểm học', title: 'Đề xuất 3' }] });
    assert.deepEqual(preview.warnings, ['Không có đề xuất số: #999.']);
    assert.deepEqual(await receipts(), before, 'xem trước không mở biên nhận');
    await f.rollbackCase(async () => {
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='never' WHERE action='learning.decide'");
      assert.equal((await decide('auto', rid(31), { numbers: [2], decision: 'reject' })).kind, 'preview', 'sàn trong SQL: quyết định một lần luôn xem trước');
    });
    const params = { numbers: [3, 2, 999], decision: 'approve', note: '  Đúng quy trình mới.  ' };
    const applied = await decide('apply', rid(30), params, preview);
    assert.deepEqual(applied, { kind: 'applied', link: '/settings/hermes?tab=bai-hoc', result: { decision: 'approve', numbers: [2, 3], count: 2 } });
    assert.deepEqual((await rows()).filter(row => [2, 3].includes(row.seq)).map(row => [row.seq, row.status, row.via, row.note, row.announced]),
      [[2, 'approved', 'hermes_connector', 'Đúng quy trình mới.', true], [3, 'approved', 'hermes_connector', 'Đúng quy trình mới.', true]]);
    const decided = (await db.query('SELECT DISTINCT decided_by,decision_request_id FROM app_private.hermes_learning_proposals WHERE seq IN (2,3) AND organization_id=$1', [ORG])).rows;
    assert.deepEqual(decided, [{ decided_by: USER, decision_request_id: rid(30) }]);
    assert.deepEqual(await decide('apply', rid(30), params, preview), applied, 'cùng requestId ⇒ phát lại');
    assert.deepEqual(await decide('apply', rid(30), { ...params, decision: 'reject' }, preview), { kind: 'rejected', reason: 'request_conflict' });
    assert.deepEqual(await status(rid(30)), { kind: 'status', outcome: 'applied', action: 'learning.decide', result: applied.result });
    // Trang web thấy đúng quyết định qua connector.
    const view = await call('SELECT public.hermes_learning_review_v1($1::jsonb) result', [JSON.stringify({ organizationId: ORG, historyCursor: null, pendingAfterSeq: null })]);
    assert.deepEqual(view.history.filter(item => [2, 3].includes(item.seq)).map(item => [item.seq, item.via, item.decidedByName]).sort((a, b) => a[0] - b[0]),
      [[2, 'hermes_connector', 'Chủ trợ lý'], [3, 'hermes_connector', 'Chủ trợ lý']]);
  });

  await t.test('decide: số đã quyết định / không có ⇒ needs_input learning_not_pending; trộn ⇒ chỉ số còn chờ + cảnh báo; bỏ kèm lý do', async () => {
    assert.deepEqual(await decide('auto', rid(40), { numbers: [2, 1, 999], decision: 'reject' }), { kind: 'needs_input', reason: 'learning_not_pending' });
    const mixed = await decide('auto', rid(41), { numbers: [4, 3], decision: 'reject', note: 'sai quy trình thu cọc' });
    assert.deepEqual(mixed.preview.items.map(item => item.number), [4]);
    assert.equal(mixed.preview.decision, 'BỎ');
    assert.equal(mixed.preview.effect, 'Bỏ chỉ ghi nhận quyết định; bài học vẫn ở trợ lý tới khi điều phối viên gỡ.');
    assert.deepEqual(mixed.warnings, ['Đã duyệt trước đó, không đổi được: #3.']);
    const done = await decide('apply', rid(41), { numbers: [4, 3], decision: 'reject', note: 'sai quy trình thu cọc' }, mixed);
    assert.deepEqual(done.result, { decision: 'reject', numbers: [4], count: 1 });
    const rejected = await decide('auto', rid(42), { numbers: [4, 5], decision: 'approve' });
    assert.deepEqual(rejected.warnings, ['Đã bỏ trước đó, không đổi được: #4.']);
  });

  await t.test('decide lượt 2: trạng thái đổi giữa hai lượt, bản đã giải bị đổi, ghi chú khác ⇒ state_changed, không ghi, không biên nhận', async () => {
    const params = { numbers: [5, 6], decision: 'approve' };
    const preview = await decide('auto', rid(50), params);
    await f.rollbackCase(async () => {
      await webDecide(rid(51), [await idOf(5)], 'reject');
      assert.deepEqual(await decide('apply', rid(50), params, preview), { kind: 'rejected', reason: 'state_changed' });
    });
    await f.rollbackCase(async () => {
      // Số chưa có lúc xem trước được nạp giữa hai lượt: tập còn chờ đổi ⇒ phải xem lại.
      const wider = await decide('auto', rid(52), { numbers: [6, 31], decision: 'approve' });
      await ingest([proposal(500)]);
      assert.deepEqual(await decide('apply', rid(52), { numbers: [6, 31], decision: 'approve' }, wider), { kind: 'rejected', reason: 'state_changed' });
    });
    assert.deepEqual(await decide('apply', rid(50), params, { ...preview, resolved: { ...preview.resolved, proposalIds: [await idOf(5), await idOf(7)] } }),
      { kind: 'rejected', reason: 'state_changed' }, 'bản đã giải lệch số đã xem');
    assert.deepEqual(await decide('apply', rid(50), params, { ...preview, resolved: { proposalIds: preview.resolved.proposalIds } }),
      { kind: 'rejected', reason: 'state_changed' }, 'bản đã giải thiếu số');
    assert.deepEqual(await decide('apply', rid(50), { ...params, note: 'thêm ghi chú sau khi xem' }, preview), { kind: 'rejected', reason: 'state_changed' });
    assert.deepEqual(await decide('apply', rid(50), params, { ...preview, basis: 'x'.repeat(32) }), { kind: 'rejected', reason: 'state_changed' });
    assert.equal((await receipts()).some(row => row.request_id === rid(50)), false);
    assert.deepEqual((await rows()).filter(row => [5, 6].includes(row.seq)).map(row => row.status), ['pending', 'pending']);
  });

  await t.test('quyền: thiếu users.edit (ảnh chụp hoặc cổng web sau khoá công ty), khoá tắt, kết nối thiếu khoá, binding cũ, anon ⇒ từ chối, không ghi', async () => {
    const params = { numbers: [5], decision: 'approve' };
    const preview = await decide('auto', rid(60), params);
    const cases = [
      ["UPDATE public.fixture_acl SET allowed=false WHERE permission='users.edit'", '42501'],
      ["INSERT INTO public.fixture_perm_denied VALUES('users.edit')", '42501'],
      [`UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='${KEY}'`, '42501'],
      [`UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,'${KEY}')`, '42501'],
      [`INSERT INTO public.fixture_offboarded VALUES('${USER}')`, '42501'],
    ];
    for (const [setup, expected] of cases) await f.rollbackCase(async () => {
      await db.exec(setup);
      await assert.rejects(decide('apply', rid(60), params, preview), code(expected), setup);
      await assert.rejects(digest(rid(61)), code(expected), setup);
    });
    await assert.rejects(f.learning('learning.decide', 'apply', rid(60), params, preview, { ...binding, expectedEpoch: 99 }), code('PT409'));
    await assert.rejects(f.learning('learning.digest', 'auto', rid(62), {}, {}, binding, { role: 'anon' }));
    assert.equal((await receipts()).some(row => [rid(60), rid(61), rid(62)].includes(row.request_id)), false);
    assert.equal((await rows()).find(row => row.seq === 5).status, 'pending');
  });

  await t.test('đầu vào sai ⇒ 22023 (connector đã kiểm; SQL vẫn tự kiểm), không ghi', async () => {
    for (const params of [{}, { numbers: [], decision: 'approve' }, { numbers: [0], decision: 'approve' }, { numbers: [5, 5], decision: 'approve' },
      { numbers: ['5'], decision: 'approve' }, { numbers: [5.5], decision: 'approve' }, { numbers: [10_000_000], decision: 'approve' },
      { numbers: Array.from({ length: 21 }, (_, n) => n + 1), decision: 'approve' }, { numbers: [5], decision: 'maybe' }, { numbers: [5] },
      { numbers: [5], decision: 'approve', note: 'x'.repeat(501) }, { numbers: [5], decision: 'approve', note: 'a\u0001b' },
      { numbers: [5], decision: 'approve', note: 5 }, { numbers: [5], decision: 'approve', extra: true }])
      await assert.rejects(decide('auto', rid(70), params), code('22023'), JSON.stringify(params));
    for (const [action, phase] of [[null, 'auto'], ['learning.decide', null], ['learning.decide', 'write'], ['learning.nope', 'auto']])
      await assert.rejects(f.learning(action, phase, rid(71), { numbers: [5], decision: 'approve' }), error => ['22023', '42501'].includes(error.code), `${action} ${phase}`);
    await assert.rejects(decide('apply', rid(72), { numbers: [5], decision: 'approve' }, { resolved: ['x'], basis: 'x' }), code('22023'));
    await assert.rejects(decide('apply', rid(72), { numbers: [5], decision: 'approve' }, { resolved: {} }), code('22023'));
    assert.equal((await receipts()).some(row => [rid(70), rid(71), rid(72)].includes(row.request_id)), false);
  });

  await t.test('guard bất biến: đã báo chỉ một lần khi còn chờ; quyết định giữ mốc đã báo; nội dung, quyết định lại, xoá vẫn bị chặn', async () => {
    const pendingAnnounced = await idOf(5), decidedAnnounced = await idOf(2);
    const [{ id: fresh }] = (await ingest([proposal(600)])).inserted;
    for (const [query, params] of [
      ['UPDATE app_private.hermes_learning_proposals SET announced_at=clock_timestamp() WHERE id=$1', [pendingAnnounced]],
      ['UPDATE app_private.hermes_learning_proposals SET announced_at=NULL WHERE id=$1', [pendingAnnounced]],
      ['UPDATE app_private.hermes_learning_proposals SET announced_at=clock_timestamp() WHERE id=$1', [decidedAnnounced]],
      ['UPDATE app_private.hermes_learning_proposals SET announced_at=NULL WHERE id=$1', [decidedAnnounced]],
      ['UPDATE app_private.hermes_learning_proposals SET announced_at=clock_timestamp(),title=$2 WHERE id=$1', [fresh, 'đổi lúc báo']],
      ['UPDATE app_private.hermes_learning_proposals SET content=$2 WHERE id=$1', [fresh, 'sửa lén']],
      // Quyết định kèm đổi mốc đã báo trong cùng câu.
      [`UPDATE app_private.hermes_learning_proposals SET status='approved',decided_by=$2,decided_at=clock_timestamp(),decision_via='crm_ui',
        decision_request_id=$3,announced_at=clock_timestamp() WHERE id=$1`, [pendingAnnounced, USER, id('7')]],
      ["UPDATE app_private.hermes_learning_proposals SET status='rejected' WHERE id=$1", [decidedAnnounced]],
      ['DELETE FROM app_private.hermes_learning_proposals WHERE id=$1', [fresh]],
    ]) await assert.rejects(db.query(query, params), code('55000'), query);
    // Đúng bước được phép: trống → có mốc khi còn chờ (đường của learning.digest), rồi quyết định giữ nguyên mốc đó.
    await db.query('UPDATE app_private.hermes_learning_proposals SET announced_at=clock_timestamp() WHERE id=$1', [fresh]);
    const mark = (await db.query('SELECT announced_at FROM app_private.hermes_learning_proposals WHERE id=$1', [fresh])).rows[0].announced_at;
    await webDecide(rid(80), [fresh], 'approve');
    assert.deepEqual((await db.query('SELECT status,announced_at FROM app_private.hermes_learning_proposals WHERE id=$1', [fresh])).rows[0], { status: 'approved', announced_at: mark });
  });
});
