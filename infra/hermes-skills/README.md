# Hướng dẫn chuẩn CRM cho Hermes (skill `ihome-crm-*`)

Thư mục này là **lớp 2** của mô hình 3 lớp (chủ duyệt 31/10/2026): skill CRM chuẩn, phát hành cùng connector, Hermes chỉ đọc.

**Vì sao có:** 31/10 bot của chủ (hồ sơ `owner`, Zalo) không tạo được việc. Skill tự viết `crm-task-management` bảo bot tìm
`crm_task_create` / `crm_task_input_options` — hai tool đã nghỉ hưu từ 29/10 (giao việc nay là `crm_action_run` action
`task.create`). Curator của Hermes còn học thêm dòng sai đó vào skill. Gốc: kiến thức "dùng tool CRM thế nào" nằm trong sổ tay bot
tự viết, không gắn phiên bản với connector.

## Mô hình 3 lớp

| Lớp | Ở đâu | Ai sửa | Vai trò |
| --- | --- | --- | --- |
| 1. Luật cứng | connector (`infra/hermes-broker`) + DB | PR + migration | Quyền, khuôn tham số, xem trước / xác nhận, tool nghỉ hưu bị ẩn và bị từ chối. Bot hiểu sai thì máy chủ chặn. |
| 2. Hướng dẫn chuẩn | SOUL + skill trong thư mục này | PR cùng connector | Cách dùng đúng tool hiện hành. Triển khai vào `skills.external_dirs` của hồ sơ. Curator không chọn skill ngoài để sửa / cất (`tools/skill_usage.is_curation_eligible` trả False); `tools/skill_manager_guards.py` chỉ chặn XOÁ. Bảo vệ thật là file root:root 0644 — tiến trình Hermes (uid 10003) không ghi được (`deploy.sh` từ chối `--owner` trùng uid đó). Khác lớp 3 thì theo lớp 2. |
| 3. Tự học | curator + bộ nhớ Hermes (vẫn bật) | bot | Kinh nghiệm riêng; có thể lỗi thời. Cổng kiểm học tập đối chiếu với connector bằng `infra/hermes-broker/catalog-names.mjs`. |

## Nội dung

| Skill | Phạm vi |
| --- | --- |
| `ihome-crm-ghi-chung` | Thứ tự ưu tiên; luật "gọi `crm_action_list` trước khi nói không làm được"; vòng ghi `crm_action_list` → `crm_action_run` (xem trước, xác nhận, `requestId`, `crm_action_status`); bảng tool nghỉ hưu → tool thay. |
| `ihome-crm-cong-viec` | Trang Công việc: `task.*`, theo dõi `crm_task_follow_*`, đọc việc. |
| `ihome-crm-hop-dong` | Trang Hợp đồng: `contract.*` (báo trả, giữ phòng, gia hạn, trả phòng, người ở, nháp). |
| `ihome-crm-hoa-don` | Trang Hoá đơn: `invoice.*` (thu tiền, chỉ số, điều chỉnh, huỷ / khôi phục). |
| `ihome-crm-thu-chi` | Trang Thu chi: `expense.*` và các khoản phải chặn sang web. |
| `ihome-crm-phong-sale-nhom` | Phòng trống, trang Sale, tin pass, `crm_sale_action`, gửi nhóm, gửi ảnh phòng trống. |

`DESCRIPTION.md` là mô tả nhóm `ihome-crm` (Hermes hiện ở đầu nhóm trong chỉ mục skill). Luật Hermes cho `SKILL.md` (đọc trong
container 31/10): frontmatter YAML có `name` (= tên thư mục) và `description`; chỉ mục skill cắt mô tả dài hơn 60 ký tự ⇒ mô tả
một câu ≤ 60 ký tự, kết thúc bằng dấu chấm; có mục `## When to Use`; không nhắc lệnh shell trong văn.

## Đổi tool connector ⇒ sửa skill chuẩn trong CÙNG PR

CI chặn nếu lệch: [`infra/hermes-broker/official-skills.test.mjs`](../hermes-broker/official-skills.test.mjs) (suite node-native;
`tooling/test-matrix.json` chọn test này khi đổi `infra/hermes-skills/**`) đỏ khi:

- skill nhắc tên tool `crm_…`, mã thao tác `<trang>.<thao tác>` hay `report=<mã>` không còn trong danh mục rút từ module thật;
- nhắc tên tool nghỉ hưu mà cùng dòng không có tool thay (và mã thao tác thay);
- bảng nghỉ hưu của `ihome-crm-ghi-chung` thiếu một tên, hoặc skill của trang thiếu một mã thao tác của trang;
- trang mới có thao tác ghi mà chưa có skill; frontmatter sai luật Hermes; mô tả `crm_action_run` / `crm_action_status` thiếu tên
  tool cũ mà chúng thay, hoặc `crm_action_list` mất từ khoá ý định có dấu / không dấu.

