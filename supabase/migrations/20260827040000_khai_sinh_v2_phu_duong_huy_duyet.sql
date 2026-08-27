BEGIN;
-- ============================================================
-- KHAI SINH V2 phai phu ca duong HUY DUYET (su co PC2606055, 27/08/2026)
--
-- Trieu chung do duoc tren prod: phieu PC2606055 (tao 12/06/2026) bi huy duyet
-- luc 03:42:16 ngay 27/08, sau do bam "Duyet va Chi" tra HTTP 500:
--   assert_committed_birth_boundary_v2: voucher 1cf50ae4-af54-429c-9ee7-… has
--   no birth provenance
-- Cung canh ngo: PC2607042 (huy duyet 03:40:39). Ca hai co
-- birth_operation_id / birth_txid / source_payload_hash = NULL, va KHONG nam
-- trong income_expense_v2_backfill_exceptions — tuc backfill chua tung cham
-- toi chung, khong phai cham roi bi guard chan.
--
-- GOC RE la mot KHOANG TRONG giua hai manh cua migration 20260723230000:
--   • backfill khai sinh CHI quet `approval_status = 'UNAPPROVED'` tai thoi
--     diem migration chay (23/07/2026);
--   • trigger a86 chi BEFORE **INSERT**.
-- Phieu dang APPROVED hom 23/07 nam ngoai CA HAI manh. Khi unapprove_voucher
-- tra no ve UNAPPROVED thi khong manh nao cap khai sinh, ma lifecycle V2 lai
-- doi khai sinh de duyet lai ⇒ phieu vao ngo cut, giao dien khong co duong ra.
--
-- Chung minh bang change_log (app_private.income_expense_change_log):
--   a76e8c84  03:40:39  APPROVED → UNAPPROVED  birth truoc = NULL
--   1cf50ae4  03:42:16  APPROVED → UNAPPROVED  birth truoc = NULL  (POSTED → UNPOSTED)
-- Ca hai deu KHONG co dong nao trong income_expense_audit_log, tuc chung chua
-- tung doi trang thai truoc 27/08 — dung la lop "APPROVED luc backfill chay".
--
-- KHONG phai su co hai phieu le. Do prod cung luc:
--   APPROVED   : 2.523 / 2.598 thieu birth
--   CANCELLED  :   193 /   203 thieu birth
--   UNAPPROVED :     2 /    84 thieu birth
-- Moi phieu APPROVED thieu birth la mot qua min, cho ai do bam huy duyet.
--
-- ------------------------------------------------------------
-- Vi sao vá o TRIGGER chu khong o unapprove_voucher
--
-- unapprove_voucher la duong dua APPROVED → UNAPPROVED duy nhat do duoc hom
-- nay, nhung no khong phai duong duy nhat CO THE co: 28 ham trong schema co
-- ghi approval_status kem 'UNAPPROVED'. Vá tung ham la vá theo danh sach, va
-- danh sach do se dai them. Trigger a86 von da la NOI DUY NHAT chiu trach
-- nhiem cap khai sinh cho writer cu — no chi thieu dung mot nhanh: UPDATE.
-- Mo rong no giu bat bien o MOT cho, phu moi writer hien co lan sau nay.
--
-- Chinh header migration 20260723230000 da viet "phieu UNAPPROVED chua co
-- provenance duoc khai sinh tu dong". Y dinh von la vay; BEFORE INSERT chi la
-- hien thuc hoa THIEU cua chinh y dinh do.
--
-- ------------------------------------------------------------
-- Vi sao KHONG backfill 2.523 phieu APPROVED
--
-- Trigger moi cap khai sinh ngay tai giay phut phieu quay ve UNAPPROVED, nen
-- 2.523 phieu kia duoc phu ma khong can cham vao chung. Chay UPDATE tren 2.523
-- dong so sach tien that de phong mot tinh huong da co duong xu ly la doi rui
-- ro lay so 0. Chi backfill dung lop DANG ket — phieu da nam san o UNAPPROVED
-- voi birth NULL, vi voi chung khong con UPDATE nao de trigger banh thuc.
--
-- ------------------------------------------------------------
-- He qua da can nhac: huy duyet + duyet lai trong CUNG mot transaction
--
-- Trigger dat birth_txid = pg_current_xact_id() cua transaction huy duyet. Neu
-- co luong nao gop huy-duyet va duyet-lai vao chung mot transaction thi
-- assert_committed_birth_boundary_v2 se chan ("create and transition in same
-- transaction"). Do la DUNG bat bien §6.1 (khai sinh phai commit truoc), khong
-- phai tac dung phu: mot phieu vua sinh khai sinh o transaction nay khong duoc
-- coi la da qua ranh gioi commit. Duong nguoi dung that (bam Huy duyet, roi
-- bam Duyet) la hai transaction tach biet — da kiem bang su co that.
--
-- Thu tu trigger da kiem: a00_ie_owned_payload_freeze (BEFORE UPDATE) chay
-- TRUOC a86 theo thu tu ten, nen luc guard so OLD/NEW thi birth_* chua bi
-- trigger cham → khong co delta → khong bi chan. Cac guard chay SAU a86
-- (_guard_ie_financial_columns, ie_handover_guard, income_expenses_check_lock,
-- trg_ie_commission_guard, guard_profit_payout_linked_v2, …) deu KHONG nhac
-- toi birth_* hay source_payload_hash — da do bang pg_get_functiondef.
-- ============================================================

-- ------------------------------------------------------------
-- (1) Trigger a86: phu ca UPDATE, kem WHEN hep o tang Postgres.
--     WHEN loc TRUOC khi goi plpgsql, nen moi UPDATE khac tren bang nong nhat
--     he thong khong phai tra gia mot lan goi ham.
--     Ham bridge giu NGUYEN — dieu kien IF ben trong no trung voi WHEN, gio
--     thanh lop chan thu hai, khong phai lop duy nhat.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS a86_finance_v2_birth_provenance ON public.income_expenses;
CREATE TRIGGER a86_finance_v2_birth_provenance
  BEFORE INSERT OR UPDATE ON public.income_expenses
  FOR EACH ROW
  WHEN (NEW.approval_status = 'UNAPPROVED' AND NEW.birth_operation_id IS NULL)
  EXECUTE FUNCTION app_private.finance_v2_birth_provenance_bridge();

-- ------------------------------------------------------------
-- (2) Token per-xid cho phieu flow-owned sap duoc stamp trong buoc (3).
--     Backfill o buoc (3) UPDATE thang birth_* nen no DI QUA freeze guard —
--     khac voi duong trigger. Giu nguyen khuon cua 20260723230000.
-- ------------------------------------------------------------
INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
SELECT ie.id, pg_current_xact_id(), 'FINANCE_V2_BIRTH_BACKFILL'
FROM public.income_expenses ie
WHERE ie.approval_status = 'UNAPPROVED' AND ie.deleted_at IS NULL
  AND ie.birth_operation_id IS NULL
  AND app_private.is_income_expense_flow_owned(ie.id)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- (3) Backfill lop DANG ket: UNAPPROVED + birth NULL.
--     Outcome rieng 'UNAPPROVE_BACKFILL_BIRTH' de phan biet voi dot
--     'LEGACY_BACKFILL_BIRTH' cua 20260723230000 khi doc so canonical.
-- ------------------------------------------------------------
DO $backfill$
DECLARE
  v_row record;
  v_txid xid8;
  v_hash text;
  v_n integer := 0;
  v_blocked integer := 0;
BEGIN
  FOR v_row IN
    SELECT ie.id, ie.organization_id, ie.user_id, ie.code
    FROM public.income_expenses ie
    WHERE ie.approval_status = 'UNAPPROVED' AND ie.deleted_at IS NULL
      AND ie.birth_operation_id IS NULL
  LOOP
    BEGIN
      SELECT b.birth_txid, b.payload_hash INTO v_txid, v_hash
      FROM app_private.finance_v2_register_birth_v1(
        v_row.organization_id, v_row.id, v_row.user_id, 'UNAPPROVE_BACKFILL_BIRTH') b;
      UPDATE public.income_expenses
         SET birth_operation_id = v_row.id,
             birth_txid = v_txid,
             source_payload_hash = v_hash
       WHERE id = v_row.id;
      v_n := v_n + 1;
    EXCEPTION WHEN others THEN
      -- Cung khuon 20260723230000: lop bi writer-he-thong chan (forfeit pair,
      -- profit-linked, salary…) thuoc adapter owner, ghi nhan chu khong chan
      -- migration. Khac biet duy nhat: tu nay chung KHONG con la ngo cut —
      -- trigger (1) se cap khai sinh o lan quay ve UNAPPROVED ke tiep.
      INSERT INTO app_private.income_expense_v2_backfill_exceptions
        (organization_id, voucher_id, reason_code, detail)
      VALUES (v_row.organization_id, v_row.id, 'BIRTH_STAMP_BLOCKED',
              jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM,
                                 'dot', 'UNAPPROVE_BACKFILL_BIRTH', 'code', v_row.code))
      ON CONFLICT DO NOTHING;
      v_blocked := v_blocked + 1;
    END;
  END LOOP;
  RAISE NOTICE 'backfill khai sinh (dot huy duyet): % phieu, % bi chan', v_n, v_blocked;
END
$backfill$;

COMMIT;

NOTIFY pgrst, 'reload schema';
