-- =============================================================================
-- T2 — Đồng bộ lớp NGOẠI LỆ: đưa quyền đang dùng ở hệ cũ vào mô hình canonical
--
-- BỐI CẢNH
--   Trigger a81 (20260722140000) đồng bộ staff_assignments -> role_bindings nhưng
--   ghi rõ "KHÔNG đụng member_permission_overrides". Nên lớp tinh chỉnh từng người
--   chưa bao giờ sang mô hình mới.
--
-- GỐC RỄ THẬT (đo 2026-07-25, không phải thiếu dữ liệu mà là lỗi cấu trúc)
--   96/214 quyền khai scope_kinds = ['ORGANIZATION'] (danh mục, nhà cung cấp, kho,
--   hotline, loại công việc, hạn mức dịch vụ, mẫu...). Vai trò "Quản Lý Tòa" CÓ
--   các quyền này (đã kiểm 5/5), NHƯNG binding của nhân viên chỉ mang phạm vi
--   BUILDING. Evaluator đòi `scope_type = any(scope_kinds)` ⇒ BUILDING không khớp
--   ORGANIZATION ⇒ các quyền đó KHÔNG VỚI TỚI ĐƯỢC cho mọi nhân viên scope-toà.
--
--   Đo trên org thật, toàn bộ 214 quyền:
--     nguyentamca165 : 214/214 giống nhau        -> không cần gì
--     joey           : giống 173 · MẤT 38 · THÊM 3
--     nathan         : giống 172 · MẤT 39 · THÊM 3
--     bosshuy        : giống 211 · MẤT  3 · THÊM 0
--
-- VÌ SAO KHÔNG "THÊM PHẠM VI TỔ CHỨC VÀO BINDING" (phương án đơn giản hơn)
--   Đã đo: cách đó vá được phần MẤT nhưng CẤP THÊM ngoài ý muốn —
--   joey +6, nathan +5, trong đó có income_expenses.approve [ELEVATED],
--   thu_tien.collect, reports_finance.export. Cutover phải đổi CƠ CHẾ, không đổi
--   QUYỀN. Nên cấp ngoại lệ THEO TỪNG QUYỀN, không mở phạm vi cả gói.
--
-- LOẠI TRỪ CÓ CHỦ ĐÍCH
--   * 3 quyền "THÊM": KHÔNG đụng. Chúng đã live trên đường ghi (vai trò canonical
--     có ALLOW), chỉ UI cũ giấu. Thêm DENY là THAY ĐỔI QUYỀN thật -> chủ sở hữu quyết.
--   * cashbooks.create/delete/edit: hệ cũ (RLS) cho, nhưng app KHÔNG có đường ghi
--     trực tiếp vào `accounts` (0 điểm DML frontend) — mọi thao tác sổ quỹ đi qua
--     create_cashbook_v1/update_cashbook_metadata_v1, tức canonical đang gác và
--     hiện TỪ CHỐI. Khôi phục = cấp quyền MỚI. (cashbooks.view vẫn khôi phục.)
--   * Quyền ELEVATED: chốt chặn cứng, không bao giờ khôi phục tự động.
--   * Quyền requires_cashbook_possession: do cashbook_possession_bindings quản,
--     không thuộc lớp ngoại lệ.
--
-- ⚠ Ghi vào member_permission_overrides CÓ HIỆU LỰC NGAY với 48 RPC ghi tiền.
--   Đó là lý do danh sách trên đã lọc sạch ELEVATED và các quyền chưa từng dùng được.
--
-- Idempotent: bỏ qua nếu đã có override chưa thu hồi cho cùng (membership, key).
-- =============================================================================

begin;

-- Mỗi tổ chức phải có sẵn một phạm vi ORGANIZATION chuẩn để tái sử dụng.
insert into public.authorization_scopes (id, organization_id, scope_type)
select gen_random_uuid(), o.id, 'ORGANIZATION'
  from public.organizations o
 where not exists (
   select 1 from public.authorization_scopes s
    where s.organization_id = o.id and s.scope_type = 'ORGANIZATION');

with
-- Thành viên có phân công legacy thật (loại self-assignment).
target_member as (
  select m.id as membership_id, m.organization_id, m.user_id
    from public.organization_memberships m
   where m.status = 'ACTIVE'
     and exists (select 1 from public.staff_assignments sa
                  where sa.staff_id = m.user_id and sa.staff_id <> sa.user_id)
),

