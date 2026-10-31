# Kiểm học tập Hermes (học có kiểm duyệt)

Đợt 2 của kế hoạch trị tận gốc sự cố 31/10/2026: curator Hermes ghi tên tool CRM đã nghỉ hưu (`crm_task_create`) vào skill,
nên bot báo "công cụ tạo việc không khả dụng" dù CRM làm được. Chủ **giữ** tính năng tự học. Bài học được xử lý **tuỳ loại**:

| Loại bài học | Xử lý |
|---|---|
| Sở thích, cách nói chuyện, việc trợ lý ngoài CRM | Tự áp dụng (báo cáo chỉ đếm, không chép nội dung) |
| Cách **ghi** dữ liệu CRM (tạo/sửa/huỷ/thu/chi/khoá…, `crm_action_run`, mã thao tác) | **Đề xuất**, chủ/admin xem và ghi nhận quyết định |

**Hành vi hiện tại:** bài học đã có hiệu lực từ lúc curator/trợ lý tự ghi (job chỉ đọc, không chặn trước). Trang duyệt nói rõ
điều này; "Bỏ" chỉ **ghi nhận** quyết định, gỡ bài học khỏi trợ lý làm tay (mục "Vận hành sau khi chủ quyết định"). Duyệt
trước/sau hiệu lực, ai được xem nội dung, lưu nguyên văn hay tóm tắt, xoá/che sau quyết định: **chờ chủ quyết** — xem
[docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md](../../docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md).

Chủ duyệt ở trang CRM **Cài đặt › Hermes › "Bài học chờ duyệt"** (`/settings/hermes?tab=bai-hoc`), kèm "lần kiểm cuối" của
từng hồ sơ (quá 36 giờ thì báo đỏ); tin Zalo mỗi tối là đợt sau (thiết kế ở tài liệu trên).

## Thành phần

| File | Vai trò | Chạy bằng |
|---|---|---|
| `learning_audit.py` | Kiểm học tập, **CHỈ ĐỌC** hồ sơ; báo cáo đủ (private) + outbox chỉ đề xuất | Python ≥ 3.10, chỉ thư viện chuẩn, user `ihome-hermes-audit` |
| `ingest.mjs` | Nạp đề xuất của outbox vào CRM (`app_private.hermes_store_learning_ingest_v1`) | Node của connector, user `ihome-hermes`, login riêng |
| `systemd/ihome-hermes-learning-audit.service` + `.timer` | Kiểm 20:40 giờ VN; thành công ⇒ nạp ngay (`OnSuccess=`) | systemd ≥ 249 |
| `systemd/ihome-hermes-learning-ingest.service` + `.timer` | Nạp 20:55 giờ VN, **độc lập** với kiểm (job kiểm chết vẫn báo "quá cũ") | systemd ≥ 249 |
| `systemd/ihome-hermes-learning-alert@.service` | `OnFailure=` của hai unit trên: một dòng mức err vào journal | — |
| `learning-audit.example.json` | Mẫu cấu hình nạp (outbox, login riêng, ánh xạ hồ sơ → công ty/người dùng; ID giả) | — |
| `test_learning_audit.py`, `*.test.mjs` | Test với dữ liệu giả trong thư mục tạm | `node --test infra/hermes-learning-audit/*.test.mjs` |

Kho đề xuất: migration `supabase/migrations/20261031041523_hermes_learning_proposals_v1.sql` (bảng
`app_private.hermes_learning_proposals` + `hermes_learning_audit_runs`, RPC đọc/duyệt cho người giữ `users.edit`, cổng nạp chỉ
cho vai NOLOGIN riêng `hermes_learning_ingest`).

## Kiểm học tập làm gì (`learning_audit.py`)

Quét mọi hồ sơ dưới `/var/lib/ihome-hermes-profiles/owner/.hermes/profiles/*` (bỏ thư mục ẩn như `.deleted`):

