import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { chuanHoaBroadcast } from '../../worker/lib/automation-config.js';
import { zaloBroadcastResult, zaloBroadcastInput } from './zalo-broadcast-contract.mjs';
import { setupZaloBroadcast, windowExcludingNow, binding, code, WHOLE_DAY, G1, G2, G3, G4, U1, GF, ACCOUNT2,
  USER, ORG, FOREIGN, ACCOUNT, ORG_SCOPE, BUILDING_SCOPE } from './zalo-broadcast-sql-fixture.mjs';

const req = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { row: { organizationId: ORG } };
// Every SQL result also passes the strict broker contract.
const checked = (operation, input, value) => zaloBroadcastResult(operation, value, identity, zaloBroadcastInput(operation, input));

test('SQL normaliser matches worker/lib/automation-config.js for time, days and recipients', async t => {
  const { db } = await setupZaloBroadcast(t);
  const corpus = [undefined, null, {}, [], 'x', 5, { schedule: null }, { schedule: [] }, { schedule: 'x' },
    { schedule: { time: '8:5' } }, { schedule: { time: ' 09:30 ' } }, { schedule: { time: '\u00a0\t07:45\n' } }, { schedule: { time: '24:00' } },
    { schedule: { time: '23:60' } }, { schedule: { time: '7' } }, { schedule: { time: 830 } }, { schedule: { time: ['08:15'] } }, { schedule: { time: [['6:7']] } },
    { schedule: { time: ['08:15', '09:00'] } }, { schedule: { time: true } }, { schedule: { time: { h: 8 } } }, { schedule: { time: '123:45' } },
    { schedule: { days: { mon: 'off', tue: 'full', sun: 'compact', wed: 'FULL', thu: 1, fri: null, sat: ['full'] } } },
    { schedule: { days: ['full'] } }, { schedule: { days: 'full' } }, { schedule: { days: { mon: 'compact', extra: 'off' } } },
    { recipients: [' a ', 'a', '', null, 'b', 7, 7.5, 1.50, true, false, { x: 1 }, [1, [2, null]], [], 'A', ' ', '\u2028c\u2028'] },
    { recipients: 'abc' }, { recipients: { 0: 'x' } }, { recipients: [G1, ` ${G2}`, G1] }];
  for (const raw of corpus) {
    const expected = chuanHoaBroadcast(raw), cfg = raw === undefined ? null : JSON.stringify(raw);
    const got = (await db.query(`SELECT app_private.hermes_zalo_gio_v1(c#>'{schedule,time}','08:30') t,app_private.hermes_zalo_ngay_v1(c#>'{schedule,days}') d,
      app_private.hermes_zalo_nguoi_nhan_v1(c->'recipients') r FROM (SELECT CASE WHEN jsonb_typeof($1::jsonb)='object' THEN $1::jsonb ELSE '{}'::jsonb END c) x`, [cfg])).rows[0];
    assert.deepEqual({ time: got.t, days: got.d, recipients: got.r }, { time: expected.schedule.time, days: expected.schedule.days, recipients: expected.recipients }, JSON.stringify(raw));
  }
});

