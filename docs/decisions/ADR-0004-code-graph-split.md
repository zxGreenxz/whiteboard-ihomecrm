---
status: current
reviewed: 2026-08-07
last_verified_commit: 7965c6a6
source_paths:
  - tooling/agent-tools.json
  - tooling/graph-policy.json
  - tooling/graph-manifests/ua.json
  - tooling/known-gaps.yaml
  - tooling/program-status.json
  - scripts/run-pinned-gitnexus.mjs
  - scripts/check-graph-hygiene.mjs
  - scripts/check-graph-freshness.mjs
  - scripts/__tests__/check-graph-governance.test.mjs
  - docs/engineering/PROJECT_CONTRACT.md
  - .github/workflows/ci-gates.yml
  - .ua/meta.json
  - .gitnexus/gitnexus.json
  - .gitnexus/manifest.json
copilot_ingest: false
risk: normal
---

# ADR-0004 — Tách hai công cụ tri thức: GitNexus và Understand Anything

**Trạng thái:** đã áp dụng (07/08/2026) · **Luật văn bản:** [`PROJECT_CONTRACT.md` §12](../engineering/PROJECT_CONTRACT.md)
— sáu luật nằm ở đó, trang này KHÔNG chép lại, chỉ giải thích *vì sao* và ghi *trạng thái đo được*.

`copilot_ingest: false` vì AI Copilot chỉ đọc file được khai trong `docs/he-thong/manifest.json`
(`scripts/check-copilot-docs-manifest.mjs`), và trang này không nằm trong thư mục đó.

---

## 1. Vấn đề

Graph tri thức là thứ agent đọc rồi **tin theo**. Kiểu hỏng của nó không giống test đỏ:

> Một graph cũ không báo lỗi. Nó trả lời trôi chảy — chỉ là trả lời về một codebase đã không còn
> tồn tại. *(`scripts/check-graph-freshness.mjs:6-12`)*

Đo thật lúc viết trang này (`node scripts/check-graph-freshness.mjs`, HEAD `7965c6a6`): graph UA
không có node nguồn nào cho **18 tiểu hệ thống**, gồm trọn vẹn Network Center và OpenClaw. Hỏi nó
"repo có những tiểu hệ nào" thì nó kể thiếu — một cách tự tin, và **không nói là nó đang thiếu**.

## 2. Quyết định

Dùng **hai** công cụ với hai vai trò tách hẳn, không phải một công cụ vạn năng:

| | GitNexus | Understand Anything (UA) |
|---|---|---|
| Artifact | `.gitnexus/` — **local-only**, `.gitignore:41` | `.ua/` — **commit vào repo** |
| Hộ chiếu | `.gitnexus/manifest.json` (sinh tự động, cũng local) | `tooling/graph-manifests/ua.json` (viết tay, bị đối chiếu) |
| Cửa vào | `scripts/run-pinned-gitnexus.mjs` — cửa DUY NHẤT | chạy tay, chưa có wrapper |
| Việc | code exploration, impact analysis TS/JS | onboarding, domain map, tài liệu |
| Freshness | **cửa chặn cứng** cho task medium/high-risk | **mặc định cảnh báo** |

Ưu tiên khi ba nguồn mâu thuẫn — khai tường minh trong `tooling/graph-policy.json:41`:

```
contract-manifests-and-sql-harness  >  gitnexus  >  ua
```

## 3. Vì sao GitNexus cứng còn UA chỉ cảnh báo

Sự bất đối xứng này **cố ý**, và lý do là chi phí refresh chứ không phải chất lượng công cụ:

- **GitNexus rẻ để làm tươi.** Chỉ mục nằm ngoài git, regenerate không cần review của ai. Đo trên
  máy này: `.gitnexus/` chiếm **496 MB** (`du -sh`), riêng `.gitnexus/lbug` là **387.170.304 byte** —
  con số này chính là lý do nó không bao giờ được commit. Đòi nó tươi là đòi được.
  *(CHƯA KIỂM CHỨNG: header `check-graph-freshness.mjs:15` ghi "regenerate trong ~53 giây"; tôi
  không chạy lại `analyze` để đo, nên coi đó là lời khai của tác giả script.)*
