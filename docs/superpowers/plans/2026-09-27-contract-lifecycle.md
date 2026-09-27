# Hợp đồng, trả phòng, cọc và phòng sale — Implementation Plan V2

> **Dành cho agent thi hành:** dùng superpowers:executing-plans theo từng task và checkpoint; đọc Project Contract trước. Đây là kế hoạch, chưa phải lệnh triển khai production.

**Phiên bản:** 02, cập nhật theo chốt mới nhất của chủ. **Phạm vi:** cải tiến thao tác và theo dõi, giữ nguyên nghiệp vụ quyết toán/thu–chi đang dùng. Ngay bước đầu bắt buộc chọn loại thanh lý + ngày thực trả; chọn quyết toán ngay hoặc sau. Không còn yêu cầu chủ chọn lại chính sách tiền. Chưa sửa ứng dụng, chưa chạy migration, chưa đóng gate runtime.

**Mục tiêu:** quản lý ghi đúng việc khách đã đi và chào phòng ngay; kế toán xử lý tiền sau hoặc ngay trong cùng lần thao tác; chuẩn bị, tải và xác nhận hợp đồng từ nháp; mọi tiền/cọc và quyền giữ phòng thuộc đúng lượt khách.

**Phạm vi được chủ xác nhận lại:** giữ nguyên R01–R13 của bản trước audit; **chỉ nhượng hợp đồng (EX01/P9.T) là phần mở rộng mới**. Các đề xuất kỹ thuật vốn còn mở trong bản cũ giữ đúng trạng thái đề xuất, không tự trở thành nghiệp vụ được duyệt.

**Giới hạn cần giữ khi thi hành — đính chính mới nhất của chủ:** giữ nguyên toàn bộ flow quyết toán hiện tại, kể cả bỏ cọc, xử lý/hủy hóa đơn nợ và credit theo cơ chế đang dùng. Chủ xác nhận mô tả trước về giữ nợ khi bỏ cọc là nhầm; yêu cầu đó đã rút, không sửa bộ máy tiền để giữ nợ. Phần thêm là lưu loại ban đầu/ngày thực trả, nhả phòng khi quyết toán sau, hàng chờ và lịch sử đổi loại. DEFERRED chưa chạy nghiệp vụ tiền; đến lúc quyết toán mới áp dụng flow hiện hành theo loại cuối. Báo ngày trả/nhắc quá hạn, dọn sửa vẫn sale, nháp không giữ phòng vẫn giữ nguyên.

**Kiến trúc:** tách lịch dự kiến, lượt ở thực tế, hồ sơ quyết toán, công việc dọn/sửa, quyền giữ phòng và tài liệu hợp đồng. Dùng chung nguồn sự thật ở server cho các kênh; giữ bộ máy tiền hiện hành sau khi đóng đường ghi cũ không an toàn. Stack hiện tại React/Vite, Supabase/Postgres, Edge/worker; tài liệu mới dùng Supabase Storage private.

## 0. Đọc plan này và nguồn chứng cứ

Đây là bản master để thi hành/audit trong checkout gốc. Các tài liệu sau là thành phần của V2:

- **Đọc trước:** [đối chiếu hiện trạng, mục tiêu và13 yêu cầu gốc trước audit](../../audits/2026-09-27-contract-lifecycle/revision-v2/scope-alignment.md). Audit chỉ sửa cách hiện thực, không đổi flow hoặc nghiệp vụ đã chốt.

- [Rà flow, quyền/trigger và đối soát](../../audits/2026-09-27-contract-lifecycle/revision-v2/flow-control-review.md): bảng tác động từng thao tác, một hồ sơ thấy đủ nghĩa vụ và phát hiện FC01–FC06. Không thêm tầng duyệt hoặc nghiệp vụ mới.

- [Đối chiếu 35 finding và phán quyết](../../audits/2026-09-27-contract-lifecycle/revision-v2/audit-response.md).
- [Chốt nghiệp vụ, các câu còn chờ và lựa chọn kỹ thuật](../../audits/2026-09-27-contract-lifecycle/revision-v2/decisions.md).
- Review source theo miền: [tiền/quyền/khóa](../../audits/2026-09-27-contract-lifecycle/revision-v2/finance-review.md), [nháp/cọc/ký](../../audits/2026-09-27-contract-lifecycle/revision-v2/drafts-review.md), [phòng/nhắc việc/kênh sale](../../audits/2026-09-27-contract-lifecycle/revision-v2/availability-review.md).
- [Ma trận nghiệm thu V01–V55](../../audits/2026-09-27-contract-lifecycle/revision-v2/verification-matrix.md), [kết quả kiểm riêng lần sửa tài liệu](../../audits/2026-09-27-contract-lifecycle/revision-v2/verification-summary.md).
- [Audit độc lập bản công khai đã biên tập](../../audits/2026-09-27-contract-lifecycle/independent-audit.md) (bản nguyên gốc giữ ở checkout riêng tư), [V1 được audit, giữ nguyên](../../audits/2026-09-27-contract-lifecycle/revision-v2/plan-v1-reviewed.md), [manifest bằng chứng đã đọc](../../audits/2026-09-27-contract-lifecycle/revision-v2/reviewed-evidence-manifest.json).
- [Sơ đồ cho quản lý/kế toán](../../../outputs/so-do-hop-dong-2026-09-27/so-do-hop-dong.html), [prompt audit tại gốc repo](../../../AUDIT-HOP-DONG-2026-09-27.md).

Source đối chiếu: `e498f10d49f3548e72074095c955371d0cee41ab`. Đã kiểm source và 45 thân hàm do reviewer lưu; catalog chụp lúc `2026-09-27T12:35:40.599Z`, không phải truy vấn DB sống mới. Probe TEST lưu sẵn chứng minh tạo thêm **phiếu hoàn chưa duyệt**, direct status update và chu kỳ khóa; chưa chứng minh production đã chi trùng. HTTP JWT, E2E và reconcile nghiệp vụ còn phải chạy lúc thi hành.

Reviewer ghi baseline đúng phạm vi 20 files/496 tests; 6 files/259 tests bổ sung có phần trùng, **không cộng thành 755 tests độc lập**. Bản source đóng gói dưới `outputs/` khiến test bị quét hai lần nếu không exclude. Lần sửa V2 không chạy lại các test ứng dụng không thay đổi.

### Ràng buộc xuyên suốt

1. Tuân thủ [Project Contract](../../engineering/PROJECT_CONTRACT.md). Theo yêu cầu chủ, tài liệu ở checkout gốc; giữ nguyên công việc dở dang khác. Khi thi hành app/schema mới chọn checkout theo Contract.
2. Thử ghi trên project TEST riêng, target xác định tường minh; không ghi org thật. So parity baseline tiền/quyền/spend trước thay đổi, rồi xác minh chỉ có delta đã duyệt. Không đòi TEST và prod có hash giống nhau sau thêm tính năng.
3. Migration forward, lịch sử/witness bất biến. Pinned runtime body/owner/ACL muốn thay phải có supersession được review và gate xác minh chuyển tiếp; không đổi hash cũ để xanh.
4. Không tạo bộ máy tiền song song; không khôi phục raw RPC đã thu quyền; chốt số không đồng nghĩa phiếu đã duyệt hoặc tiền đã chi.
5. **Giữ quyền hiện tại theo B4**, mapping action mới vào đúng authority hiện hành; không tự cấp/bớt quyền thu–chi–duyệt. Scope/eligibility vẫn kiểm ở server, unknown mapping deny; quyền thấy tòa không cấp quyền thấy snapshot tiền. Reader STABLE dùng authorizer thuần, không gọi helper lấy khóa.
6. UI qua hook/service, RPC typed + validation input/output. Không thêm any/cast né lỗi, sửa generated types bằng tay hoặc tăng TS baseline.
7. Mốc đo vật lý độc lập thu/chi; ghi đọc điện không được phụ thuộc khoản thu >0 hoặc catch rồi bỏ qua lỗi.
8. Cùng intent giữ operation ID qua timeout/retry; kiểm quyền trước trả kết quả replay; cùng key/khác nội dung bị từ chối.
9. Không tự đổi số hợp đồng lịch sử, chuyển chủ tiền, miễn nợ ngoài nghiệp vụ hiện hành, suy khoản chưa biết thành 0 hoặc reset cọc khách mới từ hồ sơ cũ. Xử lý nợ trong quyết toán/bỏ cọc giữ nguyên theo B2 đã đính chính.
10. Authz, tiền, migration và cách ly org cần test hành vi âm, concurrency, idempotency và mutation; grep SQL không thay JWT thật.
11. Public chỉ projection allowlist; invalid token, không có phòng và lỗi mạng là ba kết quả khác nhau. Không fallback dữ liệu mẫu/số liên hệ giả.
12. Mọi kênh dùng cùng facts: public, bảng nội bộ, Copilot, Zalo, worker tạo nội dung/ảnh. Không đóng task chỉ với hai UI.
13. Cả hai reconcile theo Contract vẫn bắt buộc, thêm harness TEST không miễn chúng. Lệnh có default production chưa được dùng để thử ghi hoặc coi scope fixture đã có sẵn.
14. Mỗi slice tiền/quyền/schema cần review độc lập, draft PR và lane phát hành; rollback app giữ dữ liệu đã tạo đọc/thu/chi được. Không rollback schema phá hủy.

## 1. Yêu cầu đã chốt và phạm vi giao

| ID | Hành vi phải giữ | Task chính |
|---|---|---|
| R01 | Báo ngày dự kiến trả nhanh; đổi/hủy được, sale cập nhật theo thông tin mới. Ngày dự kiến không tự kết thúc hợp đồng. | P2/P4 |
| R02 | Đến/quá ngày chưa xác nhận phải có nhắc việc và hàng quá hạn; không mất việc chỉ vì đã đọc notification. | P5 |
| R03 | Thanh lý bắt buộc **ngày bàn giao thực tế + loại thanh lý** ngay ban đầu: hết hạn / trả trước hạn / bỏ cọc. | P6/P8 |
| R04 | Hai nhánh trong cùng form: **trả phòng, quyết toán sau** hoặc **thanh lý và quyết toán ngay**. | P6/P7/P8 |
| R05 | Nhánh sau: kết thúc lượt ở, phòng dùng được cho lượt mới; tiền/nợ/cọc còn nguyên để xử lý. Chưa biết là NULL/chờ bổ sung, không phải 0. | P6 |
| R06 | Quyết toán được chọn lại hình thức thanh lý; giữ loại ban đầu, loại cuối, lý do, người và thời điểm đổi. | P7 |
| R07 | Chốt số khác thực thu/chi. Kết quả: hoàn tất / chờ hoàn / chờ khách trả; theo tiền đã ghi sổ và các reversal. | P7/P8 |
| R08 | Quyết toán A sau khi B vào phòng không đổi phòng/cọc/hợp đồng B. | P6/P7 |
| R09 | **Phòng đã trả đang dọn/sửa vẫn lên sale là trống**, kèm ngày dự kiến nhận. Đây là dữ kiện theo dõi công việc, không phải khoá chào phòng. | P3/P4 |
| R10 | Dọn/sửa trễ phải nhắc và cập nhật ngày; chưa có ngày mới thì sale ghi cần xác nhận ngày nhận. Không ẩn phòng chỉ vì dọn/sửa trễ. Giữ nguyên giữ chỗ khách kế tiếp. | P3/P5 |
| R11 | Nháp lưu/sửa/tải gửi xem trước; **nháp không giữ phòng**, không sinh thu tiền hoặc hoá đơn. Giữ chỗ/cọc riêng. | P9/P10 |
| R12 | Xác nhận đã ký từ đúng bản nháp; tái sử dụng dữ liệu, không tạo trùng khi bấm lại. | P11a |
| R13 | Giữ chỗ/cọc/hoàn/bỏ cọc và hồ sơ tồn đọng phải dễ theo dõi, gắn đúng lượt khách. | P8/P9/P9.T |

