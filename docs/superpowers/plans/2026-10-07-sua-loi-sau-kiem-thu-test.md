# Plan sửa lỗi sau kiểm thử thật trên TEST — 07/10/2026

> **Trạng thái:** plan, CHƯA thi hành. Nguồn lỗi + bằng chứng: [`docs/audits/2026-10-07-kiem-thu-test-env/`](../../audits/2026-10-07-kiem-thu-test-env/README.md).
> Mã nguồn lúc kiểm: `1c616829` (= production). Luật thi hành: [Project Contract](../../engineering/PROJECT_CONTRACT.md) — plan này
> không thay Contract; chỗ nào lệch thì Contract thắng.

## Tóm tắt

- 139 mục đã kết luận (thử thật trên TEST bằng tài khoản hệ thống + kiểm lại bằng phản biện độc lập): **1 P0, 19 P1,
  67 P2, 37 P3**, 16 không phải lỗi; 0 mục P0/P1 bị phản biện bác bỏ. Chi tiết: [README audit](../../audits/2026-10-07-kiem-thu-test-env/README.md).
- Phần lớn lỗi nặng **chưa gây thiệt hại trên production** vì dữ liệu chưa chạm tới (0 dòng vật tư không gắn công ty,
  0 phiên bàn giao vào sổ ảo, 0 phòng bị khoá bởi bảng cọc cũ, 0 người bị tách quyền thanh lý). Đã thiệt hại thật: Báo cáo Lợi
  Nhuận hỏng từ 30/09; "Công nợ tổng" thiếu 86 hoá đơn quá hạn (309,7 triệu); nhắc nợ quá hạn chỉ bắt 9/95 hoá đơn; Chủ công ty
  thấy thẻ thống kê hoá đơn = 0; quyết toán đã thu thừa 25.202 đ (41 phiếu); Import chỉ số chưa từng chạy được.
- Gom theo **nguyên nhân gốc** thay vì sửa từng triệu chứng: 6 gốc chung giải quyết khoảng một nửa số lỗi —
  (G1) bản ghi tạo không gắn `organization_id`; (G2) máy chủ kiểm quyền khác giao diện; (G3) đọc bảng `tenants` cũ
  (bảng đã rỗng, 444/444 HĐ có `tenant_id` NULL); (G4) "còn nợ" lọc thiếu `OVERDUE`; (G5) chức năng chạy từ trình duyệt
  thay vì máy chủ (nhắc việc, hoàn thành việc); (G6) cài đặt/tính năng "ma" — có màn nhưng không có tác dụng.
- Thứ tự: **Đợt 0** (chặn rủi ro, làm ngay) → **Đợt 1** (tiền và số liệu sai) → **Đợt 2** (gốc chung) → **Đợt 3** (P2 còn
  lại) → **Đợt 4** (P3, dữ liệu, tooling). **Đợt D** (tài liệu) chạy song song.
- **Sửa L54 (promote) trước mọi lần phát hành khác** — nếu không, mỗi lần promote vẫn có thể kéo theo commit đỏ.

## 0. Quyết định cần anh chốt (có mặc định — trả lời "đồng ý hết trừ Qx" là đủ)

