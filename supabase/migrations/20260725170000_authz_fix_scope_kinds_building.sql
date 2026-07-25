-- =============================================================================
-- Vá lệch metadata: quyền được hỏi KÈM TOÀ nhưng khai scope_kinds={ORGANIZATION}
--
-- PHÁT HIỆN (vòng kiểm chứng 179 agent, mục B1; đo lại xác nhận)
--   6 quyền đang được policy gọi dạng can_do_on_building('<res>','<act>', toà)
--   nhưng catalog khai scope_kinds = {ORGANIZATION} — tức mô hình mới KHÔNG biểu
--   diễn được "quyền này ở TOÀ NÀY". Hệ quả dây chuyền:
--     · Binding/ngoại lệ phải gắn phạm vi ORGANIZATION mới khớp scope_kinds
--     · Phạm vi ORGANIZATION ⇒ org_wide ⇒ cấp trên MỌI toà
--     · Trong khi hệ cũ chỉ cấp trên các toà người đó được phân công
--
--   Đo trên org thật (45 cặp policy hỏi theo toà × 21 toà = 945 phép thử/người):
--     nguyentamca165 : 0 lệch
--     joey           : 40 lệch — TẤT CẢ là "thêm", 0 mất
--     nathan         : 32 lệch — TẤT CẢ là "thêm", 0 mất
--   Toàn bộ rơi đúng 4 quyền: auto_debt.edit, warehouses.create/delete/edit
--
-- CÁCH VÁ (hai vế, phải làm cùng nhau)
--   (1) Cho scope_kinds của 6 quyền này nhận thêm BUILDING + AREA, để mô hình mới
--       diễn đạt được "quyền ở toà cụ thể".
--   (2) Chuyển phạm vi của các ngoại lệ tương ứng từ ORGANIZATION sang đúng các
--       toà mà người đó đang có — mirror hệ cũ, hết nới.
--   Làm (1) mà quên (2) thì ngoại lệ vẫn khớp ORGANIZATION ⇒ vẫn cấp mọi toà.
--
-- Không đụng auto_debt.view / warehouses.view: chúng chỉ được hỏi ở cấp tổ chức
-- (can_access_org_entity), giữ ORGANIZATION là đúng.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- (1) Mở rộng scope_kinds cho 6 quyền được hỏi kèm toà
-- -----------------------------------------------------------------------------
update public.permission_definitions
   set scope_kinds = array['ORGANIZATION','AREA','BUILDING']::text[]
 where key in ('auto_debt.create','auto_debt.edit','auto_debt.delete',
               'warehouses.create','warehouses.edit','warehouses.delete')
   and not ('BUILDING' = any(scope_kinds));

-- -----------------------------------------------------------------------------
-- (2) Hạ phạm vi ngoại lệ của các quyền đó từ ORGANIZATION xuống đúng toà đang có
--
--     Chỉ đụng ngoại lệ do bước đồng bộ cutover sinh ra (nhận diện bằng `reason`),
--     không đụng ngoại lệ do người dùng tự đặt.
-- -----------------------------------------------------------------------------
-- Bảng tạm: override cần hạ phạm vi, kèm tập cạnh toà/khu thay thế.
--
-- Ràng buộc hình dạng (a90_override_shape / a90_override_edge_shape) là
-- DEFERRABLE INITIALLY DEFERRED — kiểm lúc COMMIT — nên trong transaction này
-- được phép đổi mode và cạnh theo thứ tự bất kỳ, miễn cuối cùng nhất quán:
--   scope_mode='ORGANIZATION' -> đúng 1 cạnh, và phải là ORGANIZATION
--   scope_mode='SCOPED'       -> >=1 cạnh, và KHÔNG cạnh ORGANIZATION nào
-- Ngoài ra mọi cạnh phải có scope_type nằm trong scope_kinds của quyền —
-- vì vậy bước (1) ở trên phải chạy TRƯỚC.
create temporary table tmp_ha_pham_vi on commit drop as
select o.id as override_id, o.membership_id, o.organization_id
  from public.member_permission_overrides o
 where o.revoked_at is null
   and o.reason like 'Cutover V3%'
   and o.permission_key in ('auto_debt.create','auto_debt.edit','auto_debt.delete',
                            'warehouses.create','warehouses.edit','warehouses.delete')
   -- chỉ hạ khi người đó THỰC SỰ có phạm vi toà/khu để thay thế; ai chỉ có
   -- phạm vi tổ chức (vd chủ sở hữu) thì giữ nguyên ORGANIZATION.
   and exists (
     select 1 from public.role_bindings rb
       join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
       join public.authorization_scopes s on s.id = rbs.scope_id
      where rb.membership_id = o.membership_id and rb.valid_to is null
        and s.scope_type in ('BUILDING','AREA'));

-- Thêm cạnh toà/khu đúng bằng phạm vi người đó đang có
insert into public.member_override_scopes (organization_id, override_id, scope_id)
select distinct t.organization_id, t.override_id, s.id
  from tmp_ha_pham_vi t
  join public.role_bindings rb
    on rb.membership_id = t.membership_id and rb.valid_to is null
  join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
  join public.authorization_scopes s on s.id = rbs.scope_id
 where s.scope_type in ('BUILDING','AREA')
   and not exists (select 1 from public.member_override_scopes x
                    where x.override_id = t.override_id and x.scope_id = s.id);

-- Gỡ cạnh ORGANIZATION cũ
delete from public.member_override_scopes mos
 using tmp_ha_pham_vi t, public.authorization_scopes s
 where mos.override_id = t.override_id
   and s.id = mos.scope_id
   and s.scope_type = 'ORGANIZATION';

-- Đổi mode cho khớp hình dạng mới
update public.member_permission_overrides o
   set scope_mode = 'SCOPED'
  from tmp_ha_pham_vi t
 where o.id = t.override_id and o.scope_mode <> 'SCOPED';

-- Chốt chặn: không được để ngoại lệ nào mất sạch phạm vi (write path sẽ RAISE).
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from public.member_permission_overrides o
   where o.revoked_at is null
     and not exists (select 1 from public.member_override_scopes s where s.override_id = o.id);
  if v_n <> 0 then
    raise exception 'Có % ngoại lệ không còn phạm vi nào — dừng', v_n;
  end if;
end $$;

commit;
