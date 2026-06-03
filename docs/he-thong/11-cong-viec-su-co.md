# Công việc · Sự cố · Quy trình (Jobs, Issues, Workflows)

## 1. Tổng quan & vai trò nghiệp vụ

Domain này quản lý **việc vận hành toà nhà** — từ một yêu cầu nhỏ ("phòng 201 sửa vòi nước") tới một sự cố lớn cần đi qua nhiều giai đoạn (tiếp nhận → xử lý → đánh giá → hoàn thành). Trong vòng đời tổng của CRM (lead → cọc → HĐ → chỉ số → hoá đơn → thu chi → báo cáo → lợi nhuận), domain này nằm ở khâu **vận hành sau khi khách đã thuê**: khách/nhân viên báo việc cần làm, hệ thống giao việc, theo dõi tiến độ, và khi làm xong có thể **trừ vật tư từ kho** (material_usages) — chi phí đó về sau chảy vào thu chi / báo cáo lợi nhuận.

Điểm cốt lõi: tồn tại **hai hệ song song, độc lập** trong cùng domain:

| | **jobs** (Công việc) | **issues** (Sự cố) |
|---|---|---|
| Bản chất | Phiếu việc vận hành đơn giản, vòng đời 2 trạng thái | Sự cố/ticket có workflow nhiều giai đoạn + SLA |
| Trạng thái | `IN_PROGRESS` / `COMPLETED` (text, CHECK) | enum `issue_status` (6 giá trị) + phase trong flow |
| UI hiện có | **Có** — `/tasks` (TaskManagementPage) | **Chưa có trang** quản lý; chỉ Dashboard đọc thống kê |
| Mã phiếu | `JOB-YYYYMMDD-NNNN` (trigger `generate_job_code`) | `code_sequences` object_type `ISSUE` (prefix `IS`) |
| Workflow | Không (đã đơn giản hoá, bỏ nghiệm thu) | `task_flows → task_phases → phase_transitions` |
| SLA | Không | `sla_configs` + `set_issue_sla` / `check_sla_breach` |
| Lịch sử | `started_at`, `completion_time` trên chính phiếu | `issue_status_history`, `issue_phase_history`, `issue_comments` |

> **Trạng thái thực tế của codebase:** Hệ **jobs** đang chạy đầy đủ trên UI (`/tasks`). Hệ **issues** và toàn bộ máy workflow (`task_flows`, `task_phases`, `phase_transitions`, `sla_configs`, `scheduled_jobs`, `task_types`) đã có **schema + trigger + RLS** ở DB nhưng **chưa có trang quản trị** trong `src/`. Frontend chỉ chạm tới `issues` qua [useDashboard.ts](src/hooks/useDashboard.ts) (đếm sự cố chưa xử lý) và chạm `departments` qua [useJobTypes.ts](src/hooks/useJobTypes.ts). Tài liệu này mô tả cả hai để phản ánh đúng dữ liệu thật.

Các bảng danh mục đi kèm: `job_types` (loại công việc — có default priority/deadline/department/auto-assign), `job_groups` (nhóm loại), `departments` (bộ phận), `issue_categories` (danh mục sự cố), `task_types` (danh mục loại đơn giản, tách riêng).

---

## 2. Cấu trúc dữ liệu

### 2.1. Hệ JOBS (công việc vận hành)

#### `jobs` — phiếu công việc
Mục đích: một việc vận hành cụ thể gắn với toà/phòng, giao cho người thực hiện, có hạn hoàn thành.

