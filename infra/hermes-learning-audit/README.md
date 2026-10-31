# Kiểm học tập Hermes (học có kiểm duyệt)

Đợt 2 của kế hoạch trị tận gốc sự cố 31/10/2026: curator Hermes ghi tên tool CRM đã nghỉ hưu (`crm_task_create`) vào skill,
nên bot báo "công cụ tạo việc không khả dụng" dù CRM làm được. Chủ **giữ** tính năng tự học. Bài học được xử lý **tuỳ loại**:

| Loại bài học | Xử lý |
|---|---|
| Sở thích, cách nói chuyện, việc trợ lý ngoài CRM | Tự áp dụng (chỉ ghi vào báo cáo) |
| Cách **ghi** dữ liệu CRM (tạo/sửa/huỷ/thu/chi/khoá…, `crm_action_run`, mã thao tác) | **Đề xuất**, chủ/admin phải duyệt |

Chủ duyệt ở hai nơi: trang CRM **Cài đặt › Hermes › "Bài học chờ duyệt"** (`/settings/hermes?tab=bai-hoc`) để xem kỹ và tra
lịch sử; tin Zalo mỗi tối (đợt sau — thiết kế ở [docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md](../../docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md)).

## Thành phần

| File | Vai trò | Chạy bằng |
|---|---|---|
| `learning_audit.py` | Kiểm học tập, **CHỈ ĐỌC** hồ sơ; xuất báo cáo JSON + tóm tắt tiếng Việt | Python ≥ 3.10, chỉ thư viện chuẩn |
| `ingest.mjs` | Nạp đề xuất của báo cáo vào CRM (`app_private.hermes_store_learning_ingest_v1`) | Node của connector, user `ihome-hermes` |
| `systemd/*.service`, `*.timer` | Lịch 20:40 giờ VN: kiểm → (thành công) nạp | systemd ≥ 249 (`OnSuccess=`) |
| `learning-audit.example.json` | Mẫu cấu hình nạp (ánh xạ hồ sơ → công ty/người dùng; ID giả) | — |
| `test_learning_audit.py`, `*.test.mjs` | Test với dữ liệu giả trong thư mục tạm | `node --test infra/hermes-learning-audit/*.test.mjs` |

Kho đề xuất: migration `supabase/migrations/20261031041523_hermes_learning_proposals_v1.sql` (bảng
`app_private.hermes_learning_proposals`, RPC đọc/duyệt cho người giữ `users.edit`, cổng nạp cho `hermes_store_executor`).

## Kiểm học tập làm gì (`learning_audit.py`)

Quét mọi hồ sơ dưới `/var/lib/ihome-hermes-profiles/owner/.hermes/profiles/*` (bỏ thư mục ẩn như `.deleted`):

1. **Tên tool chết** trong skill local (`skills/**/*.md`, trừ `.archive`, `.hub`…) và bộ nhớ (`memories/MEMORY.md`, `USER.md`,
   mục ngăn bằng `\n§\n`): mọi `crm_*` (kể cả dạng `mcp__ihomecrm__crm_*`) không thuộc `catalogToolNames()`, mọi mã thao tác
   `trang.việc` không thuộc `catalogActionIds()`. Danh mục lấy bằng `node` import
   `/opt/ihome-hermes/current/infra/hermes-broker/catalog-names.mjs`. **Thiếu module/lỗi node ⇒ báo "KHÔNG KIỂM ĐƯỢC TÊN"**,
   không đoán tên nào là chết.
2. **Skill local trùng tên skill chuẩn** (`ihome-official-skills/current`, nạp qua `skills.external_dirs`): Hermes ưu tiên
   project > local > external ⇒ bản local **đè** bản chuẩn. Thiếu thư mục chuẩn ⇒ báo "không kiểm được trùng tên".
   Skill local nhắc tool CRM ngoài bộ chuẩn được nêu mức trung bình (`local_crm_skill`).
3. **Bài học về ghi CRM ⇒ đề xuất**:
   - mục mới của sổ curator `skills/.curator_ledger.jsonl` (actor `curator`/`agent`; `user` tự sửa thì bỏ) từ lần chạy trước
     (lần đầu: 72 giờ gần nhất). Phần **thêm** được dựng lại bằng blob trước/sau ở `.curator_backups/blobs/<sha256>`; mất blob
     thì so với file hiện tại và ghi `diffUnavailable: true`;
   - mục bộ nhớ mới (lần đầu: mọi mục) nhắc thao tác ghi, `crm_action_run`/`confirmToken`, mã thao tác, tool ghi
     (`crm_*_create|update|upsert|send…`) hoặc ý định ghi trong ngữ cảnh CRM.
   Còn lại (sở thích, đọc dữ liệu, việc ngoài CRM) ⇒ `autoApplied`.
   Skill đổi mà sổ curator không ghi nhận ⇒ cảnh báo `skill_changed_without_ledger`.
