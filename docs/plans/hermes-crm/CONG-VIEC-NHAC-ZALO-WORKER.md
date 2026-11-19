# Nhắc việc qua Zalo — bàn giao cho worker (Công việc Mốc 6)

Phần DB: `20261023063140_task_reminder_v1` (hàng đợi, cấu hình, bộ sinh nhắc) và `20261023063142_zalo_worker_task_reminder_v1` (ba RPC
cho worker). Thiết kế: [CONG-VIEC-THAO-TAC-GHI.md](CONG-VIEC-THAO-TAC-GHI.md) mục 6 và 23.

**Trạng thái khi viết (23/10/2026):** hai migration chưa áp ở đâu; mã worker CHƯA đổi; tính năng khoá để TẮT (không có dòng
`task_reminder_config` nào). Tài liệu này là hợp đồng để phiên chính sửa worker. Phiên Mốc 6 không sửa, không deploy worker.

## 1. Worker đọc gì

- Worker **không** đọc bảng `app_private.task_reminder_outbox` (không có quyền, kể cả `service_role`). Mọi thao tác đi qua ba RPC
  `public.zalo_worker_*_task_reminder*_v1`. Ba RPC này chỉ cấp cho `service_role` và đòi worker đang giữ lease singleton
  `zalo_worker_lease` (heartbeat dưới 30 s), giống `zalo_worker_claim_job_v1`.
- Không dùng `zalo_send_queue`, không ghi `zalo_messages` / `zalo_conversations`. Guard hộp thư chung của nick bot chặn DM thường;
  hàng đợi nhắc tự là nhật ký gửi, giống đường cầu native `/v1/send` gửi cho người đã ghép.
- Người nhận chỉ đến từ liên kết Hermes đang hiệu lực (`app_private.hermes_zalo_bindings.sender_uid`), và người đó phải là thành viên
  ACTIVE của công ty. Không có đường nào để gửi tới số hay UID tuỳ ý, hay tới khách.

## 2. Vòng xử lý đề xuất

Gắn vào nhịp tự động hoá 60 s có sẵn (`worker/index.js`, `tickTuDongHoa` trong `worker/lib/automation.js`), cạnh `tickHermesSchedules`.
`INSTANCE_ID` là uuid của `worker/lib/lease.js`.

```text
claim = rpc zalo_worker_claim_task_reminders_v1 { p_instance_id: INSTANCE_ID, p_limit: 5 }
  lỗi PGRST202 (hàm chưa deploy) ⇒ coi như không có tin (như worker/lib/hermes-schedule.js)
  claim.ok = false (lease_lost) ⇒ dừng lượt này
for item in claim.items:                       # {id, accountId, peerUid, kind, reminderDate, leaseUntil}
  session = phiên đang giữ nick item.accountId
    không có ⇒ settle(item.id, 'failed', 'account_offline'); tiếp
  gate = rpc zalo_worker_begin_task_reminder_v1 { p_id: item.id, p_instance_id: INSTANCE_ID }
    gate.ok = false ⇒ tiếp (DB đã ghi skipped / dời giờ yên / not_claimed); KHÔNG gửi
  try   await withTimeout(session.api.sendMessage({ msg: gate.body }, gate.peerUid, ThreadType.User), 60 s)
        settle(item.id, 'sent')
  catch chắc chắn tin CHƯA rời worker (lỗi trước khi gọi mạng, nick bị từ chối trước khi gửi) ⇒ settle(item.id, 'failed', mã)
        còn lại (timeout, mất kết nối giữa chừng, không rõ) ⇒ settle(item.id, 'unknown', mã)
  nghỉ ≥ 3 s giữa hai tin; đếm chung trần của nick với mọi đường gửi khác (1 tin/3 s, 30 tin/giờ, 200 tin/ngày — docs/zalo/PLAN.md)
```

Luôn gửi `gate.body` (nội dung begin vừa dựng lại từ các việc còn mở), không gửi nội dung nào khác.

## 3. Hợp đồng RPC

| RPC | Vào | Ra | Ghi chú |
| --- | --- | --- | --- |
| `zalo_worker_claim_task_reminders_v1(p_instance_id uuid, p_limit int = 5)` | uuid instance, 1–20 | `{ok:true, items:[{id, accountId, peerUid, kind, reminderDate, leaseUntil}]}` hoặc `{ok:false, reason:'lease_lost', items:[]}` | Lấy tin `queued` đã tới `not_before` (SKIP LOCKED), giữ 60 s. Cùng lượt: dọn lease quá hạn; tin của công ty đã tắt / đã qua ngày / người nhận hết liên kết ⇒ `skipped` |
| `zalo_worker_begin_task_reminder_v1(p_id uuid, p_instance_id uuid)` | id từ claim | `{ok:true, id, accountId, peerUid, body, leaseUntil}` hoặc `{ok:false, reason}` | Cổng NGAY TRƯỚC khi gọi Zalo. `reason`: `lease_lost`, `not_claimed`, `disabled`, `expired`, `recipient_unbound`, `notifications_off`, `quiet_hours` (dời `not_before`, tin quay về `queued`), `jobs_closed`. Thành công ⇒ `sending`, giữ 90 s |
| `zalo_worker_settle_task_reminder_v1(p_id uuid, p_instance_id uuid, p_outcome text, p_error_code text = null)` | `sent` / `failed` / `unknown`; mã lỗi tuỳ ý (chuẩn hoá về `[a-z0-9_]`, tối đa 64 ký tự) | `{ok:true, state, attempts[, replay]}` hoặc `{ok:false, reason:'not_found'/'not_owner'/'not_started', state}` | `sent` và `unknown` chỉ nhận khi tin đang `sending`. Gọi lại cùng kết quả cuối ⇒ `replay:true`, không đổi gì |