**EX01 — phần mở rộng duy nhất vừa bổ sung:** nhượng hai hợp đồng liên kết theo B5/N1, thực hiện riêng ở P9.T; không sửa13 yêu cầu gốc phía trên.

**P11a** giao ký từ nháp và nhận phòng ngay. **P11b** tương ứng đề xuất kỹ thuật D03 đã có trong bản trước audit, chưa được tự bật khi billing/hủy/no-show chưa rõ; không phải nghiệp vụ mới vừa được duyệt và không dùng G-BILLING để trì hoãn R12/P11a.

Luồng quản lý: `Báo ngày trả (tùy chọn) → Thanh lý: ngày thực tế + loại bắt buộc → [Quyết toán sau | Quyết toán ngay] → phòng trống + việc dọn/sửa nếu có`. Luồng kế toán: `Hồ sơ chờ → đối chiếu → chọn lại loại nếu cần → xem trước số → chốt → theo dõi phiếu/thu/chi còn mở`. Luồng khách mới: `nháp không giữ → giữ chỗ/cọc riêng nếu có → xác nhận đã ký + bàn giao → hợp đồng chính thức`.

### Quyết định nghiệp vụ đã chốt và còn chờ

| ID | Trạng thái / quyết định | Áp dụng |
|---|---|---|
| B1 | **Đã chốt:** trả phòng và sale ngay dù thiếu số; đủ mốc rõ mới bàn giao khách mới. | P6/P11a: A thiếu mốc ở hàng đối soát; B có MOVE_IN riêng được xác minh. |
| B2 | **Đã đính chính: giữ nguyên flow cũ.** Bỏ cọc, hóa đơn nợ, credit và chứng từ xử lý như hiện tại, kể cả hủy nợ nếu đó là tác động của flow đang dùng. Rút yêu cầu giữ toàn bộ nợ và ví dụ phải thu1 triệu sau bỏ cọc. | P0/P7/V11/V14 so kết quả với luồng hiện hành; DEFERRED chưa chạy tiền, khi quyết toán mới áp dụng theo loại cuối. |
| B3 | **Giữ cách hiện tại:** tạo/duyệt/chi phiếu hoàn và quyền không thay đổi; rút các đề xuất thêm nút duyệt hoặc ép phiếu chờ. | P0 chụp baseline luồng thật, P7 dùng lại; không còn câu hỏi chọn policy. |
| B4 | **Đã chốt:** toàn bộ quyền giữ như hiện tại; thay flow/thêm bước, không đổi quyền xử lý tiền thu–chi. | P0 chụp mapping hiện hành; action mới giữ parity, không tạo/grant settle mới để đổi vai trò. |
| B5 | **Đã chốt:** hai hợp đồng riêng có liên kết và dấu nhượng. Tự tìm khách: cọc mới hoặc dùng cọc cũ bù, giữ hạn cũ/chọn hạn mới. Môi giới: trích 50% cọc cũ, khách mới đóng đủ cọc. | P9.T; old quyết toán/new ký bình thường, N1/N2 xác định allocation. |
| N1 | **Đã chốt:** cọc cũ 4 triệu → phí nhượng bắt buộc 50%=2 triệu để chi hoa hồng hợp đồng mới → phần cọc hoàn 2 triệu; thu khác thanh lý như bình thường. | P9.T: base trước khoản thanh lý khác; fee line và commission liên kết, không thu/cấn cùng phí hai lần. |
| N2 | **Không thêm policy tiền:** giữ lựa chọn cọc theo B5 và cơ chế cấn/chứng từ hiện hành; chỉ nối đúng nguồn hai hồ sơ. Rút đề xuất tự chuyển số còn hoàn như một cơ chế mới. | P0/P9.T xác minh đường hiện hành để map; chưa map được thì báo thiếu tương thích, không tự đổi cách làm. |

Chi tiết ở decisions.md. Chỉ thị “giữ nguyên cách làm hiện tại, đừng sửa quyết toán” thay thế các phương án đổi policy tác giả từng đề xuất. B3/N2 là yêu cầu giữ tương thích, không được ghi người dùng đã chọn một phương án thu/duyệt/chuyển tiền mới. Nếu source snapshot khác mô tả nghiệp vụ, tìm đúng đường đang dùng và chứng minh trên TEST trước khi nối flow; không hỏi chủ chọn lại nghiệp vụ hoặc copy side effect trái chốt.

## 2. Mô hình dữ liệu và invariant

Tên dưới đây là **đề xuất mới**, không được giả định đã tồn tại. P0 đối chiếu catalog, tránh tạo trùng primitive hiện có. Mọi bảng domain có org/building phù hợp, timestamps, actor, version; FK/constraint phải chặn subject khác org/tòa ngay ở server. Bảng private không expose PostgREST, quyền service cũng phải đi đúng writer. Áp sandbox-hide theo Contract cho bảng mới có org.

### 2.1 Lượt ở, hồ sơ cũ và việc vận hành

| Đối tượng | Dữ liệu / ràng buộc |
|---|---|
| contracts | lifecycle_version; actual_move_in_date. Occupancy khác ngày hẹn/tiền; protected fields có guard. Không nhét draft vào enum contract chính thức. |
| contract_moveout_notices | contract/room, expected_on, OPEN/FULFILLED/CANCELLED, responsible, revision; tối đa một OPEN/contract. Đổi/hủy append event, không tự TERM khi quá ngày. |
| contract_exit_cases | UNIQUE(contract_id), room_at_handover, **party_snapshot**, actual_move_out_on, initial_kind bắt buộc/bất biến, current_kind có lịch sử, DEFERRED/IMMEDIATE, PENDING/FINALIZED, boundary state/ref, due/responsible, accounting_on, immutable final snapshot + version, nguồn tiền, legacy source unique. Không tự bổ sung tính năng hủy lần trả trong scope này. |
| contract_lifecycle_events | Append-only; subject type/id, org/building, action, before/after tối thiểu, reason/actor/time. Phân quyền financial payload; không ghi PII hoặc secret vào public log. |
| room_turnovers | Source EXIT_CASE / ROOM_TRANSFER / LEGACY_VACANCY, room, PENDING/READY/VOIDED, expected_ready_on nullable, responsible/current pointer. Một công việc current đang mở/phòng. Hủy hợp đồng chưa nhận không tự sinh turnover mới. |
| room_turnover_jobs | Link immutable đến turnover; TRACKING hoặc APPROVED_PAID_JOB. TRACKING không tạo tick/bonus/payroll kể cả gọi API trực tiếp. |
| lifecycle_work_items | source_kind/id, phase, source_revision, OPEN/RESOLVED/SUPERSEDED, due, responsible. Partial UNIQUE(source_kind, source_id) WHERE OPEN; **không đưa revision vào unique OPEN**. Đổi phase đóng/mở cùng transaction. |
| notification outbox private | Digest key org + recipient **user_id** + local day + notification family; refs source/revision, lease, attempts, next_attempt, delivery state. Work items mới trong ngày cập nhật digest/inbox, không lặp push từng item. |
| lifecycle job runs private | execution_id/environment/lease/checkpoint; retry sau lỗi. Không khóa cả ngày bằng daily-run flag rồi bỏ sót công việc đến sau. |
| settlement previews private | Subject ACTIVE_CONTRACT_EXIT_INTENT / EXIT_CASE / SIGNED_CANCELLATION, actor/scope, versions, financial facts/eligible IDs, policy version, intent hash, TTL 10 phút, consumed operation và result case ID. Preview trước trả bind contract version và physical intent, không tạo case/occupancy effects. TTL là cấu hình đề xuất, kiểm ở server. |

Case của hợp đồng từng nhượng phải có lineage/party allocation đã xác minh. Contract ID đơn lẻ chưa chứng minh ai sở hữu credit/cọc. Legacy không rõ phải vào LEGACY_REVIEW, không đoán người nhận hoàn từ đại diện hiện tại.

Enum loại đề xuất: NATURAL_EXPIRY (hết hạn), EARLY_RETURN (trả trước hạn), FORFEIT (bỏ cọc). **initial_kind bắt buộc ngay khi xác nhận trả**, current_kind lưu kết luận lúc quyết toán. Chỉ chọn loại ở nhánh quyết toán sau chưa tự ghi doanh thu/thu tiền; lúc xử lý tiền dùng đúng nghiệp vụ hiện hành theo B2. Retry chỉ trả lại case của đúng intent đã ghi; không tự mở lại lượt ở.

### 2.2 Chỉ số vật lý tách tiền

`contract_meter_boundaries`: contract/room/meter, kind MOVE_OUT hoặc MOVE_IN, measured_at, effective_on, reading, evidence, actor, revision, VERIFIED/MISSING/REVIEW. Dữ liệu meter_readings tham chiếu boundary; số 0 hợp lệ khác thiếu số.

- MOVE_OUT của A và MOVE_IN của B là hai mốc. Nếu dọn/sửa có tiêu thụ, khoảng giữa thuộc khoảng trống quản lý; không tự thu A/B hay tự sinh phiếu chi khi chưa có policy.
- Khi B có mốc nhận riêng đã xác minh, không lấy thiếu số A làm lý do tính phần A vào B. Thiếu A nằm đối soát theo B1; không suy bằng 0 hoặc lấy chỉ số B điền ngược.
- Reader tính predecessor theo meter + interval + thời điểm đo + thứ tự tie-break rõ, không dùng latest toàn meter bất kể kỳ/khách. Đồng hồ thay/rollover là sự kiện riêng, không làm hiệu âm rồi ép về 0.
- Ghi mốc vật lý trong transaction bàn giao, không trong nhánh extra_charge >0. Sửa mốc muộn phát hiện hóa đơn đã phát hành/duyệt bị ảnh hưởng và đưa đối soát, không âm thầm sửa nợ lịch sử.

### 2.3 Giữ chỗ, cọc, nháp và tài liệu

| Đối tượng | Ràng buộc |
|---|---|
| room_reservations | Customer/party identity, room, intended dates, hold_until, trạng thái, version, converted_contract_id. Hạn nhắc khác tự hủy giữ. |
| room_next_claims | Registry mới, unique live org+room; owner chính xác reservation hoặc signed-waiting contract. LIVE/CONSUMED/CANCELLED, history giữ nguyên. Khi P11a nhận ngay hoặc P11b activate, claim LIVE → CONSUMED cùng transaction nhận, không còn next claim của lượt vừa nhận. Giữ chỗ thuần và cọc có tiền cùng protocol; không dùng bảng hold 24h/amount>0 làm registry mới. |
| reservation_receipts | Nguồn phiếu/dòng/allocation + reservation/customer/party; một allocation không thuộc hai lượt. Duyệt, hủy, reversal cập nhật facts nguyên tử. Pending receipt không bị đếm thành thực nhận. |
| contract_drafts | Typed payload + revision, EDITABLE/SIGNED/CANCELLED, converted_contract_id unique; mỗi draft tối đa một contract chính thức. Save/export hoàn toàn không ghi occupancy/claim/ledger; chỉ transaction ký được chuyển SIGNED/link contract. |
| contract_draft_revisions | Immutable nội dung đã lưu; optimistic version, không last-write-wins khi hai người sửa. |
| contract_document_versions | Pin revision payload, **bytes template**, selected template ID, renderer version/options và output hash; private object immutable, GENERATING/READY/FAILED, links source/final contract. Không tin DOCX do client upload là nội dung đã ký. |
| contract_number_allocations | Tận dụng allocator atomic hiện có, thêm registry/guard mọi writer. Seed mọi nhãn lịch sử là đã dùng; duplicate legacy tra UUID/queue, không tự đổi số giấy đã ký. |
| contract_transfer_links | B5: old_contract_id/old_exit_case_id, new_draft_id/new_contract_id, party snapshots, SELF_FOUND/BROKER, deposit mode, KEEP_OLD_END_DATE/NEW_TERM + dates, broker/commission source refs, policy/revision/state. Unique new contract và một link sống/old exit; cross-org/party/source validate. Link hiển thị ở cả hai hợp đồng; legacy nhượng cùng ID giữ riêng để đối soát. |