| # | Câu hỏi | Mặc định đề xuất | Ảnh hưởng nếu chọn khác |
|---|---|---|---|
| Q1 | Bật kiểm `contracts.terminate`/`transfer`/`renew` (thanh lý, chuyển phòng/nhượng, gia hạn) và `tasks.complete` (hoàn thành việc) ở máy chủ | **Bật**. Hợp đồng: hôm nay cả 5 vai có `contracts.edit` đều có đủ 3 khoá ⇒ không ai mất quyền. Công việc: joey, nathan (Quản Lý Tòa, đang tự hoàn thành ~350 việc) KHÔNG có `tasks.complete` ⇒ phải cấp cho vai Quản Lý Tòa ở cả 2 công ty TRƯỚC khi bật | Không bật ⇒ bỏ các khoá này khỏi bộ chọn quyền và sửa tài liệu, để khỏi hứa một hàng rào không tồn tại |
| Q2 | Cài đặt/tính năng "ma" (L14 tự sinh hoá đơn, L15 các công tắc Cài đặt chung, L16 định mức bậc thang, L17 gạch nợ tự động, L22 tab mẫu không thêm được, L23 logo, L47 các màn giữ chỗ) | **Ẩn hoặc gắn nhãn "chưa hoạt động" ngay**; nối công tắc "tự duyệt hoá đơn" vào cờ cấp công ty (chỉ chủ sửa) vì cờ đó có người đọc thật; các tính năng còn lại chỉ làm khi anh chọn | Làm thật từng cái là việc M–L riêng |
| Q3 | Bàn giao tiền mặt: cho nộp cho **Chủ công ty** (vai RBAC), không chỉ tài khoản hệ thống super admin? | **Có** — người nhận hợp lệ = cùng đội, hoặc có quyền nhận bàn giao cấp công ty | Giữ nguyên ⇒ nhân viên chỉ nộp được cho tài khoản hệ thống |
| Q4 | Đổi mật khẩu: ngoài kiểm "mật khẩu hiện tại" trong app, bật thêm "Secure password change" của Supabase Auth? | **KHÔNG bật** (đổi so với bản đầu): tuỳ chọn đó bắt xác thực lại bằng mã OTP gửi email/SMS, mà hầu hết tài khoản đăng nhập bằng tên với email giả `@username.ihomecrm.local` ⇒ không nhận được mã ⇒ không ai đổi được mật khẩu. Chỉ sửa app: xác thực mật khẩu hiện tại bằng `signInWithPassword` trước khi `updateUser` | Gọi thẳng API Auth bằng phiên đang mở vẫn đổi được — chấp nhận, vì người đó đã có phiên |
| Q5 | Nút "Reset dữ liệu DEMO" trên site docs (snapshot tháng 7, bí mật nhúng trong JS) | **Gỡ nút và khoá hàm** (DEMO đã dựng lại 11/08, không ai dùng reset) | Giữ ⇒ phải chụp lại snapshot từ DEMO hiện tại và chuyển xác thực sang JWT super admin |
| Q6 | Trang công khai `/phongtrong`: hiện toà theo công ty của token (thêm 45/3 Trần Thái Tông) và bỏ giá/cọc của phòng đã thuê khỏi dữ liệu trả về? | **Có cả hai** | Giữ lọc theo người tạo ⇒ toà do người khác tạo không bao giờ lên trang |
| Q7 | Phiếu chi vượt cam kết: tạo yêu cầu duyệt giao cho chủ (hiện ở `/approvals` + thông báo)? | **Có** | Không ⇒ chỉ sửa tài liệu: phiếu chờ ở tab "Chờ xử lý" của Thu chi |
| Q8 | Bỏ hẳn bảng `deposits` cũ khỏi luồng (nút "Cọc" ở Khách hẹn, kiểm khoá phòng, Bảng tin) | **Có** — production đã đo 0 dòng `deposits`/`leads`/`tenants` nên an toàn | — |
| Q9 | Tab "Chốt LN tháng", "Cổ đông", "Lương của tôi" đang ẩn sau 3 lần bấm | **Hiện theo quyền** (Lương của tôi luôn hiện) | Giữ "easter egg" |
| Q10 | Quyết toán đã thu lại phần làm tròn (N-A1-05): đo được **25.202 đ** trên 41 phiếu (06→10/2026); rủi ro còn treo ≈ 93.666 đ trên 65 HĐ | **Chỉ sửa từ nay**, không lập chứng từ điều chỉnh cho 41 phiếu cũ (số nhỏ, mỗi phiếu < 10.000 đ) | Muốn hoàn ⇒ lập phiếu điều chỉnh theo từng HĐ (không sửa tay phiếu cũ) |
| Q11 | joey/nathan đang có quyền cấp riêng `categories.*` TOÀN CÔNG TY còn sót từ đợt chuyển đổi 07–08 (trái quyết định 03/10 "chỉ chủ công ty sửa danh mục") | **Thu hồi** 8 quyền cấp riêng này (có lý do ghi vào nhật ký phân quyền) | Giữ ⇒ họ vẫn sửa được danh mục/phân loại tài chính của cả công ty |

## 1. Cách thi hành chung (áp cho mọi đợt)

1. Mỗi mục = một nhánh/worktree riêng, PR nhỏ theo **một gốc**. Mục đụng **tiền, quyền hoặc migration** ⇒ draft PR + một lượt
   review chéo trên diff cuối (Contract §3).
2. **Tái hiện trước khi sửa**: mỗi lỗi đã có kịch bản tái hiện trong thư mục bằng chứng (script `*.cjs`/`*.sql`). Chuyển thành
   test (vitest cho logic client; test RPC/SQL chạy trên database dùng một lần cho hàm SQL; đột biến với tiền/quyền theo
   Contract §8). Test phải ĐỎ trên mã cũ, XANH sau khi sửa.
3. Schema/hàm SQL: migration forward mới (không sửa migration đã áp), thử trên TEST bằng `npm run test-env:thu-sql`, rồi áp
   production chỉ qua `npm run migrate:forward` có backup/biên nhận (Contract §4). Đổi kiểu trả về RPC ⇒ tạo `_v2`.