test('status reads the CRM automation, normalised, with version, groups and one-shot runs', async t => {
  const x = await setupZaloBroadcast(t);
  const empty = checked('status', {}, await x.call('status', {}));
  assert.equal(empty.enabled, false); assert.equal(empty.time, '08:30'); assert.deepEqual(empty.allowedHours, { from: '08:00', to: '20:00' });
  assert.deepEqual(empty.days, { mon: 'full', tue: 'compact', wed: 'compact', thu: 'compact', fri: 'compact', sat: 'compact', sun: 'off' });
  assert.equal(empty.dailyCap, 120); assert.deepEqual(empty.recipients, []); assert.deepEqual(empty.oneshots, []);
  await x.setConfig({ ...WHOLE_DAY, recipients: [G1, G3, 'không-phải-id', GF.toUpperCase(), G2], schedule: { time: '7:5', days: { sun: 'full' } },
    template: { introText: 'giữ nguyên' } }, true);
  const status = checked('status', {}, await x.call('status', {}));
  assert.equal(status.enabled, true); assert.equal(status.time, '07:05'); assert.equal(status.days.sun, 'full'); assert.equal(status.days.mon, 'full');
  assert.deepEqual(status.allowedHours, { from: '00:00', to: '23:59' }); assert.equal(status.recipientCount, 5);
  assert.deepEqual(status.recipients.map(r => [r.conversationId, r.valid]), [[G1, true], [G3, false], [GF, false], [G2, true]]);
  assert.deepEqual(status.recipients[0], { conversationId: G1, name: 'Nhóm MG Quận 7', accountName: 'Synthetic bot', valid: true });
  assert.equal(status.recipients[2].name, null, 'another company\'s group is never named');
  assert.notEqual(status.version, empty.version);
  // Worker stats writes do not move the version (it hashes enabled + config only).
  await x.db.query("UPDATE public.zalo_automations SET stats='{\"lan\":1}' WHERE organization_id=$1", [ORG]);
  assert.equal(checked('status', {}, await x.call('status', {})).version, status.version);
  const sent = await x.call('send', { requestId: req(1), conversationIds: [G1], mode: 'full', runAt: null });
  const listed = checked('status', {}, await x.call('status', {}));
  assert.deepEqual(listed.oneshots.map(o => [o.oneshotId, o.status, o.origin, o.requestId, o.recipientCount]), [[sent.oneshot.oneshotId, 'queued', 'hermes', req(1), 1]]);
});

test('recipients: only company sale groups; label names are per nick; group/label filters fold accents', async t => {
  const x = await setupZaloBroadcast(t);
  await x.setConfig({ recipients: [G2] });
  const all = checked('recipients', {}, await x.call('recipients', { groupName: null, labelName: null, labelKey: null, limit: 30 }));
  assert.deepEqual(all.groups.map(g => g.conversationId).sort(), [G1, G2, G4].sort(), 'no non-sale group, user thread or foreign group');
  assert.equal(all.groups.find(g => g.conversationId === G2).inSchedule, true);
  const label = await x.call('recipients', { groupName: null, labelName: 'group mg ihome', labelKey: null, limit: 30 });
  const byLabel = checked('recipients', { labelName: 'group mg ihome' }, label);
  assert.deepEqual(byLabel.groups.map(g => [g.conversationId, g.accountName]), [[G2, 'Nick Hai'], [G1, 'Synthetic bot']]);
  assert.deepEqual(byLabel.labels.map(l => [l.key, l.accountName, l.groupCount]).sort(),
    [[`${ACCOUNT}:1`, 'Synthetic bot', 1], [`${ACCOUNT2}:1`, 'Nick Hai', 1]].sort(), 'same name on two nicks stays two labels');
  const one = checked('recipients', { labelKey: `${ACCOUNT2}:1` }, await x.call('recipients', { groupName: null, labelName: null, labelKey: `${ACCOUNT2}:1`, limit: 30 }));
  assert.deepEqual(one.groups.map(g => g.conversationId), [G2]);
  const accent = checked('recipients', { groupName: 'doi tac' }, await x.call('recipients', { groupName: 'doi tac', labelName: null, labelKey: null, limit: 30 }));
  assert.deepEqual(accent.groups.map(g => [g.conversationId, g.labels]), [[G4, [{ key: `${ACCOUNT}:2`, name: 'Đối tác' }]]]);
  const page = checked('recipients', { limit: 1 }, await x.call('recipients', { groupName: null, labelName: null, labelKey: null, limit: 1 }));
  assert.equal(page.total, 3); assert.equal(page.truncated, true); assert.equal(page.groups.length, 1);
  for (const bad of [{ groupName: '', labelName: null, labelKey: null, limit: 30 }, { groupName: null, labelName: null, labelKey: 'x:1', limit: 30 },
    { groupName: null, labelName: null, labelKey: null, limit: 51 }, { groupName: null, labelName: null, labelKey: null }])
    await assert.rejects(x.call('recipients', bad), code('22023'));
});

