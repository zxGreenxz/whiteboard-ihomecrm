# Kế hoạch triển khai khắc phục bảo mật toàn kho mã

> **[CÒN SỐNG — trạng thái 02/09/2026]** Snapshot 12/08 neo HEAD `931eb9e7`, 0/80 checkbox đã thực hiện; HEAD đã đi 190 commit. **Đã re-anchor toàn bộ 49 finding** tại `2026-09-02-security-remediation-re-anchor.md` (4 ĐÃ VÁ · 45 CÒN MỞ, 12 P1) — đọc file đó để biết vị trí mới + hàng đợi fix; mọi `file:line` trong file này đã lỗi thời.

> **Dành cho agent triển khai:** BẮT BUỘC dùng `superpowers:subagent-driven-development` (khuyến nghị) hoặc `superpowers:executing-plans` để thực hiện lần lượt từng task. Mọi bước dùng checkbox `- [ ]` để theo dõi.

**Mục tiêu (Goal):** Đóng đủ 49 finding trong tồn đọng khắc phục bảo mật theo thứ tự P1, P2, P3 bằng kiểm soát phía server, kiểm thử vai trò thật, bằng chứng đột biến và quy trình migration tiến tới duy nhất.

**Kiến trúc (Architecture):** Ưu tiên chặn đường tấn công trực tiếp bằng các migration tiến tới nhỏ, RPC phiên bản mới và thay đổi runtime có ownership rõ; mọi quyết định quyền phải gắn với tổ chức và tài nguyên cuối cùng. Mỗi work package phải có ca dương, ca âm cùng điều kiện nhưng khác phạm vi/quyền, kiểm ACL hiệu lực, đột biến đỏ đúng lý do, bằng chứng triển khai và đường forward-fix; năm đề xuất hardening kiến trúc chỉ được làm sau khi 49 finding chiến thuật đã đóng.

**Công nghệ (Tech Stack):** React 18, TypeScript, Vite/Vitest, Supabase PostgreSQL 17.6/PostgREST/Edge Functions, Deno 2.9.4, Node workers, Cloudflare Workers/R2, Playwright, Zod, PowerShell và PostgreSQL dùng một lần.

**Đặc tả (Spec):** Codex Security scan `c947aff2-502a-4691-a58c-cdb5da1df039` tại revision `6d0407cf30ef1236240900626c2b8dcf0177b1bb`, gồm `report.md`, `findings.json`, `coverage.json`, threat model và hardening portfolio trong scan directory ghi ở mục Nguồn gốc; finding bổ sung `S49` được neo vào current source trong Task 9.

## Ràng buộc toàn cục (Global Constraints)

- Bằng chứng scan khóa tại scan ID `c947aff2-502a-4691-a58c-cdb5da1df039`, revision `6d0407cf30ef1236240900626c2b8dcf0177b1bb`.
- Scan niêm phong có 48 finding chuẩn: `14 High`, `25 Medium`, `9 Low`. Bổ sung `S49` ở mức Medium tạo tồn đọng khắc phục 49 finding: `14 P1`, `26 P2`, `9 P3`; không sửa artifact scan niêm phong để nhét S49 vào.
- `coverage.json` có receipt/review cho `421/421` inventory rows, nhưng `coverage.completeness` tổng thể vẫn là `partial`. Kết quả này không chứng minh quét exhaustive và chỉ là static validation; chưa chạy mutation trên database/provider/browser/production thật.
- HEAD tại checkpoint rà cuối là `931eb9e78ceed2f7ffd5513d67fc7e4c14bafd7e`, đi sau scan revision 52 commit. Commit mới nhất `feat(chat-zalo): trang chat theo công ty — media/voice/sticker, reply thật, CRM live, tiện ích hội thoại` thêm/sửa các UI/hook Zalo, gồm `src/hooks/chat-zalo/useZaloConversationActions.ts`, `src/hooks/chat-zalo/useZaloMedia.ts` và caller hiện hữu trong `src/hooks/useZaloChat.ts`; worktree còn các file untracked ngoài ownership của plan. Executor phải chụp lại HEAD/worktree, đọc lại định nghĩa source và catalog đang deploy trước file implementation đầu tiên; nếu lệch thì cập nhật fixture/task liên quan, không áp dụng sketch cũ một cách im lặng. Chuỗi migration Zalo `20260813100000_zalo_khu_rieng_theo_cong_ty.sql` -> `20260813110000_zalo_gui_media_va_idempotency.sql` -> `20260813120000_zalo_tien_ich_rpc.sql` -> `20260813130000_zalo_gan_hoi_thoai_crm.sql` đã được commit tại `dbc492c52e803607b421ae7b3ea7222169ca7d21`; provenance đánh dấu cả bốn `ledger-applied`, receipt/evidence có SHA-256 khớp file và catalog production được chụp lúc `2026-08-13T03:23:25.196Z`. Live catalog chỉ-đọc tại checkpoint xác nhận ABI Zalo cuối chuỗi là send 8 đối số, history 2, react 2, recall 1; Task 4/10 phải rebase containment/V2 và exact revoke lên ABI này. `contracts/surfaces/rpc-surface.json` vẫn ghi send 6 đối số trong khi generated types và live catalog ghi 8, vì vậy riêng điểm này surface là stale và phải được regenerate/check trước khi dùng làm bằng chứng. Không sửa, xóa hoặc replay bốn migration đã áp dụng.
- Thực hiện đúng thứ tự `P1 -> P2 -> P3`. Chỉ bắt đầu mức sau khi focused tests, integrated gates, kiểm thử vai trò thật và bằng chứng đột biến của mức trước đều xanh.
- Không sửa, đổi tên, di chuyển hoặc replay migration đã deploy. Mỗi sửa database là một migration tiến tới mới, timestamp 14 chữ số duy nhất trong `supabase/migrations/`, chỉ áp dụng qua `npm run migrate:forward`.
- Tuyệt đối không replay `supabase/migrations-archive/`, không chạy `supabase db push`, không backfill `supabase_migrations.schema_migrations`, không redirect output của `npm run gen:types` vào file.
- Mỗi ranh giới `SECURITY DEFINER`, RLS hoặc permission phải có ma trận: được phép cùng phạm vi, thiếu quyền, khác tổ chức, context NULL, tài nguyên không tồn tại và replay/concurrency khi có hiệu ứng ghi.
- Mọi chỗ trong remediation gọi `app_private.authorize_tenant_action_v3` phải gọi `app_private.lock_org_for_decision_v1(exact_org)` ở statement ngay trước; live-definition test kiểm ordering này. Với read-scope resolver như `authorized_scope_v3`, cũng khóa org trước khi lấy scope và caller phải là `VOLATILE` nếu thực hiện lock; không chèn lock vào helper `STABLE`.
- Mỗi đột biến phải là thay đổi cú pháp hợp lệ, thực sự bỏ đúng guard, làm suite đỏ vì assertion bảo mật đã đặt tên, rồi để `scripts/dot-bien.mjs` xác minh SHA-256 trở về đúng giá trị ban đầu.
- Fixture database dùng PostgreSQL/Supabase dùng một lần hoặc transaction rollback trên DEMO/TEST. Không ghi tổ chức THẬT; fixture DEMO phải tự dọn.
- Thay đổi tiền phải chạy cả `node scripts/reconcile-money.mjs 2026-08` và `node scripts/reconcile-money-v2.mjs 2026-08`, cùng bằng chứng idempotency và concurrency.
- E2E chạy headless, mật khẩu chỉ nạp qua `FLEET_PASS_*`; không mở browser headed nếu user không yêu cầu.
- Chỉ apply/deploy production từ SHA sạch đã review, sau preflight credential/project/org, backup/evidence receipt và toàn bộ gate bắt buộc. Rollback database bằng forward-fix hoặc khôi phục từ backup đã xác minh, không down-migrate file đã áp dụng.

---

## Kết quả cần đạt

Loại bỏ các đường đã xác thực cho phép ghi tài chính bằng bearer yếu, đọc/ghi chéo tổ chức, Zalo confused-deputy, lệch permission giữa route/Copilot/RPC, public capability không có vòng đời và materialize request trước khi kiểm giới hạn, đồng thời giữ hành vi hợp lệ ngoài phạm vi finding.

## Trong phạm vi

- Đúng 48 finding chuẩn trong scan và finding bổ sung S49, theo bảng mapping cuối tài liệu.
- Migration tiến tới mới, thay đổi TypeScript/Edge/worker/Cloudflare có giới hạn, typed boundary, tests, E2E, surface/type regeneration, backup/rollout/rollback cần thiết để đóng các finding.
- Chặn grant/entrypoint legacy nguy hiểm trong cùng work package, nhưng tách containment/revoke thành forward migration riêng khi caller đang deploy cần cutover; chỉ revoke sau runtime/client tương thích và adoption evidence.

## Ngoài phạm vi

- Viết lại toàn bộ authorization framework, chuyển mọi RPC trong repo sang abstraction mới, bật PITR, đổi chính sách giá/sản phẩm hoặc redesign UI.
- Refactor chung, bật TypeScript strict toàn repo, cleanup không phục vụ finding hoặc xử lý `FR001-C06` khi chưa chứng minh được setter do attacker điều khiển.
- Triển khai năm đề xuất hardening kiến trúc trước khi 49 finding chiến thuật đã đóng và user phê duyệt phase riêng.

## Điều kiện hoàn tất

- Mỗi dòng trong mapping 49 finding trỏ tới đúng một work package hoàn tất và có negative regression tái hiện đúng vai trò/phạm vi của attacker.
- P1 đóng trước P2; P2 đóng trước P3; không còn blocker trong scope.
- Mỗi boundary mới có ACL hiệu lực, ca authorized/denied/cross-org/NULL, mutation proof đỏ đúng lý do và restore đúng hash.
- Mỗi thay đổi schema là migration tiến tới có provenance, dry-run, backup-bound apply receipt, catalog readback, canonical types/surfaces được sinh lại và đường forward-fix đã diễn tập.
- Focused tests, harness PostgreSQL dùng một lần, role-real DEMO/TEST, typecheck, baseline lint, ESLint focused, build, repository gates, money reconciliation và E2E headless đều xanh sau thay đổi cuối.
- `node scripts/clone-org/snapshot.mjs after` báo `0/158` bảng rò rỉ; final diff chỉ có file remediation dự kiến; không có secret hoặc generated drift ngoài ý muốn.

## Nguồn gốc và phân loại

| Bằng chứng | Giá trị |
| --- | --- |
| Báo cáo scan | `C:/Users/Nguyen Tam/AppData/Local/Temp/codex-security-scans-5rEfFg/whiteboard-ihomecrm-main/6d0407cf30ef1236240900626c2b8dcf0177b1bb_20260812T015538Z_2q22izhx/report.md` |
| Finding chuẩn | Cùng thư mục, file `findings.json`; 48 record, không trùng `findingId` hoặc `occurrenceId` |
| Occurrence phải giữ riêng | `PANALYTICS-C01` x6, `PMETER-C01` x2, `PZALO-C01` x4 |
| Coverage | `421/421` inventory rows có receipt/review; completeness tổng thể vẫn `partial`; chỉ static validation |
| Dòng scan deferred | `FR001-C06`: chưa chứng minh setter do attacker điều khiển |
| Bằng chứng bổ sung | S49 lấy từ current source, không thuộc report 48 finding niêm phong |
| Drift Zalo đã xác minh | Commit `dbc492c52e803607b421ae7b3ea7222169ca7d21`; 4 receipt trong `docs/generated/schema-change-evidence/202608131*.json`; `supabase/migration-provenance.json` ghi `ledger-applied`; live catalog read-only xác nhận send/history/react/recall = 8/2/2/1 đối số |
| Giới hạn UI | Canonical artifacts/finalizer trên detached revision đã hoàn tất, nhưng Codex Security app hiện báo remediation/report unavailable vì checkout đã rời revision scan; dùng file niêm phong làm nguồn và revalidate current source trước implementation |

Trước khi sửa file implementation đầu tiên:

```powershell
git rev-parse HEAD
git merge-base --is-ancestor 6d0407cf30ef1236240900626c2b8dcf0177b1bb HEAD
npm run gate:graph-freshness -- --nhiem-vu high-risk
npm run graph:impact -- luckySavePayout
```

Kỳ vọng: revision scan là ancestor; graph freshness hợp lệ trước khi đọc graph; định nghĩa live/catalog được chụp lại cho từng RPC. Graph không thay thế contract manifest, SQL harness hoặc deployed catalog.

## Bản đồ ownership

| Gói công việc | File chính | Kiểm thử chính |
| --- | --- | --- |
| P1 payout Lucky | `src/lib/luckyDrawApi.ts`, `src/pages/quayso/QuaySoPage.tsx`, `src/pages/quayso/LuckyDrawAdminPage.tsx`, các migration Lucky additive/revoke | `src/lib/__tests__/luckyDrawSecurityMigration.test.ts`, `src/pages/quayso/__tests__/QuaySoPayoutCapability.test.tsx`, Lucky E2E |
| P1 integrity tài chính | migration contract/termination/voucher, `src/hooks/income-expenses/mutations.ts` | SQL fixture, migration tests, finance E2E |
| P1 duyệt công tơ | migration meter, `src/hooks/useMeterReadings.ts` | meter migration/hook tests |
| P1 Zalo queue | migration Zalo containment/enqueue, `worker/lib/queue.js` với bootstrap `worker/index.js` | SQL/Node worker tests, Zalo E2E |
| P1 salary | migration salary, `src/hooks/useManagerSalary.ts` | salary migration/gate/E2E |
| Harness dùng một lần | `scripts/security-disposable-db.mjs`, runner và test matrix | Node harness tests |
| P2 public projection/proof | public room/Lucky source và migration | public room/Lucky tests/E2E |
| P2 permission/report/S49 | migrations authz/report/analytics/cashbook, `src/hooks/useSettlementReport.ts`, explicit selected-org state, Copilot context/tool | business authz, settlement hook/cashbook, route tests/E2E |
| P2 Zalo reaction/recall | migration action authz, Zalo wrappers và `worker/lib/queue.js` | action-specific SQL/worker/E2E |
| P2 finance object scope | finance migrations và typed wrappers | finance V2/compat/role-real suites |
| P2 request/storage budget | Edge/Cloudflare/worker helpers và analytics migration | Deno/Node/Vitest budget suites |
| P3 public token lifecycle | public token migration và clients | public capability tests/E2E |
| P3 worker response bound | `infra/network-center-worker/src/apiClient.ts` | package tests |
| P3 auth/Copilot consent | auth client, login, Copilot confirmation store | auth/Copilot tests/E2E |
| P3 finance array bound | finance migration, clients/schemas | invoice/finance tests/E2E |

Plan dự kiến đúng 32 migration tiến tới mới. Các tên migration dưới đây dành dải `20260814xxxxxx`. Nếu implementation bắt đầu khi tên đã tồn tại, agent chính cấp timestamp chưa dùng tiếp theo, giữ nguyên thứ tự phụ thuộc và cập nhật tất cả tham chiếu trong task trước khi code.

## P1 - Chặn và sửa finding High

### Task 1: Thay bearer sáu chữ số của Lucky payout bằng capability do quản trị phát

**Finding:** `FR001-C03`.

