# Kiểm học tập Hermes (học có kiểm duyệt)

Đợt 2 của kế hoạch trị tận gốc sự cố 31/10/2026: curator Hermes ghi tên tool CRM đã nghỉ hưu (`crm_task_create`) vào skill,
nên bot báo "công cụ tạo việc không khả dụng" dù CRM làm được. Chủ **giữ** tính năng tự học. Bài học được xử lý **tuỳ loại**:

| Loại bài học | Xử lý |
|---|---|
| Sở thích, cách nói chuyện, việc trợ lý ngoài CRM | Tự áp dụng (báo cáo chỉ đếm, không chép nội dung) |
| Cách **ghi** dữ liệu CRM (tạo/sửa/huỷ/thu/chi/khoá…, `crm_action_run`, mã thao tác) | **Đề xuất**, chủ/admin xem và ghi nhận quyết định |
| Không phân loại chắc được: thao tác khác của curator, file không phải `.md`, phần vá chỉ xoá nội dung, skill đổi ngoài sổ, tên tool chết, skill đè bản chuẩn… | **Cảnh báo** `audit_warning`, tới cùng trang duyệt; không tự áp dụng im lặng |

**Chủ đã chốt (31/10, ~18:30)** — chi tiết ở [docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md](../../docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md):

- **Duyệt SAU**: bài học có hiệu lực ngay từ lúc curator/trợ lý tự ghi; job kiểm 20:40 mỗi tối gom và đưa lên hàng duyệt. Không
  cách ly định kỳ, không chặn trong lõi Hermes. Trang duyệt nói rõ điều này; "Bỏ" chỉ **ghi nhận** quyết định, gỡ bài học khỏi
  trợ lý làm tay (mục "Vận hành sau khi chủ quyết định").
- **Nội dung NGUYÊN VĂN**, kể cả thông tin khách (SĐT, CCCD, email, STK…): công ty nhỏ, nhân viên nội bộ dùng chung; quyền xem/duyệt
  vẫn là người giữ `users.edit`. **Chỉ che bí mật kỹ thuật** (mật khẩu, token/JWT/Bearer, khoá API `sk-…`/`sbp_…`, khối PEM…) — vì
  đó là **an ninh hệ thống** (ai cầm được là vào được hệ thống), không phải riêng tư của khách; chủ có thể yêu cầu bỏ sau (xoá các
  mẫu tương ứng trong `REDACTIONS` của `learning_audit.py`).