test('send: default full, now or once later; CRM refusals come back coded; same requestId is reused, never duplicated', async t => {
  const x = await setupZaloBroadcast(t);
  await x.setConfig(WHOLE_DAY);
  const input = { requestId: req(1), conversationIds: [G2, G1], mode: 'full', runAt: null };
  const first = checked('send', input, await x.call('send', input));
  assert.equal(first.ok, true); assert.equal(first.reused, false);
  assert.deepEqual([first.oneshot.mode, first.oneshot.sendNow, first.oneshot.origin, first.oneshot.recipients], ['full', true, 'hermes', [G1, G2]]);
  assert.equal(checked('send', input, await x.call('send', input)).reused, true);
  const drift = checked('send', { ...input, mode: 'compact' }, await x.call('send', { ...input, mode: 'compact' }));
  assert.equal(drift.code, 'ma_yeu_cau_da_dung'); assert.match(drift.huongDan, /crm_new_request_id/);
  assert.equal(await x.scalar('SELECT count(*)::int v FROM public.zalo_automation_oneshots'), 1);
  assert.equal(await x.scalar("SELECT count(*)::int v FROM public.fixture_audit WHERE event='HERMES_ZALO_BROADCAST_SEND'"), 1, 'audited once');
  const later = new Date(Date.now() + 3 * 3600_000).toISOString();
  const scheduled = checked('send', { requestId: req(2), conversationIds: [G4], mode: 'compact', runAt: later },
    await x.call('send', { requestId: req(2), conversationIds: [G4], mode: 'compact', runAt: later }));
  assert.deepEqual([scheduled.oneshot.sendNow, scheduled.oneshot.runAt, scheduled.oneshot.mode], [false, later, 'compact']);
  const bad = await x.call('send', { requestId: req(3), conversationIds: [G1, G3, U1, GF], mode: 'full', runAt: null });
  assert.deepEqual([bad.code, [...bad.invalidRecipients].sort()], ['nguoi_nhan_khong_hop_le', [G3, U1, GF].sort()]);
  const far = new Date(Date.now() + 40 * 86400_000).toISOString();
  assert.equal((await x.call('send', { requestId: req(4), conversationIds: [G1], mode: 'full', runAt: far })).code, 'gio_hen_khong_hop_le');
  const window = await windowExcludingNow(x.db);
  await x.setConfig({ antiSpam: { allowedHours: window } });
  const outside = checked('send', { ...input, requestId: req(5) }, await x.call('send', { ...input, requestId: req(5) }));
  assert.equal(outside.code, 'ngoai_khung_gio'); assert.deepEqual(outside.allowedHours, window);
  assert.ok(Date.parse(outside.suggestedRunAt) > Date.now()); assert.match(outside.huongDan, new RegExp(`runAt=${outside.suggestedRunAt}`));
  const retry = { ...input, requestId: req(6), runAt: outside.suggestedRunAt };
  assert.equal(checked('send', retry, await x.call('send', retry)).oneshot.sendNow, false, 'hẹn đúng giờ gợi ý thì nhận');
  for (const invalid of [{ ...input, requestId: req(7), mode: 'off' }, { ...input, requestId: req(7), runAt: '2026-10-17T09:00:00+07:00' },
    { ...input, requestId: req(7), conversationIds: [] }, { ...input, requestId: 'x' }, { ...input, extra: 1 }])
    await assert.rejects(x.call('send', invalid), code('22023'));
});

test('cancel: only a pending run of this company; repeat is reused; a running one is refused', async t => {
  const x = await setupZaloBroadcast(t);
  await x.setConfig(WHOLE_DAY);
  const later = new Date(Date.now() + 3600_000).toISOString();
  const shot = (await x.call('send', { requestId: req(1), conversationIds: [G1], mode: 'full', runAt: later })).oneshot.oneshotId;
  const done = checked('cancel', { oneshotId: shot }, await x.call('cancel', { oneshotId: shot }));
  assert.deepEqual([done.ok, done.reused, done.oneshot.status], [true, false, 'cancelled']);
  assert.equal(checked('cancel', { oneshotId: shot }, await x.call('cancel', { oneshotId: shot })).reused, true);
  const running = (await x.call('send', { requestId: req(2), conversationIds: [G1], mode: 'full', runAt: null })).oneshot.oneshotId;
  await x.db.query("UPDATE public.zalo_automation_oneshots SET status='running' WHERE id=$1", [running]);
  const refused = checked('cancel', { oneshotId: running }, await x.call('cancel', { oneshotId: running }));
  assert.deepEqual([refused.code, refused.oneshot.status], ['da_chay', 'running']);
  await x.db.query("INSERT INTO public.zalo_automation_oneshots(id,organization_id,recipients,run_at,created_by,request_id,request_fingerprint) VALUES($1,$2,ARRAY[$3]::uuid[],now(),$4,'foreign','x')",
    [req(9), FOREIGN, GF, USER]);
  assert.deepEqual(await x.call('cancel', { oneshotId: req(9) }), { ok: false, code: 'khong_tim_thay', reason: 'Không tìm thấy lượt hẹn này trong công ty.', oneshot: null });
  assert.equal(await x.scalar('SELECT status v FROM public.zalo_automation_oneshots WHERE id=$1', [req(9)]), 'queued');
});

