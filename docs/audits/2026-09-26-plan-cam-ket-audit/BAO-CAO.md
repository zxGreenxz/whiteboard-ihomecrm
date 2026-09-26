# Audit độc lập — Cỗ máy chi theo cam kết

- **SHA-256 plan đã đọc:** `72ae574acc5ac99a8e1d907df171a4bb3c6e6b976f5e3cd15d4f297771c53252`.
- **Ref mã đã đọc sau `git fetch origin`:** `e1a0d2ac0312bba94148e974af2fb132303865a6` (`origin/main`; `origin/production` cùng SHA).
- **Mốc chạy lại số nền:** hai vòng khởi chạy **26/09/2026 12:25:54 và 12:25:57 UTC+07**. Timestamp máy của hai script: `2026-09-26T05:25:54.841Z`, `2026-09-26T05:25:57.546Z`.
- **Mốc đo bổ sung:** **12:27:17–12:32:10 UTC+07**, ghi chi tiết trong `started_at` / `finished_at` của từng JSON kèm theo. Ngày audit thực tế là **26/09**, vì vậy thư mục không dùng ngày dự kiến 27/09.
- **Đích đo:** production `tryymsxyyckgbrmmvozx`; số liệu nghiệp vụ chủ yếu lọc org THẬT `aaaa0000-0000-4000-8000-000000000001`. Các phép đếm toàn catalog/toàn bảng được ghi rõ.
- **Phạm vi thao tác:** đọc source bằng `git show origin/main:<path>` / `git grep origin/main`; mọi truy vấn production nằm trong **BEGIN READ ONLY … ROLLBACK**; không gọi writer, không Management API, không migration, không sửa plan, không commit/push. Chỉ ghi chứng cứ và báo cáo trong thư mục audit này.
- **Trạng thái checkout:** HEAD lúc audit đã trùng `origin/main`, không còn tụt 192 commit như lúc hướng dẫn được soạn. Vẫn tuân thủ đọc source theo ref. Không tạo worktree.

## Kết luận và mức phát hiện

**Chưa đủ điều kiện mở bất kỳ giai đoạn thi hành nào của bản plan này.** Ba điểm chặn là: nền danh mục bị đếm gộp hai tổ chức; “cam kết còn lại” chưa thành một giao thức bảo toàn tiền và chống đua dùng chung; G1 được coi là nhập dữ liệu vô hại dù nó đổi quyết định duyệt của mã đang chạy ngay lập tức.

Audit cũng **bác hai nghi vấn theo cách plan đang đặt**: policy danh mục không còn mở hoàn toàn; trần tuyệt đối điện nước đã được gọi. Đây không phải lý do bỏ kiểm soát quyền cột hay độ phủ trần, mà là lý do phải sửa đúng tiền đề.

| ID | Mức | Phát hiện |
|---|---|---|
| C1 | **CHẶN THI HÀNH** | “100 nhóm hạng mục trùng” là 100 nhóm khác org; G3 đang dựa vào chẩn đoán sai và thiếu ranh giới org |
| C2 | **CHẶN THI HÀNH** | Cam kết chưa có định nghĩa tiêu/giữ/hoàn, giao thức khoá chung, và không thay thế được idempotency; rollout từng writer để hở cửa cũ |
| C3 | **CHẶN THI HÀNH** | G1 tác động luật hiện hành trước khi chạy bóng; đường lùi “không cần” không đúng |
| P1 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G3/G4** | RLS hiện hành có RBAC/org boundary, nhưng chưa có cơ chế khoá cột luật và mapping |
| P2 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G2** | Quyền dùng sổ THU khác CHI; thiếu hình thức thanh toán và rollback tương thích G5 |
| P3 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G3** | Mapping, trigger hạng mục, parity và INV-4 chưa nhất quán |
| P4 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G4** | Chạy bóng đêm không có facts tại thời điểm sinh; “lệch 0” lẫn thay đổi chính sách |
| P5 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G4/G5** | Một facts/hạng mục không đủ cho phiếu nhiều dòng; B0 và INV-1–3 mâu thuẫn phạm vi |
| P6 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G5 CỬA ĐIỆN NƯỚC** | Độ phủ trần thiếu; “83/83 tự duyệt” sai cách diễn giải số đo |
| P7 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G5 CỬA 2–3** | B1/B2 đổi chính sách THU; chưa có quyết định và kiểm thử chuyển tiếp tương ứng |
| P8 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G6** | Đổi một hàm duyệt chưa đóng đường tự duyệt legacy; danh sách caller sai/thiếu |
| P9 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G7** | Chưa chuyển caller trước bỏ compat; REVOKE V4 đã xong |
| P10 | **PHẢI SỬA TRƯỚC GIAI ĐOẠN G1** | Superplan vẫn ra chỉ dẫn cũ; banner plan cũ không giải quyết hết entry point |
| Y1 | **GÓP Ý** | Một số câu “đã xong”, “chỉ một caller”, “lớn nhất” vượt quá chứng cứ |
| Y2 | **GÓP Ý** | Mô tả lane/token và disable trigger chưa khớp Contract/phạm vi bảng |
| Y3 | **GÓP Ý** | Phân biệt trần mỗi phiếu với tổng toà/kỳ, tỷ lệ, làm tròn và nguồn chứng cứ lịch sử |

Mức **CHẶN THI HÀNH** áp dụng cho bản kế hoạch được ghim ở đầu báo cáo, không cấm tiếp tục khảo sát và sửa tài liệu. Các phát hiện P có gate riêng; không suy chúng đều là lỗ hổng đang bị khai thác trên production.

## 1. Ba câu ưu tiên

### 1.1. Trần điện nước: đã nối; số phiếu đang chờ không đo được số phiếu từng bị chặn

**Căn cứ mã và catalog:** `20260828150000_utility_ceiling_wired_into_pay_bill.sql:218–222` gọi thật `utility_ceiling_check_v1(v_org,p_building_id,p_utility_type,v_p_start,p_amount)`. `OVER_CEILING` hoặc `OVER_RATIO` hạ trạng thái về `UNAPPROVED`, kể cả người có quyền duyệt. Hàm helper chọn `PUBLISHED`, đúng org/loại/toà, tháng hiệu lực không muộn hơn **tháng kỳ**. Không có trần thì trả `NO_RULE`, giữ quyết định cũ. Bản trong baseline cũ không đủ; phải đọc migration mới hơn. Định nghĩa sống nằm ở `catalog-song.json → utility-functions`; md5 cả caller/helper khớp gói.

Đã gọi **chỉ helper STABLE đọc dữ liệu trên một cấu hình mẫu**, không gọi `pay_utility_bill`: bằng trần ⇒ `WITHIN_LIMIT`; vượt 1 đồng ⇒ `OVER_CEILING`; trước tháng hiệu lực ⇒ `NO_RULE`. Chứng cứ: `doi-chieu-song.json → utility-safe-boundary-probes`.

