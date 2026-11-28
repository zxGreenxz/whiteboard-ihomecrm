import { Fragment, useState } from 'react';
import { Building2, ChevronDown, ChevronRight } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useExpenseBuildings, useOrgExpenseRules } from '@/hooks/useBuildingExpenseDirectory';
import { FEE_KINDS, useFeeConfigMatrix, type FeeKind } from '@/hooks/useFeeConfigMatrix';
import { useSpecialFeePrices } from '@/hooks/useSpecialFeePrices';
import { useSpendCommitments, useSpendEngineStatus, useSpendSwitches } from '@/hooks/useSpendEngine';
import { useIsCompanyOwner } from '@/hooks/useIsCompanyOwner';
import { useIsSuperAdmin } from '@/hooks/useIsAdmin';
import { useMyBuildingScope } from '@/hooks/useMyBuildingScope';
import { describeExpensePolicy } from '@/lib/buildingExpensePolicy';
import { normalizeVietnamese } from '@/lib/utils';
import { currentMonthVN } from '@/lib/collect';
import FeeDetails from './FeeDetails';
import { CommitmentEditor, RulesTab, SelfApprovedTab, ShadowTab, SpendStatus, SwitchesTab } from './SpendControls';

const money = (value?: number) => value == null ? '—' : value.toLocaleString('vi-VN') + 'đ';

function useExpenseAccess(orgId: string) {
  const owner = useIsCompanyOwner();
  const admin = useIsSuperAdmin();
  const mayReadRules = (!owner.isError && owner.data === true) || (!admin.isError && admin.data === true);
  const status = useSpendEngineStatus(mayReadRules ? orgId : null);
  // The server checks the owner against this company. An owner elsewhere may get 42501.
  const canManage = mayReadRules && !!status.data && !status.isError;
  const restricted = (!owner.isError && !admin.isError && owner.data === false && admin.data === false)
    || (status.error as { code?: string } | null)?.code === '42501';
  return { owner, admin, status, mayReadRules, canManage, restricted };
}

type ExpenseAccess = ReturnType<typeof useExpenseAccess>;