test('update patches only the requested fields, keeps the rest, and refuses stale versions', async t => {
  const x = await setupZaloBroadcast(t);
  const original = { ...WHOLE_DAY, recipients: [G1, 'rác'], schedule: { time: '08:30', days: { mon: 'full', sat: 'off' }, skipIfUnchanged: false },
    template: { introText: 'Mẫu riêng {link}', blocks: ['link'] }, eventDriven: { enabled: false }, extra: { giu: [1, 2] } };
  await x.setConfig(original, false);
  let { version } = checked('status', {}, await x.call('status', {}));
  const input = { requestId: req(1), expectedVersion: version, time: '9:15', days: { sun: 'compact', mon: 'off' }, addConversationIds: [G2], removeConversationIds: [G1] };
  const shaped = zaloBroadcastInput('update', input);
  assert.deepEqual(shaped.days, { mon: 'off', sun: 'compact' }); assert.equal(shaped.time, '09:15');
  const applied = checked('update', input, await x.call('update', shaped));
  assert.deepEqual([applied.ok, applied.reused, applied.changed], [true, false, ['time', 'days', 'recipients']]);
  assert.deepEqual(applied.warnings, []);
  const stored = (await x.row()).config;
  assert.deepEqual(stored, { ...original, recipients: ['rác', G2], schedule: { time: '09:15', days: { mon: 'off', sat: 'off', sun: 'compact' }, skipIfUnchanged: false } },
    'template, antiSpam, eventDriven and unknown keys stay untouched');
  assert.equal((await x.row()).enabled, false);
  // Same requestId: the receipt answers, nothing is written again.
  const before = (await x.row()).updated_at;
  const replay = checked('update', input, await x.call('update', shaped));
  assert.equal(replay.reused, true); assert.deepEqual(replay.settings, applied.settings);
  assert.equal((await x.row()).updated_at.getTime(), before.getTime());
  const reused = await x.call('update', { ...shaped, time: '10:00' });
  assert.equal(reused.code, 'ma_yeu_cau_da_dung');
  // A UI save between read and write: the stale version is refused, nothing overwritten.
  await x.setConfig({ ...stored, schedule: { ...stored.schedule, time: '11:00' } }, false);
  const stale = checked('update', { requestId: req(2), expectedVersion: applied.settings.version, enabled: true },
    await x.call('update', zaloBroadcastInput('update', { requestId: req(2), expectedVersion: applied.settings.version, enabled: true })));
  assert.equal(stale.code, 'cau_hinh_vua_doi'); assert.match(stale.huongDan, /đọc lại/i);
  assert.deepEqual([(await x.row()).enabled, (await x.row()).config.schedule.time], [false, '11:00']);
  ({ version } = checked('status', {}, await x.call('status', {})));
  assert.equal(stale.version, version, 'the refusal carries the current version');
  const on = checked('update', { requestId: req(3), expectedVersion: version, enabled: true },
    await x.call('update', { requestId: req(3), expectedVersion: version, enabled: true }));
  assert.deepEqual([on.changed, on.settings.enabled, on.settings.time], [['enabled'], true, '11:00']);
  assert.equal(await x.scalar("SELECT count(*)::int v FROM public.fixture_audit WHERE event='HERMES_ZALO_BROADCAST_UPDATE'"), 2);
});