4. **"Bó tay" 24 giờ** trên hồ sơ người dùng thật (mặc định `owner`) và kênh thật (`zalo_personal`…; phiên CLI thử như
   `full50`, `verify-*` bị loại): câu trả lời của trợ lý khớp mẫu từ chối/không làm được (`khong_kha_dung`,
   `chua_co_trong_crm`, `khong_cho_phep`, `thieu_cong_cu`, `khong_the_lam`…), kèm phiên, giờ, câu người dùng ngay trước
   (cắt 160 ký tự). `state.db` mở `file:…?mode=ro`; mở tại chỗ không được thì đọc **bản sao** trong thư mục tạm riêng.

Đầu ra (thư mục `/var/lib/ihome-hermes-learning-audit`, nhóm `ihome-hermes` đọc được): `reports/learning-audit-<UTC>.json`
(giữ 30 bản), `latest.json`, `latest.txt` (tóm tắt), `state.json` (0600 — mục sổ đã thấy, băm bộ nhớ/skill). Không ghi gì vào hồ sơ.
Khoá chống trùng của đề xuất = sha256(hồ sơ | loại | nguồn | nội dung chuẩn hoá) — ổn định giữa các lần chạy; tiêu đề luôn một dòng.

Đọc an toàn: job có `CAP_DAC_READ_SEARCH` (đọc được mọi file trên host) trong khi hồ sơ do Hermes ghi được, nên mọi file của hồ sơ
được đọc qua `safe_read`: chỉ file thường nằm trong hồ sơ, **từ chối symlink**, đường `..`/tuyệt đối lấy từ sổ curator, file quá
lớn, file bị tráo giữa lúc kiểm và lúc mở; unit còn giấu `/etc/ihome-hermes*` và thư mục trạng thái connector.

Thử tay không ghi gì — chạy **trong cùng sandbox** của unit (chạy trần bằng root, SQLite có thể chạm `-shm`/`-wal` của hồ sơ):

```bash
systemd-run --pipe --wait --collect -p User=ihome-hermes-audit -p Group=ihome-hermes \
  -p AmbientCapabilities=CAP_DAC_READ_SEARCH -p CapabilityBoundingSet=CAP_DAC_READ_SEARCH -p NoNewPrivileges=yes \
  -p ProtectSystem=strict -p ReadOnlyPaths=/var/lib/ihome-hermes-profiles -p PrivateNetwork=yes -p PrivateTmp=yes \
  -p 'InaccessiblePaths=-/etc/ihome-hermes -/etc/ihome-hermes-test' \
  /usr/bin/python3 -I -B -X utf8 /opt/ihome-hermes/current/infra/hermes-learning-audit/learning_audit.py --stdout --no-state
```

Tuỳ chọn: `--profiles-root`, `--official-skills`, `--catalog-module`, `--node`, `--real-profiles owner`, `--window-hours 24`,
`--now <ISO>`, `--config <json>` (khoá như `DEFAULTS`).

## Xác thực khi nạp — chọn cổng kho bền connector

`ingest.mjs` gọi `app_private.hermes_store_learning_ingest_v1(p jsonb)` qua `store-transport.mjs` (thao tác
`ingestLearningProposals`), đăng nhập bằng login kho bền `hermes_store_<tên>` thuộc vai `hermes_store_executor` — **cùng đường
với mọi writer server-side của Hermes** (connector, dọn bộ nhớ công việc). Lý do:

- không thêm khoá tĩnh mới, không dùng `service_role` trên VPS (connector từ chối `sb_secret_`); quyền của login chỉ là các hàm
  `hermes_store_*` cố định, TLS xác minh, kiểm vai trước lệnh đầu (không super/bypassrls);
- tenant nằm trong payload và SQL tự kiểm: người dùng là thành viên **đang hoạt động** của công ty và có trợ lý `ACTIVE`;
  payload đúng khuôn (≤ 25 đề xuất/lô, khoá 64 hex, loại trong danh sách đóng, `detectedAt` ISO trong [−400 ngày, +1 ngày]);
- nạp lặp lại an toàn: trùng (công ty, khoá) bị bỏ qua ⇒ mất phản hồi thì gửi lại đúng lô một lần; mỗi lần chạy còn gửi lại
  đề xuất của mọi báo cáo trong `replayDays` ngày (mặc định 7, thư mục `reportsDir`) — một tối nạp hỏng không làm mất đề xuất
  (job kiểm chỉ báo mỗi đề xuất một lần). Lô ≤ 25 đề xuất và ≤ 96 KiB (trần payload 128 KiB).

Mặc định đọc khối `store` (chỉ khối này) của `/etc/ihome-hermes/connector.json`; muốn login riêng thì khai `store`
(`projectRef`, `host`, `role`, `passwordFile`, `caFile`) trong cấu hình nạp và tạo login `hermes_store_<tên>` thuộc
`hermes_store_executor` (ngoài repo, như `hermes_store_host`). File bí mật phải là file thường, đường dẫn tuyệt đối, không mở
cho nhóm/người khác.

