-- =============================================================================
-- Network Center 1/4: AuthZ v3 catalog + tenant-bound device inventory.
--
-- Security posture at this stage is deliberately inert: every new table has
-- RLS enabled and no browser policy. Task 4/4 adds the narrow read/write RPCs.
-- Router credentials remain outside Supabase; credential_ref is an opaque key
-- resolved only by the dedicated worker.
-- =============================================================================

BEGIN;

INSERT INTO public.permission_definitions (
  key,
  resource,
  action,
  sensitivity,
  permission_domain,
  scope_kinds,
  is_active,
  scope_match_mode,
  requires_cashbook_possession,
  accepted_possession_kinds,
  required_dimensions
)
VALUES
  (
    'network_center.view',
    'network_center',
    'view',
    'VIEW',
    'TENANT',
    ARRAY['ORGANIZATION','AREA','BUILDING']::text[],
    true,
    'ANY_MATCH',
    false,
    ARRAY[]::text[],
    ARRAY['BUILDING']::text[]
  ),
  (
    'network_center.execute',
    'network_center',
    'execute',
    'MANAGE',
    'TENANT',
    ARRAY['ORGANIZATION','AREA','BUILDING']::text[],
    true,
    'ANY_MATCH',
    false,
    ARRAY[]::text[],
    ARRAY['BUILDING']::text[]
  )
ON CONFLICT (key) DO UPDATE SET
  resource = EXCLUDED.resource,
  action = EXCLUDED.action,
  sensitivity = EXCLUDED.sensitivity,
  permission_domain = EXCLUDED.permission_domain,
  scope_kinds = EXCLUDED.scope_kinds,
  is_active = EXCLUDED.is_active,
  scope_match_mode = EXCLUDED.scope_match_mode,
  requires_cashbook_possession = EXCLUDED.requires_cashbook_possession,
  accepted_possession_kinds = EXCLUDED.accepted_possession_kinds,
  required_dimensions = EXCLUDED.required_dimensions;

CREATE TABLE IF NOT EXISTS public.network_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL,
  device_kind text NOT NULL,
  external_key text NOT NULL,
  display_name text NOT NULL,
  vendor text NOT NULL,
  model text,
  serial_number text,
  desired_firmware text,
  parent_device_id uuid,
  uplink_interface_key text,
  sort_order integer NOT NULL DEFAULT 0,
  lifecycle_status text NOT NULL DEFAULT 'UNPROVISIONED',
  write_capability boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  credential_ref text,
  inventory_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_devices_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_devices_parent_fk
    FOREIGN KEY (organization_id, building_id, parent_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_devices_kind_check
    CHECK (device_kind IN ('MIKROTIK', 'ARUBA')),
  CONSTRAINT network_devices_name_check
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT network_devices_external_key_check
    CHECK (char_length(btrim(external_key)) BETWEEN 1 AND 160),
  CONSTRAINT network_devices_vendor_check
    CHECK (char_length(btrim(vendor)) BETWEEN 1 AND 80),
  CONSTRAINT network_devices_lifecycle_check
    CHECK (lifecycle_status IN ('UNPROVISIONED', 'PROVISIONING', 'ONLINE', 'OFFLINE', 'DISABLED')),
  CONSTRAINT network_devices_desired_firmware_check
    CHECK (desired_firmware IS NULL OR char_length(btrim(desired_firmware)) BETWEEN 1 AND 80),
  CONSTRAINT network_devices_parent_not_self_check
    CHECK (parent_device_id IS NULL OR parent_device_id <> id),
  CONSTRAINT network_devices_uplink_key_check
    CHECK (uplink_interface_key IS NULL OR char_length(btrim(uplink_interface_key)) BETWEEN 1 AND 160),
  CONSTRAINT network_devices_sort_order_check
    CHECK (sort_order >= 0),
  CONSTRAINT network_devices_aruba_display_only
    CHECK ((device_kind = 'ARUBA' AND write_capability = false) OR device_kind <> 'ARUBA'),
  CONSTRAINT network_devices_credential_ref_check
    CHECK (
      credential_ref IS NULL
      OR (
        char_length(credential_ref) BETWEEN 3 AND 255
        AND credential_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
      )
    ),
  CONSTRAINT network_devices_metadata_object_check
    CHECK (jsonb_typeof(inventory_metadata) = 'object'),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, building_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS network_devices_one_active_mikrotik_per_building
  ON public.network_devices (organization_id, building_id)
  WHERE device_kind = 'MIKROTIK' AND is_active;

CREATE UNIQUE INDEX IF NOT EXISTS network_devices_external_key_uidx
  ON public.network_devices (organization_id, building_id, device_kind, external_key);

CREATE INDEX IF NOT EXISTS network_devices_building_kind_idx
  ON public.network_devices (organization_id, building_id, device_kind, is_active, id);

CREATE INDEX IF NOT EXISTS network_devices_serial_idx
  ON public.network_devices (organization_id, serial_number)
  WHERE serial_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.network_interfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  interface_key text NOT NULL,
  display_name text NOT NULL,
  interface_kind text NOT NULL DEFAULT 'OTHER',
  interface_role text NOT NULL DEFAULT 'UNKNOWN',
  mac_address macaddr,
  if_index integer,
  nominal_speed_bps bigint,
  is_protected boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_enabled boolean NOT NULL DEFAULT true,
  is_managed boolean NOT NULL DEFAULT false,
  display_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_interfaces_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_interfaces_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE CASCADE,
  CONSTRAINT network_interfaces_key_check
    CHECK (char_length(btrim(interface_key)) BETWEEN 1 AND 160),
  CONSTRAINT network_interfaces_name_check
    CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 160),
  CONSTRAINT network_interfaces_kind_check
    CHECK (interface_kind IN ('ETHERNET', 'WIRELESS', 'WIREGUARD', 'BRIDGE', 'VLAN', 'LOOPBACK', 'OTHER')),
  CONSTRAINT network_interfaces_role_check
    CHECK (interface_role IN ('WAN', 'LAN', 'ACCESS', 'UPLINK', 'MANAGEMENT', 'UNKNOWN')),
  CONSTRAINT network_interfaces_if_index_check
    CHECK (if_index IS NULL OR if_index >= 0),
  CONSTRAINT network_interfaces_speed_check
    CHECK (nominal_speed_bps IS NULL OR nominal_speed_bps > 0),
  CONSTRAINT network_interfaces_protected_role_check
    CHECK (interface_role NOT IN ('WAN', 'UPLINK', 'MANAGEMENT') OR is_protected),
  CONSTRAINT network_interfaces_sort_order_check
    CHECK (sort_order >= 0),
  CONSTRAINT network_interfaces_metadata_object_check
    CHECK (jsonb_typeof(display_metadata) = 'object'),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, building_id, device_id, id),
  UNIQUE (device_id, interface_key)
);