**Tệp:**
- Create: `supabase/migrations/20260814010000_lucky_payout_capability_additive.sql`
- Create: `supabase/migrations/20260814010500_lucky_payout_legacy_revoke.sql`
- Modify: `src/lib/luckyDrawApi.ts`
- Modify: `src/pages/quayso/QuaySoPage.tsx`
- Modify: `src/pages/quayso/LuckyDrawAdminPage.tsx`
- Create: `src/lib/__tests__/luckyDrawSecurityMigration.test.ts`
- Create: `src/pages/quayso/__tests__/QuaySoPayoutCapability.test.tsx`
- Create: `scripts/test-lucky-payout-capability.mjs`
- Create: `scripts/tests/test-lucky-payout-capability.sql`
- Modify: `.e2e-fleet/specs/quayso-lucky-draw.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Giao diện:**
- Legacy thật là `public.lucky_save_payout_v1(p_code text, p jsonb)`, được gọi tại `src/lib/luckyDrawApi.ts` và hiện cấp `anon, authenticated`.
- Tạo `public.lucky_admin_rotate_payout_capability_v1(p_team uuid)` cho quản trị đã đăng nhập và `public.lucky_save_payout_v2(p_capability text, p_request_kind text, p_expected_revision bigint, p_idempotency_key uuid, p jsonb)` cho participant. Cả issuer và writer chỉ dùng lần đọc đầu để tìm tuple, sau đó khóa lại theo đúng một thứ tự `organization -> event -> team -> capability -> operation` và revalidate toàn bộ tuple. Issuer gọi `app_private.lock_org_for_decision_v1(exact_org)` ngay trước khi kiểm org ACTIVE cùng membership ACTIVE `OWNER|STAFF` của actor trong chính org đó; tuyệt đối không dùng `lucky_admin_org_v1()`/`lucky_admin_assert_event_v1()` vì hai helper legacy suy ra org đầu tiên bằng `LIMIT 1`. Capability được phát hoặc rotate qua kênh out-of-band; `lucky_checkin_v1` chỉ điểm danh và tuyệt đối không phát, rotate hay trả payout capability từ mã sáu chữ số.
- Token có dạng `<capability-id>.<secret>`: ID UUID ngẫu nhiên chỉ là locator, secret là 32 byte ngẫu nhiên mã hóa base64url không padding. Lưu riêng `capability_id`, digest SHA-256 của secret, organization/event/team audience, expiry tối đa 7 ngày, revoked timestamp, current revision và operation count trong `app_private.lucky_payout_capabilities`; không lưu raw secret. Sau khi lấy đủ lock, writer re-read exact tuple rồi so đủ 32 byte digest bằng helper fixed-work `app_private.secure_bytea_equal_v1`, không dùng phép so sánh `bytea =`/`IS DISTINCT FROM` có thể dừng sớm và không tuyên bố guarantee timing mạnh hơn PostgreSQL runtime thực sự cung cấp; browser không được gửi organization/event/team ID làm authority.
- Capability được dùng nhiều lần trong TTL để luồng hiện tại có thể lưu metadata proof, xóa metadata proof và lưu tài khoản bằng các request riêng, nhưng tối đa 64 idempotency key mới; replay key đã có không tăng quota. Mỗi write bắt buộc `p_expected_revision`, tăng revision atomically và ghi `p_idempotency_key` + hash của `{requestKind,payload}` đã canonicalize. Retry cùng key/payload được kiểm sau secret/audience/expiry/revocation/event/team nhưng trước expected-revision: không ghi lần hai, trả `operationRevision` đã lưu cùng `currentRevision` và state hiện tại để client không hạ revision; cùng key khác payload bị conflict, revision cũ của operation mới trả `40001`. Capability chỉ hết hiệu lực do expiry/revoke/rotate hoặc event đóng, không consume ở lần lưu đầu.
- Raw capability chỉ hiện ở màn quản trị đúng một lần để chuyển out-of-band và participant chỉ giữ trong React memory của tab sau khi nhập hoặc lấy từ URL fragment rồi xóa fragment bằng `history.replaceState`; không dùng sessionStorage. Không đưa token vào URL query, React Query key/cache, localStorage, log, toast, public payload, audit payload hoặc analytics. Reload/mất token phải yêu cầu nhập lại; mã sáu chữ số không được dùng làm fallback.
- Task 1 chỉ kiểm writer metadata bằng proof path/name được harness service-role nạp sẵn dưới prefix event giống contract v1 hiện tại; P1 không mở đường upload mới và không coi fixture đó là bằng chứng ownership storage. Task 8 sở hữu upload authorization thật, thay input proof từ path/name sang server object ID và tái sử dụng cùng issuer/resolver/audience `lucky_payout`; proof upload không được tạo hệ payout capability thứ hai hay phát token từ mã check-in. Upload ticket ngắn hạn chỉ được mint sau khi payout capability hợp lệ và bind đúng organization/event/team/object budget.

- [ ] **Bước 1: Viết test đỏ cho đúng signature legacy và boundary mới**

```ts
expect(clientSource).not.toContain("'lucky_save_payout_v1'");
expect(liveAcl('public.lucky_save_payout_v1(text,jsonb)')).not.toMatch(/PUBLIC|anon|authenticated/);
expect(liveAcl('public.lucky_admin_rotate_payout_capability_v1(uuid)')).toMatch(/authenticated/);
expect(liveAcl('public.lucky_admin_rotate_payout_capability_v1(uuid)')).not.toMatch(/PUBLIC|anon/);
expect(liveDefinition('public.lucky_admin_rotate_payout_capability_v1(uuid)')).toMatch(/lock_org_for_decision_v1[\s\S]*organization_memberships[\s\S]*OWNER[\s\S]*STAFF/i);
expect(liveDefinition('public.lucky_admin_rotate_payout_capability_v1(uuid)')).not.toMatch(/lucky_admin_org_v1|lucky_admin_assert_event_v1/i);
expect(liveDefinition('public.lucky_checkin_v1(text)')).not.toMatch(/payout_capability|capabilitySecret/i);
expect(liveDefinition('public.lucky_save_payout_v2(text,text,bigint,uuid,jsonb)')).toMatch(/lucky_payout_capabilities/i);
expect(liveDefinition('public.lucky_save_payout_v2(text,text,bigint,uuid,jsonb)')).toMatch(/p_request_kind[\s\S]*p_expected_revision[\s\S]*p_idempotency_key/i);
expect(liveDefinition('public.lucky_save_payout_v2(text,text,bigint,uuid,jsonb)')).toMatch(/lock_org_for_decision_v1[\s\S]*secure_bytea_equal_v1[\s\S]*operation_count/i);
expect(clientSource).toContain("'lucky_save_payout_v2'");
expect(clientSource).not.toMatch(/publicRpc[^\n]*lucky_save_payout_v1/);
```

E2E phải dùng hai đội DEMO: admin phát capability A và chuyển out-of-band; harness service-role nạp trước một object/path fixture dưới prefix event rồi participant dùng A lưu metadata proof, xóa metadata proof và lưu tài khoản qua ba request/revision liên tiếp; capability A không ghi B; mã sáu chữ số/check-in response không mint capability và không còn ghi payout; reload mất secret yêu cầu nhập lại; mọi denial/conflict giữ nguyên payout/proofs. Ca upload object thật và ownership/quota storage chỉ được tính đóng ở Task 8.

- [ ] **Bước 2: Chạy focused tests để xác nhận trạng thái đỏ trước sửa**

```powershell
npx vitest run src/lib/__tests__/luckyDrawSecurityMigration.test.ts src/lib/__tests__/luckyWheel.test.ts
```

Kỳ vọng ở baseline trước sửa: test contract đỏ vì v2 chưa tồn tại, ACL v1 còn `anon/authenticated` và client vẫn gọi v1; các assertions phía trên mô tả trạng thái xanh bắt buộc sau implementation/revoke checkpoint.

- [ ] **Bước 3: Tạo issuer admin, registry private và writer revision/idempotency trong migration additive**

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.lucky_events'::regclass
      AND conname = 'lucky_events_id_organization_id_key'
  ) THEN
    ALTER TABLE public.lucky_events
      ADD CONSTRAINT lucky_events_id_organization_id_key UNIQUE (id, organization_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.lucky_event_teams'::regclass
      AND conname = 'lucky_event_teams_id_event_id_key'
  ) THEN
    ALTER TABLE public.lucky_event_teams
      ADD CONSTRAINT lucky_event_teams_id_event_id_key UNIQUE (id, event_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS app_private.lucky_payout_capabilities (
  capability_id uuid PRIMARY KEY,
  secret_digest bytea NOT NULL CHECK (octet_length(secret_digest) = 32),
  audience text NOT NULL DEFAULT 'lucky_payout' CHECK (audience = 'lucky_payout'),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  event_id uuid NOT NULL,
  team_id uuid NOT NULL,
  issued_by uuid NOT NULL REFERENCES auth.users(id),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  operation_count smallint NOT NULL DEFAULT 0 CHECK (operation_count BETWEEN 0 AND 64),
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '7 days'),
  FOREIGN KEY (event_id, organization_id)
    REFERENCES public.lucky_events(id, organization_id),
  FOREIGN KEY (team_id, event_id) REFERENCES public.lucky_event_teams(id, event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lucky_payout_one_active_capability_per_team
ON app_private.lucky_payout_capabilities(team_id)
WHERE revoked_at IS NULL;

-- Nếu lucky_event_teams chưa có UNIQUE(id,event_id), thêm unique constraint/index
-- tương thích trước composite FK; không sửa migration lịch sử.

CREATE TABLE IF NOT EXISTS app_private.lucky_payout_operations (
  capability_id uuid NOT NULL REFERENCES app_private.lucky_payout_capabilities(capability_id),
  request_kind text NOT NULL CHECK (request_kind IN ('account', 'proofs')),
  idempotency_key uuid NOT NULL,
  payload_hash bytea NOT NULL,
  expected_revision bigint NOT NULL,
  result_revision bigint NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (capability_id, request_kind, idempotency_key)
);

REVOKE ALL ON app_private.lucky_payout_capabilities, app_private.lucky_payout_operations
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.secure_bytea_equal_v1(p_left bytea, p_right bytea)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_diff integer := 0;
  i integer;
BEGIN
  IF p_left IS NULL OR p_right IS NULL
     OR octet_length(p_left) <> 32 OR octet_length(p_right) <> 32 THEN
    RETURN false;
  END IF;
  FOR i IN 0..31 LOOP
    v_diff := v_diff | (get_byte(p_left, i) # get_byte(p_right, i));
  END LOOP;
  RETURN v_diff = 0;
END;
$$;

-- Cùng migration định nghĩa parser fail-closed cho UUID + secret base64url 32 byte,
-- canonical JSON digest của {requestKind,payload}, và helper response. REVOKE mọi
-- helper app_private khỏi PUBLIC/anon/authenticated; live-catalog test kiểm ACL.

CREATE OR REPLACE FUNCTION public.lucky_admin_rotate_payout_capability_v1(p_team uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $$
-- Pre-read team -> event -> exact org without treating that read as authority.
-- Lock exact org via lock_org_for_decision_v1, then event FOR UPDATE, then team
-- FOR UPDATE; revalidate org ACTIVE and actor membership ACTIVE OWNER|STAFF in
-- that exact org. Never call lucky_admin_org_v1/lucky_admin_assert_event_v1.
-- Revoke old active capability rows only after those locks; generate independent
-- capability_id + 32-byte secret, persist only SHA-256 digest, set TTL 24 hours,
-- and return {capability, revision:1, expiresAt} exactly once.
$$;

CREATE OR REPLACE FUNCTION public.lucky_save_payout_v2(
  p_capability text,
  p_request_kind text,
  p_expected_revision bigint,
  p_idempotency_key uuid,
  p jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $$
DECLARE
  v_cap app_private.lucky_payout_capabilities%ROWTYPE;
  v_event public.lucky_events%ROWTYPE;
  v_team public.lucky_event_teams%ROWTYPE;
  v_payload_hash bytea := app_private.digest_lucky_operation_v1(p_request_kind, p);
  v_secret_digest bytea;
  v_existing app_private.lucky_payout_operations%ROWTYPE;
BEGIN
  -- Additive migration defines safe parse helpers: malformed input returns NULL, never 22P02.
  -- Locator pre-read only discovers lock keys and never authorizes by itself.
  SELECT * INTO v_cap
  FROM app_private.lucky_payout_capabilities
  WHERE capability_id = app_private.parse_lucky_capability_id_v1(p_capability);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_cap.organization_id);
  SELECT * INTO v_event FROM public.lucky_events
   WHERE id = v_cap.event_id AND organization_id = v_cap.organization_id
   FOR UPDATE;
  SELECT * INTO v_team FROM public.lucky_event_teams
   WHERE id = v_cap.team_id AND event_id = v_cap.event_id
   FOR UPDATE;
  SELECT * INTO v_cap FROM app_private.lucky_payout_capabilities
   WHERE capability_id = v_cap.capability_id
     AND organization_id = v_cap.organization_id
     AND event_id = v_cap.event_id AND team_id = v_cap.team_id
   FOR UPDATE;

  v_secret_digest := extensions.digest(
    app_private.parse_lucky_capability_secret_v1(p_capability), 'sha256'
  );
  IF v_cap.audience IS DISTINCT FROM 'lucky_payout'
     OR v_cap.revoked_at IS NOT NULL
     OR v_cap.expires_at <= clock_timestamp()
     OR NOT app_private.secure_bytea_equal_v1(v_cap.secret_digest, v_secret_digest) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_event.id IS NULL OR v_event.status = 'closed'
     OR v_team.id IS NULL OR v_team.checked_in_at IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Under the capability lock, lock/read operation last. Same key+hash is a
  -- side-effect-free replay before expected-revision checking: return current
  -- state plus stored operationRevision and current revision. Same key with a
  -- different hash raises 23505. No incomplete claim survives transaction rollback.
  SELECT * INTO v_existing FROM app_private.lucky_payout_operations
   WHERE capability_id = v_cap.capability_id
     AND request_kind = p_request_kind AND idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.payload_hash IS DISTINCT FROM v_payload_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different payload' USING ERRCODE = '23505';
    END IF;
    RETURN app_private.lucky_payout_response_v1(
      v_cap.event_id, v_cap.team_id, v_cap.revision, v_existing.result_revision, true
    );
  END IF;

  IF v_cap.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'payout profile changed; refresh' USING ERRCODE = '40001';
  END IF;
  IF v_cap.operation_count >= 64 THEN
    RAISE EXCEPTION 'capability operation budget exhausted' USING ERRCODE = '54000';
  END IF;

  -- Validate request_kind/payload/proof metadata. UPDATE only v_cap.team_id with CAS revision;
  -- account request preserves proofs, proofs request preserves account fields.
  -- Increment revision + operation_count + last_used_at with WHERE revision=
  -- p_expected_revision RETURNING; zero row => 40001. Insert one completed operation
  -- row with payload hash, expected/result revision and original response;
  -- do not consume capability and leave every row unchanged on denial/conflict.
  RETURN app_private.lucky_payout_response_v1(
    v_cap.event_id, v_cap.team_id, v_cap.revision + 1, v_cap.revision + 1, false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lucky_admin_rotate_payout_capability_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lucky_admin_rotate_payout_capability_v1(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.lucky_save_payout_v2(text,text,bigint,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lucky_save_payout_v2(text,text,bigint,uuid,jsonb) TO anon, authenticated;
REVOKE ALL ON FUNCTION app_private.secure_bytea_equal_v1(bytea,bytea) FROM PUBLIC, anon, authenticated;
```

Migration additive không revoke v1 và không sửa response `lucky_checkin_v1`. Migration revoke chỉ chứa ACL containment cho exact legacy signature và chỉ apply sau khi server/client v2 đã deploy, adoption evidence xác nhận không còn caller v1 và negative fixture v2 xanh:

```sql
REVOKE ALL ON FUNCTION public.lucky_save_payout_v1(text,jsonb) FROM PUBLIC, anon, authenticated;
```

- [ ] **Bước 4: Cập nhật admin/participant client cho multi-request capability**

Admin page gọi issuer trực tiếp từ event handler typed, không dùng React Query mutation/query cho response chứa secret; raw token + revision chỉ nằm trong component state/ref, hiển thị đúng một lần rồi zeroize khi copy/đóng/unmount và không tự persist. Participant page có input capability riêng; fragment được đọc và xóa bằng `history.replaceState` trước request mạng đầu tiên, check-in chỉ persist mã locator như hiện tại, còn payout form chỉ enable khi memory token + revision tồn tại. Mọi thêm metadata proof, xóa metadata proof và lưu tài khoản truyền `{ capability, requestKind, expectedRevision, idempotencyKey, payout }`; response trả `operationRevision`, `currentRevision`, `replayed` ngoài public state và client chỉ tăng revision bằng `max(local,currentRevision)`. Không đưa capability vào React Query query/mutation cache hoặc key và loại fallback v1. Test admin đa tổ chức/khác tổ chức, wrong team/secret, locator đúng-secret sai, malformed token, expired, revoked/rotated, pre-checkin/closed event, stale revision, retry cùng key sau một operation mới hơn không làm revision lùi, cùng key khác payload, cùng textual key độc lập cho `account` và `proofs`, canonical JSON key order, quota 64 operation mới, ba write liên tiếp và legacy ACL.

- [ ] **Bước 5: Chạy mutation DB executable phá predicate authorization thật**

```powershell
node scripts/dot-bien.mjs --file supabase/migrations/20260814010000_lucky_payout_capability_additive.sql --tim "OR NOT app_private.secure_bytea_equal_v1(v_cap.secret_digest, v_secret_digest)" --thay "OR false AND NOT app_private.secure_bytea_equal_v1(v_cap.secret_digest, v_secret_digest)" --suite "node scripts/test-lucky-payout-capability.mjs --local-cluster" --mong-doi-chua "FR001-C03 wrong secret must be denied"
```

Fixture chạy RPC thật trong disposable/local Supabase-compatible database: trước mutation locator đúng-secret sai bị `42501` và row bất biến; sau mutation cùng request vượt qua secret guard nên assertion đỏ; restore hash rồi chạy lại xanh. Static regex/Vitest chỉ kiểm shape, không được dùng thay bằng chứng mutation authorization.

- [ ] **Bước 6: Chạy focused verification và E2E headless**

```powershell
npx vitest run src/lib/__tests__/luckyDrawSecurityMigration.test.ts src/lib/__tests__/luckyWheel.test.ts src/pages/quayso/__tests__/QuaySoPayoutCapability.test.tsx
node scripts/test-lucky-payout-capability.mjs --local-cluster
cd .e2e-fleet
$env:FLEET_WORKERS='2'; npx playwright test specs/quayso-lucky-draw.spec.ts
```

### Task 2: Buộc integrity theo tài nguyên cuối và dữ liệu server cho contract/settlement/voucher

**Các finding:** `FR002-C01`, `FR002-C02`, `PCOMPAT-C01`.

**Tệp:**
- Create: `supabase/migrations/20260814011000_contract_transfer_customer_org_guard.sql`
- Create: `supabase/migrations/20260814012000_moveout_settlement_server_truth.sql`
- Create: `supabase/migrations/20260814013000_pending_voucher_final_scope_guard.sql`
- Modify: `src/hooks/income-expenses/mutations.ts`
- Modify: `src/hooks/useContractOperations.ts`
- Modify: `src/lib/customerCreditRpc.ts`
- Modify: `scripts/tests/test-contract-transfer-hardening.sql`
- Modify: `scripts/tests/test-termination-refund-obligation.sql`
- Modify: `scripts/tests/test-termination-refund-writer.sql`
- Create: `src/lib/__tests__/pendingVoucherFinalScopeMigration.test.ts`
- Modify: `src/lib/__tests__/terminationNonCashPaymentMigration.test.ts`
- Modify: `src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts`
- Modify: `.e2e-fleet/specs/termination-refund.spec.ts`
- Modify: `.e2e-fleet/specs/finance-writers-scope.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Giao diện:** migration phải pin và fail nếu thiếu/overload sai các identity live `public.transfer_contract(uuid,uuid,numeric,numeric,date,text)`, `public.transfer_contract_impl(uuid,uuid,numeric,numeric,date,text)`, `public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid)`, `public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text)` và `public.ie_compat_update_pending_v2(uuid,jsonb,jsonb)`. Đây là exact ABI 6/6/10/11/3 đối số trên baseline HEAD; không pin overload lịch sử 7 đối số của move-out. `_impl` hiện chỉ kiểm customer tồn tại, chưa chứng minh cùng organization, nên enforcement wrapper + `_impl` là mục tiêu hardening của task chứ không phải thuộc tính baseline. Contract/customer phải có cùng organization không NULL; move-out dùng signature mới có expected authoritative settlement thay vì thay ABI 10/11 đối số tại chỗ; voucher patch authorize toàn bộ scope sau patch, không scope cũ. Sau additive migration phải sinh lại types/surface từ live catalog.

- [ ] **Bước 1: Viết ba fixture đỏ và snapshot không đổi sau denial**

```sql
-- Contract A + customer A thành công; contract A + customer B phải 42501.
-- Caller gửi debt=0 trong khi authoritative debt dương phải bị từ chối.
-- Voucher building A patch sang building B khi thiếu B edit phải 42501.
```

Mỗi ca chụp row count, tổng tiền, liên kết và audit trước/sau; denial phải bằng nhau tuyệt đối.

- [ ] **Bước 2: Sửa contract transfer bằng khóa và ràng buộc cùng organization**

```sql
-- Pre-read chỉ tìm exact organization/lock keys, không quyết định quyền.
SELECT c.organization_id, c.id INTO STRICT v_pre
FROM public.contracts c WHERE c.id = p_contract_id;

