# Implementation Plan: Quản lý Công việc (Task Management)

## Overview

Triển khai trang Công việc tại menu chính, cho phép tạo, theo dõi, và xử lý công việc vận hành với quy trình: Tạo mới → Nhận xử lý → Hoàn thành → Nghiệm thu. Cần tạo bảng `jobs` mới (SQL migration), TypeScript types, pure helper functions (Zod + status logic), useJobs hook, 8 React components, và tích hợp routing/navigation. Tái sử dụng hooks hiện có (useBuildings, useRooms, useBeds, useJobGroups, useJobTypes) và AttachmentUpload component. UI tuân thủ 100% ảnh tham chiếu.

## Tasks

- [x] 1. Database migration và TypeScript types
  - [x] 1.1 Tạo SQL migration cho bảng `jobs`
    - Tạo file migration trong `supabase/migrations/` với CREATE TABLE `jobs` đầy đủ cột theo design
    - CHECK constraints cho `priority` (NORMAL, LOW, URGENT) và `status` (NOT_STARTED, IN_PROGRESS, PENDING_ACCEPTANCE, ACCEPTED, FAILED, OVERDUE)
    - RLS policies: SELECT, INSERT, UPDATE, DELETE với `auth.uid() = user_id`
    - Trigger `generate_job_code` auto-generate mã công việc format `JOB-YYYYMMDD-NNNN`
    - Trigger `trigger_jobs_updated_at` auto-update `updated_at`
    - Indexes: user_id, status, building_id, assignee_id, created_at DESC
    - Tạo Supabase Storage bucket `job-attachments`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 4.2_

  - [x] 1.2 Tạo `src/types/jobs.ts` với TypeScript types
    - Export `JOB_STATUSES`, `JOB_PRIORITIES` const arrays
    - Export types: `JobStatus`, `JobPriority`
    - Export `STATUS_LABELS`, `PRIORITY_LABELS` (Vietnamese labels)
    - Export `VALID_TRANSITIONS` map
    - Export interfaces: `Job`, `JobWithRelations`, `TaskFilters`, `defaultTaskFilters`
    - _Requirements: 8.4, 11.2, 11.4_

  - [x] 1.3 Cập nhật `src/integrations/supabase/types.ts` — thêm Database type entries cho bảng `jobs` (Row, Insert, Update)
    - _Requirements: 12.1_

- [x] 2. Pure helper functions và validation
  - [x] 2.1 Tạo `src/lib/jobValidation.ts` với Zod schemas và pure helper functions
    - Implement `jobCreateSchema` — Zod schema validate form tạo mới (title required, priority enum, optional UUIDs, optional datetime deadline)
    - Implement `jobCompleteSchema` — Zod schema validate form hoàn thành (completion_time required)
    - Implement `jobAcceptanceSchema` — Zod schema validate form nghiệm thu
    - Implement `isValidTransition(from, to)` — kiểm tra chuyển trạng thái hợp lệ theo VALID_TRANSITIONS
    - Implement `getAvailableActions(status)` — trả về actions khả dụng: NOT_STARTED→["accept"], IN_PROGRESS→["complete"], PENDING_ACCEPTANCE→["review"], others→[]
    - Implement `computeTaskStats(jobs)` — đếm số lượng theo từng trạng thái, trả về Record<JobStatus, number>
    - Implement `filterJobs(jobs, filters)` — lọc danh sách theo tất cả filter criteria
    - Implement `paginateJobs(jobs, page, pageSize)` — phân trang client-side
    - Implement `isOverdue(job)` — kiểm tra quá hạn: deadline past + status not ACCEPTED → true
    - Implement `getStatusLabel(status)`, `getStatusColor(status)`, `getPriorityLabel(priority)`, `getPriorityColor(priority)`
    - Export types: `JobCreateFormValues`, `JobCompleteFormValues`, `JobAcceptanceFormValues`
    - _Requirements: 8.1, 8.2, 8.3, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 2.1, 2.3, 3.2, 5.1, 6.1, 7.1_

  - [ ]* 2.2 Property test: Status transition validity — `src/lib/__tests__/jobValidation.property.test.ts`
    - **Property 1: Status transition validity**
    - **Validates: Requirements 5.3, 6.3, 7.3, 7.4, 8.1, 8.3**

  - [ ]* 2.3 Property test: Available actions per status
    - **Property 2: Available actions per status**
    - **Validates: Requirements 5.1, 5.4, 6.1, 7.1**

  - [ ]* 2.4 Property test: Task statistics correctness — `src/lib/__tests__/jobStats.property.test.ts`
    - **Property 3: Task statistics correctness**
    - **Validates: Requirements 2.1**

  - [ ]* 2.5 Property test: Status color mapping distinctness
    - **Property 4: Status color mapping distinctness**
    - **Validates: Requirements 2.3**

  - [ ]* 2.6 Property test: Filter correctness — `src/lib/__tests__/jobFilter.property.test.ts`
    - **Property 5: Filter correctness**
    - **Validates: Requirements 3.2**

  - [ ]* 2.7 Property test: Pagination bounds
    - **Property 9: Pagination bounds**
    - **Validates: Requirements 1.2**

  - [ ]* 2.8 Property test: Overdue detection — `src/lib/__tests__/jobOverdue.property.test.ts`
    - **Property 6: Overdue detection**
    - **Validates: Requirements 8.2**

  - [ ]* 2.9 Property test: Zod schema round-trip — `src/lib/__tests__/jobSchema.property.test.ts`
    - **Property 7: Zod schema round-trip for valid job creation input**
    - **Validates: Requirements 11.5**

  - [ ]* 2.10 Property test: Zod schema rejects invalid input
    - **Property 8: Zod schema rejects invalid job creation input**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.6, 8.4**

  - [ ]* 2.11 Unit tests — `src/lib/__tests__/jobValidation.test.ts`
    - Test isValidTransition: specific valid/invalid pairs
    - Test getAvailableActions: each status returns correct actions
    - Test computeTaskStats: empty list, single job, mixed statuses
    - Test filterJobs: default filters return all, specific filters narrow results
    - Test isOverdue: no deadline, future deadline, past deadline + ACCEPTED
    - Test getStatusLabel, getPriorityLabel: all values
    - Test jobCreateSchema: empty title rejected, valid input accepted
    - Test jobCompleteSchema: empty completion_time rejected
    - _Requirements: 8.1, 8.2, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