Việc cần làm theo loại thay đổi:

| Thay đổi | Sửa |
| --- | --- |
| Thêm / bớt thao tác của trang | Skill của trang (nêu mã + tham số chính). |
| Nghỉ hưu một tool | Bảng nghỉ hưu của họ tool (`TASK_RETIRED_BY`, `EXPENSE_RETIRED_TOOLS`, `SCHEDULE_RETIRED_BY`) ⇒ `retiredToolNames()` tự có; thêm dòng ở bảng của `ihome-crm-ghi-chung`; tool thay là `crm_action_*` thì nêu tên cũ trong mô tả tool đó. **Trần 2 000 B của họ `crm_action_*` trong tools/list đã gần chạm** (31/10: ba tool 1 997 B, tính cả dấu phẩy 1 999 B — còn 1 B) ⇒ thêm một tên cũ nữa thì phải co mô tả chỗ khác trong cùng PR (`action-tools-budget.test.mjs` / `action-contract.test.mjs` đỏ nếu vượt). |
| Trang mới có thao tác ghi | Skill `ihome-crm-<trang>` + `PAGE_SKILLS` trong test. |
| Đổi tên / bỏ báo cáo | Dòng `report=…` trong skill. |

`catalog-names.mjs` (giữ nguyên tên hàm, cổng kiểm học tập import): `catalogToolNames()`, `catalogActionIds()`,
`catalogReportIds()`, `retiredToolNames()` (`{ tênCũ: { tool, action? } }`), `findCatalogMentions(text)`,
`checkCatalogMentions(text)` (lỗi theo dòng: `unknown_tool`, `retired_without_replacement`, `unknown_action`, `unknown_report`).

## Triển khai lên VPS