- **UA đắt để làm tươi.** Artifact đã commit: `knowledge-graph.json` **4.550.396 byte** +
  `fingerprints.json` **2.583.512 byte** (`git cat-file -s` trên blob đang track) = **7.133.908 byte
  ≈ 6,8 MiB**. Refresh là một PR với ngần ấy JSON trong diff. Nếu để CI đỏ mỗi lần nó cũ thì kết
  cục quen thuộc là **người ta tắt gate
  đi** — và lúc đó không còn cả cảnh báo. Ghi rõ ở `check-graph-freshness.mjs:17-20` và ở comment
  của bước CI `.github/workflows/ci-gates.yml:132-137`.

Đổi lại, UA **vẫn cứng** với đúng bốn nhiệm vụ mà graph LÀ nguồn sự thật, ánh xạ ở
`tooling/graph-policy.json:8-15`: `onboarding`, `architecture`, `domain-review`, `generated-docs`.
`medium-risk`/`high-risk` ánh xạ sang `gitnexus`.

```bash
node scripts/check-graph-freshness.mjs                        # cảnh báo, exit 0 dù cũ
node scripts/check-graph-freshness.mjs --nhiem-vu onboarding  # cửa chặn, exit 1 khi UA cũ
```

Mã thoát **0 / 1 / 3** — số 3 nghĩa là "KHÔNG kiểm được", và nó khác 0 có chủ ý: repo shallow,
artifact không tự nhất quán, `fingerprints.files` rỗng đều ra 3 chứ không âm thầm thành "đạt"
(`check-graph-freshness.mjs:25-26`). Khi thoát 3, script **xoá luôn** `tooling/graph-verdict.local.json`
để không ai dùng một phán quyết lỗi thời tưởng còn hiệu lực (`:108-113`).

## 4. Vì sao contract manifest + SQL harness thắng CẢ HAI graph

Cả hai graph đọc **mã nguồn trong worktree**. Không cái nào biết object nào đang thật sự deploy trên
database: RLS policy, trigger, chuỗi tên RPC, quyền runtime. Contract §12 gọi thẳng đó là khoảng
trống và nói được bù bằng contract manifest + SQL harness, **không** bằng graph.

Luật này không kiểm bằng máy được (nó nói về việc *tin cái nào hơn*), nên thứ được cưỡng chế là:
**câu luật còn nằm đó**. `scripts/check-graph-hygiene.mjs:39-43` ghim nguyên văn ba dòng trong
Contract, mất một dòng là gate đỏ:

- `## 12. Công cụ tri thức`
- `Contract manifest + SQL harness LUÔN ưu tiên hơn mọi graph`
- `Agent KHÔNG được nạp graph khi chưa có verdict còn hiệu lực`

Cùng kỹ thuật với `MIEN_TRU` trong `check-agent-contract.mjs`. Chuỗi ưu tiên được in ra mỗi lần chạy
freshness (`check-graph-freshness.mjs:254`) và ghi vào verdict (`:269`).

## 5. Trạng thái đo được — 07/08/2026, HEAD `7965c6a6`

Chạy `node scripts/check-graph-freshness.mjs`, nguyên văn:

```
  UA        : STALE — cũ 508 commit · 1381 file đổi · thiếu 122 migration · 18 tiểu hệ vắng mặt
  GitNexus  : FRESH — cũ 21 commit
```

**Bốn con số này hỏng nhanh — đừng trích lại mà không chạy.** Bản nháp trang này đo ở `43a5564e`
(đúng một commit trước) ra `507 / 1379 / 122 / 18` và GitNexus `20`; chỉ một commit sau, ba trong
bốn số đã đổi. Đó chính là luận điểm của cả trang: độ lệch của graph là hàm số của HEAD, nên mọi con
số ở đây là **ảnh chụp có nhãn**, không phải hằng số.