PERFORM app_private.lock_org_for_decision_v1(v_pre.organization_id);
SELECT * INTO STRICT v_contract FROM public.contracts
WHERE id = v_pre.id AND organization_id = v_pre.organization_id FOR UPDATE;
SELECT * INTO STRICT v_customer FROM public.customers
WHERE id = p_new_customer_id AND organization_id = v_contract.organization_id FOR SHARE;
IF v_contract.organization_id IS NULL
   OR v_customer.organization_id IS DISTINCT FROM v_contract.organization_id THEN
  RAISE EXCEPTION 'customer outside contract organization' USING ERRCODE='42501';
END IF;

PERFORM app_private.lock_org_for_decision_v1(v_contract.organization_id);
SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
  auth.uid(), v_contract.organization_id, 'contracts.transfer', v_contract.building_id, NULL
);
```

Quarantine mismatch hiện có trước khi validate composite foreign keys; giữ audit của ca same-org hợp lệ. Wrapper và `_impl` phải cùng enforce/revalidate exact tuple; test dùng `to_regprocedure` + `pg_get_functiondef`, không chỉ grep một migration lịch sử.

- [ ] **Bước 3: Tính move-out từ authoritative locked state**

Tạo `app_private.compute_moveout_settlement_v1(p_contract_id uuid, p_move_out_date date, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid) RETURNS jsonb` ngay trong migration; helper là `VOLATILE`, chỉ đọc state đã khóa và trả canonical `{deposit,credit,outstandingDebt,penalty,excessRent,refund,shortfall,total}`. Tạo additive `public.terminate_contract_move_out_v2(p_contract_id uuid,p_move_out_date date,p_expected_settlement jsonb,p_notes text,p_extra_charges jsonb,p_shortfall_mode text,p_receipt_account_id uuid,p_idempotency_key text) RETURNS jsonb`; không thay chữ ký legacy 10 đối số. V2 pre-read contract/org không khóa, lấy org lock trước rồi mới khóa/re-read `contract -> invoices/credits/accounts` theo UUID deterministic; ngay trước exact evaluator lặp lại org-lock statement (no-op trên lock đang giữ), tính settlement từ locked state, canonicalize/so `p_expected_settlement` và trả `40001` nếu stale trước write.

Tạo exact `public.terminate_contract_move_out_with_credit_v2(p_contract_id uuid,p_move_out_date date,p_expected_settlement jsonb,p_notes text,p_extra_charges jsonb,p_shortfall_mode text,p_receipt_account_id uuid,p_idempotency_key text) RETURNS jsonb`; hàm dùng cùng expected-settlement contract và delegate V2. Cập nhật `src/hooks/useContractOperations.ts`, `src/lib/customerCreditRpc.ts`, types/surface để client chỉ gọi V2. Không tin bốn số `p_deposit_refund/p_penalty_fee/p_excess_rent/p_outstanding_debt` của hai đường legacy; sau adoption count bằng 0 mới revoke authenticated trên exact 10/11-arg signatures hoặc biến chúng thành fail-closed wrappers không còn ghi. Điều chỉnh penalty tùy ý phải đi qua adjustment ID có permission riêng, không phải numeric client.

- [ ] **Bước 4: Resolve và authorize voucher sau patch**

Trong `public.ie_compat_update_pending_v2(uuid,jsonb,jsonb)`, pre-read row hiện tại chỉ để lấy org/lock keys. Khóa org trước, re-read row và mọi final relation từ `COALESCE(p_patch.field,current.field)`; xác minh building/contract/invoice/room/tenant/type/account đều cùng `v_target_org`, rồi khóa resource theo UUID deterministic. Không dùng `app_private.ie_can_edit_money_axis_v1(uuid,uuid)` (helper `STABLE` hiện lấy quyết định trước org lock) cho bất kỳ remediation decision nào; inline cặp lock/evaluator hoặc tạo helper `VOLATILE` mới. Ngay trước mỗi decision current/final scope gọi:

```sql
PERFORM app_private.lock_org_for_decision_v1(v_target_org);
SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
  auth.uid(), v_target_org, 'income_expenses.edit', v_target_building, v_target_account
);
IF NOT COALESCE(v_allowed, false) THEN
  RAISE EXCEPTION 'not authorized for resulting voucher scope' USING ERRCODE='42501';
END IF;
```

Hook chỉ gọi signature guarded, không fallback compatibility.

- [ ] **Bước 5: Chứng minh concurrency, idempotency, mutation và reconciliation**

```powershell
node scripts/dot-bien.mjs --file supabase/migrations/20260814013000_pending_voucher_final_scope_guard.sql --tim "auth.uid(), v_target_org, 'income_expenses.edit', v_target_building, v_target_account" --thay "auth.uid(), v_current_org, 'income_expenses.edit', v_current_building, v_current_account" --suite "npx vitest run src/lib/__tests__/pendingVoucherFinalScopeMigration.test.ts" --mong-doi-chua "resulting voucher scope"
node scripts/reconcile-money.mjs 2026-08
node scripts/reconcile-money-v2.mjs 2026-08
```

Hai session phải chứng minh transfer không đổi org giữa decision/insert, settlement stale buộc retry, replay idempotency không ghi lần hai.

- [ ] **Bước 6: Chạy focused và E2E**

```powershell
npx vitest run src/lib/__tests__/terminationNonCashPaymentMigration.test.ts src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts src/lib/__tests__/pendingVoucherFinalScopeMigration.test.ts
cd .e2e-fleet
$env:FLEET_WORKERS='4'; npx playwright test specs/termination-refund.spec.ts specs/finance-writers-scope.spec.ts
```

### Task 3: Bỏ duyệt công tơ anonymous và compatibility fallback không an toàn

**Các finding:** `PMETER-C01` occurrence single và bulk.

**Tệp:**
- Create: `supabase/migrations/20260814014000_meter_approval_final_resource_authz.sql`
- Modify: `src/hooks/useMeterReadings.ts`
- Create: `src/lib/__tests__/meterApprovalSecurityMigration.test.ts`
- Modify: `src/hooks/__tests__/meterReadingFilters.contract.test.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Giao diện:** baseline HEAD chỉ có `public.approve_meter_reading(p_reading_id uuid)`, `public.bulk_approve_meter_readings(p_reading_ids uuid[])`, `public.approve_meter_reading_v1(p_id uuid)` và `public.bulk_approve_meter_readings_v1(p_ids uuid[])`; hook hiện gọi V1 rồi fallback sang legacy khi PGRST202. Migration `20260814014000_meter_approval_final_resource_authz.sql` phải **tạo trước khi dùng** exact `public.approve_meter_reading_v2(p_id uuid)` và `public.bulk_approve_meter_readings_v2(p_ids uuid[])`, regenerate types/surface để chứng minh hai ABI mới tồn tại, rồi mới cutover hook, chạy ACL assertions và revoke legacy. Single delegate vào cùng atomic bulk core. Migration phải pin/fail nếu live catalog thiếu bốn baseline signatures; mỗi reading resolve building/org phía server, bulk trộn A/B bị reject nguyên transaction và client typed không fallback legacy.

- [ ] **Bước 1: Viết test đỏ ACL, client và mixed-bulk**

```ts
expect(effectiveAcl('approve_meter_reading(uuid)')).not.toMatch(/PUBLIC|anon|authenticated/);
expect(effectiveAcl('bulk_approve_meter_readings(uuid[])')).not.toMatch(/PUBLIC|anon|authenticated/);
expect(useMeterReadingsSource).not.toMatch(/\.rpc\(\s*["']approve_meter_reading["']/);
expect(useMeterReadingsSource).not.toMatch(/\.rpc\(\s*["']bulk_approve_meter_readings["']/);
```

Ma trận gồm reading A được phép, B bị cấm, list `[A,B]` reject atomic và cả hai row không đổi.

- [ ] **Bước 2: Tạo RPC authenticated authorize từng reading cuối**

Pre-read IDs/reading→meter→building→org không khóa; reject auth NULL, array NULL/rỗng, ID NULL/trùng, thiếu row và vượt `c_max_readings_per_call=200`. Lấy distinct org UUID tăng dần và acquire `app_private.lock_org_for_decision_v1(org)` theo đúng thứ tự đó. Sau khi đủ org lock, re-read exact reading→meter→building→org `FOR UPDATE`, fail nếu tuple drift, rồi xử lý reading/building tăng dần. Ngay trước mỗi `authorize_tenant_action_v3(auth.uid(), exact_org, 'meter_readings.edit', exact_building, NULL)` lặp lại exact org-lock statement; một deny làm rollback toàn batch.

Revoke exact legacy `public.approve_meter_reading(uuid)` và `public.bulk_approve_meter_readings(uuid[])` khỏi `PUBLIC, anon, authenticated`; với hai V1 catalog-only cũng revoke `PUBLIC, anon, authenticated` hoặc thay bằng wrappers delegate V2 nếu telemetry chứng minh còn caller. Chỉ grant V2 cho `authenticated, service_role`; giữ `service_role` trên legacy chỉ khi inventory chứng minh job nội bộ cần và job đã có explicit contract test.

- [ ] **Bước 3: Xóa fallback và regenerate surface**

`src/hooks/useMeterReadings.ts` chỉ gọi V2, bỏ mọi `as any` quanh RPC và không retry/fallback khi PGRST thiếu hàm. Thứ tự bắt buộc: apply additive V2 -> regenerate/check `src/integrations/supabase/types.ts` và `contracts/surfaces/rpc-surface.json` -> focused call smoke -> deploy hook -> đo legacy caller bằng 0 -> revoke. Argument names và ACL phải được pin cho cả sáu exact signatures gồm bốn baseline và hai V2 mới.

- [ ] **Bước 4: Chạy đột biến hợp lệ bỏ quyết định deny**

```powershell
node scripts/dot-bien.mjs --file supabase/migrations/20260814014000_meter_approval_final_resource_authz.sql --tim "IF NOT COALESCE(v_allowed, false) THEN" --thay "IF false AND NOT COALESCE(v_allowed, false) THEN" --suite "npx vitest run src/lib/__tests__/meterApprovalSecurityMigration.test.ts" --mong-doi-chua "foreign meter reading must remain unchanged"
```

- [ ] **Bước 5: Chạy focused gates**

```powershell
npx vitest run src/lib/__tests__/meterApprovalSecurityMigration.test.ts src/hooks/__tests__/meterReadingFilters.contract.test.ts
npm run gate:rpc-surface
npm run gate:rpc-arg-names
```

### Task 4: Chặn forged Zalo queue và revalidate trước provider I/O

**Các finding:** `FR009-C03`, `PZALO-C01` send/react/recall/history, `PZALO-C02`.

**Tệp:**
- Create: `supabase/migrations/20260814015000_zalo_queue_containment.sql`
- Create: `supabase/migrations/20260814016000_zalo_capability_enqueue_rpcs.sql`
- Create: `supabase/migrations/20260814016500_zalo_legacy_entrypoint_revoke.sql`
- Modify: `src/hooks/useZaloChat.ts`
- Modify if still present at implementation time: `src/hooks/chat-zalo/useZaloConversationActions.ts`
- Modify if still present at implementation time: `src/hooks/chat-zalo/useZaloMedia.ts`
- Modify: `src/pages/chat-zalo/ChatZaloPage.tsx`
- Modify: `worker/lib/queue.js`
- Create: `scripts/test-zalo-capability-security.mjs`
- Create: `scripts/__tests__/zalo-capability-security.test.mjs`
- Modify: `src/lib/openclaw-zalo/__tests__/actionContractsAgainstSql.test.ts`
- Modify: `.e2e-fleet/specs/openclaw-zalo.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Giao diện:** browser role không DML trực tiếp queue; enqueue RPC derive actor/org/account/conversation/message; `worker/lib/queue.js` chạy `validateZaloCommandScope(job)` sau atomic claim nhưng ngay trước mọi provider call và reject atomic nếu tuple/capability không còn hợp lệ. Legacy Chat Zalo hook/page và các hook tách mới dưới `src/hooks/chat-zalo/` phải nhận selected organization, đưa org vào mọi query key/realtime filter/RPC và không còn ghi trực tiếp table/queue hoặc gọi RPC broad cũ. Các poll read-only cho `status/result/last_error` trong `useZaloConversationActions.ts` và `useZaloMedia.ts` được giữ qua một service/hook org-scoped, chỉ đọc đúng `job_id` do RPC trả về và phải có test deny job khác org; không biến containment thành cấm đọc kết quả async cần cho UI. Task này đóng queue forgery và arbitrary history/send target; exact reaction/recall business permission của `FR009-C01/C02` nằm ở Task 10 P2.

- [ ] **Bước 1: Viết fixture hai tổ chức và provider spy đỏ**

Org A actor có send/view trong A; org B có account/conversation/message. Direct queue DML, cross-org send/history, forged react/recall, tuple org A + account/conversation B, NULL scope và realtime/read khác org phải fail. Seed command cấu trúc hợp lệ nhưng scope sai; mọi provider spy phải chưa được gọi.

- [ ] **Bước 2: Viết containment/revoke exact signature và quarantine hàng không chứng minh được scope**

```sql
REVOKE INSERT, UPDATE, DELETE ON public.zalo_send_queue FROM authenticated;
DROP POLICY IF EXISTS zalo_send_queue_owner_all ON public.zalo_send_queue;
REVOKE ALL ON FUNCTION public.zalo_send_message(uuid,text,text,text,jsonb,text,jsonb,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zalo_load_history(uuid,integer) FROM PUBLIC, anon, authenticated;
```

`20260814015000_zalo_queue_containment.sql` chỉ backfill/quarantine và thêm typed columns/constraint/index/status cần cho worker/RPC v2; nó không revoke RPC/table path mà client v1 còn dùng. `20260814016000_zalo_capability_enqueue_rpcs.sql` phải tạo hai exact identities sau **trước khi dùng**:

- `public.zalo_send_message_v2(p_organization_id uuid,p_conversation_id uuid,p_type text DEFAULT 'text',p_body text DEFAULT NULL,p_media_url text DEFAULT NULL,p_reply_to jsonb DEFAULT NULL,p_cli_msg_id text DEFAULT NULL,p_mentions jsonb DEFAULT NULL,p_reply_to_message_id uuid DEFAULT NULL) RETURNS public.zalo_messages`; `VOLATILE SECURITY DEFINER`, revoke `PUBLIC, anon`, grant exact signature cho `authenticated, service_role`. `p_organization_id` là explicit caller context nhưng account/conversation/message/queue organization vẫn derive và revalidate từ row đã khóa; mismatch fail `42501`. Response giữ nguyên row shape để `useSendZaloMessage` thay optimistic bubble bằng `mapMsg(data)` mà không cần query phụ.
- `public.zalo_load_history_v2(p_organization_id uuid,p_conversation_id uuid,p_count integer DEFAULT 50) RETURNS uuid`; `VOLATILE SECURITY DEFINER`, revoke `PUBLIC, anon`, grant exact signature cho `authenticated, service_role`. Return duy nhất exact `job_id` đã insert; clamp `p_count` về `1..200`, bind group conversation/account/org và `chat_zalo.view`. Client poll kết quả qua org-scoped queue-result service, không suy job theo conversation hay đọc hàng khác org.

Ngay sau additive apply, catalog smoke phải trả đúng identity:

```sql
SELECT to_regprocedure('public.zalo_send_message_v2(uuid,uuid,text,text,text,jsonb,text,jsonb,uuid)');
SELECT to_regprocedure('public.zalo_load_history_v2(uuid,uuid,integer)');
```

Smoke tiếp tục kiểm `pg_get_function_result`, `provolatile='v'`, `prosecdef=true`, argument names/order trong `pg_proc.proargnames`, effective ACL và generated types/surface trước hook/page cutover. Caller mapping bắt buộc: `src/hooks/useZaloChat.ts` send/history chuyển sang hai V2 và truyền selected organization; `src/pages/chat-zalo/ChatZaloPage.tsx` chỉ gọi qua các hook typed đó. `src/hooks/chat-zalo/useZaloConversationActions.ts` (`zalo_start_chat_by_phone`) và `src/hooks/chat-zalo/useZaloMedia.ts` (`zalo_sticker_search`, cùng các enqueue async liên quan) không được đổi tên thành send/history V2, nhưng mọi RPC enqueue của chúng phải trả exact `job_id` và dùng chung queue-result service org-scoped; `zalo_send_media` phải nhận/revalidate selected organization hoặc có V2 exact riêng được pin trong cùng migration nếu inventory chứng minh signature hiện tại không thể mở rộng tương thích. Không để direct `.from('zalo_send_queue')` rải trong từng hook.

Exact revoke ở trên nằm riêng trong `20260814016500_zalo_legacy_entrypoint_revoke.sql` và chỉ apply sau khi hook/page v2 đã deploy, source + deployed telemetry cho `zalo_send_message(uuid,text,text,text,jsonb,text,jsonb,uuid)`, `zalo_load_history(uuid,integer)` và browser queue DML bằng 0, queue cũ đã drain/quarantine, worker revalidation đang chạy. Live catalog checkpoint cho thấy hai RPC còn executable cho `anon/authenticated/service_role`; queue cấp `authenticated` đủ `INSERT/SELECT/UPDATE/DELETE` và còn các policy `ALL` theo membership/send scope, trong khi SELECT org-scoped phục vụ poll async. Vì vậy catalog test phải đọc effective table ACL + policy list của queue và `proacl` của đúng hai signatures; revoke write grants/policy nhưng giữ một SELECT policy tối thiểu bind `auth.uid()`, organization và exact job do caller tạo/RPC trả về. Migration lỗi nếu signature expected không tồn tại thay vì bỏ qua im lặng. Row chưa xử lý có tuple actor/org/account/conversation/message không chứng minh được phải chuyển `REJECTED_SCOPE` kèm audit, không execute và không xóa im lặng. Trước migration đầu tiên, regenerate/check `contracts/surfaces/rpc-surface.json`; manifest checkpoint đang stale riêng ở send 6 đối số và không được dùng để pin revoke.

- [ ] **Bước 3: Tạo enqueue RPC derive toàn bộ foreign key từ row đã khóa**

```sql
-- Lần đọc đầu chỉ tìm lock keys, không phải quyết định quyền.
SELECT c.id, c.organization_id, c.account_id
INTO STRICT v_pre
FROM public.zalo_conversations c
JOIN public.zalo_accounts a ON a.id = c.account_id
WHERE c.id = p_conversation_id
  AND a.organization_id = c.organization_id;

PERFORM app_private.lock_org_for_decision_v1(v_pre.organization_id);
SELECT * INTO STRICT v_account
FROM public.zalo_accounts
WHERE id = v_pre.account_id AND organization_id = v_pre.organization_id
FOR SHARE;
SELECT * INTO STRICT v_target
FROM public.zalo_conversations
WHERE id = v_pre.id
  AND organization_id = v_pre.organization_id
  AND account_id = v_account.id
FOR UPDATE;

-- Gọi lại là no-op trên lock đang giữ, nhưng giữ đúng contract: statement ngay
-- trước evaluator và snapshot quyền không thể được lấy trước organization lock.
PERFORM app_private.lock_org_for_decision_v1(v_target.organization_id);
SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
  auth.uid(), v_target.organization_id, 'chat_zalo.send', NULL, NULL
);
IF NOT COALESCE(v_allowed, false) THEN
  RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