function BuildingFees({ orgId, buildingId, month, access }: {
  orgId: string; buildingId: string; month: string; access: ExpenseAccess;
}) {
  const [expanded, setExpanded] = useState<FeeKind | null>(null);
  const config = useFeeConfigMatrix([buildingId]);
  const prices = useSpecialFeePrices([buildingId], month);
  const { owner, admin, status, mayReadRules, canManage, restricted } = access;
  const scope = canManage ? orgId : null;
  const switches = useSpendSwitches(scope, buildingId, month);
  const commitments = useSpendCommitments(scope, month, month, buildingId);
  const rules = useOrgExpenseRules(scope);
  const policyQueries = [status, switches, commitments, rules];
  const ready = canManage && policyQueries.every(q => q.data !== undefined && !q.isError);
  const failure = canManage && [switches, commitments, rules].some(q => q.isError);
  const cells = config.byBuilding.get(buildingId)?.cells;
  const reload = () => {
    const sources = [config, prices, owner, admin];
    for (const q of sources) void q.refetch();
    if (mayReadRules && !restricted) void status.refetch();
    if (canManage) for (const q of [switches, commitments, rules]) void q.refetch();
  };
  return <QueryRegion label="chi phí theo tòa" queries={[config, prices]} skeleton="table">
    {restricted && <p className="text-sm text-muted-foreground">Bạn có thể xem giá và sửa số gợi ý. Quy tắc duyệt và hạn mức tháng thuộc quyền chủ công ty.</p>}
    {failure && <div role="alert" className="flex items-center gap-3 rounded-md border p-3 text-sm">
      Chưa tải đủ quy tắc duyệt của công ty.
      <Button size="sm" variant="outline" onClick={() => {
        for (const q of [switches, commitments, rules]) if (q.isError) void q.refetch();
      }}>Tải lại quy tắc</Button>
    </div>}
    <div className="space-y-3">
      <div className="flex justify-end"><Button type="button" variant="outline" size="sm" onClick={reload}>Tải lại bảng</Button></div>
      <div className="overflow-x-auto rounded-lg border">
        <Table><TableHeader className="max-sm:sr-only"><TableRow>
          <TableHead>Hạng mục</TableHead><TableHead>{canManage ? 'Cách duyệt khi đóng phí' : 'Hạng mục áp dụng'}</TableHead>
          <TableHead className="text-right">{canManage ? 'Mức áp dụng' : 'Giá công bố'}</TableHead>{canManage && <TableHead className="text-right">Còn được chi</TableHead>}
        </TableRow></TableHeader><TableBody>
          {FEE_KINDS.map(({ key, label }) => {
            const cell = cells?.get(key);
            const price = prices.byCell.get(buildingId + ':' + key);
            if (!cell) return <TableRow key={key}><TableCell>{label}</TableCell><TableCell colSpan={canManage ? 3 : 2}>Chưa tải được cấu hình hạng mục.</TableCell></TableRow>;
            const rule = rules.data?.find(t => t.fee_category === key);
            // pay_utility_bill resolves the utility voucher type by normalized name.
            const utilityName = key === 'dien' ? 'dong tien dien' : key === 'nuoc' ? 'dong tien nuoc' : null;
            const writerRule = utilityName ? rules.data?.find(t =>
              normalizeVietnamese(t.name).trim().replace(/\s+/g, ' ') === utilityName) : rule;
            const commitment = commitments.data?.find(c => c.building_id === buildingId && c.fee_category === key);
            const policy = describeExpensePolicy({
              buildingId, month, fee: key, route: ready && price ? status.data?.route : undefined,
              mode: writerRule?.fee_category === key ? writerRule.spend_mode : undefined, switches: switches.data ?? [], commitment,
              price: price?.amount ?? null, disabled: cell.notApplicable,
            });
            const visibility = utilityName ? 'Ẩn ở tổng quan phí' : 'Ẩn trên lưới đóng phí';
            const title = canManage ? policy.label : cell.notApplicable ? visibility : 'Đang dùng';
            const feeAmount = !price ? 'Chưa tải được giá' : price.amount == null ? 'Chưa công bố' : money(price.amount);
            const limit = policy.limitDescription ?? money(policy.amount);
            const open = expanded === key;
            const selection = { orgId, buildingId, buildingName: cell.buildingName, fee: key, month };
            return <Fragment key={key}><TableRow className="max-sm:grid max-sm:grid-cols-2 max-sm:py-1">
              <TableCell className="font-medium max-sm:col-span-2 max-sm:pb-0"><button type="button" aria-expanded={open}
                aria-controls={open ? 'chi-phi-' + key : undefined} onClick={() => setExpanded(open ? null : key)}
                className="flex items-center gap-1.5 py-1 text-left hover:underline">
                {open ? <ChevronDown size={16}/> : <ChevronRight size={16}/>} {label}
              </button></TableCell>
              <TableCell className="max-sm:col-span-2 max-sm:py-1"><span className="font-medium">{title}</span>
                {canManage && utilityName && cell.notApplicable && <span className="block text-xs text-muted-foreground">Ẩn ở tổng quan phí. Vẫn có thể đóng theo công tơ.</span>}
                {canManage && policy.note && <span className="block text-xs text-muted-foreground">{policy.note}</span>}</TableCell>
              <TableCell className="text-right tabular-nums max-sm:text-left"><span className="block text-xs text-muted-foreground sm:hidden">{canManage ? 'Mức áp dụng' : 'Giá công bố'}</span>{canManage ? limit : feeAmount}</TableCell>
              {canManage && <TableCell className={`text-right tabular-nums max-sm:text-left ${(policy.remaining ?? 0) < 0 ? 'text-destructive' : ''}`}><span className="block text-xs text-muted-foreground sm:hidden">Còn được chi</span>{money(policy.remaining)}</TableCell>}
            </TableRow>
            {open && <TableRow><TableCell colSpan={canManage ? 4 : 3} id={'chi-phi-' + key} className="bg-muted/30">
              <div className="space-y-4">
                <FeeDetails cell={cell} price={price} month={month}/>
                {canManage && <div className="space-y-3">
                  {(rule?.spend_mode === 'CAM_KET' || commitment) && <CommitmentEditor {...selection}/>}
                  <details><summary className="cursor-pointer text-sm font-medium">Sửa quy tắc và phạm vi áp dụng</summary>
                    <div className="mt-3 space-y-4"><RulesTab orgId={orgId} fee={key}/>
                      <SwitchesTab orgId={orgId} route={status.data?.route} cell={selection}/></div>
                  </details>
                </div>}
              </div>
            </TableCell></TableRow>}
            </Fragment>;
          })}
        </TableBody></Table>
      </div>
      {canManage && <p className="text-sm text-muted-foreground">Bảng áp dụng cho một khoản đóng trọn tháng ở Thanh toán. Phiếu Thu chi lập tay, định kỳ và sinh hàng loạt còn xét nguồn phiếu, sổ quỹ và các dòng trong phiếu. Phiếu chờ duyệt cũng giữ chỗ trong hạn mức.</p>}
    </div>
  </QueryRegion>;
}

