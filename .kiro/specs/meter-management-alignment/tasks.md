# Implementation Plan: Căn chỉnh trang Quản lý Đồng hồ Công tơ

## Overview

Sửa đổi code hiện có để khớp 100% với tài liệu hướng dẫn Resident. Không tái triển khai — chỉ sửa các điểm lệch: nút text thay icon, toast messages, loại bỏ trường service_id khỏi form, auto-resolve service_id, dọn dẹp route/page cũ.

## Tasks

- [x] 1. Fix MeterList action buttons and toast messages
  - [x] 1.1 Change icon buttons to text buttons in MeterList.tsx
    - Replace `<Pencil>` icon button with text button "Sửa" (`variant="ghost" size="sm"`)
    - Replace `<Trash2>` icon button with text button "Xoá" (`variant="ghost" size="sm" className="text-destructive hover:text-destructive"`)
    - Remove unused `Pencil`, `Trash2` imports from `lucide-react`
    - _Requirements: 1.4, 3.1, 4.1_

  - [x] 1.2 Fix toast messages in useMeters.ts
    - Change `useCreateMeter` onSuccess toast from "Công tơ đã được tạo thành công" to "Dữ liệu đã được TẠO thành công"
    - Change `useDeleteMeter` onSuccess toast from "Công tơ đã được xóa thành công" to "Dữ liệu đã được XOÁ thành công"
    - _Requirements: 6.1, 6.2_

- [x] 2. Remove service_id from form and add auto-resolve logic
  - [x] 2.1 Remove service_id from Zod schema in meterReadingValidation.ts
    - Remove `service_id: z.string().min(1, 'Vui lòng chọn dịch vụ')` from `meterFormSchema`
    - Update `MeterFormValues` type export (auto-inferred from schema)
    - _Requirements: 8.1, 8.2_

  - [x] 2.2 Remove service_id field from MeterForm.tsx UI
    - Remove the `service_id` FormField JSX block
    - Remove `useServices` import
    - Remove `service_id` from form defaultValues and reset logic
    - Remove `service_id` from onSubmit payload (both create and update paths)
    - _Requirements: 8.1, 8.2_

  - [x] 2.3 Add auto-resolve service_id in useMeters.ts
    - In `useCreateMeter` mutationFn, query `services` table to find service matching `meter_type` (ELECTRICITY→Điện, WATER→Nước, GAS→Gas) and inject `service_id` into insert payload
    - In `useUpdateMeter` mutationFn, do the same for update payload when `meter_type` is present
    - Show toast error if no matching service found
    - _Requirements: 2.4, 8.1_

  - [ ]* 2.4 Write property test for validation schema (Property 1)
    - **Property 1: Validation schema chấp nhận form hợp lệ và từ chối form thiếu trường bắt buộc**
    - File: `src/lib/__tests__/meterFormValidation.property.test.ts`
    - Generate random form data with valid/invalid required fields (building_id, room_id, meter_type, code)
    - Assert: schema.safeParse succeeds for valid data, fails for missing required fields
    - Min 100 iterations with fast-check
    - **Validates: Requirements 2.2, 2.3, 2.7, 8.1, 8.2**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Clean up legacy page and routing
  - [x] 4.1 Delete legacy MetersPage and update App.tsx routing
    - Delete `src/pages/settings/categories/MetersPage.tsx`
    - In `App.tsx`: remove `MetersLegacyPage` import, replace route `/settings/categories/meters` with `<Navigate to="/settings/meters" replace />`
    - _Requirements: 7.1, 7.2_

  - [x] 4.2 Update CategoriesPage.tsx navigation link
    - Change href from `/settings/categories/meters` to `/settings/meters` for "Đồng hồ công tơ" entry
    - _Requirements: 7.1_

  - [x] 4.3 Update Breadcrumbs.tsx mapping
    - Replace `/settings/categories/meters` key with `/settings/meters` in the breadcrumb path map
    - _Requirements: 7.1_

- [ ] 5. Property tests for form round-trip and room cascade
  - [ ]* 5.1 Write property test for form pre-population round-trip (Property 2)
    - **Property 2: Form pre-population round-trip**
    - File: `src/components/meters/__tests__/meterFormPopulation.property.test.ts`
    - Generate random MeterWithRoom objects, convert to form values then back to update payload
    - Assert: all user-editable fields are preserved through the round-trip
    - Min 100 iterations with fast-check
    - **Validates: Requirements 3.1**

  - [ ]* 5.2 Write property test for room cascade filtering (Property 3)
    - **Property 3: Room cascade filtering**
    - File: `src/hooks/__tests__/useMeters.property.test.ts` (append to existing)
    - Generate random rooms with random building_ids, pick a random building_id filter
    - Assert: filtered rooms all match building_id, no matching room is excluded
    - Min 100 iterations with fast-check
    - **Validates: Requirements 8.4**

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Existing property tests in `useMeters.property.test.ts` (Properties 1, 2, 5, 6 from meter-reading-reimplementation) remain unchanged
