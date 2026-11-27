import { useState, type ReactNode } from "react";
import { ForecastBreakdown } from "./ForecastBreakdown";
import { ArrowDownLeft, ArrowUpRight, ChartNoAxesColumnIncreasing, ChevronDown, Wallet } from "lucide-react";
import { QueryRegion } from "@/components/errors/QueryRegion";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/contexts/OrganizationContext";
import { type ForecastHouse, useShareholderForecast } from "@/hooks/useShareholderForecast";
import { formatCurrency } from "@/lib/utils";
import { vnTodayISO } from "@/lib/vnDate";
import { FEE_KINDS } from "@/hooks/useFeeConfigMatrix";

const labels = new Map<string,string>(FEE_KINDS.map(k => [k.key,k.label]));
const fmt = (value: number | null) => value === null ? "Chưa có số" : formatCurrency(value);
const millions = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const inputClass = "h-10 max-w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";

function HouseDetail({ h }: { h: ForecastHouse }) {
  return <div className="space-y-3 border-t bg-muted/25 p-3 sm:p-4">
    <div className="grid gap-3 md:grid-cols-2">
      <ForecastBreakdown house={h} side="income" />
      <ForecastBreakdown house={h} side="expense" />
    </div>
    {!h.locked && <p className="text-xs text-muted-foreground">Tiền thuê ước tính theo ngày hợp đồng có tính tiền. Ngày phòng trống tính 0 ₫. Điện, nước chưa có phiếu dùng mức đã cấu hình hoặc chi phí đã duyệt của tháng trước.</p>}
    {h.rent_needs_review && <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">Tiền thuê có kỳ cần đối chiếu giá hoặc mức hỗ trợ. Doanh thu, lợi nhuận và phần chia của nhà còn tạm tính.</p>}
    {h.unknown_fees.length>0 && <p className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">Chưa tính được chi phí {h.unknown_fees.map(k=>labels.get(k) ?? k).join(", ").toLocaleLowerCase("vi")}. Nhà chưa có mức dự kiến hoặc phiếu chi cho các khoản này.</p>}
  </div>;
}

function total(houses: ForecastHouse[], key: "revenue"|"expense"|"profit"|"share"|"booked_income"|"booked_cost"): number | null {
  let sum = 0;
  for (const h of houses) {
    const amount = h[key];
    if (amount === null) return null;
    sum += amount;
  }
  return sum;
}

function HouseDisclosure({ h, children }: { h: ForecastHouse; children: ReactNode }) {
  const [open,setOpen] = useState(false);
  return <details className="group border-t" onToggle={event=>setOpen(event.currentTarget.open)}>
    {children}{open && <HouseDetail h={h} />}
  </details>;
}

export default function ShareholderForecast() {
  const {selectedOrganizationId: org} = useOrganization();
  return <ForecastPeriod key={org} org={org} />;
}

function ForecastPeriod({ org }: { org: string | null }) {
  const latest = vnTodayISO().slice(0,7);
  const [period,setPeriod] = useState(latest);
  const [subject,setSubject] = useState<string|null>(null);
  const query = useShareholderForecast(org,period,subject);
  // Lỗi sau thu hồi quyền phải ẩn cả kết quả đã cache.
  const data = query.isError ? undefined : query.data;
  const rows = [...(data?.houses ?? [])].sort((a,b)=>b.share-a.share || a.name.localeCompare(b.name,"vi"));
  const locked = rows.filter(r=>r.locked).length;
  const missing = rows.filter(r=>r.unknown_fees.length>0).length;
  const rentReview = rows.filter(r=>r.rent_needs_review).length;
  const allLocked = rows.length>0 && locked===rows.length;
  const shareLabel = data?.own ? "Phần tôi được chia" : "Phần của " + (data?.name ?? "cổ đông");
  const cards = [
    {label:"Doanh thu", value:total(rows,"revenue"), note:"Đã ghi nhận " + fmt(total(rows,"booked_income")), icon:ArrowDownLeft},
    {label:"Chi phí", value:total(rows,"expense"), note:"Đã ghi nhận " + fmt(total(rows,"booked_cost")), icon:ArrowUpRight},
    {label:"Lợi nhuận", value:total(rows,"profit"), note:"Sau chi phí vận hành", icon:ChartNoAxesColumnIncreasing},
    {label:shareLabel, value:total(rows,"share"), note:allLocked?"Theo phân bổ đã chốt":"Ước tính lợi nhuận", icon:Wallet},
  ];
  return <section aria-label="Dự kiến doanh thu và lợi nhuận" className="space-y-4 text-foreground">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-xl font-bold tracking-tight sm:text-2xl">{allLocked?"Doanh thu & lợi nhuận đã chốt":"Dự kiến doanh thu & lợi nhuận"}</h2>
        {data && <p className="text-sm text-muted-foreground">{rows.length} nhà góp vốn · {data.name} · Cập nhật {new Date(data.as_of).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Ho_Chi_Minh"})}</p>}</div>
      <div className="flex flex-wrap gap-2">
        {data && data.choices.length>0 && <label className="grid gap-1 text-xs">Cổ đông<select aria-label="Cổ đông" className={inputClass} value={data.shareholder_id} onChange={e=>setSubject(e.target.value)}>
          {data.choices.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label className="grid gap-1 text-xs">Tháng báo cáo<input aria-label="Tháng báo cáo" type="month" className={inputClass} max={latest} value={period}
          onChange={e=>{const v=e.target.value;if(/^\d{4}-(0[1-9]|1[0-2])$/.test(v) && v<=latest)setPeriod(v);}} /></label>
      </div>
    </header>
    {query.isError ? <div role="alert" className="rounded-lg border p-4 text-sm">Chưa đọc được dự báo trong phạm vi tài khoản và công ty đang chọn.
      <Button className="ml-2" variant="outline" size="sm" onClick={()=>void query.refetch()}>Tải lại</Button>
      {subject && <Button variant="ghost" size="sm" onClick={()=>setSubject(null)}>Về cổ đông mặc định</Button>}</div>
      : <QueryRegion label="dự kiến doanh thu và lợi nhuận" queries={[query]} skeleton="cards" rows={4}>
      {data && (rows.length===0 ? <p className="rounded-lg border p-4">Chưa có nhà góp vốn trong kỳ này.</p> : <>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {cards.map(({label,value,note,icon:Icon},i)=><div key={i} className={"min-w-0 rounded-xl border p-3 sm:p-4 " + (i===3?"border-emerald-900 bg-emerald-900 text-white":"bg-card")}>
            <div className="flex items-center gap-1.5 text-sm font-semibold"><Icon aria-hidden className="h-4 w-4 shrink-0" />{label}</div>
            <p title={fmt(value)} className="my-2 break-words text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl">{value===null?"—":millions.format(value/1e6)} {value!==null && <small className="whitespace-nowrap text-xs font-normal">triệu ₫</small>}</p>
            <p className={"text-xs "+(i===3?"text-emerald-100":"text-muted-foreground")}>{note}</p>
          </div>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground"><span>{locked}/{rows.length} nhà đã chốt kỳ</span>
          {missing>0 && <span className="font-medium text-amber-800 dark:text-amber-300">{missing} nhà còn chi phí chưa có mức ước tính</span>}
          {rentReview>0 && <span className="font-medium text-amber-800 dark:text-amber-300">{rentReview} nhà cần đối chiếu tiền thuê</span>}</div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-1 p-3 sm:p-4"><h3 className="text-lg font-semibold">Chi tiết theo nhà</h3><span className="text-xs text-muted-foreground">Đơn vị: triệu đồng</span></div>
          <div className="forecast-row hidden bg-muted/55 py-2 text-right text-xs font-medium text-muted-foreground md:grid" aria-hidden><span className="text-left">Nhà góp vốn</span><span>Doanh thu</span><span>Chi phí</span><span>Lợi nhuận</span><span>Được chia</span><span /></div>
          <div key={[org,data.shareholder_id,period].join("/")}>{rows.map(h=><HouseDisclosure key={h.id} h={h}>
            <summary className="forecast-row grid cursor-pointer list-none grid-cols-4 items-center gap-y-2 py-3 hover:bg-muted/35 [&::-webkit-details-marker]:hidden">
              <div className="col-span-4 flex items-center gap-2 md:col-span-1"><div className="min-w-0"><b className="break-words">{h.name}</b><div className="text-xs text-muted-foreground">{h.locked?"Đã chốt":h.rent_needs_review?"Cần đối chiếu tiền thuê":h.unknown_fees.length?"Ước tính · thiếu chi phí":"Ước tính"}</div></div>
                {period===latest && <span className="text-[11px] text-muted-foreground" title="Phòng có khách hiện tại">{h.occupied_rooms}/{h.total_rooms} phòng có khách</span>}
                <ChevronDown aria-hidden className="ml-auto h-4 w-4 shrink-0 group-open:rotate-180 md:hidden" /></div>
              {([["Doanh thu",h.revenue],["Chi phí",h.expense],["Lợi nhuận",h.profit],["Được chia",h.share]] as const).map(([label,value],i)=><span key={label} title={fmt(value)} className={"min-w-0 break-words text-sm tabular-nums md:text-right "+(i===3?"font-bold text-emerald-700 dark:text-emerald-300":"")}>
                <span className="block text-[11px] font-normal text-muted-foreground md:sr-only">{label}</span>{value===null?"—":millions.format(value/1e6)}</span>)}
              <ChevronDown aria-hidden className="hidden h-4 w-4 group-open:rotate-180 md:block" />
            </summary></HouseDisclosure>)}</div>
        </div>
      </>)}
    </QueryRegion>}
  </section>;
}
