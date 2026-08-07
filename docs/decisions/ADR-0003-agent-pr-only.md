---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - docs/engineering/PROJECT_CONTRACT.md
  - .github/workflows/ci-gates.yml
  - .github/workflows/supabase-migrate.yml
  - .github/workflows/network-center-validation.yml
  - .github/pull_request_template.md
  - scripts/check-no-auto-apply.mjs
  - scripts/check-external-controls.mjs
  - scripts/apply-reviewed-migration.mjs
  - docs/generated/external-controls.json
  - tooling/program-status.json
  - vercel.json
copilot_ingest: false
risk: security
---

# ADR-0003 — Đường phát hành tách khỏi `main`; agent không có đường tự động chạm production

**Trạng thái:** đã áp dụng (2026-08-06) · **Thay thế:** mô hình cũ "push `main` = phát hành"

Luật thường ngày ở [`docs/engineering/PROJECT_CONTRACT.md`](../engineering/PROJECT_CONTRACT.md) §3
(phát hành) và §4–5 (ghi database). Trang này chỉ ghi **vì sao** chọn như vậy và **cái gì vẫn hở**.

---

## 1. Sửa lại tên file trước đã

Tên `agent-pr-only` **không mô tả đúng luật đang chạy**. Contract §3 nói ngược lại, nguyên văn dòng 67:

> Agent **được** tự commit, push `main`, và tự promote khi gate xanh. Không cần hỏi.

Chủ dự án chọn **tự động hoàn toàn**; điểm dừng là **máy**, không phải người (Contract §3:64). Không có
gate nào bắt agent phải mở PR, và cũng **không thể** có — xem §3 dưới đây. Vậy quyết định thật sự là:

> Agent không bị chặn khỏi việc *đẩy code*. Agent bị chặn khỏi hai thứ khác hẳn:
> **(a)** một cú `push main` không còn tự biến thành bản phát hành; **(b)** đường ghi vào
> database production đòi một bí mật mà vault **không** có.

---

## 2. Quyết định

### 2.1 Nhánh phát hành tách khỏi `main`

- Nhánh `origin/production` được tạo trỏ vào `bb0bc3ba` — nguồn: `tooling/program-status.json:106-107`.
  *CHƯA KIỂM CHỨNG:* thời điểm tạo ref không nằm trong git history (ref push không sinh commit),
  nên không xác nhận được bằng lệnh, chỉ có ghi chép này.
- Trước khi flip, `origin/production` được fast-forward lên `ac4c8a59` để nhánh phát hành không trỏ
  vào code cũ hơn `main`. Kiểm được: `git merge-base --is-ancestor bb0bc3ba ac4c8a59` → đúng;
  `git ls-remote --heads origin production` → `ac4c8a59…`.
- **Commit ghi lại việc tách: `18dd17bb`, 2026-08-06 07:38:55 +0700**,
  `chore(release): Vercel đã theo dõi nhánh production — push main không còn là phát hành`.
  Commit đó đổi 7 file (AGENTS/CLAUDE/README/PROJECT_CONTRACT + `docs/generated/external-controls.json`
  + `tooling/known-gaps.yaml` + `tooling/program-status.json`) và **đóng** gap
  `vercel-production-branch-not-flipped`.

Từ đó: `push main` → Preview; production chỉ đổi khi có commit lên nhánh `production`
(promote: `git push origin origin/main:production`, Contract §3:75).

### 2.2 Ghi production database đòi promotion token nhập lúc chạy

`scripts/apply-reviewed-migration.mjs` là đường apply duy nhất sau cutoff, và `--apply` chết ngay nếu
thiếu biến môi trường (`apply-reviewed-migration.mjs:140-148`):

```
❌ Thiếu IHOMECRM_PROMOTION_TOKEN.
   Ghi production đòi token nhập TẠI THỜI ĐIỂM CHẠY, không lấy từ CLAUDE.local.md.
   Đây là chỗ duy nhất biến 'chỉ con người mới phát hành' thành cơ chế thật —
   PAT trong vault cho phép ghi production bất cứ lúc nào mà không ai hay.
```

**Vì sao token phải nhập tay, không nằm trong vault:** cùng file đó, `readPat()` (dòng 40-48) đọc thẳng
`sbp_…` từ `CLAUDE.local.md` khi không có `SUPABASE_PAT`. Tức là **quyền ghi production đã nằm sẵn
trong repo của máy dev** — một agent có thể dùng nó bất cứ lúc nào mà không ai hay. Nếu promotion token
cũng nằm trong vault thì nó chỉ là biến môi trường thứ hai đọc từ cùng một file, và lớp chặn bằng không.
Token phải đến từ **ngoài** hệ thống mà agent đọc được, nếu không thì câu "chỉ con người mới phát hành"
vẫn chỉ là lời văn. Contract §11:434 liệt kê "ghi database production bằng PAT sẵn trong vault, không có
promotion token" là việc agent **không được** tự làm.

