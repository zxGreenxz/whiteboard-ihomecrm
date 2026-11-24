import test from 'node:test';
import assert from 'node:assert/strict';
import { runCameraAlertsProof } from '../test-network-center-camera-disposable.mjs';

// Cảnh báo camera v2 (spec docs/superpowers/plans/2026-11-24-canh-bao-camera-v2.md §8):
// 16 mục + lịch cron trên PostgreSQL dùng một lần, rồi lật từng luật một để
// chứng minh ca tương ứng không xanh rỗng (Contract §8: quyền, cách ly org,
// migration). Mỗi phép đột biến chỉ chạy ca mà nó phải làm đỏ.
test('camera alerts v2: migration runs three times and every §8 case holds on PostgreSQL', async () => {
  const result = await runCameraAlertsProof();
  assert.equal(result.passed, true);
  assert.deepEqual(result.cases, ['cron', 'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09',
    'c10', 'c11', 'c12', 'c13', 'c14', 'c15', 'c16', 'c17']);
});

const mutations = [
  // Chống nhiễu / chống spam.
  ['closing on the first good round (no hysteresis)', ['c01'],
    'ELSIF cond.clear_streak + 1 >= 2 THEN', 'ELSIF cond.clear_streak + 1 >= 1 THEN', /lượt tốt đầu tiên chỉ được RECOVERING/],
  ['disk incidents kept under an OFFLINE recorder (B2)', ['c02'],
    "PERFORM app_private.camera_alert_retire_v1(cond, 'SUPERSEDED', p_now);", 'NULL;', /SUPERSEDED/],
  ['an IGNORE channel still tracked', ['c03'],
    "IF v_mute IN ('IGNORE', 'SNOOZE') THEN", 'IF false THEN', /IGNORE|tạm ẩn/],
  ['a KNOWN_BROKEN channel announced on its own (1392QT)', ['c03', 'c04'],
    "WHEN (v_ev ->> 'knownBroken')::boolean THEN 'KNOWN_BROKEN'", "WHEN false THEN 'KNOWN_BROKEN'", /đã biết hỏng|kênh/],
  ['a recorder outage not attributed to the building router', ['c05'],
    "RETURN jsonb_build_object('cause', 'ROUTER_DOWN');", "RETURN jsonb_build_object('cause', 'UNKNOWN');", /toà mất mạng/],
  ['monitor-stale in two buildings listed recorder by recorder', ['c06'],
    'IF v_buildings >= 2 OR', 'IF false OR', /tin gộp/],
  ['a repeat within 24 hours sent again', ['c07'],
    "AND e.occurred_at > p_now - interval '24 hours' AND e.occurred_at < p_now) THEN 'REPEAT_24H'",
    "AND e.occurred_at > p_now - interval '1 minute' AND e.occurred_at < p_now) THEN 'REPEAT_24H'", /24 giờ/],
  ['a WARNING sent during the night', ['c08'],
    "WHEN v_ev ->> 'severity' <> 'CRITICAL' AND v_in_night THEN 'NIGHT'", "WHEN false THEN 'NIGHT'", /đêm/],
  ['reminders on days 4–6', ['c09'],
    'OR ((v_date - (c.opened_at AT TIME ZONE v_tz)::date) >= 4 AND v_monday));',
    'OR ((v_date - (c.opened_at AT TIME ZONE v_tz)::date) >= 4));', /ngày 4–6/],
  ['reminders after "Đã biết"', ['c09'],
    "AND (p_shadow OR (i.id IS NOT NULL AND i.status <> 'RESOLVED' AND i.acknowledged_at IS NULL))",
    "AND (p_shadow OR (i.id IS NOT NULL AND i.status <> 'RESOLVED'))", /Đã biết/],
  ['no daily cap', ['c10'],
    'IF v_count >= p_settings.daily_zalo_cap THEN', 'IF false THEN', /trần/],
  ['a WARNING recovery sent to Zalo', ['c11'],
    "WHEN v_ev ->> 'severity' = 'CRITICAL' THEN v_route", 'WHEN true THEN v_route', /khôi phục/],
  ['reconnect transitions counted as flapping', ['c12'],
    "AND ev.state = 'DISCONNECTED' AND ev.previous_state = 'CONNECTED'", "AND ev.state = 'DISCONNECTED'", /chập chờn/],
  ['SHADOW opening real incidents', ['c13'],
    'IF NOT p_live THEN', 'IF false THEN', /SHADOW/],
  ['the Zalo job tagged as the vacant-room bot (tu_dong)', ['c14'],
    "'camera_alert', true, 'camera_alert_delivery_id', p_delivery_id)",
    "'camera_alert', true, 'tu_dong', true, 'camera_alert_delivery_id', p_delivery_id)", /tu_dong/],
  ['a rerun with the same now evaluated again', ['c16'],
    'IF s.last_evaluated_at IS NOT NULL AND p_now <= s.last_evaluated_at THEN', 'IF false THEN', /bỏ qua/],
  ['a BELL-only repeat listed in the Zalo digest', ['c07'],
    "\n         AND e.route IN ('ZALO', 'DIGEST')\n", '\n', /chỉ báo chuông/],
  ['one failing organization aborting every organization', ['c17'],
    "RAISE WARNING 'camera alert: organization % failed: % %', s.organization_id, SQLSTATE, SQLERRM;", 'RAISE;', /lỗi giả lập/],
  ['a LIVE switch accepted without a Zalo group', ['c15'],
    "IF s.enabled AND s.mode = 'LIVE' AND s.zalo_conversation_id IS NULL THEN", 'IF false THEN', /không có nhóm/],
  ['a delivery page cursor that drops rows of the same round', ['c15'],
    'ELSE (d.created_at, d.id) < (p_before, p_before_id) END)', 'ELSE d.created_at < p_before END)', /phân trang/],
  // Quyền và cách ly org.
  ['a Zalo group of another organization accepted at enqueue', ['c14'],
    'IF NOT FOUND OR c.organization_id IS DISTINCT FROM p_org THEN', 'IF NOT FOUND THEN', /org khác/],
  ['the company-owner branch dropped from edit', ['c15'],
    'RETURN coalesce(app_private.ie_actor_is_company_owner_v1(p_org, v_uid), false)', 'RETURN false', /chủ công ty/],
  ['a super admin outside the organization allowed to edit', ['c15'],
    'OR (coalesce(public.is_super_admin(), false)\n        AND EXISTS (', 'OR (coalesce(public.is_super_admin(), false)\n        OR EXISTS (', /superadmin ngoài org/],
  ['the building view check dropped from read', ['c15'],
    'AND app_private.camera_share_actor_can_v1(p_org, b.id));', 'AND true);', /org khác|ngừng hoạt động/],
  ['delivery rows of other buildings shown to a building manager', ['c15'],
    'WHERE NOT app_private.camera_share_actor_can_v1(p_organization_id, b.id)))', 'WHERE false))', /chỉ được thấy dòng/],
  ['a manager allowed to mute channels', ['c15'],
    "IF NOT FOUND OR NOT app_private.camera_alert_actor_can_edit_v1(r.organization_id) THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin tắt báo kênh được'",
    "IF NOT FOUND THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin tắt báo kênh được'", /tắt (báo kênh|được kênh)/],
  ['a stale version accepted (no CAS)', ['c15'],
    'IF (v_found AND s.version <> p_expected_version)', 'IF (v_found AND false)', /CAS lệch/],
  ['anyone allowed to acknowledge', ['c15'],
    'OR NOT (app_private.camera_alert_actor_can_edit_v1(inc.organization_id)', 'OR NOT (true', /Đã biết/],
  ['a baseline naming a building without that building in the ledger row', ['c04'],
    "'buildingIds', v_known_ids,", "'buildingIds', '[]'::jsonb,", /lọc người xem/],
  ['a manager allowed to list Zalo groups', ['c15'],
    "     OR NOT app_private.camera_alert_actor_can_edit_v1(p_organization_id) THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin chọn được nhóm Zalo'",
    " THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin chọn được nhóm Zalo'", /danh sách nhóm Zalo/],
  ['a manager allowed to send the test message', ['c15'],
    "     OR NOT app_private.camera_alert_actor_can_edit_v1(p_organization_id) THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin gửi tin thử được'",
    " THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin gửi tin thử được'", /gửi được tin thử/],
  ['a manager allowed to unmute channels', ['c15'],
    "IF NOT FOUND OR NOT app_private.camera_alert_actor_can_edit_v1(r.organization_id) THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin bật lại báo kênh được'",
    "IF NOT FOUND THEN\n    RAISE EXCEPTION 'Chỉ chủ công ty hoặc superadmin bật lại báo kênh được'", /bật lại báo kênh được/],
  ['channel mutes of another building readable', ['c15'],
    "     OR NOT coalesce(public.can_access_building(p_building_id), false)\n     OR NOT coalesce(public.can_do_on_building('network_center', 'view', p_building_id), false)\n     OR (coalesce(public.is_super_admin(), false) AND coalesce(v_org",
    "     OR (coalesce(public.is_super_admin(), false) AND coalesce(v_org", /tắt kênh toà B/],
  ['the company owner dropped from bell recipients', ['c05'],
    'app_private.ie_actor_is_company_owner_v1(p_org, m.user_id)\n       OR coalesce((', 'false\n       OR coalesce((', /chuông|chủ công ty/],
];

for (const [name, cases, from, to, message] of mutations) {
  test(`camera alerts v2 proof detects ${name}`, async () => {
    await assert.rejects(runCameraAlertsProof({ cases, mutation: (sql) => sql.replace(from, to) }), message);
  });
}