| Phạm vi | Kết quả tự đo |
|---|---|
| Cấu hình PUBLISHED của org THẬT | **24 dòng, 16 toà**; 16 ELECTRIC + 8 WATER; tất cả hiệu lực từ 01/08/2026 |
| Loại trần | 24 trần số tiền; 0 tỷ lệ; 0 cấu hình global; không dòng retired |
| Cùng mẫu A-10: 90 ngày, deleted_at NULL, kể cả CANCELLED | **83 phiếu / 556.009.060đ**, 16 toà, 27 cặp toà–loại |
| Trạng thái của 83 phiếu | **78 APPROVED / 555.975.429đ; 5 CANCELLED / 33.631đ; 0 UNAPPROVED** |
| Độ phủ cấu hình trên mẫu 83 | **15/16 toà**, **23/27 cặp toà–loại** có cấu hình, chưa xét tháng phiếu |
| Chỉ phiếu còn sống, loại CANCELLED | **78 phiếu, 15 toà, 26 cặp toà–loại** |
| Độ phủ trên phiếu còn sống | **14/15 toà**, **22/26 cặp toà–loại** |
| Dùng tháng kỳ của từng phiếu trong mẫu 83 | 35 có trần áp dụng; **48 NO_RULE** |
| Replay bằng cấu hình hiện nay | **32 WITHIN_LIMIT, 3 OVER_CEILING, 48 NO_RULE** |

Các cặp còn thiếu cấu hình hiện hành trong tập phiếu sống: **111PVC–WATER, 158PVC–WATER, 15KV–WATER, Kho Văn Phòng Chung–ELECTRIC**. Không lấy “16 toà đã khai” chia thẳng cho tổng toà phát sinh: hai tập không trùng nhau, và có trần điện không có nghĩa đã có trần nước.

**Bằng chứng hoạt động thực tế:** 3 phiếu APPROVED có ghi chú `[VƯỢT TRẦN …]`, tổng **7.891.317đ**; cả ba được duyệt sau lúc tạo, trễ từ **00:29:21.491553** đến **1 ngày 18:07:23.553025**. Mã writer chỉ nối dấu này ở nhánh vượt trần. Đây là bằng chứng nhất quán với việc từng chuyển CHỜ rồi được duyệt sau; nó phản bác suy luận “0 đang chờ ⇒ không kích”. Không có trace đầy đủ từng transaction nên không dùng timestamp/notes để khẳng định lịch sử bất biến của mọi phiếu.

**Sai số hồi cứu:** 16 phiếu kỳ tháng 8 hiện ra WITHIN_LIMIT nhưng cấu hình được tạo **sau phiếu**. Vì thế replay bằng bảng hiện tại không chứng minh chúng từng được kiểm trần lúc sinh. 46/48 NO_RULE là kỳ tháng 6–7, trước hiệu lực; 2 còn lại là kỳ tháng 9. Không được dự báo “bật B5 sẽ đẩy cả 83 phiếu/quý vào chờ” từ tổng lịch sử này.

**P6:** trước bật G5 điện nước, chốt tập toà–loại–kỳ cần phủ, xử lý các cặp thiếu và ghi rõ `NO_RULE → CHỜ` là đổi chính sách. Thêm ca thực thi trên TEST/DEMO: dưới/bằng/vượt trần, thiếu trần, nhiều công tơ, người có quyền duyệt. Audit này chưa ghi fixture để chạy writer.

**Y3:** caller chỉ truyền 5 đối số, bỏ `p_billed_to_tenants`; nhánh tỷ lệ không thể ra `OVER_RATIO` qua cửa này, chỉ có thể `WARN_NO_BILLED`, mà writer không hạ trạng thái vì cảnh báo đó. Hiện 24 dòng đều không đặt tỷ lệ nên chưa chứng minh tác động tiền thực. Trần hiện so từng `p_amount`, làm tròn tới đồng, không cộng các công tơ/phiếu trong kỳ. Plan phải gọi đúng là trần mỗi phiếu hoặc thiết kế tổng theo toà/kỳ nếu đó mới là ý chủ.

### 1.2. RLS hạng mục: tiền đề “mở hoàn toàn” sai; quyền cột mới vẫn thiếu thiết kế

**Đã kiểm cả source lẫn catalog sống.**

- Policy `income_expense_types_authenticated_all` từ 11/05 đã bị **DROP** ở `20260528000003_rbac_batch_f_drop_legacy.sql:205`.
- `20260528000001_rbac_batch_a_config_tables.sql:88–96` thay bằng RBAC `categories.view/create/edit/delete`.
- `20260807163000_ie_types_org_boundary.sql:80–83` thêm policy **RESTRICTIVE FOR ALL TO authenticated**, kiểm org ở cả USING/WITH CHECK.
- Catalog sống có **11 policy**, RLS bật, không còn policy mở mà plan dẫn. Có các policy bổ sung cho restricted/demo/sandbox và role nội bộ. Quyền SQL cấp bảng của `authenticated` có INSERT/UPDATE/DELETE, nhưng vẫn phải qua RLS và trigger.
- `can_access_org_entity` hiện kiểm super admin hoặc capability tương ứng; không phải mọi authenticated đều qua. Boundary còn ngoại lệ super admin; không khẳng định cơ chế này là bảo đảm cách ly tuyệt đối cho mọi role.

Do vậy **không xác nhận lỗ “mọi user sửa hạng mục mọi user” như §11.2**. Nguy cơ chính xác là: người qua quyền sửa danh mục và các điều kiện dòng hiện tại có thể sửa **cột luật mới** nếu migration chỉ thêm cột, không thêm ranh giới quyền.

**P1 — phải sửa trước khi thêm/backfill mapping hoặc đưa luật vào dùng ở G3/G4.** Cơ chế khả thi:

