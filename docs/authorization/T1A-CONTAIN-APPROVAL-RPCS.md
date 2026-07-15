# T1a — Contain exposed approval RPCs

> Trạng thái: `IN_DESIGN`  
> Production apply: `BLOCKED` cho đến khi recovery set `VERIFIED`, restore test pass và owner duyệt exact hash/window.

## Mục tiêu

Đóng quyền gọi trực tiếp prototype approval engine đang được grant cho client, không drop bảng/data và không re-grant contract cũ khi phát hiện hidden caller.

## Trước và sau

| | Trước T1a | Sau T1a |
|---|---|---|
| `submit_financial_voucher(uuid,text,text,text)` | `authenticated` có thể gọi; submit chỉ kiểm membership và tin classification từ client. | `PUBLIC`, `anon`, `authenticated` không có `EXECUTE`; không có client wrapper thay thế trong T1a. |
| `decide_financial_voucher(uuid,text,text,bigint)` | `authenticated` có thể gọi prototype contract chưa đủ exact permission/snapshot/audit/idempotency. | `PUBLIC`, `anon`, `authenticated` không có `EXECUTE`. |
| `_eval_approval_rule`, `_post_financial_voucher` | Helper cần được xác minh exact signature/ACL/search path. | Helper/implementation không client-callable; giữ quyền internal owner path cần thiết. |
| Dữ liệu approval | Giữ nguyên. | Giữ nguyên; không drop/truncate/rewrite history. |
| Hidden caller | Có thể đang phụ thuộc RPC prototype. | Forward-fix caller/contract; không mở lại prototype để chữa availability. |

Ảnh hưởng nghiệp vụ dự kiến: UI hiện không được phép bắt đầu dùng prototype approval contract. Luồng legacy đang chạy không bị thay thế trong T1a; nếu telemetry cho thấy caller production thật, tranche dừng và caller được sửa theo contract đích.

## Dependency và gate

- T0a recovery certification: `BLOCKED`.
- Refresh live exact signatures/owner/search path/grants: bắt buộc ngay trước prepare/apply.
- Usage/caller inventory từ PostgREST/DB logs và code: bắt buộc.
- Restore project direct tests: bắt buộc.
- Exact migration SHA-256 + maintenance window + owner gate: chưa có.

## SQL intent — chưa phải migration được duyệt

SQL production phải dùng exact identity signatures lấy từ live catalog, theo mẫu:

```sql
begin;

revoke execute on function public.submit_financial_voucher(uuid, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.decide_financial_voucher(uuid, text, text, bigint)
  from public, anon, authenticated;

-- Helper signatures được thêm sau khi refresh live catalog; không dùng tên trần.

commit;
```

Không đặt SQL này vào `supabase/migrations/` trước khi restore test/review và recovery gate đạt.

## Acceptance

1. `has_function_privilege` false cho `PUBLIC`, `anon`, `authenticated` trên từng exact signature.
2. Direct PostgREST/RPC JWT client bị deny và không tạo side effect.
3. Internal trigger/function path cần thiết vẫn chạy trên restore project.
4. Bảng/request/decision/audit cũ không đổi count/hash ngoài traffic hợp lệ được giải thích.
5. Reconciliation tiền delta = 0.
6. Browser production smoke cho các flow hiện hữu không có regression/console error.
7. Theo dõi hidden caller/RPC errors tối thiểu một ngày làm việc trước khi `VERIFIED`.

## Abort/forward fix

- Abort nếu có money drift, hidden caller quan trọng, unexpected internal deny hoặc telemetry mất.
- Nếu đã revoke và caller thật lỗi, freeze flow liên quan và forward-fix caller; chỉ rollback grant khi owner duyệt một contract an toàn thay thế, không tự re-grant prototype.