18 tiểu hệ UA hoàn toàn mù: `infra/network-center-worker`, `infra/openclaw-media-gateway`,
`infra/openclaw-zalo`, `infra/openclaw-zalo-watchdog`, `services/openclaw-egress-broker`,
`services/openclaw-zalo-bridge`, `services/openclaw-zalo-cell`, `services/openclaw-zalo-maintenance`,
`src/app`, `supabase/functions/_shared`, `supabase/functions/network-center-worker`,
`supabase/functions/network-watchdog`, `supabase/functions/openclaw-control`,
`supabase/functions/openclaw-object-tickets`, `supabase/functions/openclaw-qr`,
`supabase/functions/openclaw-runtime`, `supabase/functions/openclaw-runtime-token`,
`supabase/functions/openclaw-watchdog`.

| | UA | GitNexus |
|---|---|---|
| baseCommit | `d0ffb045` (29/07, `.ua/meta.json`) | `17bb0090` (`.gitnexus/manifest.json`) |
| analyzedFiles | 2.120 (`.ua/meta.json`) | 2.461 file (`.gitnexus/gitnexus.json` → `stats`) |
| Quy mô | — | 25.430 node · 56.001 edge · 818 community · 226 process · **0 embedding** |
| toolVersion | `2.9.4`, nguồn **`attested`** | `1.6.9`, nguồn **`measured`** |

**Đã đăng ký nợ:** `tooling/known-gaps.yaml` mục `ua-graph-stale`, hạn `2026-09-30`. Lúc đăng ký
(07/08) số đo là 488/1.345/118/18; nay đã trôi tiếp thành 508/1.381/122/18 — chính xác vì UA không
phải required check. Điều kiện thoát: refresh UA trong **PR riêng**, manifest ghi `toolVersion` **đọc
thật** thay vì attested, và `npm run gate:graph-freshness -- --nhiem-vu architecture` exit 0.

**Phần chưa được che, nói thẳng:** `toolVersion: "2.9.4"` của UA là **lời khai**, không đo được —
artifact `.ua/` không ghi version công cụ ở đâu cả; trường `version: "1.0.0"` trong cả ba file là
version *schema*. Nếu graph thật ra sinh bởi bản khác thì không có cách nào biết cho tới lần refresh
tới (`tooling/graph-manifests/ua.json:16-18`).

## 6. Cưỡng chế — ai giữ luật nào

| Gate | Luật | Chạy ở đâu |
|---|---|---|
| `scripts/check-graph-hygiene.mjs` | #3 hộ chiếu ↔ artifact, #6 refresh đi riêng, ghim 3 dòng Contract | **CI blocking** (`ci-gates.yml:123`) |
| `scripts/check-graph-freshness.mjs` | #1 GitNexus hard, #2 UA warning-mặc-định, #4 verdict | **local** theo nhiệm vụ; CI chạy chế độ báo cáo (`ci-gates.yml:139`) |
| `scripts/run-pinned-gitnexus.mjs` | pin version, ép cờ bắt buộc | cửa duy nhất gọi GitNexus |

`npm run gate:graph-hygiene` · `npm run gate:graph-freshness` · `npm run graph:analyze` ·
`npm run graph:status` (`package.json:69-72`).

CI phải `fetch-depth: 0` (`ci-gates.yml:86`): checkout mặc định là shallow, mà cả hai gate đều thoát
3 trên repo nông — tức gate sẽ không bao giờ thật sự chạy.

Hai gate này có **34 test** đơn vị ở `scripts/__tests__/check-graph-governance.test.mjs`, chia 8
suite phủ đúng **tám hàm export** (5 của freshness + 3 của hygiene). Đếm bằng
`node --test scripts/__tests__/check-graph-governance.test.mjs` → `# tests 34 · # pass 34 · # fail 0`.

> Đừng đếm bằng `grep -c "it("` — nó ra **38**, sai 4. Lý do đáng nhớ hơn con số: các dòng gọi
> `phanLoaiCommit(` chứa sẵn chuỗi con `it(` trong chữ "Commit(". Một phép đếm bằng grep trên tên
> hàm tiếng Việt sẽ còn dính bẫy này ở chỗ khác.

