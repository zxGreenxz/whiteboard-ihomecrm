# Runbook: lùi Đợt 3 sổ tổng lợi nhuận cổ đông (R7a → R1)

Đợt 3 gồm ba migration:

- D3a `20261115113530_so_tong_loi_nhuan_chuyen_doi`: chuyển đổi dữ liệu, đưa công tắc từ OFF sang SHADOW.
- D3b `20261115113532_so_tong_loi_nhuan_bat`: siết ba policy tự xem, đưa công tắc từ SHADOW sang ON.
- `20261115213226_so_tong_loi_nhuan_don_ham_ghi_bu`: dọn hàm ghi bù chỉ dùng một lần.

Công tắc là `shareholder_profit.ledger_payout.v1`.

Mỗi tệp `d3_<bước>.sql` trong thư mục này là **nội dung migration hoàn chỉnh** (header + `BEGIN; … COMMIT;`) nhưng **KHÔNG phải migration**. Các tệp nằm ngoài `supabase/migrations` và chỉ dùng khi phải lùi.

## Chọn bước

| Tình huống | Các bước |
|---|---|
| Dừng NGAY mọi bước tiền theo sổ tổng | R7a |
| Thôi chi theo sổ tổng (lùi D3b) | R7a → R7b → R7c → R6 (hoặc R7b → R6) |
| Lùi toàn phần về đường cũ LEGACY như trước D3a | **R7a → R7b → R7c → R6 → R3 → R2 → R4 → (R5) → R1** |

**Trước R7b:** xử lý hết phiếu chi theo sổ tổng (`profit.ledger_payout` / `profit.manager_salary`) đang chờ duyệt hoặc đã duyệt mà chưa ghi sổ. Chốt F1 chỉ cho duyệt và ghi sổ khi route là CANONICAL. Có hai cách xử lý:

- Duyệt rồi ghi sổ khi công tắc còn ON (nếu đã chạy R7a thì gỡ đóng băng trước).
- Huỷ có lý do (E6). Lệnh huỷ chạy ở mọi route, kể cả khi đang đóng băng.

R7b và R1 tự dừng (`R7B_PHIEU_KET` / `R1_PHIEU_KET`) kèm số phiếu nếu còn phiếu như vậy.

Luật thứ tự:

- **R6 LUÔN trước R1.** Ở LEGACY, web cũ đọc thẳng ba bảng.
- **R3 và R2 chỉ chạy sau R7b** (công tắc không còn ON, kể cả ON đang đóng băng). Gỡ mốc hay huỷ ghi bù khi còn chi theo sổ tổng làm số dư được phép chi nhảy lên.
- **R3 cần route SHADOW.** Nếu đang đóng băng thì chạy R7c trước.
- **R3 phải chạy trước R1.** Hàm đặt mốc không chạy ở LEGACY.
- **R5 chỉ dùng khi lùi cả web production về bản TRƯỚC Đợt 2.** Bản đó còn gọi lệnh chi cũ.

R1 tự chặn khi thứ tự sai: còn ON hoặc đóng băng, còn policy X5, còn mốc Đợt 3a, hoặc còn phiếu kẹt.

## Áp một bước

1. Chạy `node scripts/tao-ten-migration.mjs <slug>` (slug gợi ý ở header từng tệp). Lệnh này **chỉ in ra tên** `<timestamp>_<slug>.sql`, không tạo tệp.
2. Tạo `supabase/migrations/<tên vừa in>` chứa NGUYÊN VĂN tệp `d3_<bước>.sql`, ví dụ bằng `cp`. Sau đó `git add` tệp đó và chạy `npm run provenance:generate`.
3. Chạy `npm run migrate:forward -- <tệp>`. Đây là dry-run: lane dán HAI lượt trong một giao dịch rồi ROLLBACK.
4. Chạy `npm run migrate:forward -- <tệp> --apply`, chỉ sau khi dry-run xanh.

Sau khi áp, làm tươi provenance và catalog như mọi migration, rồi promote production sớm. CI dán hai lượt mọi migration mới trong `production..HEAD` lên production ở mọi push. Mọi bước đã được thiết kế để lượt chạy lại ở trạng thái SAU bất kỳ bước lùi nào vẫn xanh: nếu đã ở trạng thái đích thì chỉ báo `NOTICE` bằng câu cố định rồi bỏ qua, không ném lỗi.

## Từng bước

