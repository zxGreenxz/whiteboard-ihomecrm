import { useState } from "react";
import { CalendarClock, ChevronDown, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHermesShiftPlan } from "@/hooks/useHermesShiftPlan";
import { useCreateJob } from "@/hooks/useJobs";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useOrganization } from "@/contexts/OrganizationContext";

function clock(minute:number){
  const n=Math.max(0,Math.round(minute));
  const time=String(Math.floor(n/60)%24).padStart(2,"0")+":"+String(n%60).padStart(2,"0");
  return n>=1440?time+" (hôm sau)":time;
}
export default function HermesShiftCard({staff}:{staff:string}){
  const {selectedOrganizationId}=useOrganization();
  return <ShiftCard key={String(selectedOrganizationId)+staff} staff={staff}/>;
}
function ShiftCard({staff}:{staff:string}){
  const plan=useHermesShiftPlan(staff);
  const job=useCreateJob({silent:true});
  const {data:perms}=useMyPermissions();
  const [ask,setAsk]=useState(false),[adding,setAdding]=useState(false),[all,setAll]=useState(false);
  const [building,setBuilding]=useState(""),[title,setTitle]=useState(""),[saving,setSaving]=useState(false);
  const [notice,setNotice]=useState(""),[draftId,setDraftId]=useState("");
  const data=plan.data;
  if(plan.isError)return <div role="alert" className="mb-3 rounded-xl border bg-white p-3 text-sm">Chưa tải được lịch Hermes. <button className="underline" onClick={()=>void plan.refetch()}>Tải lại</button></div>;
  if(plan.isLoading)return <p role="status" className="p-3 text-sm">Đang tải lịch đầu ca…</p>;
  if(!data)return null;
  const next=data.stops[0];
  const visible=all?data.stops:data.stops.slice(0,3);
  const chosen=building||data.buildings[0]?.id;
  async function save(){
    if(!title.trim()||!chosen||!draftId||saving)return;
    setSaving(true);
    try{
      await job.mutateAsync({id:draftId,title:title.trim(),building_id:chosen,assignee_id:staff,priority:"URGENT",status:"IN_PROGRESS",visible_to_customer:false,exclude_from_salary:true});
      setAdding(false);setTitle("");setAll(true);
      setNotice("Đã lưu việc gấp vào CRM TEST. Lịch sẽ tự cập nhật.");
      void plan.refetch();
    }catch{setNotice("Chưa xác nhận được việc mới. Kiểm tra danh sách công việc trước khi thử lại.");}
    finally{setSaving(false);}
  }
  return <section aria-label="Lịch đầu ca Hermes" className="mb-3 space-y-3 rounded-2xl border border-emerald-200 bg-white p-4">
    <div className="flex items-center gap-2"><CalendarClock size={19} className="text-emerald-700"/><h2 className="font-semibold">Lịch đầu ca Hermes</h2><span className="ml-auto text-xs text-muted-foreground">{data.date.split("-").reverse().join("/")}</span></div>
    {!data.ready?<p role="status" className="text-sm">Máy chủ đang chuẩn bị lịch cho ca này.</p>:<>
      <p className="text-xs text-muted-foreground">Bản {data.revision} · {data.reason==="job"?"Tự xếp lại khi công việc thay đổi":data.reason==="inspection"?"Đã cập nhật lượt kiểm":"Máy chủ xếp trước ca"} · {data.updated&&new Date(data.updated).toLocaleTimeString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh",hour:"2-digit",minute:"2-digit"})}</p>
      {data.updating&&<p role="status" className="text-xs text-amber-800">Có dữ liệu mới. Máy chủ đang xếp lại phần còn lại của ca.</p>}
      {data.off&&<p className="text-sm">Hôm nay là ngày nghỉ. Việc khẩn đang mở vẫn hiện bên dưới.</p>}
      {next?<ol className="space-y-2">{visible.map((s,i)=><li key={(s.building??s.label)+i} className={i===0?"rounded-xl bg-emerald-50 p-3":"border-t px-3 pt-2"}>
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm"><strong>{i===0?"Đi tiếp":"Chặng "+(i+1)} · {s.label}</strong><span className="ml-auto tabular-nums">{clock(s.start)}–{clock(s.end)}</span></div>
        <div className="mt-1 text-xs font-medium">{[s.active?"Đang kiểm":null,s.urgent?"Việc gấp":null,s.full?(s.daysLeft===null?"FULL lần đầu":s.daysLeft<0?"FULL trễ "+(-s.daysLeft)+" ngày":s.daysLeft===0?"Phải FULL hôm nay":"FULL theo lịch"):null,s.late?"Nguy cơ trễ • cần điều phối":null].filter(Boolean).join(" · ")}</div>
        {s.tasks.map((task,j)=><p key={j} className="mt-0.5 break-words text-sm">{task}</p>)}
      </li>)}</ol>:<p className="text-sm">Chưa có điểm đến cần xử lý trong phạm vi của bạn.</p>}
      {data.stops.length>3&&<button aria-expanded={all} onClick={()=>setAll(!all)} className="flex items-center gap-1 text-sm underline"><ChevronDown size={15}/>{all?"Thu gọn":"Xem cả "+data.stops.length+" chặng"}</button>}
      <p className="text-xs text-muted-foreground">Giờ dự kiến theo tuyến xe máy và thời lượng ước tính. {data.state==="checked"?"GPT-6.2 Astra · Extra High đã gửi phương án để máy chủ đối chiếu.":data.state==="pending"?"Máy chủ đã xếp lịch. Đang chờ Astra đối chiếu.":data.state==="empty"?"":"Đang dùng lịch do bộ tối ưu tính. Chưa xác nhận phương án từ Astra."}</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={!data.ready} aria-expanded={ask} onClick={()=>setAsk(!ask)}><Route size={15}/>Hỏi nhanh Hermes</Button>
      {canUse(perms,"tasks","create")&&data.buildings.length>0&&<Button variant="outline" size="sm" aria-expanded={adding} onClick={()=>{setAdding(!adding);if(!adding)setDraftId(crypto.randomUUID());}}>Thêm việc đột xuất</Button>}
    </div>
    {ask&&<p className="rounded-lg bg-slate-50 p-3 text-sm" role="status">{next?"Đi "+next.label+" trước. "+(next.active?"Tiếp tục phiên kiểm đang mở.":next.urgent?"Có việc gấp được giao tại đây.":next.full?"Đây là lượt FULL cần thực hiện trên tuyến hôm nay.":"Có việc đang mở tại tòa.")+" Dự kiến hoàn tất "+clock(next.end)+".":"Hiện chưa có điểm đến trên tuyến."}</p>}
    {adding&&<form className="space-y-2 border-t pt-3" onSubmit={e=>{e.preventDefault();void save();}}>
      <label className="block text-sm">Tòa có việc đột xuất<select required className="mt-1 block w-full rounded-md border p-2" value={chosen??""} onChange={e=>setBuilding(e.target.value)}>{data.buildings.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label className="block text-sm">Nội dung việc gấp<Input required maxLength={250} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Ví dụ: xử lý rò nước"/></label>
      <Button type="submit" size="sm" disabled={saving||!title.trim()||!chosen}>{saving?"Đang lưu…":"Lưu việc gấp"}</Button>
    </form>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
  </section>;
}