END IF;
```

Đối số thứ năm của evaluator là `p_cashbook_id`, vì vậy Zalo luôn truyền `NULL`; account/conversation/message được kiểm bằng tuple riêng, không ép UUID Zalo vào domain cashbook. Mọi action dùng cùng lock order `organization -> account -> conversation -> message -> queue`; pre-read chỉ tìm lock key, sau lock phải re-read exact tuple và fail nếu drift. Backfill/quarantine trước khi đặt scope columns non-null; thêm unique/composite FK hoặc constraint trigger để `account.organization_id = conversation.organization_id = message/queue.organization_id` và account/conversation IDs khớp nhau. Queue organization/account/message luôn derive từ row đã khóa, không lấy từ payload. History bind conversation/account/org, gọi exact `chat_zalo.view` sau revalidation và org-lock statement ngay trước evaluator. `useZaloChat`/`ChatZaloPage` bỏ caller legacy, org-scope query/realtime cache và fail closed khi selected org null.

- [ ] **Bước 4: Revalidate trong worker ngay trước provider call**

```js
const commandScope = await validateZaloCommandScope(job);
if (!commandScope.ok) {
  await rejectZaloCommand(job.id, 'REJECTED_SCOPE', commandScope.reason);
  return;
}
```

Helper nằm trong hoặc cạnh `worker/lib/queue.js`, join lại job -> account -> conversation -> message/requester, kiểm status, org/account equality, capability version và action target. Mọi nhánh provider (`sendMessage`, media, react, recall, history, delete, seen, typing, find-user, sticker) phải đi qua guard này sau claim `queued -> processing`; không dùng payload queue làm source of truth. `worker/index.js` chỉ còn bootstrap/poll và không phải vị trí mutation của guard.

- [ ] **Bước 5: Chạy đột biến JS hợp lệ bỏ worker revalidation**

```powershell
node scripts/dot-bien.mjs --file worker/lib/queue.js --tim "if (!commandScope.ok) {" --thay "if (false && !commandScope.ok) {" --suite "node --test scripts/__tests__/zalo-capability-security.test.mjs" --mong-doi-chua "provider must not be called for rejected scope"
```

- [ ] **Bước 6: Chạy package tests và E2E provider-safe**

```powershell
node --test scripts/__tests__/zalo-capability-security.test.mjs
npx vitest run src/lib/openclaw-zalo/__tests__/actionContractsAgainstSql.test.ts
npm run test:openclaw:services
npm run test:openclaw:sql:local
cd .e2e-fleet
$env:FLEET_WORKERS='2'; npx playwright test specs/openclaw-zalo.spec.ts
```

Không gửi message thật; chỉ dùng fake/provider-safe DEMO adapter.

### Task 5: Gắn salary ledger vào một organization được authorize rõ ràng

**Các finding:** `FR009-C04`, `FR009-C05`.

**Tệp:**
- Create: `supabase/migrations/20260814017000_salary_ledger_org_boundary.sql`
- Create: `supabase/migrations/20260814017500_salary_ledger_legacy_revoke.sql`
- Modify: `src/hooks/useManagerSalary.ts`
- Create: `src/lib/__tests__/salaryTenantBoundaryMigration.test.ts`
- Modify: `src/lib/__tests__/salaryCompletionDate.test.ts`
- Modify: `.e2e-fleet/specs/salary-mobile-period.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Giao diện:** baseline HEAD chỉ có `public.salary_work_ledger(p_period_month date,p_staff_id uuid DEFAULT NULL)` và hook đang gọi signature này; V2 chưa tồn tại. Migration additive `20260814017000_salary_ledger_org_boundary.sql` phải **tạo trước khi dùng** exact `public.salary_work_ledger_v2(p_organization_id uuid,p_period_month date,p_staff_id uuid DEFAULT NULL)`, regenerate types/surface và smoke ABI rồi mới cutover hook. JOB, DAY_BONUS, CASH, config, holiday, building, room và staff cùng org; NULL staff chỉ là org-wide khi caller có quyền, không bao giờ là global. Migration additive không revoke legacy. Chỉ sau khi hook V2 đã deploy, source inventory và deployed telemetry xác nhận caller `salary_work_ledger(date,uuid)` bằng 0, role-real V2 xanh và catalog readback pin đúng signature mới apply `20260814017500_salary_ledger_legacy_revoke.sql`; file revoke phải fail nếu exact legacy identity thiếu và revoke `PUBLIC, anon, authenticated`, chỉ giữ `service_role` nếu inventory chứng minh một job nội bộ cụ thể còn cần cùng contract test. Không giữ wrapper suy organization bằng `LIMIT 1`.

- [ ] **Bước 1: Viết live-definition và fixture A/B đỏ**

```ts
const sql = liveDefinitionOf('salary_work_ledger_v2');
expect(sql).toContain('p_organization_id');
expect(sql).not.toMatch(/is_super_admin[\s\S]{0,120}limit\s+1/i);
```

- [ ] **Bước 2: Implement explicit organization và fail closed**

```sql
IF p_organization_id IS NULL OR auth.uid() IS NULL THEN
  RAISE EXCEPTION 'organization context required' USING ERRCODE='42501';
END IF;
PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
  auth.uid(), p_organization_id, 'salary.view', NULL, NULL
);
IF NOT COALESCE(v_allowed, false) THEN
  RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
END IF;
```

`salary_work_ledger_v2(p_organization_id uuid,p_period_month date,p_staff_id uuid DEFAULT NULL)` là `VOLATILE SECURITY DEFINER`. Actor ACTIVE không có `salary.view` vẫn được xem duy nhất chính mình khi `p_staff_id=auth.uid()`; xem staff khác hoặc `p_staff_id IS NULL` bắt buộc exact `salary.view` và chỉ resolve staff ACTIVE trong org. CASH/JOB/DAY_BONUS/config/holiday/building/room đều filter `organization_id=p_organization_id`. Revoke `PUBLIC, anon`, grant exact V2 cho `authenticated` và pin duy nhất catalog key `salary.view`; không tạo alias số nhiều.

`20260814017500_salary_ledger_legacy_revoke.sql` chỉ chứa containment sau adoption cho exact `public.salary_work_ledger(date,uuid)` cùng catalog assertion; không được gộp vào additive migration để giảm số file.

- [ ] **Bước 3: Cập nhật hook và query key**

Hook bắt buộc current authorized org, truyền RPC arg và đưa org vào React Query key; không chọn first super-admin toàn cục.

- [ ] **Bước 4: Mutation, money và E2E**

Đột biến xóa đúng một predicate `cash.organization_id = p_organization_id` bằng thay thế thành `cash.organization_id IS NOT NULL`; cross-org CASH assertion phải đỏ và hash phục hồi.

```powershell
npx vitest run src/lib/__tests__/salaryTenantBoundaryMigration.test.ts src/lib/__tests__/salaryCompletionDate.test.ts src/lib/__tests__/salaryPeriod.test.ts
npm run gate:salary-completion-date
node scripts/reconcile-money.mjs 2026-08
node scripts/reconcile-money-v2.mjs 2026-08
cd .e2e-fleet
$env:FLEET_WORKERS='2'; npx playwright test specs/salary-mobile-period.spec.ts
```

### Task 6: Xây harness PostgreSQL dùng một lần cho remediation

**Tệp:**
- Tạo: `scripts/security-disposable-db.mjs`
- Tạo: `scripts/test-security-remediation.mjs`
- Tạo: `scripts/__tests__/security-disposable-db.test.mjs`
- Tạo: `scripts/__tests__/security-remediation-manifest.test.mjs`
- Tạo: `scripts/check-security-remediation-manifest.mjs`
- Tạo: `tooling/security-remediation-manifest.json`
- Tạo: `tooling/security-remediation-manifest.sha256`
- Sửa: `package.json`
- Sửa: `tooling/test-matrix.json`
- Sửa: `.github/workflows/ci-gates.yml`

**Giao diện:** runner chỉ có explicit `--dry-run`, `--local-cluster` hoặc `--role-real`; không có live/default mode. `--local-cluster` bắt buộc tạo/chọn PostgreSQL disposable URL rồi gọi nguyên văn `node scripts/dien-tap-khoi-phuc-baseline.mjs --dich <resolved-url>`; `--role-real` nhận target Supabase-compatible DEMO/TEST đã preflight, không tự biến thành production. Nguồn case bắt buộc duy nhất là immutable manifest `tooling/security-remediation-manifest.json` khóa bằng `tooling/security-remediation-manifest.sha256`, chứa đúng 49 occurrence của bảng mapping cuối plan và scan revision. Runner xuất JSON verdict/receipts đối chiếu manifest và fail nếu thiếu, trùng, thừa hoặc case đã được chọn nhưng không chạy để chống xanh rỗng. Full execution chỉ được yêu cầu cho tập occurrence mà selector chọn và các suite/artifact của batch đó đã được implement; `--dry-run` chỉ validate manifest, selector, command graph, required artifact declarations và capability routing, không chạy business case. Trong cùng Task 6, `package.json` phải thêm exact script `"gate:security-remediation-manifest": "node scripts/check-security-remediation-manifest.mjs"`; script này chưa tồn tại trên baseline, nên không được chạy Task 7 hoặc bất kỳ integrated gate nào trước khi checker + npm alias đã được tạo và unit test xanh.

`--case <occurrenceId>` và `--priority <P1|P2|P3>` chỉ là selector trên manifest, không phải mode mới; selector không có entry hoặc suite không chạy là exit 3. Task 1 phụ thuộc Task 6 cho mutation/fixture runner; nếu triển khai Task 1 trước, dùng trực tiếp `scripts/test-lucky-payout-capability.mjs` nhưng vẫn phải đăng ký receipt `FR001-C03` vào manifest trước integrated P1 gate.

- [ ] **Bước 1: Ghi nhận đúng trạng thái baseline trước khi code harness**

Repo có `supabase/baseline/platform-shim.sql`, `roles.sql`, `schema.sql`, `manifest.json` và runner an toàn `scripts/dien-tap-khoi-phuc-baseline.mjs`. Baseline thay cho replay lịch sử; harness không được tự viết lại logic restore hoặc tuyên bố bootstrap thành công chỉ vì `psql` exit, mà phải gọi runner sẵn có và tiếp tục kiểm inventory object cần cho remediation.

```powershell
npm run gate:baseline-doc
```

- [ ] **Bước 2: Viết test đỏ cho lifecycle an toàn của cluster**

Kiểm PostgreSQL 17.x, port loopback ngẫu nhiên, sentinel trong TEMP đã resolve, deadline toàn cục, `pg_ctl stop` được xác minh, port đóng sau dọn, từ chối production connection/env và cleanup cả khi assertion ném lỗi.

- [ ] **Bước 3: Bootstrap theo baseline, tuyệt đối không replay history**

Lệnh bootstrap duy nhất từ harness:

```powershell
node scripts/dien-tap-khoi-phuc-baseline.mjs --dich $disposableConnection
```

Existing runner tự parse `--dich`, từ chối `manifest.sourceProject`, chạy đúng thứ tự `platform-shim.sql -> roles.sql -> schema.sql lượt 1 -> schema.sql lượt 2`, rồi so bảng/view/policy/trigger với manifest và gate tối thiểu 99%. `security-disposable-db.mjs` sở hữu adapter `startDisposablePostgres17() -> { connectionString, stop, identity }`; `test-security-remediation.mjs --local-cluster` truyền `connectionString` đó sang exact CLI trên, ghi command/digest vào receipt và chỉ tiếp tục khi exit 0. Sau đó nó kiểm required-object list riêng và apply ordered forward-remediation migrations mới hơn cutoff. Không quét toàn thư mục migration, không replay migration history/archive, không bịa alias `baseline-runner` hay mode `--local-cluster` cho script baseline hiện hữu. Nếu còn thiếu Supabase runtime semantics bắt buộc, báo capability gap và dùng local Supabase-compatible cluster cho role-real lane; không tạo shim ngoài `platform-shim.sql` chuẩn của repo.

- [ ] **Bước 4: Seed fixed A/B và chạy assertion trong rollback transaction**

Seed UUID cố định cho org A/B, owner/staff/limited, building, cashbook/account, contract/customer, finance objects, meter, salary, Zalo account/conversation/message/queue và public capability. Catalog/constraint setup tồn tại trong cluster; từng business assertion chạy transaction rollback.

- [ ] **Bước 5: Đăng ký runner và anti-green-empty cases**

Manifest dùng khóa occurrence ổn định, không chỉ candidate ID: sáu entry `PANALYTICS-C01/summary`, `/time-series`, `/top-rooms`, `/funnel`, `/token`, `/errors`; hai entry `PMETER-C01/single`, `/bulk`; bốn entry `PZALO-C01/send`, `/react`, `/recall`, `/history`; các finding đơn dùng chính finding ID, gồm `S49`. Header bắt buộc có `schemaVersion`, scan ID/revision, `occurrenceCount=49`, `priorityCounts={P1:14,P2:26,P3:9}`; mỗi entry có `occurrenceId`, `task`, `suiteId`, `runner`, positive/negative case IDs, `role`, `organizationScope`, `resourceScope`, `expectedDecision`, `mutationId`. Validator có expected occurrence set độc lập trong code, canonicalize JSON bằng key ordering ổn định + LF rồi kiểm external digest; reject malformed/unreadable, missing, duplicate, reordered/extra ID, priority/task/suite drift, digest mismatch, suite/assertion/mutation rỗng. Không tin digest tự khai trong JSON.

```powershell
node scripts/test-security-remediation.mjs --dry-run
node --test scripts/__tests__/security-disposable-db.test.mjs scripts/__tests__/security-remediation-manifest.test.mjs
npm run gate:security-remediation-manifest
```

Task 6 không chạy full `--local-cluster`: tại thời điểm này các case P1/P2/P3 và migration của Task 1-5, 8-12, 14-17 chưa đồng thời tồn tại. Unit test của disposable adapter dùng fixture tối thiểu/temporary manifest để chứng minh start -> baseline bootstrap -> assertion giả lập -> cleanup/port closed; full selected suites bắt đầu ở Task 7 (`--priority P1`), Task 13 (`--priority P2`) và Task 18 (toàn bộ manifest).

Verdict chứa `manifestDigest`, `runId`, batch/mode/target identity, reviewed commit, baseline/migration digests, `expectedCount`, `executedCount`, `receipts[]`, cleanup/port-closed evidence và `unexpectedCaseIds[]`. Mỗi receipt bind occurrence ID với exact command/suite, role/JWT actor, org/resource IDs, assertion count, expected/actual decision, positive + negative result, mutation receipt, stdout/stderr digest và rollback/cleanup. Exit `0` chỉ khi coverage đầy đủ; exit `1` cho assertion đã chạy nhưng fail; exit `3` cho manifest/capability/credential gap, `NOT_RUN`, uncertain cleanup hoặc incomplete receipt. `tooling/test-matrix.json` và CI phải đăng ký manifest gate + runner thật; không được coi exit 3/skipped là pass.

`scripts/test-cross-tenant.mjs` chỉ có ma trận Network Center và `--local-disposable` của nó replay history riêng; giữ làm supplemental Network Center evidence, tuyệt đối không dùng receipt đó để đóng Lucky, finance, salary, Zalo, analytics hoặc S49. Generic remediation harness chỉ bootstrap bằng baseline runner chuẩn rồi apply explicit ordered forward-remediation list có digest/provenance; không glob migration và không gọi Network Center replay lane.

### Task 7: Hoàn tất integrated gate P1 trước khi bắt đầu P2

**Prerequisite cứng:** Task 1-6 đều đã tạo xong artifact của mình và focused verification xanh. Đặc biệt Task 4 phải đã tạo Zalo harness/test, Task 6 phải đã tạo disposable runner, manifest checker, npm alias `gate:security-remediation-manifest` và đăng ký test matrix/CI; file hoặc script vắng mặt là blocker/exit 3, không phải skip/pass.

- [ ] **Bước 1: Chạy focused P1 và harness**

```powershell
npx vitest run src/lib/__tests__/luckyDrawSecurityMigration.test.ts src/lib/__tests__/terminationNonCashPaymentMigration.test.ts src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts src/lib/__tests__/pendingVoucherFinalScopeMigration.test.ts src/lib/__tests__/meterApprovalSecurityMigration.test.ts src/lib/__tests__/salaryTenantBoundaryMigration.test.ts src/lib/__tests__/salaryCompletionDate.test.ts
node --test scripts/__tests__/zalo-capability-security.test.mjs scripts/__tests__/security-disposable-db.test.mjs
node scripts/test-security-remediation.mjs --local-cluster --priority P1
npm run test:openclaw:sql:local
```

- [ ] **Bước 2: Chạy database/security gates P1**

```powershell
npm run gate:stable-fn-locks
npm run gate:definer-acl
npm run gate:permission-catalog
npm run gate:migration-provenance
npm run gate:migration-test-liveness
npm run gate:migration-idempotent
npm run gate:rpc-surface
npm run gate:rpc-arg-names
npm run gate:rpc-layer
npm run gate:org-boundary-inventory
```

- [ ] **Bước 3: Chạy role-real và money P1**

```powershell
node scripts/test-security-remediation.mjs --role-real --priority P1
node scripts/measure-org-leak.mjs
node scripts/reconcile-money.mjs 2026-08
node scripts/reconcile-money-v2.mjs 2026-08
node scripts/clone-org/snapshot.mjs after
```

