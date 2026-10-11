// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CommissionAuditEntry, CommissionAuditHistory } from '../CommissionAuditHistory';
const state=vi.hoisted(()=>({data:[] as unknown[],isLoading:false,isError:false,refetch:vi.fn()}));
vi.mock('@/hooks/useCommissionAudit',()=>({useCommissionAudit:()=>state}));
afterEach(()=>{cleanup();state.data=[];state.isError=false;});
it('shows the actual actor, stage, reason and before/after amounts from saved evidence',()=>{
  render(<CommissionAuditEntry event={{id:'10000000-0000-4000-8000-000000000001',stage:'EDIT_PENDING',actor_id:'10000000-0000-4000-8000-000000000002',actor_name:'Người kiểm thử',at:'2026-01-01T03:00:00Z',reason:'Điều chỉnh theo phụ lục',before:{total_amount:2500000},after:{total_amount:2000000},baseline:{rent_price:5000000,months:12,rate_percent:50,default_amount:2500000}}}/>);
  expect(screen.getByText('Sửa phiếu chờ duyệt')).toBeTruthy();
  expect(screen.getByText(/Người kiểm thử/)).toBeTruthy();
  expect(screen.getByText(/Điều chỉnh theo phụ lục/)).toBeTruthy();
  expect(screen.getByText(/Trước:.*2.500.000/)).toBeTruthy();
  expect(screen.getByText(/Sau:.*2.000.000/)).toBeTruthy();
});
it('states the absence of historical reasons without inventing an actor or reason',()=>{
  render(<CommissionAuditHistory voucherId="voucher" showLegacyNotice/>);
  expect(screen.getByText(/Chưa có lịch sử lý do/)).toBeTruthy();
  expect(screen.queryByText(/Thực hiện theo cấu hình/)).toBeNull();
});
it('shows a retryable failure instead of a missing-history conclusion',()=>{
  state.isError=true;render(<CommissionAuditHistory voucherId="voucher" showLegacyNotice/>);
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Tải lại'})).toBeTruthy();
  expect(screen.queryByText(/Chưa có lịch sử lý do/)).toBeNull();
});
it('still identifies missing creation evidence when a legacy voucher has later edits',()=>{
  state.data=[{id:'10000000-0000-4000-8000-000000000001',stage:'EDIT_PENDING',actor_id:'10000000-0000-4000-8000-000000000002',actor_name:'Người kiểm thử',at:'2026-01-01T03:00:00Z',reason:'Điều chỉnh theo phụ lục',before:{total_amount:2500000},after:{total_amount:2000000},baseline:null}];
  render(<CommissionAuditHistory voucherId="voucher" showLegacyNotice/>);
  expect(screen.getByText(/Chưa có lịch sử lý do tại thời điểm lập phiếu/)).toBeTruthy();
  expect(screen.getByText('Sửa phiếu chờ duyệt')).toBeTruthy();
});
it('shows the saved cashbook and room names plus posting status before and after',()=>{
  render(<CommissionAuditEntry event={{id:'10000000-0000-4000-8000-000000000001',stage:'EDIT_PENDING',actor_id:'10000000-0000-4000-8000-000000000002',actor_name:'Người kiểm thử',at:'2026-01-01T03:00:00Z',reason:'Chọn lại sổ và phòng theo hồ sơ',before:{account_name:'Quỹ A',room_name:'Phòng A',posting_status:'UNPOSTED'},after:{account_name:'Quỹ B',room_name:'Phòng B',posting_status:'POSTED'},baseline:null}}/>);
  expect(screen.getByText('Trước: Quỹ A')).toBeTruthy();expect(screen.getByText('Sau: Quỹ B')).toBeTruthy();
  expect(screen.getByText('Trước: Phòng A')).toBeTruthy();expect(screen.getByText('Sau: Phòng B')).toBeTruthy();
  expect(screen.getByText('Trước: Chưa ghi sổ')).toBeTruthy();expect(screen.getByText('Sau: Đã ghi sổ')).toBeTruthy();
});
