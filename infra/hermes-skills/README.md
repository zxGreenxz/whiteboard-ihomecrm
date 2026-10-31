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
| 2. Hướng dẫn chuẩn | SOUL + skill trong thư mục này | PR cùng connector | Cách dùng đúng tool hiện hành. Triển khai vào `skills.external_dirs` của hồ sơ: curator chỉ đọc (Hermes `tools/skill_usage.is_curation_eligible` trả False, `tools/skill_manager_guards.py` từ chối sửa). Khác lớp 3 thì theo lớp 2. |
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
| Nghỉ hưu một tool | Bảng nghỉ hưu của họ tool (`TASK_RETIRED_BY`, `EXPENSE_RETIRED_TOOLS`, `SCHEDULE_RETIRED_BY`) ⇒ `retiredToolNames()` tự có; thêm dòng ở bảng của `ihome-crm-ghi-chung`; tool thay là `crm_action_*` thì nêu tên cũ trong mô tả tool đó (giữ trần 2 000 B của ba tool). |
| Trang mới có thao tác ghi | Skill `ihome-crm-<trang>` + `PAGE_SKILLS` trong test. |
| Đổi tên / bỏ báo cáo | Dòng `report=…` trong skill. |

`catalog-names.mjs` (giữ nguyên tên hàm, cổng kiểm học tập import): `catalogToolNames()`, `catalogActionIds()`,
`catalogReportIds()`, `retiredToolNames()` (`{ tênCũ: { tool, action? } }`), `findCatalogMentions(text)`,
`checkCatalogMentions(text)` (lỗi theo dòng: `unknown_tool`, `retired_without_replacement`, `unknown_action`, `unknown_report`).

## Triển khai lên VPS

Điều kiện: bản phát hành connector dựng từ cả cây git (đang làm vậy: `/opt/ihome-hermes/releases/<sha>` có `infra/`, `RELEASE_SHA`).
Hai script chạy trên host bằng root, viết để chạy lại an toàn; đã chạy thử trên cây giả
([`official-skills-deploy.test.mjs`](../hermes-broker/official-skills-deploy.test.mjs): chạy khô ở mọi nền tảng, ghi thật trên
Linux/CI), chưa chạy trên VPS.

1. Phát hành connector như thường lệ (đổi `/opt/ihome-hermes/current`).
2. Đưa skill chuẩn vào hồ sơ — xem trước rồi làm:

   ```bash
   bash /opt/ihome-hermes/current/infra/hermes-skills/deploy.sh --profiles "owner tkt tkh tkj" --dry-run
   bash /opt/ihome-hermes/current/infra/hermes-skills/deploy.sh --profiles "owner tkt tkh tkj"
   ```

   Chép skill vào `/var/lib/ihome-hermes-profiles/owner/.hermes/ihome-official-skills/<sha>/ihome-crm/` (root:root, 0755/0644),
   đổi symlink `current` (đích tương đối), nối `skills.external_dirs: [/home/hermes/.hermes/ihome-official-skills/current]` vào
   `config.yaml` của từng hồ sơ (sao lưu ở `/root/ihome-hermes-skills-backups/<stamp>-<pid>/`). Kiểm hết trước khi đổi; lỗi thì không
   đổi gì. Chạy lại cùng bản ⇒ `KHÔNG ĐỔI GÌ`.
3. Sửa SOUL của từng hồ sơ: dòng "Skill có sẵn: `crm-room-communications` … `crm-task-management` …" phải trỏ sang các skill
   `ihome-crm-*` (SOUL v4.41 gọi đích danh hai skill cũ). Việc này ngoài PR này.
4. Cất hai skill tự học cũ (sau bước 2 và 3):

   ```bash
   bash /opt/ihome-hermes/current/infra/hermes-skills/archive-stale-local.sh --profiles "owner tkt tkh tkj"          # khô
   bash /opt/ihome-hermes/current/infra/hermes-skills/archive-stale-local.sh --profiles "owner tkt tkh tkj" --apply
   ```

   Dùng đúng lệnh Hermes `hermes --profile <p> curator archive <tên>` (qua `docker exec -u 10003:10003 hermes-owner`): thư mục vào
   `profiles/<p>/skills/.archive/<tên>`, `.usage.json` ghi archived, sổ `.curator_ledger.jsonl` ghi lại. Sao lưu tar + manifest ở
   `/root/ihome-hermes-skills-backups/archive-<stamp>-<pid>/` (sổ `archive-manifests.list`). Khôi phục: thêm `--restore --apply`
   (trả về đúng `productivity/<tên>`, ghim lại nếu lần cất gần nhất ghi đang ghim).

**Khởi động lại:** KHÔNG cần (khởi động lại `hermes-owner` làm gián đoạn Zalo).

- Skill: Hermes đọc `config.yaml` theo chữ ký file (mtime, size, inode, ctime) và quét lại skill ở lượt sau. Phiên đang chạy giữ
  system prompt cũ nhưng nhận ghi chú "skills changed … Now available / No longer available" ở lượt kế tiếp
  (`agent/skills_index_delta.py`).
- Đổi bản skill sau này (symlink `current` sang sha mới): Hermes nhớ đường dẫn external_dirs ĐÃ RESOLVE (sha cũ) theo chữ ký config
  ⇒ `deploy.sh` chạm `config.yaml` của các hồ sơ trỏ tới `current`. Bản sha cũ được giữ để lùi.
- SOUL: phiên đang chạy dùng lại nguyên system prompt đã lưu (`agent/conversation_loop._restore_or_build_system_prompt`), chỉ dựng
  lại khi đổi model / provider / thư mục làm việc. SOUL mới vào phiên MỚI hoặc khi phiên được nén; khởi động lại container không
  giúp.

**Lùi:** `deploy.sh --release /opt/ihome-hermes/releases/<sha-cũ> --profiles …` (symlink về bản cũ + chạm config); bỏ hẳn lớp 2 thì
chép lại `config.yaml` từ thư mục sao lưu; skill cũ: `archive-stale-local.sh --restore --apply`.

**Kiểm sau triển khai (chỉ đọc):** `ls -la /var/lib/ihome-hermes-profiles/owner/.hermes/ihome-official-skills/`;
`docker exec hermes-owner sh -c "ls /home/hermes/.hermes/ihome-official-skills/current/ihome-crm"`; khối `skills:` trong
`config.yaml`; nhắn thử ở hồ sơ TEST một câu giao việc ⇒ bot gọi `crm_action_list` / `crm_action_run` `task.create`.