test('update: set list, invalid recipients, no-op, emergency stop, legacy owner and warnings', async t => {
  const x = await setupZaloBroadcast(t);
  await x.setConfig({ antiSpam: { allowedHours: { from: '08:00', to: '20:00' } }, recipients: [G1] }, true);
  const version = async () => checked('status', {}, await x.call('status', {})).version;
  const bad = await x.call('update', { requestId: req(1), expectedVersion: await version(), setConversationIds: [G2, G3, U1] });
  assert.deepEqual([bad.code, bad.invalidRecipients], ['nguoi_nhan_khong_hop_le', [G3, U1].sort()]);
  const set = checked('update', { requestId: req(2), expectedVersion: await version(), setConversationIds: [G4, G2] },
    await x.call('update', { requestId: req(2), expectedVersion: await version(), setConversationIds: [G4, G2] }));
  assert.deepEqual((await x.row()).config.recipients, [G4, G2]); assert.deepEqual(set.changed, ['recipients']);
  const updatedAt = (await x.row()).updated_at;
  const noop = checked('update', { requestId: req(3), expectedVersion: await version(), time: '08:30' },
    await x.call('update', { requestId: req(3), expectedVersion: await version(), time: '08:30' }));
  assert.deepEqual(noop.changed, []); assert.equal((await x.row()).updated_at.getTime(), updatedAt.getTime(), 'no write when nothing changes');
  const late = checked('update', { requestId: req(4), expectedVersion: await version(), time: '22:00' },
    await x.call('update', { requestId: req(4), expectedVersion: await version(), time: '22:00' }));
  assert.deepEqual(late.warnings.map(w => w.code), ['gio_gui_ngoai_khung_gio']);
  const emptyOn = await x.call('update', { requestId: req(5), expectedVersion: await version(), removeConversationIds: [G4, G2] });
  assert.deepEqual(emptyOn.warnings, ['gio_gui_ngoai_khung_gio', 'chua_co_nguoi_nhan_hop_le']);
  await x.db.query('INSERT INTO public.fixture_legacy_owner VALUES($1)', [G1]);
  const owner = await x.call('update', { requestId: req(6), expectedVersion: await version(), addConversationIds: [G1] });
  assert.equal(owner.code, 'trung_lich_hermes_cu');
  assert.deepEqual((await x.row()).config.recipients, [], 'refused write left the row as it was');
  await x.as('SELECT public.zalo_dung_khan_cap($1) v', [ORG]);
  const stopped = checked('update', { requestId: req(7), expectedVersion: await version(), enabled: true },
    await x.call('update', { requestId: req(7), expectedVersion: await version(), enabled: true }));
  assert.equal(stopped.code, 'dang_dung_khan_cap'); assert.match(stopped.huongDan, /không tự gỡ/);
  assert.equal(checked('status', {}, await x.call('status', {})).emergencyStop, true, 'Hermes never lifts the stop');
  for (const invalid of [{ requestId: req(8), expectedVersion: 'x', enabled: true }, { requestId: req(8), expectedVersion: await version() },
    { requestId: req(8), expectedVersion: await version(), setConversationIds: [G1], addConversationIds: [G2] },
    { requestId: req(8), expectedVersion: await version(), addConversationIds: [G1], removeConversationIds: [G1] },
    { requestId: req(8), expectedVersion: await version(), days: { mon: 'gon' } }, { requestId: req(8), expectedVersion: await version(), time: '8:30' }])
    await assert.rejects(x.call('update', invalid), code('22023'));
});

