begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('ihome-openclaw-realtime-allowlist-v1', 0)
);

do $preflight$
declare
  v_relation text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication publication
    where publication.pubname = 'supabase_realtime'
  ) then
    raise exception 'supabase_realtime publication is unavailable'
      using errcode = '55000';
  end if;

  foreach v_relation in array array[
    'public.openclaw_accounts',
    'public.openclaw_account_connections',
    'public.openclaw_runtime_cells',
    'public.openclaw_conversations',
    'public.openclaw_conversation_members',
    'public.openclaw_messages',
    'public.openclaw_message_media'
  ]
  loop
    if pg_catalog.to_regclass(v_relation) is null then
      raise exception 'OpenClaw Realtime dependency % is unavailable', v_relation
        using errcode = '55000';
    end if;
  end loop;
end
$preflight$;

do $publication$
declare
  v_table text;
  v_expected text[];
  v_actual text[];
begin
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_accounts'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_accounts (
      id,organization_id,account_profile,display_name,is_active,connection_state,
      session_risk_state,configured_mode,effective_mode,connection_generation,
      disclosure_version,disclosure_acknowledged_version,disclosure_acknowledged_at,
      paused_at,created_at,updated_at
    )';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_account_connections'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_account_connections (
      id,organization_id,account_id,connection_generation,connection_state,
      session_risk_state,configured_mode,effective_mode,reason_code,
      disclosure_version,disclosure_acknowledged_version,changed_at
    )';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_runtime_cells'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_runtime_cells (
      id,organization_id,account_id,cell_generation,state,is_current,
      last_heartbeat_at,created_at,retired_at
    )';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_conversations'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_conversations (
      id,organization_id,account_id,target_id,status,assigned_membership_id,
      unread_count,last_received_at,last_message_id,version,created_at,updated_at
    )';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_conversation_members'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_conversation_members (
      id,organization_id,account_id,conversation_id,display_name,member_role,
      joined_at,left_at,created_at
    )';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_messages (
      id,organization_id,account_id,conversation_id,direction,event_kind,
      provider_timestamp,received_at,created_at
    )';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'openclaw_message_media'
  ) then
    execute 'alter publication supabase_realtime add table public.openclaw_message_media (
      id,organization_id,account_id,conversation_id,message_id,media_index,
      media_kind,mime,byte_length,byte_state,retention_delete_not_before,
      created_at,updated_at
    )';
  end if;

  for v_table, v_expected in
    select specification.table_name, specification.column_names
    from (
      values
        ('openclaw_accounts', array[
          'id','organization_id','account_profile','display_name','is_active',
          'connection_state','session_risk_state','configured_mode','effective_mode',
          'connection_generation','disclosure_version','disclosure_acknowledged_version',
          'disclosure_acknowledged_at','paused_at','created_at','updated_at'
        ]::text[]),
        ('openclaw_account_connections', array[
          'id','organization_id','account_id','connection_generation','connection_state',
          'session_risk_state','configured_mode','effective_mode','reason_code',
          'disclosure_version','disclosure_acknowledged_version','changed_at'
        ]::text[]),
        ('openclaw_runtime_cells', array[
          'id','organization_id','account_id','cell_generation','state','is_current',
          'last_heartbeat_at','created_at','retired_at'
        ]::text[]),
        ('openclaw_conversations', array[
          'id','organization_id','account_id','target_id','status',
          'assigned_membership_id','unread_count','last_received_at','last_message_id',
          'version','created_at','updated_at'
        ]::text[]),
        ('openclaw_conversation_members', array[
          'id','organization_id','account_id','conversation_id','display_name',
          'member_role','joined_at','left_at','created_at'
        ]::text[]),
        ('openclaw_messages', array[
          'id','organization_id','account_id','conversation_id','direction',
          'event_kind','provider_timestamp','received_at','created_at'
        ]::text[]),
        ('openclaw_message_media', array[
          'id','organization_id','account_id','conversation_id','message_id',
          'media_index','media_kind','mime','byte_length','byte_state',
          'retention_delete_not_before','created_at','updated_at'
        ]::text[])
    ) as specification(table_name, column_names)
  loop
    select pg_catalog.array_agg(columns.attname order by columns.attname)
      into v_actual
    from pg_catalog.pg_publication_columns columns
    where columns.pubname = 'supabase_realtime'
      and columns.schemaname = 'public'
      and columns.tablename = v_table;

    if coalesce(v_actual, array[]::text[])
       is distinct from (
         select pg_catalog.array_agg(expected_column order by expected_column)
         from pg_catalog.unnest(v_expected) expected_column
       )
    then
      raise exception 'Unsafe or incomplete Realtime columns for public.%', v_table
        using errcode = '55000';
    end if;
  end loop;
end
$publication$;

commit;