CREATE INDEX IF NOT EXISTS network_interfaces_device_idx
  ON public.network_interfaces (organization_id, building_id, device_id, id);

CREATE INDEX IF NOT EXISTS network_interfaces_mac_idx
  ON public.network_interfaces (organization_id, mac_address)
  WHERE mac_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.network_device_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL,
  transport text NOT NULL,
  management_ip inet NOT NULL,
  management_port integer NOT NULL,
  credential_ref text NOT NULL,
  host_key_fingerprint text,
  poll_interval_seconds integer NOT NULL DEFAULT 60,
  connect_timeout_ms integer NOT NULL DEFAULT 8000,
  is_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_device_connections_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_device_connections_device_fk
    FOREIGN KEY (organization_id, building_id, device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE CASCADE,
  CONSTRAINT network_device_connections_transport_check
    CHECK (transport IN ('ROUTEROS_SSH', 'ROUTEROS_API', 'SNMP', 'HTTPS', 'DISPLAY_ONLY')),
  CONSTRAINT network_device_connections_port_check
    CHECK (management_port BETWEEN 1 AND 65535),
  CONSTRAINT network_device_connections_poll_check
    CHECK (poll_interval_seconds BETWEEN 30 AND 3600),
  CONSTRAINT network_device_connections_timeout_check
    CHECK (connect_timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT network_device_connections_credential_ref_check
    CHECK (
      char_length(credential_ref) BETWEEN 3 AND 255
      AND credential_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]+$'
    ),
  CONSTRAINT network_device_connections_host_key_check
    CHECK (
      host_key_fingerprint IS NULL
      OR host_key_fingerprint ~ '^SHA256:[A-Za-z0-9+/]{20,}={0,2}$'
    ),
  UNIQUE (organization_id, id),
  UNIQUE (device_id, transport, management_ip, management_port)
);

CREATE INDEX IF NOT EXISTS network_device_connections_device_idx
  ON public.network_device_connections (organization_id, building_id, device_id, is_enabled, id);

