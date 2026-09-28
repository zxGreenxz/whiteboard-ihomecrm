import {existsSync,readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
const path='supabase/migrations/20260928042301_lifecycle_reminder_cron.sql';
const migration=existsSync(path)?readFileSync(path,'utf8'):'';
// Native extensions are supplied by explicit local transport stubs; production
// migration still creates the real pg_cron/pg_net extensions.
const sql=migration.replace(/^CREATE EXTENSION[^;]*;\s*/gm,'');
const db=new PGlite();
const serviceJwt=(ref='tryymsxyyckgbrmmvozx',role='service_role')=>`header.${Buffer.from(JSON.stringify({ref,role,exp:4102444800})).toString('base64url')}.signature`;
beforeAll(async()=>{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE SCHEMA app_private;CREATE SCHEMA vault;CREATE SCHEMA cron;CREATE SCHEMA net;
    GRANT USAGE ON SCHEMA app_private TO authenticated,service_role;
    CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
    CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
    CREATE FUNCTION cron.schedule(job_name text,cron_schedule text,cron_command text) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE id bigint;BEGIN
      INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,cron_schedule,cron_command) ON CONFLICT(jobname) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command RETURNING jobid INTO id;RETURN id;END $$;
    CREATE FUNCTION cron.unschedule(id bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobid=id;RETURN FOUND;END $$;
    CREATE TABLE net.test_requests(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,url text,headers jsonb,body jsonb,timeout integer);
    CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE id bigint;BEGIN INSERT INTO net.test_requests(url,headers,body,timeout) VALUES(url,headers,body,timeout_milliseconds) RETURNING test_requests.id INTO id;RETURN id;END $$;
    CREATE FUNCTION public.lifecycle_reminder_sweep_v1(uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    INSERT INTO cron.job(jobname,schedule,command) VALUES('unrelated-existing','0 7 * * *','SELECT 1');`);
  await db.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',['lifecycle_reminders_service_jwt',serviceJwt()]);
});
afterAll(async()=>db.close());
async function tx(run:()=>Promise<void>){await db.exec('BEGIN');try{await run();}finally{await db.exec('ROLLBACK');}}
async function deny(run:()=>Promise<unknown>,code:string){await db.exec('SAVEPOINT expected_reject');try{await expect(run()).rejects.toMatchObject({code});}finally{await db.exec('ROLLBACK TO SAVEPOINT expected_reject');}}
describe('P5 cron SQL, actual native transports explicitly stubbed',()=>{
  it('installs exactly one own15min job idempotently without editing another job',()=>tx(async()=>{
    expect(migration).toContain('CREATE OR REPLACE FUNCTION app_private.dispatch_lifecycle_reminders_v1');
    await db.exec(sql);await db.exec(sql);
    const jobs=(await db.query<{jobname:string;schedule:string;command:string}>('SELECT jobname,schedule,command FROM cron.job ORDER BY jobname')).rows;
    expect(jobs).toEqual([{jobname:'lifecycle-reminders-15m',schedule:'*/15 * * * *',command:'SELECT app_private.dispatch_lifecycle_reminders_v1();'},{jobname:'unrelated-existing',schedule:'0 7 * * *',command:'SELECT 1'}]);
    expect(jobs[0].command).not.toContain(serviceJwt());
  }));
  it('queues exact production endpoint using Vault JWT and returns request ID, not delivery success',()=>tx(async()=>{
    await db.exec(sql);const result=await db.query<{id:number}>('SELECT app_private.dispatch_lifecycle_reminders_v1() id');
    const requests=(await db.query<{id:number;url:string;headers:unknown;body:unknown;timeout:number}>('SELECT * FROM net.test_requests')).rows;
    expect(requests).toHaveLength(1);expect(result.rows[0].id).toBe(requests[0].id);
    expect(requests[0]).toMatchObject({url:'https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/lifecycle-reminders',headers:{Authorization:'Bearer '+serviceJwt(),'Content-Type':'application/json'},body:{},timeout:120000});
  }));
  it('TEST marker removes only a copied own production job and denies runtime before any HTTP',()=>tx(async()=>{
    await db.exec(sql);await db.exec('CREATE SCHEMA test_env;CREATE TABLE test_env.danh_dau(ref text)');
    await db.exec(sql);await db.exec(sql);
    expect((await db.query('SELECT * FROM cron.job WHERE jobname=\'lifecycle-reminders-15m\'')).rows).toHaveLength(0);
    await deny(()=>db.query('SELECT app_private.dispatch_lifecycle_reminders_v1()'),'55000');
    expect((await db.query('SELECT * FROM net.test_requests')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM cron.job WHERE jobname=\'unrelated-existing\'')).rows).toHaveLength(1);
  }));
  it('fails clearly when Vault service JWT is missing, including before schedule install',()=>tx(async()=>{
    await db.exec(sql);await db.exec('DELETE FROM vault.decrypted_secrets');
    await deny(()=>db.query('SELECT app_private.dispatch_lifecycle_reminders_v1()'),'55000');
    await deny(()=>db.exec(sql),'55000');
    expect((await db.query('SELECT * FROM net.test_requests')).rows).toHaveLength(0);
  }));
  it.each([['hzulujxgonszuleqticb','service_role'],['tryymsxyyckgbrmmvozx','anon']])('rejects wrong ref/role credential %s/%s before schedule or dispatch', (ref,role)=>tx(async()=>{
    await db.exec(sql);await db.query('UPDATE vault.decrypted_secrets SET decrypted_secret=$1',[serviceJwt(ref,role)]);
    await deny(()=>db.query('SELECT app_private.dispatch_lifecycle_reminders_v1()'),'55000');await deny(()=>db.exec(sql),'55000');
    expect((await db.query('SELECT * FROM net.test_requests')).rows).toHaveLength(0);
  }));
  it('application roles cannot invoke privileged production dispatch or credential helper',()=>tx(async()=>{
    await db.exec(sql);for(const role of ['authenticated','service_role']){
      await db.exec('SET LOCAL ROLE '+role);await deny(()=>db.query('SELECT app_private.dispatch_lifecycle_reminders_v1()'),'42501');
      await deny(()=>db.query('SELECT app_private.lifecycle_reminder_service_jwt_v1()'),'42501');await db.exec('RESET ROLE');
    }
  }));
});