Nếu gate P1 bắt buộc không chạy được, ghi rõ capability gap và dừng; không bắt đầu P2.

## P2 - Hoàn thiện boundary mức Medium

### Task 8: Redact public projection và gắn Lucky proof upload với capability

**Findings:** `FR001-C01`, `FR001-C04`.

**Files:**
- Create: `supabase/migrations/20260814020000_public_room_projection_redaction.sql`
- Create: `supabase/migrations/20260814021000_lucky_proof_upload_capability.sql`
- Create: `supabase/migrations/20260814021100_lucky_proof_upload_legacy_revoke.sql`
- Create: `supabase/functions/lucky-proof-upload/index.ts`
- Create: `supabase/functions/lucky-proof-upload/index.test.ts`
- Create: `supabase/functions/lucky-proof-upload/deno.json`
- Modify after dependency resolution: `deno.lock`
- Modify: `src/pages/phong-trong/supabaseData.ts`
- Modify: `src/pages/phong-trong/PhongTrongSheet.tsx`
- Modify: `src/lib/luckyDrawApi.ts`
- Create: `src/pages/phong-trong/__tests__/publicRoomProjection.test.ts`
- Create: `src/lib/__tests__/luckyProofUploadSecurityMigration.test.ts`
- Modify: `.e2e-fleet/specs/quayso-lucky-draw.spec.ts`
- Modify: `.e2e-fleet/specs/phong-trong-export-image.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`
- Modify after generation: `contracts/surfaces/edge-function-surface.json`

- [ ] **Bước 1: Viết projection/upload tests đỏ**

```ts
expect(publicPayload).not.toHaveProperty('sale_bonus_note');
expect(publicAdapterSource).not.toContain('sale_bonus_note');
expect(liveDefinition('public.lucky_issue_proof_upload_ticket_v1(text,bigint,uuid,text,text,bigint)')).toMatch(/lock_org_for_decision_v1[\s\S]*secure_bytea_equal_v1[\s\S]*reserved_bytes/i);
expect(edgeSource).toMatch(/lucky_consume_proof_upload_ticket_v1[\s\S]*TransformStream/i);
expect(edgeSource).not.toMatch(/arrayBuffer\(|formData\(|uploadLuckyProof\([^)]*eventId/i);
expect(clientSource).not.toMatch(/storage\/v1\/object[\s\S]*lucky-proofs/i);
```

- [ ] **Bước 2: Thay row serialization bằng allowlist public**

Không dùng `to_jsonb(rms)`; dựng object chỉ từ guest-facing fields đã tài liệu hóa. Xóa `sale_bonus_note` khỏi TypeScript payload/render và thêm contract test chặn cột nội bộ mới tự lọt vào response.

- [ ] **Bước 3: Bind proof upload và quota**

Không thêm payout-capability registry thứ hai. Migration tạo `app_private.lucky_proof_upload_tickets` và `app_private.lucky_proof_objects`; cả hai private ACL, FK bind capability/organization/event/team và có trạng thái explicit `reserved|uploading|uploaded|failed|expired`. RPC `public.lucky_issue_proof_upload_ticket_v1(p_capability, p_expected_revision, p_idempotency_key, p_file_name, p_mime, p_bytes)` resolve payout capability bằng cùng parser, lock order và `secure_bytea_equal_v1` của Task 1, nhưng không tăng payout revision; dưới capability lock nó atomically reserve count/bytes, tạo object path server-side `<organization>/<event>/<team>/<uuid>.<ext>` và trả raw ticket một lần có `jti.secret`, expiry <= 5 phút, `maxUses=1`. Cùng idempotency key + cùng metadata trả lại cùng reservation nhưng không được trả lại raw secret sau response đầu; client mất response phải yêu cầu reservation mới sau khi reservation cũ được hủy/expire, không tạo endpoint đọc secret.

Edge Function `lucky-proof-upload` là ingress duy nhất cho participant và nhận raw body cùng ticket ở header riêng; CORS allowlist không log header. Function gọi `lucky_consume_proof_upload_ticket_v1` để hash/kiểm secret, lock org -> event -> team -> capability -> ticket, recheck expiry/revoke/audience/MIME/declared bytes và CAS `reserved -> uploading` trước provider I/O. Nó từ chối `Content-Length` thiếu/sai/vượt cap, đồng thời bọc `request.body` bằng `TransformStream` đếm byte thật và abort khi vượt reservation trước khi chuyển tiếp stream tới bucket private bằng service credential chỉ nằm trong Edge env; không gọi `arrayBuffer()`/`formData()`. Sau provider success, RPC finalize chỉ chuyển `uploading -> uploaded` khi object path/size/MIME/etag khớp; provider failure/abort chuyển `failed`, best-effort xóa object theo exact path và không tạo metadata usable. Retry ticket đã consume fail closed; reconciliation job dọn `reserved/uploading` quá TTL và exact orphan path, có receipt số reservation/object đã dọn.

Participant không gửi organization/event/team/path làm authority. `luckySavePayout` sau Task 8 chỉ nhận proof object IDs; writer join `lucky_proof_objects` trạng thái `uploaded` của cùng capability/organization/event/team rồi dựng public proof metadata server-side, không chấp nhận path/name/at do client tự khai. Migration additive `20260814021000_lucky_proof_upload_capability.sql` chỉ tạo ticket/object registry, RPC/Edge contract và path mới; không drop policy upload legacy hoặc revoke entrypoint đang được client/runtime dùng. Sau Edge `lucky-proof-upload` và client proof-object flow đã deploy, source inventory + deployed telemetry xác nhận direct Storage upload và caller `public.lucky_event_open_v1(text)` bằng 0, role-real ticket flow xanh và object reservation cũ đã drain/expire, mới apply `20260814021100_lucky_proof_upload_legacy_revoke.sql`. Migration revoke phải `DROP POLICY IF EXISTS "lucky proofs upload" ON storage.objects`, revoke exact `public.lucky_event_open_v1(text)` khỏi `PUBLIC, anon, authenticated`, và readback `pg_policies`/`proacl` chứng minh bucket không còn INSERT cho anon/authenticated; giữ hoặc drop helper legacy tùy dependency inventory nhưng không để client execute. Staff read/review đi qua signed read RPC/Edge path có authenticated actor, org lock và exact event/team check.

- [ ] **Bước 4: Role-real, mutation và E2E**

Anonymous room RPC với DEMO token không có internal field. Deno test dùng stream nhiều chunk và provider fake backpressure để chứng minh byte counter chạy trước materialization; body lớn hơn declared/reserved làm abort, provider không finalize và cleanup về zero usable object. Role-real/E2E chứng minh valid ticket -> upload -> object ID -> payout metadata thành công; wrong-team, expired, revoked, replayed, over-budget, wrong MIME/bytes, raw path tự khai và direct Storage POST bằng anon key không tạo object usable hoặc payout metadata. Task 1 chỉ hoạt động với object fixture/pre-upload hợp lệ, còn upload mới không thể xảy ra nếu chưa qua ticket Task 8. Đột biến bỏ ticket consume/CAS/tuple predicate phải làm assertion upload có tên đỏ; đột biến thêm lại `sale_bonus_note` vào allowlist phải làm projection test đỏ.

### Task 9: Đồng nhất permission report/admin/analytics/Cashbook và truyền organization chuẩn vào Copilot

**Findings:** `FR011-C01`, `FR011-C02`, `FR011-C03`, `FR011-C04`, `FR020-C01`, `FR020-C02`, `FR020-C03`, `PANALYTICS-C01` x6, `S49`.

**Files:**
- Create: `supabase/migrations/20260814022000_report_final_org_and_restricted_authz.sql`
- Create: `supabase/migrations/20260814023000_authz_read_selected_org_binding.sql`
- Create: `supabase/migrations/20260814024000_analytics_exact_permission.sql`
- Create: `supabase/migrations/20260814025000_cashbook_settlement_permission_parity.sql`
- Create: `supabase/migrations/20260814025100_cashbook_settlement_legacy_revoke.sql`
- Modify: `supabase/functions/llm-proxy/index.ts`
- Modify: `src/contexts/OrganizationContext.tsx`
- Modify: `src/contexts/__tests__/OrganizationContext.test.ts`
- Modify: `src/copilot/ChatPanel.tsx`
- Modify: `src/copilot/tools/registry.ts`
- Modify: `src/copilot/tools/nghiepVuTools.ts`
- Modify: `src/copilot/__tests__/nghiepVuTools.test.ts`
- Modify: `src/copilot/__tests__/copilot.test.ts`
- Modify: `src/hooks/useSettlementReport.ts`
- Create: `src/hooks/__tests__/useSettlementReportOrganizationScope.test.ts`
- Modify: `src/pages/reports/finance/BanGiaoReport.tsx`
- Modify: `src/app/routes/settingsRoutes.tsx`
- Modify: `src/app/capabilities/registry.ts`
- Modify: `scripts/test-business-performance-authz.mjs`
- Modify: `scripts/__tests__/business-performance-authz-harness.test.mjs`
- Create: `src/lib/__tests__/analyticsPermissionMigration.test.ts`
- Create: `src/lib/__tests__/cashbookSettlementPermissionMigration.test.ts`
- Modify: `.e2e-fleet/specs/business-performance.spec.ts`
- Modify: `.e2e-fleet/specs/capability-route-smoke.spec.ts`
- Modify: `.e2e-fleet/specs/cashbook-create-org-resolution.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Interfaces:** report nhận/derive đúng một organization; restricted fields cần exact restricted action; Copilot, settlement hook, route và capability registry dùng cùng `cashbooks.view`. `ToolCtx` hiện chỉ có `perms` và `navigate`, nên thêm `organizationId: string | null`. `OrganizationContext` hiện đặt `organization = organizations[0]`, không phải lựa chọn canonical; task phải thêm explicit selected-organization state/API, validate selection thuộc danh sách ACTIVE và fail closed khi nhiều org nhưng chưa chọn. `ChatPanel` và `BanGiaoReport` chỉ truyền ID đã được chọn rõ ràng, không truyền first entry mặc định.

- [ ] **Bước 1: Mở rộng ma trận role-real trước implementation**

Ca bắt buộc: missing/ambiguous org; global permission A target B; restricted deny override; inactive permission; suspended member/org; từng analytics RPC thiếu `sale_phong.view_analytics`; Cashbook tool/hook có `income_expenses.view` nhưng không có `cashbooks.view`; org-wide allow cộng exact cashbook deny; exact cashbook allow không mở sổ khác; positive controls.

- [ ] **Bước 2: Sửa report và canonical deny-wins evaluator**

Xóa first-super-admin fallback. Monthly profit/change/deposit bind final org, gọi exact action, omit restricted rows hoặc require restricted-view trước SELECT. `llm-proxy`, authorization explanation và admin read dùng canonical evaluator gồm org lifecycle, membership, role permission, member override, emergency deny; không chọn first active org sau global `users.view`.

- [ ] **Bước 3: Gate đủ sáu analytics RPC phía server**

Migration và live-definition tests phải pin đủ sáu exact identity hiện hữu: `public.pra_summary(date,date,text,uuid[],boolean)`, `public.pra_timeseries(date,date,text,uuid[],boolean,text)`, `public.pra_top_rooms(date,date,text,uuid[],boolean,integer)`, `public.pra_funnel(date,date,text,uuid[],boolean)`, `public.pra_by_token(date,date,text,uuid[],boolean)` và `public.pra_errors(date,date,text,uuid[],boolean,integer)`. Baseline cả sáu là `STABLE SECURITY DEFINER`; migration đổi chúng sang `VOLATILE` là thay đổi implementation bắt buộc để khóa org, không phải mô tả ABI hiện hữu. Resolve owner/filter tới đúng một final organization, gọi `lock_org_for_decision_v1(exact_org)` ngay trước `authorize_tenant_action_v3(auth.uid(),exact_org,'sale_phong.view_analytics',...)`, rồi mới đọc. Fixture thiếu quyền phải deny riêng từng signature; UI `canUse` chỉ là presentation.

- [ ] **Bước 4: Đóng S49 bằng RPC v2 có organization rõ ràng**

Baseline HEAD chỉ có `public.cashbook_settlement_report(p_from date,p_to date)` và cả `useSettlementReport` lẫn Copilot đang gọi legacy. Migration `20260814025000_cashbook_settlement_permission_parity.sql` phải **tạo trước khi dùng** `public.cashbook_settlement_report_v2(p_organization_id uuid,p_from date,p_to date)`, regenerate types/surface và smoke exact ABI, rồi mới cutover hai caller; migration revoke chỉ chạy sau caller inventory bằng 0. Hàm V2 là `VOLATILE SECURITY DEFINER`, kiểm `auth.uid`, khóa organization, lấy effective scope `cashbooks.view`, rồi chỉ aggregate accounts/sessions/reconciliations thuộc `p_organization_id` và thuộc tập cashbook cuối caller được phép. Không dùng `same_team`, owner heuristic hoặc route permission làm authorization thay thế.

```sql
PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
SELECT org_wide, cashbook_ids
INTO v_org_wide, v_cashbook_ids
FROM app_private.authorized_scope_v3('cashbooks.view', p_organization_id);

IF NOT v_org_wide AND COALESCE(cardinality(v_cashbook_ids), 0) = 0 THEN
  RAISE EXCEPTION 'Không có quyền xem sổ quỹ' USING ERRCODE='42501';
END IF;

-- Mọi nhánh accounts/sessions/reconciliations phải join qua cashbook/account cuối:
-- account.organization_id = p_organization_id
-- AND account.id = ANY(v_cashbook_ids); resolver đã nở org-wide ALLOW thành toàn bộ sổ
-- rồi loại exact DENY, nên không được bypass mảng bằng điều kiện OR v_org_wide.
```

Không dùng lời gọi `authorize_tenant_action_v3` với cả building/cashbook dimension bằng `NULL` làm gate duy nhất cho S49: org-level decision có thể deny một actor chỉ có exact cashbook ALLOW, trong khi report phải trả đúng tập cashbook hiệu lực. `authorized_scope_v3` là nguồn canonical cho org-wide + exact allow trừ deny; org lock vẫn phải là statement ngay trước khi lấy scope để snapshot permission không chạy trước lock.

```ts
export interface ToolCtx {
  perms: PermissionsMap | undefined;
  organizationId: string | null;
  navigate?: (to: string) => void;
}

