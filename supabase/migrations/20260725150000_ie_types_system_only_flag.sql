-- =============================================================================
-- Hạng mục: cờ `system_only` + cắm quyền hạn chế cho nhóm lương / lợi nhuận
--
-- Ý 2 — THÊM CỜ ĐÁNH DẤU HẠNG MỤC CẤM TẠO TAY
--   Hiện create_income_expense_v1 chặn theo HAI cách khác nhau:
--     (a) cờ dữ liệu  : is_deposit = true            -> 14 dòng
--     (b) SO KHỚP TÊN : nrm_vn(name) IN ('hoa hong moi gioi','thuong nong sale')
--                                                    -> 22 dòng
--   Cách (b) rất mong manh: đổi tên hạng mục thành "Hoa hồng MG" hay "Thưởng Sale"
--   là thoát chặn ngay. Migration này gom về MỘT cờ `system_only` để:
--     · đổi tên không phá chặn
--     · chủ sở hữu tự bật/tắt từng hạng mục trên màn Cài đặt sau này
--     · chỉ còn một chỗ kiểm thay vì hai
--
--   ⚠ GIỮ NGUYÊN HÀNH VI: cờ được bật từ ĐÚNG hai vị từ đang chạy, không rộng hơn.
--     HHMG cố ý KHÔNG nằm trong nhóm này (chủ sở hữu xác nhận là thiết kế có chủ
--     đích) — nó ở mức "cần quyền hạn chế", không phải cấm tuyệt đối.
--
-- Ý 3 — CẮM QUYỀN HẠN CHẾ CHO NHÓM LƯƠNG / LỢI NHUẬN
--   Nhóm này bắt buộc duyệt nhưng vẫn tạo tay được. Bật is_restricted để chỉ người
--   có `income_expenses.restricted_create` mới tạo tay được — quyền đó hiện CHỈ vai
--   trò "Chủ sở hữu tổ chức" có, nên hiệu lực thực tế là chỉ chủ sở hữu.
--   Hiện 3/9 dòng đã có cờ; migration bật nốt 6 dòng còn thiếu.
--
-- KHÔNG làm (đã kiểm, hệ thống vốn đã đúng):
--   · Bàn giao tiền mặt: đã có cỗ máy trạng thái 2 chiều riêng (cash_handovers +
--     confirm_cash_handover + trigger ie_handover_guard). Không đụng.
--   · Nội bộ không tiền thật: 67 phiếu trên sổ quỹ ảo, KHÔNG phiếu nào ở Nháp —
--     luồng hệ thống không đi qua luật ngưỡng. Không cần thêm luật.
--   · "Tất cả phiếu thu auto duyệt": toàn hệ chỉ 4 phiếu thu ở Nháp và đều là
--     phiếu test canary trên org demo. Không có phiếu nghiệp vụ nào bị kẹt.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1) Cột cờ mới
-- -----------------------------------------------------------------------------
alter table public.income_expense_types
  add column if not exists system_only boolean not null default false;

comment on column public.income_expense_types.system_only is
  'true = hạng mục CHỈ do hệ thống sinh (hợp đồng/cọc/thanh lý/hoa hồng), cấm tạo tay từ màn Thu/Chi. Thay cho cách so khớp tên cũ.';

-- -----------------------------------------------------------------------------
-- 2) Bật cờ từ ĐÚNG hai vị từ đang chạy trong create_income_expense_v1
-- -----------------------------------------------------------------------------
update public.income_expense_types
   set system_only = true
 where system_only = false
   and (
     is_deposit is true
     or public.nrm_vn(name) in ('hoa hong moi gioi', 'thuong nong sale')
   );

-- Chốt chặn: phải đúng 36 dòng, không hơn không kém.
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.income_expense_types where system_only;
  if v_n <> 36 then
    raise exception 'system_only bật % dòng, kỳ vọng 36 — dừng để rà lại', v_n;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3) Cắm quyền hạn chế cho nhóm lương / lợi nhuận
--
-- ⚠ VÌ SAO PHẢI TẮT TRIGGER `ie_type_restricted_recompute` TRONG BƯỚC NÀY
--   Trigger đó chạy lại cờ `income_expenses.has_restricted_item` cho MỌI phiếu cũ
--   đang dùng hạng mục vừa đổi. Nhưng phiếu đã ghi sổ (canonical/flow-owned) bị
--   `app_private.guard_income_expense_owned_payload` đóng băng: chỉ cho sửa một
--   danh sách cột hẹp, và `has_restricted_item` KHÔNG nằm trong đó.
--   Lần chạy đầu migration này đã bị chặn đúng ở đó (phiếu 6e561454, errcode 55000).
--
--   Đó là chốt bất biến ĐÚNG — không phá nó. Thay vào đó chỉ áp cờ cho phiếu
--   SINH RA TỪ NAY, giữ nguyên 67 phiếu lịch sử:
--     · Yêu cầu của chủ sở hữu là chặn TẠO TAY, không phải đổi hiển thị dữ liệu cũ.
--     · Hồi tố cờ sẽ làm 67 phiếu lương/lợi nhuận cũ đột ngột biến mất khỏi tầm
--       nhìn của nhân viên không có `income_expenses.restricted_view` — thay đổi
--       ngoài ý muốn, và không thể hoàn tác dễ vì phiếu đã đóng băng.
--
--   Phiếu MỚI vẫn được gán cờ đúng vì trigger trên `income_expense_items` (đường
--   tạo phiếu) không bị đụng — chỉ tắt trigger trên bảng hạng mục, trong đúng
--   statement này.
-- -----------------------------------------------------------------------------
alter table public.income_expense_types disable trigger ie_type_restricted_recompute;

update public.income_expense_types
   set is_restricted = true
 where coalesce(is_restricted, false) = false
   and name in (
     'Lương quản lý', 'Lương điều hành', 'Ứng lương quản lý',
     'Chia lợi nhuận cổ đông', 'Tiền Lương', 'Quản Lý'
   );

alter table public.income_expense_types enable trigger ie_type_restricted_recompute;

-- Chốt chặn: cả 9 dòng nhóm lương/LN phải có cờ sau bước này.
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.income_expense_types
   where name in ('Lương quản lý','Lương điều hành','Ứng lương quản lý',
                  'Chia lợi nhuận cổ đông','Tiền Lương','Quản Lý')
     and coalesce(is_restricted,false) = false;
  if v_n <> 0 then
    raise exception 'Còn % dòng nhóm lương/LN chưa cắm quyền hạn chế', v_n;
  end if;
end $$;

commit;