- **Không che sau quyết định**: đề xuất đã quyết định giữ nguyên làm lịch sử (bất biến, không xoá). Trường hợp duy nhất phải sửa là
  bí mật kỹ thuật đã lọt: theo thủ tục "Gỡ bí mật đã lọt" trong [PR #371](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/371), qua lane, có chủ duyệt.

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
   `trang.việc` không thuộc `catalogActionIds()` (tên file như `task.md`, `contract.pdf` không bị nhầm là mã thao tác). Danh mục lấy bằng `node` import
   `/opt/ihome-hermes/current/infra/hermes-broker/catalog-names.mjs` (việc của nhánh "hướng dẫn chuẩn", PR #369). **Thiếu
   module/lỗi node ⇒ báo "KHÔNG KIỂM ĐƯỢC TÊN"**, không đoán tên nào là chết. Tiến trình node chạy **không** có
   `CAP_DAC_READ_SEARCH` (xoá tập năng lực ambient bằng `prctl` trước exec, môi trường tối thiểu, không `NODE_OPTIONS`); node còn
   năng lực (`CapEff` khác 0) ⇒ không dùng danh mục.
2. **Skill local trùng tên skill chuẩn** (`ihome-official-skills/current`, nạp qua `skills.external_dirs`): Hermes ưu tiên
   project > local > external ⇒ bản local **đè** bản chuẩn. Thiếu thư mục chuẩn ⇒ báo "không kiểm được trùng tên".
3. **Bài học về ghi CRM ⇒ đề xuất**:
   - mục mới của sổ curator `skills/.curator_ledger.jsonl` (actor `curator`/`agent`; `user` tự sửa thì bỏ) từ lần chạy trước
     (lần đầu: 72 giờ gần nhất). Phần **thêm** và phần **xoá** được dựng lại bằng blob trước/sau ở `.curator_backups/blobs/<sha256>`; mất
     blob thì so với file hiện tại và ghi `diffUnavailable: true`. Đề xuất hiện **toàn bộ** phần đổi, không lọc riêng câu nói về CRM.
     `create`, `edit`, `patch`, `write_file` (đọc từ `tools/skill_manager_tool.py` của Hermes trong `hermes-owner`) là thao tác thay nội
     dung: có dấu hiệu ghi CRM thì đề xuất, không thì tự áp dụng nếu chỉ là `.md`. Mọi thao tác khác (`delete`, `remove_file`, `archive`,
     `rollback`…, kể cả tên chưa biết), file không phải `.md`, file nhị phân (chỉ báo tên) và bản vá chỉ xoá nội dung ⇒ cảnh báo;
   - mục bộ nhớ mới (lần đầu: mọi mục) nhắc thao tác ghi, `crm_action_run`/`confirmToken`, mã thao tác, tool ghi
     (`crm_*_create|update|upsert|send…`) hoặc ý định ghi trong ngữ cảnh CRM.
   Còn lại (sở thích, đọc dữ liệu, việc ngoài CRM) ⇒ `autoApplied` (chỉ loại + băm/tên skill, không nội dung).
   Skill đổi mà sổ curator không ghi nhận ⇒ phát hiện `skill_changed_without_ledger` và đưa nguyên file hiện tại lên trang duyệt
   (có dấu hiệu ghi CRM thì là đề xuất, không thì cảnh báo). Tên chết, skill đè bản chuẩn, file không đọc an toàn, mục sổ lạ/hỏng cũng
   thành cảnh báo trên trang duyệt, khoá theo nội dung nên cùng phát hiện không hiện lại mỗi tối.
4. **"Bó tay" 24 giờ** trên hồ sơ người dùng thật (mặc định `owner`) và kênh thật (`zalo_personal`…; phiên CLI thử như
   `full50`, `verify-*` bị loại): câu trả lời của trợ lý khớp mẫu từ chối/không làm được, kèm phiên, giờ, câu người dùng ngay
   trước (nguyên văn, cắt 160 ký tự; chỉ bí mật kỹ thuật bị che). `state.db` (WAL) mở `file:…?mode=ro`; mở tại chỗ không được thì
   đọc **bản sao** (db + `-wal`)
   trong thư mục tạm riêng. UTF-8 hỏng trong tin nhắn ⇒ U+FFFD.

### Dữ liệu hồ sơ không được tin

Hồ sơ do Hermes ghi, nên mọi chuỗi lấy từ sổ curator, `state.db`, skill, bộ nhớ, tên file đều được **làm sạch trước khi rời hồ
sơ**: surrogate lẻ ⇒ U+FFFD, bỏ NUL và ký tự điều khiển, **che bí mật kỹ thuật** rồi mới cắt ngắn. Che gồm: Bearer, JWT, `sk-…`/`rk-…`/
`pk-…`, header `Authorization`, `Cookie:`, khối PEM, token GitHub/Supabase/Slack/AWS/Google/Contentful/Vercel/bot, token kết nối `hc_…`; nhãn + giá trị có hậu tố hoặc nháy
(`DB_PASSWORD=`, `PGPASSWORD=`, `VERCEL_TOKEN=`, `ZALO_API_KEY=`, `SUPABASE_KEY=`, `"service_role_key": "x"`, `"password": "x"`, `"api_key":"x"`, `API key: x`, `Secret key: x`, `token là x`, `Token của Vercel: x`), chuỗi kết nối
(`postgresql://u:PASS@host`, `https://u:PASS@host`), tham số `-u`/`--user` của curl dạng tên:mật khẩu, `-p` của mysql và sshpass, `--password X`; tiếng Việt (`mật khẩu:`, `mật khẩu là X`, `Mật khẩu
wifi: X`, `mã khoá`/`mã khóa`, `pass:`, `mk:`), giá trị ngắn, giá trị ở dòng ngay dưới nhãn, chữ dạng NFD. Lưới cuối đo độ ngẫu nhiên: chuỗi ≥ 32 ký tự lẫn hoa, thường, số thì che dù không có nhãn hay tiền tố
(bắt khoá của nhà cung cấp chưa biết; mã băm hex, UUID, đường dẫn, tên định danh không rơi vào).

**Đây là lớp giảm rủi ro, không đảm bảo tuyệt đối.** Lớp bảo vệ thật là chỉ người giữ `users.edit` đọc được đề xuất, kèm thủ tục gỡ ở mục I runbook PR #371. Cố ý KHÔNG che, để không nhầm thông tin khách:
văn tự do không nhãn (`mật khẩu X`, `tk admin mk X`, `admin/X`, `mã OTP:`, `mã PIN:`); giá trị dạng số 9–19 chữ số đứng sau nhãn tiếng Việt hoặc `pass:`/`mk:` (có thể là SĐT, CCCD, STK nên giữ, kể cả khi đó thật ra là mật khẩu);
chữ có dấu thuần chữ cái (`mật khẩu: không đổi`). Từ giữa nhãn và dấu `:` chỉ nhận danh sách đóng (wifi, admin, cửa, phòng…), nên `Mật khẩu gửi khách SĐT: 0901…` giữ nguyên. Mật khẩu có dấu cách mà không để trong nháy chỉ che được từ đầu.
**Thông tin khách (SĐT, CCCD/CMND, email, STK…) giữ nguyên văn** theo quyết định của chủ (xem đầu file). Lý do vẫn che bí mật kỹ
thuật: đó là an ninh hệ thống — một token/mật khẩu lọt vào báo cáo hay hàng duyệt là ai đọc được cũng dùng được để vào hệ thống,
trong khi nội dung bài học không cần chúng. Nội dung dài hơn 3500 ký tự được **tách phần** (`phần i/n`, nguồn có `part`/`parts`), người duyệt
đọc đủ; quá 12 phần mới cắt, phần cuối ghi `contentTruncated` + `omittedChars` và có cảnh báo `proposal_truncated`. Nguồn của đề xuất ≤ 2 KiB
dạng chữ jsonb (tên tool trong lý do ≤ 64 ký tự); `detectedAt` kẹp vào [lúc chạy − 365 ngày, lúc chạy] (mốc tương lai/năm 9999
lệch −14:00 không làm hỏng job). Mỗi đề xuất được kiểm đúng quy tắc của SQL trước khi ghi outbox (lệch ⇒ phát hiện
`proposal_dropped`, không gửi).

Một mục hỏng (dòng sổ lạ, skill/bộ nhớ không kiểm được, tin nhắn lệch khuôn) chỉ thành **phát hiện**/lỗi trong báo cáo, không làm
hỏng lần chạy; mục sổ được ghi "đã thấy" trước khi xử lý nên trạng thái luôn tiến. Mọi file ghi ra là JSON thuần ASCII
(`ensure_ascii`) — không thể hỏng vì lỗi mã hoá. Lỗi hệ thống (không ghi được đầu ra, gốc hồ sơ là symlink…) ⇒ mã ≠ 0 ⇒ cảnh báo
`OnFailure=`; gốc hồ sơ hỏng thì **không** ghi đè trạng thái. Phần việc chính không kiểm được (danh mục `catalog-names.mjs` hỏng, `state.db` của hồ sơ
người dùng thật không đọc được hoặc vắng, một bước quét chết, bộ skill chuẩn lỗi) ⇒ báo cáo và outbox vẫn ghi, trường `degraded` nêu lý do, mã 1, và mỗi lý do thành một cảnh báo trên trang duyệt
(khoá cố định theo lý do nên không thêm dòng mỗi tối). Mỗi hồ sơ tối đa 20 cảnh báo một lần kiểm, phần dư gộp thành một dòng `warnings_overflow` và chỉ nằm trong báo cáo trên máy chủ: sandbox gắn sai không đổ hàng loạt dòng vào kho bất biến.

### Đầu ra

Thư mục `/var/lib/ihome-hermes-learning-audit` (`StateDirectory`, 0750 nhóm `ihome-hermes`):

| Đường | Quyền | Nội dung | Ai đọc |
|---|---|---|---|
| `private/` | 0700 | `reports/learning-audit-<UTC>.json` (giữ 30), `latest.json`, `latest.txt` (tóm tắt tiếng Việt), `state.json` | chỉ `ihome-hermes-audit` (và root) |
| `outbox/` | 0750 | `learning-outbox-<UTC>.json` (0640, giữ 30): **chỉ** đề xuất + mỗi hồ sơ đã kiểm một mục (nhịp kiểm) | job nạp (`ihome-hermes`) |

Báo cáo đủ giữ 0600 trong `private/` 0700 vì có trích đoạn hội thoại của người dùng (câu "bó tay", câu hỏi ngay trước) và vị trí
các bí mật kỹ thuật đã bị che; hàng duyệt trên CRM chỉ nhận đề xuất. Stdout/journal của job kiểm: **một dòng JSON đếm số**
(`learning_audit`: số hồ sơ, đề xuất, phát hiện mức cao, "bó tay", lỗi) — không tiêu đề, không nội dung. Khoá chống trùng của đề
xuất = sha256(hồ sơ | loại | nguồn | nội dung chuẩn hoá) — ổn định giữa các lần chạy; tiêu đề luôn một dòng.

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
có trích đoạn tin nhắn của người dùng).

## Nạp vào CRM (`ingest.mjs`)

`ingest.mjs` đọc `outbox/` (không đọc `private/`, không đọc hồ sơ) và gọi `app_private.hermes_store_learning_ingest_v1(p jsonb)`
qua `store-transport.mjs` phạm vi `scope: 'learning'`, đăng nhập bằng login **riêng** `hermes_store_learning`:

- login này chỉ thuộc vai NOLOGIN `hermes_learning_ingest` (migration tạo vai; quyền được cấp riêng của vai là USAGE `app_private` + EXECUTE
  hàm nạp, không có quyền bảng), **không** thuộc `hermes_store_executor` của connector — lộ mật khẩu job nạp không mở được kho bền connector, và
  ngược lại login connector không còn quyền nạp. **Giới hạn thật:** như mọi vai, nó vẫn thừa hưởng EXECUTE của PUBLIC trên các hàm chưa thu quyền đó (đo
  production 01/11, bỏ hàm của extension: 119 hàm `public`/`app_private`, trong đó 67 DEFINER, 52 INVOKER vô hại); phía job, transport chỉ gửi đúng thao tác nạp, nhưng người cầm mật khẩu tự kết nối thì gọi
  được các hàm đó. Thu EXECUTE khỏi PUBLIC là việc riêng sau. Transport kiểm vai trước lệnh đầu (thuộc `hermes_learning_ingest`, không thuộc
  executor/postgres/service_role, không super/bypassrls). TLS xác minh, không `service_role`, không JWT người dùng, không khoá tĩnh mới;
- tenant nằm trong payload và SQL tự kiểm: người dùng là thành viên **đang hoạt động** của công ty và có trợ lý `ACTIVE`;
- **nhịp kiểm**: mỗi hồ sơ có ánh xạ gửi ít nhất một lời gọi mỗi lần chạy (kể cả 0 đề xuất) với `auditGeneratedAt` = mốc của
  outbox mới nhất có hồ sơ đó (không vượt "bây giờ"); SQL giữ mốc lớn nhất ⇒ trang CRM thấy "lần kiểm cuối" thật;
- **kiểm khuôn đúng như SQL** trước khi gửi: khoá 64 hex, loại trong danh sách đóng, tiêu đề/nội dung có chữ, độ dài theo ký tự
  (≤ 200/≤ 4000), không NUL/surrogate lẻ/ký tự điều khiển, nguồn ≤ 4096 B **dạng chữ jsonb** (đo khớp `octet_length(source::text)`
  của PostgreSQL — có test so với PGlite), `detectedAt` trong [−400 ngày, +1 ngày]. Mục lệch bị bỏ và báo `droppedInvalidKeys`;
- lô bị SQL từ chối (`store_rejected`) ⇒ gửi nhịp riêng (kiểm phần đầu lô) rồi **gửi lại từng đề xuất**: chỉ mục bị từ chối riêng
  mới bị bỏ (`droppedRejectedKeys`); phần đầu lô bị từ chối ⇒ `batch_header_rejected`. Lỗi tạm/chưa rõ kết cục: thử lại một lần;
- nạp lặp lại an toàn: trùng (công ty, khoá) bị bỏ qua; mỗi lần chạy gửi lại đề xuất của mọi outbox trong `replayDays` ngày
  (mặc định 7) — một tối nạp hỏng không làm mất đề xuất. Trùng với đề xuất **đã bỏ** không vào lại hàng chờ và được tách hai loại: `relearned` +
  `relearnedKeys` = lần kiểm mới nhất lại thấy bài học chủ đã bỏ (cần gỡ tay); `replayedRejected` = gửi bù outbox cũ hoặc cảnh báo chưa sửa,
  chuyện thường, chỉ đếm. Lô ≤ 25 đề xuất và ≤ 96 KiB.

Journal: một dòng JSON `learning_ingest` chỉ có số đếm, số thứ tự, dedupeKey (băm) — không nội dung, không mật khẩu. Sandbox của job
giấu `/etc/ihome-hermes/store-password`, `keys/`, `connector.json`, `/var/lib/ihome-hermes-connector`, hồ sơ Hermes và `private/`; job chỉ cần
`learning-audit.json`, `learning-store-password`, `store-ca.pem` và `outbox/`.
Mã thoát: `0` = xong; `1` = có lô lỗi, mục bị bỏ, outbox hỏng hoặc hồ sơ có ánh xạ vắng ở lần kiểm mới nhất (phần hợp lệ vẫn
nạp); `2` = cấu hình/bí mật sai; `3` = outbox quá cũ (`staleAfterHours`, mặc định 36: job kiểm đã ngừng). Mã ≠ 0 ⇒ `OnFailure=`.

## Cài đặt (điều phối viên — KHÔNG làm khi chưa có migration trên production)

Lệnh từng bước, điểm dừng lần chạy đầu và thứ tự rollback: runbook trong [PR #371](https://github.com/zxGreenxz/whiteboard-ihomecrm/pull/371).

1. **Schema**: áp `20261031041523_hermes_learning_proposals_v1.sql` rồi `20261101064441_hermes_store_learning_role.sql` qua lane
   (`npm run migrate:forward -- <file>` dry-run, review chéo, rồi `--apply`; [runbook](../../docs/engineering/MIGRATION_STRATEGY.md)). Migration đầu tạo
   vai NOLOGIN `hermes_learning_ingest`; migration sau tạo vai `hermes_store_learning` NOLOGIN, `INHERIT` (transport kiểm `pg_has_role(…, 'USAGE')`),
   5 cờ tắt, 3 trần thời gian, đúng một nhóm. Chưa áp thì trang báo "Máy chủ chưa có chức năng duyệt bài học".
2. **Bật login nạp** (chỉ production): sinh mật khẩu trên VPS vào `/etc/ihome-hermes/learning-store-password` (0600 `ihome-hermes`, không xuống dòng cuối)
   cùng file verifier SCRAM, rồi `scripts/hermes-learning-login.mjs --enable --verifier-file <file> --apply` chạy đúng một câu `ALTER ROLE … LOGIN PASSWORD`.
   Verifier không vào migration. `scripts/test-env/owners.mjs` đã khai login này (TEST dựng lại NOLOGIN).
3. **Web**: promote bản có tab "Bài học chờ duyệt". **Connector release** (`/opt/ihome-hermes/current`) phải chứa
   `infra/hermes-learning-audit/` và `store-transport.mjs` có phạm vi `learning` (bản main sau khi gộp PR này).
4. **User chạy kiểm**: `useradd --system --no-create-home --shell /usr/sbin/nologin --gid ihome-hermes ihome-hermes-audit`.
5. **Unit kiểm**: chép `ihome-hermes-learning-audit.service` và `ihome-hermes-learning-alert@.service` vào `/etc/systemd/system/`, `systemctl daemon-reload`,
   `systemd-analyze security ihome-hermes-learning-audit.service` để xem lại sandbox. **Chưa cài unit nạp**: đề xuất đã nạp là bất biến, nên lần chạy đầu phải quét outbox trước.
6. **Chạy kiểm và quét outbox** tại chỗ (runbook mục F): `systemctl show -p LoadState --value ihome-hermes-learning-ingest.service` phải là `not-found` trước khi start.
7. **Sau khi quét đạt mới cài phần nạp**: cấu hình (ID thật của công ty + tài khoản chủ trợ lý hồ sơ `owner`, projectRef/host thật như `connector.json`, không
   đưa vào repo; sửa từ `learning-audit.example.json`, `install -o ihome-hermes -g ihome-hermes -m 600 learning-audit.json /etc/ihome-hermes/learning-audit.json`; hồ sơ nghiệm thu `tkt/tkh/tkj` trỏ DB TEST ⇒ **không** khai ở đây),
   chép `ihome-hermes-learning-ingest.service` + `.timer`, `daemon-reload`, `systemctl start ihome-hermes-learning-ingest.service`, rồi `journalctl -u ihome-hermes-learning-ingest -n 5`
   (một dòng `learning_ingest`: `inserted`, `duplicates`, `rejectedDuplicates`, `dropped*`, `failures`). Kiểm trên web: tab "Bài
   học chờ duyệt" có đề xuất và dòng "Lần kiểm cuối". Nếu "Bó tay" báo không đọc được `state.db`: xem bản sao trong
   `PrivateTmp` và quyền `CAP_DAC_READ_SEARCH`. Nếu "KHÔNG KIỂM ĐƯỢC TÊN" vì node: kiểm `catalog-names.mjs` có trong bản phát
   hành và không import ngoài `/opt/ihome-hermes/current`.
8. **Bật lịch**: chép `ihome-hermes-learning-audit.timer`, `systemctl enable --now ihome-hermes-learning-audit.timer ihome-hermes-learning-ingest.timer` (20:40 và 20:55
   giờ VN, `Persistent=true`). Không dùng systemd thì cron tương đương (giờ máy UTC):
   `40 13 * * * root systemctl start ihome-hermes-learning-audit.service` và `55 13 * * * root systemctl start ihome-hermes-learning-ingest.service`.
9. **Cảnh báo**: `journalctl -p err -t ihome-hermes-learning` (dòng của `ihome-hermes-learning-alert@…`); chủ thấy trên web khi
   "lần kiểm cuối" quá 36 giờ.

## Vận hành sau khi chủ quyết định

- **Duyệt**: điều phối viên đưa bài học vào bộ skill chuẩn `ihome-crm-*` (repo `infra/hermes-skills/`, nạp qua
  `skills.external_dirs`) để mọi hồ sơ dùng, rồi gỡ bản local.
- **Bỏ**: gỡ khỏi trợ lý — skill: `docker exec hermes-owner hermes --profile owner curator rollback <ledgerId>` (trang duyệt hiện đủ mã này, cả ở
  lịch sử; xem trước bằng `hermes curator ledger`); bộ nhớ: xoá đúng mục (ngăn bằng `§`) trong `memories/*.md` của hồ sơ, có sao lưu.
- **Cảnh báo kiểm học**: Duyệt = đã xem và xử lý, Bỏ = không cần xử lý. Sửa xong (vd. bỏ tên tool chết) thì nội dung phát hiện đổi; còn nguyên thì cảnh báo
  đã quyết định không hiện lại.
- Đây là thao tác GHI trên VPS — chỉ điều phối viên làm, theo quy trình hạ tầng.

## Giới hạn đã biết

- Duyệt SAU (chủ chốt): curator ghi skill ngay sau phiên; job chỉ phát hiện và đưa đi duyệt, **không chặn trước** hiệu lực của bài
  học. Skill chuẩn ở `external_dirs` thì curator không sửa được.
- Phân loại "ghi CRM" là heuristic thận trọng (nghi thì đưa đi duyệt); mẫu "bó tay" có thể sót câu diễn đạt lạ. Che bí mật kỹ thuật
  là theo mẫu (có thể sót dạng lạ); vì đề xuất đã nạp bất biến, lần chạy đầu có điểm dừng quét outbox tại chỗ trong runbook.
- `hermes_member_v1` từ chối người thường thuộc từ 2 công ty trở lên (`hermes_ordinary_org_ambiguous`); super admin không bị chặn. An toàn theo mặc định, chưa sửa vì phải đổi logic quyền (đo production 01/11: 0 người thường bị chặn; xem việc sau trong PR).
- Tên chết lấy từ `catalog-names.mjs` của bản phát hành (PR #369); thiếu module ⇒ "KHÔNG KIỂM ĐƯỢC TÊN".
- Sandbox systemd và phần đọc `state.db` trong sandbox **chưa chạy thử trên VPS** (PR chỉ viết, không cài); bước 6–7 là lần kiểm đầu.
- Gỡ lịch: `systemctl disable --now ihome-hermes-learning-audit.timer ihome-hermes-learning-ingest.timer`; dữ liệu đề xuất ở CRM
  giữ nguyên làm lịch sử (bất biến).
