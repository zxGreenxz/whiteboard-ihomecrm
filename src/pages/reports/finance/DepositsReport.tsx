import { QueryRegion } from "@/components/errors/QueryRegion";
import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import { ChevronRight } from "lucide-react";
import { useReservationDeposits } from '@/hooks/useDeposits';
import { useHeldDeposits, useDepositSettlementReport } from '@/hooks/useDepositDashboard';
import { usePersistedState } from "@/hooks/usePersistedState";
import { BuildingFilterSelect } from "@/components/buildings/BuildingFilterSelect";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from '@/components/ui/button';
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/utils";

const STATUS_MAP: Record<string,string> = {
  HOLD:'Giữ chỗ trước hợp đồng', CONTRACT:'Đang giữ theo hợp đồng', REVIEW:'Chưa xác định lượt thuê',
  PENDING:'Chờ duyệt / ghi sổ', REFUND_DUE:'Phải hoàn khách', REFUNDED:'Đã hoàn khách', RETAINED:'Đã bỏ cọc',
};
type ReportRow={id:string;buildingId:string;building:string;room:string;person:string;status:string;amount:number;code:string};
export default function DepositsReport() {
  const [statusFilter, setStatusFilter] = usePersistedState<string>("flt:rpt-deposits:status", "all");
  // Lọc 1 toà (BuildingFilterSelect, state giữ shape mảng 0/1 phần tử). [] = tất cả.
  // Lọc client-side theo buildings.id trên rows đã fetch (hook không nhận filter).
  const [buildingIds, setBuildingIds] = usePersistedState<string[]>("flt:rpt-deposits:buildingIds", []);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  const vouchers=useReservationDeposits(buildingIds);
  const contracts=useHeldDeposits();
  const settlements=useDepositSettlementReport();
  const filtered=useMemo(()=>{
    const rows=new Map<string,ReportRow>();
    const add=(row:ReportRow)=>{
      const old=rows.get(row.id);
      rows.set(row.id,old?{...old,amount:old.amount+row.amount,code:old.code+', '+row.code}:row);
    };
    for(const v of vouchers.data??[]){
      if(v.approval_status==='CANCELLED')continue;
      const base={buildingId:v.building_id,building:v.building_name,room:v.room_name??'—',person:v.payer_name??'—',code:v.code??'—'};
      if(v.settlement){
        for(const [status,amount] of [['REFUND_DUE',v.settlement.refundRemaining],['REFUNDED',v.settlement.refundedAmount],['RETAINED',v.settlement.retainedAmount]] as const){
          if(amount>0)add({...base,id:status+v.id,status,amount});
        }
        continue;
      }
      const verified=v.received_fact_status==='VERIFIED' && v.approval_status==='APPROVED' && (v.received_amount??0)>0;
      const status=!v.reservation_id?'REVIEW':verified?'HOLD':'PENDING';
      add({...base,id:status+(v.reservation_id??v.id),status,amount:verified?Number(v.received_amount):0});
    }
    for(const h of contracts.data??[]){
      add({id:h.contract_id,buildingId:h.building_id,building:h.building_name,room:h.room_name,
        person:h.customer_name,code:h.contract_number??'—',status:'CONTRACT',amount:h.deposit_paid});
    }
    for(const r of settlements.data?.settlements??[]){
      const base={buildingId:r.building_id,building:r.building_name,room:r.room_name,person:r.customer_name,code:r.contract_number??'—'};
      if(r.pending_deposit_refund)add({...base,id:'pending-refund-'+r.id,status:'REFUND_DUE',amount:r.pending_deposit_refund});
      if(r.posted_deposit_refund)add({...base,id:'refund-'+r.id,status:'REFUNDED',amount:r.posted_deposit_refund});
      if(r.kind==='FORFEIT' && r.status==='COMPLETED')add({...base,id:'forfeit-'+r.id,status:'RETAINED',amount:r.total_deposit});
    }
    for(const v of settlements.data?.unlinked??[]){
      add({id:'unlinked-'+v.id,code:v.code,buildingId:v.buildingId,building:v.building,room:v.room,
        person:v.person,amount:v.amount,status:v.posted?'REFUNDED':'REFUND_DUE'});
    }
    return [...rows.values()].filter(r=>(!buildingIds.length||buildingIds.includes(r.buildingId)) && (statusFilter==='all'||r.status===statusFilter))
      .sort((a,b)=>a.building.localeCompare(b.building,'vi')||a.room.localeCompare(b.room,'vi',{numeric:true}));
  },[vouchers.data,contracts.data,settlements.data,buildingIds,statusFilter]);
  const total=filtered.reduce((sum,r)=>sum+(statusFilter!=='all'||['CONTRACT','HOLD','REVIEW'].includes(r.status)?r.amount:0),0);
  const isLoading=vouchers.isLoading||contracts.isLoading||settlements.isLoading;
  const totalCount = filtered.length;
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <MainLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link to="/reports/finance" className="hover:text-primary">
            Báo cáo tài chính
          </Link>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">Danh sách tiền cọc</span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <SearchableSelect
            value={statusFilter}
            onValueChange={v=>{setStatusFilter(v);setPage(1);}}
            className="w-[200px]"
            placeholder="Loại cọc"
            options={[
              { value: 'all', label: 'Tất cả loại cọc' },
              ...Object.entries(STATUS_MAP).map(([k, v]) => ({ value: k, label: v })),
            ]}
          />

          <BuildingFilterSelect
            value={buildingIds}
            onChange={(ids) => {
              setBuildingIds(ids);
              setPage(1);
            }}
            className="w-[260px]"
            placeholder="Tất cả toà nhà"
          />
        </div>

        <QueryRegion label="báo cáo tiền cọc" queries={[vouchers,contracts,settlements]} skeleton="table" rows={8}>
        <div className="text-base font-semibold">{statusFilter==='all'?'Tiền cọc đang giữ':'Tổng theo phân loại'} · {formatCurrency(total)}</div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tòa nhà</TableHead>
                <TableHead>Căn hộ</TableHead>
                <TableHead>Người gửi / khách ký</TableHead>
                <TableHead className="text-right">Số tiền cọc</TableHead>
                <TableHead>Chứng từ / hợp đồng</TableHead>

                <TableHead>Phân loại</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    Không có dữ liệu nào để hiển thị
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.building}</TableCell>
                    <TableCell>{d.room}</TableCell>
                    <TableCell>{d.person}</TableCell>
                    <TableCell className="text-right">{formatCurrency(d.amount)}</TableCell>
                    <TableCell>{d.code}</TableCell>
                    <TableCell>{STATUS_MAP[d.status] || d.status}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Số bản ghi</span>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v, 10)); setPage(1); }}>
              <SelectTrigger className="w-[80px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" disabled={page<=1} onClick={()=>setPage(page-1)}>Trang trước</Button>
          <Button variant="outline" disabled={page*pageSize>=totalCount} onClick={()=>setPage(page+1)}>Trang sau</Button>
          <div>
            {totalCount === 0
              ? "1 - 0 trên tổng số 0 bản ghi"
              : `${(page - 1) * pageSize + 1} - ${Math.min(page * pageSize, totalCount)} trên tổng số ${totalCount} bản ghi`}
          </div>
        </div>
      </QueryRegion>
      </div>
    </MainLayout>
  );
}
