import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/20261120155631_hermes_sale_advice.sql', import.meta.url),
  'utf8',
);
it('xếp tin theo phiên bot, nhóm môi giới, trang Sale và người vừa hỏi', async () => {
  const db = new PGlite();
  const [org, other, account, owner, instance, generation] = Array.from({ length: 6 }, () => randomUUID());
  const one = async (q, p = []) => Object.values((await db.query(q, p)).rows[0])[0];
  try {
    await db.exec(`
      CREATE SCHEMA app_private; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE organizations(id uuid PRIMARY KEY);
      CREATE TABLE zalo_accounts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, kind text, status text, zalo_uid text,login_requested_at timestamptz);
      CREATE TABLE app_private.hermes_zalo_bots(account_id uuid, organization_id uuid,enabled boolean);
      CREATE TABLE app_private.hermes_zalo_ingress_sessions(account_id uuid,organization_id uuid, account_owner_id uuid,instance_id uuid,generation uuid,own_uid text,login_requested_at timestamptz);
      CREATE TABLE zalo_worker_lease(id text,instance_id uuid,heartbeat_at timestamptz);
      CREATE TABLE zalo_conversations(organization_id uuid,account_id uuid,thread_type text,thread_id text,is_sale_partner boolean);
      CREATE TABLE zalo_automations(organization_id uuid,kind text,enabled boolean,config jsonb);
      CREATE TABLE zalo_send_queue(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,account_id uuid,channel text,payload jsonb,status text,processing_instance_id uuid);
      CREATE TABLE public_room_share_tokens(token text,organization_id uuid,revoked boolean);
      CREATE TABLE test_page(value jsonb);
      CREATE FUNCTION get_public_available_rooms(text) RETURNS jsonb LANGUAGE sql AS 'SELECT value FROM test_page';
      CREATE FUNCTION app_private.zalo_config_int_v1(jsonb,int,int) RETURNS int LANGUAGE sql AS 'SELECT coalesce(($1#>>''{}'')::int,$2)';
    `);
    await db.exec(migration);
    await db.exec(migration);
    expect(
      await one(
        "select has_function_privilege('authenticated','public.zalo_sale_advice_intake_v1(jsonb)','EXECUTE')",
      ),
    ).toBe(false);
    await db.query('INSERT INTO organizations VALUES($1),($2)', [org, other]);
    await db.query("INSERT INTO zalo_accounts VALUES($1,$2,$3,'personal','connected','100',null)", [
      account,
      org,
      owner,
    ]);
    await db.query('INSERT INTO app_private.hermes_zalo_bots VALUES($1,$2,true)', [account, org]);
    await db.query("INSERT INTO app_private.hermes_zalo_ingress_sessions VALUES($1,$2,$3,$4,$5,'100',null)", [
      account,
      org,
      owner,
      instance,
      generation,
    ]);
    await db.query("INSERT INTO zalo_worker_lease VALUES('singleton',$1,now())", [instance]);
    await db.query("INSERT INTO zalo_conversations VALUES($1,$2,'group','300',true),($1,$2,'group','400',false)", [
      org,
      account,
    ]);
    await db.query(
      "INSERT INTO zalo_automations VALUES($1,'auto_reply',true,$2),($1,'broadcast_vacant',true,$3)",
      [org, { saleAdvisor: true }, { template: { shareUrl: 'https://example.test/r/published' } }],
    );
    await db.query("INSERT INTO public_room_share_tokens VALUES('published',$1,false)", [org]);
    await db.query('INSERT INTO test_page VALUES($1)', [
      {
        buildings: [{ id: 'b', floor_layouts: {} }],
        rooms: [
          { id: 'p', status_public: 'free' },
          { id: 'hidden', status_public: 'rented' },
        ],
      },
    ]);
    const input = {
      organizationId: org,
      accountId: account,
      generation,
      instanceId: instance,
      threadType: 'user',
      threadId: '200',
      senderUid: '200',
      sentAt: Date.now(),
      messageId: 'dm',
      question: 'Còn phòng nào?',
    };
    const intake = (over = {}) => one('select public.zalo_sale_advice_intake_v1($1)', [{ ...input, ...over }]);
    expect(await intake({ organizationId: other })).toBe('inactive');
    expect(await intake({ generation: randomUUID() })).toBe('inactive');
    expect(await intake({ threadType: 'group', threadId: '400' })).toBe('inactive');
    expect(await intake()).toBe('queued');
    expect(await intake()).toBe('duplicate');
    const group = { threadType: 'group', threadId: '300', messageId: 'g1' };
    expect(await intake(group)).toBe('queued');
    expect(await intake({ ...group, messageId: 'g2', senderUid: '201', followUp: true })).toBe('unrelated');
    const job = await one("select job_id from app_private.hermes_sale_questions where provider_id='g1'");
    await db.query("UPDATE zalo_send_queue SET status='processing',processing_instance_id=$2 WHERE id=$1", [
      job,
      instance,
    ]);
    const read = (sig = null, memory = null) =>
      one('select public.zalo_sale_advice_delivery_v1($1,$2,$3,$4,$5)', [job, instance, generation, sig, memory]);
    const snapshot = await read();
    expect(snapshot.page.rooms.map((x) => x.id)).toEqual(['p']);
    expect(snapshot.page.buildings[0]).not.toHaveProperty('floor_layouts');
    expect(await read(snapshot.signature, { ids: ['p'] })).toMatchObject({ authorized: true, threadId: '300' });
    await db.query("UPDATE zalo_send_queue SET status='sent' WHERE id=$1", [job]);
    for (const [sender, previous] of [
      ['200', { ids: ['p'] }],
      ['201', null],
    ]) {
      const messageId = 'next-' + sender;
      expect(await intake({ ...group, messageId, senderUid: sender })).toBe('queued');
      const next = await one('select job_id from app_private.hermes_sale_questions where provider_id=$1', [
        messageId,
      ]);
      await db.query("UPDATE zalo_send_queue SET status='processing',processing_instance_id=$2 WHERE id=$1", [
        next,
        instance,
      ]);
      const context = await one('select public.zalo_sale_advice_delivery_v1($1,$2,$3)', [
        next,
        instance,
        generation,
      ]);
      expect(context.previous).toEqual(previous);
    }
    await db.query("UPDATE zalo_send_queue SET status='processing' WHERE id=$1", [job]);
    await db.query('UPDATE public_room_share_tokens SET revoked=true');
    await expect(read(snapshot.signature)).rejects.toThrow('sale_advice_listing_changed');
    expect((await read()).page).toBe(null);
    await db.query('UPDATE zalo_conversations SET is_sale_partner=false');
    await expect(read()).rejects.toThrow('sale_advice_inactive');
  } finally {
    await db.close();
  }
}, 30000);