4. Kiểm trên TEST bằng app thật: `npm run test-env:check` (+ chạy lại kịch bản tái hiện của lỗi đó) — TEST đồng bộ lại khi bắt đầu đợt.
5. `npm run gate:truoc-push` → CI đúng SHA → `npm run promote:production -- --sha <40 ký tự>` (sau khi L54 đã sửa) → kiểm Vercel READY.
6. Sửa xong từng mục thì sửa luôn câu tài liệu liên quan (Đợt D, nhóm "sửa sau khi sửa app").
7. Đường dẫn bằng chứng dạng `A#/…` hoặc `audit/A#/…` trong plan này tính từ thư mục bằng chứng
   `C:\Users\Nguyen Tam\ihomecrm-backups\audits\2026-10-07-kiem-thu-test-env\` (ngoài repo vì có dữ liệu thật của TEST).

## 2. Đợt 0 — chặn rủi ro ngay (≈ 3–4 ngày công)

| # | Lỗi | Sửa | Chỗ sửa | Migration | Kiểm | Ước lượng |
|---|---|---|---|---|---|---|
| 0.1 | **N-A6-11** (P0) + N-A2-06, N-A4-03, N-A6-12 — bản ghi không gắn công ty / người dùng đa công ty không ghi được | (a) Mọi hook ghi gửi `organization_id` của công ty đang chọn (`withOrg`): `useMaterials.ts:89`, `useMaterialPurchases.ts:41,48`, `useMaterialAdjustments.ts:31,38`, `useMaterialUsages.ts:107`, `useAssetWarehouses.ts:47-49`, `useHotlines.ts:43`, `useAutoDebtConfig.ts:49`, `useSettings.ts:465-475`; `create_cash_handover` lấy org từ sổ nguồn. (b) Migration: trigger `autofill_org_strict` + `NOT NULL organization_id` cho các bảng trên, bỏ nhánh `organization_id IS NULL` khỏi policy `*_org_boundary` của chúng. (c) Rà mọi bảng còn policy chấp nhận NULL (danh sách quét: `A6/W21/org-null-scan.json`) và xử lý cùng mẫu | hooks + `supabase/migrations/<mới>` | Có | Đo production trước: 9 bảng hiện 0 dòng NULL (đã đo 07/10) ⇒ đặt NOT NULL an toàn. Test: JWT `demo.chunha` không đọc/sửa/xoá được dòng của công ty thật; super admin (2 công ty) tạo được vật tư/phiếu xuất/phiên bàn giao/cài đặt | M |
| 0.2 | **L02** (P1, thành P0 khi tách vai) | `app_private.assert_contract_exit_writer_v1` (dùng chung cho `confirm_contract_return_v1`, `finalize_contract_exit_case_v1`, `update_contract_exit_case_kind_v1`, `run_contract_exit_settlement_v1`) kiểm `contracts.terminate`; `transfer_room`/`transfer_contract`/`apply_contract_notice_transition_v1` kiểm `contracts.transfer`; `renew_contract` kiểm `contracts.renew`. **REVOKE** `terminate_contract_move_out`/`terminate_contract_forfeit` (+ 2 bản `_with_credit_v1`) khỏi `authenticated`: không còn màn nào gọi, nhưng đang cho người có `contracts.edit` thanh lý thẳng HĐ, bỏ qua hồ sơ trả phòng. Chốt ngữ nghĩa "có `terminate` mà thiếu `edit`" (Q1) | `supabase/migrations/<mới>` (định nghĩa cuối ở `20260928015559…`, `20260929123356…`, `20260731050000…`, `20260601000100…`, `20260822093000…`, `20260721135500…`) | Có | Test RPC hai chiều cho từng khoá (CẤM ⇒ 42501, CHO ⇒ chạy) + test quét: mọi hàm ghi hợp đồng phải nêu khoá riêng. Chạy lại `A1/l02-probe.cjs` | S–M |
| 0.3 | **N-A2-07** (sát P0) | `confirm_cash_handover` từ chối sổ nhận `is_virtual` VÀ sổ thuộc công ty khác công ty của phiên; ô "Sổ nhận tiền" lọc sổ ảo (`HandoverSheet.tsx:109-114,304-316`) | migration + UI | Có | Test RPC 3 ca (sổ ảo, sổ khác công ty, sổ hợp lệ); chạy lại kịch bản `A2/ev/w11-virtual-rollback` ⇒ bị từ chối | S |
| 0.4 | **L01** | Trước `updateUser`, xác thực lại bằng `signInWithPassword(email của phiên, currentPassword)`; ô trống/sai ⇒ chặn (desktop `ProfilePage.tsx`, mobile `AccountMobilePage.tsx`, hook `useProfile.ts:166-171`). Q4: bật xác thực lại ở Supabase Auth | UI + cấu hình Auth | Không (cấu hình Auth qua Management API — việc ngoài repo, cần chủ đồng ý) | Kịch bản `audit/A4` L01: mật khẩu hiện tại sai ⇒ bị chặn, đúng ⇒ đổi được; desktop 1440 + mobile 390 | S |
| 0.5 | **L54** — **ĐÃ XONG** bởi PR #140 (merge 07/10 23:21, `74c5de95`…`15d0e2ed`) | Push lên `main` plan từ đỉnh `production`; promote chỉ nhận aggregate có `snapshot.base` là tổ tiên/chính đỉnh `production` (`evidenceCoversProduction`), plan không base bị từ chối; không huỷ run đang chạy trên `main`; `--sha` ngắn tự giải; promote kiểm Vercel sau push | `scripts/promote-to-production.mjs`, `.github/workflows/ci-gates.yml` | Không | Test đã có ở `scripts/__tests__/promote-to-production.test.mjs` (base tổ tiên ⇒ phủ; base mới hơn ⇒ từ chối; full không base ⇒ từ chối). Còn lại: lần promote kế tiếp phải cho CI chạy lại dải `production..main` (dispatch trên `main` plan từ `production`) để chứng minh dải hiện tại không còn gate đỏ đã lỡ lên | — |
| 0.6 | **N-A5-01** | `REVOKE EXECUTE ON FUNCTION reverse_invoice_payment_v3 FROM authenticated` (không còn call site trong `src/`) | migration | Có | grep call site = 0; gate `check-definer-body-authz` xanh | S |

## 3. Đợt 1 — tiền và số liệu sai (≈ 6–8 ngày công)

| # | Lỗi | Sửa | Migration | Kiểm | Ước lượng |
|---|---|---|---|---|---|
| 1.1 | **N-A3-01** — Báo cáo Lợi Nhuận hỏng với dữ liệu cũ (production có 18 dòng) | `disposition()` nhận `LEGACY_RETAINED_UNALLOCATED` (+ kiểu `ProfitUnallocatedDisposition`, nhãn "Giữ lại (chốt kiểu cũ)"); test bằng dòng dạng thật lấy từ `audit/A3/state-2026-05.json` | Không | Tab Tổng quan + Chốt LN T05/2026 mở được trên TEST; mở khoá/đặt lại tháng cũ chạy | S — **làm đầu tiên** |
| 1.2 | **N-A1-05** — quyết toán thu lại làm tròn hoá đơn đã trả đủ | Vòng lặp "Quyết toán hoá đơn còn nợ" trong định nghĩa cuối của `terminate_contract_move_out_impl` bỏ hoá đơn `PAID` (hoặc trừ phần đã làm tròn); UI (`useContracts.ts:1087`) và máy chủ dùng chung một danh sách | Có | Kịch bản W06b (`audit/A1/w06n-*`): số nợ ghi = số trên màn xác nhận. Q10: đo lịch sử các lần thanh lý đã thu thừa | S–M |
| 1.3 | **N-A1-03** + **N-A1-02** | `settle_reservation_deposit_v1`/`reservation_pay_refund_v1` đóng giữ chỗ + claim trong cùng giao dịch khi mọi phiếu cọc của giữ chỗ đã xử lý (còn phiếu nạp thêm chưa xử lý thì giữ); thêm "claim LIVE" vào `reservation_room_blockers_v1`; sổ nội bộ chọn theo mục đích ("Cấn trừ nội bộ") thay vì "sổ ảo cũ nhất" (`reservation_internal_account_v1` — production hiện ra sổ tiền thối của nhân viên). Production hiện 0 giữ chỗ ⇒ không có claim treo phải dọn | Có | Kịch bản W03 (`A1/w03-after-forfeit-*`): xử lý 1/1 phiếu ⇒ claim đóng, khách khác giữ chỗ được; 1/2 phiếu ⇒ claim còn; cặp bút toán vào sổ nội bộ | M |
| 1.4 | **L12** + N-A6-04 (Q8) | Chặn nhanh: ẩn nút "Cọc" ở Khách hẹn. Sau đó nút mở luồng `create_room_reservation_v1` điền sẵn khách + phòng từ lead (tạo `customers`), lead CONVERTED + `deposit_id`/`conversion_date` sau khi phiếu tạo xong; bỏ nhánh `deposits` khỏi `room_has_holding_deposit`, `reservation_room_blockers_v1`, `assert_room_reservation_legacy_sources_v1` (production `leads`/`deposits`/`tenants` 0 dòng ⇒ an toàn); Bảng tin đếm `room_reservations` | UI + migration | Có | Kịch bản W02: không còn dòng `deposits`; giữ chỗ hiện trên /deposits; phòng không bị khoá ngầm; bị ngắt giữa chừng không để khách/phiếu mồ côi | M |
| 1.5 | **N-A4-04** + **L30** (gốc G4 + phạm vi) | Một định nghĩa "còn nợ" = `APPROVED, PARTIAL_PAID, OVERDUE` (hoặc theo `due_date` + số còn nợ) dùng chung cho `get_dashboard_summary`, `DebtChart.tsx:35`, `useDashboard.ts:248`, `notificationScheduler.ts:114,176`; `get_invoice_statistics_v2` lấy phạm vi toà như RLS (`buildings_for_v3('invoices.view')`), không qua `staff_assignments` — rà các RPC báo cáo khác còn dùng `staff_assignments` | Có | Chủ công ty (`nguyentam`) thấy thẻ thống kê = tổng trên bảng; Quản Lý Tòa đủ 9 toà; "Công nợ tổng" gồm 86 hoá đơn quá hạn (309,7 triệu) | S–M |
| 1.6 | **L36**, **N-A6-06**, **N-A1-UI-01** | L36: RPC gộp theo phòng (kỳ lớn nhất, số còn nợ), lọc chưa thu, ô phòng thật, thêm cột tiền. N-A6-06: lọc giảm ≠ 0, đọc `months × amount_per_month`/lịch hỗ trợ v2. N-A1-UI-01: `!inner` + lọc máy chủ + `count` thật thay vì cắt 50 | L36 có | So số trên màn với SQL độc lập (kịch bản trong `audit/A2/ev/l36-cap.txt`, `audit/A6/scripts/l32-reports.cjs`, `audit/A1/ui/detail-result.json`) | M |
| 1.7 | **N-A4-02** + N-A4-01 + N-A6-08/N-A6-09 (P2, theo Q1) | N-A4-02: nhánh `building_id IS NULL` của 8 bảng đòi quyền phạm vi TOÀN CÔNG TY. N-A4-01: nút "Toà đang phụ trách" không đưa phạm vi toàn công ty. N-A6-08/09: hoàn thành việc qua RPC kiểm `tasks.complete` + ảnh/GPS phía máy chủ (cấp quyền trước) | Có | JWT fixture chỉ có quyền 1 toà: tạo kho cấp công ty ⇒ 403; joey (không có complete) ⇒ không hoàn thành được; ngoại lệ "Toà đang phụ trách" lưu đúng toà | M |
| 1.8 | **L13d** + **N-A2-01** | Import chỉ số tra mã công tơ trong phạm vi toà rồi gọi `bulk_create_meter_readings_v1`/`create_meter_reading_v1`; thu hồi `bulk_create_meter_readings` legacy. Form đọc đúng cột `code/name/meter_type` (`meterReadingFormUtils.ts`) | Có | Kịch bản W08 (`audit/A2/w08b-import-edit.cjs`): joey import được, dòng ra APPROVED; form có tên công tơ | S–M |
| 1.9 | **N-A6-S01**, L18 (P2, rẻ nên làm cùng) | S01: cho bỏ trống loại tài sản (Zod optional, gửi null — form Sửa đang `\|\| ""`; đừng gửi chuỗi "none"), sau đó làm màn Loại tài sản (L47c, Q2). L18: RPC trả `configured:false` + số 0 (vẫn jsonb) hoặc Zod nhận null; "Việc của tôi" tách khỏi QueryRegion ngày công; đổi đích dự phòng của thông báo; ẩn ô "Hôm nay" khi công ty chưa bật | L18 tuỳ | Tạo + sửa tài sản không cần loại (cả tài sản cũ có loại NULL); `/my-day` của `demo.*` vẫn thấy "Việc của tôi" | S–M |
| 1.10 | Soát dữ liệu do L28 che | Lỗi nuốt ngoại lệ ở `_termination_apply_extra_charges` đã che **INV-2026-00937** (hoá đơn thanh lý 102LVT/408 tính 1.090→1.483, 1.532.700 đ, không khớp công tơ 5.560→5.793) và một chỉ số ghi ngày TƯƠNG LAI 31/10/2026 (5.793→7.245) trên cùng công tơ. Đọc production (chỉ đọc), đối chiếu với chủ, rồi sửa bằng luồng điều chỉnh hoá đơn/chỉ số có vết — không sửa tay DB | Không (dữ liệu qua luồng app) | Hoá đơn và chuỗi chỉ số công tơ liền mạch | S |

## 4. Đợt 2 — gốc chung (≈ 5–7 ngày công)

### 2.1 Hoàn tất chuyển "tenant → customer" ở phía đọc (G3)
Bảng `tenants` đã rỗng; mọi chỗ còn nhúng nó đều trả trống. Thay bằng khách đại diện qua `contract_customers → customers`
(helper sẵn có: `useRoomsWithContracts.ts:96-97`, `IssuedInvoiceEditor.tsx:40-44`), rồi gỡ phụ thuộc. Danh sách tại `1c616829`:

| Nhóm | Chỗ (file:dòng) | Lỗi đã thấy |
|---|---|---|
| Chi tiết toà/căn hộ | `src/hooks/usePropertyDetailQueries.ts:73,78,83,93,99` | N-A1-UI-02 |
| Sơ đồ toà | `src/components/building-map/RoomDetailDialog.tsx:70` | L31 |
| Báo cáo BĐS | `src/hooks/reports/realEstateReports.ts:361,715,788,855` | L32 |
| Hộp thu tiền | `src/components/invoices/RecordPaymentDialog.tsx:830-831` | L29 |
| Nhắc việc | `src/lib/notificationScheduler.ts:50,111,173`; `src/lib/invoiceHelpers.ts:148` | N-A6-14 |
| In / xuất file | `src/pages/invoices/InvoicePrintPage.tsx:25`; `src/lib/exportDatasetRegistry.ts:98,110,147` | (chưa kiểm — khả năng cao trống tên khách trên bản in/Excel) |
| Hợp đồng/thanh toán/cọc | `src/hooks/useContracts.ts:999,1010,1183`; `src/hooks/usePayments.ts:70,116`; `src/hooks/useInvoices.ts:1627`; `src/hooks/useDeposits.ts:277`; `src/hooks/reports/financeReports.ts:155` | (chưa kiểm từng màn) |
| Thu chi / tài sản | `src/hooks/income-expenses/queries.ts:303,847`; `src/hooks/income-expenses/detailRead.ts:84`; `src/hooks/useAssets.ts:349` | (chưa kiểm) |

Kiểm: một test hợp đồng kiểu cho helper khách đại diện + quét lại `grep "tenant:tenants"` = 0; xem lại bản in hoá đơn,
Excel xuất HĐ/hoá đơn/thanh toán. Không cần migration (trừ khi quyết định DROP bảng `tenants` — để đợt sau). Bẫy: bảng
`contract_customers` có hai khoá ngoại ⇒ embed phải ghi rõ FK (`contract_customers!contract_customers_contract_id_fkey(…,
customer:customers!contract_customers_customer_id_fkey(…))`). **N-A1-UI-02 phải sửa CÙNG hoặc TRƯỚC L20/L73** (mở lối vào
trang chi tiết căn hộ trước thì câu sai "chưa có khách hàng" lên ngay màn chính); gộp với N-A1-UI-01 vì cùng hook.

### 2.2 Nhắc việc chạy ở máy chủ (G5 — L11, N-A6-14)
Chuyển 4 bộ nhắc (hoá đơn sắp hạn, quá hạn, thiếu cọc, HĐ sắp hết hạn) sang cron máy chủ theo mẫu `lifecycle-reminders-15m`;
người nhận theo quyền + phạm vi toà (`lifecycle_recipient_allowed_v1`), khoá `UNIQUE (user, loại, ref, ngày VN)` — dọn 139 dòng
trùng hiện có trước khi đặt; bỏ hẳn chèn từ trình duyệt (`useScheduledNotifications`); tên khách qua 2.1; lọc quá hạn theo
`due_date < org_today` + còn nợ thay vì theo status (production: nhắc hiện chỉ bắt 9/95 hoá đơn quá hạn, 17 hoá đơn chưa từng
được nhắc). Bẫy: so `created_at` với chuỗi ngày lệch 7 giờ (00:00 UTC). Có migration. Kiểm: không mở Bảng tin vẫn có nhắc;
không trùng khi chạy đồng thời; Chủ công ty nhận nhắc cho HĐ người khác tạo; quản lý chỉ nhận toà mình.

### 2.3 Bảng tin đúng phạm vi (N-A6-01/02/03, L49, L07)
Mọi khối lọc theo toà đang chọn (cảnh báo, hoạt động, khách hẹn/cọc, biểu đồ nợ); "công việc chưa xử lý" đọc `jobs`;
"hợp đồng mới" bỏ HĐ đã xoá; ẩn số tiền khi thiếu `dashboard.view_finance`; route `/` kiểm `dashboard.view`. RPC
`get_dashboard_summary` cần `_v2`. Kiểm: lọc 331PHI ⇒ mọi khối chỉ còn số của 331PHI.

## 5. Đợt 3 — P2 còn lại (≈ 8–10 ngày công, chia nhiều PR nhỏ theo khu)

| Khu | Mục | Ghi chú sửa |
|---|---|---|
| Quyền giao diện | L04, L05, L06, N-A4-07, N-A5-04, N-A6-13 | L04: RPC đòi chủ công ty, route gác `reports_finance.analysis`; L05: `canExport` cho `ExportButtons` (cả `reports_finance.export`); L06: `permissionModule` cho `CategoryCrudPage`; N-A5-04: danh mục phạm vi bỏ toà đã xoá; N-A6-13: chủ công ty đọc hồ sơ thành viên cùng công ty |
| Hợp đồng/cọc | L71, L27, L28, N-A1-01, N-A1-04, N-A1-06, L20, L21, L26, L44, L73, N-A1-UI-03 | L71: chỉ cho chọn phòng cùng toà + mã lỗi 55000; L28: bỏ nuốt lỗi, số cuối thanh lý thành mốc trả phòng; L44: so khớp tỉnh sau chuẩn hoá (`normalizeProvinceName`) + thống nhất 2 form sửa toà; L20/L73/UI-03: route `/rooms/:id` giữ id, link từ bảng Toà nhà/Căn hộ/hộp sơ đồ |
| Chỉ số/hoá đơn/thu | L13a, L13c, L13e, N-A2-02, N-A2-03, N-A2-04, N-A2-05, L19, L14+L15 (Q2), N-A2-08 | L13a: production có 11 nhóm trùng thật (59 nhóm khác là chỉ số chốt trả phòng TLY — đúng thiết kế) ⇒ KHÔNG đặt UNIQUE(meter_id, settlement_month) trần; dùng chỉ mục một phần loại dòng TLY/dòng gắn mốc + bắt Ngày chốt nằm trong Tháng chốt; L13c: chặn sửa chỉ số đã lên hoá đơn; L13e: chỉ số liền trước theo ngày; L19: href `/income-expense/voucher/:id` |
| Sổ quỹ/báo cáo tài chính | L34, L35, L37, L39, N-A3-02, N-A3-04 (Q7), L40 | L34: cộng `initial_amount`; L35/L37: đổi nhãn; N-A3-02: quy tắc lỗi "kỳ đã khoá" + Báo chi nhanh không chọn sẵn sổ đã chốt |
| Vận hành | L24, L25, N-A6-05, N-A6-07, L16+L17+L22+L47 (Q2), L33 | N-A6-05: `"none"` → null; L33: lý do cắt dòng + mở rộng |
| Bảo mật nhỏ/công khai | N-A5-05 (Q5), N-A5-06 + L08 (Q6) | — |
| Hiệu năng (L53) | `get_my_permissions_v2` (TB 209 ms, max 7,8 s), danh sách HĐ `count=exact` + embed (`useContracts.ts:316-321`), `get_contract_stats`, truy vấn accrual; N-A5-03: chuyển gate catalog/pg_dump khỏi giờ cao điểm production; chụp ảnh tài liệu tối đa 2 trình duyệt song song | đo lại bằng `pg_stat_statements` sau khi sửa |

## 6. Đợt 4 — P3, dữ liệu, tooling (≈ 3–4 ngày công)

- **Nhãn/định dạng/nút thừa:** L41 (bảng nhãn trạng thái phòng chung trong `src/lib/roomStatus.ts`), L42, N-A1-07, N-A1-UI-04,
  N-A1-UI-05, N-A2-09, N-A2-10, N-A3-03, N-A3-06, N-A3-07, N-A4-05, N-A4-08, N-A6-10, N-A6-15, N-A6-16, N-A6-S04, N-A6-S05,
  N-A6-S06, L45, L52 (Q9), L69 (câu gợi ý).
- **Logic nhỏ:** N-A2-08 (hiển thị trừ phần làm tròn), N-A3-08 (phiếu thiếu/thừa quỹ gán toà ảo "Chung"), L23 (logo theo
  công ty + đưa vào bản in, nếu Q2 chọn làm), quan sát A1 (chuyển phòng ghi mốc chỉ số; "Xác nhận ký" thẳng ghi mốc nhận phòng).
- **Dữ liệu (migration dữ liệu/fixture, chỉ DEMO trừ khi ghi khác):** L60 (điền `fee_type/pricing_type/unit/code` cho 3 dịch vụ
  DEMO + gắn Toà C/D), L61 (sổ tiền mặt riêng cho `demo.chunha`), L63 (spec `.e2e-fleet` dọn fixture lương theo `note`),
  L59/L76 (giải quyết qua N-A5-04; tuỳ chọn dọn scope mồ côi), N-A4-06 (**production**: gán `type='lease_contract'` cho 3 mẫu
  HĐ `type` NULL — đo lại trên production trước), quy tắc lương điều hành của quản lý đã xoá (A3 — chủ quyết).
- **Tooling/mã chết:** L51 (xoá `RenewedBadge` + gỡ strict-islands), L46 (registry gán `userDoc` cho Trung tâm mạng; gate
  kiểm lý do miễn trừ còn đúng), L48, L55 (`declare const process` trong `docs-site/middleware.ts`), N-A5-02 (gỡ 3 mục "ma"
  khỏi allowlist, gate hiểu `DROP FUNCTION`), N-A6-S07 (build TEST bật cờ Trung tâm mạng), L56 (khi bật lại Copilot).

## 7. Đợt D — tài liệu (song song)

Tài liệu người dùng (`docs/huong-dan-su-dung/`) vừa đồng bộ 07/10 nhưng thử thật cho thấy các chỗ dưới đây lệch app.
**D1 — tài liệu SAI so với app (sửa ngay, một PR docs):**

| Trang | Sửa |
|---|---|
| `01-bat-dau/quy-trinh-ban-giao` (~dòng 54, 61) | Bỏ câu "Danh sách liệt kê mọi nhân viên…" (câu do đợt đồng bộ 07/10 thêm, SAI): danh sách người nhận = cùng đội + tài khoản hệ thống, máy chủ chỉ nhận hai loại đó, chưa nhận vai "Chủ công ty" (L10, chờ Q3). Phiếu bị khoá ngay khi phiên còn chờ, không đợi xác nhận (L68) |
| `03-quan-ly-van-hanh/gia-han-chuyen-phong` (~61) | Chuyển phòng sang toà khác luôn bị máy chủ từ chối (L71) |
| `03-quan-ly-van-hanh/dat-coc` | Giữ chỗ 0 đồng không đổi trạng thái phòng (chỉ chặn người khác giữ); sau "Xử lý bỏ cọc" phải bấm "Hủy giữ chỗ" (tới khi sửa N-A1-03) |
| `03-quan-ly-van-hanh/hoa-don` (~31, 57), `sinh-hoa-don` (~48) | Trạng thái hoá đơn mới theo cờ cấp công ty (hiện: duyệt ngay), không theo công tắc ở Cài đặt chung (L15); ô tìm chỉ nhận mã phòng dạng số/MB/G/L (N-A2-09) |
| `03-quan-ly-van-hanh/thu-chi` (~69), `cho-duyet`, `01-bat-dau/quy-trinh-chot-thang` (Bước 1), `so-quy` | Phiếu chi vượt cam kết nằm ở tab "Chờ xử lý" của Thu chi, không hiện ở `/approvals` (N-A3-04, tới khi Q7); phiếu có "Cài đặt lặp lại" luôn chờ duyệt (N-A3-05); cột "Số dư đầu kỳ" cũng ẩn với người không giữ sổ |
| `02-theo-doi-nhanh/thong-bao` (~49) | Nhắc việc sinh theo TRÌNH DUYỆT khi mở Bảng tin desktop, chỉ quét bản ghi do chính người mở tạo (L11) |
| `02-theo-doi-nhanh/viec-cua-toi` | Lỗi xảy ra khi CÔNG TY chưa bật chấm ngày công v5, không phải theo tài khoản (L18) |
| `02-theo-doi-nhanh/bang-tin` (Bước 2, Sandbox) | Cảnh báo, hoạt động, khách hẹn/đặt cọc, biểu đồ nợ chưa đổi theo toà; "công việc chưa xử lý" luôn 0 (N-A6-01/02, L49) |
| `03-quan-ly-van-hanh/cong-viec` (~23) | Quyền "Hoàn thành" chưa được máy chủ kiểm; ảnh bắt buộc chỉ ở giao diện (N-A6-08/09) |
| `04-bao-cao/{hd-sap-het-han ~63, cho-thue-moi ~59, khuyen-mai ~64, thanh-ly ~69}`, `lich-thanh-toan` (~40) | Cột Khách hàng "N/A" với MỌI hợp đồng (L32); Khuyến mại tổng giảm hiện 0 (N-A6-06); "đến ngày" của Lịch thanh toán sai do cắt 1.000 dòng (L36) |
| `03-quan-ly-van-hanh/toa-nha`, `can-ho-phong` | Nút Dạng lưới/Tìm kiếm chưa có tác dụng (N-A1-UI-04) |
| `05-cai-dat/danh-muc-khac` (~34, 64), `loai-cong-viec`, `cai-dat-chung` | 5 thẻ dẫn tới trang giữ chỗ (không phải 3) (N-A6-S02); loại công việc cấu hình theo công ty; các công tắc theo tài khoản chưa có tác dụng, super admin không lưu được (L14, L15, N-A4-03) |
| `07-thong-tin-khac/tra-quyen-nhanh` | Ghi chú: `dashboard.view_finance`, `reports_real_estate.export`/`reports_finance.export`, `tasks.complete` chưa có tác dụng; máy chủ thanh lý đang kiểm `contracts.edit` (tới khi sửa L02, L05, L07, N-A6-08) |
| `docs/he-thong/02-co-cau-toa-nha-phong-dich-vu.md` (33, 106, 127, 404, 406, 414, 419), `docs/he-thong/08-thu-chi-so-quy.md` (37, 112) | Định mức bậc thang và gạch nợ tự động CHƯA chạy; RPC công khai không trả `sale_bonus_note`; hook không còn "nuốt lỗi tiers" (L57, L16, L17) |

**D2 — tài liệu đúng ý đồ nhưng app sai (thêm cảnh báo tạm nếu cần, sửa câu sau khi sửa app):** `so-do-toa-nha` (hộp chi
tiết có tên khách — L31), `can-ho-phong` (tab "Khách hàng (n)" — N-A1-UI-02), `khach-hen` (nút "Cọc" — L12), `thanh-ly-move-out`
(nợ lệch vài trăm đồng N-A1-05; chỉ số trả phòng nhập hai nơi L28), `thu-tien-hoa-don` (~52, N-A2-08), `ghi-chi-so`
(ô "Công tơ chưa chốt trong tháng" N-A2-02), `phan-quyen` (nút "Toà đang phụ trách" N-A4-01), `trung-tam-mang` (~79, L45),
`mau-bieu` (câu "Nhấn 'Thêm mẫu'" ở hai tab không thêm được — L22).

## 8. Phần chưa kiểm — làm kèm các đợt

- Nhượng hợp đồng (5 bước); quyết toán "trả phòng, quyết toán sau"; phiếu "Trả khách thanh lý" chọn sổ → duyệt → chi — kiểm cùng 1.2/1.3.
- Mode Excel tạo hoá đơn, sửa nháp, duyệt điều chỉnh, Thanh toán hàng loạt — kiểm cùng 1.8.
- Lương (chốt kỳ, lập yêu cầu thanh toán, mở khoá), "Chi lợi nhuận", nhóm TOTAL_GROUP, nhánh "Từ chối & huỷ đề nghị" chốt sổ, `/approvals` — kiểm ngay sau 1.1 (N-A3-01 đang chặn "Chi lợi nhuận").
- In hoá đơn/xuất Excel tên khách — kiểm trong 2.1.

## 9. Ước lượng tổng

| Đợt | Nội dung | Công (1 người) |
|---|---|---|
| 0 | 6 mục chặn rủi ro | 3–4 ngày |
| 1 | 9 nhóm tiền/số liệu | 6–8 ngày |
| 2 | 3 gốc chung | 5–7 ngày |
| 3 | P2 theo khu | 8–10 ngày |
| 4 | P3/dữ liệu/tooling | 3–4 ngày |
| D | Tài liệu | 1–2 ngày (rải theo đợt) |

Song song được: Đợt 0.1/0.2/0.3/0.4/0.5 độc lập nhau; Đợt 1.1 làm ngay cùng Đợt 0 (không migration, giá trị cao); Đợt 2.1 độc
lập với Đợt 1. Không chạy hai mục cùng sửa một hàm SQL song song (gom 1.5 với 2.2 vì cùng đụng nhắc nợ).
