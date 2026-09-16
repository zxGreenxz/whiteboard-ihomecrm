// @vitest-environment jsdom
//
// FORM ĐÓNG THÌ KHÔNG ĐƯỢC ĐỌC GÌ.
//
// /thu-chi mount SẴN ba `<IncomeExpenseForm>` (tạo mới, sửa, tạo bản sao) với
// `open={false}` — xem IncomeExpensePage.tsx:844/850/856 và bản mobile. Trước
// bản vá này thân form vẫn chạy đủ mọi hook dù đang đóng, trong đó
// `useContractsLegacy(undefined)` quét TOÀN BỘ bảng contracts (`select *` kèm
// `count: exact`, không range) — ba lần, ngay khi vừa vào trang, trước khi
// người dùng bấm gì.
//
// Bài này chốt hai điều: (1) form đóng render ra rỗng; (2) không hook đọc dữ
// liệu nào được gọi. Giữ hook order an toàn bằng cách tách phần thân thành
// `IncomeExpenseFormInner` — vỏ ngoài early-return TRƯỚC mọi hook.
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const boundary = vi.hoisted(() => ({
  contractsLegacy: vi.fn(() => ({ data: [] })),
  accounts: vi.fn(() => ({ data: [] })),
  formRooms: vi.fn(() => ({ data: [] })),
  formBuildings: vi.fn(() => ({ data: [] })),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } },
}));
vi.mock('@/hooks/useContracts', () => ({ useContractsLegacy: boundary.contractsLegacy }));
vi.mock('@/hooks/useAccounts', () => ({ useAccounts: boundary.accounts }));
vi.mock('@/hooks/useIncomeExpenseFormScope', () => ({
  useIncomeExpenseFormRooms: boundary.formRooms,
  useIncomeExpenseFormBuildings: boundary.formBuildings,
}));

import IncomeExpenseForm from '../IncomeExpenseForm';

beforeEach(() => {
  for (const spy of Object.values(boundary)) spy.mockClear();
});

describe('IncomeExpenseForm khi đóng', () => {
  it('render ra rỗng', () => {
    const { container } = render(
      <IncomeExpenseForm open={false} onOpenChange={() => {}} voucher={null} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('KHÔNG gọi hook đọc dữ liệu nào — kể cả useContractsLegacy quét toàn bảng HĐ', () => {
    render(<IncomeExpenseForm open={false} onOpenChange={() => {}} voucher={null} />);
    expect(boundary.contractsLegacy).not.toHaveBeenCalled();
    expect(boundary.accounts).not.toHaveBeenCalled();
    expect(boundary.formRooms).not.toHaveBeenCalled();
    expect(boundary.formBuildings).not.toHaveBeenCalled();
  });

  it('ba form mount sẵn trên /thu-chi ⇒ vẫn 0 lần đọc', () => {
    render(
      <>
        <IncomeExpenseForm open={false} onOpenChange={() => {}} voucher={null} />
        <IncomeExpenseForm open={false} onOpenChange={() => {}} voucher={null} />
        <IncomeExpenseForm open={false} onOpenChange={() => {}} voucher={null} />
      </>,
    );
    expect(boundary.contractsLegacy).not.toHaveBeenCalled();
  });
});

describe('IncomeExpenseForm khi mở', () => {
  it('chưa chọn phòng ⇒ useContractsLegacy bị tắt, không quét toàn bảng HĐ', () => {
    // Không render cả form (thân form kéo theo hàng chục hook); chốt giao kèo ở
    // chỗ duy nhất quyết định: form phải truyền `enabled` theo phòng đã chọn.
    const nguon = readFileSync('src/components/income-expenses/IncomeExpenseForm.tsx', 'utf8');
    expect(nguon).toContain('enabled: open && !!selectedRoomId');
  });
});