Cột chủ chốt:
- `code` (UNIQUE, NOT NULL) — mã `JOB-YYYYMMDD-NNNN`, **tự sinh** bởi trigger khi để trống.
- `title`, `description` — tiêu đề ghép `(loại) (mô tả)`; description lưu nguyên chuỗi quick-input.
- `building_id`, `room_id` — vị trí; `room_id` có thể NULL nếu là việc **toàn toà** (nhập `tn` ở ô phòng).
- `job_type_id` — loại công việc (FK `job_types`).
- `priority` (text, DEFAULT `NORMAL`, CHECK ∈ {`NORMAL`,`LOW`,`URGENT`}) — **lưu ý**: tập giá trị này KHÁC enum `issue_priority`. UI luôn gửi `NORMAL`.
- `assignee_id` (FK `profiles`) **hoặc** `assignee_name` (text tự do) — giao cho user có hồ sơ, hoặc gõ tên tự do khi người đó chưa có account.
- `deadline` — hạn hoàn thành (mặc định: cuối ngày mai nếu không nhập).
- `status` (text, DEFAULT `IN_PROGRESS`, CHECK ∈ {`IN_PROGRESS`,`COMPLETED`}) — chỉ 2 trạng thái sau khi [đơn giản hoá vòng đời](supabase/migrations/20260516000053_jobs_simplify_status.sql).
- `started_at` — set = now() lúc tạo; `completion_time` — set khi bấm Hoàn thành.
- `visible_to_customer` (bool) — có cho khách thấy không.
- `attachments` (jsonb) — ảnh đính kèm; khi tạo lưu ảnh ban đầu, khi Hoàn thành ảnh "đã làm" được GỘP vào chính cột này (`useCompleteJob` ghi merged vào `attachments`). `completion_attachments`/`completion_description` là cột **di sản** của flow nghiệm thu cũ, hiện KHÔNG được create/complete flow ghi.
- Các cột `acceptance_result`, `customer_evaluation`, `customer_comments`, `accepted_at` — **di sản** của flow nghiệm thu cũ, hiện không còn dùng trên UI.
- id/user_id/created_at/updated_at: chuẩn (user_id = owner tenant).

FK đi ra: `assignee_id→profiles`, `building_id→buildings`, `room_id→rooms`, `job_type_id→job_types`.
Được tham chiếu: `material_usages.job_id` — phiếu xuất vật tư gắn vào job (domain Vật tư/Kho).

#### `job_types` — loại công việc (danh mục có cấu hình)
Mục đích: định nghĩa sẵn priority mặc định, các deadline (tính bằng **phút**), bộ phận xử lý, và cờ auto-assign.

Cột chủ chốt:
- `name`, `job_group_id` (FK `job_groups`), `description`.
- `default_priority` (enum **`issue_priority`**, DEFAULT `MEDIUM`) — chú ý dùng enum issue_priority, không phải tập của jobs.
- `customer_contact_deadline`, `acceptance_deadline`, `completion_deadline` (int phút, ≥0; 0 = không áp dụng) — khung thời gian liên hệ khách / bộ phận nhận việc / hoàn thành.
- `business_hours_only` (bool) — tính deadline theo giờ hành chính (9–18h) hay 24/7.
- `default_department_id` (FK `departments`) — bộ phận mặc định.
- `auto_assign` (bool) — cờ tự động giao việc (logic auto-assign chưa hiện diện trong code FE/trigger; là cấu hình dự phòng).
- `is_active`.

FK đi ra: `job_group_id→job_groups`, `default_department_id→departments`.
Được tham chiếu: `issues.job_type_id`, `jobs.job_type_id`, `task_flows.job_type_id`.

#### `job_groups` — nhóm loại công việc
`name`, `description`, `color`, `icon` (hiển thị UI). Được tham chiếu bởi `job_types.job_group_id`.

#### `task_types` — danh mục loại (đơn giản, độc lập)
Bảng danh mục riêng (`name`, `description`, `color`), **không có FK** tới jobs/issues. Là danh mục "Loại công việc" tách rời, tạo ở migration khác ([20250101000010](supabase/migrations/20250101000010_create_task_types_and_asset_warehouses.sql)). Lưu ý: trang `TaskTypesPage.tsx` (route `/settings/categories/task-types`) **không** quản lý bảng `task_types` này — nó quản lý `job_types` (xem mục 5.2). `task_types` là bảng danh mục cũ/song song.

### 2.2. Hệ ISSUES (sự cố + workflow + SLA)

#### `issues` — sự cố / ticket
Mục đích: theo dõi sự cố do khách thuê hoặc nhân viên báo, có phân loại, ưu tiên, SLA, và (tuỳ chọn) chạy theo workflow phase.

