import { useEffect,useRef,useState,type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useRoomTurnover,useSaveRoomTurnover } from '@/hooks/rooms/useRoomTurnover';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { useStaffUsers } from '@/hooks/useStaffUsers';
import { canUse } from '@/lib/permissionPages';
import { classifyDbError } from '@/lib/contracts/errors';
import {
  roomTurnoverFormSchema,turnoverErrorMessage,turnoverReadiness,
  type RoomTurnoverFormData,type RoomTurnoverSnapshot,
} from '@/lib/contract-lifecycle/turnover';
import { Button } from '@/components/ui/button';
import { LoadingState,SkeletonBar } from '@/components/loading/LoadingState';
import { DateInput } from '@/components/ui/date-input';
import { Textarea } from '@/components/ui/textarea';
import { Form,FormControl,FormField,FormItem,FormLabel,FormMessage } from '@/components/ui/form';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';

export interface RoomTurnoverPanelProps {roomId:string;sourceContractId?:string|null;canEdit?:boolean;}

function TurnoverHistory({history}:{history:RoomTurnoverSnapshot['history']}) {
  const staff=useStaffUsers();
  // Tên nhân viên chưa về: vạch xám ngay trong ô tên (không in tạm mã người dùng) — chủ chốt 02/10/2026.
  const userName=(id:string|null):ReactNode=>id?(staff.isPending
    ?<span className="ld-appear inline-flex align-middle" aria-hidden="true"><SkeletonBar className="inline-block" style={{width:'6rem'}} /></span>
    :(staff.data?.find(user=>user.id===id)?.full_name||id)):'Chưa phân công';
  const dateLabel=(date:string|null)=>date?date.split('-').reverse().join('/'):'Chưa hẹn';
  return <details className="text-sm"><summary className="cursor-pointer font-medium">Lịch sử dọn/sửa (20 thay đổi gần nhất)</summary>
    {staff.isPending&&<LoadingState label="tên người thay đổi" variant="none" />}
    {staff.isError&&<p role="alert" className="mt-2">Chưa tải được tên nhân viên. Mã người thay đổi vẫn được giữ để đối soát.</p>}
    <ol className="mt-2 space-y-2">{history.map(event=><li key={event.id} className="rounded border p-2">
      <p>Đợt {event.epoch} · {new Date(event.created_at).toLocaleString('vi-VN')}</p>
      <p title={event.actor_id}>Người thay đổi: {userName(event.actor_id)}</p>
      <p>{event.previous_state?.status==='READY'?'Sẵn sàng':event.previous_state?'Đang dọn/sửa':'Mới tạo'} → {event.new_state.status==='READY'?'Sẵn sàng':'Đang dọn/sửa'}</p>
      <p>Ngày dự kiến xong: {event.previous_state?`${dateLabel(event.previous_state.expected_ready_on)} → `:''}{dateLabel(event.new_state.expected_ready_on)}</p>
      <p>Người phụ trách: {event.previous_state?<>{userName(event.previous_state.responsible_user_id)} → </>:null}{userName(event.new_state.responsible_user_id)}</p>
      <p>{event.reason}</p>
    </li>)}</ol>
  </details>;
}