Adapter chuyển tiếp đọc/khóa đủ bốn nguồn cọc/hold hiện hành, kể cả orphan receipt, hold_until và 24h operational hold. Pass là tin chào phòng, không phải giữ chỗ. Không tự hủy claim có tiền vì hết 24h; hold không tiền có hạn do người dùng xác nhận, hết hạn sinh việc và policy rõ trước auto-release.

Storage mới dùng bucket private với authorized download ngắn hạn. Migration 016/025 khai báo bucket template/contract-files private, nhưng chưa xác minh cấu hình và policy live hiện tại đủ scope org/tòa; getPublicUrl trong metadata không chứng minh bucket đang public. Không xóa object/template được snapshot tham chiếu. Export nháp có dấu “BẢN NHÁP” và số tham chiếu nháp; không tiêu số chính thức. Source export cần READY trước xác nhận đúng nội dung. Transaction ký ghi terms/hash và cấp số nguyên tử; rendering bản chính thức chạy/retry sau commit, lỗi render không tạo hợp đồng/số mới.

### 2.4 Eligibility theo hành động

| Action | Điều kiện server |
|---|---|
| Báo trả/gia hạn/chuyển phòng đang ở | Lượt ở hợp lệ ACTIVE/EXTENDED, chưa có exit case sống, quyền đúng action, version mới nhất. |
| Xác nhận trả | Entry eligibility ACTIVE/EXTENDED + date/kind + scope; kiểm trước effects, token cho bước đổi TERM và audit cuối. |
| Chốt/thu/hoàn hồ sơ cũ | TERM + case/party/nguồn nghĩa vụ hợp lệ, quyền riêng; không đòi ACTIVE. |
| Lập hóa đơn | Period/subject eligibility ở server, loại kỳ đã chốt/không thuộc lượt; không chỉ lọc trạng thái trên UI. |
| Ký nhận ngay | Draft revision/artifact khớp, đúng claim/customer, phòng đủ điều kiện bàn giao, mốc nhận theo B1; tạo ACTIVE một lần. |
| Ký trước nhận | Chỉ P11b đã bật và G-BILLING đạt; SIGNED_WAITING giữ claim, chưa có occupancy. |

## 3. RPC, quyền ghi và giao dịch

Các RPC mới dưới đây là hợp đồng interface cần hiện thực; version/argument chính xác được đóng bằng generated surface ở P1. Mỗi mutator nhận operation_id + expected_version, trả typed result; server tự tính org/scope và tiền từ nguồn đã khóa.

| Surface đề xuất | Đầu vào/kết quả chính |
|---|---|
| update_contract_operational_fields_v1 | Metadata allowlist; thay direct protected PATCH, không cho giả trạng thái/room/party. |
| set_contract_moveout_notice_v1 / cancel_contract_moveout_notice_v1 | contract, expected date/reason/version → notice, facts revision. |
| confirm_contract_moveout_v1 | Ngày thực, loại bắt buộc, DEFERRED/IMMEDIATE, boundary payload, turnover → exit case + room projection. |
| record_contract_meter_boundary_v1 | Subject/kind/readings/evidence/version → verified boundary hoặc REVIEW; không tiền side effect. |
| preview_contract_exit_settlement_v1 / finalize_contract_exit_settlement_v1 | Preview union ACTIVE_CONTRACT_EXIT_INTENT(contract/version/date/kind/mode/boundary digest/turnover intent) hoặc EXIT_CASE(case/version/current_kind/reason), cùng accounting_on/policy/adjustments → token. Later finalize token+operation → snapshot/nguồn nghĩa vụ; IMMEDIATE token do confirm_contract_moveout_v1 consume trong cùng physical+financial transaction. |
| list_contract_exit_cases_v1 | Pagination, filter building/state/actor; cột tài chính chỉ với quyền tiền. |
| update_room_turnover_v1 | Expected ready/readiness/job/version → facts+work item. |
| create_room_reservation_v1 / update_room_reservation_terms_v1 | Identity/date/hold terms → registry claim. |
| link_reservation_receipt_v1 / cancel_room_reservation_v1 | Exact source allocation/identity → update receipt+claim; không dựa room hoặc payer_name. |
| save_contract_draft_v1 / cancel_contract_draft_v1 | Payload/revision; không room/ledger side effects. |
| request_contract_draft_export_v1 + renderer | Snapshot/version/template selection → authorized immutable artifact. |
| sign_and_checkin_contract_draft_v1 | P11a: revision/artifact hash/claim/date/boundary/confirmed terms → một contract ACTIVE + nguồn linked, cùng official core. |
| sign_contract_draft_for_future_v1 / activate_signed_contract_v1 / cancel_signed_contract_v1 | P11b riêng; cancellation preview/finalize theo subject SIGNED_CANCELLATION, không tạo exit giả. |
| public_room_availability_revision_v1 | Token đã map scope → scope epoch/revision/serverNow/nextTransitionAt; không nhận arbitrary org/building từ anon. |

`MoveOutInput` là discriminated union: DEFERRED không có monetary totals/preview; IMMEDIATE bắt preview hợp lệ và accounting_on. Theo B1 đã chốt, meter union COMPLETE(readings) hoặc MISSING(reason,responsible) đều ghi nhận trả được; MISSING không đủ để chốt khoản phụ thuộc chỉ số hoặc bàn giao B thiếu MOVE_IN riêng. Money dùng decimal/minor-unit contract nhất quán; quantity/meter không bị ép thành integer tiền. Server reject unknown fields thay vì tin tổng client.

### 3.1 Đóng đường ghi cũ trước rollout

Private write capability gắn transaction ID/backend, actor, org, action, đúng subject/allowed columns/transition và operation. Chỉ private issuer được cấp sau kiểm quyền/version; consume/close trong cùng transaction, rollback xóa toàn bộ. Không dùng GUC do caller đặt hoặc current_user=postgres làm bypass. Không hứa chống DB superuser cố ý sửa schema.

Guard nhìn diff cột và action: metadata vô hại vẫn dùng được; lifecycle/identity/financial-driving changes cần token. Entry eligibility được kiểm trước effects; sau đó token cho phép writer đổi TERM rồi hoàn tất audit. Guard “mọi UPDATE phải ACTIVE” sẽ làm hỏng flow hợp lệ nên bị cấm. Trigger chạy sau khi đã giữ row lock không đủ sửa thứ tự khóa của entrypoint.

| Cửa hiện có phải inventory và quyết định KEEP_ADAPTER / REPLACE / REVOKE | Xử lý bắt buộc |
|---|---|
| Direct contract_terminations INSERT DRAFT + approve_contract_termination_v1 | Kiểm eligibility/case v2 từ đầu; block raw bypass; DRAFT legacy hợp lệ qua adapter hoặc review queue. |
| create_contract_v1; raw terminate_* và overload/impl | Đóng ACL/raw sau kiểm owner callgraph; wrapper credit kiểm trước mutation. Không drop vội làm gãy caller nội bộ. |
| create_contract_v2; ContractImportExportDialog insert ACTIVE | Core scope/claim/readiness/meter/number dưới khóa; import RPC atomic, lỗi từng dòng rõ. |
| useContracts.useUpdateContract; useRegisterMoveOut; soft-delete | Adapter cùng đợt guard; không giữ direct status/room/date/deleted_at PATCH. |
| renew_contract wrappers/impl | Lock+recheck; notice KEEP/CANCEL explicit, không ngầm bỏ lịch. |
| transfer_room; transfer_contract | Hai phòng khóa có thứ tự; notice cũ giải quyết riêng, turnover vacancy đúng nguồn. B5 v2 dùng hai hợp đồng linked; raw đổi đại diện cùng ID không được bypass flow v2; legacy còn hoạt động phải giữ lineage/review. |
| Bảng extension/transfer có trigger driving | RLS/guard token tương tự RPC; REST INSERT không vòng qua guard. |
| Copilot approve/terminate/deposit/renew/transfer actions | Cùng adapter, preview/confirm/authorization/version; không chỉ ẩn nút. |
| Orphan deposit linking, old holds/deposits, receipt approval/reversal | Cùng exact identity và claim guard, không tự nối theo room. |
| Collection/refund/reversal, cashbook/profit/spend writers | Cùng lock/period/provenance; TERM hợp lệ vẫn xử lý được. |

P0 xuất inventory tên+signature+owner+ACL+caller+decision; wildcard trong bảng này không thay inventory cụ thể. Kể cả RPC không có repo caller vẫn kiểm direct REST/ACL.

### 3.2 Khóa, period mutex và witness

Protocol ứng viên cần chứng minh toàn callgraph: resolve scope không khóa + authorizer thuần → **org NO KEY UPDATE trước helper authorize lấy SHARE** → mutex building/accounting-period → room IDs tăng dần → contract IDs tăng dần → case/notice/claim/draft → invoices → vouchers → cashbook/accounts → spend buckets → availability metadata counters theo thứ tự. Nếu trace thực tế có cạnh ngược, đổi toàn giao thức trước bật, không ghi “org-first là đủ”. Authorize/version recheck sau chờ khóa.

- Ghi rõ lock modes, advisory key và transaction lifetime; không cấp lock qua input org không xác minh. Global order phải gồm trigger, receipt approval, raw reverse, cashbook và close-month.
- Chốt tiền và khóa tháng dùng cùng mutex org/building/month, kể cả profit_monthly chưa có row và account NULL. FOR UPDATE một row chưa tồn tại không ngăn race. Chọn kỳ hạch toán hợp lệ trước effect, kiểm lại sau đợi.
- 14 retirement witness ghim body/owner/ACL. Với writer pinned còn raw callable, thêm _v3 rồi đổi frontend chưa đóng lock/bypass. Cần reviewed forward supersession: giữ witness lịch sử, thêm before/after signatures/hash/owner/ACL/migration receipt và rule gate chuyển tiếp.
- Nếu chưa supersede được, phải có ngoại lệ coexistence được review, thử tất cả cặp xung đột và bounded **whole-transaction retry cùng operation ID**; không retry fragment và không tuyên bố global deadlock-free. Không đạt một trong hai phương án thì slice liên quan chưa bật.
- Ma trận tối thiểu: moveout∥moveout/finalize/create/deposit/renew/transfer; finalize∥cashbook-lock/month-close/refund-approve/reversal; hai create/claim cùng phòng; hai rooms transfer ngược; counter nhiều tòa theo thứ tự. Chạy cả positive legacy adapter và raw pinned surface còn callable.