Cột chủ chốt:
- `title`, `description` (NOT NULL), `category_id` (FK `issue_categories`).
- `priority` (enum `issue_priority`, DEFAULT `MEDIUM`), `status` (enum `issue_status`, DEFAULT `NEW`).
- Vị trí: `building_id`, `room_id`, `contract_id`.
- Người báo: `reported_by_tenant_id` (FK `tenants`), `reported_by_staff_id` (FK `profiles`).
- Giao việc: `assigned_to` (FK `profiles`), `assigned_at`.
- Mốc thời gian: `due_date`, `resolved_at`, `closed_at`.
- Chi phí: `estimated_cost`, `actual_cost` (≥0).
- Đánh giá khách: `rating` (1–5), `feedback`.
- **Workflow** (thêm ở migration 016): `job_type_id`, `flow_id` (FK `task_flows`), `current_phase_id` (FK `task_phases`), `department_id` (FK `departments`).
- **SLA** (thêm ở migration 029): `sla_due_date`, `sla_response_time_minutes`, `sla_resolution_time_minutes`, `first_response_at`, `sla_breached`, `sla_response_breached`.
- `images`, `attachments` (jsonb).

FK được tham chiếu: `issue_comments.issue_id`, `issue_phase_history.issue_id`, `issue_status_history.issue_id`, `notifications.issue_id`.

#### `issue_categories` — danh mục sự cố
`name`, `description`, `color`, `icon`, `is_active`. Được tham chiếu bởi `issues.category_id`.

#### `issue_comments` — bình luận / cập nhật trên sự cố
`issue_id`, `user_id`, `comment` (NOT NULL), `images` (jsonb). RLS: chỉ thấy/ghi comment trên issue thuộc về mình.

#### `issue_status_history` — nhật ký đổi trạng thái sự cố
`issue_id`, `old_status`/`new_status` (varchar), `changed_by`, `notes`. **Tự động ghi** bởi trigger `log_issue_status_change` mỗi khi `status` đổi.

#### `issue_phase_history` — nhật ký đi qua các giai đoạn (phase)
`issue_id`, `from_phase_id`/`to_phase_id` (FK `task_phases`), `transition_id` (FK `phase_transitions`), `user_id`, `entered_at`/`exited_at`/`duration_minutes`, `comment`, `attachments`. Là dấu vết kiểm toán cho máy workflow.

### 2.3. Máy WORKFLOW (định nghĩa quy trình)

#### `task_flows` — định nghĩa quy trình
`name`, `description`, `job_type_id` (gắn loại việc, optional), `is_active`, `is_default` (flow mặc định cho issue không chỉ định flow). Được tham chiếu: `issues.flow_id`, `task_phases.flow_id`.

#### `task_phases` — giai đoạn trong quy trình
Mục đích: từng bước của flow, có ràng buộc hành động và quyền.
- `flow_id` (FK `task_flows`, ON DELETE CASCADE), `name`, `sequence_order` (>0, UNIQUE theo flow).
- `phase_type` (text, CHECK ∈ {`START`,`PROCESS`,`REVIEW`,`COMPLETE`,`CANCEL`}).
- `auto_transition` + `transition_conditions` (jsonb) — tự chuyển khi đủ điều kiện.
- `time_limit` (phút) — thời hạn ở giai đoạn này.
- `require_comment` / `require_attachment` / `require_rating` — bắt buộc khi rời giai đoạn.
- `allowed_departments` (uuid[]) — bộ phận được xử lý phase.
- `notify_on_enter` + `notify_template_id` — gửi thông báo khi vào phase.
- `color`, `icon`.
Được tham chiếu: `issue_phase_history.from/to_phase_id`, `issues.current_phase_id`, `phase_transitions.from/to_phase_id`.

#### `phase_transitions` — chuyển dịch hợp lệ giữa hai phase
`from_phase_id` → `to_phase_id` (khác nhau, CHECK), `name` (vd "Approve"/"Reject"/"Forward"), `require_approval` + `approval_roles` (text[]), `actions` (jsonb hành động khi chuyển), `button_label`/`button_color`. Được tham chiếu bởi `issue_phase_history.transition_id`.

#### `sla_configs` — cấu hình SLA theo độ ưu tiên
`priority` (varchar: URGENT/HIGH/MEDIUM/LOW, UNIQUE theo user), `response_time_minutes` (thời gian phản hồi đầu), `resolution_time_minutes` (thời gian giải quyết), `is_active`. Seed mặc định: URGENT 30/240, HIGH 60/480, MEDIUM 240/1440, LOW 480/2880 (phút).

### 2.4. Danh mục & lập lịch dùng chung

#### `departments` — bộ phận
`code` (UNIQUE theo user), `name`, `description`, `manager_id` (FK `profiles`), `phone`, `email`, `is_active`. Được tham chiếu: `issues.department_id`, `job_types.default_department_id`.

