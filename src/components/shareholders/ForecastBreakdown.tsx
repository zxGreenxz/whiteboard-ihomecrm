import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ForecastEntry, ForecastHouse } from "@/hooks/useShareholderForecast";
import { FEE_KINDS } from "@/hooks/useFeeConfigMatrix";
import { rowCategoryAmounts, type InvoiceAmountParts } from "@/lib/invoiceAmountParts";
import { compareRoomNames } from "@/lib/roomSort";
import { formatCurrency } from "@/lib/utils";
import { formatISODateVN } from "@/lib/vnDate";

type Bucket = ForecastEntry["bucket"];
const sections: Record<"income" | "expense", { key: Bucket; label: string }[]> = {
  income: [
    { key: "booked_income", label: "Đã ghi nhận" }, { key: "pending_income", label: "Phiếu chờ duyệt" },
    { key: "unpaid", label: "Hóa đơn còn phải thu" }, { key: "unbilled", label: "Tiền thuê chưa lập hóa đơn" },
  ],
  expense: [
    { key: "booked_cost", label: "Đã ghi nhận" }, { key: "pending_cost", label: "Phiếu chờ duyệt" },
    { key: "fixed_cost", label: "Chi phí cố định dự kiến bổ sung" }, { key: "utility_cost", label: "Điện, nước dự kiến bổ sung" },
  ],
};
const fees = new Map<string,string>(FEE_KINDS.map(f => [f.key, f.label]));
interface Source { row: ForecastEntry; amount: number }
interface Category { name: string; amount: number; sources: Source[] }

function categories(rows: ForecastEntry[]): Category[] {
  const result = new Map<string,Category>();
  const parts = new Map<string,InvoiceAmountParts>();
  rows.forEach((row,i) => {
    const key = String(i);
    if (row.parts) parts.set(key,row.parts);
    const fee = row.bucket === "fixed_cost" || row.bucket === "utility_cost";
    let name = fee ? fees.get(row.label) ?? row.label : row.label;
    if (row.bucket === "unpaid" || row.bucket === "unbilled") name = row.room ? "Phòng " + row.room : name;
    for (const slice of rowCategoryAmounts({key, name, amount:row.amount},parts)) {
      const group = result.get(slice.name) ?? {name:slice.name, amount:0, sources:[]};
      group.amount += slice.amount;
      if (row.code || row.room || row.description || row.day) group.sources.push({row, amount:slice.amount});
      result.set(slice.name,group);
    }
  });
  return [...result.values()].sort((a,b)=>Math.abs(b.amount)-Math.abs(a.amount) || compareRoomNames(a.name,b.name));
}

function CategoryRow({ category }: { category: Category }) {
  const [open,setOpen] = useState(false);
  const id = useId();
  const sources = category.sources;
  const content = <><span className="flex min-w-0 items-center gap-1">
    {sources.length>0 && <ChevronDown aria-hidden className={"h-3.5 w-3.5 shrink-0 text-muted-foreground " + (open?"rotate-180":"")} />}
    <span className="break-words">{category.name}</span></span><span className="shrink-0 tabular-nums">{formatCurrency(category.amount)}</span></>;
  const style = "flex w-full items-baseline justify-between gap-2 py-1.5 text-left text-sm";
  return <li className="border-b border-border/50 last:border-0">
    {sources.length ? <button type="button" className={style+" hover:bg-muted/60"} aria-expanded={open} aria-controls={id}
      onClick={()=>setOpen(!open)}>{content}</button> : <div className={style}>{content}</div>}
    {open && <ul id={id} className="mb-1 space-y-1.5 border-l-2 pl-3 text-xs text-muted-foreground">{sources.map(({row,amount},i)=>
      <li key={i} className="flex justify-between gap-2"><span className="min-w-0 break-words">
        {[row.room && "Phòng " + row.room, row.code, row.day && formatISODateVN(row.day),row.description].filter(Boolean).join(" · ")}
      </span><span className="shrink-0 tabular-nums">{formatCurrency(amount)}</span></li>)}</ul>}
  </li>;
}

export function ForecastBreakdown({ house,side }: { house: ForecastHouse; side: "income"|"expense" }) {
  const title = side==="income" ? "Doanh thu" : "Chi phí vận hành";
  const total = side==="income" ? house.revenue : house.expense;
  const lines = house.detail_lines;
  return <section aria-label={title+" theo hạng mục"} className="min-w-0 self-start overflow-hidden rounded-lg border bg-background">
    <div className={"flex flex-wrap items-center justify-between gap-x-2 border-b px-3 py-2 "+(side==="income"
      ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100"
      : "bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100")}>
      <h4 className="font-semibold">{title}</h4><strong className="text-base tabular-nums">{total===null?"Chưa có số":formatCurrency(total)}</strong>
    </div>
    {lines===null ? <p className="p-3 text-sm text-muted-foreground">Kỳ đã chốt chỉ có số tổng để đối chiếu.</p> :
      <div className="divide-y">{sections[side].map(({key,label})=>{
        const amount = house[key];
        const groups = categories(lines.filter(row=>row.bucket===key));
        if (!groups.length && (amount===0 || amount===null)) return null;
        return <div key={key} className="px-3 py-2"><div className="flex justify-between gap-2 text-xs font-semibold text-muted-foreground">
          <h5>{house.locked ? "Đã chốt theo hạng mục" : label}</h5><span className="shrink-0 tabular-nums">{amount===null?"—":formatCurrency(amount)}</span></div>
          <ul className="mt-1">{groups.map(g=><CategoryRow category={g} key={g.name} />)}</ul></div>;
      })}{!lines.some(row=>sections[side].some(s=>s.key===row.bucket)) &&
        <p className="p-3 text-sm text-muted-foreground">Kỳ này chưa có khoản {side==="income"?"thu":"chi"}.</p>}</div>}
  </section>;
}