## Cài đặt (điều phối viên — KHÔNG làm khi chưa có migration trên production)

1. **Schema**: áp `20261031041523_hermes_learning_proposals_v1.sql` qua lane (`npm run migrate:forward -- <file>` dry-run, review
   chéo, rồi `--apply`; [runbook](../../docs/engineering/MIGRATION_STRATEGY.md)). Chưa áp thì trang báo "Máy chủ chưa có chức năng
   duyệt bài học" và nạp lỗi `PGRST202`/42883.
2. **Web**: promote bản có tab "Bài học chờ duyệt". **Connector release** (`/opt/ihome-hermes/current`) phải chứa
   `infra/hermes-learning-audit/` và `store-transport.mjs` có `ingestLearningProposals` (bản main sau khi gộp PR này).
3. **User chạy kiểm**: `useradd --system --no-create-home --shell /usr/sbin/nologin --gid ihome-hermes ihome-hermes-audit`.
4. **Cấu hình nạp** (ID thật của công ty + tài khoản chủ trợ lý hồ sơ `owner`, không đưa vào repo):
   `install -o ihome-hermes -g ihome-hermes -m 600 learning-audit.json /etc/ihome-hermes/learning-audit.json` (sửa từ
   `learning-audit.example.json`). Hồ sơ nghiệm thu `tkt/tkh/tkj` trỏ DB TEST ⇒ **không** khai ở đây.
5. **Unit**: chép 3 file `systemd/*` vào `/etc/systemd/system/`, `systemctl daemon-reload`.
6. **Chạy thử tay**: `systemctl start ihome-hermes-learning-audit.service` ⇒ `journalctl -u ihome-hermes-learning-audit -n 80`
   (tóm tắt tiếng Việt), `cat /var/lib/ihome-hermes-learning-audit/latest.txt`, rồi `journalctl -u ihome-hermes-learning-ingest -n 5`
   (một dòng JSON `learning_ingest`: `inserted`, `duplicates`, `skipped`, `failures`). Kiểm trên web: tab "Bài học chờ duyệt".
   Nếu dòng "Bó tay" báo không đọc được `state.db`: bản SQLite đọc qua bản sao trong `PrivateTmp`; vẫn lỗi thì xem quyền
   `CAP_DAC_READ_SEARCH`.
7. **Bật lịch**: `systemctl enable --now ihome-hermes-learning-audit.timer` (20:40 giờ VN, `Persistent=true`).
   Không dùng systemd thì cron tương đương (giờ máy UTC): `40 13 * * * root systemctl start ihome-hermes-learning-audit.service`.

Mã thoát: kiểm `0` = đã ghi báo cáo (lỗi từng hồ sơ nằm trong báo cáo), `2` = cấu hình sai; nạp `0` = xong, `1` = có lô lỗi
hoặc có đề xuất/báo cáo lệch khuôn bị bỏ (phần hợp lệ vẫn nạp), `2` = cấu hình/bí mật/báo cáo mới nhất sai, `3` = báo cáo quá cũ
(`staleAfterHours`, mặc định 36). Bản sao `state.db` (khi phải đọc qua bản sao) nằm trong `PrivateTmp` — chỉ hồ sơ người dùng thật
(owner, ~20 MB), dưới `MemoryMax=256M` kể cả khi `/tmp` là tmpfs.

## Vận hành sau khi chủ quyết định

- **Duyệt**: điều phối viên đưa bài học vào bộ skill chuẩn `ihome-crm-*` (repo `infra/hermes-skills/`, nạp qua
  `skills.external_dirs`) để mọi hồ sơ dùng, rồi gỡ bản local.
- **Bỏ**: gỡ khỏi trợ lý — skill: `docker exec hermes-owner hermes --profile owner curator rollback <ledgerId>` (mã ở nguồn đề
  xuất; xem trước bằng `hermes curator ledger`); bộ nhớ: xoá đúng mục (ngăn bằng `§`) trong `memories/*.md` của hồ sơ, có sao lưu.
- Đây là thao tác GHI trên VPS — chỉ điều phối viên làm, theo quy trình hạ tầng.

## Giới hạn đã biết

- Curator ghi skill ngay sau phiên; job chỉ phát hiện và đưa đi duyệt, **không chặn trước** hiệu lực của bài học (chặn trước cần
  hook trong Hermes — ngoài phạm vi). Skill chuẩn ở `external_dirs` thì curator không sửa được.
- Phân loại "ghi CRM" là heuristic thận trọng (nghi thì đưa đi duyệt); mẫu "bó tay" có thể sót câu diễn đạt lạ.
- Tên chết chỉ kiểm khi có `catalog-names.mjs` (việc của nhánh "hướng dẫn chuẩn").
- Gỡ lịch: `systemctl disable --now ihome-hermes-learning-audit.timer`; dữ liệu đề xuất ở CRM giữ nguyên (bất biến, không xoá).
