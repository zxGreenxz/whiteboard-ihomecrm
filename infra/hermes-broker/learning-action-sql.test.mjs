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
// Khung giờ tin tối (20261111015658, áp SAU file của đợt 3 như thứ tự phát hành): lượt GHI của learning.digest chỉ được nhận khi đồng hồ
// database nằm trong [20:55:00, 21:10:00) giờ Asia/Ho_Chi_Minh. Bộ test phải chạy được ở giờ bất kỳ nên fixture (superuser PGlite) thay
// hàm KHÔNG tham số hermes_learning_digest_window_open_v1 bằng bản luôn mở ngay sau khi áp file; các test khung giờ tự đặt mốc cố định
// (qua phép so thuần THẬT) hoặc trả lại bản thật của migration. Production không có đường thay này: hàm không tham số, không đọc GUC /
// header, chỉ chủ hàm (postgres, qua migration) đổi được thân.
// Kiểm đột biến: HERMES_LEARNING_ACTION_SQL_MUTATION=<tên trong MUTATIONS hoặc WINDOW_MUTATIONS> sửa SQL CHỈ trong bộ nhớ của lần chạy
// này ⇒ test phải đỏ. Bước đang chạy sau setup là thân của file khung giờ, nên đột biến thân bước / GRANT bước trong MUTATIONS áp cho CẢ
// bản sao ở file khung giờ (ghim md5 của khối $requires$ tính lại theo hai thân đã đột biến — như người sửa có cập nhật ghim).
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
// md5 thân bước DEFINER của 20261105025453 (prosrc, bỏ CR) — tính từ file đã phát hành; file khung giờ ghim đúng md5 này làm "thân đang chạy".
const RUNNING_STEP = '64102acc22a0369df53745da554d8247';
const STEP_GRANT = 'GRANT EXECUTE ON FUNCTION app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text) TO authenticated;';
const WINDOW_GUARD = "IF v_write AND p_action='learning.digest' AND app_private.hermes_learning_digest_window_open_v1() IS NOT TRUE THEN";
// Tắt khối $check$ tự kiểm của file khung giờ: đột biến phép so / quyền phải đỏ ở TEST, không chỉ ở khối tự kiểm lúc áp migration.
const CHECK_OFF = ["RAISE EXCEPTION 'hermes_learning_digest_window_check_failed'; END IF;", 'NULL; END IF;'];
// Đột biến của file khung giờ (20261111015658): mỗi tên = danh sách cặp [gốc, thay], mỗi chuỗi gốc xuất hiện đúng một lần.
const WINDOW_MUTATIONS = {
  // Bỏ cổng khung giờ: learning.digest lại đánh dấu ở giờ bất kỳ.
  'window-no-guard': [[WINDOW_GUARD, 'IF false THEN']],
  // Chỉ chặn lượt auto: lượt apply (chính sách siết always, hoặc gọi thẳng phase apply) vẫn đánh dấu ngoài khung.
  'window-auto-only': [[WINDOW_GUARD, `IF p_phase='auto' AND ${WINDOW_GUARD.slice(3)}`]],
  // Chặn cả learning.decide: duyệt qua Zalo chỉ còn làm được trong khung giờ.
  'window-guard-all-actions': [[WINDOW_GUARD, 'IF v_write AND app_private.hermes_learning_digest_window_open_v1() IS NOT TRUE THEN']],
  // Chặn cả xem trước chỉ đọc.
  'window-guard-preview': [[WINDOW_GUARD, "IF p_action='learning.digest' AND app_private.hermes_learning_digest_window_open_v1() IS NOT TRUE THEN"]],
  // Xét khung giờ TRƯỚC phát lại: requestId đã ghi gọi lại ngoài khung mất tin cũ.
  'window-guard-before-replay': [['IF v_write AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts',
    "IF v_write AND (p_action<>'learning.digest' OR app_private.hermes_learning_digest_window_open_v1()) AND EXISTS(SELECT 1 FROM app_private.hermes_action_receipts"]],
  'window-start-exclusive': [[">='20:55:00'::time", ">'20:55:00'::time"], CHECK_OFF],
  'window-end-inclusive': [["<'21:10:00'::time", "<='21:10:00'::time"], CHECK_OFF],
  // Dùng TimeZone của phiên thay vì giờ Việt Nam (PostgREST nhận Prefer: timezone=… của bên gọi).
  'window-session-zone': [["SELECT COALESCE((p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time>=", 'SELECT COALESCE(p_at::time>='],
    ["AND (p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time<", 'AND p_at::time<'], CHECK_OFF],
  'window-null-open': [["'21:10:00'::time,false)", "'21:10:00'::time,true)"], CHECK_OFF],
  // Hàm không tham số không còn đọc đồng hồ database.
  'window-open-always': [['SELECT app_private.hermes_learning_digest_window_v1(clock_timestamp())', 'SELECT true']],
  'window-helper-grant-authenticated': [[STEP_GRANT, `${STEP_GRANT}\nGRANT EXECUTE ON FUNCTION app_private.hermes_learning_digest_window_open_v1() TO authenticated;`], CHECK_OFF],
  'window-helper-grant-public': [[STEP_GRANT, `${STEP_GRANT}\nGRANT EXECUTE ON FUNCTION app_private.hermes_learning_digest_window_v1(timestamptz) TO PUBLIC;`], CHECK_OFF],
  // Không ghim md5 thân bước ⇒ bước bị sửa ngoài migration vẫn bị đè im lặng; chỉ nhận thân đang chạy ⇒ file không chạy lại được.
  'window-step-no-pin': [[" OR v_step NOT IN ('64102acc22a0369df53745da554d8247','", " OR false AND v_step NOT IN ('64102acc22a0369df53745da554d8247','"]],
  'window-pin-only-running': [["IF v_step IS NULL OR v_step NOT IN ('64102acc22a0369df53745da554d8247',", "IF v_step IS NULL OR v_step NOT IN ('64102acc22a0369df53745da554d8247') OR false AND v_step IN ("]],
};
const mutationName = process.env.HERMES_LEARNING_ACTION_SQL_MUTATION;
assert(!mutationName || Object.hasOwn(MUTATIONS, mutationName) || Object.hasOwn(WINDOW_MUTATIONS, mutationName), `unknown mutation ${mutationName}`);
// Thân guard (prosrc, bỏ CR) và md5 của nó — khối $requires$ ghim md5 thân đang chạy (041523) và thân mới của file này.
const guardBody = sql => /CREATE OR REPLACE FUNCTION app_private\.hermes_learning_guard_v1\(\)[\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/.exec(sql)[1];
const md5 = text => createHash('md5').update(text.replaceAll('\r', '')).digest('hex');
// Đo trên production và TEST 05/11 (review #391): md5 thân guard đang chạy = thân của 20261031041523.
const RUNNING_GUARD = '54e4b8fc6831348bd4e2df411bde6fdb';
const mutate = sql => {
  if (!mutationName || !Object.hasOwn(MUTATIONS, mutationName)) return sql;
  const [from, to] = MUTATIONS[mutationName];
  assert.equal(sql.split(from).length, 2, `${mutationName}: chuỗi gốc phải xuất hiện đúng một lần`);
  const mutated = sql.replace(from, () => to);
  // Đột biến thân guard (guard-*) mô phỏng người sửa guard CÓ cập nhật ghim "thân mới" ở $requires$: phải đỏ ở test hành vi của guard,
  // không phải ở ghim md5 (ghim có test và đột biến riêng: guard-no-pin, guard-pin-only-running).
  const before = md5(guardBody(sql)), after = md5(guardBody(mutated));
  return before === after ? mutated : mutated.replace(`'${before}')`, () => `'${after}')`);
};
const RESOLVE = migration('hermes_write_name_resolve_v1'), FOUNDATION = migration('hermes_action_foundation_v1');
const ACTION_SOURCE = migration('hermes_learning_action_v1'), WINDOW_SOURCE = migration('hermes_learning_digest_window_v1');
const STORE = migration('hermes_learning_proposals_v1'), ACTION = mutate(ACTION_SOURCE);
// Thân bước DEFINER (prosrc) và câu CREATE đầy đủ của nó trong một file.
const stepBody = sql => /CREATE OR REPLACE FUNCTION app_private\.hermes_learning_action_step_v1\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/.exec(sql)[1];
const stepOf = sql => /CREATE OR REPLACE FUNCTION app_private\.hermes_learning_action_step_v1\([\s\S]*?\$fn\$;/.exec(sql)[0];
const NEW_STEP = md5(stepBody(WINDOW_SOURCE));
// File khung giờ của lần chạy này: đột biến của chính nó, hoặc đột biến thân bước / GRANT bước của MUTATIONS áp cho bản sao của bước ở
// đây (chuỗi gốc có trong file thì phải có đúng một lần); rồi ghim md5 ở $requires$ tính lại theo hai thân đang dùng.
const mutateWindow = sql => {
  let mutated = sql;
  if (mutationName && Object.hasOwn(MUTATIONS, mutationName)) {
    const [from, to] = MUTATIONS[mutationName];
    const hits = sql.split(from).length - 1;
    assert.ok(hits <= 1, `${mutationName}: chuỗi gốc xuất hiện ${hits} lần trong file khung giờ`);
    if (hits === 1) mutated = sql.replace(from, () => to);
  } else if (mutationName) {
    for (const [from, to] of WINDOW_MUTATIONS[mutationName]) {
      assert.equal(mutated.split(from).length, 2, `${mutationName}: chuỗi gốc phải xuất hiện đúng một lần: ${from}`);
      mutated = mutated.replace(from, () => to);
    }
  }
  return mutated.replaceAll(RUNNING_STEP, md5(stepBody(ACTION))).replaceAll(NEW_STEP, md5(stepBody(mutated)));
};
const WINDOW = mutateWindow(WINDOW_SOURCE);
const REVERT_SOURCE = readFileSync('docs/plans/hermes-crm/revert/hermes_learning_digest_window_revert_v1.sql', 'utf8').replaceAll('\r\n', '\n');
// Chạy một file migration BÊN TRONG giao dịch của rollbackCase: bỏ BEGIN / COMMIT của chính file.
const plain = sql => sql.replace(/^BEGIN;|^COMMIT;/gm, '');
const KEY = 'assistant.learning_review';
const SHELL = 'public.hermes_learning_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)';
const STEP = 'app_private.hermes_learning_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text)';
const WINDOW_PURE = 'app_private.hermes_learning_digest_window_v1(timestamptz)';
const WINDOW_OPEN = 'app_private.hermes_learning_digest_window_open_v1()';
// Bản thay của fixture cho hàm KHÔNG tham số: cùng chữ ký và thuộc tính với bản thật, chỉ khác thân. CREATE OR REPLACE giữ chủ hàm và ACL.
// windowAt đặt "đồng hồ" tại một mốc cố định nhưng vẫn đi qua phép so thuần THẬT của migration.
const windowAs = body => `CREATE OR REPLACE FUNCTION ${WINDOW_OPEN} RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $f$ ${body} $f$`;
const windowAt = instant => windowAs(`SELECT app_private.hermes_learning_digest_window_v1('${instant}'::timestamptz)`);
const REAL_OPEN = /CREATE OR REPLACE FUNCTION app_private\.hermes_learning_digest_window_open_v1\(\)[\s\S]*?\$fn\$;/.exec(WINDOW)[0];
const REFUSED = { kind: 'rejected', reason: 'learning_digest_outside_window' };
// Giờ Việt Nam = UTC+7 cố định (không đổi giờ mùa): phép tính độc lập với SQL để đối chiếu hàm đọc đồng hồ thật.
const vnWindow = epochSeconds => { const s = (((epochSeconds + 7 * 3600) % 86400) + 86400) % 86400; return s >= 20 * 3600 + 55 * 60 && s < 21 * 3600 + 10 * 60; };
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
  // Khung giờ tin tối, áp sau file của đợt 3 như thứ tự phát hành; cũng hai lần (lượt hai thấy thân bước mới của chính nó).
  await db.exec(WINDOW); await db.exec(WINDOW);
  // Từ đây cổng khung giờ luôn mở trong fixture để các test sẵn có chạy được ở giờ bất kỳ; test khung giờ tự đặt mốc / trả lại bản thật.
  await db.exec(windowAs('SELECT true'));
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
  // Ảnh chụp MỌI bảng của public / app_private / auth (số dòng + băm nội dung từng dòng): "không dòng nào đổi" là so hai ảnh chụp.
  const snapshot = async () => {
    const tables = (await db.query(`SELECT n.nspname s,c.relname r FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','app_private','auth') ORDER BY 1,2`)).rows;
    const parts = tables.map(({ s, r }) => `SELECT '${s}.${r}' t,count(*)::int n,COALESCE(md5(string_agg(md5(x::text),'' ORDER BY md5(x::text))),'') h FROM "${s}"."${r}" x`);
    return Object.fromEntries((await db.query(parts.join(' UNION ALL '))).rows.map(row => [row.t, `${row.n}:${row.h}`]));
  };
  const changed = (before, after) => Object.keys({ ...before, ...after }).filter(table => before[table] !== after[table]).sort();
  return { ...f, learning, digest, decide, status, ingest, webDecide, rows, idOf, receipts, activate, snapshot, changed };
}

test('đợt 3 học có kiểm duyệt: learning.digest / learning.decide trên khung thao tác chung', { timeout: 240000 }, async t => {
  const f = await learningSetup(t);
  const { db, call, digest, decide, status, ingest, webDecide, rows, idOf, receipts, snapshot, changed } = f;

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

  // ───── Khung giờ tin tối (20261111015658). Tới đây công ty không còn đề xuất chờ CHƯA báo; mỗi ca tự nạp đề xuất mới trong rollbackCase.
  const pureOpen = async instant => (await db.query('SELECT app_private.hermes_learning_digest_window_v1($1::text::timestamptz) open', [instant])).rows[0].open;
  const stepMd5 = async () => (await db.query(`SELECT md5(replace(prosrc,chr(13),'')) md5 FROM pg_proc WHERE oid='${STEP}'::regprocedure`)).rows[0].md5;
  const announcedOf = async seq => (await rows()).find(row => row.seq === seq).announced;
  // Năm mốc biên của đề bài, viết bằng giờ Việt Nam có múi tường minh.
  const BOUNDS = [['2026-11-11 20:54:59+07', false], ['2026-11-11 20:55:00+07', true], ['2026-11-11 21:09:59+07', true],
    ['2026-11-11 21:10:00+07', false], ['2026-11-11 21:10:01+07', false]];

  await t.test('khung giờ — phép so thuần: [20:55:00, 21:10:00) giờ Việt Nam, đầu tính cuối không; TimeZone của phiên không dời được khung; NULL ⇒ đóng', async () => {
    const CASES = [...BOUNDS, ['2026-11-11 20:54:59.999999+07', false], ['2026-11-11 21:00:00+07', true], ['2026-11-11 21:09:59.999999+07', true],
      // Sáng 11/11 (giờ của lượt chạy tay làm mất tin), đầu và cuối ngày.
      ['2026-11-11 08:18:00+07', false], ['2026-11-11 00:00:00+07', false], ['2026-11-11 23:59:59.999999+07', false],
      // Cùng các mốc ấy viết theo múi khác.
      ['2026-11-11 13:54:59Z', false], ['2026-11-11 13:55:00Z', true], ['2026-11-11 14:09:59Z', true], ['2026-11-11 14:10:00Z', false],
      ['2026-11-11 08:55:00-05', true], ['2026-11-12 03:09:59+13', true], ['2026-11-12 03:10:00+13', false],
      // 20:55–21:10 theo đồng hồ của múi KHÁC không phải khung.
      ['2026-11-11 20:55:00Z', false], ['2026-11-11 21:00:00Z', false], ['2026-11-11 21:00:00-05', false], ['2026-11-11 21:00:00+14', false],
      // Khung lặp mỗi ngày.
      ['2024-02-29 21:09:59+07', true], ['2027-02-28 20:55:00+07', true], ['2027-03-14 21:10:00+07', false]];
    // Đối chứng cho từng TimeZone: 20:55 giờ Việt Nam đọc theo đồng hồ của phiên — phiên thật sự đổi múi, phép so thuần vẫn cho cùng kết quả.
    for (const [zone, wall] of [[null, null], ['UTC', '13:55:00'], ['Asia/Ho_Chi_Minh', '20:55:00'], ['America/New_York', '08:55:00'], ['Pacific/Kiritimati', '03:55:00']])
      await f.rollbackCase(async () => {
        if (zone) {
          await db.exec(`SET LOCAL TimeZone='${zone}'`);
          assert.equal((await db.query("SELECT ('2026-11-11 20:55:00+07'::timestamptz)::time::text wall")).rows[0].wall, wall, `phiên ${zone} đã đổi múi`);
        }
        for (const [instant, expected] of CASES) assert.equal(await pureOpen(instant), expected, `${instant} @ phiên ${zone ?? 'mặc định'}`);
        assert.equal((await db.query('SELECT app_private.hermes_learning_digest_window_v1(NULL) open')).rows[0].open, false, 'NULL ⇒ đóng');
      });
    // Mốc KHÔNG ghi múi: Postgres hiểu theo TimeZone của phiên lúc đổi sang timestamptz — vẫn là một mốc tuyệt đối trước khi vào hàm.
    await f.rollbackCase(async () => {
      await db.exec("SET LOCAL TimeZone='UTC'");
      assert.deepEqual([await pureOpen('2026-11-11 20:55:00'), await pureOpen('2026-11-11 13:55:00'), await pureOpen('2026-11-11 14:09:59'), await pureOpen('2026-11-11 14:10:00')],
        [false, true, true, false]);
    });
  });

  await t.test('khung giờ — hàm không tham số THẬT đọc đồng hồ database: khớp phép tính độc lập, TimeZone của phiên không dời được; digest thật theo đúng đồng hồ', async () => {
    await f.rollbackCase(async () => {
      await db.exec(REAL_OPEN);
      const flags = (await db.query(`SELECT p.proname fn,p.pronargs::int nargs,p.provolatile::text volatility,p.prosecdef definer,p.proconfig::text config,
        pg_get_userbyid(p.proowner) owner,p.prorettype::regtype::text returns,btrim(p.prosrc,E' \\n') body FROM pg_proc p
        WHERE p.oid IN ('${WINDOW_PURE}'::regprocedure,'${WINDOW_OPEN}'::regprocedure) ORDER BY 1`)).rows;
      assert.deepEqual(flags, [
        // Không tham số: bên gọi không truyền được mốc giờ. Thân chỉ gọi phép so thuần trên clock_timestamp().
        { fn: 'hermes_learning_digest_window_open_v1', nargs: 0, volatility: 'v', definer: false, config: '{search_path=pg_catalog}', owner: 'postgres', returns: 'boolean',
          body: 'SELECT app_private.hermes_learning_digest_window_v1(clock_timestamp())' },
        { fn: 'hermes_learning_digest_window_v1', nargs: 1, volatility: 'i', definer: false, config: '{search_path=pg_catalog}', owner: 'postgres', returns: 'boolean',
          body: "SELECT COALESCE((p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time>='20:55:00'::time\n    AND (p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time<'21:10:00'::time,false)" }]);
      // Không GUC, không header, không bảng: hai hàm khung giờ không đọc gì ngoài tham số / đồng hồ.
      for (const source of [/CREATE OR REPLACE FUNCTION app_private\.hermes_learning_digest_window_v1\(p_at timestamptz\)[\s\S]*?\$fn\$;/.exec(WINDOW_SOURCE)[0], REAL_OPEN])
        assert.doesNotMatch(source, /current_setting|set_config|request\.|\bFROM\b/i);
      // Đồng hồ database đọc ngay trước và ngay sau trong cùng một câu; hai mốc cùng phía của biên thì kết quả phải khớp phép tính ở JS.
      const probe = async () => (await db.query(`SELECT extract(epoch FROM clock_timestamp())::float8 before,
        app_private.hermes_learning_digest_window_open_v1() open,extract(epoch FROM clock_timestamp())::float8 after`)).rows[0];
      const agrees = async label => {
        const seen = await probe();
        if (vnWindow(seen.before) === vnWindow(seen.after)) assert.equal(seen.open, vnWindow(seen.before), label);
        return seen;
      };
      const now = await agrees('phiên mặc định');
      // Đặt TimeZone của phiên sao cho đồng hồ phiên đọc 21:02 (giữa khung) — và 09:02 (ngoài khung): kết quả vẫn theo giờ Việt Nam.
      for (const target of [21 * 3600 + 120, 9 * 3600 + 120]) {
        const shift = Math.round((((target - (now.before % 86400)) % 86400 + 86400 + 43200) % 86400 - 43200) / 60);
        const sign = shift < 0 ? '-' : '+', hh = String(Math.floor(Math.abs(shift) / 60)).padStart(2, '0'), mm = String(Math.abs(shift) % 60).padStart(2, '0');
        await db.exec(`SET LOCAL TIME ZONE INTERVAL '${sign}${hh}:${mm}' HOUR TO MINUTE`);
        const wall = (await db.query("SELECT to_char(clock_timestamp(),'HH24:MI') wall")).rows[0].wall;
        assert.match(wall, target > 12 * 3600 ? /^21:0[1-4]$/ : /^09:0[1-4]$/, 'đồng hồ của phiên đã dời');
        await agrees(`phiên dời ${sign}${hh}:${mm}`);
      }
      for (const zone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York']) { await db.exec(`SET LOCAL TimeZone='${zone}'`); await agrees(`phiên ${zone}`); }
      await db.exec('RESET TimeZone');
      // Cả đường RPC với hàm thật: kết quả của learning.digest theo đúng đồng hồ lúc chạy test (trong khung ⇒ ghi; ngoài khung ⇒ từ chối).
      const [fresh] = (await ingest([proposal(690)])).inserted;
      const before = await probe(), outcome = await digest(rid(89)), after = await probe();
      if (vnWindow(before.before) === vnWindow(after.after)) {
        if (vnWindow(before.before)) assert.deepEqual([outcome.kind, outcome.result.items.map(item => item.seq), await announcedOf(fresh.seq)], ['applied', [fresh.seq], true]);
        else assert.deepEqual([outcome, await announcedOf(fresh.seq)], [REFUSED, false]);
      }
    });
    // Ra khỏi ca: fixture trở lại bản luôn mở.
    assert.equal((await db.query(`SELECT btrim(prosrc,E' \\n') body FROM pg_proc WHERE oid='${WINDOW_OPEN}'::regprocedure`)).rows[0].body, 'SELECT true');
  });

  await t.test('khung giờ — ngoài khung: lượt ghi của learning.digest bị từ chối và KHÔNG dòng nào đổi; xem trước vẫn chỉ đọc; phát lại vẫn trả kết quả cũ; trong khung y như trước', async () => {
    await f.rollbackCase(async () => {
      const [a, b] = (await ingest([proposal(700), proposal(701, { kind: 'audit_warning' })])).inserted;
      // 08:18 giờ Việt Nam = giờ của lượt chạy tay sáng 11/11 đã làm ba đề xuất rời khỏi tin tối.
      await db.exec(windowAt('2026-11-11 08:18:00+07'));
      const before = await snapshot();
      const preview = await digest(rid(90), 'preview');
      assert.deepEqual([preview.kind, preview.confirm, preview.preview], ['preview', 'required', { action: 'learning.digest', newCount: 2 }], 'xem trước không bị khung giờ chặn');
      assert.deepEqual(await digest(rid(90)), REFUSED, 'lượt auto (chính sách never = lượt ghi)');
      assert.deepEqual(await digest(rid(90)), REFUSED, 'gọi lại cùng requestId: vẫn từ chối, không có gì để phát lại');
      assert.deepEqual(await digest(rid(91)), REFUSED, 'requestId khác');
      assert.deepEqual(await digest(rid(90), 'apply', { resolved: preview.resolved, basis: preview.basis }), REFUSED, 'apply đúng basis của bản xem trước');
      assert.deepEqual(await digest(rid(90), 'apply', { resolved: {}, basis: 'khác' }), REFUSED, 'apply lệch basis: khung giờ xét trước basis');
      assert.deepEqual(changed(before, await snapshot()), [], 'xem trước và mọi lượt bị từ chối không đổi dòng nào ở bất kỳ bảng nào');
      for (const requestId of [rid(90), rid(91)]) assert.deepEqual(await status(requestId), { kind: 'status', outcome: 'not_found' }, 'không biên nhận');
      assert.deepEqual([await announcedOf(a.seq), await announcedOf(b.seq)], [false, false]);
      // Quyền vẫn xét TRƯỚC khung giờ: người không còn quyền nhận 42501 như cũ, không phải mã khung giờ.
      await db.exec("SAVEPOINT denied; INSERT INTO public.fixture_perm_denied VALUES('users.edit')");
      await assert.rejects(digest(rid(91)), code('42501'));
      await db.exec('ROLLBACK TO SAVEPOINT denied');
      // Vào khung: đúng các đề xuất ấy được báo, kết quả đúng khuôn cũ — và ảnh chụp thấy đúng các bảng mà một lượt ghi chạm tới.
      await db.exec(windowAt('2026-11-11 21:00:00+07'));
      const applied = await digest(rid(90));
      assert.deepEqual([applied.kind, applied.link, Object.keys(applied.result).sort(), applied.result.items.map(item => [item.seq, item.kind])],
        ['applied', '/settings/hermes?tab=bai-hoc', ['announcedAt', 'items', 'pendingTotal'], [[a.seq, 'skill_crm_write'], [b.seq, 'audit_warning']]]);
      assert.match(applied.result.announcedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.deepEqual(presentLearningDigest(applied.result, { webOrigin: 'https://crm.example.vn' }).numbers, [a.seq, b.seq]);
      const after = await snapshot();
      assert.deepEqual(changed(before, after), ['app_private.hermes_action_receipts', 'app_private.hermes_learning_proposals', 'public.authorization_audit_events'],
        'đối chứng: ảnh chụp bắt được lượt ghi (biên nhận, đề xuất, dòng audit của lượt ghi)');
      assert.deepEqual([await announcedOf(a.seq), await announcedOf(b.seq)], [true, true]);
      // Hết khung: requestId ĐÃ có biên nhận vẫn phát lại đúng kết quả cũ (lượt gọi lại của chính job tối không mất tin) và không ghi gì;
      // requestId mới bị từ chối dù có đề xuất mới đang chờ.
      await db.exec(windowAt('2026-11-11 21:10:00+07'));
      assert.deepEqual(await digest(rid(90)), applied, 'phát lại ngoài khung');
      assert.deepEqual(await status(rid(90)), { kind: 'status', outcome: 'applied', action: 'learning.digest', result: applied.result });
      assert.deepEqual(changed(after, await snapshot()), [], 'phát lại không đổi dòng nào');
      const [late] = (await ingest([proposal(702)])).inserted;
      const mid = await snapshot();
      assert.deepEqual(await digest(rid(92)), REFUSED);
      assert.deepEqual([changed(mid, await snapshot()), await announcedOf(late.seq)], [[], false]);
    });
    // Chính sách siết always: auto chỉ là xem trước (không ghi) ở giờ bất kỳ; lượt apply mới là lượt ghi ⇒ chịu khung giờ.
    await f.rollbackCase(async () => {
      const [fresh] = (await ingest([proposal(710)])).inserted;
      await db.query("UPDATE app_private.hermes_action_policies SET confirm='always' WHERE action='learning.digest'");
      await db.exec(windowAt('2026-11-11 21:10:01+07'));
      const before = await snapshot();
      const preview = await digest(rid(93));
      assert.deepEqual([preview.kind, preview.confirm, preview.preview], ['preview', 'required', { action: 'learning.digest', newCount: 1 }]);
      assert.deepEqual(await digest(rid(93), 'apply', { resolved: preview.resolved, basis: preview.basis }), REFUSED);
      assert.deepEqual([changed(before, await snapshot()), await announcedOf(fresh.seq)], [[], false]);
      await db.exec(windowAt('2026-11-11 20:55:00+07'));
      const applied = await digest(rid(93), 'apply', { resolved: preview.resolved, basis: preview.basis });
      assert.deepEqual([applied.kind, applied.result.items.map(item => item.seq), await announcedOf(fresh.seq)], ['applied', [fresh.seq], true]);
    });
    // learning.decide không chịu khung giờ: duyệt qua Zalo lúc nào cũng được (xem trước rồi ghi).
    await f.rollbackCase(async () => {
      await db.exec(windowAt('2026-11-11 08:18:00+07'));
      const params = { numbers: [5], decision: 'approve' };
      const preview = await decide('auto', rid(94), params);
      assert.equal(preview.kind, 'preview');
      assert.deepEqual(await decide('apply', rid(94), params, preview),
        { kind: 'applied', link: '/settings/hermes?tab=bai-hoc', result: { decision: 'approve', numbers: [5], count: 1 } });
      assert.equal((await rows()).find(row => row.seq === 5).status, 'approved');
    });
  });

  await t.test('khung giờ — biên qua RPC thật, ở từng TimeZone của phiên: 20:54:59 ngoài · 20:55:00 trong · 21:09:59 trong · 21:10:00 ngoài · 21:10:01 ngoài', async () => {
    let n = 100;
    for (const zone of [null, 'UTC', 'America/New_York']) for (const [instant, open] of BOUNDS) await f.rollbackCase(async () => {
      if (zone) await db.exec(`SET LOCAL TimeZone='${zone}'`);
      const [fresh] = (await ingest([proposal(720)])).inserted;
      await db.exec(windowAt(instant));
      const before = await snapshot();
      const outcome = await digest(rid(n++));
      const label = `${instant} @ phiên ${zone ?? 'mặc định'}`;
      if (open) assert.deepEqual([outcome.kind, outcome.result.items.map(item => item.seq), await announcedOf(fresh.seq)], ['applied', [fresh.seq], true], label);
      else assert.deepEqual([outcome, changed(before, await snapshot()), await announcedOf(fresh.seq)], [REFUSED, [], false], label);
    });
  });

  await t.test('khung giờ — quyền: hai hàm khung giờ chỉ chủ hàm gọi và đổi được (không vai API / runtime nào, không PUBLIC); bước giữ đúng GRANT cũ', async () => {
    const grantees = (await db.query(`SELECT p.proname fn, COALESCE(string_agg(g.role, ',' ORDER BY g.role),'') roles FROM pg_proc p
      LEFT JOIN LATERAL (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE') g ON true
      WHERE p.oid IN ('${STEP}'::regprocedure,'${WINDOW_PURE}'::regprocedure,'${WINDOW_OPEN}'::regprocedure) GROUP BY 1 ORDER BY 1`)).rows;
    assert.deepEqual(grantees, [{ fn: 'hermes_learning_action_step_v1', roles: 'authenticated,postgres' },
      { fn: 'hermes_learning_digest_window_open_v1', roles: 'postgres' }, { fn: 'hermes_learning_digest_window_v1', roles: 'postgres' }]);
    const reach = (await db.query(`SELECT r.role_name||' '||p.proname who FROM pg_proc p
      CROSS JOIN unnest(ARRAY['anon','authenticated','service_role','hermes_store_executor','hermes_learning_ingest']) r(role_name)
      WHERE p.oid IN ('${WINDOW_PURE}'::regprocedure,'${WINDOW_OPEN}'::regprocedure) AND has_function_privilege(r.role_name::name,p.oid,'EXECUTE') ORDER BY 1`)).rows;
    assert.deepEqual(reach, []);
    // hermes_learning_ingest có USAGE trên app_private (đường nạp đề xuất) nhưng không gọi, không thay được hàm khung giờ; authenticated
    // còn không vào được schema. Bản thay "luôn mở" của fixture chỉ làm được vì db.exec chạy bằng superuser của PGlite.
    const forged = windowAs('SELECT true');
    for (const [role, pattern] of [['hermes_learning_ingest', /permission denied|must be owner/], ['authenticated', /schema app_private/], ['anon', /schema app_private/]]) {
      for (const sql of ['SELECT app_private.hermes_learning_digest_window_open_v1() result', "SELECT app_private.hermes_learning_digest_window_v1('2026-11-11 21:00:00+07'::timestamptz) result",
        forged, `ALTER FUNCTION ${WINDOW_OPEN} OWNER TO ${role}`, `DROP FUNCTION ${WINDOW_OPEN}`])
        await assert.rejects(call(sql, [], { role, actor: role === 'authenticated' ? USER : '' }),
          error => error.code === '42501' && pattern.test(error.message), `${role}: ${sql.slice(0, 60)}`);
    }
    assert.equal(await stepMd5(), md5(stepBody(WINDOW)), 'bước đang chạy = thân của file khung giờ');
  });

  await t.test('khung giờ — $requires$ ghim md5 thân bước trước khi đè: thân 025453 đang chạy hoặc thân mới (chạy lại) qua, thân khác ⇒ dừng; thân mới = thân cũ + đúng một khối IF', async () => {
    const requires = /DO \$requires\$[\s\S]*?END \$requires\$;/.exec(WINDOW)[0];
    assert.equal(md5(stepBody(ACTION_SOURCE)), RUNNING_STEP, 'md5 thân bước của 20261105025453 = md5 file khung giờ ghim làm "thân đang chạy"');
    assert.ok(WINDOW_SOURCE.includes(`v_step NOT IN ('${RUNNING_STEP}','${NEW_STEP}')`), 'file ghim đúng md5 thân mới của chính nó');
    // Thân mới = thân 025453 từng ký tự + ĐÚNG một khối (chú thích + IF) ngay sau khối phát lại theo requestId.
    const block = /\n  -- Khung giờ tin tối \(20261111015658\)[^\n]*\n  --[^\n]*\n  --[^\n]*\n  IF v_write AND p_action='learning\.digest' AND app_private\.hermes_learning_digest_window_open_v1\(\) IS NOT TRUE THEN\n    RETURN jsonb_build_object\('kind','rejected','reason','learning_digest_outside_window'\);\n  END IF;/;
    const [cut] = block.exec(stepBody(WINDOW_SOURCE));
    assert.equal(stepBody(WINDOW_SOURCE).replace(cut, () => ''), stepBody(ACTION_SOURCE));
    assert.ok(stepBody(WINDOW_SOURCE).includes(`RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409';\n  END IF;${cut}\n\n  IF p_action='learning.digest' THEN`), 'khối IF nằm ngay sau khối phát lại, trước mọi phép đọc / ghi của digest');
    // Chữ ký, kiểu trả về, thuộc tính của bước không đổi so với 025453.
    const head = sql => stepOf(sql).slice(0, stepOf(sql).indexOf('AS $fn$'));
    assert.equal(head(WINDOW_SOURCE), head(ACTION_SOURCE));
    await f.rollbackCase(async () => {
      // Setup đã chạy file hai lần: lượt hai thấy thân mới của chính file và qua.
      assert.equal(await stepMd5(), md5(stepBody(WINDOW)));
      await db.exec(requires);
      // Lượt đầu trên production / TEST: thân 025453 đang chạy.
      await db.exec(stepOf(ACTION));
      assert.equal(await stepMd5(), md5(stepBody(ACTION)));
      await db.exec(requires);
      // Có người sửa bước ngoài migration (ở đây chỉ thêm một chú thích) ⇒ dừng trước khi đè, nêu md5 lạ.
      await db.exec(stepOf(ACTION).replace(/END \$fn\$;$/, () => 'END -- sửa tay\n$fn$;'));
      await db.exec('SAVEPOINT drift');
      await assert.rejects(db.exec(requires), /hermes_learning_action_step_body_drift: [0-9a-f]{32}/);
      await db.exec('ROLLBACK TO SAVEPOINT drift');
    });
    assert.equal(await stepMd5(), md5(stepBody(WINDOW)));
  });

  await t.test('khung giờ — file lùi đã soạn: trả đúng thân 025453 (đánh dấu ở giờ bất kỳ như cũ), chạy lại được, giữ GRANT; áp lại file khung giờ ⇒ cổng trở lại', async () => {
    assert.equal(stepOf(REVERT_SOURCE), stepOf(ACTION_SOURCE), 'file lùi mang nguyên văn câu CREATE của bước ở 20261105025453');
    assert.ok(REVERT_SOURCE.includes(`v_step NOT IN ('${NEW_STEP}','${RUNNING_STEP}')`), 'file lùi ghim đúng thân nó thay (thân khung giờ) và thân nó trả về');
    // Trong lần chạy đột biến, thân đang chạy lệch md5 đã ghim ⇒ ghim của file lùi tính lại theo thân đang dùng (như mutateWindow).
    const revert = plain(REVERT_SOURCE).replaceAll(NEW_STEP, md5(stepBody(WINDOW)));
    const stepGrantees = async () => (await db.query(`SELECT COALESCE(string_agg(g.role, ',' ORDER BY g.role),'') roles FROM pg_proc p
      CROSS JOIN LATERAL (SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END role
        FROM aclexplode(p.proacl) a WHERE a.privilege_type='EXECUTE') g WHERE p.oid='${STEP}'::regprocedure`)).rows[0].roles;
    await f.rollbackCase(async () => {
      const [first, second] = (await ingest([proposal(730), proposal(731)])).inserted;
      await db.exec(windowAt('2026-11-11 08:18:00+07'));
      assert.deepEqual(await digest(rid(120)), REFUSED);
      await db.exec(revert); await db.exec(revert);
      assert.deepEqual([await stepMd5(), await stepGrantees()], [RUNNING_STEP, 'authenticated,postgres']);
      const back = await digest(rid(120));
      assert.deepEqual([back.kind, back.result.items.map(item => item.seq)], ['applied', [first.seq, second.seq]], 'sau khi lùi: hành vi cũ, không còn khung giờ');
      // Áp lại file khung giờ lên thân đã lùi (ghim nhận thân 025453) ⇒ cổng trở lại; hàm không tham số trở về bản thật nên đặt lại mốc.
      await db.exec(plain(WINDOW_SOURCE));
      await db.exec(windowAt('2026-11-11 08:18:00+07'));
      const [third] = (await ingest([proposal(732)])).inserted;
      assert.deepEqual([await stepMd5(), await digest(rid(121)), await announcedOf(third.seq)], [NEW_STEP, REFUSED, false]);
      // Bước bị sửa ngoài hai file ⇒ file lùi dừng, không đè.
      await db.exec(stepOf(WINDOW_SOURCE).replace(/END \$fn\$;$/, () => 'END -- sửa tay\n$fn$;'));
      await db.exec('SAVEPOINT drift');
      await assert.rejects(db.exec(revert), /hermes_learning_action_step_body_drift: [0-9a-f]{32}/);
      await db.exec('ROLLBACK TO SAVEPOINT drift');
    });
    assert.equal(await stepMd5(), md5(stepBody(WINDOW)));
  });
});