function TurnoverEditor({roomId,sourceContractId,snapshot,startNewCycle,onClose,onReload}:{
  roomId:string;sourceContractId:string|null;snapshot:RoomTurnoverSnapshot;startNewCycle:boolean;onClose:()=>void;onReload:()=>void;
}) {
  const save=useSaveRoomTurnover();
  const staff=useStaffUsers();
  const [error,setError]=useState<unknown>(null);
  const state=startNewCycle?null:snapshot.turnover;
  const form=useForm<RoomTurnoverFormData>({
    resolver:zodResolver(roomTurnoverFormSchema),
    defaultValues:{status:state?.status??'PENDING',expectedReadyOn:state?.expected_ready_on??'',responsibleUserId:state?.responsible_user_id??'',reason:''},
  });
  const stale=classifyDbError(error)==='conflict';
  const onSubmit=async(data:RoomTurnoverFormData)=>{
    setError(null);
    try{
      await save.mutateAsync({roomId,expectedVersion:snapshot.turnover?.version??0,status:data.status,
        expectedReadyOn:data.expectedReadyOn||null,responsibleUserId:data.responsibleUserId||null,
        sourceContractId:state?state.source_contract_id:sourceContractId,reason:data.reason,startNewCycle});
      onClose();
    }catch(saveError){setError(saveError);}
  };
  const selectedUser=state?.responsible_user_id;
  return <Form {...form}><form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 rounded-md border bg-background p-3">
    <p className="text-sm font-medium">{startNewCycle?'Đợt dọn/sửa mới':'Cập nhật theo dõi dọn/sửa'}</p>
    <FormField control={form.control} name="status" render={({field})=><FormItem><FormLabel>Tình trạng</FormLabel><Select onValueChange={field.onChange} value={field.value} disabled={save.isPending||stale}>
      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="PENDING">Đang dọn/sửa</SelectItem><SelectItem value="READY">Đã sẵn sàng nhận khách</SelectItem></SelectContent>
    </Select><FormMessage /></FormItem>} />
    <FormField control={form.control} name="expectedReadyOn" render={({field})=><FormItem><FormLabel>Ngày dự kiến xong (có thể để trống)</FormLabel><FormControl>
      <DateInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} disabled={save.isPending||stale} />
    </FormControl><FormMessage /></FormItem>} />
    <FormField control={form.control} name="responsibleUserId" render={({field})=><FormItem><FormLabel>Người phụ trách (tùy chọn)</FormLabel><Select value={field.value||'UNASSIGNED'} onValueChange={value=>field.onChange(value==='UNASSIGNED'?'':value)} disabled={save.isPending||stale||staff.isPending}>
      <FormControl><SelectTrigger><SelectValue placeholder="Chưa phân công" /></SelectTrigger></FormControl><SelectContent>
        <SelectItem value="UNASSIGNED">Chưa phân công</SelectItem>
        {selectedUser&&!staff.data?.some(user=>user.id===selectedUser)&&<SelectItem value={selectedUser}>Người phụ trách đã phân công</SelectItem>}
        {(staff.data??[]).map(user=><SelectItem key={user.id} value={user.id}>{user.full_name||'Nhân viên'}</SelectItem>)}
      </SelectContent></Select><FormMessage />{staff.isError&&<p role="alert" className="text-xs text-destructive">Chưa tải được người phụ trách. Có thể lưu việc chưa phân công.</p>}</FormItem>} />
    <FormField control={form.control} name="reason" render={({field})=><FormItem><FormLabel>Lý do / ghi chú</FormLabel><FormControl>
      <Textarea {...field} rows={2} placeholder="Dọn sau trả phòng, đổi ngày, đã kiểm tra xong..." disabled={save.isPending||stale} />
    </FormControl><FormMessage /></FormItem>} />
    {!!error&&<p role="alert" className="text-sm text-destructive">{turnoverErrorMessage(error)}</p>}
    <div className="flex flex-wrap gap-2">
      {stale&&<Button type="button" variant="outline" onClick={onReload}>Tải lại việc dọn/sửa</Button>}
      <Button type="submit" disabled={save.isPending||stale}>{save.isPending&&<Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu theo dõi</Button>
      <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>Đóng</Button>
    </div>
  </form></Form>;
}