test('authority: Read for every call, Action manage for writes, send for send; overlay, registry and binding are rechecked in SQL', async t => {
  const x = await setupZaloBroadcast(t);
  await x.setConfig(WHOLE_DAY);
  const send = n => x.call('send', { requestId: req(n), conversationIds: [G1], mode: 'full', runAt: null });
  // A schedule change that cannot start sends (time on a disabled schedule) needs manage only.
  const update = async n => x.call('update', { requestId: req(n), expectedVersion: (await x.call('status', {})).version, time: `0${n % 10}:15` });
  await x.db.exec('UPDATE public.fixture_authority SET send_zalo=false');
  await assert.rejects(send(1), code('42501')); assert.equal((await update(2)).ok, true, 'update needs manage, not send');
  await x.db.exec('UPDATE public.fixture_authority SET send_zalo=true,manage_zalo=false');
  await assert.rejects(send(3), code('42501')); await assert.rejects(update(4), code('42501'));
  assert.equal(typeof (await x.call('status', {})).version, 'string');
  await x.db.exec('UPDATE public.fixture_authority SET manage_zalo=true,view_zalo=false');
  await assert.rejects(x.call('status', {}), code('42501')); await assert.rejects(send(5), code('42501'));
  await x.db.exec('UPDATE public.fixture_authority SET view_zalo=true');
  // CRM allows, but the saved connection overlay no longer carries chat_zalo.send.
  await x.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.manage_automation']");
  await assert.rejects(send(6), code('42501')); assert.equal((await update(7)).ok, true);
  // CRM allows manage, but the overlay only carries send: no write at all.
  await x.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.send']");
  await assert.rejects(update(10), code('42501')); await assert.rejects(send(11), code('42501'));
  await assert.rejects(x.call('cancel', { oneshotId: req(12) }), code('42501'));
  await x.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.manage_automation','chat_zalo.send']");
  await x.db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='chat_zalo.send'");
  await assert.rejects(send(8), code('42501'));
  await x.db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='chat_zalo.send'");
  assert.equal((await send(9)).ok, true);
  await assert.rejects(x.call('status', {}, { b: { ...binding, expectedEpoch: 2 } }), code('42501'));
  await assert.rejects(x.call('status', {}, { b: { ...binding, expectedPolicyVersion: 2 } }), code('42501'));
  await assert.rejects(x.call('status', {}, { actor: FOREIGN }), code('42501'));
  for (const role of ['anon', 'service_role']) await assert.rejects(x.call('status', {}, { role }), code('42501'));
  for (const [name, args] of [['app_private.hermes_zalo_broadcast_view_v1', `'${ORG}'::uuid`], ['app_private.hermes_zalo_group_ok_v1', `'${ORG}'::uuid,'${G1}'::uuid`]])
    await assert.rejects(x.as(`SELECT ${name}(${args}) v`, []), code('42501'));
  await assert.rejects(x.as('SELECT count(*) v FROM app_private.hermes_zalo_broadcast_receipts', []), code('42501'));
});

test('review fixes (20261016140535): send Action gates turning sends on; writes need the Toàn tổ chức overlay; UUID case', async t => {
  const x = await setupZaloBroadcast(t);
  const version = async () => checked('status', {}, await x.call('status', {})).version;
  const update = async (n, patch) => x.call('update', { requestId: req(n), expectedVersion: await version(), ...patch });
  // P2.1 — the saved overlay has manage_automation but not chat_zalo.send.
  await x.setConfig({ ...WHOLE_DAY, recipients: [G1] }, false);
  await x.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.manage_automation']");
  await assert.rejects(update(1, { enabled: true }), code('42501'), 'turning sends on');
  assert.equal((await update(2, { addConversationIds: [G2] })).ok, true, 'adding to a disabled schedule');
  await x.setConfig({ ...WHOLE_DAY, recipients: [G1] }, true);
  await assert.rejects(update(3, { addConversationIds: [G2] }), code('42501'), 'adding to an enabled schedule');
  await assert.rejects(update(4, { setConversationIds: [G2] }), code('42501'), 'replacing recipients of an enabled schedule');
  assert.deepEqual((await update(5, { time: '09:00', removeConversationIds: [G1] })).changed, ['time', 'recipients'], 'narrowing stays allowed');
  assert.equal((await update(6, { enabled: false })).ok, true, 'turning off stays allowed');
  await x.db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['chat_zalo.manage_automation','chat_zalo.send']");
  await x.db.exec('UPDATE public.fixture_authority SET send_zalo=false');
  await assert.rejects(update(7, { enabled: true }), code('42501'), 'CRM send decision revoked');
  await x.db.exec('UPDATE public.fixture_authority SET send_zalo=true');
  assert.deepEqual((await update(8, { enabled: true, addConversationIds: [G2] })).changed, ['enabled', 'recipients']);
  // P2.2 — a building-only connection overlay reads but never writes.
  await x.db.exec(`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${BUILDING_SCOPE}'::uuid]`);
  assert.equal(checked('recipients', {}, await x.call('recipients', { groupName: null, labelName: null, labelKey: null, limit: 5 })).total, 3);
  await assert.rejects(x.call('send', { requestId: req(9), conversationIds: [G1], mode: 'full', runAt: null }), code('42501'));
  await assert.rejects(update(10, { time: '10:00' }), code('42501'));
  await assert.rejects(x.call('cancel', { oneshotId: req(11) }), code('42501'));
  // Only an ORGANIZATION-typed overlay counts, even a malformed one without building/area/cashbook.
  await x.db.exec(`INSERT INTO public.authorization_scopes VALUES('40000000-0000-4000-8000-000000000003','${ORG}','AREA',null,null,null);
    UPDATE app_private.hermes_org_policies SET scope_ids=scope_ids||'40000000-0000-4000-8000-000000000003'::uuid;
    UPDATE app_private.hermes_connections SET scope_ids=ARRAY['40000000-0000-4000-8000-000000000003'::uuid]`);
  await assert.rejects(update(13, { time: '10:00' }), code('42501'));
  await x.db.exec(`UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${ORG_SCOPE}'::uuid]`);
  // P3c — the same UUID in another case is one recipient (ids with hex letters).
  const GA = 'a0000000-0000-4000-8000-00000000000a', GB = 'b0000000-0000-4000-8000-00000000000b';
  await x.db.query(`INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,unread_count,peer_name,is_sale_partner)
    VALUES($1,$3,$4,'group','ga',0,'Nhóm Ánh',true),($2,$3,$4,'group','gb',0,'Nhóm Bảo',true)`, [GA, GB, ACCOUNT, ORG]);
  await x.setConfig({ ...WHOLE_DAY, recipients: [GA.toUpperCase(), 'rác', GB.toUpperCase()] }, true);
  await update(12, { addConversationIds: [GA, G2], removeConversationIds: [GB] });
  assert.deepEqual((await x.row()).config.recipients, [GA, 'rác', G2]);
  assert.equal(checked('recipients', {}, await x.call('recipients', { groupName: 'anh', labelName: null, labelKey: null, limit: 5 }))
    .groups.find(group => group.conversationId === GA).inSchedule, true);
});

