# Implementation Plan: Quản lý Loại công việc (Task Type Management)

## Overview

Triển khai trang quản lý Loại công việc (Task Types) trong Cài đặt hệ thống > Danh mục khác. Sử dụng custom page với bảng danh sách, form dialog thêm/sửa, inline job group creation, và property-based tests cho validation logic. Database schema đã tồn tại — chỉ cần thêm TypeScript types và xây dựng UI layer.

## Tasks

- [x] 1. Thêm Supabase types và tạo pure helper functions
  - [x] 1.1 Thêm manual TypeScript types cho `job_types`, `job_groups`, `departments` vào `src/integrations/supabase/types.ts`
    - Thêm interfaces: `JobType`, `JobGroup`, `Department`, `JobTypeWithRelations`, `IssuePriority`
    - Thêm Database type entries cho 3 bảng (Row, Insert, Update)
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 1.2 Tạo `src/lib/jobTypeValidation.ts` với Zod schema và pure helper functions
    - Implement `jobTypeFormSchema` (Zod schema validate form input)
    - Implement `PRIORITY_LABELS` mapping và `getPriorityLabel(priority)`
    - Implement `filterJobTypesBySearch(jobTypes, query)` — lọc case-insensitive theo name
    - Implement `paginateJobTypes(jobTypes, page, pageSize)` — phân trang client-side
    - Export type `JobTypeFormValues` từ Zod infer
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [ ]* 1.3 Tạo property tests cho Zod validation — `src/lib/__tests__/jobTypeValidation.property.test.ts`
    - **Property 1: Zod schema round-trip for valid input**
    - **Validates: Requirements 6.7**

  - [ ]* 1.4 Property test: Zod schema rejects invalid input
    - **Property 2: Zod schema rejects invalid input**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8**

  - [ ]* 1.5 Property test: Deadline fields accept non-negative integers and reject negative values
    - **Property 3: Deadline fields accept non-negative integers and reject negative values**
    - **Validates: Requirements 6.3, 6.4, 6.5**

  - [ ]* 1.6 Property test: Priority label mapping is total and correct
    - **Property 4: Priority label mapping is total and correct**
    - **Validates: Requirements 6.2**

  - [ ]* 1.7 Tạo property tests cho search và pagination — `src/lib/__tests__/jobTypeHelpers.property.test.ts`
    - **Property 5: Search filter correctness**
    - **Validates: Requirements 1.3**

  - [ ]* 1.8 Property test: Pagination bounds
    - **Property 6: Pagination bounds**
    - **Validates: Requirements 1.2**

  - [ ]* 1.9 Tạo unit tests — `src/lib/__tests__/jobTypeValidation.test.ts`
    - Test edge cases: name rỗng, name whitespace, deadline = 0, tất cả trường hợp lệ
    - Test getPriorityLabel cho từng giá trị priority
    - Test filterJobTypesBySearch: query rỗng, query không khớp
    - Test paginateJobTypes: page vượt quá tổng
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 2. Checkpoint - Đảm bảo validation logic và tests hoạt động
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Tạo TanStack Query hooks
  - [x] 3.1 Tạo `src/hooks/useJobTypes.ts`
    - Implement `useJobTypes()` — fetch job_types với join job_groups, departments, sắp xếp created_at desc
    - Implement `useCreateJobType()` — mutation tạo mới với toast "Dữ liệu đã được TẠO thành công"
    - Implement `useUpdateJobType()` — mutation cập nhật với toast "Dữ liệu đã được CẬP NHẬT thành công"
    - Implement `useDeleteJobType()` — mutation xoá với toast "Dữ liệu đã được XOÁ thành công"
    - Tất cả mutations invalidate query key `["job_types"]`
    - _Requirements: 1.2, 1.3, 1.4, 2.3, 2.5, 4.3, 4.5, 5.2, 5.4_

  - [x] 3.2 Tạo `src/hooks/useJobGroups.ts`
    - Implement `useJobGroups()` — fetch job_groups cho dropdown
    - Implement `useCreateJobGroup()` — mutation tạo nhóm mới inline
    - _Requirements: 3.1, 3.3, 3.4_

- [x] 4. Tạo UI components
  - [x] 4.1 Tạo `src/components/task-types/TaskTypeTable.tsx`
    - Bảng hiển thị 9 cột: Tên, Nhóm, Ưu tiên, 3 deadline, Giờ hành chính, Bộ phận, Thao tác
    - Search bar filter client-side theo name
    - DataTablePagination component
    - Nút Edit (xanh) và Delete (đỏ) icon buttons
    - Empty state khi danh sách rỗng
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 5.1_

  - [x] 4.2 Tạo `src/components/task-types/TaskTypeFormDialog.tsx`
    - Dialog form với React Hook Form + Zod resolver
    - Các trường: name (*), job_group_id (*) với inline create, default_priority, 3 deadlines, business_hours_only toggle, default_department_id (*)
    - Title: "THÊM LOẠI CÔNG VIỆC" hoặc "SỬA LOẠI CÔNG VIỆC"
    - Inline job group creation: option "Thêm nhóm mới" trong dropdown
    - Ghi chú "(tính theo phút, để 0 nếu không áp dụng)" cho deadline fields
    - Buttons: Huỷ (outline) | Lưu (green)
    - _Requirements: 2.1, 2.2, 2.4, 2.6, 3.1, 3.2, 3.3, 4.1, 4.2, 4.4_

  - [x] 4.3 Tạo `src/pages/settings/categories/TaskTypesPage.tsx`
    - Container page kết nối hooks và components
    - State: searchQuery, isFormOpen, editingJobType, deleteTarget, pagination
    - Sử dụng useJobTypes, useJobGroups, usePagination
    - AlertDialog xác nhận xoá: "Bạn có chắc chắn muốn xoá loại công việc này không?"
    - Toast messages cho CRUD operations
    - _Requirements: 1.1, 2.3, 2.5, 4.3, 4.5, 5.1, 5.2, 5.3, 5.4_

- [x] 5. Tích hợp routing, breadcrumbs, và navigation
  - [x] 5.1 Cập nhật `src/App.tsx` — thêm route `/settings/categories/task-types` trỏ đến TaskTypesPage
    - _Requirements: 8.1_

  - [x] 5.2 Cập nhật `src/components/layout/Breadcrumbs.tsx` — thêm label "Loại công việc" cho route `/settings/categories/task-types`
    - _Requirements: 1.1, 8.4_

  - [x] 5.3 Cập nhật `src/pages/settings/CategoriesPage.tsx` — thêm mục "Loại công việc" vào STANDALONE_ITEMS với mô tả "Quản lý loại công việc vận hành" và link đến `/settings/categories/task-types`
    - _Requirements: 8.2, 8.3_

- [x] 6. Final checkpoint - Đảm bảo tất cả hoạt động
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Database schema đã tồn tại — không cần migration
- Sử dụng TypeScript cho tất cả implementation
- Property tests sử dụng `fast-check` với tối thiểu 100 iterations mỗi test
- Pattern hooks theo `useHotlines` hiện có trong codebase