expect(soQuy.requiredPermission).toEqual({ module: 'cashbooks', action: 'view' });
```

`OrganizationContext` sản xuất `selectedOrganizationId` và `selectOrganization(id)`; nếu chỉ có một ACTIVE org có thể chọn tự động, còn multi-org phải dùng lựa chọn explicit đã persist/validate hoặc trả null. `useSettlementReport(organizationId, from, to)` đưa org vào query key `['settlement-report', organizationId, from, to]`, chỉ enable khi org hợp lệ và gọi v2. `BanGiaoReport`, `soQuy.execute` và `ChatPanel` fail closed khi org null, truyền cùng selected ID; route/capability/tool đều là `cashbooks.view`. Inventory grep phải cho direct legacy call literal `rpc('cashbook_settlement_report'` bằng 0 trước revoke v1, nhưng vẫn cho phép tên v2 và migration containment nhắc tới signature v1.

Tách ACL revoke `public.cashbook_settlement_report(date,date)` thành containment migration riêng nếu cần cutover; Task 9 chỉ coi S49 đóng sau khi cả hook lẫn Copilot đã deploy v2, source/deployed caller inventory bằng 0, rồi revoke exact legacy signature khỏi `authenticated` và readback catalog xác nhận.

- [ ] **Bước 5: Mutation exact-org và focused gates**

Đột biến bỏ `account.id = ANY(v_cashbook_ids)` hoặc đổi `p_organization_id` sang org khác có membership phải làm fixture exact-deny/cross-org đỏ. Đột biến `IF NOT COALESCE(v_allowed, false)` thành `IF false AND NOT COALESCE(v_allowed, false)` phải làm cashbook denied assertion đỏ; cả ba chạy trên role-real DB fixture và restore hash.

```powershell
npx vitest run src/contexts/__tests__/OrganizationContext.test.ts src/copilot/__tests__/nghiepVuTools.test.ts src/copilot/__tests__/copilot.test.ts src/hooks/__tests__/useSettlementReportOrganizationScope.test.ts src/lib/__tests__/analyticsPermissionMigration.test.ts src/lib/__tests__/cashbookSettlementPermissionMigration.test.ts
node --test scripts/__tests__/business-performance-authz-harness.test.mjs
node scripts/test-business-performance-authz.mjs
node scripts/test-security-remediation.mjs --local-cluster --case S49
npm run gate:route-permission-drift
npm run gate:capability-surfaces
npm run gate:permission-catalog
```

### Task 10: Tách riêng exact authorization cho Zalo reaction và recall

**Findings:** `FR009-C01`, `FR009-C02`.

**Files:**
- Create: `supabase/migrations/20260814025500_zalo_reaction_recall_exact_authz.sql`
- Create: `supabase/migrations/20260814025600_zalo_reaction_recall_legacy_revoke.sql`
- Modify: `src/integrations/supabase/types.ts`
- Modify: `src/lib/permissions.ts`
- Modify: `src/lib/permissionPages.ts`
- Modify: `src/lib/__tests__/permissionPages.test.ts`
- Modify: `src/lib/__tests__/permissionPageRoutes.test.ts`
- Modify: `src/hooks/openclaw-zalo/openClawRpc.ts`
- Modify: `src/hooks/useZaloChat.ts`
- Modify if still present at implementation time: `src/hooks/chat-zalo/useZaloConversationActions.ts`
- Modify: `worker/lib/queue.js`
- Extend from Task 4: `scripts/test-zalo-capability-security.mjs`
- Extend from Task 4: `scripts/__tests__/zalo-capability-security.test.mjs`
- Modify: `src/lib/openclaw-zalo/__tests__/actionContractsAgainstSql.test.ts`
- Modify: `.e2e-fleet/specs/openclaw-zalo.spec.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Interfaces:** sealed scan ghi ABI send cũ 6 đối số, nhưng baseline triển khai đã tiến lên sau bốn migration Zalo `ledger-applied`. Live catalog read-only, generated types và caller current source thống nhất bốn legacy signatures còn executable/có caller là `public.zalo_send_message(uuid,text,text,text,jsonb,text,jsonb,uuid)`, `public.zalo_load_history(uuid,integer)`, `public.zalo_react_message(uuid,text)` và `public.zalo_recall_message(uuid)`; `contracts/surfaces/rpc-surface.json` checkpoint chỉ stale ở send và phải regenerate trước migration. Task này tạo hai catalog key chưa tồn tại: `chat_zalo.react` (`MANAGE`, tenant dimension `ORGANIZATION`) và `chat_zalo.recall` (`MANAGE`, tenant dimension `ORGANIZATION`), cập nhật permission catalog/client maps/tests trong cùng change set.

Migration additive phải **tạo trước khi dùng** hai exact identities:

- `public.zalo_react_message_v2(p_organization_id uuid,p_conversation_id uuid,p_message_id uuid,p_reaction text,p_idempotency_key uuid) RETURNS uuid`;
- `public.zalo_recall_message_v2(p_organization_id uuid,p_conversation_id uuid,p_message_id uuid,p_idempotency_key uuid) RETURNS uuid`.

Cả hai là `VOLATILE SECURITY DEFINER`, revoke exact signature khỏi `PUBLIC, anon`, grant cho `authenticated, service_role`, và return duy nhất exact `job_id` của typed queue row đã insert hoặc job hiện hữu của cùng idempotency key/payload. Ngay sau additive apply, smoke catalog phải xanh trước client cutover:

```sql
SELECT to_regprocedure('public.zalo_react_message_v2(uuid,uuid,uuid,text,uuid)');
SELECT to_regprocedure('public.zalo_recall_message_v2(uuid,uuid,uuid,uuid)');
```

Live-definition test pin `pg_get_function_result(...)='uuid'`, `provolatile='v'`, `prosecdef=true`, `pg_proc.proargnames` đúng thứ tự, effective ACL và generated types/surface. `p_organization_id` là selected-org context, không phải authority: RPC derive organization từ account/conversation/message sau lock, so exact equality và fail `42501` nếu mismatch. `src/hooks/openclaw-zalo/openClawRpc.ts` expose typed return `Promise<string>` cho job ID; `src/hooks/useZaloChat.ts` tạo idempotency UUID, truyền selected organization cùng conversation/message, nhận job ID rồi đăng ký với shared queue-result service org-scoped của Task 4. Reaction giữ optimistic UI nhưng rollback + invalidate nếu exact job thất bại; recall chỉ chuyển UI sang trạng thái thu hồi sau RPC row update và vẫn invalidate/hiển thị lỗi nếu provider job thất bại. Không bỏ qua `data`, không tự tìm job theo message/conversation và không đọc queue row khác org. Regenerate types/surface và smoke ABI rồi mới cutover client/worker hoặc revoke. Reaction cần exact `chat_zalo.react`; recall cho sender gốc hoặc actor có `chat_zalo.recall`. Boundary queue P1 và lock order `organization -> account -> conversation -> message -> queue` vẫn giữ nguyên.

- [ ] **Bước 1: Viết action-specific tests đỏ**

Actor A có broad send nhưng không reaction trên B phải bị deny; user A không recall outbound message của user B dù cùng tenant; sender hợp lệ và moderator exact permission là positive controls.

- [ ] **Bước 2: Implement RPC và worker parity**

Pre-read chỉ tìm org/account/conversation/message keys; acquire theo đúng `organization -> account -> conversation -> message -> queue`, re-read exact tuple và fail drift. Ngay trước evaluator lặp exact org lock; reaction gọi `chat_zalo.react`, recall kiểm `message.sender_user_id=auth.uid()` hoặc gọi `chat_zalo.recall`. Enqueue RPC ghi actor/org/account/conversation/message/action/capability version vào cột typed, không chỉ payload JSON. Worker `validateZaloCommandScope(job)` trong `worker/lib/queue.js` nhận typed row, re-read cùng tuple và permission/membership ngay trước provider call; không dùng ownership từ request payload hoặc broad `chat_zalo.send` để thay reaction/recall.

Client `openClawRpc` và `useZaloChat` chỉ gọi hai V2 typed signatures, không gọi `public.zalo_react_message(uuid,text)`/`public.zalo_recall_message(uuid)` hay broad action RPC. Sau deploy/adoption + queue drain, migration `20260814025600_zalo_reaction_recall_legacy_revoke.sql` revoke exact legacy signatures khỏi `PUBLIC, anon, authenticated`; catalog readback phải chứng minh chỉ V2 còn executable cho authenticated. Migration additive không revoke sớm caller đang deploy.

- [ ] **Bước 3: Mutation và verification**

Đột biến recall predicate `message.sender_user_id IS DISTINCT FROM auth.uid()` thành `false` phải làm another-user recall assertion đỏ. Đột biến reaction exact action thành `chat_zalo.send` phải làm broad-permission fixture đỏ.

```powershell
node --test scripts/__tests__/zalo-capability-security.test.mjs
npx vitest run src/lib/openclaw-zalo/__tests__/actionContractsAgainstSql.test.ts src/lib/__tests__/permissionPages.test.ts src/lib/__tests__/permissionPageRoutes.test.ts
cd .e2e-fleet
$env:FLEET_WORKERS='2'; npx playwright test specs/openclaw-zalo.spec.ts
```

### Task 11: Buộc final object scope cho finance writers và category resolution

**Findings:** `FR016-C01`, `FR017-C01`, `FR018-C01`, `FR023-C01`.

**Files:**
- Create: `supabase/migrations/20260814026000_recurring_voucher_scope_guard.sql`
- Create: `supabase/migrations/20260814026100_recurring_voucher_legacy_revoke.sql`
- Create: `supabase/migrations/20260814027000_evidence_adoption_final_scope.sql`
- Create: `supabase/migrations/20260814028000_finance_v2_reference_org_constraints.sql`
- Create: `supabase/migrations/20260814029000_fixed_expense_category_authz.sql`
- Create: `supabase/migrations/20260814029100_fixed_expense_legacy_revoke.sql`
- Modify: `src/hooks/income-expenses/recurring.ts`
- Modify: `src/hooks/income-expenses/financeV2Mutations.ts`
- Modify: `src/hooks/income-expenses/mutations.ts`
- Modify: `src/hooks/income-expenses/batch.ts`
- Create: `src/lib/__tests__/recurringVoucherScopeMigration.test.ts`
- Create: `src/lib/__tests__/evidenceAdoptionScopeMigration.test.ts`
- Modify: `src/lib/__tests__/financeV2WriterMigration.test.ts`
- Modify: `src/lib/__tests__/financeV2AuditGates.test.ts`
- Modify: `.e2e-fleet/specs/finance-writers-scope.spec.ts`
- Modify: `.e2e-fleet/specs/finance-v2.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Interfaces:** baseline HEAD có `public.generate_recurring_vouchers_v2()` no-arg, `public.adopt_voucher_attachments_as_evidence_v2(uuid)`, `public.resolve_fixed_expense_type(uuid,text)` với đối số đầu là owner, cùng `public.create_income_expense_v2(jsonb)` hiện hữu. Các signature `public.generate_recurring_vouchers_v3(p_organization_id uuid,p_building_ids uuid[])`, `public.adopt_voucher_attachments_as_evidence_v3(p_voucher_id uuid,p_destination_kind text,p_destination_key text)` và `public.resolve_fixed_expense_type_v2(p_organization_id uuid,p_category_key text)` đều phải được migration tương ứng **tạo trước khi dùng**, regenerate types/surface và smoke ABI trước client/internal-caller cutover. Legacy signatures chỉ revoke sau client/server/internal-SQL adoption, không fallback.

- [ ] **Bước 1: Viết cross-object fixtures đỏ**

Cover one-building assignment tạo owner-wide recurring; attachment voucher ngoài scope; voucher A với room/tenant/type B; actor cung cấp identity fixed-expense của owner khác. Denial không ghi bền và không lộ URL/ID.

- [ ] **Bước 2: Implement exact resource checks và composite constraints**

`generate_recurring_vouchers_v3` reject org/building array NULL/rỗng/trùng/vượt 100; pre-read exact building→org, khóa org rồi building UUID tăng dần, re-read và authorize `income_expenses.create` cho từng building ngay trước generation. Chỉ chọn recurring parents có `parent.organization_id=p_organization_id` và `parent.building_id=ANY(p_building_ids)`; lock parent tăng dần, revalidate repeat state/date và sinh child trong cùng org/building. Hook truyền selected org/building IDs; không gọi no-arg `generate_recurring_vouchers_v2()`. Sau source/deployed caller count bằng 0, `20260814026100` revoke V2 khỏi authenticated; không owner-wide fallback.

`adopt_voucher_attachments_as_evidence_v3` khóa org/source voucher deterministic, authorize exact building/account và chỉ chấp nhận `p_destination_kind IN ('post_approved','approve_and_post')` cùng `p_destination_key` là idempotency key sẽ truyền nguyên vẹn vào posting RPC. Vì unique hiện hữu `finance_evidence_objects_org_bucket_object_key(organization_id,bucket_id,object_name)` không cho cùng object sinh nhiều evidence row, thêm binding vào bảng con private `app_private.finance_evidence_bindings(organization_id,evidence_id,source_voucher_id,destination_kind,destination_key_hash,created_at)` với FK org-qualified tới evidence/voucher và unique `(organization_id,evidence_id,source_voucher_id,destination_kind,destination_key_hash)`; không được thay unique hiện hữu bằng key rộng hơn làm object có thể tái dùng. Backfill/quarantine binding ambiguous, rồi enforce non-null. Chỉ attachment nằm trên source voucher và `storage_object_links.organization_id` khớp mới adopt. `public.post_approved_income_expense_v2(jsonb)` và `public.approve_and_post_income_expense_v2(jsonb)` tiếp tục nhận `input.evidenceIds`; migration bổ sung kiểm mỗi ID bind đúng voucher + destination kind + hash của `input.idempotencyKey` trước khi gọi internal `app_private.finance_v2_post_manual_voucher(public.income_expenses,uuid,uuid,uuid,date,uuid[],text)`. Đây là contract hardening mới, không phải hành vi baseline; idempotency retry cùng key được phép, key khác không mượn evidence.

`create_income_expense_v2(jsonb)` resolve/lock building org trước canonical-op reservation; validate đúng related ID mà live payload hiện chấp nhận: `roomId`, `tenantId`, `cashbookId` và từng `items[].typeId`. `contractId`/`invoiceId` không thuộc finding/source path này và không được tự thêm vào input contract. Tạo/reuse unique keys cần thiết và composite FKs cụ thể: `income_expenses(organization_id,building_id)` -> `buildings(organization_id,id)`, `(organization_id,room_id)` -> `rooms`, `(organization_id,tenant_id)` -> `tenants`, `(organization_id,account_id)` -> `accounts`; `income_expense_items(organization_id,income_expense_type_id)` -> `income_expense_types(organization_id,id)`. Mỗi constraint backfill/quarantine -> `NOT VALID` -> validate -> set required columns non-null khi domain cho phép; migration test pin exact names và reject cross-object payload trước write.

`resolve_fixed_expense_type_v2` lấy actor từ `auth.uid()`, reject org NULL, khóa org ngay trước `authorize_tenant_action_v3(...,'categories.edit',NULL,NULL)` khi cần create/update; lookup existing exact category trong org có thể return sau active membership check nhưng không nhận `p_owner`. `ensure_income_expense_type_v1` nhận actor/org server-derived. Cập nhật mọi SQL/client caller sang V2, gồm cả internal SQL/migration definitions đang gọi owner-based legacy chứ không chỉ `src/`; sau inventory source + deployed catalog/caller telemetry bằng 0, `20260814029100` mới revoke `public.resolve_fixed_expense_type(uuid,text)` khỏi authenticated.

- [ ] **Bước 3: Update typed wrappers, không thêm raw cast mới**

Hooks truyền explicit org/building/operation, validate unknown RPC result theo contract hiện có và gom boundary vào typed facade. Sinh lại types/surface; không thêm raw cast, không giữ nhánh gọi no-arg/owner-based legacy khi V3/V2 trả lỗi.

- [ ] **Bước 4: Focused, disposable, money, E2E**

```powershell
npx vitest run src/lib/__tests__/recurringVoucherScopeMigration.test.ts src/lib/__tests__/evidenceAdoptionScopeMigration.test.ts src/lib/__tests__/financeV2WriterMigration.test.ts src/lib/__tests__/financeV2AuditGates.test.ts
node scripts/test-security-remediation.mjs --local-cluster --case FR016-C01
node scripts/test-security-remediation.mjs --local-cluster --case FR017-C01
node scripts/test-security-remediation.mjs --local-cluster --case FR018-C01
node scripts/test-security-remediation.mjs --local-cluster --case FR023-C01
node scripts/test-security-remediation.mjs --role-real --case FR016-C01
node scripts/test-security-remediation.mjs --role-real --case FR017-C01
node scripts/test-security-remediation.mjs --role-real --case FR018-C01
node scripts/test-security-remediation.mjs --role-real --case FR023-C01
node scripts/reconcile-money.mjs 2026-08
node scripts/reconcile-money-v2.mjs 2026-08
cd .e2e-fleet
$env:FLEET_WORKERS='4'; npx playwright test specs/finance-writers-scope.spec.ts specs/finance-v2.spec.ts
```

### Task 12: Áp giới hạn request/storage trước materialization

**Findings:** `FR003-C01`, `FR024-C01`, `FR029-C01`, `PANALYTICS-C02`.

**Files:**
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `supabase/functions/network-center-worker/index.test.ts`
- Create: `infra/cloudflare-worker/src/boundedBody.ts`
- Modify: `infra/cloudflare-worker/src/index.ts`
- Create: `infra/cloudflare-worker/src/boundedBody.test.ts`
- Modify: `infra/cloudflare-worker/package.json`
- Create: `infra/cloudflare-worker/tsconfig.json`
- Create: `supabase/functions/_shared/bounded-json.ts`
- Modify: `supabase/functions/llm-proxy/index.ts`
- Create: `supabase/functions/llm-proxy/index.test.ts`
- Create: `supabase/functions/llm-proxy/deno.json`
- Create: `supabase/functions/public-room-events/index.ts`
- Create: `supabase/functions/public-room-events/index.test.ts`
- Create: `supabase/functions/public-room-events/deno.json`
- Modify after dependency resolution: `deno.lock`
- Create: `supabase/migrations/20260814030000_public_room_event_budget.sql`
- Create: `src/lib/__tests__/publicRoomEventBudgetMigration.test.ts`
- Modify: `src/pages/phong-trong/tracking.ts`
- Modify after generation: `contracts/surfaces/edge-function-surface.json`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`
- Modify: `tooling/test-matrix.json`
- Modify: `.github/workflows/ci-gates.yml`
- Modify: `.github/workflows/network-center-validation.yml`

**Interfaces:** dùng shared behavioral contract `readBoundedBody(stream,{maximumBytes,maximumConcurrent,signal})` và `readBoundedJson(request,limits)`; Edge modules dùng implementation chung, Cloudflare dùng adapter riêng nhưng cùng vectors/assertions. Kiểm declared length và stream byte trước decode/JSON/R2/provider. Giữ các cap Network Center route hiện hữu (8,192–2,200,000 bytes); R2 cap 8 MiB. LLM cap 512 KiB/request, 128 messages, 32 KiB/message content, 32 tools và 256 KiB tổng tool schema; unknown top-level/message/tool fields bị reject. Analytics cap 50 row/call, 120 request và 2,000 row mỗi token/source/10 phút, dedupe retry 24 giờ, retention 90 ngày.

- [ ] **Bước 1: Viết tests biên trước**

Absent/invalid/negative/under/exact/one-byte-over Content-Length; unknown-length chunk vượt cap; cancellation; no downstream call; retained bytes không quá cap cộng một chunk; concurrency của nhiều stream bị reject. Network Center test lặp mọi route cap trong map, Cloudflare test `maximumBytes=8*1024*1024`, LLM test exact 512 KiB + schema maxima và assert `reserve_ai_usage`/provider chưa được gọi khi reject.

- [ ] **Bước 2: Thay `arrayBuffer()` và `Request.json()` bằng bounded stream**

Helper `readJsonBody` trong `supabase/functions/network-center-worker/index.ts` gọi shared `readBoundedJson` từ `supabase/functions/_shared/bounded-json.ts`, không gọi `request.arrayBuffer()`. Shared Edge module không được import Zod/LLM schema: nó chỉ sở hữu byte/concurrency/abort primitive; `network-center-worker` giữ route schema hiện hữu, còn `llm-proxy` sở hữu LLM constants/Zod schema và đọc tối đa 512 KiB với tối đa 8 concurrent parses/isolate trước `JSON.stringify`, quota reservation hoặc provider lookup/call. `infra/cloudflare-worker/src/boundedBody.ts` là implementation riêng cho Cloudflare streams nhưng giữ cùng semantics/limit names; export `boundedBody(req.body,{maximumBytes:8*1024*1024,maximumConcurrent:16,signal:req.signal})`, stream kết quả trực tiếp vào `R2Bucket.put` khi API hỗ trợ, nếu adapter cần bytes thì reader chỉ cấp bounded buffer, không materialize trước cap.

- [ ] **Bước 3: Thêm cumulative analytics budget**

Tạo Edge Function `public-room-events` làm ingress duy nhất. Preflight phải chứng minh bằng platform contract + integration test header nào do Supabase ingress sở hữu và có strip/overwrite giá trị client; chỉ khi có bằng chứng đó mới parse IP từ header ấy. Nếu không chứng minh được hoặc header thiếu/malformed, dùng digest sentinel `unknown`, tạo budget gộp chặt hơn thay vì tin `x-forwarded-for`, `x-real-ip` hay IP trong body. HMAC bằng secret `PUBLIC_ROOM_EVENT_SOURCE_HMAC_KEY` tối thiểu 32 byte từ Edge secret thành `source_digest`; secret thiếu/yếu phải fail startup/request trước service call. Sau bounded-read, Edge gọi facade PostgREST-exposed `public.log_public_room_events_service_v2(p_token text,p_request_id uuid,p_events jsonb,p_source_digest bytea)`. Facade là `VOLATILE SECURITY DEFINER`, `SET search_path = pg_catalog, app_private, public`, chỉ grant exact signature cho `service_role`, revoke `PUBLIC, anon, authenticated`, không tin actor/browser fields và delegate ngay vào helper không-exposed `app_private.log_public_room_events_v2(...)`; integration test phải gọi qua Supabase client/service role thật, kiểm `public` facade executable còn private helper không gọi trực tiếp qua PostgREST. Migration tạo `app_private.public_room_event_budgets(token_digest,source_digest,bucket_start,request_count,row_count,updated_at)` + unique key; private logger không grant browser và trước `jsonb_array_elements` khóa budget row, fail/no-op thống nhất nếu vượt 120 request hoặc 2,000 row/10 phút. Trong P2, legacy room token chỉ cần tồn tại và `revoked=false`; nếu Task 14 managed capability đã apply thì logger ưu tiên resolver mới và kiểm expiry/revocation/audience, nhưng Task 12 không được tham chiếu cột `expires_at` chưa tồn tại. `public_room_events` thêm `request_id,event_index` với unique `(token,request_id,event_index)` để retry deterministic; retention function xóa event/budget cũ hơn 90 ngày và được scheduler/maintenance manifest gọi. Client gọi Edge slug, sinh một request UUID cho mỗi batch, cap local queue 200 và drop/coalesce presentation events khi đầy. Sau Edge adoption revoke `public.log_public_room_events(text,jsonb)` khỏi anon/authenticated; không nhận source digest/IP từ browser payload/header.

- [ ] **Bước 4: Mutation và runtime suites**

```powershell
deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
deno test --config supabase/functions/public-room-events/deno.json supabase/functions/public-room-events/index.test.ts --allow-env
deno test --config supabase/functions/llm-proxy/deno.json supabase/functions/llm-proxy/index.test.ts --allow-env
npx vitest run src/lib/__tests__/publicRoomEventBudgetMigration.test.ts
npm --prefix infra/cloudflare-worker test
node scripts/dot-bien.mjs --file supabase/functions/network-center-worker/index.ts --tim "bytes.byteLength > maximumBytes" --thay "false" --suite "deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env" --mong-doi-chua "body_too_large"
npm run surface:edge
npm run gate:edge-surface
```

Đăng ký `supabase/functions/llm-proxy/index.test.ts` và `public-room-events` vào suite Deno/CI explicit với `deno.json` import map pin exact và root `deno.lock`; không chạy Edge test bằng Vitest. Đăng ký Cloudflare bounded-body vào suite package Vitest explicit trong `tooling/test-matrix.json` + step `quality-gates`; thêm `test`, `typecheck` và devDependencies pin exact cần thiết vào `infra/cloudflare-worker/package.json`, cùng `tsconfig.json` riêng để suite không dựa vào hoisting ngầm. Giữ Network Center trong `network-center-validation.yml` (không chỉ `ci-gates.yml`). Cập nhật edge-surface/deploy manifest cho slug mới. `gate:test-matrix` phải chứng minh không orphan/cross-runner conflict; CI step gọi đúng các file mới, không dựa vào root glob đang exclude `infra/**` và không giả định mọi Edge test chạy Deno. Dependency gate là cứng: Task 8 phải tạo `lucky-proof-upload` test/config trước Task 13; Task 12 phải tạo và đăng ký `llm-proxy`, `public-room-events` test/config cùng Cloudflare `test`/`typecheck` scripts trước Task 13/18. Không chạy các lệnh Deno/package này trên baseline hoặc coi file/script vắng mặt là skip/pass.

### Task 13: Hoàn tất integrated gate P2 trước khi bắt đầu P3

- [ ] **Bước 1: Chạy focused P2**

```powershell
npx vitest run src/pages/phong-trong/__tests__/publicRoomProjection.test.ts src/lib/__tests__/luckyProofUploadSecurityMigration.test.ts src/contexts/__tests__/OrganizationContext.test.ts src/copilot/__tests__/nghiepVuTools.test.ts src/copilot/__tests__/copilot.test.ts src/lib/__tests__/analyticsPermissionMigration.test.ts src/lib/__tests__/cashbookSettlementPermissionMigration.test.ts src/lib/__tests__/recurringVoucherScopeMigration.test.ts src/lib/__tests__/evidenceAdoptionScopeMigration.test.ts src/lib/__tests__/financeV2WriterMigration.test.ts src/lib/__tests__/publicRoomEventBudgetMigration.test.ts
npm --prefix infra/cloudflare-worker test
npm --prefix infra/cloudflare-worker run typecheck
node --test scripts/__tests__/business-performance-authz-harness.test.mjs scripts/__tests__/zalo-capability-security.test.mjs
deno test --config supabase/functions/lucky-proof-upload/deno.json supabase/functions/lucky-proof-upload/index.test.ts --allow-env
deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
deno test --config supabase/functions/public-room-events/deno.json supabase/functions/public-room-events/index.test.ts --allow-env
deno test --config supabase/functions/llm-proxy/deno.json supabase/functions/llm-proxy/index.test.ts --allow-env
```

- [ ] **Bước 2: Chạy permission/surface/migration/role-real/money gates**

```powershell
npm run gate:permission-catalog
npm run gate:route-permission-drift
npm run gate:capability-surfaces
npm run gate:stable-fn-locks
npm run gate:definer-acl
npm run gate:migration-provenance
npm run gate:migration-test-liveness
npm run gate:migration-idempotent
npm run gate:rpc-surface
npm run gate:edge-surface
npm run gate:org-boundary-inventory
node scripts/test-business-performance-authz.mjs
node scripts/test-security-remediation.mjs --local-cluster --priority P2
node scripts/test-security-remediation.mjs --role-real --priority P2
node scripts/reconcile-money.mjs 2026-08
node scripts/reconcile-money-v2.mjs 2026-08
```

- [ ] **Bước 3: Chạy P2 E2E headless**

```powershell
cd .e2e-fleet
$env:FLEET_WORKERS='8'; npx playwright test specs/business-performance.spec.ts specs/capability-route-smoke.spec.ts specs/cashbook-create-org-resolution.spec.ts specs/finance-writers-scope.spec.ts specs/finance-v2.spec.ts specs/quayso-lucky-draw.spec.ts specs/phong-trong-export-image.spec.ts specs/openclaw-zalo.spec.ts
```

## P3 - Vòng đời, consent và bounded work mức Low

### Task 14: Nâng public contract/room token thành managed capability

**Findings:** `FR001-C02`, `FR001-C05`.

**Files:**
- Create: `supabase/migrations/20260814031000_public_capability_lifecycle.sql`
- Create: `supabase/migrations/20260814031100_public_capability_legacy_revoke.sql`
- Modify: `src/pages/public/PublicContractInvoicePage.tsx`
- Modify: `src/pages/phong-trong/usePhongTrong.ts`
- Modify: `src/hooks/usePublicRoomTokens.ts`
- Modify: `src/components/contracts/ContractQRDialog.tsx`
- Modify: `src/components/contracts/detail/ContractDetailView.tsx`
- Modify: `src/components/invoices/InvoiceDetailView.tsx`
- Modify: `src/lib/contractQrImage.ts`
- Modify: `src/app/routes/publicRoutes.tsx`
- Create: `src/lib/__tests__/publicCapabilityLifecycleMigration.test.ts`
- Create: `.e2e-fleet/specs/public-capability-lifecycle.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

- [ ] **Bước 1: Viết entropy/lifecycle tests đỏ**

Digest at rest, tối thiểu 128 random bits, audience non-null, expiry/revocation trong mọi resolver, response invalid thống nhất và không lộ state.

- [ ] **Bước 2: Implement issue/resolve/rotate/revoke**

Tạo private table `app_private.public_capabilities(capability_id uuid primary key,secret_digest bytea,organization_id uuid,audience text,resource_id uuid,issued_by uuid,issued_at timestamptz,expires_at timestamptz,revoked_at timestamptz,rotation_generation bigint)` và bảng binding `app_private.public_capability_buildings(capability_id uuid,organization_id uuid,building_id uuid,primary key(capability_id,building_id))` với FK/composite FK chứng minh building thuộc đúng organization. Raw token `<uuid>.<32-byte-base64url-secret>`, không lưu raw. Audience chỉ `contract_latest_invoice` hoặc `public_room_catalog`, TTL mặc định/tối đa lần lượt 90/365 ngày, bind exact final resource/org và, với room catalog, bind exact tập building đã authorize; compare digest bằng `secure_bytea_equal_v1`.

Exact management APIs: `public.issue_public_contract_invoice_capability_v1(p_contract_id uuid,p_expires_at timestamptz)`, `public.rotate_public_contract_invoice_capability_v1(p_contract_id uuid,p_expires_at timestamptz)`, `public.revoke_public_contract_invoice_capability_v1(p_contract_id uuid)`; room APIs là `issue_public_room_capability_v1(p_organization_id uuid,p_building_ids uuid[],p_expires_at timestamptz)`, `rotate_public_room_capability_v1(p_organization_id uuid,p_building_ids uuid[],p_expires_at timestamptz)` và `revoke_public_room_capability_v1(p_capability_id uuid)`. Contract issuer resolve `contract -> building -> organization`, khóa org/contract, rồi gọi `authorize_tenant_action_v3(auth.uid(),exact_org,'contracts.print',exact_building,NULL)` ngay sau org lock. Room issuer reject array NULL/rỗng/trùng/vượt budget, khóa org rồi lấy effective `sale_phong.manage_tokens` scope; `p_building_ids` phải là subset đầy đủ của exact authorized building set sau org-wide allow trừ exact deny, và mọi building phải thuộc chính org. Quyền trên building A không được mint capability chứa B; capability org-wide chỉ được tạo khi effective scope thật sự org-wide sau deny và resolver vẫn filter theo binding đã lưu. Không dùng owner heuristic hoặc tên quyền chưa tồn tại. Anonymous resolvers là `public.resolve_public_contract_invoice_capability_v1(p_capability text)` và `public.resolve_public_room_capability_v1(p_capability text)`; room resolver chỉ trả catalog rows có building trong binding. Cả hai trả cùng `NULL`/404-shaped response cho malformed, unknown, expired, revoked, rotated hoặc wrong audience và chỉ response allowlist. Rate-limit tối thiểu theo capability digest; chỉ thêm source digest khi request metadata đã được chứng minh là ingress-owned, nếu không dùng bucket `unknown` chặt hơn thay vì tin header caller. E2E/role-real bắt buộc có staff chỉ quản lý building A: issue `[A]` thành công, issue `[A,B]` và resolve B đều fail/không lộ row.

Additive migration chỉ tạo registry/lifecycle và đánh dấu tài nguyên legacy cần rotate; không sinh secret rồi bỏ mất, không lưu raw token để "backfill". Management UI phải issue/rotate, nhận raw token đúng một lần và phân phối URL mới trong transition trong khi link cũ vẫn hoạt động. Clients đổi route param thành capability và gọi resolver V1. Sau phát/rotate link mới, adoption telemetry bằng 0 mới apply `20260814031100`: revoke `public.get_public_latest_invoice_by_code(text)`, `public.get_public_available_rooms(text)`, `public.create_public_room_token(text)` khỏi `PUBLIC/anon/authenticated` phù hợp, khóa direct token-table DML và vô hiệu `contracts.public_code`/raw `public_room_share_tokens.token` làm authority. Catalog tests pin exact ACL/cutover; không silently fall back mã 6 ký tự.

- [ ] **Bước 3: Update clients và E2E**

Raw token chỉ ở URL path/request của page hiện tại, không query/log/referrer/localStorage/sessionStorage/React Query persisted cache; page đặt `Referrer-Policy: no-referrer`. E2E valid/expired/revoked/rotated/wrong-audience/legacy-disabled, response invalid đồng nhất và không lộ internal fields.

### Task 15: Bound success/error response của Network Center worker khi stream

**Findings:** `FR003-C02`, `FR003-C03`.

**Files:**
- Modify: `infra/network-center-worker/src/apiClient.ts`
- Modify: `infra/network-center-worker/test/apiClient.test.ts`

- [ ] **Bước 1: Viết chunked boundary tests**

Missing/invalid length, exact/one-byte-over, split UTF-8 multibyte, slow timeout, cancellation và không giữ raw body sau reject cho cap success 4 MiB và error 4 KiB.

- [ ] **Bước 2: Implement một shared bounded UTF-8 reader**

Export một shared `readBoundedUtf8Response(response,maximumBytes,signal)` và dùng cho cả success/error. Missing/empty `Content-Length` phải stream-count, invalid/negative/multiple length fail closed trước `response.text()`; exact length được phép, one-byte-over cancel reader/abort upstream. Chỉ decode bounded bytes rồi parse; giữ error-code extraction allowlist hiện có và xóa mọi nhánh `response.text()`/`arrayBuffer()` trực tiếp ở success lẫn error.

- [ ] **Bước 3: Verify package**

```powershell
npm --prefix infra/network-center-worker test
npm --prefix infra/network-center-worker run typecheck
npm --prefix infra/network-center-worker run build
```

### Task 16: Tôn trọng Remember Me và yêu cầu Copilot confirmation gắn server

**Findings:** `FR005-C01`, `FR006-C01`.

**Files:**
- Create: `supabase/migrations/20260814031500_copilot_confirmation_nonce.sql`
- Modify: `src/pages/auth/Login.tsx`
- Modify: `src/hooks/useAuth.ts`
- Modify: `src/integrations/supabase/client.ts`
- Create: `src/integrations/supabase/authStorage.ts`
- Create: `src/pages/auth/__tests__/LoginSessionPersistence.test.tsx`
- Modify: `src/hooks/__tests__/useAuthMutationKeys.test.ts`
- Modify: `src/copilot/chatEngine.ts`
- Modify: `src/copilot/tools/writeTools.ts`
- Create: `src/copilot/confirmationStore.ts`
- Modify: `src/copilot/__tests__/chatTurn.test.ts`
- Modify: `src/copilot/__tests__/copilot.test.ts`
- Create: `src/lib/__tests__/copilotConfirmationNonceMigration.test.ts`
- Create: `.e2e-fleet/specs/login-session-persistence.spec.ts`
- Create: `.e2e-fleet/specs/copilot-confirmation.spec.ts`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Interfaces:** auth singleton dùng một switchable storage adapter được chọn trước `signInWithPassword`, không tạo nhiều GoTrue client/listener. Copilot server APIs là `public.copilot_preview_income_expense_v1(p_organization_id uuid,p_payload jsonb) RETURNS jsonb` và `public.copilot_execute_income_expense_v1(p_confirmation_nonce text,p_payload jsonb) RETURNS jsonb`; browser không INSERT/UPDATE trực tiếp `ai_write_audit` và không gọi `ie_compat_insert_v2` từ write tool.

- [ ] **Bước 1: Viết tests đỏ**

Remember unchecked chỉ sống current tab/session và không để `sb-*-auth-token` trong localStorage; checked persist đúng contract. Copilot first-turn `confirmed=true`, payload đổi, wrong org/user, expired/replayed nonce hoặc permission bị gỡ sau preview đều fail trước RPC write.

- [ ] **Bước 2: Chọn storage trước auth client và giữ listener an toàn**

`authStorage.ts` export `setAuthPersistence('local'|'session')` và một `SupportedStorage` adapter mà singleton Supabase client nhận lúc module init. Trước login, adapter chọn `localStorage` khi checked, `sessionStorage` khi unchecked, chuyển/xóa đúng auth key `sb-*-auth-token` ở storage kia rồi mới gọi sign-in; không đổi client instance nên `AuthCacheSync` vẫn có đúng một sync callback/listener. Boot đọc location hiện có của auth key để chọn adapter trước `getSession`; logout xóa cả storage qua adapter, không gọi storage I/O trong auth callback. Tests cover reload/new-tab semantics, cross-tab refresh, StrictMode cleanup và switch checked↔unchecked.

- [ ] **Bước 3: Triển khai xác nhận hai bước gắn với server**

Migration tạo private `app_private.copilot_write_confirmations(id uuid,nonce_digest bytea,user_id uuid,organization_id uuid,tool text,payload_hash bytea,permission_key text,expires_at timestamptz,consumed_at timestamptz,created_at timestamptz)` với raw nonce 32 byte chỉ trả một lần, TTL 5 phút và unique digest. Preview canonicalize server-side payload, resolve exact building/type/org, gọi `lock_org_for_decision_v1(exact_org)` ngay trước `authorize_tenant_action_v3(...,'income_expenses.create',exact_building,NULL)`, ghi confirmation + preview; không ghi voucher/audit. Execute hash nonce, pre-read lock key, khóa `organization -> confirmation -> building/type`, re-read unconsumed/unexpired row, constant-work compare, so actor/org/tool/payload hash, lặp lại org-lock statement ngay trước evaluator rồi CAS `consumed_at IS NULL`; trong cùng transaction gọi guarded server writer và insert/update `ai_write_audit` với organization/entity. Replay/wrong payload/user/org/expired/revoked permission fail trước side effect. `confirmationStore.ts` chỉ giữ nonce trong memory theo tool-call/conversation turn; model boolean/text không thể tự tạo nonce.

- [ ] **Bước 4: Focused và E2E**

```powershell
npx vitest run src/pages/auth/__tests__/LoginSessionPersistence.test.tsx src/hooks/__tests__/useAuthMutationKeys.test.ts src/app/providers/__tests__/authCacheSyncStrictMode.test.ts src/copilot/__tests__/chatTurn.test.ts src/copilot/__tests__/copilot.test.ts src/lib/__tests__/copilotConfirmationNonceMigration.test.ts
cd .e2e-fleet
$env:FLEET_WORKERS='2'; npx playwright test specs/login-session-persistence.spec.ts specs/copilot-confirmation.spec.ts
```

### Task 17: Giới hạn finance tender/item trước JSON expansion hoặc lock

**Findings:** `FR014-C01`, `FR015-C01`, `FR018-C02`.

**Files:**
- Create: `supabase/migrations/20260814032000_finance_input_cardinality_limits.sql`
- Modify: `src/lib/paymentRecordRpc.ts`
- Modify: `src/components/invoices/RecordPaymentDialog.tsx`
- Modify: `src/hooks/income-expenses/financeV2Mutations.ts`
- Modify: `src/hooks/income-expenses/mutations.ts`
- Modify: `src/hooks/income-expenses/batch.ts`
- Create: `src/lib/financeInputLimits.ts`
- Modify: `src/lib/__tests__/invoiceCollectionV5Hardening.test.ts`
- Modify: `src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts`
- Modify: `src/lib/__tests__/financeV2WriterMigration.test.ts`
- Modify: `.e2e-fleet/specs/invoice-collection-v5.spec.ts`
- Modify: `.e2e-fleet/specs/finance-writers-scope.spec.ts`
- Create: `scripts/test-finance-input-limits.mjs`
- Create: `scripts/__tests__/finance-input-limits.test.mjs`
- Modify after apply: `src/integrations/supabase/types.ts`
- Modify after apply: `contracts/surfaces/rpc-surface.json`

**Interfaces:** shared constants là `MAX_INVOICE_TENDERS=16`, `MAX_FINANCE_ITEMS=200`, `MAX_FINANCE_ARRAY_BYTES=262144`; DB vẫn là authority và trả SQLSTATE `22023` + stable reason `finance_input_limit_exceeded`. Exact writers trong scope: `public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text)` (`p_tenders`), `public.ie_compat_insert_v2(jsonb,jsonb)` (`p_items`) và `public.create_income_expense_v2(jsonb)` (`payload->'items'`). `ie_compat_update_pending_v2(uuid,jsonb,jsonb)` dùng cùng item limit vì nhận cùng array và được test như đường phụ bắt buộc.

- [ ] **Bước 1: Đo budget và viết fail-fast tests**

Ghi provenance: UI hiện không có maxima, DB chỉ check nonempty; chọn 16 tender (cao hơn luồng thanh toán thực tế) và 200 item/256 KiB (cao hơn batch nghiệp vụ nhưng bounded), rồi xác nhận bằng read-only distribution query trước implementation. Nếu số đo legitimate vượt constants, dừng và cập nhật plan/constants trước code thay vì nới ngầm. Test 0, normal, exact max, max+1, duplicate/NULL và serialized payload 262144/262145 bytes. Max+1 phải fail trước idempotency hash/reservation, advisory/row lock, `jsonb_array_elements`, WAL/write.

- [ ] **Bước 2: Thêm server-first cardinality/byte checks**

```sql
IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_items) > 200
   OR pg_column_size(p_items) > 262144 THEN
  RAISE EXCEPTION 'finance_input_limit_exceeded' USING ERRCODE='22023';