test('review fixes (20261016140535): stop mark taken after the company lock; legacy text schedules cannot be created in SQL', async t => {
  const x = await setupZaloBroadcast(t);
  await x.setConfig(WHOLE_DAY, false);
  // A save that won the company lock after this transaction began (updated_at > now()) must not lift the stop.
  await x.db.exec('BEGIN');
  try {
    await x.db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [USER]);
    await x.db.query('SELECT pg_sleep(0.05)');
    await x.db.exec("SET LOCAL session_replication_role='replica'");
    await x.db.query('UPDATE public.zalo_automations SET updated_at=clock_timestamp() WHERE organization_id=$1', [ORG]);
    await x.db.exec("SET LOCAL session_replication_role='origin'");
    await x.db.query('SELECT public.zalo_dung_khan_cap($1)', [ORG]);
    assert.equal((await x.db.query('SELECT app_private.zalo_dang_dung_khan_cap_v1($1) v', [ORG])).rows[0].v, true);
    assert.equal((await x.db.query("SELECT bool_and(created_at>now()) v FROM public.zalo_automation_runs WHERE mode='stopped'")).rows[0].v, true);
  } finally { await x.db.exec('ROLLBACK'); }
  await assert.rejects(x.db.query("SELECT app_private.hermes_schedule_settings_v1('{}'::jsonb,$1::uuid)", [ORG]),
    error => error.code === '42501' && /hermes_schedule_retired/.test(error.message));
  // Its only caller is manage_v1 create/update; manage_v2 hands create/update/revoke to manage_v1.
  const root = new URL('../../supabase/migrations/', import.meta.url);
  const calls = readdirSync(root).filter(name => name.endsWith('.sql')).flatMap(name => readFileSync(new URL(name, root), 'utf8').split('\n')
    .filter(line => line.includes('hermes_schedule_settings_v1(') && !/CREATE OR REPLACE|ALTER FUNCTION|REVOKE|GRANT|'app_private\.hermes_schedule_settings_v1|position\(|hermes_schedule_settings_v1\(jsonb,uuid\)/.test(line))
    .map(line => `${name}: ${line.trim()}`));
  assert.deepEqual(calls, ["20261014081344_hermes_room_schedule_v1.sql: settings:=app_private.hermes_schedule_settings_v1(input->'settings',c.organization_id);"]);
  assert.match(readFileSync(new URL('20261015100100_hermes_delivery_reconcile_v1.sql', root), 'utf8'),
    /IF op IN \('create','update','revoke'\) THEN[\s\S]{0,120}result:=public\.hermes_room_schedule_manage_v1\(p\);/);
});