**Khoảng trống còn lại của chính cơ chế này:**
- Cửa chặn cứng của UA chỉ tồn tại **trên máy dev** — CI cố ý chạy chế độ báo cáo. Nghĩa là luật #4
  ("chạy freshness trước khi đọc graph") dựa vào kỷ luật của agent, không có gì ép được.
- Phép đo độ mới của **GitNexus chỉ có một chiều duy nhất: `commitsBehind`**
  (`check-graph-freshness.mjs:227-231`). Nó không đo file drifted, không đo migration thiếu, và
  **không đo missing-subsystem** — đúng phép đo quan trọng nhất, thứ bắt graph *mù* chứ không chỉ
  graph *cũ*. Một chỉ mục GitNexus bỏ sót cả một thư mục vẫn báo FRESH.

## 7. Bẫy đã cắn thật — ghi lại để không lặp

1. **`--skip-embeddings` không còn tồn tại ở GitNexus 1.6.9.** Plan kiến trúc §14 (khối lệnh ở dòng
   1694 của `docs/whiteboard-ihomecrm-architecture-agent-plan-2026-08-05 (1).md`) chỉ định cờ này.
   Chạy lại `npx --yes gitnexus@1.6.9 analyze --help` để kiểm: cờ đó **không có trong danh sách**;
   thứ tồn tại là `--embeddings [limit]` — nguyên văn *"Enable embedding generation for semantic
   search (off by default)"*. Tức mặc định đã là hành vi mà plan muốn, và chạy đúng câu lệnh trong
   plan sẽ lỗi cờ lạ. Đã ghi lại trong `tooling/agent-tools.json:13` thay vì im lặng bỏ.
   (Khớp với artifact: `stats.embeddings = 0`.)
2. **Công cụ tự sửa hợp đồng agent.** `gitnexus analyze` mặc định chèn một mục vào `CLAUDE.md` và
   `AGENTS.md` — để nó làm vậy là để công cụ tự viết luật cho chính nó. Wrapper **ép**
   `--skip-agents-md` vào mọi lần analyze, kể cả khi người gọi quên
   (`run-pinned-gitnexus.mjs:200-205`).
3. **`npx.cmd` trên Windows, hai bẫy ngược nhau.** `shell:false` → Node từ chối spawn `.cmd`
   (`EINVAL`, bản vá CVE-2024-27980) và stdout rỗng nên **trông y hệt "chạy nhưng không in gì"**.
   Nhưng `shell:true` → Node không bọc nháy đối số, mà đường dẫn repo là
   `C:\Users\Nguyen Tam\…` có dấu cách nên đối số bị cắt đôi — **đúng lỗi đã cắn
   `scripts/check-permission-catalog.mjs`**, và CI Linux không bao giờ lộ ra. Cách xử:
   `shell:true` + tự bọc nháy trên Windows (`run-pinned-gitnexus.mjs:60-87`).
4. **sha256 worktree ≠ nội dung git lưu.** `configDigest` dùng **git blob OID**, không phải sha256
   file: trên Windows worktree có thể là CRLF trong khi blob là LF, nên sha256 sẽ lệch một cách vô
   nghĩa và gate đỏ giả (`graph-manifests/ua.json:24`, `run-pinned-gitnexus.mjs:96-99`).
5. **`git hash-object` chứ không `rev-parse HEAD:<path>`.** Cái sau chỉ đọc được file **đã commit**,
   nên lần chạy đầu tiên — khi `agent-tools.json` còn trong working tree — `configDigest` sẽ thành
   `null`, đúng lúc cần nó nhất (`run-pinned-gitnexus.mjs:103-107`).
6. **Gõ sai `--nhiem-vu` không được âm thầm rơi về chế độ cảnh báo.** Đó là cách một cửa chặn biến
   mất trong khi người chạy vẫn tưởng mình đang được bảo vệ → exit 3 (`check-graph-freshness.mjs:133-139`).