Cùng đường đó còn hai cửa nữa: version phải **sau** cutoff trong `supabase/migration-policy.json`, và
sha256 phải khớp `supabase/migration-provenance.json` (file bị sửa sau review ⇒ chặn). Backup là **cửa
chặn, không phải lời nhắc**: `bk.status !== 0` ⇒ không apply (dòng 176-187). Lối thoát `--khong-backup`
còn đó nhưng bắt buộc kèm lý do và lý do bị in ra — bỏ qua được, không im lặng được.

### 2.3 CI không bao giờ tự apply migration

`scripts/check-no-auto-apply.mjs` chạy ở **cả ba** workflow: `ci-gates.yml:110`,
`network-center-validation.yml:275`, `supabase-migrate.yml:44`. Đo 07/08/2026 tại `7965c6a6`:

```
$ node scripts/check-no-auto-apply.mjs
✅ 3 file YAML (workflow + composite action): không có bước nào tự apply migration.
```

`supabase-migrate.yml:3-13` giải thích cái giá nếu bỏ gate này: ledger
`supabase_migrations.schema_migrations` đang tụt sau production, nên một lần apply tự động sẽ **replay
lại** bộ 2026-07-20/21 vốn đã hand-apply — tức làm hỏng chính sổ sách nó định cập nhật.

---

## 3. Vì sao required check của GitHub KHÔNG bật được

Repo `zxGreenxz/whiteboard-ihomecrm` là **private trên GitHub Free**, tier không có branch protection.
`scripts/check-external-controls.mjs:67-74` mã hoá đúng điều này: HTTP 404 ở endpoint
`repos/…/branches/main/protection` được đọc là `absent`, kèm ghi chú *"Repo private trên GitHub Free
không dùng được tính năng này — lớp chặn phải nằm ở Vercel"*.

Hệ quả dây chuyền, đều đã ghi trong repo:

- Không có required status check ⇒ **không cách nào bắt "gate xanh rồi mới promote" bằng máy**. Thứ tự
  đó do người/agent tự giữ. Đây là lý do Contract §3 phải viết ra thành luật thay vì cấu hình.
- Không có required review ⇒ `CODEOWNERS` vô dụng (một owner duy nhất). Thay bằng
  `tooling/risk-map.json`, cờ `crossReview: true` — một agent thứ hai soi độc lập, không phải cơ chế
  enforce. Đo được **4** tier bật cờ (`money`, `authorization`, `migration`, `infrastructure`), trong
  khi `notes` của chính file đó (dòng 116) viết "chỉ áp cho **ba** tier cao nhất". Con số trong văn bản
  đã trôi; `.github/pull_request_template.md:24-27` khớp với 4.
- Ranh giới deploy của Vercel trở thành **kiểm soát cứng duy nhất khả thi** (nguyên văn
  `check-external-controls.mjs:111`). Ai gạt Branch Tracking về `main` trong dashboard là gỡ sạch lớp
  chặn, lặng lẽ.

---

## 4. Án lệ — hai lần gate tự nói dối

Ghi lại vì cả hai đều là gate **về chính chủ đề trang này** và cả hai đều xanh trong lúc hỏng.

**`bd49c7f5` (07/08/2026) — tắt hết kiểm soát ngoài repo thì báo cáo SẠCH HƠN bật.**
`check-external-controls` chỉ phủ trường hợp *không gọi được* control (thiếu token, 404). Trường hợp
*gọi được và câu trả lời cho thấy control đang tắt* thì lọt sạch: project deploy production thẳng từ
`main` vẫn in ✅ kèm dòng `ihomecrm → production branch: main` như thể bình thường. Branch protection
rỗng ruột (`requiredChecks=[]`, `requiredApprovals=0`, `enforceAdmins=false`, cho cả force-push) cũng
ra `present` — ba con số đó **được tính rồi ghi vào JSON nhưng không tham gia phán quyết**. Gate báo
cáo giá trị chứ không so giá trị với kỳ vọng. Sửa: thêm trạng thái `failed`/`hollow`, so với hằng
`NHANH_PHAT_HANH` (dòng 36), coi `projects=[]` là `unverified`, và hỏi remote bằng `git ls-remote`
thay vì `rev-parse` ref local.

Bản sửa còn **tách đôi ngưỡng exit** — chi tiết dễ đọc nhầm nên ghi rõ: `unverified` vẫn exit 0 (lý lẽ
cũ vẫn đúng — xem bảng §5), nhưng `failed`/`hollow` thì **exit 1** (`check-external-controls.mjs:240-245`).
Ranh giới là "chưa kiểm được" so với "đã kiểm và thấy tắt": im lặng ở vế thứ hai là tệ nhất trong ba
lựa chọn.