Điều kiện: bản phát hành connector dựng từ cả cây git, có `infra/hermes-skills/` và `RELEASE_SHA` (danh sách file release ở
[HOST_SERVICE.md](../hermes-runtime/HOST_SERVICE.md#release-package)). Hai script chạy trên host bằng root, viết để chạy lại an toàn;
đã chạy thử trên cây giả ([`official-skills-deploy.test.mjs`](../hermes-broker/official-skills-deploy.test.mjs): chạy khô ở mọi
nền tảng, ghi thật trên Linux/CI), chưa chạy trên VPS.

**Mỗi nhóm hồ sơ một symlink, theo đúng connector của nhóm:** `owner` (connector production 8740) dùng `--link current` với release
`/opt/ihome-hermes/current`; hồ sơ TEST `tkt tkh tkj` (connector 8741) dùng `--link test` với release `/opt/ihome-hermes-test/current`.
`deploy.sh` dừng nếu đổi một link mà có hồ sơ ngoài `--profiles` đang trỏ tới.

1. Phát hành connector như thường lệ (đổi `/opt/ihome-hermes/current`, `/opt/ihome-hermes-test/current`).
2. Đưa skill chuẩn vào hồ sơ — xem trước rồi làm:

   ```bash
   S=/opt/ihome-hermes/current/infra/hermes-skills
   bash $S/deploy.sh --profiles "tkt tkh tkj" --link test --release /opt/ihome-hermes-test/current --dry-run
   bash $S/deploy.sh --profiles "tkt tkh tkj" --link test --release /opt/ihome-hermes-test/current
   bash $S/deploy.sh --profiles "owner" --dry-run
   bash $S/deploy.sh --profiles "owner"
   ```

   Chép skill vào `/var/lib/ihome-hermes-profiles/owner/.hermes/ihome-official-skills/<sha>/ihome-crm/` (root:root, 0755/0644),
   đổi symlink `<link>` (đích tương đối), nối `skills.external_dirs: [/home/hermes/.hermes/ihome-official-skills/<link>]` vào
   `config.yaml` từng hồ sơ (kiểm YAML bằng PyYAML hoặc js-yaml của release — ghi thật mà không kiểm được thì dừng; sao lưu ở
   `/root/ihome-hermes-skills-backups/<stamp>-<pid>/` chỉ để đối chiếu). Kiểm hết trước khi đổi; lỗi thì không đổi gì. Chạy lại
   cùng bản ⇒ `KHÔNG ĐỔI GÌ`.
3. SOUL v4.42 (điều phối viên làm, ngoài PR này) cho mọi hồ sơ: dòng 32 "Skill có sẵn: `crm-room-communications` …
   `crm-task-management` …" trỏ sang `ihome-crm-*`; dòng 31 (luật cũ `crm_task_create` khi không có `task.create`) và dòng 10
   (`crm_expense_input_options`, đã gỡ) bỏ hoặc sửa.
4. **Mở phiên mới cho `owner`** (`/new` trong Zalo, cần `/approve`): phiên `owner` chạy từ 17/10 còn giữ system prompt với SOUL cũ
   (gọi `skill_view crm-task-management`). Smoke ngay trên `owner` nhưng **CHỈ ĐỌC** (Contract §2: org thật chỉ đọc): hỏi "em giao
   việc được không? giữ phòng được không?" ⇒ bot gọi `crm_action_list`, trả lời theo `items` / `notPermitted` (thấy `task.create`,
   `contract.room_lock`), **không gọi `crm_action_run`**. `task.create` và `contract.room_lock` là `confirm: if_required` với chính
   sách DB `never` ⇒ gọi là ghi thật ngay (giao việc thật, khoá phòng thật), không có bản xem trước để dừng. Thao tác `confirm:
   always` (vd phiếu chi) trên `owner` chỉ tới bản xem trước, **không xác nhận** (đáp "thôi"). Smoke ghi thật (giao việc, giữ / bỏ
   giữ phòng) làm trên hồ sơ TEST `tkt` / `tkh` / `tkj` (connector 8741, DB TEST).
5. Cất hai skill tự học cũ (sau bước 2–4):

   ```bash
   bash $S/archive-stale-local.sh --profiles "owner tkt tkh tkj"          # khô
   bash $S/archive-stale-local.sh --profiles "owner tkt tkh tkj" --apply
   ```

   `--apply` TỪ CHỐI khi `profiles/<p>/SOUL.md` còn gọi tên skill sắp cất. Dùng đúng lệnh Hermes `hermes --profile <p> curator
   archive <tên>` (qua `docker exec -u 10003:10003 hermes-owner`): thư mục vào `profiles/<p>/skills/.archive/<tên>`, `.usage.json`
   ghi archived, sổ `.curator_ledger.jsonl` ghi lại. Sao lưu tar + manifest ở `/root/ihome-hermes-skills-backups/archive-<stamp>-<pid>/`
   (sổ `archive-manifests.list`). Khôi phục: thêm `--restore --apply` (trả về đúng `productivity/<tên>`, ghim lại nếu lần cất gần
   nhất ghi đang ghim).

**Khởi động lại:** KHÔNG cần (khởi động lại `hermes-owner` làm gián đoạn Zalo).

- Skill: Hermes đọc `config.yaml` theo chữ ký file (mtime, size, inode, ctime) và quét lại skill ở lượt sau. Phiên đang chạy giữ
  system prompt cũ nhưng nhận ghi chú "skills changed … Now available / No longer available" ở lượt kế tiếp
  (`agent/skills_index_delta.py`).
- Đổi bản skill sau này (symlink sang sha mới): Hermes nhớ đường dẫn external_dirs ĐÃ RESOLVE (sha cũ) theo chữ ký config
  ⇒ `deploy.sh` chạm `config.yaml` của các hồ sơ trỏ tới link đó. Bản sha cũ được giữ để lùi.
- SOUL: phiên đang chạy dùng lại nguyên system prompt đã lưu (`agent/conversation_loop._restore_or_build_system_prompt`), chỉ dựng
  lại khi đổi model / provider / thư mục làm việc. SOUL mới vào phiên MỚI hoặc khi phiên được nén; khởi động lại container không
  giúp.

**Lùi:**

- Về bản skill cũ: `deploy.sh --release <release-cũ> --profiles … [--link …]` (symlink về sha cũ + chạm config).
- Bỏ hẳn lớp 2 của một hồ sơ: `deploy.sh --remove --profiles … [--link …]` gỡ khối `skills` khi nó đúng bằng
  `{external_dirs: [/home/hermes/.hermes/ihome-official-skills/<link>]}` — kể cả khi Hermes / `yaml.dump` đã ghi lại config (mất dòng
  chú thích, đổi thụt lề, đổi thứ tự khoá; bộ kiểm YAML xác nhận). Khối có thêm mục / khoá ⇒ dừng, gỡ tay. KHÔNG chép đè
  `config.yaml` từ sao lưu: header `Authorization` có thể đã được xoay sau đó ⇒ MCP 401, bot mất CRM.
- Skill cũ: `archive-stale-local.sh --restore --apply`.

**Kiểm sau triển khai (chỉ đọc):** `ls -la /var/lib/ihome-hermes-profiles/owner/.hermes/ihome-official-skills/`;
`docker exec hermes-owner sh -c "ls /home/hermes/.hermes/ihome-official-skills/current/ihome-crm"`; khối `skills:` trong
`config.yaml`; smoke ở bước 4.