#### `scheduled_jobs` — tác vụ lập lịch (cron-like)
`job_type` (varchar: `AUTO_INVOICE`/`OVERDUE_CHECK`/`SLA_CHECK`…), `schedule` (cron hoặc `DAILY`/`MONTHLY`), `last_run_at`/`next_run_at`, `is_active`, `config` (jsonb). Bảng cấu hình lịch dùng chung toàn hệ — **không chỉ riêng** domain công việc (vd dùng cho sinh hoá đơn tự động). Lưu ý phân biệt với tên hàm `run_recurring_vouchers_job()` thuộc domain Thu chi.

---

## 3. Sơ đồ quan hệ dữ liệu

```mermaid
erDiagram
    job_groups ||--o{ job_types : "phân nhóm"
    departments ||--o{ job_types : "bộ phận mặc định"
    job_types ||--o{ jobs : "loại việc"
    job_types ||--o{ issues : "loại việc"
    job_types ||--o{ task_flows : "gắn flow"

    jobs }o--|| buildings : "toà"
    jobs }o--o| rooms : "phòng (NULL=toàn toà)"
    jobs }o--o| profiles : "assignee_id"
    jobs ||--o{ material_usages : "trừ vật tư"

    issue_categories ||--o{ issues : "phân loại"
    departments ||--o{ issues : "bộ phận"
    issues ||--o{ issue_comments : "bình luận"
    issues ||--o{ issue_status_history : "log trạng thái"
    issues ||--o{ issue_phase_history : "log phase"

    task_flows ||--o{ task_phases : "các giai đoạn"
    task_flows ||--o{ issues : "flow áp dụng"
    task_phases ||--o{ phase_transitions : "from_phase"
    task_phases ||--o{ phase_transitions : "to_phase"
    task_phases ||--o{ issues : "current_phase"
    phase_transitions ||--o{ issue_phase_history : "transition"

    task_types {
        uuid id
        text name
        text color
    }
    sla_configs {
        varchar priority
        int response_time_minutes
        int resolution_time_minutes
    }
    scheduled_jobs {
        varchar job_type
        varchar schedule
    }
```

Hai cụm node `task_types`, `sla_configs`, `scheduled_jobs` đứng tách (không FK trực tiếp tới jobs/issues) — `sla_configs` được match theo `priority`+`user_id` trong trigger, `task_types`/`scheduled_jobs` là danh mục/cấu hình độc lập.

---

## 4. Quy tắc nghiệp vụ & tự động hoá

### 4.1. `generate_job_code()` — trigger BEFORE INSERT trên `jobs`
Điều kiện kích hoạt: `WHEN (NEW.code IS NULL OR NEW.code = '')`. Sinh mã `JOB-YYYYMMDD-NNNN`, NNNN = (MAX số trong ngày) + 1, pad 4 chữ số.

Bản vá quan trọng ([20260527000001](supabase/migrations/20260527000001_fix_generate_job_code_rls.sql)):
- Chuyển sang **SECURITY DEFINER** + `SET search_path = public, pg_temp` để khi SELECT MAX(code) **không bị RLS lọc theo user_id của caller** — nếu không, staff tạo job đầu tiên sẽ tính ra `-0001` đã tồn tại của owner → lỗi UNIQUE (23505).
- Thêm `pg_advisory_xact_lock(hashtext('jobs_code:' || ngày))` để **serialize** việc cấp số trong cùng ngày, tránh race khi 2 INSERT đồng thời.

**Invariant:** mã job là duy nhất toàn bảng, đánh số liên tục trong ngày, không phụ thuộc tenant.

### 4.2. Vòng đời `jobs` đã đơn giản hoá
[Migration 20260516000053](supabase/migrations/20260516000053_jobs_simplify_status.sql) bỏ flow nghiệm thu:
- Default mới `IN_PROGRESS` (tạo phiếu vào thẳng "đang làm").
- CHECK chỉ cho 2 giá trị `IN_PROGRESS` / `COMPLETED`.
- Dữ liệu cũ migrate: `NOT_STARTED → IN_PROGRESS`; `PENDING_ACCEPTANCE/ACCEPTED/FAILED/OVERDUE → COMPLETED`.

```mermaid
stateDiagram-v2
    [*] --> IN_PROGRESS: tạo phiếu (started_at=now)
    IN_PROGRESS --> COMPLETED: bấm "Hoàn thành" (completion_time=now)
    COMPLETED --> [*]
```