**`1bf587bb` (07/08/2026) — gate chặn auto-apply bỏ lọt 7/10 cách viết.**
Cửa chặn hệ quả nặng nhất repo, và nó **không có test nào**. Bản cũ đọc YAML từng dòng thô nên không
bao giờ dựng lại được lệnh runner thật sự chạy: `run: >` folded scalar, nối dòng bằng `\`, plain
multiline scalar, `npx supabase@2.20.5 db push` (regex `\bsupabase\s+db` vỡ vì ký tự `@`),
`db reset --db-url "$PROD"`, `echo "$(supabase db push)"`, và composite action trong `.github/actions/`.
Sửa bằng `js-yaml` + 13 test hồi quy (đỏ 7/13 trên gate cũ).

Bài học chung của cả hai: **một gate không có test đối chứng bằng đột biến thì không phải bằng chứng.**

---

## 5. Khoảng trống — đo được, chưa đóng

| Khoảng trống | Bằng chứng |
|---|---|
| Bằng chứng máy đọc **chưa từng** xác nhận việc flip Vercel | `docs/generated/external-controls.json` `checkedAt: 2026-08-06T00:36:37.266Z`, `vercelProductionBranch.status = "unverified"`. File này được ghi lại **trong chính commit flip `18dd17bb`** mà vẫn `unverified` — thiếu `VERCEL_TOKEN`. Việc flip hiện chỉ có lời văn (commit message + `program-status.json:86-87`) làm chứng. |
| Chạy lại 07/08/2026 vẫn thế | `node scripts/check-external-controls.mjs` → 2 `unverified`, exit 0. Script **cố ý** không exit 1 khi thiếu token (Contract §3:99-100, nguyên văn): gate đỏ vì thiếu credential sẽ bị tắt đi, và khi ấy mất luôn khả năng nhìn. Ngưỡng này **chỉ** áp cho `unverified` — `failed`/`hollow` vẫn exit 1, xem §4. |
| Đường promote **không kích gate nào** | Cả ba workflow chỉ nhận `push` vào `main`/`release/*`/`master` (`ci-gates.yml:30-33`, `network-center-validation.yml:29-30`, `supabase-migrate.yml:16-17`). Promote là **push thẳng** (`git push origin origin/main:production`) ⇒ không workflow nào khởi động. *Đính chính một cách nói dễ sai:* không phải "nhánh `production` không tồn tại với CI" — `ci-gates.yml:28` và `network-center-validation.yml:45` có `pull_request:` **không lọc nhánh**, nên một PR *nhắm vào* `production` vẫn chạy; chỉ là đường promote thật không đi qua PR. Không workflow nào có bước deploy (`grep -rni vercel .github/workflows/` → 0 kết quả) — Vercel deploy qua Git integration, ngoài tầm CI. |
| *(đang có người vá, CHƯA COMMIT)* job `production-promotion` | Cây làm việc tại `7965c6a6` có `.github/workflows/ci-gates.yml` **đã sửa nhưng chưa commit**: thêm job `production-promotion` (`if: github.ref == 'refs/heads/production' \|\| github.event_name == 'workflow_dispatch'`) chạy `scripts/check-production-promotion.mjs` — file này cũng còn `??` trong `git status`. **Không có trong HEAD.** Đo được ở dạng đang viết: job vẫn **không** chạy khi push vào `production`, vì `on.push.branches` không liệt kê `production` nên workflow không khởi động; còn với `pull_request` thì `github.ref` là `refs/pull/N/merge` nên điều kiện `if` sai. Chỉ `workflow_dispatch` thủ công là chạy được. Ghi lại để lần commit sau không tưởng khoảng trống đã đóng. |
| production đang sau main **96 commit** | `git rev-list --left-right --count origin/main...origin/production` → `96 0` (đo 07/08/2026 tại `7965c6a6`). `origin/production` = `ac4c8a59`, `origin/main` = `7965c6a6`. Con số này trôi theo mỗi commit vào `main` — chạy lại lệnh trên, đừng tin số in ở đây. |
| PITR **tắt** ⇒ RPO ~24 giờ | Contract §4; `apply-reviewed-migration.mjs:22` và `:158-161`. Bản dump chụp ngay trước apply là điểm khôi phục **duy nhất**. |
| `.github/pull_request_template.md:53` còn câu lạc hậu | Nguyên văn: `<!-- Chừng nào Vercel còn deploy từ main thì push = phát hành. -->` — sai kể từ `18dd17bb`. |

---

## 6. Đã cân nhắc và bỏ

- **Nâng gói GitHub để có branch protection** — không tìm thấy ghi chép nào về việc đã cân nhắc chi phí.
  *CHƯA KIỂM CHỨNG:* không có commit/issue nào trong repo bàn về việc này.
- **Bắt agent chỉ được mở PR** — mâu thuẫn với lựa chọn "tự động hoàn toàn" của chủ dự án
  (Contract §3:64), và với một owner duy nhất thì PR không tạo ra reviewer thứ hai. Thay bằng
  `crossReview` trong `tooling/risk-map.json` — *"bắt buộc cho mọi thay đổi sẽ làm mọi việc chậm gấp
  đôi mà không tăng an toàn tương xứng"* (`risk-map.json:116`).
- **Để CI tự apply migration** — xem §2.3, sẽ replay bộ đã hand-apply.