1. **Tên tool chết** trong skill local (`skills/**/*.md`, trừ `.archive`, `.hub`…) và bộ nhớ (`memories/MEMORY.md`, `USER.md`,
   mục ngăn bằng `\n§\n`): mọi `crm_*` (kể cả dạng `mcp__ihomecrm__crm_*`) không thuộc `catalogToolNames()`, mọi mã thao tác
   `trang.việc` không thuộc `catalogActionIds()`. Danh mục lấy bằng `node` import
   `/opt/ihome-hermes/current/infra/hermes-broker/catalog-names.mjs` (việc của nhánh "hướng dẫn chuẩn", PR #369). **Thiếu
   module/lỗi node ⇒ báo "KHÔNG KIỂM ĐƯỢC TÊN"**, không đoán tên nào là chết. Tiến trình node chạy **không** có
   `CAP_DAC_READ_SEARCH` (xoá tập năng lực ambient bằng `prctl` trước exec, môi trường tối thiểu, không `NODE_OPTIONS`); node còn
   năng lực (`CapEff` khác 0) ⇒ không dùng danh mục.
2. **Skill local trùng tên skill chuẩn** (`ihome-official-skills/current`, nạp qua `skills.external_dirs`): Hermes ưu tiên
   project > local > external ⇒ bản local **đè** bản chuẩn. Thiếu thư mục chuẩn ⇒ báo "không kiểm được trùng tên".
3. **Bài học về ghi CRM ⇒ đề xuất**:
   - mục mới của sổ curator `skills/.curator_ledger.jsonl` (actor `curator`/`agent`; `user` tự sửa thì bỏ) từ lần chạy trước
     (lần đầu: 72 giờ gần nhất). Phần **thêm** được dựng lại bằng blob trước/sau ở `.curator_backups/blobs/<sha256>`; mất blob
     thì so với file hiện tại và ghi `diffUnavailable: true`;
   - mục bộ nhớ mới (lần đầu: mọi mục) nhắc thao tác ghi, `crm_action_run`/`confirmToken`, mã thao tác, tool ghi
     (`crm_*_create|update|upsert|send…`) hoặc ý định ghi trong ngữ cảnh CRM.
   Còn lại (sở thích, đọc dữ liệu, việc ngoài CRM) ⇒ `autoApplied` (chỉ loại + băm/tên skill, không nội dung).
   Skill đổi mà sổ curator không ghi nhận ⇒ cảnh báo `skill_changed_without_ledger`.
4. **"Bó tay" 24 giờ** trên hồ sơ người dùng thật (mặc định `owner`) và kênh thật (`zalo_personal`…; phiên CLI thử như
   `full50`, `verify-*` bị loại): câu trả lời của trợ lý khớp mẫu từ chối/không làm được, kèm phiên, giờ, câu người dùng ngay
   trước (đã che, cắt 160 ký tự). `state.db` (WAL) mở `file:…?mode=ro`; mở tại chỗ không được thì đọc **bản sao** (db + `-wal`)
   trong thư mục tạm riêng. UTF-8 hỏng trong tin nhắn ⇒ U+FFFD.

### Dữ liệu hồ sơ không được tin

Hồ sơ do Hermes ghi, nên mọi chuỗi lấy từ sổ curator, `state.db`, skill, bộ nhớ, tên file đều được **làm sạch trước khi rời hồ
sơ**: surrogate lẻ ⇒ U+FFFD, bỏ NUL và ký tự điều khiển, **che** bí mật (Bearer, JWT, `sk-…`/`rk-…`/`pk-…`, header
`Authorization`, `password=`/`token:`/`api_key=`…, khối PEM, token GitHub/Supabase/Slack/AWS/Google) và thông tin cá nhân hiển
nhiên (SĐT Việt Nam, CCCD/CMND, email, số tài khoản có nhãn "STK"/"số tài khoản") rồi mới cắt ngắn. Nguồn của đề xuất ≤ 2 KiB
dạng chữ jsonb (tên tool trong lý do ≤ 64 ký tự); `detectedAt` kẹp vào [lúc chạy − 365 ngày, lúc chạy] (mốc tương lai/năm 9999
lệch −14:00 không làm hỏng job). Mỗi đề xuất được kiểm đúng quy tắc của SQL trước khi ghi outbox (lệch ⇒ phát hiện
`proposal_dropped`, không gửi).

Một mục hỏng (dòng sổ lạ, skill/bộ nhớ không kiểm được, tin nhắn lệch khuôn) chỉ thành **phát hiện**/lỗi trong báo cáo, không làm
hỏng lần chạy; mục sổ được ghi "đã thấy" trước khi xử lý nên trạng thái luôn tiến. Mọi file ghi ra là JSON thuần ASCII
(`ensure_ascii`) — không thể hỏng vì lỗi mã hoá. Lỗi hệ thống (không ghi được đầu ra, gốc hồ sơ là symlink…) ⇒ mã ≠ 0 ⇒ cảnh báo
`OnFailure=`; gốc hồ sơ hỏng thì **không** ghi đè trạng thái.

### Đầu ra

Thư mục `/var/lib/ihome-hermes-learning-audit` (`StateDirectory`, 0750 nhóm `ihome-hermes`):

| Đường | Quyền | Nội dung | Ai đọc |
|---|---|---|---|
| `private/` | 0700 | `reports/learning-audit-<UTC>.json` (giữ 30), `latest.json`, `latest.txt` (tóm tắt tiếng Việt), `state.json` | chỉ `ihome-hermes-audit` (và root) |
| `outbox/` | 0750 | `learning-outbox-<UTC>.json` (0640, giữ 30): **chỉ** đề xuất (đã che) + mỗi hồ sơ đã kiểm một mục (nhịp kiểm) | job nạp (`ihome-hermes`) |

Stdout/journal của job kiểm: **một dòng JSON đếm số** (`learning_audit`: số hồ sơ, đề xuất, phát hiện mức cao, "bó tay", lỗi) —
không tiêu đề, không nội dung. Khoá chống trùng của đề xuất = sha256(hồ sơ | loại | nguồn | nội dung chuẩn hoá, đã che) — ổn
định giữa các lần chạy; tiêu đề luôn một dòng.

### Sandbox (`ihome-hermes-learning-audit.service`)

Job có `CAP_DAC_READ_SEARCH` (đọc được file 0600 của uid 10003) nên sandbox **chỉ gắn những đường cần đọc**:
`TemporaryFileSystem=/var/lib:ro /var/backups:ro /var/log:ro /opt:ro /srv:ro`, rồi `BindReadOnlyPaths=` đúng `skills/`,
`memories/`, `.curator_backups/`, `state.db`, `state.db-wal`, `state.db-shm` của từng hồ sơ (owner, tkt, tkh, tkj, abc1,
abeager3), bộ skill chuẩn, `/opt/ihome-hermes/node` và `/opt/ihome-hermes/current`. `.env`, `config.yaml`, `auth*`, `pending_messages/`…
của hồ sơ và mọi thứ khác của `.hermes` **không có trong sandbox**; `/etc/ihome-hermes*`, `/etc/shadow`, `/etc/ssh`… bị giấu
(`InaccessiblePaths=`). Mã còn ghim gốc hồ sơ một lần, từ chối gốc/hồ sơ/thư mục con (`skills`, `memories`, `.curator_backups`)
là symlink, mở file bằng `O_NOFOLLOW` + so dev/ino + đường thật của fd (`/proc/self/fd`), từ chối đường `..`/tuyệt đối lấy từ
sổ curator — lớp chặn thứ hai. File CÓ mà bị từ chối ⇒ phát hiện mức cao `unsafe_profile_file`.

**Thêm hồ sơ**: thêm một dòng `BindReadOnlyPaths=` như các hồ sơ có sẵn (drop-in
`systemctl edit ihome-hermes-learning-audit.service`), `daemon-reload`. Hồ sơ không được gắn thì job kiểm không thấy; nếu hồ sơ
đó có ánh xạ trong cấu hình nạp, job nạp báo `missingProfiles` (mã 1 ⇒ cảnh báo).

Thử tay (sau khi cài): `systemctl start ihome-hermes-learning-audit.service` (ghi đúng vào thư mục của job, không ghi hồ sơ),
rồi `journalctl -u ihome-hermes-learning-audit -n 20` và `cat /var/lib/ihome-hermes-learning-audit/private/latest.txt`. Bản in
JSON đủ ra màn hình: thêm `--stdout --no-state` vào `ExecStart` qua `systemd-run` với cùng thuộc tính — **chỉ** khi cần (bản in
có đoạn đã che của tin nhắn).

## Nạp vào CRM (`ingest.mjs`)

`ingest.mjs` đọc `outbox/` (không đọc `private/`, không đọc hồ sơ) và gọi `app_private.hermes_store_learning_ingest_v1(p jsonb)`
qua `store-transport.mjs` phạm vi `scope: 'learning'`, đăng nhập bằng login **riêng** `hermes_store_learning`:

- login này chỉ thuộc vai NOLOGIN `hermes_learning_ingest` (migration tạo vai; vai chỉ có USAGE `app_private` + EXECUTE đúng
  hàm nạp), **không** thuộc `hermes_store_executor` của connector — lộ mật khẩu job nạp không mở được kho bền connector, và
  ngược lại login connector không còn quyền nạp. Transport kiểm vai trước lệnh đầu (thuộc `hermes_learning_ingest`, không thuộc
  executor/postgres/service_role, không super/bypassrls) và chỉ gọi được thao tác nạp. TLS xác minh, không `service_role`, không
  JWT người dùng, không khoá tĩnh mới;
- tenant nằm trong payload và SQL tự kiểm: người dùng là thành viên **đang hoạt động** của công ty và có trợ lý `ACTIVE`;
- **nhịp kiểm**: mỗi hồ sơ có ánh xạ gửi ít nhất một lời gọi mỗi lần chạy (kể cả 0 đề xuất) với `auditGeneratedAt` = mốc của
  outbox mới nhất có hồ sơ đó (không vượt "bây giờ"); SQL giữ mốc lớn nhất ⇒ trang CRM thấy "lần kiểm cuối" thật;
- **kiểm khuôn đúng như SQL** trước khi gửi: khoá 64 hex, loại trong danh sách đóng, tiêu đề/nội dung có chữ, độ dài theo ký tự
  (≤ 200/≤ 4000), không NUL/surrogate lẻ/ký tự điều khiển, nguồn ≤ 4096 B **dạng chữ jsonb** (đo khớp `octet_length(source::text)`
  của PostgreSQL — có test so với PGlite), `detectedAt` trong [−400 ngày, +1 ngày]. Mục lệch bị bỏ và báo `droppedInvalidKeys`;
- lô bị SQL từ chối (`store_rejected`) ⇒ gửi nhịp riêng (kiểm phần đầu lô) rồi **gửi lại từng đề xuất**: chỉ mục bị từ chối riêng
  mới bị bỏ (`droppedRejectedKeys`); phần đầu lô bị từ chối ⇒ `batch_header_rejected`. Lỗi tạm/chưa rõ kết cục: thử lại một lần;
- nạp lặp lại an toàn: trùng (công ty, khoá) bị bỏ qua; mỗi lần chạy gửi lại đề xuất của mọi outbox trong `replayDays` ngày
  (mặc định 7) — một tối nạp hỏng không làm mất đề xuất. Trùng với đề xuất **đã bỏ** (trợ lý học lại bài học chủ đã bỏ) được báo
  riêng `rejectedDuplicates` + `rejectedDuplicateKeys` (SQL không đưa lại vào hàng chờ). Lô ≤ 25 đề xuất và ≤ 96 KiB.

Journal: một dòng JSON `learning_ingest` chỉ có số đếm, số thứ tự, dedupeKey (băm) — không nội dung, không mật khẩu.
Mã thoát: `0` = xong; `1` = có lô lỗi, mục bị bỏ, outbox hỏng hoặc hồ sơ có ánh xạ vắng ở lần kiểm mới nhất (phần hợp lệ vẫn
nạp); `2` = cấu hình/bí mật sai; `3` = outbox quá cũ (`staleAfterHours`, mặc định 36: job kiểm đã ngừng). Mã ≠ 0 ⇒ `OnFailure=`.

## Cài đặt (điều phối viên — KHÔNG làm khi chưa có migration trên production)

1. **Schema**: áp `20261031041523_hermes_learning_proposals_v1.sql` qua lane (`npm run migrate:forward -- <file>` dry-run, review
   chéo, rồi `--apply`; [runbook](../../docs/engineering/MIGRATION_STRATEGY.md)). Migration tạo vai NOLOGIN `hermes_learning_ingest`.
   Chưa áp thì trang báo "Máy chủ chưa có chức năng duyệt bài học".
2. **Login nạp** (đường admin đã duyệt, ngoài repo, như `hermes_store_host`): `CREATE ROLE hermes_store_learning LOGIN INHERIT
   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` (timeout ngắn), rồi **chỉ** `GRANT hermes_learning_ingest TO
   hermes_store_learning` (phải kế thừa: transport kiểm `pg_has_role(…, 'USAGE')`, login NOINHERIT bị từ chối); mật khẩu chỉ ở VPS
   `/etc/ihome-hermes/learning-store-password` (`install -o ihome-hermes -g ihome-hermes -m 600`, không xuống dòng cuối).
   `scripts/test-env/owners.mjs` đã khai login này (TEST dựng lại NOLOGIN).
3. **Web**: promote bản có tab "Bài học chờ duyệt". **Connector release** (`/opt/ihome-hermes/current`) phải chứa
   `infra/hermes-learning-audit/` và `store-transport.mjs` có phạm vi `learning` (bản main sau khi gộp PR này).
4. **User chạy kiểm**: `useradd --system --no-create-home --shell /usr/sbin/nologin --gid ihome-hermes ihome-hermes-audit`.
5. **Cấu hình nạp** (ID thật của công ty + tài khoản chủ trợ lý hồ sơ `owner`, projectRef/host thật như `connector.json`, không
   đưa vào repo): sửa từ `learning-audit.example.json`, `install -o ihome-hermes -g ihome-hermes -m 600 learning-audit.json
   /etc/ihome-hermes/learning-audit.json`. Hồ sơ nghiệm thu `tkt/tkh/tkj` trỏ DB TEST ⇒ **không** khai ở đây.
6. **Unit**: chép 5 file `systemd/*` vào `/etc/systemd/system/`, `systemctl daemon-reload`,
   `systemd-analyze security ihome-hermes-learning-audit.service` để xem lại sandbox.
7. **Chạy thử tay**: `systemctl start ihome-hermes-learning-audit.service` ⇒ `journalctl -u ihome-hermes-learning-audit -n 20`
   (một dòng đếm), `cat /var/lib/ihome-hermes-learning-audit/private/latest.txt`, rồi `journalctl -u ihome-hermes-learning-ingest -n 5`
   (một dòng `learning_ingest`: `inserted`, `duplicates`, `rejectedDuplicates`, `dropped*`, `failures`). Kiểm trên web: tab "Bài
   học chờ duyệt" có đề xuất và dòng "Lần kiểm cuối". Nếu "Bó tay" báo không đọc được `state.db`: xem bản sao trong
   `PrivateTmp` và quyền `CAP_DAC_READ_SEARCH`. Nếu "KHÔNG KIỂM ĐƯỢC TÊN" vì node: kiểm `catalog-names.mjs` có trong bản phát
   hành và không import ngoài `/opt/ihome-hermes/current`.
8. **Bật lịch**: `systemctl enable --now ihome-hermes-learning-audit.timer ihome-hermes-learning-ingest.timer` (20:40 và 20:55
   giờ VN, `Persistent=true`). Không dùng systemd thì cron tương đương (giờ máy UTC):
   `40 13 * * * root systemctl start ihome-hermes-learning-audit.service` và `55 13 * * * root systemctl start ihome-hermes-learning-ingest.service`.
9. **Cảnh báo**: `journalctl -p err -t ihome-hermes-learning` (dòng của `ihome-hermes-learning-alert@…`); chủ thấy trên web khi
   "lần kiểm cuối" quá 36 giờ.

## Vận hành sau khi chủ quyết định

- **Duyệt**: điều phối viên đưa bài học vào bộ skill chuẩn `ihome-crm-*` (repo `infra/hermes-skills/`, nạp qua
  `skills.external_dirs`) để mọi hồ sơ dùng, rồi gỡ bản local.
- **Bỏ**: gỡ khỏi trợ lý — skill: `docker exec hermes-owner hermes --profile owner curator rollback <ledgerId>` (mã ở nguồn đề
  xuất; xem trước bằng `hermes curator ledger`); bộ nhớ: xoá đúng mục (ngăn bằng `§`) trong `memories/*.md` của hồ sơ, có sao lưu.
- Đây là thao tác GHI trên VPS — chỉ điều phối viên làm, theo quy trình hạ tầng.

## Giới hạn đã biết

- Curator ghi skill ngay sau phiên; job chỉ phát hiện và đưa đi duyệt, **không chặn trước** hiệu lực của bài học (chặn trước cần
  hook trong Hermes — ngoài phạm vi). Skill chuẩn ở `external_dirs` thì curator không sửa được.
- Phân loại "ghi CRM" là heuristic thận trọng (nghi thì đưa đi duyệt); mẫu "bó tay" có thể sót câu diễn đạt lạ. Che thông tin là
  theo mẫu (có thể sót dạng lạ, có thể che thừa một số dài giống SĐT/CCCD).
- Tên chết chỉ kiểm khi có `catalog-names.mjs` (việc của nhánh "hướng dẫn chuẩn").
- Sandbox systemd và phần đọc `state.db` trong sandbox **chưa chạy thử trên VPS** (PR chỉ viết, không cài); bước 6–7 là lần kiểm đầu.
- Gỡ lịch: `systemctl disable --now ihome-hermes-learning-audit.timer ihome-hermes-learning-ingest.timer`; dữ liệu đề xuất ở CRM
  giữ nguyên (chính sách xoá/che chờ chủ quyết).