-- Quyền hệ CŨ đang cấp — đúng ngữ nghĩa can_access_org_entity
-- (bất kỳ phân công nào có cờ, KHÔNG kèm super-admin vì super-admin không
--  cần ngoại lệ và sẽ được canonical phủ qua vai trò chủ sở hữu).
legacy_grant as (
  select tm.membership_id, tm.organization_id, tm.user_id, pd.key, pd.scope_kinds
    from target_member tm
    cross join public.permission_definitions pd
   where pd.permission_domain = 'TENANT'
     and pd.is_active
     and pd.sensitivity <> 'ELEVATED'
     and not pd.requires_cashbook_possession
     and pd.key not in ('cashbooks.create','cashbooks.delete','cashbooks.edit')
     and exists (
       select 1
         from public.staff_assignments sa
         left join public.roles r on r.id = sa.role_id
        where sa.staff_id = tm.user_id
          and coalesce((coalesce(sa.permissions, r.permissions) -> pd.resource ->> pd.action)::boolean, false)
     )
),

-- Quyền mô hình MỚI thực sự cấp được.
-- PHẢI soi cả scope_kinds — đây chính là chỗ chẩn đoán lần đầu bị sai:
-- vai trò có quyền nhưng phạm vi binding không thuộc scope_kinds thì KHÔNG cấp.
canonical_grant as (
  select distinct tm.membership_id, rp.permission_key as key
    from target_member tm
    join public.role_bindings rb
      on rb.membership_id = tm.membership_id and rb.valid_to is null
    join public.organization_roles orl
      on orl.id = rb.role_id and coalesce(orl.status,'ACTIVE') = 'ACTIVE'
    join public.role_permissions rp
      on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
     and rp.effect = 'ALLOW'
    join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
    join public.authorization_scopes s   on s.id = rbs.scope_id
    join public.permission_definitions pd on pd.key = rp.permission_key
   where s.scope_type = any(pd.scope_kinds)
     and not pd.requires_cashbook_possession
),

existing_override as (
  select o.membership_id, o.permission_key as key
    from public.member_permission_overrides o
   where o.revoked_at is null
),

to_restore as (
  select lg.*
    from legacy_grant lg
   where not exists (select 1 from canonical_grant cg
                      where cg.membership_id = lg.membership_id and cg.key = lg.key)
     and not exists (select 1 from existing_override eo
                      where eo.membership_id = lg.membership_id and eo.key = lg.key)
),

ins_override as (
  insert into public.member_permission_overrides
    (id, organization_id, membership_id, permission_key, effect, reason, scope_mode, created_by, created_at)
  select gen_random_uuid(), tr.organization_id, tr.membership_id, tr.key, 'ALLOW',
         'Cutover V3: giu nguyen quyen dang dung o he cu (doi chieu bong 2026-07-25)',
         case when 'BUILDING' = any(tr.scope_kinds) then 'SCOPED' else 'ORGANIZATION' end,
         tr.user_id, now()
    from to_restore tr
  returning id, organization_id, membership_id, permission_key
)

-- Phạm vi cho ngoại lệ:
--   * quyền nhận BUILDING  -> bám ĐÚNG phạm vi toà/khu người đó đang có
--                             (mirror hành vi per-building của hệ cũ, không nới)
--   * quyền chỉ nhận ORGANIZATION -> phạm vi ORGANIZATION (hệ cũ cũng org-wide)
insert into public.member_override_scopes (organization_id, override_id, scope_id)
select distinct io.organization_id, io.id, sc.scope_id
  from ins_override io
  join public.permission_definitions pd on pd.key = io.permission_key
  cross join lateral (
    select s.id as scope_id
      from public.role_bindings rb
      join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
      join public.authorization_scopes s on s.id = rbs.scope_id
     where rb.membership_id = io.membership_id
       and rb.valid_to is null
       and 'BUILDING' = any(pd.scope_kinds)
       and s.scope_type in ('BUILDING','AREA')
    union all
    select s.id
      from public.authorization_scopes s
     where s.organization_id = io.organization_id
       and s.scope_type = 'ORGANIZATION'
       and not ('BUILDING' = any(pd.scope_kinds))
  ) sc;

commit;
