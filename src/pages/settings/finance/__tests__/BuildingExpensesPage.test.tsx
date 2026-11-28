// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import BuildingExpensesPage from '../BuildingExpensesPage';

const state = vi.hoisted(() => ({owner: true, route: 'CANONICAL', fail: false, org: 'org-a', month: '2026-11'}));
const query = <T,>(data: T, fail = false) => ({
  data, status: fail ? 'error' : 'success', fetchStatus: 'idle', isLoading: false, isError: fail,
  error: fail ? {code:'FETCH_ERROR'} : null, refetch: vi.fn(),
});
const cell = (id: string) => ({ buildingId: id, buildingName: id, feeCategory: 'internet', notApplicable: false });
vi.mock('@/components/layout/MainLayout', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@/contexts/OrganizationContext', () => ({useOrganization: () => ({selectedOrganizationId: state.org})}));
vi.mock('@/hooks/useBuildingExpenseDirectory', () => ({
  useExpenseBuildings: () => query([{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}]),
  useOrgExpenseRules: () => query([{id:'t',name:'Internet',fee_category:'internet',spend_mode:'CAM_KET'}]),
}));
vi.mock('@/hooks/useMyBuildingScope', () => ({useMyBuildingScope: () => ({canManageBuilding:(b:string) => b!=='c'})}));
vi.mock('@/hooks/useIsCompanyOwner', () => ({useIsCompanyOwner: () => query(state.owner)}));
vi.mock('@/hooks/useIsAdmin', () => ({useIsSuperAdmin: () => query(false)}));
vi.mock('@/hooks/useFeeConfigMatrix', () => ({
  FEE_KINDS: [{key:'internet',label:'Internet'}],useFeeConfigMatrix: ([id]:string[]) => ({
    ...query([cell(id)]),byBuilding:new Map([[id,{cells:new Map([['internet',cell(id)]])}]]),
  }),
}));
vi.mock('@/hooks/useSpecialFeePrices', () => ({useSpecialFeePrices: ([id]:string[], month:string) => ({
  ...query([]),byCell:new Map([[id+':internet',{amount: month==='2026-12'?600000:500000}]]),
})}));
vi.mock('@/hooks/useSpendEngine', () => ({
  useSpendEngineStatus: (id:string|null) => query(id ? {route:state.route} : undefined),
  useSpendSwitches: () => query([{fee_category:'internet',building_id:'a',period_from:'2026-11-01',period_to:'2026-11-01'}],state.fail),
  useSpendCommitments: () => query([{building_id:'a',fee_category:'internet',amount:800000,remaining:400000}]),
}));
vi.mock('../SpendControls', () => ({
  CommitmentEditor:()=>null, RulesTab:()=>null, SelfApprovedTab:()=>null, ShadowTab:()=>null, SpendStatus:()=>null, SwitchesTab:()=>null,
}));
vi.mock('../FeeDetails', () => ({default: ()=> <p>Chi tiết Internet</p>}));
afterEach(() => { cleanup(); state.owner=true; state.route='CANONICAL'; state.fail=false; state.org='org-a'; });
function openAt(month='2026-11') {
  render(<BuildingExpensesPage/>);
  fireEvent.change(screen.getByLabelText('Tháng'),{target:{value:month}});
}
it('mức duyệt theo đúng tòa và tháng, gập chi tiết khi đổi tòa', () => {
  openAt();expect(screen.getByText('Duyệt trong hạn mức tháng')).toBeTruthy();
  expect(screen.getByText('400.000đ')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Internet'}));expect(screen.getByText('Chi tiết Internet')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tòa nhà'), {target:{value:'b'}});
  expect(screen.getByText('Duyệt đúng giá')).toBeTruthy();expect(screen.queryByText('Chi tiết Internet')).toBeNull();
  fireEvent.change(screen.getByLabelText('Tháng'),{target:{value:'2026-12'}});
  expect(screen.getByText('600.000đ')).toBeTruthy();
});
it('nhân viên thấy giá, chỉ chọn được tòa trong phạm vi và không thấy hạn mức', () => {
  state.owner=false;openAt();
  expect(within(screen.getByRole('table')).getByText('500.000đ')).toBeTruthy();
  expect(screen.queryByRole('columnheader',{name:'Còn được chi'})).toBeNull();
  expect(screen.queryByRole('option',{name:'C'})).toBeNull();
  expect(screen.queryByRole('tab',{name:'Luật hạng mục'})).toBeNull();
  expect(screen.queryByText('400.000đ')).toBeNull();
});
it('lỗi nguồn công tắc không được ngầm chuyển sang duyệt đúng giá', () => {
  state.fail=true;openAt();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByText('Chưa xác định cách duyệt')).toBeTruthy();
  expect(screen.queryByText('Duyệt đúng giá')).toBeNull();
});
it('chạy thử vẫn dùng luồng đóng phí và không hiện số còn lại như mức đang áp', () => {
  state.route='SHADOW';openAt();
  expect(screen.getByText('Duyệt đúng giá')).toBeTruthy();
  expect(screen.queryByText('400.000đ')).toBeNull();
});