- [x] 3. Checkpoint - Đảm bảo types, validation logic và tests hoạt động
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Tạo useJobs hook
  - [x] 4.1 Tạo `src/hooks/useJobs.ts`
    - Implement `useJobs(filters?)` — fetch jobs với join relations (buildings, rooms, beds, job_groups, job_types, profiles), sắp xếp created_at desc, áp dụng filters qua Supabase query chaining (.eq, .gte, .lte)
    - Implement `useCreateJob()` — mutation INSERT vào bảng jobs với user_id = auth.uid(), toast "Dữ liệu đã được TẠO thành công", invalidate query key ["jobs"]
    - Implement `useUpdateJobStatus()` — mutation UPDATE status + extra data (completion fields, acceptance fields, started_at), toast "Trạng thái đã được cập nhật thành công", invalidate ["jobs"]
    - Implement `useDeleteJob()` — mutation DELETE, toast "Dữ liệu đã được XOÁ thành công", invalidate ["jobs"]
    - _Requirements: 1.1, 1.2, 1.3, 4.4, 4.6, 5.3, 6.3, 7.3, 7.4_

- [x] 5. Tạo UI components — Stats, Filters, Table
  - [x] 5.1 Tạo `src/components/tasks/TaskStatusStats.tsx`
    - 6 cards ngang hàng hiển thị số lượng theo trạng thái
    - Mỗi card: Icon + Label + Count (font lớn bold)
    - Màu sắc: NOT_STARTED=gray, IN_PROGRESS=blue, PENDING_ACCEPTANCE=yellow, ACCEPTED=green, FAILED=red, OVERDUE=orange
    - Sử dụng `computeTaskStats()` từ jobValidation.ts
    - Props: `jobs: JobWithRelations[]`
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 5.2 Tạo `src/components/tasks/TaskFiltersPanel.tsx`
    - Panel collapsible với các filter dropdowns: Căn hộ (useBuildings), Phòng (useRooms filtered by building), Nhóm công việc (useJobGroups), Loại công việc (useJobTypes), Mức độ ưu tiên, Người thực hiện, Trạng thái, Khoảng thời gian (2 date inputs)
    - Cascading: chọn Căn hộ → filter Phòng
    - Buttons: "Áp dụng" (green) + "Xoá bộ lọc" (outline)
    - Props: `filters`, `onChange`, `onApply`, `onClear`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 5.3 Tạo `src/components/tasks/TaskTable.tsx`
    - Bảng 11 cột: Mã công việc (link clickable), Tiêu đề, Căn hộ, Phòng, Nhóm công việc, Loại công việc, Mức độ ưu tiên (badge), Người thực hiện, Hạn hoàn thành (dd/MM/yyyy HH:mm), Trạng thái (badge màu), Thao tác (View + Delete icons)
    - Click Mã công việc → mở detail dialog
    - Empty state: icon ClipboardList + "Chưa có công việc nào. Hãy thêm công việc đầu tiên."
    - DataTablePagination component
    - Sắp xếp created_at giảm dần
    - Props: `data`, `isLoading`, `onViewDetail`, `onDelete`, `pagination`, `totalCount`
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 6. Tạo UI components — Dialogs
  - [x] 6.1 Tạo `src/components/tasks/TaskCreateDialog.tsx`
    - Dialog form React Hook Form + Zod resolver (jobCreateSchema)
    - 12 trường: Căn hộ, Phòng (cascading), Giường (cascading), Tiêu đề (*), Mô tả, Nhóm công việc (+ inline create), Loại công việc (+ inline create), Mức độ ưu tiên (default NORMAL), Người thực hiện, Hạn hoàn thành, Hiển thị với khách hàng (toggle), Đính kèm (AttachmentUpload, bucket: job-attachments)
    - Cascading logic: Chọn Căn hộ → reset+load Phòng → Chọn Phòng → reset+load Giường
    - Inline creation: Nhóm công việc nút (+) → input tạo mới → useCreateJobGroup; Loại công việc nút (+) → input tạo mới
    - Title: "THÊM CÔNG VIỆC" (uppercase, text xanh)
    - Buttons: "Huỷ" (outline) | "Lưu" (green)
    - Validation error: "Tiêu đề không được để trống"
    - On success: đóng dialog, toast "Dữ liệu đã được TẠO thành công"
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 9.1, 9.2, 9.3, 9.4, 10.1, 10.3, 11.1_

  - [x] 6.2 Tạo `src/components/tasks/TaskDetailDialog.tsx`
    - Dialog hiển thị tất cả thông tin công việc + attachments
    - Action buttons theo trạng thái (sử dụng getAvailableActions):
      - NOT_STARTED: "Nhận xử lý" → confirm dialog "Bạn có chắc chắn muốn nhận việc?" → update IN_PROGRESS
      - IN_PROGRESS: "Hoàn thành" → mở TaskCompleteDialog
      - PENDING_ACCEPTANCE: "Nghiệm thu công việc" → mở TaskAcceptanceDialog
      - ACCEPTED/FAILED/OVERDUE: không có action
    - Hiển thị attachments, completion info, acceptance info nếu có
    - Props: `open`, `onOpenChange`, `job`, `onAcceptTask`, `onCompleteTask`, `onReviewTask`
    - _Requirements: 1.5, 5.1, 5.2, 5.3, 5.4, 6.1, 7.1, 10.4_

  - [x] 6.3 Tạo `src/components/tasks/TaskCompleteDialog.tsx`
    - Dialog form React Hook Form + Zod resolver (jobCompleteSchema)
    - 3 trường: Thời gian hoàn thành (*) (date/time picker), Mô tả kết quả (textarea), Đính kèm (AttachmentUpload)
    - Validation: "Thời gian hoàn thành không được để trống"
    - On success: update status → PENDING_ACCEPTANCE + lưu completion fields
    - Props: `open`, `onOpenChange`, `jobId`, `onSuccess`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 10.2_

  - [x] 6.4 Tạo `src/components/tasks/TaskAcceptanceDialog.tsx`
    - Dialog form React Hook Form + Zod resolver (jobAcceptanceSchema)
    - 3 trường: Đánh giá kết quả (textarea), Đánh giá khách hàng (textarea), Ý kiến khách hàng (textarea)
    - 2 buttons: "Không đạt" (red → FAILED) | "Đạt" (green → ACCEPTED)
    - On success: update status + lưu acceptance fields + accepted_at
    - Props: `open`, `onOpenChange`, `jobId`, `onSuccess`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 7. Checkpoint - Đảm bảo tất cả components render đúng
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Tạo trang chính và tích hợp routing
  - [x] 8.1 Tạo `src/pages/TaskManagementPage.tsx`
    - Container page kết nối tất cả hooks và components
    - State: searchQuery, showFilters, filters, isCreateOpen, selectedJob, isDetailOpen, isCompleteOpen, isAcceptanceOpen, deleteTarget, pagination
    - MainLayout wrapper: title="Công việc", subtitle="Quản lý công việc vận hành", icon=ClipboardList
    - Layout: TaskStatusStats → Toolbar (Search + Filter icon + Add button) → TaskFiltersPanel (collapsible) → TaskTable
    - Sử dụng useJobs(filters), filterJobs cho client-side search, paginateJobs cho pagination
    - AlertDialog xác nhận xoá: "Bạn có chắc chắn muốn xoá công việc này không?"
    - Wire tất cả dialog open/close states
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.2, 3.1, 3.3, 3.4, 4.1, 4.6, 13.4_

  - [x] 8.2 Cập nhật `src/App.tsx` — thêm route `/tasks` trỏ đến TaskManagementPage
    - _Requirements: 13.1_

  - [x] 8.3 Cập nhật `src/components/layout/Breadcrumbs.tsx` — thêm label "Công việc" cho route `/tasks`
    - _Requirements: 13.4_

  - [x] 8.4 Cập nhật sidebar navigation — thêm mục "Công việc" với icon ClipboardList, link đến `/tasks`
    - _Requirements: 13.2, 13.3_

- [x] 9. Final checkpoint - Đảm bảo tất cả hoạt động end-to-end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Sử dụng TypeScript cho tất cả implementation
- Property tests sử dụng `fast-check` với tối thiểu 100 iterations mỗi test
- Tái sử dụng hooks hiện có: useBuildings, useRooms, useBeds, useJobGroups, useJobTypes, useCreateJobGroup
- Tái sử dụng components: AttachmentUpload, DataTablePagination, MainLayout, usePagination
- Pattern theo TaskTypesPage và IncomeExpenseList hiện có trong codebase
- UI phải tuân thủ 100% ảnh tham chiếu
- Toast messages chuẩn: "Dữ liệu đã được TẠO/XOÁ thành công", "Trạng thái đã được cập nhật thành công"