"Trễ hẹn" (overdue) **không phải trạng thái DB** — tính ở client bởi `isOverdue()` trong [jobValidation.ts](src/lib/jobValidation.ts): phiếu chưa COMPLETED và `deadline < now`.

### 4.3. `set_issue_sla()` — trigger BEFORE INSERT trên `issues`
Khi tạo sự cố: tra `sla_configs` theo `user_id` + `priority::text` (active), rồi gán `sla_response_time_minutes`, `sla_resolution_time_minutes`, và `sla_due_date = created_at + resolution_time phút`. Nếu không có config khớp → để NULL.

### 4.4. `check_sla_breach()` — trigger BEFORE UPDATE trên `issues`
- Khi `first_response_at` lần đầu được set (OLD NULL → NEW có): nếu trễ hơn `created_at + response_time` → `sla_response_breached = TRUE`.
- Khi `resolved_at` lần đầu được set: nếu vượt `sla_due_date` → `sla_breached = TRUE`.

### 4.5. `log_issue_status_change()` — trigger BEFORE UPDATE trên `issues`
Chỉ chạy khi `status` thực sự đổi (`IS DISTINCT FROM`). Tác động:
1. Ghi 1 dòng `issue_status_history` (old/new status, `changed_by = auth.uid()`).
2. Nếu chuyển sang `RESOLVED`/`CLOSED` (mà trước đó chưa) → set `resolved_at = now()`.
3. Nếu chuyển từ `NEW` sang `IN_PROGRESS`/`ASSIGNED` lần đầu → set `first_response_at = now()` (mốc này kết hợp với `check_sla_breach`).

**Invariant SLA:** `first_response_at` và `resolved_at` được trigger đặt tự động theo luồng trạng thái; cờ breach được tính ngay tại thời điểm UPDATE.

```mermaid
sequenceDiagram
    participant U as User
    participant ISS as issues (row)
    participant T1 as log_issue_status_change
    participant T2 as check_sla_breach
    participant H as issue_status_history
    U->>ISS: UPDATE status NEW→IN_PROGRESS
    ISS->>T1: BEFORE UPDATE
    T1->>H: INSERT (old=NEW, new=IN_PROGRESS)
    T1->>ISS: set first_response_at=now()
    ISS->>T2: BEFORE UPDATE (cùng câu)
    T2->>ISS: nếu trễ → sla_response_breached=TRUE
```

### 4.6. RLS & phân quyền
- **jobs/issues**: bản gốc dùng `auth.uid() = user_id` (owner-only). Hệ RBAC sau này ([staff_write_rls](supabase/migrations/20260510000056_staff_write_rls.sql)) ánh xạ bảng → module quyền: `jobs`/`issues`/`issue_comments`/`task_flows` → module **`tasks`**; `job_groups` → `tasks`; `job_types` → **`task_types`**. Nhờ đó staff được phân quyền theo toà có thể đọc/ghi qua các hàm `staff_can`/`can_do_on_building`.
- **task_phases / phase_transitions / issue_phase_history / issue_comments**: RLS gián tiếp qua EXISTS join về `task_flows.user_id` hoặc `issues.user_id` của owner.
- **scheduled_jobs / sla_configs**: có policy RBAC riêng (batch A config tables) + admin/super-admin bypass.

### 4.7. Liên kết vật tư (side-effect khi tạo job)
Khi tạo job kèm vật tư, FE gọi `useUpsertJobMaterialUsage` → tạo `material_usages` (gắn `job_id`) + items, **tự trừ kho**. Đây là cầu nối tới domain Vật tư/Kho và sau đó là chi phí.

---

## 5. Quy trình theo từng trang (page)

### 5.1. `/tasks` — Quản lý công việc ([TaskManagementPage.tsx](src/pages/TaskManagementPage.tsx))

**Mục đích:** danh sách + tạo/sửa/hoàn thành/xoá công việc vận hành. Có layout riêng cho desktop (bảng) và mobile (card + FAB).

**Dữ liệu hiển thị:**
- `useJobs(appliedFilters)` ([useJobs.ts](src/hooks/useJobs.ts)) — SELECT `jobs` + join `buildings`, `rooms`, `job_types`, `profiles` (assignee). Filter server-side theo building/room/job_type/priority/assignee/status/khoảng ngày.
- Sau đó lọc **client-side** nhiều tầng: tab (ALL/MINE/WATCHING) → status (IN_PROGRESS/COMPLETED) → search (title/code/assignee) → phân trang (`paginateJobs`).
- `TaskStatusStats` đếm theo trạng thái; bấm card lọc nhanh.