export function RoomTurnoverPanel({roomId,sourceContractId=null,canEdit}:RoomTurnoverPanelProps) {
  const query=useRoomTurnover(roomId);
  const {data:permissions}=useMyPermissions();
  const allowed=canEdit??canUse(permissions,'rooms','edit');
  const [editor,setEditor]=useState<{roomId:string;snapshot:RoomTurnoverSnapshot;startNewCycle:boolean}|null>(null);
  const [opening,setOpening]=useState(false);
  const [error,setError]=useState<unknown>(null);
  const sequence=useRef(0);
  useEffect(()=>{
    const current=++sequence.current;setEditor(null);setError(null);setOpening(false);
    return ()=>{sequence.current=current+1;};
  },[roomId]);
  const openEditor=async(startNewCycle=false)=>{
    const request=++sequence.current;setOpening(true);setError(null);setEditor(null);
    try{
      const fresh=await query.refetch();
      if(fresh.error) throw fresh.error;
      if(!fresh.data) throw new Error('Không tải được dữ liệu phòng');
      if(request===sequence.current) setEditor({roomId,snapshot:fresh.data,startNewCycle});
    }catch(readError){if(request===sequence.current) setError(readError);}
    finally{if(request===sequence.current) setOpening(false);}
  };
  // Lúc chờ: khung mục (tiêu đề) hiện ngay, nội dung là khối xám (chủ chốt 02/10/2026).
  if(query.isPending) return <section aria-label="Theo dõi dọn/sửa phòng" className="space-y-3 rounded-lg border p-4">
    <h3 className="font-semibold">Theo dõi dọn/sửa</h3>
    <LoadingState label="theo dõi dọn/sửa" rows={2} onRetry={()=>void query.refetch()} />
  </section>;
  if(query.isError||!query.data) return <div role="alert" className="text-sm text-destructive">Chưa tải được theo dõi dọn/sửa. <Button variant="link" onClick={()=>void query.refetch()}>Thử tải lại</Button></div>;
  const snapshot=query.data;
  const readiness=turnoverReadiness(snapshot.turnover,snapshot.today);
  return <section aria-label="Theo dõi dọn/sửa phòng" className="space-y-3 rounded-lg border p-4">
    <h3 className="font-semibold">Theo dõi dọn/sửa</h3>
    <p className="text-sm text-muted-foreground">Theo dõi chuẩn bị phòng và ngày dự kiến nhận khách.</p>
    {snapshot.turnover?<div className="space-y-1 text-sm">
      <p className="font-medium">{readiness.kind==='ready'?'Đã sẵn sàng nhận khách':readiness.kind==='planned'?`Đang dọn/sửa · dự kiến xong ${snapshot.turnover.expected_ready_on?.split('-').reverse().join('/')}`:'Đang dọn/sửa · Cần xác nhận ngày nhận'}</p>
      {snapshot.turnover.expected_ready_on&&readiness.kind==='confirm-date'&&<p>Ngày dự kiến cũ: {snapshot.turnover.expected_ready_on.split('-').reverse().join('/')}. Vui lòng cập nhật lại.</p>}
      <p>{snapshot.turnover.responsible_user_id?'Đã phân công người phụ trách':'Chưa phân công người phụ trách'}</p>
      <p>Ghi chú: {snapshot.turnover.reason}</p>
    </div>:<p className="text-sm">Chưa có việc dọn/sửa được ghi nhận.</p>}
    {allowed&&<div className="flex flex-wrap gap-2">
      {(snapshot.turnover||snapshot.can_start_new_cycle)&&<Button type="button" size="sm" variant="outline" disabled={opening} onClick={()=>void openEditor()}>{snapshot.turnover?'Cập nhật dọn/sửa':'Theo dõi dọn/sửa'}</Button>}
      {snapshot.turnover?.status==='READY'&&snapshot.can_start_new_cycle&&<Button type="button" size="sm" variant="outline" disabled={opening} onClick={()=>void openEditor(true)}>Bắt đầu đợt dọn/sửa mới</Button>}
    </div>}
    {/* Đọc bản mới trước khi mở form: chỗ form là khối xám, nút mở vẫn khoá theo `opening`. */}
    {opening&&<LoadingState label="dữ liệu mới để cập nhật" variant="detail" rows={4} />}
    {!!error&&<p role="alert" className="text-sm text-destructive">{turnoverErrorMessage(error)}</p>}
    {editor?.roomId===roomId&&<TurnoverEditor key={`${roomId}:${editor.snapshot.turnover?.version??0}:${editor.startNewCycle}`} roomId={roomId} sourceContractId={sourceContractId} snapshot={editor.snapshot} startNewCycle={editor.startNewCycle} onClose={()=>setEditor(null)} onReload={()=>void openEditor(editor.startNewCycle)} />}
    {snapshot.history.length>0&&<TurnoverHistory history={snapshot.history} />}
  </section>;
}
