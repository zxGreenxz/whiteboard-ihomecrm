# Bộ máy rollout OpenClaw — chuỗi đã chứng minh và các giới hạn

Cập nhật: 2026-08-05. Mọi con số dưới đây **đo trên PostgreSQL 17.6 nạp schema
production** (`scripts/openclaw-local-stack.mjs`), không suy ra từ đọc mã.

Tài liệu này tồn tại để người sau **không phải đo lại**. Tôi đã mất nhiều vòng
cho những thứ mà một dòng ghi chú đã đủ tránh.

---

## 1. Chuỗi tới `WAITING_OWNER_QR` — ĐÃ CHẠY THÔNG

```
1. ghi openclaw_rollout_runs                      stage=FOUNDATION,      ver=1
2. tiến giai đoạn                                 stage=INFRASTRUCTURE,  ver=2
3. dựng cell:
     insert openclaw_accounts
     insert openclaw_runtime_cells                state=PROVISIONING
     insert openclaw_runtime_credentials
     insert openclaw_runtime_leases
     update openclaw_runtime_cells                state=READY      ← bước CUỐI
4. tiến giai đoạn                                 stage=WAITING_OWNER_QR, ver=3
```

**Thứ tự là hợp đồng, không phải sở thích.** Hai ràng buộc bắt buộc:

- Cell phải tạo ở `PROVISIONING` rồi mới lật `READY`. Tạo thẳng `READY` sẽ trúng
  `current artifact cell credential lease fence matrix is incomplete`, và thông
  điệp đó **không hề gợi ý** nguyên nhân là thứ tự.
- Phải dựng xong cell **trước** khi tiến vào `WAITING_OWNER_QR`. Tiến trước rồi
  dựng sau sẽ chết ở đúng bước cuối, sau khi đã ghi vào production.

> **Một phân tích tĩnh dài từng kết luận đây là bế tắc không gỡ được** — trích
> đúng số dòng, lập luận chặt, và sai. Chi phí để biết: một transaction rollback.
> Xem `scripts/__tests__/production-openclaw-smoke.test.mjs`.

---

## 2. Luật chuyển giai đoạn — đo từng ca

| Thao tác | Kết quả |
| --- | --- |
| Tiến đúng MỘT bước, `stage_version` +1 | qua |
| Nhảy cóc hai bước | `invalid rollout stage transition` |
| Lùi một bước | `invalid rollout stage transition` |
| `stage_version` không tăng | `invalid rollout stage transition` |
| `stage_version` tăng 2 | `invalid rollout stage transition` |
| Đứng yên, chỉ tăng version | `stage_version cannot change without a stage transition` |

11 giai đoạn, đúng thứ tự: `FOUNDATION → INFRASTRUCTURE → WAITING_OWNER_QR →
CONNECTION → SHADOW → WAITING_OWNER_INBOUND → LIMITED_OBSERVING →
LIMITED_VERIFIED → PROACTIVE → SALES_GROUPS → COMPLETE`.

**CAS phải gồm cả `status`**, không chỉ `stage_version`: thiếu version thì hai
tiến trình cùng tiến một bước mà không ai biết; thiếu status thì tiến được cả một
run ai đó vừa cố ý `PAUSED`.

---

## 3. Băm manifest — thuật toán chính xác

```
sha256( "ihome-openclaw-migration-manifest-v1" ‖ 0x00 ‖ Σ "tên:digest\n" )
```

theo đúng thứ tự 12 file, và **chỉ 12 file đó**. Các khoá khác trong
`artifact_digests` (`cellImageDigest`, `cellConfigDigest`,
`cellReviewedCommitSha`) nằm trong cột nhưng **không vào tiền ảnh**.

`scripts/production-openclaw-smoke.mjs` có bản song sinh JS, chốt bằng vector
vàng lấy từ chính hàm DB. Tính phía client **trước khi ghi** để biết sớm; nếu
lệch, guard sẽ từ chối dòng vừa ghi bằng một lỗi 42501 không nói được vì sao.

### Ba nguồn sự thật về danh sách 12 file

Sửa manifest phải sửa **cả ba**:

1. `OPENCLAW_MIGRATIONS` trong `scripts/test-openclaw-migrations.mjs`
2. `app_private.openclaw_rollout_manifest_hash_v1` (ghim cứng, đã trên production)
3. Cây git tại SHA đã duyệt

