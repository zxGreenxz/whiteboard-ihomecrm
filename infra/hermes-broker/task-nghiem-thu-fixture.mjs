import { setupRecurring, binding, ORG, USER, BUILDING, OTHER_BUILDING, ROOM, MANAGER, STAFF, TYPE_SUA } from './task-recurring-fixture.mjs';
import { migration, MINH, CO_OWNER, ROOM_A201, OTHER_ROOM } from './task-action-fixture.mjs';

// Lượt 11 (sửa theo nghiệm thu, 23–24/10) + 11b (review): fixture cho lõi giải tên dùng chung 20261023185114 và lõi + chuẩn bị của vỏ
// task 20261023185116, trên nền fixture Công việc (RLS jobs production, chuỗi tới 20261023042436), mỗi file hai lượt. Toà A có hai
// người quản lý (Nathan, Huy ⇒ Q31 hỏi chọn); dữ liệu nhập nhầm như production: toà "162NVK" + loại việc cùng tên, loại "ml".
export { binding, ORG, USER, BUILDING, OTHER_BUILDING, ROOM, MANAGER, STAFF, TYPE_SUA, MINH, CO_OWNER, ROOM_A201, OTHER_ROOM };
export const RESOLVE_SQL = migration('hermes_name_resolve_honorific_v1');
export const NGHIEM_THU_SQL = migration('hermes_task_nghiem_thu_v1');
export const rid = n => `00000000-0000-4000-8000-${String(8100 + n).padStart(12, '0')}`;
export const u = n => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
export const ANH_TU = u(1), TU_LE = u(2), NVK = u(3), TYPE_NVK = u(4), TYPE_ML = u(5);
const inDays = async (db, n) => (await db.query("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date+$1::int,'YYYY-MM-DD') d", [n])).rows[0].d;

export async function setupNghiemThu(t, { resolve = RESOLVE_SQL, nghiemThu = NGHIEM_THU_SQL, database } = {}) {
  const f = await setupRecurring(t, { enable: false, database });
  const { db } = f;
  for (const [label, sql] of [['20261023185114', resolve], ['20261023185116', nghiemThu]]) {
    if (!sql) continue;
    try { await db.exec(sql); await db.exec(sql); } catch (error) { error.message = `${label}: ${error.message}`; throw error; }
  }
  await db.exec(`INSERT INTO auth.users VALUES('${ANH_TU}'),('${TU_LE}') ON CONFLICT DO NOTHING;
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status,member_type) VALUES('${ANH_TU}','${ANH_TU}','${ORG}','ACTIVE','STAFF'),
      ('${TU_LE}','${TU_LE}','${ORG}','ACTIVE','STAFF');
    INSERT INTO public.profiles VALUES('${ANH_TU}','Anh Tú'),('${TU_LE}','Tú Lê') ON CONFLICT (id) DO UPDATE SET full_name=excluded.full_name;
    INSERT INTO public.fixture_member_acl VALUES('${STAFF}','tasks.edit','{${BUILDING}}') ON CONFLICT (user_id,permission) DO UPDATE SET building_ids=excluded.building_ids;
    UPDATE public.fixture_member_acl SET building_ids='{${BUILDING},${OTHER_BUILDING}}' WHERE user_id='${STAFF}' AND permission='buildings.view';
    INSERT INTO public.buildings VALUES('${NVK}','${ORG}','162NVK',false,null,null);
    INSERT INTO public.job_types VALUES('${TYPE_NVK}','${ORG}','162nvk',true),('${TYPE_ML}','${ORG}','ml',true);
    -- task.update cần khoá tasks.edit ở trần công ty + kết nối (như test Mốc 3 / 5).
    UPDATE app_private.hermes_org_policies SET action_capabilities=action_capabilities||ARRAY['tasks.edit'];
    UPDATE app_private.hermes_connections SET action_capabilities=action_capabilities||ARRAY['tasks.edit'];`);
  const deadline = `${await inDays(db, 5)} 17:00+07`;
  let n = 0;
  const job = async (title, building, room, type = TYPE_SUA) => (await db.query(`INSERT INTO public.jobs(user_id,code,title,building_id,room_id,job_type_id,priority,
      assignee_id,deadline,status,organization_id,started_at) VALUES($1,$2,$3,$4,$5,$6,'NORMAL',$7,$8::timestamptz,'IN_PROGRESS',$9,clock_timestamp()) RETURNING id`,
    [USER, `JOB-T-${String(++n).padStart(4, '0')}`, title, building, room, type, MANAGER, deadline, ORG])).rows[0].id;
  // Thêm một thành viên ACTIVE có hồ sơ (người cùng tên, bẫy danh xưng).
  const person = async (id, name) => db.exec(`INSERT INTO auth.users VALUES('${id}') ON CONFLICT DO NOTHING;
    INSERT INTO public.organization_memberships(id,user_id,organization_id,status,member_type) VALUES('${id}','${id}','${ORG}','ACTIVE','STAFF') ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles VALUES('${id}','${name.replaceAll("'", "''")}') ON CONFLICT (id) DO UPDATE SET full_name=excluded.full_name;`);
  const run = (action, phase, n, params, extra) => f.run(action, phase, rid(n), params, extra);
  const offers = async () => (await db.query('SELECT count(*)::int n FROM app_private.hermes_task_assignee_offers')).rows[0].n;
  return { ...f, job, person, run, offers };
}