| Bước | Làm gì | Bỏ qua (không ghi gì) | Dừng 55000 (không ghi gì) |
|---|---|---|---|
| R7a | `force_freeze = true` + sự kiện `FORCE_FREEZE` ⇒ route FROZEN. Huỷ phiếu (E6) và các màn đọc vẫn chạy | đã đóng băng | `R7A_CONG_TAC`. Không tìm được chủ thì VẪN đóng băng, ghi `actor_missing` |
| R7b | `set_feature_route_v1(…, 'SHADOW')` theo CAS | đã SHADOW; đã OFF | `R7B_PHIEU_KET` (kèm số phiếu), `R7B_CONG_TAC`, `R7B_ACTOR` |
| R7c | `force_freeze = false` + sự kiện `FORCE_UNFREEZE` | không đóng băng | `R7C_CONG_TAC`, `R7C_ACTOR` |
| R6 | ba policy tự xem về USING cũ | — (ALTER lặp lại cùng biểu thức) | `R6_X5` (policy đã bị sửa tay) |
| R3 | gỡ mốc Đợt 3a mới nhất của từng chủ thể (khoá idempotency `d3a-…`): đặt mốc tháng NULL đè đúng mốc đó, khoá `r3-go-moc-<id mốc>` | sau mốc Đợt 3a mới nhất đã có một mốc tháng NULL (mốc gỡ của R3 hoặc chủ tự gỡ), kể cả khi chủ đặt mốc mới sau đó | `R3_MOC_KHAC`, `R3_MOC_TRUOC_D3A`, `R3_TAM_UNG`, `R3_DONG_BANG`, `R3_ROUTE` (CANONICAL / LEGACY), `R3_ACTOR` |
| R2 | dòng C4 nguồn BACKFILL LINKED → VOID; C3 do ghi bù tạo → VOID; ghi C5 `SALARY_VOIDED` | không còn dòng ghi bù | `R2_ROUTE` (công tắc còn ON, kể cả đang đóng băng), `R2_C3_THAY`, `R2_C3_DUNG_CHUNG`, `R2_ACTOR` |
| R4 | bốn phiếu X3 về KQKD tự động; `has_restricted_item` của hai phiếu 21/05 về như trước X3 | đã KQKD tự động | `R4_TRANG_THAI`, `R4_DIEU_KIEN`, `R4_PHIEU`, `R4_ACTOR` |
| R5 | `GRANT EXECUTE` lệnh chi cũ cho `authenticated` | — (GRANT lặp lại) | — |
| R1 | `set_feature_route_v1(…, 'OFF')` theo CAS ⇒ route LEGACY | đã OFF | `R1_CONG_TAC`, `R1_DONG_BANG`, `R1_R6`, `R1_MOC`, `R1_PHIEU_KET` (kèm số phiếu), `R1_ACTOR` |

Chung cho các bước:

- **Người ghi** là tài khoản chủ (TENANT_OWNER, thành viên ACTIVE, kích hoạt sớm nhất), cùng truy vấn với D3a.
- **Khoá:** các bước có ghi dữ liệu, cùng R7b và R1, khoá công ty trước.
- **DB không có công ty thật** (Restore Drill): các bước dữ liệu và công tắc báo "không có công ty thật — bỏ qua". Chỉ R6 (policy) và R5 (quyền) đổi schema, giống X5 của D3b và X4 của D3a.
- **Cách nhận mốc:** R3/R1 nhận mốc Đợt 3a theo tiền tố khoá idempotency `d3a-`, và nhận mốc gỡ của R3 theo khoá `r3-go-moc-<id>`. Khoá web sinh ra là UUID nên không trùng được. Đừng gọi RPC đặt mốc bằng tay với các tiền tố này.

### Điểm dừng cần người quyết (không tự xử lý)