Ba tên dễ nhầm nhất — `20260727025000_openclaw_inbound_automation.sql`,
`20260727050000_openclaw_access_policies.sql`,
`20260727080000_openclaw_realtime_allowlist.sql`. Tôi từng chép tay và bịa sai cả
ba, mà **số lượng vẫn đúng 12 nên không test nào đỏ**. Đừng chép tay: dẫn xuất.

---

## 4. Khuôn dữ liệu dễ nhầm

| Trường | Khuôn | Ghi chú |
| --- | --- | --- |
| `reviewed_commit_sha` | `^[0-9a-f]{40}$` | |
| `image_digest` | `^sha256:[0-9a-f]{64}$` | **có** tiền tố |
| `config_digest` | `^[0-9a-f]{64}$` | **không** tiền tố |
| `migration_manifest_sha256` | `^[0-9a-f]{64}$` | |
| `project_ref` | `^[a-z0-9]{20}$` | guard ghim `tryymsxyyckgbrmmvozx` |

Nhầm chỗ tiền tố giữa `image_digest` và `config_digest` là lỗi rất dễ gõ, và nó
chỉ bị phát hiện **ở lần kích hoạt đầu tiên** — tức lúc muộn nhất có thể.

`allowed_scopes` của credential bị ràng bởi CHECK liệt kê đúng 18 giá trị:
`heartbeat`, `qr.publish`, `qr.result`, `inbound.commit`, `outbox.claim`,
`outbox.preflight`, `outbox.authorize-send`, `outbox.requeue`, `outbox.complete`,
`work.claim`, `work.context`, `work.complete`, `media.issue`, `lease.acquire`,
`cell.rebind`, `generation.ack`, `credential.exchange`, `runtime.sweep`.
Giá trị tự nghĩ bị chặn ở tầng DB bằng một lỗi không gợi ý giá trị nào hợp lệ.

---

## 5. Điều KHÔNG được làm

**Đừng tắt trigger để đi nhanh.** `postgres` (không superuser) vẫn đặt được
`session_replication_role='replica'` trên Supabase — tức tắt guard là khả thi.
Harness của repo có làm thế để gieo dữ liệu test. **Đừng bắt chước trên
production**: những guard đó chính là thứ ngăn OpenClaw bật lên khi chưa qua
rollout được duyệt. Chuỗi ở mục 1 chạy thông mà không cần tắt gì.

**Đừng chế một dòng `openclaw_rollout_runs` khi chưa có cell chạy thật.** Dòng đó
là lời khẳng định "có một cell đang chạy đúng ảnh đã duyệt". Ghi trước khi deploy
là biến bảng bằng chứng thành bảng ước nguyện.

---

## 6. Còn thiếu — nói thẳng

Bộ máy hiện có **chưa chạm tới VPS**. Những mảnh sau chưa dựng:

| Mảnh | Trạng thái |
| --- | --- |
| `--create-reviewed-deploy-bundle` / `--verify-...` | chưa viết |
| Chuyển bundle lên VPS, provision runtime rootless | chưa viết |
| `--verify-final-image-reproduction` (so digest ảnh đã load thật) | chưa viết |
| `--bind-owner-qr`, `--record-observation`, `--check-gates` | chưa viết |

Và bốn thứ **không tự động hoá được**, không phải vì thiếu quyền:

1. **Chủ tài khoản quét QR** trong CRM — `WAITING_OWNER_QR` dừng ở đây theo thiết kế
2. **Một người thật gửi tin vào luồng có sẵn** — `WAITING_OWNER_INBOUND`; kế hoạch
   cấm script tự tạo tin đến
3. **≥72 giờ xanh liên tục** theo đồng hồ database trước khi thăng cấp
4. **Duyệt độc lập** `R29` và `E29` — người viết code không thể là người duyệt
   độc lập cho chính nó

---

## 7. Dựng lại môi trường đo

```bash
node scripts/openclaw-local-stack.mjs up      # Postgres 17.6 + PostgREST + GoTrue + gateway
node scripts/openclaw-local-seed.mjs          # đồ thị phân quyền org DEMO
npx vitest run production-openclaw-smoke      # 49 bài hợp đồng
```

Baseline schema phải chụp trước bằng `pg_dump --schema-only` — xem
`local-pg-harness-from-prod-dump` trong ghi chú dự án. Đừng thử `supabase start`:
repo có 35 cặp version migration trùng và replay từ DB trắng là bất khả thi,
điều repo đã tự ghi ở `scripts/network-center-disposable-db.mjs:958-972`.