END IF;
```

Đặt block đầu thân hàm, trước mọi `md5/jsonb_array_elements/finance_v2_begin_canonical_op/lock`; `record_invoice_collection_v5` dùng max 16/262144 cho `p_tenders`, hai compat/V2 writers dùng max 200/262144. Reject non-array, NULL item, duplicate logical key khi contract cấm và payload oversized. `financeInputLimits.ts` mirror constants vào Zod/form/add button và typed wrappers nhưng không thay server enforcement.

- [ ] **Bước 3: Verify no partial write, concurrency, idempotency, money và E2E**

`scripts/test-finance-input-limits.mjs --local-cluster` bootstrap qua Task 6, chạy normal/exact/max+1 trên cả bốn signatures, hai concurrent oversized requests, replay và assert `pg_locks`/row count/audit/canonical operation không đổi khi reject. Mutation đổi `> 16`/`> 200` thành `> 1000000` phải làm named max+1 suite đỏ và restore hash; sau đó chạy hai reconciliation và focused E2E.

### Task 18: Hoàn tất P3 và verification toàn repo

- [ ] **Bước 1: Chạy focused P3**

```powershell
npx vitest run src/lib/__tests__/publicCapabilityLifecycleMigration.test.ts src/pages/auth/__tests__/LoginSessionPersistence.test.tsx src/copilot/__tests__/chatTurn.test.ts src/copilot/__tests__/copilot.test.ts src/lib/__tests__/copilotConfirmationNonceMigration.test.ts src/lib/__tests__/invoiceCollectionV5Hardening.test.ts src/lib/__tests__/accountingCompatibilityGuardsMigration.test.ts src/lib/__tests__/financeV2WriterMigration.test.ts
node --test scripts/__tests__/finance-input-limits.test.mjs
node scripts/test-finance-input-limits.mjs --local-cluster
npm --prefix infra/network-center-worker test
```

- [ ] **Bước 2: Chạy quality gates đúng baseline của repo**

`node scripts/check-eslint-baseline.mjs` là lint gate toàn repo có ratchet nợ hiện trạng. Không dùng raw full lint làm điều kiện độc lập vì `npm run lint` hiện chạy `eslint .` và có nợ đã khai; sau baseline gate, chạy ESLint trực tiếp chỉ trên danh sách file JS/TS/TSX đã thay đổi.

```powershell
npm run gate:runtime-matrix
npm run gate:test-matrix
npm run gate:workflow-paths
npm run gate:security-remediation-manifest
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
node scripts/check-eslint-baseline.mjs
$changedLintFiles = git diff --name-only --diff-filter=ACMR -- '*.js' '*.mjs' '*.ts' '*.tsx'
if ($changedLintFiles.Count -gt 0) { npx eslint -- $changedLintFiles }
npm --prefix infra/cloudflare-worker run typecheck
npm --prefix infra/cloudflare-worker test
npm --prefix infra/network-center-worker run typecheck
npm --prefix infra/network-center-worker test
npm run build
npm run gate:bundle
npm run gate:timezone
npm run gate:route-guards
npm run gate:permission-catalog
npm run gate:route-permission-drift
npm run gate:capability-surfaces
npm run gate:stable-fn-locks
npm run gate:view-invoker
npm run gate:definer-acl
npm run gate:migration-provenance
npm run gate:migration-test-liveness
npm run gate:migration-idempotent
npm run gate:rpc-surface
npm run gate:edge-surface
npm run gate:realtime-surface
npm run gate:rpc-arg-names
npm run gate:rpc-layer
npm run gate:rpc-name-literal
npm run gate:org-boundary-inventory
npm run gate:dependency-audit
npm run gate:no-auto-apply
npm run gate:management-api-writes
git diff --check
```

- [ ] **Bước 3: Chạy disposable và role-real verification cuối**

```powershell
npm run gate:baseline-doc
node scripts/test-security-remediation.mjs --local-cluster
node scripts/test-security-remediation.mjs --role-real
node scripts/test-business-performance-authz.mjs
deno test --config supabase/functions/lucky-proof-upload/deno.json supabase/functions/lucky-proof-upload/index.test.ts --allow-env
deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
deno test --config supabase/functions/public-room-events/deno.json supabase/functions/public-room-events/index.test.ts --allow-env
deno test --config supabase/functions/llm-proxy/deno.json supabase/functions/llm-proxy/index.test.ts --allow-env
npm --prefix infra/cloudflare-worker test
node scripts/measure-org-leak.mjs
node scripts/reconcile-money.mjs 2026-08
node scripts/reconcile-money-v2.mjs 2026-08
node scripts/clone-org/snapshot.mjs after
```

Lane dựa trên baseline luôn gọi `node scripts/dien-tap-khoi-phuc-baseline.mjs --dich $disposableConnection`, qua thứ tự platform shim, roles, schema hai lượt, kiểm required-object inventory rồi chỉ apply forward migrations mới hơn cutoff. Không replay migration history trong bất kỳ trường hợp nào.

- [ ] **Bước 4: Chạy final headless E2E**

```powershell
cd .e2e-fleet
$env:FLEET_WORKERS='8'; npx playwright test specs/quayso-lucky-draw.spec.ts specs/phong-trong-export-image.spec.ts specs/termination-refund.spec.ts specs/finance-writers-scope.spec.ts specs/openclaw-zalo.spec.ts specs/salary-mobile-period.spec.ts specs/business-performance.spec.ts specs/capability-route-smoke.spec.ts specs/cashbook-create-org-resolution.spec.ts specs/finance-v2.spec.ts specs/invoice-collection-v5.spec.ts specs/public-capability-lifecycle.spec.ts specs/login-session-persistence.spec.ts specs/copilot-confirmation.spec.ts
```

Kỳ vọng: headless; console error tracker sạch; không ghi THẬT; fixture DEMO tự dọn.

## Rollout, backup và rollback

### Pre-apply checkpoint

- [ ] Working tree chỉ chứa remediation files đã review; `git diff --check` và local gates xanh.
- [ ] `npm run gate:local-credentials` không báo thiếu capability cần cho lane hiện tại.
- [ ] Mọi migration mới có entry đúng SHA-256 trong `supabase/migration-provenance.json`.
- [ ] Dry-run từng migration cụ thể qua `npm run migrate:forward -- supabase/migrations/20260814010000_lucky_payout_capability_additive.sql`; migration revoke `20260814010500_lucky_payout_legacy_revoke.sql` được dry-run trước nhưng chỉ apply ở checkpoint containment sau adoption. Lặp với từng file đúng thứ tự và không dùng wildcard hay quét thư mục.
- [ ] Chụp catalog/types/surfaces và production web SHA, Edge versions, worker/container digest, Cloudflare Worker version, Zalo worker revision.

### Cutover bắt buộc theo từng priority batch

Không apply toàn bộ migration rồi mới deploy runtime. Lặp đúng sáu checkpoint dưới đây cho P1, sau đó P2, rồi P3; không sang batch tiếp theo nếu checkpoint hiện tại chưa có receipt xanh:

1. **Additive database:** tạo backup/provenance/dry-run receipt, apply riêng các migration schema/RPC v2/constraints tương thích ngược của batch. Với Lucky P1, apply `20260814010000_lucky_payout_capability_additive.sql` nhưng chưa apply `20260814010500_lucky_payout_legacy_revoke.sql`.
2. **Server/runtime:** deploy RPC/Edge/worker/provider revalidation tương thích cả client cũ và mới; chụp SHA/image/bundle digest, exact target preflight, catalog/readback và smoke receipt. Containment có thể fail closed ngay cho direct DML/forged queue nếu không làm vỡ caller hợp lệ; revoke signature đang được client gọi phải chờ checkpoint 5.
3. **Client v2:** deploy typed wrapper/hook/UI gọi signature mới, truyền selected org/capability/revision/idempotency đúng contract và không có silent fallback v1. Regenerate/check types/surfaces sau database additive.
4. **Adoption evidence:** inventory source và deployed telemetry/readback phải chứng minh caller v1 count bằng 0 cho entrypoint sắp revoke, client/server version tương thích và mọi occurrence của batch có receipt. Lucky phải chứng minh check-in không mint capability, payout v2 đã được dùng; S49 phải chứng minh cả `useSettlementReport` và Copilot gọi v2.
5. **Containment/revoke:** mới apply migration revoke legacy grants/signatures/direct DML, rotate/revoke bearer hoặc drain/quarantine queue cũ. Mỗi migration revoke có backup-bound apply receipt và catalog ACL readback; không gộp vào additive migration chỉ để giảm số file.
6. **Role-real negative fixture:** chạy `node scripts/test-security-remediation.mjs --role-real --priority <P1|P2|P3>` bằng JWT/role thật trên DEMO/TEST. Positive A phải thành công; wrong-org B, NULL/ambiguous org, suspended member, legacy writer, wrong/expired capability và wrong final resource phải fail không side effect. Chỉ sau receipt này mới chuyển batch.

Danh sách migration cụ thể vẫn nằm trong từng Task và manifest; runner rollout đọc ordered allowlist + digest/provenance, không glob toàn thư mục. Public capability phát token mới trước revoke link cũ; Zalo deploy worker revalidation và enqueue RPC mới, đo drain/quarantine, rồi mới revoke legacy command/DML.

### Rollback

- Web/runtime regression: promote SHA/image/worker version trước theo digest đã ghi.
- Database regression: không sửa/down-migrate migration đã apply; disable client/runtime path, revoke entrypoint mới nếu cần fail closed, rồi ship migration forward-fix mới.
- Nếu data corruption: dừng write, giữ evidence, restore vào target Supabase-compatible từ backup receipt của migration; PostgreSQL trần không đủ chứng minh RLS restore.
- Không re-grant anonymous/legacy writer để phục hồi compatibility.

## Hardening cấu trúc deferred

Các mục sau không phải acceptance criteria của remediation chiến thuật. Chỉ mở phase riêng sau khi 49 finding đã xác minh đóng và user phê duyệt; nguồn là `hardening/hardening.md` trong scan artifact.

1. Boundary authorize theo organization và final resource dùng chung phía server.
2. Typed Zalo command capability có expiry/version/evidence và worker revalidation bắt buộc.
3. Shared pre-materialization byte/item/concurrency/storage budgets cho Edge, Node, Cloudflare và SQL.
4. Một issuer/resolver/revoker cho public bearer capability entropy cao, scoped và expiring.
5. Một canonical deny-wins evaluator dùng chung cho route, Copilot, RPC, worker và consent.

## Mapping đầy đủ finding sang work package

| # | Ưu tiên | Finding | Mô tả ngắn | Work package |
| ---: | --- | --- | --- | --- |
| 1 | P2 | `FR001-C01` | Public room RPC lộ sale bonus note nội bộ | Task 8 |
| 2 | P3 | `FR001-C02` | Contract code ngắn, không expiry, lộ invoice | Task 14 |
| 3 | P1 | `FR001-C03` | Mã Lucky sáu chữ số cho phép sửa payout | Task 1 |
| 4 | P2 | `FR001-C04` | Lucky proof upload thiếu participant capability | Task 8 |
| 5 | P3 | `FR001-C05` | Public room token sáu ký tự không expiry | Task 14 |
| 6 | P1 | `FR002-C01` | Contract transfer gắn customer khác tổ chức | Task 2 |
| 7 | P1 | `FR002-C02` | Move-out tin số settlement từ caller | Task 2 |
| 8 | P2 | `FR003-C01` | Edge buffer body trước byte cap | Task 12 |
| 9 | P3 | `FR003-C02` | Worker buffer success body trước cap 4 MiB | Task 15 |
| 10 | P3 | `FR003-C03` | Worker buffer error body trước cap 4 KiB | Task 15 |
| 11 | P3 | `FR005-C01` | Remember Me bị bỏ qua, session luôn localStorage | Task 16 |
| 12 | P3 | `FR006-C01` | Confirmation do model điều khiển tạo finance voucher | Task 16 |
| 13 | P2 | `FR009-C01` | Zalo reaction permission rộng vượt tenant | Task 10 |
| 14 | P2 | `FR009-C02` | Zalo recall message outbound của user khác | Task 10 |
| 15 | P1 | `FR009-C03` | Zalo group history đọc conversation tùy ý | Task 4 |
| 16 | P1 | `FR009-C04` | Salary CASH branch thiếu tenant scope | Task 5 |
| 17 | P1 | `FR009-C05` | Salary ledger dùng first-super-admin global | Task 5 |
| 18 | P2 | `FR011-C01` | Monthly profit fallback first super-admin tenant | Task 9 |
| 19 | P2 | `FR011-C02` | Monthly profit gồm restricted-category amounts | Task 9 |
| 20 | P2 | `FR011-C03` | Change breakdown lộ restricted vouchers | Task 9 |
| 21 | P2 | `FR011-C04` | Deposit breakdown lộ restricted data | Task 9 |
| 22 | P3 | `FR014-C01` | Invoice collection nhận tender array không giới hạn | Task 17 |
| 23 | P3 | `FR015-C01` | Compat insert nhận item array không giới hạn | Task 17 |
| 24 | P2 | `FR016-C01` | Recurring voucher mở one-building thành owner-wide | Task 11 |
| 25 | P2 | `FR017-C01` | Evidence adoption dùng attachment ngoài scope | Task 11 |
| 26 | P2 | `FR018-C01` | Finance V2 nhận related UUID khác org | Task 11 |
| 27 | P3 | `FR018-C02` | Finance V2 nhận item array không giới hạn | Task 17 |
| 28 | P2 | `FR020-C01` | Copilot evaluator bỏ canonical deny/override | Task 9 |
| 29 | P2 | `FR020-C02` | Authorization explanation thiếu target-org binding | Task 9 |
| 30 | P2 | `FR020-C03` | Admin read chọn first org sau global permission | Task 9 |
| 31 | P2 | `FR023-C01` | Fixed-expense resolver ghi category vào org khác | Task 11 |
| 32 | P2 | `FR024-C01` | R2 upload buffer body trước cap 8 MiB | Task 12 |
| 33 | P2 | `FR029-C01` | LLM proxy parse oversized JSON trước quota | Task 12 |
| 34 | P2 | `PANALYTICS-C01` (summary) | Summary RPC bỏ `view_analytics` | Task 9 |
| 35 | P2 | `PANALYTICS-C01` (time-series) | Time-series RPC bỏ `view_analytics` | Task 9 |
| 36 | P2 | `PANALYTICS-C01` (top rooms) | Top-rooms RPC bỏ `view_analytics` | Task 9 |
| 37 | P2 | `PANALYTICS-C01` (funnel) | Funnel RPC bỏ `view_analytics` | Task 9 |
| 38 | P2 | `PANALYTICS-C01` (token) | Token analytics RPC bỏ `view_analytics` | Task 9 |
| 39 | P2 | `PANALYTICS-C01` (errors) | Error analytics RPC bỏ `view_analytics` | Task 9 |
| 40 | P2 | `PANALYTICS-C02` | Anonymous analytics logger tăng trưởng không giới hạn | Task 12 |
| 41 | P1 | `PCOMPAT-C01` | Pending voucher authorize building cũ, ghi scope mới | Task 2 |
| 42 | P1 | `PMETER-C01` (single) | Anonymous single meter approval | Task 3 |
| 43 | P1 | `PMETER-C01` (bulk) | Anonymous bulk meter approval | Task 3 |
| 44 | P1 | `PZALO-C01` (send) | Forged queue gửi qua account khác | Task 4 |
| 45 | P1 | `PZALO-C01` (react) | Forged queue reaction qua account khác | Task 4 |
| 46 | P1 | `PZALO-C01` (recall) | Forged queue recall qua account khác | Task 4 |
| 47 | P1 | `PZALO-C01` (history) | Forged queue lấy history khác scope | Task 4 |
| 48 | P1 | `PZALO-C02` | Zalo send RPC target conversation tenant khác | Task 4 |
| 49 | P2 | `S49` | Cashbook report/Copilot bỏ `cashbooks.view` | Task 9 |

Tổng mapping: `P1 = 14`, `P2 = 26`, `P3 = 9`, tổng `49`. Không gộp occurrence trùng candidate; mỗi dòng phải có regression riêng theo action.

## Bàn giao thực thi

Thực hiện theo batch ưu tiên bằng `superpowers:subagent-driven-development`. Trong một batch chỉ song song hóa work package có ownership file/database không chồng lấn; agent chính giữ allocation timestamp migration, integration, role-real verification, generated artifacts, rollout và kết luận cuối.
