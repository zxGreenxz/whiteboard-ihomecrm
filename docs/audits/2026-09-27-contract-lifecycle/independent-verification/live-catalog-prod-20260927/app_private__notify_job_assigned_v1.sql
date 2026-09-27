-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- app_private.notify_job_assigned_v1() md5(prosrc)=f61b2fc59fd70492c8ff8dc0487e28cb
CREATE OR REPLACE FUNCTION app_private.notify_job_assigned_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid := NEW.organization_id;
  v_label  text := 'hệ thống';
  v_in_app boolean;
  v_push   boolean;
begin
  if v_org is null then
    perform app_private.notify_no_recipient_v1(
      null, 'E4', 'JOB', NEW.id, NEW.building_id, v_actor, 'ORG_UNRESOLVED');
    return null;
  end if;

  begin
    v_label := coalesce(app_private.notif_actor_label_v1(v_actor), 'hệ thống');
  exception when others then
    raise warning 'notify: notif_actor_label_v1 lỗi (job=%): % %', NEW.id, sqlstate, sqlerrm;
    v_label := 'hệ thống';
  end;

  begin
    select g.g_in_app, g.g_push into v_in_app, v_push
      from app_private.notify_gate_v1(NEW.assignee_id, v_org, 'E4', null) g;

    if coalesce(v_in_app, true) then
      insert into public.notifications
        (user_id, organization_id, type, channel, status, subject, content, job_id, metadata, push_state)
      values (NEW.assignee_id, v_org, 'ACTION_REQUIRED', 'IN_APP', 'PENDING',
              'Việc mới được giao cho bạn',
              coalesce(nullif(NEW.title,''),'(không tiêu đề)') || ' (' || coalesce(NEW.code,'—')
                || ') — do ' || v_label || ' giao.',
              NEW.id,
              jsonb_build_object('event','E4',
                                 'url','/tasks?job=' || NEW.id::text,
                                 'actor_id', v_actor),
              case when coalesce(v_push,true) then 'QUEUED' else 'SKIPPED' end)
      on conflict (user_id, job_id) where (metadata->>'event') = 'E4'
      do nothing;
    end if;
  exception when others then
    raise warning 'notify E4: bỏ qua người nhận % (job=%): % %',
      NEW.assignee_id, NEW.id, sqlstate, sqlerrm;
  end;

  return null;
end $function$

