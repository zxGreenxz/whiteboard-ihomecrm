import {readFileSync} from 'node:fs';
import {USER,ORG,BUILDING,ROOM,TYPE} from './task-fixture.mjs';
const source=name=>readFileSync('supabase/migrations/'+name+'.sql','utf8');
const policy=(src,name)=>src.match(new RegExp('CREATE POLICY '+name+' ON public\\.\\w+[\\s\\S]*?;','i'))[0];
export async function prepareTaskMetadata(db,{notifications=false}={}){
 await db.exec(`ALTER TABLE public.buildings ADD COLUMN name text;ALTER TABLE public.rooms ADD COLUMN name text;
  ALTER TABLE public.job_types ADD COLUMN name text;ALTER TABLE public.areas ADD COLUMN name text;
  ALTER TABLE public.fixture_task_acl ADD COLUMN building_rls boolean DEFAULT true,ADD COLUMN room_rls boolean DEFAULT true,ADD COLUMN type_rls boolean DEFAULT true;
  UPDATE public.buildings SET name='Nhà A';UPDATE public.rooms SET name='Phòng 201';UPDATE public.job_types SET name='Sửa chữa';
  ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;ALTER TABLE public.job_types ENABLE ROW LEVEL SECURITY;
  CREATE POLICY fixture_building_visibility ON public.buildings FOR SELECT TO authenticated USING((SELECT building_rls FROM public.fixture_task_acl));
  CREATE POLICY fixture_room_visibility ON public.rooms FOR SELECT TO authenticated USING((SELECT room_rls FROM public.fixture_task_acl));
  CREATE OR REPLACE FUNCTION public.can_access_org_entity(text,text) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT $1='task_types' AND $2='view' AND type_rls FROM public.fixture_task_acl$$;
  CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${ORG}'::uuid]$$;`);
 // Actual canonical task_types.view policy; the underlying current-permission
 // resolver is a fixture port. This is independent of Hermes tasks.view Read.
 await db.exec(policy(source('20260527000009_rbac_phase5_misc'),'job_types_select_rbac'));
 await db.exec(policy(source('20260808020000_gd4_rao_bang_dang_ro'),'job_types_org_boundary'));
 if(notifications){
  await db.exec(`CREATE TABLE public.notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,organization_id uuid,type text,channel text,status text,
    subject text,content text,job_id uuid,metadata jsonb,push_state text);
   CREATE UNIQUE INDEX fixture_e4_unique ON public.notifications(user_id,job_id) WHERE(metadata->>'event')='E4';
   CREATE FUNCTION app_private.notif_actor_label_v1(uuid) RETURNS text LANGUAGE sql AS $$SELECT 'Actor'::text$$;
   CREATE FUNCTION app_private.notify_gate_v1(uuid,uuid,text,text) RETURNS TABLE(g_in_app boolean,g_push boolean) LANGUAGE sql AS $$SELECT true,true$$;
   CREATE FUNCTION app_private.notify_no_recipient_v1(uuid,text,text,uuid,uuid,uuid,text) RETURNS void LANGUAGE sql AS $$SELECT$$;`);
  const e4=source('20260729161000_notify_event_triggers');
  await db.exec(e4.match(/create or replace function app_private\.notify_job_assigned_v1\(\)[\s\S]*?\$fn\$;/i)[0]);
  await db.exec(e4.match(/create trigger z95_notify_job_assigned_ins[\s\S]*?execute function app_private\.notify_job_assigned_v1\(\);/i)[0]);
 }
}
export async function taskMetadataRpc(db,binding,input,{actor=USER,session}={}){
 await db.exec('BEGIN');await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)",[actor,session]);
 await db.exec('SET LOCAL ROLE authenticated');
 try{const result=(await db.query('SELECT public.hermes_task_input_options_v1($1::jsonb,$2::jsonb) result',[JSON.stringify(binding),JSON.stringify(input)])).rows[0].result;await db.exec('COMMIT');return result;}
 catch(error){await db.exec('ROLLBACK');throw error;}finally{await db.exec('RESET ROLE');}
}