- **`R3_MOC_KHAC`:** chủ đã đè mốc Đợt 3a bằng một mốc có tháng trước khi R3 chạy. R3 không tự gỡ mốc của chủ. Nếu chủ muốn lùi, chủ tự gỡ mốc của mình qua E9 (tháng NULL), rồi chạy lại R3.
- **`R3_MOC_TRUOC_D3A`:** D3a đã đè lên một mốc có tháng đặt trước D3a. Đặt lại tháng đó sẽ sinh thứ tự sổ và giờ mới, làm loại oan các phiếu chi lập sau mốc cũ. Production không có ca này, vì công tắc ở OFF từ Đợt 1 tới D3a.
- **`R3_TAM_UNG`:** gỡ mốc sẽ xoá dấu một khoản tạm ứng. Chỉ khi chủ đồng ý bằng văn bản mới đổi `c_xac_nhan_xoa_tam_ung = true`.
- **`R2_C3_THAY` / `R2_C3_DUNG_CHUNG`:** liên quan tới bản đóng băng lương có từ trước, hoặc đang được dòng khác dùng chung.
- **`R4_DIEU_KIEN`:** phiếu đã hết điều kiện như lúc X3, ví dụ sổ quỹ đã chốt.
- **Giả định của R4**, chưa có gì trong Git hay DB chứng minh:
  - `c_han_che_cu` (hai phiếu 21/05 có `has_restricted_item = false` trước X3) lấy theo phép đo trước khi áp D3a. Đây cũng là quyết định của chủ: muốn giữ "hạn chế" thì để mảng rỗng.
  - Hậu kiểm đòi `kqkd_amount = total_amount`, trong khi KQKD tính lại = `GREATEST(LEAST(phần PNL, tổng), 0)`. Hai số bằng nhau khi mọi hạng mục đều là PNL; nếu khác thì R4 dừng `R4_SAU`, không ghi gì.

## Áp lại D3a sau khi lùi

Áp lại phải là migration MỚI, đã review lại, gồm bốn việc:

1. Tạo lại `app_private.profit_ledger_luong_backfill_v1` đúng thân M3 `20261115083422` (md5 prosrc bỏ CR là `7ce5d543f3cb2937a2322fb44d664690`), kèm `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`. Production đã dọn hàm này ở `20261115213226`, mà D3a dừng ngay ở tiền kiểm nếu thiếu hàm.
2. Đo lại và sửa các dấu vân tay D3a đang ghim: đầu vào số dư, tập phiếu lương ghi bù và tập phiếu chờ duyệt, bốn phiếu X3. Việc này cần làm vì dữ liệu đã đổi sau thời gian ON.
3. Xử lý các phiếu chi theo sổ tổng còn sống từ thời gian ON. X1 của D3a dừng `D3A_X1` khi còn phiếu như vậy.
4. Chạy D3a với khoá mốc MỚI, **bắt đầu bằng `d3a-`**, rồi dọn hàm lại.

Chạy lại nguyên tệp D3a cũ (khoá cũ) sẽ dừng `D3A_MOC`. Đó là hành vi đúng.

## Kiểm chứng

`src/lib/__tests__/soTongLoiNhuanBanLuiMigration.test.ts` chạy trên PGlite, dùng cùng fixture với `soTongLoiNhuanChuyenDoiMigration.test.ts`, và dựng giao dịch bằng chính `buildTransaction` của lane. Bộ thử phủ các kịch bản sau:

- **Chuỗi lùi toàn phần:** mỗi bước dry-run hai lượt, lượt hai không ghi gì, rồi áp. Cuối chuỗi phải về đúng trạng thái trước D3a.
- **Mô phỏng CI:** sau MỖI bước, dán hai lượt mọi bước đã áp; D3a vẫn ngã đúng câu đã ghim.
- **Áp lại D3a** (tạo lại hàm, khoá mới, dọn hàm) rồi lùi lần hai.
- **DB rỗng:** từng tệp chạy nguyên văn.
- **Các ca dừng có chủ đích** ở bảng trên.

Bộ thử CHƯA phủ:

- Dữ liệu thật và engine duyệt thật.
- Kịch bản có hoạt động trong thời gian ON: phiếu chi có dòng C2, mốc của chủ đặt qua E9 có thứ tự sổ thật.
- Các trigger thật mà fixture không có:
  - `a10_accounting_feature_activation_guard` và `a11_finance_v2_activation` trên bảng công tắc. Đã đọc mã: chúng cho đóng và gỡ đóng băng.
  - F1/F1b/F2/F5 của sổ tổng.
  - `trg_ie_check_lock_upd`.
  - Hai khoá `a02` / `a00`: fixture chỉ có bản giả cùng tên.
  - Event trigger `org_boundary_tu_dong`. Theo mã, trigger này chỉ đụng bảng ở schema `public`.
- Dry-run trên TEST và Restore Drill thật (baseline + PG17).

Một chiều, không lùi được: dòng mốc C1, dòng C3/C4 đã VOID, nhật ký C5, `KQKD_OVERRIDE`, sự kiện công tắc. Các bảng này chỉ ghi thêm.
