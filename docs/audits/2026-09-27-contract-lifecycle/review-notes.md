# Rà chéo nội bộ và quy ước bản bàn giao

Ngày 27/09/2026, source base `e498f10d49f3548e72074095c955371d0cee41ab`.
Đây là kiểm tra tài liệu trước khi giao agent khác, **không thay audit độc lập để thực thi**.

## Những chỗ đã bổ sung sau rà chéo

| Nhóm phát hiện | Thay đổi trong master | Cần kiểm lại khi thực hiện |
|---|---|---|
| Case chỉ giữ IDs, không tái dựng số đã chốt | Thêm mode, final_snapshot bất biến, actor/time/accounting_on | constraints, final/reversal reader, source allocations |
| Preview token chưa bind actor/intent/expiry | Private preview store, bind scope/subject/mode/facts/policy, TTL và consume/replay | JWT/expiry/spoof/race, no privilege reuse |
| Flag OFF có thể mở legacy cho case mới | Routing theo object version trước enrollment flag | old client/Copilot/direct DML/rollback |
| Trả tháng trước, chốt kỳ sau | Phân biệt cutoff cư trú, quyết định chốt và ngày ghi sổ | locked periods, reversal, late invoice |
| Ca A→B chỉ kiểm phòng/status | B fixture có tiền/cọc/credit/claim/meter; fingerprint toàn domain | helpers phải assert fixture không rỗng |
| Chưa cụ thể spend engine | B0 không bao gồm refund, HOLD/DRAW/error checks | admission/type/custody/quyền thực |
| Mutation có thể xanh do không tạo tác động | Mutation phải đưa effect tiền vào deferred path | red đúng invariant, khôi phục hash |
| Next claim thiếu constraint dùng chung | Một registry live unique room; mọi writer/cutover chung | chọn physical migration ở G-LOCK/G-LEGACY |
| Hash giấy chưa bảo toàn dữ liệu nguồn | Pin immutable payload, template bytes/version, renderer/options | signed content, render/file retry/private access |
| Signed chưa nhận không có đường hủy | Cancellation case + endpoints riêng, không fake moveout | invoice/cọc pending sau huỷ, khách kế không đổi |
| Cọc pending duyệt sau hết hạn/hủy | Pending-review giữ claim; approve/cancel/expiry dùng lock/state guard | late posting không tái chiếm room B |
| Top-up giữa ký và invoice FIRST_INVOICE | Issuer recompute thiếu cọc dưới lock, unique obligation | top-up/issue/activation race |
| Probe bỏ qua hạn giữa ngày | nextTransitionAt/serverNow, scopeEpoch | cron tắt/client clock lệch/token scope đổi |
| Sweep không thấy source đã đóng | RPC close/supersede; sweep cả work item mồ côi/stale | một phase OPEN, READ/snooze không resolve |
| Job tracking có thể bị bật lại vào lương | Server classification guard; không đổi job trả công hiện có | generic patch, completion/reopen, salary snapshot |
| Order occupancy làm mất pass đang có khách | D08 giữ pass hợp lệ nhưng claim thắng và không dùng lịch cũ | pass ACTIVE, hold, quá hạn, public allowlist |
| Public giữ mọi trường cũ có thể lộ dữ liệu | Contact allowlist, opaque scope epoch | raw REST, contact_manager, revoke/cache |
| Outbox bị cũ sau enqueue | Dispatcher recheck source revision/membership trước gửi | enqueue→cancel/revise/revoke→drain |
| Preview hủy ký chưa có subject riêng | Union EXIT/SIGNED_CANCELLATION, CHECK references, token binding | đổi chéo token phải bị từ chối |
| Cutover hold cũ có thể bypass NULL hoặc kẹt EXCLUDE 24h | Atomic mapping status/claim_state, NOT NULL/UNIQUE và adapter legacy | mixed writers ở từng checkpoint |
| Tiền integer làm mất phần lẻ hiện hữu | Decimal string scale ≤2 theo core hiện tại | rounding/allocation/reversal có phần lẻ |
| Job flag không bao phủ V5 attendance và bonus RPC | Guard v5_tick_from_job + award_job_bonus + completion UI | TRACKING không tạo attendance JOB/SALARY_BONUS |
| Contract chưa có version cho API mới | lifecycle_version + CAS subject mapping | legacy mutation bump, stale after room/date/status change |

Các hàng trên là **đã sửa đặc tả**, không phải xác nhận test runtime đã đạt. Bản master vẫn giữ các G-* mở ở nơi cần catalog/TEST/quyết định nghiệp vụ.

## Tên chuẩn của thiết kế

Master §3–4 là nguồn tên chuẩn. Trong các báo cáo điều tra còn gặp tên nghiên cứu tương ứng:

| Tên nghiên cứu | Tên master / cách hiểu |
|---|---|
| handover_date, original_type, current_type, SETTLED | actual_move_out_on, initial_kind, current_kind, FINALIZED |
| contract_exit_events, notice_events | contract_lifecycle_events; typed event theo entity |
| preview_contract_exit_v1 | preview_contract_exit_settlement_v1 |
| confirm_contract_exit_v1 | confirm_contract_moveout_v1 |
| finalize_contract_exit_v1 | finalize_contract_exit_settlement_v1 |
| read_contract_exit_cases_v1 | get_contract_exit_cases_v1 |
| expected_date, state ACTIVE/DEPARTED của notice | expected_on, status OPEN/FULFILLED |
| available_from, availability_confidence | estimated_ready_on/arrival_status của public DTO |
| get_public_availability_version | get_available_rooms_revision_v1 |
| lifecycle_reminder_deliveries | transactional notification outbox của lifecycle_work_items |
| operational_job_links | room_turnover_jobs cho việc dọn/sửa; notice dùng persisted work items |

Không triển khai thêm bảng/RPC chỉ vì báo cáo domain dùng tên khác. Cùng nguyên tắc với lock order: các mẫu là giả thuyết; **chỉ một order đã chứng minh ở G-LOCK** được đưa vào writers thực tế.

## Giới hạn bằng chứng

- Đã đọc source theo base, rà callsites/triggers/consumers liên quan, chạy baseline Vitest và kiểm tài liệu.
- Chưa đọc live catalog, chưa kiểm số dư database hay deployed flags/cron/publication; migration text có thể khác body đang chạy.
- Các test mới V01–V35, schema mới, RPC mới, E2E mới là nội dung của plan, chưa tồn tại như tính năng đã kiểm.
- Source snapshot lấy từ Git blob; không dùng file migration newline-dirty trong working tree.
- Không triển khai hoặc ghi dữ liệu sản phẩm trong lần lập plan này.