7. **Trần hard-code chống nới policy.** `TRAN = { 200 commit / 500 file / 30 migration }` trong
   `check-graph-freshness.mjs:46`. Không có trần thì luật #1/#2 vô hiệu hoá được bằng đúng một dòng
   JSON `maxCommitsBehind: 999999`. Ngưỡng policy hiện tại thấp hơn nhiều: **50 / 150 / 10** và
   `maxMissingSubsystems: 0` (`graph-policy.json:17-23`).
8. **Ba nguồn `baseCommit`, không phải một.** `meta.json`, `fingerprints.json` và
   `knowledge-graph.json→project` đều phải khớp manifest — nếu chỉ tin `meta.json` thì một artifact
   bị sửa tay đúng một chỗ sẽ đi lọt (`check-graph-hygiene.mjs:69-80`).
9. **Chỉ mục có mà pin chưa verified = đỏ ở MỌI chế độ** (`ADOPTED_KHONG_PIN`): ai đó đã chạy
   GitNexus ngoài wrapper, tức dùng một công cụ chưa ai kiểm để kết luận về mã nguồn
   (`check-graph-freshness.mjs:61-63, 259-260`).
10. **Allowlist của luật #6 có `.gitignore` là cố ý.** Đưa graph vào repo bắt buộc phải khai luật
    ignore cho thư mục scratch của nó — commit `fcf69f5e` (29/07, commit **duy nhất** đụng
    `.ua/` cho tới nay) làm đúng vậy, thêm `.ua/intermediate/`, `.ua/tmp/`… vào `.gitignore:106-111`.
    Một file `.gitignore` không giấu được thay đổi hành vi (`graph-policy.json:30`).

## 8. Hệ quả

- Không ai gọi `npx gitnexus` trực tiếp. Đổi version = sửa **một** dòng trong
  `tooling/agent-tools.json`, và việc đổi hiện ra trong diff. `status` chỉ được đổi sang `verified`
  bởi `run-pinned-gitnexus.mjs smoke`, kèm bằng chứng đo được — hiện là
  `versionReported 1.6.9 · doctorExitCode 0 · win32 node v22.20.0`, `verifiedAt 2026-08-07T03:39:51.691Z`.
- Verdict (`tooling/graph-verdict.local.json`, gitignore dòng 55) hết hiệu lực khi **HEAD đổi**, khi
  **policy đổi** (so `policyDigest`), hoặc quá **TTL 240 phút** — thiếu một trong ba là chết
  (`check-graph-freshness.mjs:100-106`, `graph-policy.json:5-6`).
- Refresh graph đi **PR riêng**. Gate quét TOÀN lịch sử (không giới hạn N ngày — giới hạn thời gian
  tạo ra cửa "chờ cho vi phạm trôi qua") và bỏ merge commit vì combined-diff báo giả
  (`check-graph-hygiene.mjs:157-181`).
- `check-graph-hygiene.mjs` hiện **xanh** dù UA cũ 508 commit: nó kiểm *hộ chiếu khớp hàng*, không
  kiểm *độ mới*. Hai việc khác nhau, hai script khác nhau — đừng đọc "vệ sinh graph OK" thành "graph
  dùng được".

## 9. Phương án đã cân nhắc và loại

- **Chỉ dùng một graph.** Loại: một graph không thể vừa local-only-tươi-liên-tục (impact analysis)
  vừa commit-được-để-review (onboarding, tài liệu). Hai yêu cầu này mâu thuẫn ở chính chỗ artifact
  nằm đâu.
- **Bắt UA freshness thành required check.** Loại: refresh là PR ~6,8 MiB JSON; CI đỏ thường trực dẫn
  tới tắt gate. Thay bằng *hard theo nhiệm vụ* + đăng ký known-gap có **ngày hết hạn**, vì "cảnh báo
  không có ngày hết hạn thì thành tiếng ồn nền rồi không ai đọc nữa"
  (`known-gaps.yaml`, mục `ua-graph-stale`).
- **Commit `.gitnexus/`.** Loại: 496 MB trên đĩa.
- **Tin graph cho kết luận SQL/RLS/RPC.** Loại: graph không chứng minh object nào đang deploy.
