-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.guard_contract_termination_settlement() md5(prosrc)=28213b0187f01bc518e48677bea2f30c
CREATE OR REPLACE FUNCTION public.guard_contract_termination_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_frozen text := NULL;
BEGIN
  -- Chỉ soi đường REST của trình duyệt. Writer SECURITY DEFINER chạy dưới
  -- postgres, edge function chạy dưới service_role — cả hai đi thẳng.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- ── INSERT: không cho khai sinh một hồ sơ ĐÃ quyết toán từ trình duyệt.
  -- UNIQUE(contract_id) chỉ chặn được hợp đồng ĐÃ có hồ sơ; hợp đồng chưa có
  -- thì client tự INSERT một dòng status='COMPLETED' với total_deposit tuỳ ý
  -- là xong — không writer nào, không bút toán nào.
  IF TG_OP = 'INSERT' THEN
    -- Qua hàm SECURITY DEFINER ở 3.1bis — KHÔNG SELECT thẳng app_private, xem
    -- lý do ở đó (authenticated không có USAGE ⇒ 42501 ngay lúc khởi động câu).
    IF public.has_contract_termination_write_v1(NEW.id) THEN
      RETURN NEW;
    END IF;

    IF COALESCE(NEW.status, '') IN ('APPROVED', 'COMPLETED') THEN
      RAISE EXCEPTION
        '[TERMINATION_APPROVE_VIA_RPC] Không tạo hồ sơ thanh lý ở trạng thái % từ giao diện. Hồ sơ phải do RPC thanh lý sinh ra (trả phòng / bỏ cọc), hoặc tạo ở trạng thái DRAFT rồi duyệt bằng approve_contract_termination_v1.',
        NEW.status
        USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION
        '[TERMINATION_APPROVE_VIA_RPC] approved_by / approved_at do RPC duyệt đóng dấu — không ghi tay từ giao diện.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE ─────────────────────────────────────────────────────────
  -- Cửa writer (3.1) — hôm nay chưa writer nào dùng, xem ghi chú ở 3.1.
  -- Đọc qua hàm SECURITY DEFINER ở 3.1bis (lý do: 42501 schema app_private).
  IF public.has_contract_termination_write_v1(OLD.id) THEN
    RETURN NEW;
  END IF;

  -- (1) Hồ sơ ĐÃ quyết toán ⇒ đông cứng đầu vào tiền + mốc nhận diện.
  -- refund_amount và total_deductions là cột SINH TỰ ĐỘNG (stored generated)
  -- từ đúng các cột dưới đây, nên sửa một cột là đổi số tiền phải hoàn mà
  -- không sinh phiếu nào, không để lại vết nào.
  IF COALESCE(OLD.status, '') IN ('APPROVED', 'COMPLETED') THEN
    IF    NEW.total_deposit         IS DISTINCT FROM OLD.total_deposit         THEN v_frozen := 'total_deposit';
    ELSIF NEW.outstanding_debt      IS DISTINCT FROM OLD.outstanding_debt      THEN v_frozen := 'outstanding_debt';
    ELSIF NEW.early_termination_fee IS DISTINCT FROM OLD.early_termination_fee THEN v_frozen := 'early_termination_fee';
    ELSIF NEW.notice_violation_fee  IS DISTINCT FROM OLD.notice_violation_fee  THEN v_frozen := 'notice_violation_fee';
    ELSIF NEW.damage_fee            IS DISTINCT FROM OLD.damage_fee            THEN v_frozen := 'damage_fee';
    ELSIF NEW.cleaning_fee          IS DISTINCT FROM OLD.cleaning_fee          THEN v_frozen := 'cleaning_fee';
    ELSIF NEW.other_fees            IS DISTINCT FROM OLD.other_fees            THEN v_frozen := 'other_fees';
    ELSIF NEW.prorated_rent         IS DISTINCT FROM OLD.prorated_rent         THEN v_frozen := 'prorated_rent';
    ELSIF NEW.prorated_services     IS DISTINCT FROM OLD.prorated_services     THEN v_frozen := 'prorated_services';
    ELSIF NEW.prorated_days         IS DISTINCT FROM OLD.prorated_days         THEN v_frozen := 'prorated_days';
    ELSIF NEW.contract_id           IS DISTINCT FROM OLD.contract_id           THEN v_frozen := 'contract_id';
    ELSIF NEW.termination_type      IS DISTINCT FROM OLD.termination_type      THEN v_frozen := 'termination_type';
    ELSIF NEW.actual_move_out_date  IS DISTINCT FROM OLD.actual_move_out_date  THEN v_frozen := 'actual_move_out_date';
    ELSIF NEW.termination_date      IS DISTINCT FROM OLD.termination_date      THEN v_frozen := 'termination_date';
    ELSIF NEW.refund_date           IS DISTINCT FROM OLD.refund_date           THEN v_frozen := 'refund_date';
    END IF;

    IF v_frozen IS NOT NULL THEN
      RAISE EXCEPTION
        '[TERMINATION_SETTLED] Hồ sơ thanh lý đã ở trạng thái % — không sửa được cột "%" từ giao diện. Số tiền phải hoàn (refund_amount) do các cột này SINH RA, sửa một cột là đổi tiền mà không sinh phiếu nào. Sai sót phát hiện sau quyết toán phải xử lý bằng phiếu điều chỉnh.',
        OLD.status, v_frozen
        USING ERRCODE = '55000';
    END IF;

    -- Không cho hạ trạng thái để "mở băng" rồi sửa vòng hai.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        '[TERMINATION_SETTLED] Hồ sơ thanh lý đã ở trạng thái % — không đổi trạng thái từ giao diện. Mọi thay đổi phải đi qua RPC thanh lý.',
        OLD.status
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- (2) Không nhảy thẳng sang APPROVED/COMPLETED từ trình duyệt.
  -- Đặt status='APPROVED' kích trigger update_contract_on_termination_approved
  -- ⇒ hợp đồng thành TERMINATED, phòng đổi trạng thái, mà KHÔNG một bút toán
  -- tiền nào được ghi. Đây đúng là việc mà fallback client đã chết
  -- (useApproveTermination → INSERT public.cash_book, bảng KHÔNG tồn tại) làm.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('APPROVED', 'COMPLETED') THEN
    RAISE EXCEPTION
      '[TERMINATION_APPROVE_VIA_RPC] Duyệt/hoàn tất thanh lý phải gọi approve_contract_termination_v1. Đặt status = % trực tiếp sẽ khiến hợp đồng thành TERMINATED mà không sinh bút toán tiền nào.',
      NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- (3) Dấu duyệt do server đóng, không nhận từ client (mọi trạng thái).
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION
      '[TERMINATION_APPROVE_VIA_RPC] approved_by / approved_at do RPC duyệt đóng dấu — không ghi tay từ giao diện.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$