1. Giữ RLS/org boundary, thu quyền **INSERT/UPDATE cấp bảng** khỏi các role client và các đường kế thừa/PUBLIC; cấp lại chỉ các cột nghiệp vụ thường. Chỉ `REVOKE UPDATE(spend_mode)` khi còn table UPDATE **không có tác dụng chặn**. PostgreSQL cộng quyền cấp bảng và cột ([GRANT](https://www.postgresql.org/docs/current/sql-grant.html)).
2. Cột luật và tham số, cờ ảnh hưởng luật như `force_approval/is_deposit`, `canonical_type_id`, `fee_category`, `organization_id` phải có đường sửa được bảo vệ. RPC chuyên biệt kiểm danh tính/chủ của **đúng org**, kiểm old/new, ghi lịch sử và version/CAS. SECURITY DEFINER phải tự kiểm quyền; không tin claims do client gửi.
3. Đóng cả INSERT/upsert và việc xoá/tạo lại để đổi luật. Mặc định trên bản ghi mới phải là chính sách đã được duyệt; không để người có `categories.create` tự tạo hạng mục “dễ tự duyệt” ngoài chủ ý. Không cho sửa pointer để mượn luật dễ hơn.
4. Có thể dùng trigger bảo vệ old/new thay ACL cột nếu cần tương thích client, nhưng phải là enforcement server có kiểm quyền thực, bao gồm INSERT/DELETE/mapping; UI ẩn ô không đủ.
5. Nghiệm thu trên TEST bằng JWT/REST: chủ đúng org, quản lý chỉ sửa tên, user thiếu capability, cross-org, đổi pointer/flags, INSERT/upsert, helper definer và bulk import. Audit chỉ xác minh catalog; **chưa thử các thao tác ghi này**.

Đây là gate chặn **phần triển khai luật**, không phải bằng chứng một lỗ RLS mở toàn cục đang tồn tại.

### 1.3. Khoá chống đua: thiếu thật trong thiết kế; khoá không thay idempotency

**C2 — CHẶN THI HÀNH.** Hai transaction cùng đọc còn 26 triệu, mỗi bên ghi 26 triệu, không khoá chung ⇒ tổng 52 triệu vẫn có thể được quyết định “trong cam kết”. Đây là phản ví dụ của thiết kế, **không phải ca race production đã tái hiện**.

Khoá hiện có không giải quyết xuyên các cửa:

| Cửa | Khoá/kiểm hiện tại |
|---|---|
| `pay_period_fee` | advisory key `fixed_fee:org:building:category:start-month` (`20260831162000…:269–274`) |
| `pay_utility_bill` | key riêng theo org/công tơ/loại/kỳ (`20260828150000…:115`) |
| `generate_special_fees_v1` | key `special_fee:org:period` (baseline `schema.sql:62805`) |
| `create_income_expense_v1` | idempotency operation/actor/key và khoá tài nguyên, chưa có bucket cam kết dùng chung |
| Sinh phiếu lặp | kiểm parent/ngày; chọn trạng thái theo `repeat_auto_approve` (baseline `62585,62608–62612`; xác nhận thân sống) |
| Duyệt/sửa/huỷ | khoá phiếu hoặc org/phiếu, chưa có giao thức cam kết chung |

**Khoá đề xuất:** trong phần orchestration/facts server của **cùng transaction** tạo hoặc chuyển trạng thái, lấy `pg_advisory_xact_lock` với key chuẩn hoá gồm **org + toà + hạng mục chuẩn + từng kỳ** trước đọc số đã tiêu; hoặc khoá row của bucket cam kết ổn định. Phải có cách khoá ngay cả khi chưa có row cam kết; `SELECT FOR UPDATE` trên tập rỗng không khoá một “khe chưa tồn tại”. Dùng khoá transaction để tự nhả khi kết thúc ([PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)).

Sau khi đợi khoá phải đọc lại facts thích hợp; khoá → đọc → quyết định → giữ/tiêu → ghi phiếu/posting phải nguyên tử. `ie_spend_decide_v1` vẫn thuần; hàm lấy khoá không được khai STABLE/IMMUTABLE, phù hợp Contract §5. Nhiều item/nhiều tháng lấy đủ bucket theo thứ tự cố định; sửa đổi bucket khoá cả cũ/mới cùng thứ tự. Không có một key tuỳ từng writer.

Plan còn phải định nghĩa **“đã tiêu”**: APPROVED hay POSTED, phiếu chờ có giữ chỗ không, non-cash/huỷ/đảo/restore tính thế nào, thay phiên bản hoặc giảm cam kết xử lý khoản đã tiêu ra sao. Quy tắc quyền huỷ có thể giữ nguyên Đ5, nhưng cơ chế hoàn/giải phóng cam kết vẫn cần tham gia khi huỷ. Chưa thể nói bảng giá phiên bản hiện tại là một sổ cam kết hoàn chỉnh: nó không lưu khoản tiêu, giữ chỗ, hạn kết thúc hay liên kết obligation.

**Bỏ khoá khe không đồng nghĩa bỏ chống lặp nghiệp vụ.** Cam kết 100 triệu, hai request trùng 30 triệu vẫn đều dưới tổng 100 triệu, ngay cả khi tuần tự và khoá hoàn hảo. Phải giữ idempotency/key nghiệp vụ ổn định, phân biệt trả nhiều đợt hợp lệ với cùng một yêu cầu gửi lại. “Vượt thì CHỜ” cũng chưa ngăn một đường duyệt khác duyệt phần vượt. Không mặc định cấm chủ duyệt vượt: phải chốt quyền/ngoại lệ và ghi nhận khoản đã tiêu để lần tự duyệt sau đọc đúng. Không được giữ nguyên câu “chống chi trùng miễn phí”.

**Rollout G5 đang để hở:** cửa mới tiêu đủ cam kết rồi cron cũ vẫn APPROVED theo `repeat_auto_approve`. Còn `generate_special_fees_v1` là writer tự duyệt riêng nhưng **không nằm trong 5 cửa G5**; G2 chỉ được sửa đoạn chọn sổ của nó. Trước bật một tập org–hạng mục–kỳ, tất cả writer có thể tiêu tập đó phải cùng giao thức; chưa cần bật chính sách mới toàn hệ thống, nhưng không thể để đường cũ đứng ngoài kiểm tổng.

Gate bắt buộc trước bật: tạo–tạo, tạo–duyệt, tạo–sửa, huỷ/restore, đa tháng/đa item, hai key nghiệp vụ khác nhau/cùng nhau, lỗi giữa decision và posting, cập nhật luật và rollback trong lúc có phiếu chờ. Chỉ property test hàm thuần không chứng minh các bất biến này.

## 2. Chạy lại Phụ lục A/B: số không đổi, cách diễn giải mới là chỗ lệch

Hai script gói được chạy **nguyên văn**, đúng NODE_PATH, output ghi vào thư mục audit mới. Hash script khớp gói. `doi-chieu-nen.json` so từng key, không chỉ các số được chọn để báo.

| Mã | 26/09 12:09 | Audit 26/09 12:25 | Nhận xét |
|---|---:|---:|---|
| A-1 giá phí cố định | 0 | 0 | Khớp |
| A-2 trần điện nước | 24 | 24 | Khớp; độ phủ ở §1.1 |
| A-3 self_approve_limits | 0 | 0 | Khớp |
| A-4 toàn bảng: dòng/cờ/chủ/nhóm trùng | 211 / 56 / 6 / 100 | 211 / 56 / 6 / 100 | Khớp số, sai suy luận gộp danh mục |
| A-5 chờ: số/tiền/>30 ngày | 144 / 781.731.917 / 51 | 144 / 781.731.917 / 51 | Khớp |
| A-6 sổ âm | 4 / −828.138.725 | 4 / −828.138.725 | Khớp qua vòng 2 |
| A-7 hàm chứa force_approval | 9 | 9, cùng danh sách | Phép tìm chuỗi, không đồng nghĩa 9 hàm đọc để quyết định |
| A-8 khe tiền nhà nhiều phiếu | 8 | 8 | Đo bổ sung count DISTINCT voucher xác nhận cả 8 thực sự nhiều phiếu |
| A-9 diff migration ba hàm | Không chạm | Không có dòng +/- nhắc ba symbol | Cùng phạm vi c22adb2c..origin/main; không coi đây là chứng minh mọi dependency bất biến |
| A-10 nguồn 90 ngày | Các nhóm ở JSON gốc | Từng nhóm top 15 khớp | utility 83, fixed_fee không có dòng ⇒ 0 trong cửa sổ |
| A-11 định kỳ | 223 / 1.300.661.000 / 210 APPROVED | Cùng số | Xem phân trạng thái dưới đây |
| B md5 16 hàm | 16 fingerprints | **16/16 khớp**, cả độ dài | Không thấy drift của 16 hàm |

Chỉ trường thời gian kết nối đổi từ 12:09 sang 12:25. **Không có lệch số có hướng theo thời gian trong khoảng đo này.** Có **sai lệch diễn giải có hướng**: đếm cross-org làm phóng đại nhu cầu hợp nhất; đếm trạng thái hiện tại như birth status làm phóng đại “tự duyệt”; cộng CANCELLED và UNAPPROVED vào tổng định kỳ rồi dùng như tổng chi tự động.

Các lỗi gốc được giữ nguyên: vòng 1 `so-quy-am` thiếu cột organization_id ở view; `co-tuyen-finance` dùng nhầm flag_key. Vòng 2 sửa được sổ âm, chỉ dò schema cờ; audit đo bổ sung cờ bằng `feature_key`. Không đánh dấu script “mọi câu xanh” vì process exit 0.

Chi tiết A-11: 210 APPROVED **810.761.000đ**, 7 CANCELLED **194.900.000đ**, 6 UNAPPROVED **295.000.000đ**. Trong 210 APPROVED có 198 phiếu approved_at gần created_at ≤5 giây; đây vẫn chỉ là proxy, chưa phải lịch sử birth đầy đủ. Do đó “1,30 tỷ nguồn tự duyệt” không đúng; “lớn nhất” cũng chưa có mẫu so tiền đồng nhất của mọi nguồn.

Ba bất biến ghi sổ kế thừa được chạy lại theo SQL cũ: **B-GHI-SO=0, B-DUYET-TRUOC=0, B-DUYET-CO-SO=0**. Đây là ba phép đếm, **không thay thế** hai gate reconcile theo JWT/RLS và posting; audit chưa chạy các gate đó.

## 3. Phản biện theo từng mục plan

### §0 — Chứng cứ và phương pháp

Bốn loại chứng cứ là cách phân loại hữu ích. Nhưng hash/md5 khớp chỉ chứng minh đúng tài liệu và thân hàm; không chứng minh đúng cách hiểu số, đúng các dependency, ACL hay policy. A-4 và câu “83/83 tự duyệt” là hai phản ví dụ thực tế.

Ngưỡng 600.000đ của org THẬT được đo bổ sung, có thật; org DEMO đang là 5.000.000đ, nên DEMO ≥3 ngày không tự đảm bảo parity chính sách THẬT. Chủ ý nghiệp vụ/những lời “chủ đã chốt” được coi là đầu vào của tài liệu; không có biên bản trao đổi gốc để audit xác nhận độc lập.

### §1–2 — Đích và ba kiểu chi

Ba kiểu là lựa chọn nghiệp vụ khả thi, không được số đo chứng minh là lựa chọn duy nhất. C2 bác “chống trùng miễn phí”. Bảng giá là **giá công bố theo tháng**, chưa có đủ ngữ nghĩa cam kết hữu hạn/còn phải trả. Cần định nghĩa kỳ tính, ngày hết hiệu lực/hết nghĩa vụ, trả thiếu/thừa, trả trước, phân bổ nhiều kỳ và snapshot phiên bản.

Lý do loại “bảng chính sách riêng vì UPDATE được bằng SQL” không phân biệt được hai phương án: cột luật trên danh mục cũng UPDATE được bằng SQL; bảng private hiện đã có revoke và setter. Ranh giới an toàn đến từ quyền/enforcement/audit, không đến từ tên hay vị trí bảng. Không buộc chủ chọn lại giao diện, nhưng phải sửa lập luận kỹ thuật này.

§4.1 nói default TUNG_PHIEU “giữ nguyên hành vi” chỉ đúng có điều kiện: B1/B2 và bỏ OWNER đã đổi hành vi trước khi tới TUNG_PHIEU. Không gọi toàn bộ chuyển đổi là tái cấu trúc bảo toàn chính sách.

### §3 — Hiện trạng

**C1:** phép A-4 không lọc/group organization_id. Catalog sống: **THẬT 108 dòng/28 force/5 user_id; DEMO 103 dòng/28 force/1 user_id; 0 nhóm trùng trong từng org**. Cả **100 nhóm/200 dòng** trùng tên của toàn bảng nằm qua nhiều org. `20260728180000_income_expense_type_canonicalization.sql:720–740` đã hợp nhất theo org và tạo UNIQUE `(organization_id,lower(btrim(type)),normalize_income_expense_type_name(name))`, còn tồn tại trên production.

Không được chọn một dòng chuẩn chung cho mỗi cặp THẬT/DEMO. Nếu áp §5 theo đúng nhóm hiện đo, có nguy cơ trỏ canonical sang tổ chức khác. **Phải sửa nền G3 và bỏ nghiệm thu “0 tên trùng toàn DB” trước mở plan.** Đổi thành ánh xạ chín fee keys vào danh mục đã canonical theo từng org; chỉ thêm alias khi có nhu cầu thực đã đo.

Các claim khác:

| Claim | Kết quả audit |
|---|---|
| Thang luật riêng của create và pay_period_fee | Đúng; CONFIG_REQUIRED vẫn dẫn tự duyệt ở pay_period_fee |
| 9 hàm có force_approval | Đúng số/string scan; ensure/seed là ghi/default, không nên gọi tất cả là “đọc luật” |
| Các cửa chi chưa dùng danh sách sổ nhận mới | Đúng về ba cửa G2; **không đếm lại** toàn bộ “≈10 server + ≈8 UI” của plan cũ |
| receiving_cashbook_ids chỉ có một caller ở V5 | Sai nếu hiểu call graph: có allowed/assert/read RPC và change_collection_tender_method_v1; ý giới hạn đường THU vẫn đúng |
| update_cashbook_metadata ghi initial_amount | Đúng theo thân hàm; md5 không đổi; plan chưa có phase xử lý rõ phần này |
| cancel phí không kiểm income_expenses.cancel/lý do | Đúng trong hai body, nhưng còn actor/building/admin và trigger khoá tháng; “không có luật” là quá rộng |
| Mã phiếu duy nhất đã xong | Chỉ đúng bảo vệ mới: partial unique index từ mốc migration, không tuyên bố lịch sử sạch |
| Gỡ đường hoàn thứ hai | Đã thu quyền entry point/Copilot, không DROP mọi hàm liên quan; còn hàm được cố ý giữ |
| Khoá tháng/revise/đóng đường sửa cũ | Có migration tương ứng; không suy rằng mọi caller cũ đã được dọn |

A-8 mới dùng tháng item.start_date; phép B-TRUNG-KHE của gói cũ dùng voucher_date và cửa sổ khác. Không coi 10→8 là bằng chứng đã giảm trùng chỉ do hoạt động người dùng khi chưa chuẩn hoá mẫu.

### §4 — Bộ máy, bất biến và lý do

**P5:** facts hiện có một `hạng_mục_id/spend_mode`, trong khi `create_income_expense_v1` thực tế nhận `p_items`, lặp `jsonb_array_elements`, dùng `bool_or(force_approval)`. Phiếu hỗn hợp CAM_KET + TRAN + TUNG_PHIEU hoặc trải nhiều kỳ chưa có luật tổng hợp. Cần facts theo dòng/phần phân bổ, kiểm tất cả bucket, quy tắc trạng thái toàn phiếu (vd chỉ tự duyệt khi mọi dòng đạt, trừ B0 được xác thực), lý do từng dòng + tổng. Không đưa tổng tiền phiếu vào một cam kết tuỳ ý.

**B0 và INV-1–3:** §4.6 loại writer V5/hợp đồng/thanh lý/lương/bàn giao/chốt sổ khỏi bộ máy, trong khi INV-1/2 đòi *mọi phiếu*, INV-3/G7 đòi không hàm nào ngoài máy đặt status, §4.5 đòi máy tự ghi reason. Hàm decide thuần không ghi DB; writer/adapter vẫn phải vật lý ghi status. Cần invariant chính xác: trạng thái phải có quyết định server hợp lệ, writer mỏng không tự quyết; hoặc thu hẹp tập writer cùng allowlist ngoại lệ có gate riêng. Không thể nghiệm thu văn bản hiện nay.

Danh sách B0 phải có ma trận nguồn→writer→chiều→cash/non-cash→điều kiện, không chỉ chuỗi system_source từ client. Các nguồn hệ thống có cả phiếu chờ (commission/refund); không tự động nâng mọi nguồn thuộc “hợp đồng/lương” lên APPROVED. Chưa có phase được phép thêm reason cho mọi writer bị loại khỏi phạm vi. Chủ phải chốt phạm vi trước G4.

INV-4 định nghĩa “không trùng tên”, trong khi G3 giữ nguyên dòng cũ và đổi thành “không nhóm chưa có canonical”. Hai phép đo khác nhau; cùng sai nếu không giới hạn org. INV-5 khớp các count đã chạy; INV-6 chưa có baseline gate reconcile trong audit này.

**Lý do quyết định:** ngoài text/code, cần rule version, commitment/ceiling version, facts snapshot, writer và thời điểm/birth status để chứng minh quyết định khi luật đổi. Text bắt buộc là tốt nhưng không đủ provenance. Phiếu nhập đầu tiên, sửa, duyệt, replay và rollback phải phân biệt quyết định lúc nào.

### §5 / G3 — Mapping thay cho gộp nhầm

P3 phụ thuộc sửa C1. Nếu vẫn cần canonical pointer, self-FK đơn chưa đủ: dùng ràng buộc cùng org (FK composite), cùng chiều/ngữ nghĩa, alias trỏ thẳng root, không vòng/chuỗi tuỳ ý; `fee_category` unique trên root theo org và chỉ nhận key hợp lệ. Root bị ẩn bởi RLS hoặc pointer sai phải thất bại an toàn, không fallback luật nhẹ.

Chín key server có căn cứ ở CHECK bảng giá/GRID_SERVER_KEYS, nhưng registry frontend còn khái niệm khác. Khi thay contract SQL `fee_type_matches`, cập nhật hoặc gỡ mirror TypeScript `feeTypeMatches` và test parity tương ứng; chưa thấy matcher TypeScript có caller production tại SHA audit. Nghiệm thu parity tuyệt đối 90 ngày mâu thuẫn với việc đang muốn sửa matcher gộp sai: giữ parity tập không ảnh hưởng, còn ca sửa đúng phải có oracle và danh sách lệch được duyệt. Các con số gộp nhầm 16/10/3 được kế thừa từ 23/09, **chưa chạy lại** ở audit này.

Guard thực của bảng hạng mục: `a01_reservation_type_guard` so toàn JSON old/new trừ một số cột tên/mô tả. Đổi cột mới trên type đã dùng xử lý bỏ cọc có thể bị chặn 55000 (`20260909172332_reservation_deposit_settlement_v1.sql:625–638`; catalog sống có trigger). Không mặc định disable guard thanh lý; đó là vùng plan nói không đụng. Backfill canonical nằm trên **income_expense_types**, không tự nhiên phải disable trigger khoá tháng trên **income_expenses** như §7.3 gợi ý.

### §6 / G1 — Nhập cam kết đã là một lần đổi hành vi

**C3:** `pay_period_fee` đọc bảng giá trực tiếp; `generate_special_fees_v1` cũng đọc khi route là CANONICAL và có sổ truyền vào. Chưa đo cờ `special_fee.generate.v1` trong lượt này; riêng đường `pay_period_fee` đã đủ chứng minh tác động G1. Rule cũ so **bằng tổng giá tháng**, không phải ≤ phần còn lại: chưa khai ⇒ CONFIG_REQUIRED ⇒ tự duyệt; khai 26 triệu rồi trả đợt 13 triệu ⇒ AMOUNT_MISMATCH ⇒ CHỜ. G4 chạy bóng sau đó không bảo vệ việc đã xảy ra ở G1.

Setter hiện có là thật, quyền server chủ tổ chức hoặc super admin; route `thu_tien.collect` không phải toàn bộ kiểm quyền. Nó nhận tháng quá khứ, retire phiên bản cùng tháng rồi insert PUBLISHED; không có tháng hết nghĩa vụ. Có cột retired_at không đồng nghĩa có thao tác thu hồi hoàn chỉnh. Retire mới có thể làm giá cũ được chọn lại hoặc trở về CONFIG_REQUIRED. Nó không tự hoàn tác quyết định đã sinh.

G1 phải có staging chưa được writer đọc, hoặc được mô tả là đợt bật chính sách thật có preview/kiểm trước/phạm vi/đường lùi đã diễn tập. “Không cần kỹ thuật”, “không cần lùi”, “chỉ nhập dữ liệu” đều phải bỏ hoặc giới hạn rõ.

### §6 / G2 — Dùng danh sách sổ phải giữ quyền CHI

**P2:** `receiving_cashbook_ids_v1` lọc bằng possession của THU; helper nhận CUSTODIAN/KNOWER (baseline `15060–15068`). Luật sửa phiếu vừa ship cho CHI là chủ sổ/CUSTODIAN/OPERATOR, chỉ THU mới nhận KNOWER (`20260925080906…:790–813`). Thay validator bằng helper THU nguyên xi có thể nâng KNOWER thành người chi và loại OPERATOR. Đây là rủi ro thiết kế được chứng minh từ hai predicate, chưa phải implementation G2 đã có.

Cần giao tập sổ cấu hình với quyền **CHI**; không để membership NULL bỏ kiểm possession; các RPC pay_* chưa nhận TM/TK/TT nên phải định nghĩa cách xác định hình thức. Test trực tiếp RPC với quyền đúng/sai, không chỉ UI.

G2 và G5 sửa cùng hàm. Rollback G2 bằng khôi phục nguyên thân theo md5 ngày 26/09 sau khi G5 đã bật sẽ gỡ luôn phần máy chi. Cần rollback theo phiên bản/phụ thuộc hoặc tách thay đổi; cờ SHADOW cũng phải giữ giao thức tính cam kết, không mở lại đường chi cũ vô điều kiện.

### §6 / G4 — Bóng đêm là hậu kiểm, chưa là shadow tại lúc quyết định

**P4:** số dư cam kết, phiên bản luật, amount/period/mapping và trạng thái phiếu đều có thể đổi trước lúc job chấm. Ví dụ phiếu 26 triệu đúng lúc còn 26 triệu; đến đêm chính nó đã tiêu hết, chấm lại còn 0 ⇒ vượt giả. Binding không phải nguồn sai số duy nhất.

Lưu facts/rule version **trước quyết định** tại server, hoặc replay theo lịch sử đầy đủ có thứ tự; không thể vừa khẳng định “chưa writer nào gọi” vừa có shadow chính xác về nguồn tiền tại thời điểm sinh mà không chỉ ra nguồn lịch sử. Phân loại riêng “khác do chính sách chủ muốn” và “sai so oracle”. Đòi lệch 0 so luật cũ trước bật luật mới sẽ không đạt khi chủ thực sự đổi OWNER/NO_CEILING/B1/B2.

Bóng không có ca là bằng chứng rỗng: pay_period_fee đang 0/90 ngày, 14 ngày 0 lệch không xác nhận được gì. Cần fixture TEST có số ca tối thiểu và đầy đủ biên. R3 đòi định kỳ 30 ngày nhưng G5 nói 14; ghi rõ ngoại lệ bắt buộc, phủ ít nhất các lần chạy kỳ có ý nghĩa.

### §6 / G5 — Thứ tự theo tiền và tập writer, không chỉ lưu lượng

Có thể rollout ít người trước, nhưng “0 lưu lượng ⇒ sai không ảnh hưởng ai” không phải gate an toàn cho lần dùng đầu tiên. C2 yêu cầu bảo vệ mọi writer cùng tiêu cam kết trước kích hoạt bucket. Bổ sung `generate_special_fees_v1` và các transition làm đổi tiêu thụ; tên “bộ sinh định kỳ” không được nhập nhằng với nó.

**P7 — B1:** create/compat có đường cho THU thông thường sinh APPROVED ngay; riêng compat loại trừ Copilot draft và phiếu định kỳ vốn đã UNAPPROVED. Account là nullable và một số nhánh chỉ validate nếu có account. B1 có thể đưa lớp THU đang tự duyệt nhưng không sổ/sổ không thật về CHỜ; đây là đổi trạng thái có thật ở thiết kế. Đo 90 ngày: THU không nhãn còn APPROVED 293 phiếu, **0 thiếu account nhưng 1 dùng sổ ảo**; các nguồn hệ thống còn nhiều non-cash/sổ ảo. Chưa xác định writer của phiếu không nhãn chỉ từ nhãn nguồn. Không suy V5 bị phá: nó bị loại khỏi máy theo §4.6 và hiện có 636 THU APPROVED không thiếu/ảo sổ trong mẫu.

**B2** cũng đổi THU cọc: source create hiện nói rõ THU tự duyệt kể cả cọc; plan lại cho is_deposit mọi chiều vào CHỜ trước B3. Phải có quyết định riêng, test thêm sổ→duyệt, THU KNOWER, THU cọc, batch/import, nghiệp vụ non-cash; không chỉ xin ý kiến OWNER. Không đề nghị nới bất biến sổ, chỉ yêu cầu chốt thay đổi.

FROZEN “mọi phiếu CHỜ” chỉ an toàn trong phạm vi birth của writer đã nối; không ngăn các đường duyệt cũ/ngoại lệ. SHADOW sau khi có reservation cũng phải có cách giữ/giải phóng chính xác. Thử rollback với dữ liệu đã sinh, không chỉ đổi cờ.

### §6 / G6–G7 — Duyệt và dọn đường cũ

**P8:** `approve_income_expense_v1` đúng là cho người lập tự duyệt. Nhưng `approve_voucher` cũng có nhánh này (baseline `schema.sql:46368`). Wrapper `approve_pending_income_expense_checked_v1` mới rẽ sang **cả hai**, kèm CAS/version (`20260925080906_sua_phieu_cho_duyet.sql:1109,1124,1142`); FE revisions gọi wrapper. `pay_draft_fee_voucher` thực ra gọi `approve_voucher`, không phải v1. Danh sách ba caller trong plan thiếu wrapper vừa ship 25/09. Catalog/source đã xác nhận các body, không chỉ đếm grep.

Cần ma trận caller/callee/fallback và test người lập không có quyền duyệt, người lập có quyền duyệt nếu chủ chọn bỏ self-approval, CAS, engine request, cặp phiếu bỏ cọc. Đổi một body không bảo đảm “một đường duyệt”; không mở rộng sửa thanh lý chỉ vì một wrapper có nhánh chuyên trách.

**P9:** G5 nối compat không tự chuyển caller. `batch.ts:107,206`, fallback `mutations.ts:136` và Copilot còn gọi nó. G7 phải có adapter/đích thay thế và thứ tự triển khai client cũ trước REVOKE/DROP. `record_invoice_payment_v4` đã bị REVOKE ở `20260925083655…:1193–1198`; catalog sống ACL chỉ `postgres=X`, authenticated/anon/service_role đều false. Không coi đây là việc chờ lương trong tương lai.

### §7–8 — Gate, rollback, rủi ro

Các gate tiền/RLS/ACL/migration được nêu phù hợp hướng Contract; property tests/E2E chưa đủ C2 và P1. Gate quét thân hàm không chứng minh hết dynamic SQL/helper/JSON record: compat đặt status vào JSON rồi INSERT qua `jsonb_populate_record`. Cần inventory writer ở DB + ACL/guard runtime + test đột biến âm tính, dùng quét tĩnh làm một lớp. Không quét comment rồi coi có gọi luật.

§7.3 “phải DISABLE TRIGGER” không nên là hướng dẫn chung: ưu tiên không đụng lịch sử ngoài phạm vi, liệt kê đúng trigger từng bảng, chỉ đánh giá bypass có review nếu thực sự cần. Cột mới trên type không tự đụng khoá tháng phiếu, còn trigger hạng mục có thể chặn như P3.

**Y2:** §7.4/R8 khẳng định lane luôn đòi token người và agent không thể apply không được chứng minh bằng bằng chứng trong gói. Contract §4 chỉ nói đường bỏ backup cần promotion token; workflow lane mặc định có backup. Audit không chạy lane để kiểm harness thực tế, nên không kết luận “chắc chắn agent bị chặn”. Dù ai apply, task audit này tuyệt đối không được apply.

R1–R10 chưa bao phủ: cross-org canonical, phiếu đa hạng mục, G1 thay đổi live, rollback mất phần G5, luật được sửa sau quyết định, caller duyệt mới và mixed rollout. Những rủi ro này có dẫn chứng ở trên, không chỉ là checklist giả định.

### §9 — Plan cũ và superplan

**P10:** banner đầu plan cũ đủ rõ với người đọc toàn file: ghi thẳng “Đừng thi hành §5”. Không cần xoá chứng cứ lịch sử. Nhưng **superplan vẫn là entry point đang chỉ đạo bản cũ**: N6 ở dòng 26 gọi G1b, gồm sửa huỷ trái Đ5 mới; bảng đợt 136–144 còn G0/G1a/G1b/khoá khe/T9; `superplan-2026-09/T-tai-chinh.md` cũng trỏ các bước cũ.

Trước G1, sửa các entry point về bản kế hoạch được duyệt, đánh dấu ngay tiêu đề §5 cũ là lưu trữ/không thi hành, liệt kê rõ mục nào chỉ kế thừa **kỷ luật**. Không kế thừa những chẩn đoán đã sai hoặc chưa có phase xử lý, chẳng hạn initial_amount. Giữ bản audit/archive cũ nguyên vẹn. Audit này **không sửa những file đó**.

### §10 — Những quyết định còn thiếu

Giữ sáu câu hỏi chủ đang chờ. Bổ sung: ngữ nghĩa cam kết nhiều kỳ/trả từng phần/hết hạn; giữ chỗ cho pending; duyệt phần vượt cam kết; sửa luật hồi tố/giảm hạn mức; B1/B2 đối với THU/non-cash; luật cho phiếu nhiều hạng mục; default hạng mục mới; trần mỗi phiếu hay cộng theo kỳ; quyền sổ chi; ngoại lệ B0 và thứ tự rollback. Không tự coi những điều này đã được chủ chốt qua lựa chọn ba kiểu.

Con số “tiền nhà trước (19 toà)” ở câu 01 chưa được audit đối chiếu hợp đồng/nhu cầu cam kết từng toà. Không dùng tổng số toà có điện nước thay cho tập có nghĩa vụ tiền nhà.

## 4. Trả lời đủ 10 câu §11

| Câu | Trả lời |
|---|---|
| **1 — Trần có chạy?** | **Có gọi thật**, helper chạy đúng biên chỉ đọc; 3 dấu vượt trần + duyệt muộn là bằng chứng thực tế hỗ trợ. 24 dòng thuộc 16 toà nhưng chỉ phủ 14/15 toà và 22/26 cặp toà–loại của phiếu sống 90 ngày. 0 đang chờ không đo birth status. P6/Y3. |
| **2 — RLS mở?** | **Không còn mở như plan nêu**; RBAC và org boundary đang có. Nhưng migration thêm luật chưa có bảo vệ cột/mapping, phải chốt ACL cột + RPC hoặc enforcement trigger trước G3/G4. P1. |
| **3 — Bỏ khoá khe an toàn?** | **Không đủ.** Cần giao thức khoá/chốt phần tiêu cùng transaction cho mọi writer/transition; giữ idempotency riêng. Chưa tái hiện đua bằng ghi production. C2. |
| **4 — Chi ngoài cam kết vào hạng mục CAM_KET?** | CHỜ là hành vi bảo thủ hợp lý nếu đúng hạng mục và vượt/ngoài phạm vi. Nhưng số tiền nằm trong phần còn lại mà **sai mục đích** vẫn có thể tự duyệt; facts chưa có obligation/purpose để phân biệt. Phải chốt nghiệp vụ hoặc tách hạng mục/phần chi, không dùng chỉ tên hạng mục và amount làm bằng chứng nghĩa vụ. |
| **5 — Nối theo lưu lượng hay tiền?** | Dùng rủi ro tiền + độ phủ + tính nguyên tử theo tập cam kết. Có thể thử ít người trước, nhưng không để cron/writer cũ đứng ngoài protocol của bucket đã bật. 1,30 tỷ là tổng có cả chờ/huỷ, không phải tổng tự duyệt. C2/P4. |
| **6 — Canonical nửa vời?** | Tiền đề 100 nhóm cần gộp sai: 0 trùng trong org. Mapping key theo org là nhu cầu thật; alias chỉ khi cần và có bất biến không vòng/cross-org, reader thống nhất. Không xoá phiếu cũ không có nghĩa mọi mapping đều an toàn. C1/P3. |
| **7 — Gate grep đủ?** | Không. Có JSON record/helper/dynamic SQL, và pure decider không tự ghi status. Kết hợp inventory/enforcement/runtime/JWT/concurrency/mutation test; sửa INV-3 cho đúng phạm vi. P5/§7. |
| **8 — Số nền lệch?** | Số nghiệp vụ và 16 md5 **khớp toàn bộ**, chỉ timestamp đổi. Sai lệch có hướng nằm ở cách diễn giải tenant/status/mẫu đo, không phải drift 16 phút. §2. |
| **9 — Gỡ §5 cũ?** | Không cần xoá lịch sử. Banner đầu đủ rõ nhưng superplan còn chỉ đạo cũ; đổi entry point và đánh dấu ngay §5 trước phase đầu. P10. |
| **10 — B1 phá THU?** | Có thể đổi THU thông thường đang tự duyệt qua manual/compat nhưng không sổ/ảo sổ sang CHỜ; chưa có bằng chứng phá V5 vì bị loại khỏi scope. Compat draft/định kỳ đã CHỜ là lớp khác. Mẫu sống không có THU APPROVED thiếu account, có 1 THU không nhãn dùng sổ ảo; B2 THU cọc là đổi khác cũng chưa chốt. P7. |

## 5. Ma trận điểm neo C và phần chưa xác minh

| Neo | Kết quả |
|---|---|
| C-1 | Thang năm nhánh có thật, body sống cùng fingerprint; OWNER/THU đứng trước force/threshold |
| C-2 | VALID hoặc CONFIG_REQUIRED dẫn helper duyệt/post, xác nhận |
| C-3 | Ba verdict VALID / CONFIG_REQUIRED / AMOUNT_MISMATCH có thật; CONFIG_REQUIRED còn gồm kỳ sai/lẻ/quá dài/thiếu tháng, không chỉ bảng rỗng |
| C-4 | Nối thật, xem §1.1; baseline không phải bản mới nhất |
| C-5 | Nhánh người lập tự duyệt đúng, nhưng còn ở approve_voucher |
| C-6 | Route /thanh-toan dùng thu_tien.collect, financeWorkRoutes.tsx:39 |
| C-7 | Route fixed-fees/hook/setter có thật; kiểm quyền server riêng |
| C-8 | Hai lời gọi batch compat đúng, còn caller khác phải tính cho G7 |
| C-9 | Đúng phạm vi sổ THU, sai cách nói “caller duy nhất”; change_collection_tender_method_v1 cũng ép danh sách |
| C-10 | a01_ie_revise_scope_delta có thật ở migration 25/09 |

**Chưa kiểm và vì sao:**

- Không gọi writer/UPDATE/DDL hay tạo tình huống đua thật trên production, kể cả bọc rollback: user chỉ cho đọc. Do đó kết luận race là phản ví dụ thiết kế + kiểm khoá source, không phải tái hiện runtime.
- Không chạy E2E/JWT ghi, migrate:forward, test mutation, restore/rollback rehearsal hoặc hai gate reconcile toàn bộ. Không có triển khai mới để nghiệm thu; các phép count không được gọi là thay thế các gate đó.
- Không chứng minh đầy đủ lịch sử trạng thái/rule/permission tại lúc tạo của mọi phiếu. Replay và approved_at là chẩn đoán hậu kiểm; 16 cấu hình mới hơn phiếu cho thấy giới hạn rõ ràng.
- Không kiểm xác thực độc lập lời chốt của chủ, hợp đồng gốc, tập 19 toà cần cam kết, độ phủ nghĩa vụ thực, con số matcher sai 16/10/3, lượng compat ~50 từ 24/07, hoặc toàn bộ số máy chọn sổ ≈10+≈8. Chúng không có phép đo tương đương trong lượt này; báo cáo không dùng làm nền kết luận chặn.
- Không coi md5 16 hàm là checksum toàn DB. Policies/ACL/trigger cần catalog riêng đã đo; các dependency ngoài phạm vi đó chưa được kiểm toàn diện.
- Không mở trang trình bày trên claude.ai; đối tượng audit là file plan đã ghim hash, không phải giao diện trình bày.
- Không kiểm số liệu các hạng mục không thuộc kế hoạch hoặc audit lại toàn bộ gói 23/09. Chỉ chạy thêm ba invariant ghi sổ kế thừa và đọc phần chứng cứ cần thiết.

## 6. Tệp chứng cứ và chạy lại

| Tệp | Nội dung |
|---|---|
| `do-nen-ket-qua.json`, `do-nen2-ket-qua.json` | Output nguyên văn hai script gốc, giữ cả hai lỗi SQL gốc |
| `doi-chieu-nen.json` | So từng key số nền; so 16 md5; hash input; refs; kiểm A-9 |
| `catalog-song.json` | Cột, policies, ACL, indexes/triggers hạng mục, phân org, config, body utility |
| `doi-chieu-song.json` | Độ phủ/replay/probe trần, THU/sổ, trùng cross-org, DISTINCT khe, body phụ |
| `xac-nhan-song.json` | Mẫu loại CANCELLED, 3 phiếu vượt trần, cặp thiếu, trạng thái định kỳ, ba invariant, ACL V4, body writer |
| `doi-chieu-loi-lan1.json`, `doi-chieu-loi-lan2.json` | Hai lần SQL bổ sung lỗi alias trước khi sửa và chạy thành công; giữ để không che lỗi |
| `truy-van-*.json`, `do-bo-sung.cjs` | SQL đầy đủ và runner chỉ đọc, mỗi câu có SAVEPOINT |
| `kiem-chung-goi.cjs` | So số, md5, hash và diff bằng file/Git, không truy vấn DB |
| `FILES-SHA256.json` | Hash các artifact, xác nhận JSON đọc được, hash đầu vào không đổi, ba phiên bổ sung read_only=on và không có mật khẩu DB trong artifact |

Chạy tại thư mục audit bên trong checkout chính, PowerShell:

```powershell
$env:NODE_PATH = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main/node_modules'
node '../2026-09-26-plan-cam-ket-goi-audit/do-nen.cjs'
node '../2026-09-26-plan-cam-ket-goi-audit/do-nen2.cjs'
node './do-bo-sung.cjs' 'truy-van-catalog.json' 'catalog-song.json'
node './do-bo-sung.cjs' 'truy-van-doi-chieu.json' 'doi-chieu-song.json'
node './do-bo-sung.cjs' 'truy-van-xac-nhan.json' 'xac-nhan-song.json'
node './kiem-chung-goi.cjs'
```

Runner đọc đúng credential cần dùng từ vault gốc, không in hoặc nhận mật khẩu trên dòng lệnh. Muốn giữ snapshot audit này, chạy vào bản thư mục chứng cứ mới/đặt tên output mới; lệnh trên ghi đè output cùng tên. Gói không nén zip.

Báo cáo đã được ba nhánh kiểm nguồn theo chuyên đề đọc phản biện lại; các nhận xét quá rộng về matcher TypeScript, probe một cấu hình và ngoại lệ compat đã được thu hẹp. Kiểm hash cuối vẫn khớp plan/gói gốc; phạm vi Git chỉ thêm thư mục audit này, giữ nguyên thay đổi có sẵn của người dùng.