CREATE TABLE IF NOT EXISTS public.network_site_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  building_id uuid NOT NULL,
  monitoring_enabled boolean NOT NULL DEFAULT true,
  changes_paused boolean NOT NULL DEFAULT false,
  poll_interval_seconds integer NOT NULL DEFAULT 60,
  offline_after_seconds integer NOT NULL DEFAULT 180,
  latency_warning_ms integer NOT NULL DEFAULT 150,
  packet_loss_warning_pct numeric(5,2) NOT NULL DEFAULT 10,
  backup_max_age_hours integer NOT NULL DEFAULT 168,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_site_settings_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_site_settings_poll_check
    CHECK (poll_interval_seconds BETWEEN 30 AND 3600),
  CONSTRAINT network_site_settings_offline_check
    CHECK (offline_after_seconds BETWEEN 60 AND 86400),
  CONSTRAINT network_site_settings_latency_check
    CHECK (latency_warning_ms BETWEEN 1 AND 60000),
  CONSTRAINT network_site_settings_loss_check
    CHECK (packet_loss_warning_pct BETWEEN 0 AND 100),
  CONSTRAINT network_site_settings_backup_check
    CHECK (backup_max_age_hours BETWEEN 1 AND 8760),
  CONSTRAINT network_site_settings_version_check
    CHECK (version > 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, building_id)
);

CREATE INDEX IF NOT EXISTS network_site_settings_building_idx
  ON public.network_site_settings (organization_id, building_id);

CREATE TABLE IF NOT EXISTS public.network_desired_state_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  router_device_id uuid NOT NULL,
  version bigint NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT false,
  desired_state jsonb NOT NULL,
  state_hash text NOT NULL,
  change_note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_desired_state_versions_org_building_fk
    FOREIGN KEY (organization_id, building_id)
    REFERENCES public.buildings(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_desired_state_versions_router_fk
    FOREIGN KEY (organization_id, building_id, router_device_id)
    REFERENCES public.network_devices(organization_id, building_id, id) ON DELETE RESTRICT,
  CONSTRAINT network_desired_state_versions_version_check
    CHECK (version > 0),
  CONSTRAINT network_desired_state_versions_schema_check
    CHECK (schema_version > 0),
  CONSTRAINT network_desired_state_versions_state_object_check
    CHECK (jsonb_typeof(desired_state) = 'object'),
  CONSTRAINT network_desired_state_versions_hash_check
    CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT network_desired_state_versions_note_check
    CHECK (change_note IS NULL OR char_length(btrim(change_note)) BETWEEN 3 AND 1000),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, building_id, router_device_id, version)
);

CREATE INDEX IF NOT EXISTS network_desired_state_versions_router_idx
  ON public.network_desired_state_versions (
    organization_id,
    building_id,
    router_device_id,
    version DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS network_desired_state_one_active_per_building
  ON public.network_desired_state_versions (organization_id, building_id)
  WHERE is_active;

DROP TRIGGER IF EXISTS network_devices_set_updated_at ON public.network_devices;
CREATE TRIGGER network_devices_set_updated_at
  BEFORE UPDATE ON public.network_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_interfaces_set_updated_at ON public.network_interfaces;
CREATE TRIGGER network_interfaces_set_updated_at
  BEFORE UPDATE ON public.network_interfaces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_device_connections_set_updated_at ON public.network_device_connections;
CREATE TRIGGER network_device_connections_set_updated_at
  BEFORE UPDATE ON public.network_device_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS network_site_settings_set_updated_at ON public.network_site_settings;
CREATE TRIGGER network_site_settings_set_updated_at
  BEFORE UPDATE ON public.network_site_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed inventory only. These rows contain no endpoint, credential, or telemetry.
INSERT INTO public.network_devices (
  organization_id,
  building_id,
  device_kind,
  external_key,
  display_name,
  vendor,
  lifecycle_status,
  write_capability,
  is_active
)
SELECT
  b.organization_id,
  b.id,
  'MIKROTIK',
  'slot:primary',
  'MikroTik — ' || COALESCE(NULLIF(btrim(b.name), ''), b.id::text),
  'MikroTik',
  'UNPROVISIONED',
  true,
  true
FROM public.buildings b
WHERE b.organization_id IS NOT NULL
  AND b.is_virtual = false
  AND b.deleted_at IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.network_site_settings (organization_id, building_id)
SELECT b.organization_id, b.id
FROM public.buildings b
WHERE b.organization_id IS NOT NULL
  AND b.is_virtual = false
  AND b.deleted_at IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE public.network_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_interfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_device_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_desired_state_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.network_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_interfaces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_device_connections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_site_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.network_desired_state_versions FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.network_devices IS
  'Tenant-bound Network Center inventory. One active MikroTik per physical building; Aruba rows are display-only and have no count limit.';
COMMENT ON COLUMN public.network_devices.credential_ref IS
  'Opaque reference resolved by the dedicated worker; never a credential value.';
COMMENT ON TABLE public.network_device_connections IS
  'Worker-only connection metadata. Contains endpoint and opaque credential reference, never secret material.';
COMMENT ON TABLE public.network_desired_state_versions IS
  'Append-style versions of sanitized, allowlisted Network Center desired state.';

COMMIT;

NOTIFY pgrst, 'reload schema';
