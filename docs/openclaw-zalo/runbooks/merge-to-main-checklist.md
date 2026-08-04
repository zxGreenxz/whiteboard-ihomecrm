# Đưa nhánh OpenClaw về main — trạng thái và điều kiện

Cập nhật: 2026-08-03. Nhánh: `codex/openclaw-integration-trial`.

## Vì sao CHƯA push lên main

`main` deploy thẳng ra production qua Vercel, nên push = deploy. Ba dữ kiện đo được:

1. Route `/openclaw-zalo` trong `src/App.tsx` **trước đây không có cờ build-time**,
   chỉ gác bằng quyền server `openclaw_zalo.view`.
2. Quyền đó **đã được cấp** cho role chủ sở hữu ở cả ba tổ chức, gồm tổ chức thật
   `iHome CRM` (2026-08-03).
3. Plan còn ghi Task 26/28/29 **chưa xong**; chưa kịch bản e2e nào chạy; chưa tài
   khoản Zalo nào kết nối.

Nghĩa là merge sẽ đưa buồng lái chưa hoàn thiện ra trước mặt chủ nhà thật ngay
sáng hôm sau. Án lệ 2026-07-22: một lần push nhầm lên main đã phải rollback
production (`7b33f85` gỡ `05dce6e`).

## Đã sửa (không còn là lý do chặn)

| Việc | Trạng thái |
| --- | --- |
| Cờ build-time `OPENCLAW_RUNTIME_ENABLED`, mặc định TẮT, `demo` bị từ chối trong bản production | xong (`cdbad39`) |
| Containment sandbox cho 79 bảng OpenClaw trên production | xong — 0/79 → 79/79, 225 bảng khác không đổi |
| Ledger migration + gate `--schema-drift` | PASS ở `c241b9e` |

Về containment: migration `20260801020000` liệt kê bảng **động lúc chạy**, mà
`20260727*` (openclaw) chạy trước `20260801*`. Nên trên database mới nó tự phủ
openclaw; lỗ hổng chỉ có ở production vì 12 file openclaw được apply ngoài luồng
*sau* khi migration kia đã chạy. Đã chạy lại đúng khối DO đó trên production.

Lưu ý phạm vi thật: chỉ **1 bảng** openclaw có grant SELECT cho `authenticated`
(`openclaw_capacity_controls`); 29 policy `_authenticated_view_select` còn lại nằm
trên bảng mà `authenticated` không có quyền bảng nên vô hiệu. Và cả 79 bảng đang
**0 dòng**. Nên đây là bịt lỗ trước khi có dữ liệu, không phải vá rò rỉ đang chảy.

## Trạng thái phân kỳ

```
nhánh đi trước origin/main: 178 commit
origin/main đi trước:       212 commit
điểm chung:                 22a85f7 (2026-07-28)
file cả hai bên cùng sửa:   15
```

Phân kỳ **có trước** phiên 2026-08-03: ngay trước commit đầu của phiên, nhánh đã
161 trước / 212 sau.

## Vì sao merge chứ không rebase

- Rebase viết lại toàn bộ 178 SHA. Tài liệu `production-ledger-state.md` **và**
  bản ghi trong database production đều trỏ đúng SHA `c241b9e`; rebase làm chúng
  thành tham chiếu mồ côi, phải ghi lại attestation vào prod.
- Nhánh đã chứa merge commit sẵn; rebase phẳng sẽ dựng lại các xung đột đã giải.
- `types.ts` bị cả hai bên sinh lại — rebase bắt giải file ~32k dòng nhiều lần,
  merge chỉ một lần.

## Ba file cần người quyết, không giải cơ học được

1. `scripts/gen-supabase-types.mjs` và test của nó — hai bản viết lại độc lập từ
   cùng một script gốc.
2. `scripts/deploy-edge-fn.mjs` — phải xuất **hợp** các symbol của cả hai bên, và
   có **va tên `deployEdgeFunction`** với hai chữ ký khác nhau (ghép thô sẽ
   `Duplicate export`).
3. Chính sách `verify_jwt` **mâu thuẫn**: main *throw* khi truyền `--no-verify-jwt`
   cho slug ngoài network-center-worker; nhánh đặt `verifyJwt:false` cho 2 slug
   openclaw. Đây là **ranh giới xác thực** — phải là quyết định có chủ đích của
   người, không phải kết quả của một lần resolve conflict.

## Điều kiện còn lại trước khi PR vào main

- [ ] Merge `origin/main` vào nhánh, giải 15 file (3 file trên cần người)
- [ ] Gỡ mọi lời gọi `set_cashbook_shared_users_v1` / `is_account_shared_with_me`
      — main đã DROP khỏi database ngày 2026-08-02
- [ ] Task 26 Step 3–4 và Task 28 soak (đang chặn: máy không có Docker/WSL)
- [ ] Task 2 gate xanh
- [ ] E2E fleet chạy trên org DEMO, không console error

## Bẫy thời gian

`main` chạy khoảng 200 commit mỗi hai tuần, và `types.ts` chứa partition theo ngày
(`network_*_samples_2026xxxx`), nên **xung đột tự mọc lại mỗi ngày**. Công giải
conflict hôm nay mất giá trị sau một tuần. Nếu quyết định merge thì nên làm liền
mạch, đừng để PR treo.