Tham số sai (thiếu id, `p_outcome` lạ) ⇒ lỗi `22023 task_reminder_invalid`. Hàm chưa có ⇒ `PGRST202`.

## 4. Trạng thái

```text
queued ──claim──▶ claimed ──begin──▶ sending ──settle sent──▶ sent
  ▲                 │ │                 │ └──settle unknown / lease 90 s hết──▶ unknown   (KHÔNG BAO GIỜ gửi lại)
  │                 │ └─begin: hết việc / tắt / hết liên kết / E4 tắt / yên tới hết ngày──▶ skipped
  │                 └─lease 60 s hết──▶ queued
  ├──begin: đang giờ yên (cùng ngày)──┘
  └──settle failed (lần 1: +5 phút, lần 2: +30 phút) ── lần 3 ──▶ failed
```

- `failed` chỉ khi chắc chắn chưa gửi. Mọi lỗi sau khi đã gọi `sendMessage` mà không biết kết quả ⇒ `unknown`. Thà mất một tin nhắc còn
  hơn nhắn hai lần.
- Settle sau khi gửi thành công mà lỗi mạng ⇒ thử settle lại; phát lại an toàn. Không settle được trong 90 s ⇒ DB tự chuyển `unknown`
  (không gửi lại).
- Tin của ngày hôm trước chưa gửi được thì thành `skipped` (`expired`) ở lượt claim kế; không dồn tin sang hôm sau.

## 5. Nội dung tin

Một tin cho mỗi loại, mỗi người, mỗi ngày; tối đa 2 tin/người/ngày (`daily_cap`):

```text
Nhắc việc: 2 việc hạn hôm nay (23/10):
• JOB-20261023-0001 · Sửa vòi nước · 111PVC/101 · hạn 23:59
• JOB-20261023-0002 · Kiểm bình chữa cháy · 111PVC · hạn 23:59
Xem và cập nhật: https://<app_base_url>/tasks
```

Tin quá hạn ghi "quá hạn N ngày (hạn dd/mm)". Tối đa 10 việc và 1000 ký tự; phần dư thành "… và N việc khác". Tin chỉ có mã, tiêu đề
(do người giao gõ), toà / phòng, hạn và link; không SĐT, không trường khách.

## 6. Bật tính năng (phiên chính)

1. Áp `20261023063140` rồi `20261023063142` (lane `migrate:forward`, TEST rồi production).
2. Sửa worker theo mục 2, thêm test vitest (mock `sb.rpc` như `worker/__tests__/hermes-reply.test.js`): claim lỗi, lease mất, begin
   từ chối, gửi thành công, lỗi trước khi gửi ⇒ `failed`, timeout ⇒ `unknown`, settle lỗi rồi thử lại.
3. Deploy worker. **Bắt buộc:** thay container worker thì PHẢI tạo lại sidecar `hermes-owner` (và `ihome-hermes-dashboard` dùng chung
   mạng của nó), vì hai container này chạy `--network container:<ID worker>`. Worker mới ⇒ namespace mạng cũ mất ⇒ bot câm. Ngày
   22/10/2026 bot câm khoảng 12 giờ vì bỏ sót bước này. Phiên chính có script dựng lại hai container theo ID worker mới từ
   `docker inspect` của chính container cũ: `vps-recreate-sidecar.sh` (ngoài repo). Mặc định chỉ in lệnh (`MODE=dry`), `MODE=apply` mới
   chạy; container cũ được đổi tên để lùi, không xoá. Sau khi chạy: kiểm `hermes-owner` Running và bot trả lời một tin thử.
4. Bật cho công ty bằng migration riêng:

```sql
INSERT INTO app_private.task_reminder_config(organization_id,enabled,app_base_url)
VALUES('<organization_id>',true,'https://<tên miền web>')
ON CONFLICT (organization_id) DO UPDATE SET enabled=true,app_base_url=excluded.app_base_url,updated_at=clock_timestamp();
```

Mặc định: 08:00 việc hạn hôm nay, 08:00 việc quá hạn tối đa 3 ngày, không sinh nhắc mới từ 11:00, ≤ 2 tin/người/ngày, giờ yên công ty
(21→7) hoặc công ty + cá nhân khi DB có `app_private.notify_in_quiet_hours_v1`, theo công tắc E4 (tắt cả chuông lẫn push ⇒ không nhắc
Zalo; chưa từng chỉnh thông báo = bật). Tắt: `UPDATE app_private.task_reminder_config SET enabled=false`. Tin đã xếp sẽ thành `skipped` (`disabled`).

## 7. Đo sau khi bật (chỉ đọc)

```sql
SELECT reminder_date,kind,state,error_code,count(*) FROM app_private.task_reminder_outbox
WHERE created_at>now()-interval '7 days' GROUP BY 1,2,3,4 ORDER BY 1 DESC,2,3;
```

`unknown` tăng ⇒ xem log worker quanh `provider_started_at`. `skipped`/`recipient_unbound` nhiều ⇒ người nhận chưa liên kết Zalo
(hiện chỉ một chủ có liên kết; nhân viên cần luồng liên kết "chỉ nhận nhắc" theo CV10).

## 8. Chưa làm / giới hạn

- Liên kết Zalo cho nhân viên chưa có kết nối Hermes (CV10) chưa có; tới lúc đó chỉ người đã ghép `/hermes-link` nhận được nhắc.
- Nick bot cá nhân chỉ gửi được cho người đã nhắn với bot (phiên chính kiểm trên VPS: DM không cần kết bạn).
- pg_cron `task-reminders-15m` chạy bộ sinh mỗi 15 phút; tắt cấu hình thì bộ sinh không làm gì.