**Tab logic:** `MINE` = `assignee_id === me` (hoặc profile join); `WATCHING` = không giao cho mình (super admin thấy hết qua RLS bypass nên gồm cả phiếu người khác).

**Mặc định:** `statusFilter = "IN_PROGRESS"` — vào trang chỉ thấy việc đang làm.

**Thao tác — Tạo công việc** ([TaskCreateDialog.tsx](src/components/tasks/TaskCreateDialog.tsx)):
1. User gõ **quick-input** 1 dòng: `(phòng) (tòa) (loại) (mô tả) [ngày]`. Ví dụ `201 1392qt sửa vòi nước 2`.
2. `parseJobQuickInput` ([jobQuickInput.ts](src/lib/jobQuickInput.ts)) phân tích realtime: match phòng/toà/loại theo tên (token `tn` ở ô phòng = việc toàn toà), tách mô tả, tính `deadline` (số = offset ngày; `17/5` = ngày cụ thể; bỏ trống = cuối ngày mai). Hiển thị preview xanh/đỏ từng phần.
3. Nếu loại công việc chưa tồn tại → nút "Tạo '<token>'" gọi `useCreateJobType` tạo nhanh `job_types`.
4. Ô "Người thực hiện": mặc định = chính mình; `resolveAssignee` khớp tên với `profiles` → set `assignee_id`, không khớp → `assignee_name` (text tự do).
5. (Tuỳ chọn) thêm vật tư qua `MaterialUsageItemsEditor`; thêm ảnh đính kèm (bucket `job-attachments`).
6. `canSubmit` yêu cầu: có toà, có phòng **hoặc** toàn-toà, có loại, có mô tả, không lỗi cấu trúc.
7. Submit → `useCreateJob` INSERT `jobs` với `status=IN_PROGRESS`, `started_at=now`, `priority=NORMAL`, `user_id=auth user`. Trigger `generate_job_code` cấp mã. Nếu có vật tư → `upsertJobMaterials` tạo `material_usages` (không rollback job nếu vật tư lỗi).

```mermaid
flowchart TD
    A["Gõ quick-input"] --> B["parseJobQuickInput<br/>(toà/phòng/loại/mô tả/deadline)"]
    B -->|loại chưa có| C["Tạo job_type nhanh"]
    B --> D{canSubmit?}
    D -->|đủ| E["useCreateJob → INSERT jobs<br/>status=IN_PROGRESS"]
    E --> F["trigger generate_job_code → JOB-YYYYMMDD-NNNN"]
    E -->|có vật tư| G["material_usages + trừ kho"]
```

**Thao tác — Hoàn thành** ([TaskCompleteDialog.tsx](src/components/tasks/TaskCompleteDialog.tsx)): chọn `completion_time` (mặc định now), thêm ảnh "đã làm" (gộp với ảnh cũ) → `useCompleteJob` UPDATE `status=COMPLETED`, `completion_time`, `attachments=merged`.

**Thao tác khác:** Xem chi tiet (`TaskDetailDialog`), Sửa (`TaskEditDialog` → `useUpdateJob` patch), Ghi chú (`TaskNotesDialog`), Xoá (`useDeleteJob` + AlertDialog xác nhận).

**Validate (zod, [jobValidation.ts](src/lib/jobValidation.ts)):** `jobCreateSchema` — title bắt buộc; uuid hợp lệ cho building/room/job_type/assignee; priority ∈ {NORMAL,LOW,URGENT}; attachments là mảng URL. Helpers thuần: `isOverdue`, `computeTaskStats`, `getStatusLabel/Color`, `getPriorityLabel/Color`.

**Edge case:**
- Phòng để `tn` → `room_id = null`, hợp lệ (việc toàn toà).
- Assignee gõ tên không có account → lưu vào `assignee_name`, vẫn tạo được.
- Lọc/tìm/phân trang đều client-side nên search hoạt động cả trên `assignee_name` text.
- "Trễ hẹn" chỉ là nhãn tính ở client, không lưu DB.

### 5.2. `/settings/categories/task-types` — Loại công việc ([TaskTypesPage.tsx](src/pages/settings/categories/TaskTypesPage.tsx))