### 3.3 Trả phòng và quyết toán đúng flow đã chốt

**Quyết toán sau:** auth/locks/version → xác minh ngày+loại+boundary theo B1 → tạo case party snapshot → kết thúc lượt ở + fulfill notice + tắt pass của lượt đó → room projection vacant + turnover nếu cần + queue + revision → commit. Không tạo phiếu, clear credit, cancel invoice hay đổi số dư. Thiếu money là pending/null.

**Quyết toán ngay:** xem trước bằng subject ACTIVE_CONTRACT_EXIT_INTENT khi A còn đang ở, không ghi PENDING case trước. Token bind contract/version và physical intent ngày/loại/mode/boundary/turnover. confirm lấy khóa, revalidate toàn bộ rồi tạo case và chạy physical core + financial core P7 trong một transaction, lưu token→case/result. Financial validation/engine lỗi thì rollback cả lệnh; UI cho chọn rõ “ghi trả phòng, quyết toán sau” bằng intent mới nếu thực tế khách đã đi. Không lặng lẽ commit một nửa.

**Quyết toán sau khi B vào:** khóa case/nguồn của A; không update room hiện tại, không tìm hợp đồng bằng room, không reset shared current occupant. B snapshot hợp đồng/deposit/invoice/credit/allocation phải giữ nguyên; tổng sổ chung có thể tăng đúng giao dịch A.

Preview server bind actor/scope/subject và contract hoặc case version/eligible invoice IDs+versions/credit+deposit sources/meter facts/kind+policy+accounting date/physical intent/TTL. Với preview trước trả, proposed reading được kiểm với nguồn meter đang khóa; nếu physical intent đổi phải preview lại. Khi finalize/confirm, tính lại dưới khóa; thay facts phải preview lại. Không tin client debt/refund totals; không quét tất cả invoice chưa PAID, đặc biệt DRAFT. Prorate theo kỳ hợp đồng thực, không mặc định tháng lịch.

Final snapshot tách service_cutoff/actual_move_out_on, accounting_on và cash posted_on. Adapter context chỉ thêm khả năng xử lý hồ sơ cũ/chốt muộn, không đổi cách tính/hạch toán/duyệt hiện hành. **FORFEIT:** giữ nguyên doanh thu cọc, xử lý/hủy hóa đơn nợ, credit/tiền thừa và chứng từ theo luồng hiện tại với flags tương ứng; không thay bằng policy giữ nợ đã rút. Refund dùng đúng đường tạo/duyệt/chi hiện hành, có provenance; không ép generic writer tạo chờ hoặc duyệt ngay theo policy mới. Không rewrite lịch sử.

Spend engine test theo enforce ON/OFF × account thật/NULL × người có/không approve. NO_CASHBOOK có thể xảy ra trước SELF_APPROVER. Refund TUNG_PHIEU hiện không fee_category ⇒ **0 HOLD/DRAW**; lỗi CANONICAL abort toàn transaction, không đòi error row đã commit. Phiếu/tiền paid state dựa ledger và reversal, không cột FINALIZED của case.

Không bổ sung nút/RPC hoàn tác trả phòng như một tính năng mới từ audit. Guard phải chặn sửa trạng thái trực tiếp để mở lại lượt cũ hoặc đụng khách B. Nếu cần một nghiệp vụ hoàn tác mới, tách ngoài phạm vi hiện tại; không tự đảo tiền hay xóa lịch sử.

### 3.4 Một hành động gốc, tác động và dấu vết rõ ràng

Áp bảng từng thao tác ở [flow-control-review §2–5](../../audits/2026-09-27-contract-lifecycle/revision-v2/flow-control-review.md). Mỗi lệnh có authority, subject và tập tác động được phép; trigger/callee chỉ thực hiện trong phạm vi đó. Giữ trigger ràng buộc/posting/projection hợp lệ, không thêm bộ máy tiền hoặc biến kiểm tra kỹ thuật thành bước duyệt mới. Không tự mint quyền ở trigger để khởi động nghiệp vụ khác.

DEFERRED ghi `contract_exit_cases` PENDING; không INSERT/UPDATE `contract_terminations` DRAFT để theo dõi vì trigger legacy có thể tự điền tiền. Chọn/đổi loại chưa chốt không tự hạch toán. Later finalize không chạy lại physical core; IMMEDIATE chạy hai core dưới cùng lệnh. Lỗi event/chứng từ bắt buộc rollback; lỗi giao thông báo sau commit xử lý qua outbox, không khiến người dùng phải thực hiện lại giao dịch đã thành công.

Một xác nhận phải lần được `operation → case/contract/party → snapshot → nguồn/chứng từ → posting/reversal`; tái dùng operation/lineage hiện có. Replay không thêm case/chứng từ/sự kiện nghiệp vụ. Trigger kỹ thuật có thể tạo nhiều bút toán hợp lệ nhưng cùng hành động gốc; UI không trình bày thành nhiều lần thu/chi mới. Quyết định KEEP_ADAPTER/REPLACE/REVOKE phải ghi đến từng trigger/entrypoint ở P0, không chỉ ghi tên nhóm.

## 4. Facts phòng, nhắc việc và consumer

### 4.1 Phép tính phòng sale

Server trả facts gồm occupancy, notice, next claim, readiness/date confidence và publication policy; nhãn UI không tự suy từ rooms.status. Thứ tự:

1. Xác thực public token → org/buildings/scope_version; không mở rộng scope theo owner của dữ liệu lẫn tòa. Token cũ chỉ map khi xác minh chắc; không chắc thì cần đối soát, không đoán.
2. Claim khách kế tiếp hợp lệ từ registry hoặc adapter legacy chặn chào tự do. Người được giữ vẫn xem lịch bàn giao trong hồ sơ riêng. Draft không ảnh hưởng bước này.
3. Có người đang ở: notice còn hợp lệ hiển thị “Sắp trống · từ ngày …” nếu còn nhận khách; pass hợp lệ gắn đúng lượt được dùng theo policy hiện hành. Quá ngày dự kiến mà chưa xác nhận trả thì không chào một ngày đã sai: nội bộ “Cần xác nhận khách đã đi/đổi lịch”; public tạm ngừng lời hứa ngày nhận cũ cho tới xác nhận. Đây là policy hiển thị đề xuất, cần UAT chủ trước bật.
4. Đã nhận bàn giao: trống; turnover PENDING vẫn sale với ngày nhận dự kiến. Hết hạn dọn/sửa vẫn trống + cần xác nhận ngày nhận, giữ claim đang có. Unknown date hợp lệ, không bịa ngày hoặc READY.
5. Turnover READY: trống/nhận được theo facts. Không có turnover chưa đủ chứng minh sẵn sàng ở dữ liệu legacy; cần confidence/xác nhận. MAINTENANCE vận hành độc lập không được ghi tự động chỉ vì turnover.

Pass phải có source_contract/party, ngày và confirmed_at; khi lượt đó kết thúc/nhận mới thì tắt nguyên tử. Không cho pass của A tự sống lại sau B. Contact public chỉ người được phép công khai và verified; bỏ sale_bonus_note, SAMPLE fallback, tên/hotline giả và PII khách.

Revision dùng metadata counters scope/building **khóa cùng transaction**, touch ở cuối lock protocol; multi-building theo thứ tự. Không chạm updated_at của rooms/contracts và không dùng MAX(seq) append log thuần: seq nhỏ commit muộn có thể bị miss. Token trả revision vector/hash + scope epoch, serverNow/nextTransitionAt để chuyển mốc ngày ngay cả chưa có ghi dữ liệu. Khi scope đổi phải purge cache. Mọi source ảnh hưởng listing/claim đều bump; không phát metadata tài chính riêng không cần thiết.

Public poll dự kiến 5s khi visible, focus/reconnect refresh; mục tiêu TEST p95 ≤10s **cần đo**, chưa phải cam kết push realtime. Backoff/error state, rate limit, payload nhỏ và ngân sách RPC/egress theo số tab/người thật trước bật. In-app realtime qua hub có org/building cleanup; anon không subscribe bảng private.

### 4.2 Hàng việc là nguồn chính, thông báo là kênh báo

Sweep server độc lập Dashboard/client, service role có explicit environment/org/clock và authorization policy riêng; không dựa auth.uid() NULL của cron. Trước tạo/drain kiểm source revision+state+quyền người nhận lại. Recipient user ID khác membership ID. Failed lease được retry; không mất công việc vì daily lock đã đánh dấu xong.

Các việc: notice sắp/đến/quá hạn; contract end-check nhưng chưa có kế hoạch; turnover quá hạn/chưa hẹn; quyết toán pending; chờ hoàn/chờ khách trả theo tiền còn mở; hold tới hạn. Work item có responsible và due; tiền chưa có hạn ghi “Chưa hẹn xử lý”, không tự coi quá hạn.

Đề xuất sweep 15 phút, nhắc 08:00 theo timezone org, trước 1 ngày/đến ngày/mỗi ngày quá hạn; cấu hình tần suất/người nhận cần UAT. Không tự tạo automation bên ngoài CRM. Nhánh in-app có SLA riêng; lịch push 07h hiện có không chứng minh được giao thành công. Định nghĩa notification family lifecycle riêng, cập nhật đồng bộ preference/gate/no-recipient validator; **không tái dùng E6 vốn là họ chốt sổ tiền mặt**. Outbox có attempt/lease/delivery; không thêm read_at giả vào schema notifications. Đọc/snooze không resolve source; handover resolve notice nhưng giữ việc tiền.

Post-sync TEST phải bootstrap cron TEST-only vì sync hiện gỡ lịch riêng. Alert lag/run failure/outbox backlog có health evidence; không nuốt lỗi rồi báo green.

### 4.3 Các khu vực phải chuyển cùng slice