function ExpenseDirectory({ orgId, access }: { orgId: string; access: ExpenseAccess }) {
  const buildings = useExpenseBuildings(orgId);
  const scope = useMyBuildingScope('thu_tien', 'collect');
  const [chosen, setChosen] = useState('');
  const [month, setMonth] = useState(currentMonthVN);
  const options = buildings.data?.filter(b => scope.canManageBuilding(b.id)) ?? [];
  const buildingId = options.find(b => b.id === chosen)?.id ?? options[0]?.id;
  return <QueryRegion label="tòa nhà" queries={[buildings]} skeleton="table">
    {scope.isLoading ? <p>Đang tải phạm vi tòa…</p> : scope.isError ? <p role="alert">Chưa tải được quyền xem tòa.</p>
      : !buildingId ? <p>Chưa có tòa nào trong phạm vi của bạn.</p>
      : <>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="expense-building">Tòa nhà</Label>
            <select id="expense-building" className="flex h-10 max-w-full rounded-md border bg-background px-3 text-sm"
              value={buildingId} onChange={e => setChosen(e.target.value)}>
              {options.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></div>
          <div className="space-y-1"><Label htmlFor="expense-month">Tháng</Label>
            <Input id="expense-month" type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)}/></div>
        </div>
        <BuildingFees key={buildingId + month} orgId={orgId} buildingId={buildingId} month={month} access={access}/>
      </>}
  </QueryRegion>;
}

function CompanyExpenses({ orgId }: { orgId: string }) {
  const access = useExpenseAccess(orgId);
  const [tab, setTab] = useState('costs');
  const { canManage, restricted, owner, admin, status } = access;
  const accessQueries = [owner, admin, status];
  return <Tabs value={canManage ? tab : 'costs'} onValueChange={setTab} className="space-y-3">
    {!restricted && accessQueries.some(q => q.isError) && <div role="alert" className="flex items-center gap-3 rounded-md border p-3 text-sm">
      Chưa xác minh được quyền xem quy tắc của công ty.
      <Button size="sm" variant="outline" onClick={() => {
        for (const q of accessQueries) if (q.isError) void q.refetch();
      }}>Tải lại quyền</Button>
    </div>}
    {canManage && <TabsList className="h-auto flex-wrap">
      <TabsTrigger value="costs">Chi phí theo tòa</TabsTrigger>
      <TabsTrigger value="rules">Luật hạng mục</TabsTrigger>
      <TabsTrigger value="switches">Phạm vi áp dụng</TabsTrigger>
      <TabsTrigger value="audit">Lịch sử duyệt</TabsTrigger>
    </TabsList>}
    <TabsContent value="costs" forceMount className="data-[state=inactive]:hidden">
      <ExpenseDirectory orgId={orgId} access={access}/>
    </TabsContent>
    {canManage && <>
      <TabsContent value="rules"><RulesTab orgId={orgId}/></TabsContent>
      <TabsContent value="switches"><SwitchesTab orgId={orgId} route={status.data?.route}/></TabsContent>
      <TabsContent value="audit" className="space-y-4">
        <SpendStatus orgId={orgId}/>
        <Tabs defaultValue="decisions"><TabsList>
          <TabsTrigger value="decisions">Máy chấm thử</TabsTrigger><TabsTrigger value="self">Tự duyệt</TabsTrigger>
        </TabsList>
          <TabsContent value="decisions"><ShadowTab orgId={orgId}/></TabsContent>
          <TabsContent value="self"><SelfApprovedTab orgId={orgId}/></TabsContent>
        </Tabs>
      </TabsContent>
    </>}
  </Tabs>;
}

export default function BuildingExpensesPage() {
  const org = useOrganization();
  return <MainLayout><main className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
    <h1 className="flex items-center gap-2 text-2xl font-semibold"><Building2 aria-hidden size={23}/>Chi phí theo tòa</h1>
    {org.selectedOrganizationId ? <CompanyExpenses key={org.selectedOrganizationId} orgId={org.selectedOrganizationId}/>
      : <p role="status">{org.isError ? 'Chưa tải được công ty.' : org.isLoading ? 'Đang tải công ty…' : 'Chọn công ty để xem chi phí theo tòa.'}</p>}
  </main></MainLayout>;
}