**Mục đích:** CRUD danh mục **`job_types`** (dù tên trang/route là "task-types"). Quản lý loại việc + cấu hình priority/deadline/bộ phận.

**Dữ liệu:**
- `useJobTypes` — SELECT `job_types` + join `job_groups`, `departments` (default_department).
- `useJobGroups` — danh sách nhóm; `useDepartments` — bộ phận active.

**Thao tác:**
1. "Thêm loại công việc" → `TaskTypeFormDialog` (form react-hook-form + zod `jobTypeFormSchema`).
2. Trường: `name`, `job_group_id` (bắt buộc, có thể **tạo nhóm mới** ngay qua `onCreateJobGroup → useCreateJobGroup`), `default_priority` (LOW/MEDIUM/HIGH/URGENT — enum issue_priority), 3 deadline (phút, ≥0), `business_hours_only`, `default_department_id` (bắt buộc).
3. Submit → `useCreateJobType`/`useUpdateJobType` (gắn `user_id`). Xoá → `useDeleteJobType` + xác nhận.

**Validate ([jobTypeValidation.ts](src/lib/jobTypeValidation.ts)):** name không rỗng; bắt buộc chọn nhóm và bộ phận; deadline số nguyên ≥0; priority enum 4 mức. `PRIORITY_LABELS` map sang nhãn tiếng Việt (Khẩn cấp/Cao/Bình thường/Thấp).

**Edge case:** nhóm bắt buộc nhưng cho phép tạo on-the-fly; tìm kiếm theo `name` client-side; phân trang 20/trang.

> **Các trang chưa tồn tại trong codebase:** quản lý `issues`, `task_flows`/`task_phases`/`phase_transitions` (thiết kế workflow), `sla_configs`, `scheduled_jobs`, `issue_categories`, `departments`. Schema + trigger đã sẵn sàng để xây UI sau. Dashboard ([useDashboard.ts](src/hooks/useDashboard.ts)) đã tham chiếu route `/issues/:id` cho sự cố khẩn quá hạn — route này **chưa được khai báo** nên là điểm cần bổ sung.

---

## 6. Liên kết sang domain khác (vào / ra)

**Đi RA (domain này phụ thuộc / tác động domain khác):**
- → **Vật tư / Kho:** `material_usages.job_id → jobs.id`. Tạo job kèm vật tư sẽ tạo phiếu xuất + trừ kho; chi phí vật tư về sau vào báo cáo.
- → **Bất động sản (Buildings/Rooms):** `jobs.building_id/room_id`, `issues.building_id/room_id` — việc/sự cố luôn gắn vị trí; cũng là cơ sở phân quyền staff theo toà.
- → **Người dùng/Nhân sự (profiles):** `jobs.assignee_id`, `issues.assigned_to`/`reported_by_staff_id`, `departments.manager_id` — giao việc, người báo, trưởng bộ phận.
- → **Khách thuê / HĐ:** `issues.reported_by_tenant_id → tenants`, `issues.contract_id → contracts` — sự cố do khách báo, gắn hợp đồng đang thuê.
- → **Thông báo:** `notifications.issue_id → issues`; `task_phases.notify_template_id` — gửi thông báo khi vào phase / sự cố mới.

**Đi VÀO (domain khác đọc/dùng domain này):**
- ← **Dashboard / Báo cáo:** [useDashboard.ts](src/hooks/useDashboard.ts) đọc `issues` để đếm "sự cố chưa xử lý" và cảnh báo "sự cố khẩn > 24h".
- ← **RBAC / Phân quyền:** bảng `jobs`/`issues`/`task_flows`/`job_groups` ánh xạ module `tasks`, `job_types` → module `task_types` ([staff_write_rls](supabase/migrations/20260510000056_staff_write_rls.sql)); admin/super-admin bypass.
- ← **Thu chi (gián tiếp):** chi phí vật tư phát sinh từ job và `issues.actual_cost` là đầu vào tiềm năng cho chi phí vận hành → ảnh hưởng lợi nhuận.

**Lưu ý ranh giới:** hàm `run_recurring_vouchers_job()` và phần lớn `scheduled_jobs` thực chất phục vụ domain **Thu chi** (sinh phiếu định kỳ) / hoá đơn tự động, không phải logic của hệ jobs/issues — chỉ trùng chữ "job" trong tên.