| Khu vực source | Thay đổi và rủi ro phải kiểm |
|---|---|
| src/hooks/useContracts.ts, useContractOperations.ts; src/components/contracts/* | Metadata/import adapters, hai nhánh, lifecycle/case status và optimistic versions; không direct protected DML. |
| src/lib/contractLifecycle.ts, contractSettlement.ts, contractSettlementReads.ts, customerCreditRpc.ts | Action-specific eligibility, pending≠paid, exact party/source và lịch sử cuối. |
| src/pages/phong-trong/*, useMyAvailableRooms.ts, usePublicRoomSettings.ts, src/components/sale-phong/* | Facts/token/revision/errors không fallback giả; dọn/sửa vẫn trống. |
| SQL Copilot/Zalo room RPC; src/copilot/*; worker Zalo render/copy/ảnh | Facts parity và scope theo kênh; không tiếp tục phát ngày nhận/cọc sai ở worker cũ. P0 ghi đúng đường file/symbol hiện có. |
| useInvoices.ts, GenerateInvoiceDialog.tsx, useExcelInvoiceData.ts, meter readers/writers | Period+boundary theo lượt; invoice thủ công và first_invoice hiện có, **không có invoice issuer scheduler để sửa/tái dùng**. |
| useDeposits.ts, useDepositDashboard.ts, depositWorkQueue.ts, income-expenses/* | Receipts posted truth/approval/reversal và allocations, queue không đếm phiếu chờ thành nhận tiền. |
| src/components/assets/AssetHandoverDialog.tsx và hooks/assets thật | Handover vào/ra theo draft/check-in/exit case; bỏ cycle chỉ ACTIVE mới chọn được. **src/lib/handover.ts là bàn giao tiền**, không phải module tài sản. |
| useJobs.ts, tick/bonus server, salary-v5, SAD/v5_month_money | TRACKING cấm mọi đường hưởng lương; source link immutable; tick cũ cần đối soát/điều chỉnh, không xóa im lặng. |
| reports/realEstateReports.ts, residence/occupancy readers, customer QR | Không gán mọi TERM là trả sớm; tách dates/initial-current kind. QR tiền theo contract+party capability thu hồi được, không dùng token sale hoặc chỉ bỏ filter TERM. |
| realtime descriptors/keys, permissions, route/action catalogs | Org switch xóa cache/subscription, deny-default permissions, server authority; mọi consumer cũ có compatibility disposition. |

LEGACY_REVIEW bao gồm hồ sơ TERM thiếu case/lineage, hóa đơn approved/overdue còn mở, phòng projection sai, hold 1đ/24h và hợp đồng đã nhượng. Số capture (23 TERM thiếu case, 11 approved + 21 overdue, 1 active/available, 1 hold 1đ) chỉ là mốc kiểm, không target hardcode; thống kê lại lúc backfill. Không tạo lại phiếu/nghĩa vụ khi import hồ sơ cũ.

## 5. Các task thực hiện

Mỗi task: tạo test hành vi đỏ phù hợp → làm thay đổi nhỏ → chạy lại suite/task gates → review diff và evidence → commit có trailer Contract. Không stage tất cả. Các test/paths mới ghi ở đây là **deliverable sẽ tạo**, chưa là lệnh đã chạy. SQL migrations luôn cấp tên qua `scripts/tao-ten-migration.mjs`, không dùng timestamp đoán.

Đồ thị phụ thuộc:

```text
P0 → P1a → P1b → P2/P3 → P4 → P5
                  ├────────────→ P10 (lưu/xuất nháp có thể giao riêng)
P1b + P2/P3/P4 → P6(type bắt buộc, B1 đã chốt) → P7(nghiệp vụ tiền giữ nguyên) → P8
P1a/P1b + P4 → P9
P6 + P9 + P10 → P11a
P11a + G-BILLING + cancellation/consumer parity → P11b (tùy chọn, tắt mặc định)
P7 + P9 + P11a → P9.T (nhượng linked; tiền theo B5/N1 và cơ chế hiện hành)
P12 compatibility/docs và P13 rollout/gates đi cùng từng slice, không đợi cuối dự án.
```

P7 dùng fixture khách B qua core hiện hành đã guard từ P1a/P6, không phụ thuộc fixture chưa có của P9. Khi P9 xong bổ sung đường reservation mới. P4 có adapter nguồn cũ nên không đợi P9; P6 chỉ bật khi projection P4 đã đúng.

### P0 — Catalog, parity và harness có target rõ

**Create:** `scripts/contract-lifecycle/preflight.mjs`, `scripts/tests/contract-lifecycle/helpers.mjs`, `preflight.test.mjs` cùng thư mục tests; evidence manifest theo SHA/run-id. **Modify:** `tooling/test-matrix.json`; target adapters của hai reconcile chỉ sau review phạm vi.

- [ ] Capture signature/body/owner/ACL/search_path, trigger/RLS, permission, flags, cron liên quan. Xuất named writer/caller inventory cho §3.1/§3.4, gồm 14 pinned functions và quyết định supersession. Mỗi dòng có entrypoint → authority → writer/trigger → bảng/cột/nguồn tác động → transaction/khóa → event/chứng từ → disposition/test; kiểm đủ effects theo flow-control-review.
- [ ] Ghi baseline **luồng quyết toán hiện tại** từ UI → wrapper → flags → writer, gồm bỏ cọc/xử lý hóa đơn nợ/credit, thu một phần/đủ, hoàn/duyệt/chi và cấn cọc. FC02 đã trace đường hủy invoice; chủ xác nhận giữ nguyên nên rút kết luận bất nhất nghiệp vụ, không tạo task sửa hủy nợ. Capture build/catalog/flags và replay TEST để chứng minh adapter cho kết quả tiền/chứng từ/quyền như cũ. Vẫn tách physical core để chốt muộn không đổi phòng B. Không hỏi chủ chọn lại B2.
- [ ] Reproduce parity TEST theo approved baseline gồm spend engine 26–27/09; kiểm delta sau migration. Không chỉ so 8 lifecycle hashes. Bootstrap cron TEST sau sync và ghi receipt.
- [ ] Harness từ chối production/default/unknown URL, xác minh TEST project ref trước mutation, deterministic fixture + JWT của manager/accountant/sale/cross-org/revoked role; cleanup theo fixture IDs.
- [ ] Thêm preflight ca đỏ sai target/drift/thiếu fixture/no rows, pagination >1000; reconcile scope adapter là công việc mới, không ghi flags chưa tồn tại là runnable.
- [ ] Chạy `node --test scripts/tests/contract-lifecycle/preflight.test.mjs` sau khi tạo; nonzero nếu unknown/drift. Chốt baseline/evidence để task sau dùng, không nâng cờ feature.

**Ra:** G-CATALOG đủ baseline và inventory; kế hoạch xử lý pinned writers cụ thể, không chỉ “sẽ audit”.

### P1a — Vá cửa ghi và khóa trước khi thêm trạng thái mới

**Modify:** current create/terminate/approve/renew/transfer implementations bằng forward adapters; `src/hooks/useContracts.ts`, `useContractOperations.ts`, `ContractImportExportDialog.tsx`, Copilot handlers; migration-policy/gate chỉ theo approved supersession. **Create:** `scripts/tests/contract-lifecycle/legacy-entrypoints.test.mjs`, `lock-order.test.mjs`.

- [ ] Red: REST-like DRAFT→approve trên TERM và direct protected PATCH/driving-table INSERT bị từ chối; 0 voucher/ledger effects. Cùng suite chứng minh legacy ACTIVE hợp lệ vẫn hoạt động.
- [ ] Đưa write token/entry eligibility/action permissions vào mọi surface. Chuyển direct callers trước/cùng enforcement; audit cuối không bị guard ACTIVE sai chỗ; bỏ catch nuốt lỗi.
- [ ] P1a sở hữu migration tối thiểu private capability/operation/lock primitives cần cho guard; P1b mở rộng domain schema, không là dependency ngược. Dùng lại canonical operations nếu có, không tạo kho idempotency thứ hai.
- [ ] Apply lock protocol toàn component; include trigger/authorizer order, raw pinned writer resolution và period mutex. Test deadlock pair thực qua RPC, không chỉ hai SQL mô phỏng.
- [ ] Giữ kết quả tiền và quyền của luồng hợp lệ hiện hành ở cả guard lẫn P7. Chỉ chặn bypass/ghi trùng/sai subject; không coi audit là phép đổi FORFEIT, refund hay cấn nợ. Review source cùng baseline thực, không chỉ hash.
- [ ] Chạy hai node suites ở trên + baseline lifecycle/credit/reservation hiện có; V36/V37/V40/V41/V46 phải đạt với JWT/transaction thật trên TEST.

**Ra:** Có thể phát hành hotfix riêng qua lane; chưa bật new exit/notice nếu legacy vẫn bypass. Không trình bày việc viết plan là đã vá production.

### P1b — Schema, quyền và typed interfaces

**Create:** migrations cho §2, `src/lib/contract-lifecycle/{types,schemas,errors,rpc}.ts`, `src/lib/contract-lifecycle/__tests__/schemas.test.ts`, `scripts/tests/contract-lifecycle/schema.test.mjs`. **Modify:** permissions/catalog và generated surfaces qua generator.

- [ ] Tạo constraints, indexes/version/capability primitives/idempotency trên canonical operations hiện có; prefix flags theo §7. Không tạo thêm operation store cạnh tranh.
- [ ] **B4:** P0 chụp actor/role/building/action matrix của luồng hợp lệ hiện hành; map notice/moveout/settle/draft/sign/turnover vào authority đang dùng. Không thêm/grant contracts.settle hay thay vai trò duyệt/chi. Trường hợp quyền UI và server lệch phải nêu rõ và đóng bypass, không tự nới quyền để flow chạy. Test allowed/denied parity trước–sau với người hiện tại.
- [ ] RLS riêng financial snapshot/preview/party; scalar scope mọi FK, private storage policy. Negative SELECT/RPC/CROSS_ORG và mixed-building subjects; authorized reads qua HTTP không 25006.
- [ ] Chạy schema tests, Vitest schemas với `--exclude "outputs/**"`, generated types + ACL/view-invoker/STABLE/body-authz gates. Static xanh vẫn chưa đủ G-AUTH.

**Ra:** Schema additive dormant, typed contract thống nhất và permission matrix review được.

### P2 — Báo ngày trả, đổi/hủy và gia hạn

**Create:** `src/lib/contract-lifecycle/notices.ts`, `src/hooks/contracts/useMoveOutNotices.ts`, `src/components/contracts/MoveOutNoticeDialog.tsx`, `scripts/tests/contract-lifecycle/notices.test.mjs`; unit `src/lib/contract-lifecycle/__tests__/notices.test.ts`. **Modify:** RegisterMoveOutDialog/flow cũ, renew/transfer adapters.

- [ ] Red: create/change/cancel/version conflict; no auto-TERM sau ngày; khách chưa báo vẫn vào thẳng trả phòng.
- [ ] Atomic notice+event+revision; renew yêu cầu KEEP/CANCEL, recheck dưới khóa; transfer giải quyết notice phòng cũ explicit, không copy ngày sang phòng mới.
- [ ] Short form ngày+ghi chú, cho đổi/hủy ngay trên danh sách/detail; error conflict yêu cầu refresh, không ghi đè.
- [ ] Chạy notice node/unit suites và V42; snapshot money/occupancy không đổi. Gắn UI vào P4/P5 khi facts/work items sẵn.

### P3 — Dọn/sửa, ngày sẵn sàng và bảo vệ payroll

**Create:** `src/hooks/rooms/useRoomTurnover.ts`, `src/components/rooms/RoomTurnoverPanel.tsx`, `src/lib/contract-lifecycle/turnover.ts`, `scripts/tests/contract-lifecycle/turnover.test.mjs`; unit `src/lib/contract-lifecycle/__tests__/turnover.test.ts`. **Modify:** useJobs, server tick/bonus/completion và salary readers.

- [ ] Red: PENDING/overdue/unknown date vẫn sale vacant; không tạo MAINTENANCE chỉ do turnover; EXIT/TRANSFER/LEGACY source valid và một current item.
- [ ] UI ngày dự kiến/người phụ trách/đánh dấu xong, confirm READY inline ở check-in khi hợp lệ; không bắt biết ngày dọn xong mới cho trả thực tế.
- [ ] TRACKING guard mọi writer tick/award, source classification immutable; thử chuyển cờ sau có tick phải từ chối/đối soát, không clear tick cũ.
- [ ] Chạy turnover node/unit + payroll/SAD/v5_month_money regression đúng runner; snapshot 0 thay đổi lương với tracking-only, paid-job explicit có quy trình duyệt hiện có.

### P4 — Facts chung, public scope và freshness

**Create:** `src/lib/roomSaleFacts.ts`, `src/pages/phong-trong/useAvailabilityRevision.ts`, `src/lib/__tests__/roomSaleFacts.test.ts`, `src/pages/phong-trong/availability.test.tsx`, `scripts/tests/contract-lifecycle/availability.test.mjs`. **Modify:** public/in-app files ở §4.3, SQL room readers, Zalo/Copilot/worker thực trong P0 inventory, realtime descriptors.

- [ ] Red facts priority với bốn nguồn hold/cọc cũ, pass stale, notice overdue và repair vacant; token invalid/empty/error tách biệt; no PII/sample/hotline giả.
- [ ] Verified token mapping preserve URL hợp lệ; unmapped phải blocked review. Public projection allowlist riêng, rate/budget trước poll5s.
- [ ] Metadata counters/cursor commit ordering; tests hai transaction commit đảo thứ tự, source receipt approve/cancel/reversal, scope đổi và mốc ngày không có writes.
- [ ] Chuyển đủ channels hoặc ngừng tính năng channel chưa compatible bằng server guard; không để worker cũ tiếp tục quảng cáo sai. Đăng ký query keys/realtime/org cleanup.
- [ ] Chạy suites trên, hai browser contexts manager/anon đo p95 trong workload ghi rõ; verify scope/5s backoff/ngân sách và worker output. V39/V45/V54.

### P5 — Queue và reminder không lệ thuộc trình duyệt

**Create:** server sweep/outbox drain+TEST bootstrap, `src/hooks/contracts/useLifecycleWorkItems.ts`, `src/components/contracts/LifecycleWorkQueue.tsx`, `src/lib/contract-lifecycle/reminders.ts`, `scripts/tests/contract-lifecycle/reminders.test.mjs`; unit `src/lib/contract-lifecycle/__tests__/reminders.test.ts`. **Modify:** useScheduledNotifications, useNotifications, notificationRoutes, Dashboard.

- [ ] Red: không UI vẫn sinh việc; nhiều tick không duplicate OPEN; revision/phase change không tạo hai việc mở; digest nhiều nguồn/người/ngày.
- [ ] Failure→retry không mắc daily lock; source đổi/quyền bị thu trong lúc drain không gửi tin sai; đúng user UUID. Work queue tồn tại sau read/snooze, hàng “Chưa hẹn” nhìn thấy.
- [ ] Bootstrap TEST cron sau sync, không tự thay prod schedules trong test. Theo dõi sweep lag, outbox retries/delivery/no-recipient và catch-up sau outage; family lifecycle mới phải qua đủ preference/gate/validator, không dùng E6 của chốt sổ.
- [ ] Chạy reminders suites + integration scheduler thật trên TEST không có browser, V48 và timezone/date boundaries; recording attempt/lease evidence, không giả đạt từ unit mock.

### P6 — Trả phòng thực tế, loại ban đầu và mốc đo

**Create:** migration physical core, `src/hooks/contracts/useConfirmMoveOut.ts`, `scripts/tests/contract-lifecycle/moveout.test.mjs`, `meter-boundaries.test.mjs`. **Modify:** contract operations, room status triggers, meter entry/lookup, GenerateInvoiceDialog và useExcelInvoiceData.

- [ ] Red: deferred tạo đúng một case+physical boundary, fulfill notice/tắt pass, vacant dù chưa đủ tiền; money snapshot chứa dữ liệu thật giữ nguyên tuyệt đối. Retry giữ ID; concurrent exit chỉ một thành công.
- [ ] **B1 đã chốt:** thiếu số A vẫn release/sale với MISSING/REVIEW; B chỉ bàn giao khi MOVE_IN riêng verified. Mốc trả A/mốc nhận B riêng; ngày cùng ngày có timestamp/thứ tự rõ. Sửa predecessor theo interval và đo; sửa muộn bị ảnh hưởng invoice phải REVIEW.
- [ ] Money side effect, meter error hoặc event failure trong transaction không được nuốt. Policy DEFERRED không gọi settlement/credit/debt cancellation dù loại là bỏ cọc.
- [ ] Chuẩn bị fixture nhận B bằng guarded current create core: đủ readiness/mốc nhận, cọc/hóa đơn/credit của B khác A. Readiness phủ import/create/transfer, không chỉ nút P11a.
- [ ] Không tự thêm flow hoàn tác ngoài scope. Thử direct reopen/caller cũ sau khi A trả, đặc biệt B đã giữ/nhận: phải từ chối đường không hợp lệ, không sửa case/room/money B; retry đúng intent vẫn ổn định.
- [ ] Chạy hai node suites và legacy-entrypoints/meter/invoice suites đúng test matrix; V38/V50/V53. Mutation cho nhánh deferred thử ghi phiếu phải làm invariant đỏ.

**Ra:** Khách đã đi được ghi nhận riêng tiền; G-AUTH/G-LOCK/G-LEGACY và test B1 đã chốt cần đạt trước bật. Chưa có P7 thì hồ sơ hiện chờ, không đưa nút chốt giả.

### P7 — Nối hồ sơ đã trả với cách quyết toán hiện hành

**Create:** migration core/context CT v2/period mutex, `src/lib/contract-lifecycle/settlement.ts`, `src/hooks/contracts/useExitSettlement.ts`, `src/lib/contract-lifecycle/__tests__/settlement.test.ts`, `scripts/tests/contract-lifecycle/settlement.test.mjs`. **Modify:** các authorized finance wrappers đã inventory, invoice/credit allocation, profit close protocol, TerminateDialog calculation adapter.

- [ ] Tái sử dụng nghiệp vụ tính tiền/ghi chứng từ hiện hành, chỉ tách hoặc bọc phần cần để xử lý đúng case đã trả. Không viết lại policy FORFEIT/refund/duyệt. Chứng minh số tiền, trạng thái hóa đơn, phiếu và quyền trước–sau khớp baseline P0; exact party/source, không tìm khách bằng room.
- [ ] Red preview thay invoice/kind/meter/credit/version/actor/TTL → reject; valid retry cùng key trả cùng result, revoke quyền trước replay → deny. Bind adjustment reason/policy/fee/amount đúng decimal.
- [ ] Preview trước trả nhận ACTIVE_CONTRACT_EXIT_INTENT không tạo case; IMMEDIATE confirm consume đúng intent→case dưới khóa. Test cancel preview không effects và đổi ngày/mốc/turnover sau preview bị reject. Later preview nhận EXIT_CASE, không nhầm hai subject.
- [ ] Cùng nghiệp vụ hiện hành cho later và immediate; không gọi monolith cũ có thể đổi phòng B để xử lý tiền A. Đổi current_kind lưu reason+event, initial_kind bắt buộc từ bước đầu và bất biến; final snapshot immutable. Tiền cọc, hóa đơn nợ, credit và chứng từ của bỏ cọc phải khớp flow cũ, kể cả nhánh hủy nợ hiện hành. Không áp yêu cầu giữ nợ đã rút; phần tách physical không thay kết quả tài chính.
- [ ] Tách service date/accounting date/cash date; mutex cả close tháng và finalize, row tháng absent/account NULL/phiếu chờ đều test. Bổ sung late collections/refunds của TERM không mở lại occupancy.
- [ ] Refund giữ đúng cách tạo/duyệt/chi đang dùng, không nút/quyền/tầng duyệt mới. Engine0 HOLD/DRAW cho TUNG_PHIEU/no category; failure rollback không để ledger/case/IE nửa chừng. So allowed/denied/approval/posted trạng thái theo baseline thực.
- [ ] A finalized sau B snapshot domain B y nguyên; ledger chung có đúng posting A, nguồn không trùng. Immediate failure rollback cả physical+money; deferred alternative là lựa chọn rõ của user.
- [ ] Chạy settlement suite + finance baseline + cả hai reconcile qua target/harness đã đóng ở P0; mutation exact subject/dedup/version/source predicate phải đỏ. Concurrency finalize∥finalize/approve/reversal/freeze.

**Ra:** G-LOCK/G-AUTH/G-LEGACY và finance reconciliation evidence; không tự gọi FINALIZED là “đã chi”.

### P8 — Một form thanh lý, tồn đọng và màn quản lý/kế toán

**Create:** `src/components/contracts/termination/{TerminateFlowDialog,ExitSettlementStep,ExitKindHistory,ExitCaseStatus}.tsx`, `src/hooks/contracts/useExitCases.ts`, unit `src/components/contracts/termination/__tests__/TerminateFlowDialog.test.tsx`, `.e2e-fleet/specs/contract-moveout-deferred.spec.ts`. **Modify:** TerminateDialog adapter, list/detail/reports/deposit queue và asset handover thật.

- [ ] Đầu form luôn ngày thực+loại bắt buộc; hai lựa chọn dễ hiểu. Nhánh sau không validate monetary inputs; nhánh ngay preview/chốt rõ, có loading/retry ổn định. Thiếu thông tin hiển thị “Chờ bổ sung”, không số 0 mặc định.
- [ ] Queue có đã trả/chờ chốt/chờ hoàn/chờ khách trả/hoàn tất/legacy cần kiểm; responsible/due và link đúng hồ sơ. Một dòng tổng hợp/case, mở chi tiết từng nguồn. Chờ hoàn và chờ khách trả có thể cùng hiện; không net để giấu nghĩa vụ riêng hoặc tự cấn. Hoàn tất khi đã chốt và toàn bộ nghĩa vụ còn hiệu lực sau core hiện hành đã xử lý; hóa đơn đã hủy đúng flow không bị treo chờ thu; reversal mở lại việc tương ứng, không sửa snapshot. Dữ liệu tiền lấy ledger+reversal, không summary phòng hiện tại.
- [ ] Báo cáo đủ initial/final kind, physical/final/accounting/cash dates; không gọi mọi TERM là trả sớm. Trong hồ sơ xem được lịch sử trước–sau/lý do/người/thời điểm và mở đúng nguồn cọc/hóa đơn/phiếu/posting theo quyền; lần được liên kết §3.4. Legacy load paginated với lineage cảnh báo, không tự sửa tồn đọng.
- [ ] Asset picker nhận exit case/check-in context để không cần ACTIVE mới có handover; QR tiền party scope/capability expiry+revocation riêng, không mở dữ liệu qua public room token.
- [ ] Chạy unit + E2E TEST manager/accountant/sale, A đi B vào A chốt sau, refresh/timeout/back/duplicate click/mobile; check console và parity cách làm tiền/quyền. V49 kiểm nguồn cọc/hoa hồng theo cơ chế hiện hành và chốt B5/N1, không tự bổ sung policy tiền chưa có.

### P9 — Reservation registry, nguồn cọc và cutover

**Create:** migration registry/receipts, `src/lib/reservationIdentityRpc.ts`, `src/hooks/useRoomReservations.ts`, `scripts/tests/contract-lifecycle/reservations.test.mjs`, `src/lib/__tests__/reservationIdentityRpc.test.ts`. **Modify:** reservationHold.ts, QuickDepositModal.tsx, depositWorkQueue.ts, orphan link/approval triggers và tất cả legacy deposit writers.

- [ ] Red: hai khách giữ cùng phòng chỉ một claim; tiền=0 là giữ chỗ không giả 1đ, tiền chưa rõ không dùng unitPrice=1; mất khóa fail-closed. Identity mismatch/room-only matching bị từ chối.
- [ ] Source receipt allocations stable, top-up/approve/cancel/reversal nguyên tử; timeout không sinh operation key mới. Pending receipt không được cộng thực nhận. Cọc đã nhận không tự hết vì hold 24h.
- [ ] Giữ chỗ thuần cần hạn người dùng xác nhận; tới hạn work item. Auto-release chỉ khi policy và bằng chứng no-money/no-inflight rõ, không suy từ operational TTL.
- [ ] Cutover trong transaction/maintenance slice ngắn có review: khóa nguồn cũ, classify/bridge đủ bốn nguồn, dual-read facts nhưng một write authority; old client gọi raw bị adapter/deny rõ. Không hai registry đồng thời cho nhận cùng phòng.
- [ ] Chạy suite mới + reservationSettlementRpc/reservationSettlementForm/depositWorkQueue hiện có; SQL harness reservation cũ chỉ chạy với fixtures/đích loopback TEST đã xác minh. Concurrency approve∥cancel/sign/expiry và source reassignment.

#### P9.T — Nhượng bằng hai hợp đồng liên kết (B5 đã chốt)

Phụ thuộc P7/P9/P11a; triển khai cùng hoặc sau S5, **không chặn ký nháp thông thường**. N1 đã chốt phí nhượng; N2 yêu cầu map cơ chế cấn/chứng từ hiện hành, không thiết kế policy mới. Đây là phần R13 đã được chủ mô tả.

**Create:** contract_transfer_links + allocation source refs qua migration forward, `src/lib/contract-lifecycle/transfers.ts`, `src/components/contracts/ContractTransferLinkPanel.tsx`, `scripts/tests/contract-lifecycle/contract-transfers.test.mjs`, `.e2e-fleet/specs/contract-transfer-linked.spec.ts`. **Modify:** transfer_contract action/UI/Copilot hiện có để route theo enrollment; old exit/new draft/sign, commission authorized writer, settlement/receipt/deposit queues và reports.

- [ ] Form chọn **tự tìm khách / nhờ môi giới**, khách cũ/khách mới, phương án cọc và hạn hợp đồng. Hai hợp đồng riêng có old_exit_case/new_draft/new_contract link, cờ “Nhượng hợp đồng” trên cả hai, không đổi đại diện của contract cũ thành khách mới. Hợp đồng mới chọn giữ ngày hết hạn cũ hoặc nhập kỳ hạn mới; ngày nhận thực và điều kiện end≥start vẫn validate.
- [ ] Thanh lý/quyết toán cũ dùng đúng P6/P7; ký/nhận mới dùng P11a. Không bắt chốt tiền cũ mới được ký mới nếu khách mới đã có đủ cọc riêng và phòng đủ điều kiện. Tạo link không tự final case, không sinh thu/chi hoặc kéo dài hợp đồng.
- [ ] **SELF_FOUND + NEW_PAYMENT:** cọc cũ hoàn/quyết toán bình thường, cọc mới thu riêng đúng source, không thêm50% môi giới. **SELF_FOUND + OLD_DEPOSIT_OFFSET:** dùng cơ chế cấn/chứng từ đang vận hành, map exact source từ hồ sơ cũ sang mới và số cần bù theo B5; không tự tạo thêm quy tắc chuyển số còn hoàn hay tầng duyệt. Không ghi giả tiền mặt hoặc cùng một khoản vừa đã hoàn vừa được dùng làm cọc; thiếu đường tương thích thì báo rõ, không chọn hộ nghiệp vụ.
- [ ] **BROKER / N1 đã chốt:** khách mới đóng đủ cọc mới. Thêm dòng bắt buộc `TRANSFER_BROKER_FEE = 50% cọc cũ trước khoản thanh lý khác`; ví dụ 4 triệu → phí 2 triệu + phần cọc hoàn 2 triệu, điện/nước/nợ khác giữ cách tính thường. Base/snapshot có source verified; rounding theo money policy hiện có. Không lấy phần còn hoàn sau nợ làm base 50%.
- [ ] Khoản phí trên hồ sơ cũ và phiếu hoa hồng hợp đồng mới có exact link/source identity `transfer_link_id + commission purpose`, reuse authorized commission/chi core với quyền B4; guard commission tự sinh từ ký mới để không tạo phiếu thứ hai. Nếu đã cấn phí từ cọc thì không ghi thêm thu tiền mặt cùng khoản; nếu luồng thường thu/hoàn riêng phải có posting thật và phân bổ một lần. Phần cọc hoàn hiển thị riêng tổng tiền mặt cuối sau các khoản khác; phí đã tính không có nghĩa hoa hồng đã chi. Khi khách mới chưa ký, dự kiến hoa hồng chưa được tự phát sinh/chi như hợp đồng đã thành công.
- [ ] Vì old finalize và new sign có thể khác transaction, persist obligation/commission intent PENDING cùng transfer link và source key trước khi ghi thu/cấn phí; signing hoặc retry worker consume intent một lần qua core hiện có. Đã trừ phí không được mất việc tạo phiếu; new sign replay không nhân phiếu. Khách mới hủy/không ký phải còn hàng đối soát phí và điều chỉnh theo luồng có audit, không tự coi phí đã trả môi giới hay xóa intent.
- [ ] Lock old/new contract + source lots/claim theo protocol; before allocation kiểm remaining/posted/refund pending/reversal dưới khóa. Hoàn hoặc chuyển cùng một phần chỉ thắng một lần. Nếu base/nguồn không đủ hay chuyển chủ tiền chưa được xác nhận, đưa `Cần xử lý tiền nhượng`, không tự âm cọc, tạo thêm tiền, miễn nợ hoặc chuyển sang nhánh khác.
- [ ] Cancel/retry/sign conflict giữ link history, không để orphan reservation/credit/commission; sau có effects dùng adjustment/reversal đúng luồng hiện có. Không rollback liên đới hợp đồng B vì hồ sơ A sửa muộn.
- [ ] Mở rộng V49 thành SELF cash/SELF offset/BROKER, giữ hạn/chọn hạn, A pending+B ký, double-submit, concurrent refund∥offset∥commission, no-money creation from link, insufficient source và permission parity. V55: link nhượng không cấp khách này quyền xem tiền khách kia. Kiểm source allocations + cả hai reconcile, không chỉ tổng thu/chi.

### P10 — Nháp lưu/sửa/tải được độc lập

**Create:** migration drafts/documents, `src/hooks/contracts/useContractDrafts.ts`, `src/lib/contractDraftRpc.ts`, `src/components/contracts/ContractDraftList.tsx`, `src/lib/__tests__/contractDraftRpc.test.ts`, `.e2e-fleet/specs/contract-draft-export.spec.ts`; authorized renderer/storage adapter phù hợp runtime hiện có được P0 xác minh. **Modify:** form mode/footer, PrintContractDialog, contractTemplateEngine và template delete/update path.

- [ ] Red: lưu nháp thiếu trường phục vụ nhập tiếp; export cần đủ trường tài liệu với lỗi trường cụ thể; không hold/number/contract/ledger side effects. Hai người sửa dùng revision conflict.
- [ ] Pin selected template bytes/ID, payload, renderer/options; default template không ghi đè lựa chọn. Update/delete template không phá bản đã gửi; private object không truy cập qua URL public hoặc org khác.
- [ ] Render output “BẢN NHÁP”, immutable version, download có scope/expiry; retry generation không tạo document identity thứ hai cho cùng version. FAILED có retry và diagnostic không PII.
- [ ] Thử DOCX/print bytes thật (không chỉ mock download), ký từ đúng selected revision/artifact, đổi nháp khiến bản cũ không đủ confirm.
- [ ] Chạy unit + storage/JWT tests + E2E export. Có thể giao phase lưu/xuất trước P11a, UI không lộ nút ký chưa hoạt động; không đổi toàn hệ thống sang R2 chỉ để giao nháp.

### P11a — Xác nhận đã ký và nhận phòng ngay từ nháp

**Create:** migration sign_and_checkin core, `src/hooks/contracts/useContractSigning.ts`, `src/components/contracts/ConfirmContractSigningDialog.tsx`, `scripts/tests/contract-lifecycle/signing-now.test.mjs`, `.e2e-fleet/specs/contract-sign-checkin.spec.ts`. **Modify:** create V2 adapter/number allocator/all new-number writers, asset/meter check-in integration.

- [ ] Red: đúng revision+artifact+party/claim tạo một ACTIVE contract; sign∥sign/create/reservation không trùng. Nháp không claim vẫn phải kiểm phòng còn nhận được ở lúc ký.
- [ ] Check-in xác nhận ngày, readiness và MOVE_IN; dùng official core tạo hợp đồng/first_invoice hiện hành theo policy, chuyển cọc bằng đúng source allocation, không thu lần hai. Số mới atomic duy nhất dù lịch sử có duplicate.
- [ ] Atomic draft SIGNED + unique converted_contract_id, reservation CONVERTED + exact contract link/receipts, claim LIVE → CONSUMED + occupancy ACTIVE. Không giữ next claim sống trỏ về người đã nhận; historical claim vẫn truy nguyên được. Không có reservation vẫn kiểm blockers và occupancy dưới khóa trước tạo.
- [ ] Không tạo SIGNED_WAITING hoặc chờ G-BILLING cho nhánh này. “Xác nhận đã ký” là ghi nhận nghiệp vụ, không tuyên bố đã cung cấp chữ ký số pháp lý.
- [ ] Persist terms+template hash+contract number một transaction; official artifact sau commit retry cùng record. Nếu render hỏng vẫn hiển thị hợp đồng đã ký + “Tạo lại bản tải”, không cho ký lại để lấy file.
- [ ] Chạy signing-now node suite + E2E TEST + asset/meter/credit/create regressions; V47/V51. Public facts đổi ≤ mục tiêu đã đo, source ledger chỉ một lần.

### P11b — Ký trước ngày nhận, mở riêng sau khi chốt billing

**Create:** additive enum/constraints và RPC future sign/activate/cancel/finalize-cancellation, `scripts/tests/contract-lifecycle/signing-future.test.mjs`. **Modify:** status consumers theo action matrix, invoice UI/server eligibility, reminders/claims/cancellation queue.

- [ ] G-BILLING phải quyết định quyền lập thủ công/first invoice cho SIGNED_WAITING, ngày bắt đầu tính tiền theo hợp đồng, dời nhận/no-show/hủy và hoa hồng. Không tự đổi billing_start thành actual receive, không tự xây billing cron.
- [ ] Signed-waiting giữ claim, chưa occupied/residence; activation có meter/readiness/date và idempotency. Cancel giải phóng đúng claim, xử lý cọc qua source riêng, không giả exit hoặc tạo turnover thứ hai.
- [ ] Financial cancellation có party/source preview/snapshot/approval như P7 nhưng subject cancellation; giữ turnover phòng thật đang có. Late cancellation money không ảnh hưởng khách kế tiếp.
- [ ] Chạy future suite + toàn consumer compatibility/E2E/calendar/manual invoice tests, mới bật flag riêng. Chưa đạt thì P11a vẫn hoạt động.

### P12 — Compatibility, quyền, docs và những nơi dễ bỏ sót

**Modify:** toàn consumer thực ảnh hưởng ở §4.3 và P0 inventory, action/tool registry, realtime/surface/permission artifacts bằng generator. **Create:** `scripts/tests/contract-lifecycle/compatibility.test.mjs`.

- [ ] Mỗi consumer có disposition migrated/legacy-adapter/disabled và test; grep enum hoặc “không tìm thấy caller” không đủ chứng minh runtime an toàn.
- [ ] Kế toán/thu chi/cọc/hóa đơn/meter/assets/reports/residence/salary/QR/worker đồng nhất subject và pending; permissions thật và UI visibility đồng bộ, pure read authorizer không khóa.
- [ ] Cập nhật docs nghiệp vụ các chương **04/05/06/07/11/13/15/16/17/20/21** cùng manifest/corpus khi đúng slice lên; document mới không nói tính năng chưa bật đã có. P0 tìm filename hiện có, không tạo chương trùng tên.
- [ ] Chạy compatibility tests + typecheck/build/lint phạm vi/gates risk-map và docs checker; baseline docs lỗi cũ ghi riêng, không che lỗi mới. Không gọi src/lib/handover.ts là asset module.

### P13 — Backfill, rollout, rollback và UAT theo slice

**Create:** `scripts/contract-lifecycle/backfill.mjs`, `scripts/tests/contract-lifecycle/backfill.test.mjs`, `.e2e-fleet/specs/contract-lifecycle-acceptance.spec.ts`, run manifest/rollback receipt. **Modify:** feature flags namespaced trong §7 và migrations task đã review.

- [ ] Dry-run phân nhóm deterministic: case đủ lineage, legacy chưa rõ, token scope chắc/chưa chắc, pass cần xác nhận, claim cọc/hold, duplicate contract numbers, missing meter/readiness. Row counts/checksum trước/sau, restart/checkpoint/idempotency; không suy snapshot tiền từ room hiện tại.
- [ ] Không renumber lịch sử hoặc phát lại nghĩa vụ/phiếu. Legacy terminated missing-case import là review record giữ source ref, không invoke settlement core. Số audit là đối chiếu chênh lệch có lý do, không ép backfill ra đúng số cũ.
- [ ] Seed TEST storage bytes dùng fixture không PII vì TEST sync không copy files; parity cron/ACL/functions theo baseline+expected delta, không chạy green do thiếu dữ liệu.
- [ ] Bật từng slice theo §7, mixed old/new client và org; ghi actor/SHA/catalog/provenance trước/sau qua lane. Review/draft PR cho money/auth/schema.
- [ ] Rollback tắt entry mới nhưng giữ guards/readers và xử lý nghĩa vụ đã tạo; app cũ không được tự thao tác legacy trên case v2. Schema additive không down-drop; queue pending vẫn xem/chốt/thu/chi bằng bản compatible.
- [ ] UAT chủ+quản lý+kế toán: đủ R01–R13 trong phòng TEST, tiền source và thời gian sale được đo, B1–B5/N1/N2 áp đúng nơi liên quan. Release record nêu gate chưa đạt, không promote khi missing evidence.

## 6. Hợp đồng kiểm thử và lệnh kiểm chứng

[Ma trận V01–V55](../../audits/2026-09-27-contract-lifecycle/revision-v2/verification-matrix.md) là đặc tả test, **tất cả PLANNED**, không là kết quả chạy. Nghiệp vụ chính đã chốt: loại bắt buộc bước đầu, tiền giữ nguyên; không còn NOT_READY do yêu cầu chủ chọn lại B2/B3/N2. Baseline call path/parity chưa chứng minh vẫn là gate kỹ thuật chưa đạt; P11b giữ G-BILLING riêng. Không tùy tiện skip rồi báo toàn bộ pass.

Harness mới phải cung cấp: `withScenario`, `rpcAs`, `operation`, `snapshotMoney`, `snapshotContractDomain`, `captureMoveOutBoundary`, `captureMoveInBoundary`, `confirmDeferred`, `createNextOccupantViaGuardedExistingCore`, `previewExit`, `finalizeExit`, `withConcurrent`, `assertSourceOwnership`, `reconcileFixture`. Đây là API **sẽ tạo**; không dán pseudo-test gọi helper chưa tồn tại vào CI rồi coi runnable.

Fixture tối thiểu: hai org, hai tòa, manager/accountant/sale/revoked JWT, hợp đồng A có receipt/ledger/debt/credit thật và ít nhất một invoice DRAFT không eligible; B có nguồn tiền khác. Assert dữ liệu không rỗng trước snapshot. Ví dụ A ra chỉ số 1000, dọn/sửa dùng 12, B nhận 1012: A chốt sau không sửa boundary/tiền của B, khoảng 12 không tự đưa vào A/B. Tạo B sau READY bằng core guarded; không dùng fixture P9 chưa tồn tại ở P7.

Snapshot B gồm contract/party, deposit receipt/allocation, invoice/item/payment, credit và boundary; không so nguyên tổng sổ chung vì A được phép có giao dịch mới. Negative legacy test cần cả direct INSERT-denied và preexisting DRAFT→approve-denied; không để “insert bị chặn nên chưa test approve” thành bằng chứng hai cửa đều kín.

Mutation bắt buộc: bỏ exact subject/source predicate; bỏ preview/version/dedup; cho draft gọi writer chính thức; cho deferred ghi tiền; bỏ org/financial permission; bỏ source-state recheck outbox; dùng MAX(seq) khiến late commit miss; bỏ period mutex; TRACKING tạo tick. Chạy trên code/DB disposable, ghi hash và assertion đỏ cụ thể, luôn restore; mutation không kích hoạt effect không chứng minh invariant.

Các lệnh hiện có cần chọn theo risk-map/test-matrix; dưới đây là checklist tham chiếu, **không phải đã chạy trong lần sửa plan**:

```powershell
npx vitest run <cac-file-test-lien-quan> --exclude "outputs/**"
node --test scripts/tests/contract-lifecycle/<suite>.test.mjs
npm run typecheck:baseline
npm run gen:types
npm run types:normalize
npm run types:check
npm run gate:view-invoker
npm run gate:stable-fn-locks
npm run gate:definer-acl
npm run gate:definer-body-authz
npm run gate:permission-catalog
npm run gate:migration-provenance
npm run gate:migration-idempotent
npm run gate:ledger-frozen
npm run gate:money-table-dml
npm run gate:approver-provenance
npm run gate:reconcile-money
npm run gate:reconcile-money-v2
npm run docs:check:links
```

Placeholder paths phải thay bằng files đã tạo; không chạy nguyên khối. Hai reconcile hiện có default/scope hạn chế đã nêu IA-32: P0 thiết kế explicit TEST/fixture adapters và exit semantics, kiểm >1000/no rows/wrong target; giữ cả hai yêu cầu release ở đích đúng, không tự bỏ vì khó chạy. Reconcile v2 thiếu schema thực tế có thể exit **3**, không coi là pass. Static body auth.uid() chỉ là lint, không chứng minh quyền action.

E2E chạy trong `.e2e-fleet/` bằng `npx playwright test specs/<file>.spec.ts`, headless, TEST URL/ref và TEST credentials explicit; default config có production phải reject ở preflight. Không sửa mật khẩu/log secret vào evidence. Chỉ gọi đúng suites đã tạo và đăng ký, kiểm browser console. Build/bundle khi implementation thay UI/runtime; docs-only revision không cần chạy toàn app.

## 7. Gate phát hành và trình tự bật

| Gate | Điều kiện đóng có chứng cứ |
|---|---|
| G-CATALOG | Baseline relevant TEST/prod parity + delta reviewed, exact functions/ACL/flags/triggers/spend/cron, target safety, named writer inventory. |
| G-LOCK | Protocol toàn component và raw surfaces còn callable; period mutex cả hai phía; pinned supersession/ngoại lệ đã review + concurrency+retry evidence. |
| G-AUTH | Real JWT positive/negative/cross-org/cross-building/revoked replay; financial RLS/storage/QR/capability theo slice; mapping và parity quyền hiện hành theo B4 đã chốt, không tự thêm grant hoặc bớt quyền tiền. |
| G-BILLING | **Chỉ chặn P11b**: policy waiting/no-show/cancel/manual billing và consumer tests; không tự xây scheduler hoặc đổi billing date. |
| G-LEGACY | REST/raw/driving table/Copilot/old-client đóng bypass; adapter positive, money source exact, số lịch sử/party/hold/backfill có lineage. |
| G-CRON | TEST parity/bootstrap, hoạt động không UI, catch-up/retry, one OPEN, digest người/ngày, stale source/role, lag/delivery measured. |
| G-PUBLIC | Token scope verified, allowlist, tất cả channels facts đúng, repair vẫn vacant, revision commit-order/date correctness, p95/load/budget/error tests. |
| G-ACCEPT | R01–R13 theo slice, B1–B5/N1/N2 áp đúng nơi cần, required checks/reconcile/mutations/E2E/review và rollback rehearsal đủ. |

Trình tự tối ưu để giao sớm nhưng không bỏ cổng an toàn:

| Slice | Giao gì | Điều kiện / flag |
|---|---|---|
| S0 | P0/P1a đóng lỗi legacy, direct updates và lock surfaces | Review hotfix riêng; không đổi policy tiền âm thầm. |
| S1 | Notice + turnover + facts + queue, adapter cọc hiện hành | G-CATALOG/AUTH/LOCK/LEGACY/PUBLIC/CRON; `room.sale_facts.v1`, `room.lifecycle.reminders.v1`. |
| S2 | Nháp lưu/sửa/tải | G-AUTH/storage/zero-effects; `contract.drafts.v1`. Có thể song song phần S1 sau P1b. |
| S3 | Trả thực tế + pending case + quyết toán và UI | B1–B4, G-LOCK/LEGACY/AUTH/finance/G-ACCEPT; `contract.lifecycle.exit.v1`. Nếu chỉ P6 xong, enable phải có hàng chờ/đường hỗ trợ rõ, không bỏ case mồ côi. |
| S4 | Registry giữ chỗ/cọc và cutover tất cả cửa | G-LEGACY/LOCK/AUTH/PUBLIC + receipt parity; `reservation.identity.v1`. |
| S5 | Ký nháp và nhận ngay | S2/S3/S4 cần interfaces tương thích, meter/readiness/number/claim/source tests; flag `contract.sign_now.v1`. |
| S5.T | Nhượng hai hợp đồng linked theo B5/P9.T | Cùng hoặc sau S5; N1/N2 cho đúng nhánh tiền, B4 giữ quyền; source reconciliation/commission dedup; flag `contract.transfer_linked.v1`. Không chặn S5 thông thường. |
| S6 | Ký trước nhận | Tùy chọn; G-BILLING + cancellation/consumer toàn bộ; `contract.signed_waiting.v1` tắt mặc định. |

Flag phải kiểm ở server; client ẩn nút không đủ. Tắt flag không cho gọi legacy bypass lên hồ sơ v2. Mỗi flag có owner, kill-switch, supported reader version và playbook rollback, không chỉ boolean chung.

## 8. Điều kiện kết thúc và phần chưa xác minh

Plan V2 chỉ được coi **đủ để bắt đầu task** khi review không còn lỗi thiết kế chặn task đó. Không hỏi lại lựa chọn tài chính: B2 đã rõ, B3/N2 giữ cơ chế hiện tại. Phần chưa xác minh là call path/parity/runtime, không phải quyền tự đổi policy. P11b ký trước nhận vẫn có G-BILLING riêng, không chặn mục tiêu ban đầu lưu nháp/ký nhận ngay/trả trước quyết toán sau.

Lần sửa này không ghi DB, không đổi app/migration, không chạy lại JWT/concurrency/reconcile/E2E CRM. Các probe/catalog là evidence của reviewer tại thời điểm chụp. Runtime gates ở §7 vẫn mở; không gọi 35 finding là đã sửa trên sản phẩm. Full docs checker có lỗi cũ ngoài phạm vi, kết quả chính xác và HTML QA được ghi riêng trong verification-summary.md.

Khi user trả lời phần còn mở, cập nhật decisions.md, dòng task/test phụ thuộc và policy expected results trong cùng thay đổi; giữ lịch sử câu trả lời. Không để agent thi hành phải đoán lựa chọn tiền/quyền từ phương án “đề xuất”.
