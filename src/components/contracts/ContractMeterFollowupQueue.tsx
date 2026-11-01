import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useContractMeterFollowups } from '@/hooks/useContractMeterFollowups';
import { ContractQueueSheetRow } from './ContractQueueSheetRow';

// layout "sheet": nằm trong bảng trượt của mobile, tiêu đề do bảng trượt vẽ.
export function ContractMeterFollowupQueue({buildingIds=[],layout='page'}:{buildingIds?:string[];layout?:'page'|'sheet'}){
  const sheet=layout==='sheet';
  const [page,setPage]=useState(0);const {selectedOrganizationId}=useOrganization();
  const scope=[...buildingIds].sort().join(',');const query=useContractMeterFollowups(buildingIds,page);
  useEffect(()=>setPage(0),[scope,selectedOrganizationId]);
  useEffect(()=>{if(page>0&&query.data&&!query.data.items.length)setPage(value=>value-1);},[page,query.data]);
  // Khung này chỉ hiện khi có hồ sơ chờ chỉ số → chờ thì không vẽ gì (chủ chốt 02/10/2026).
  if(query.isLoading)return <LoadingState label="mốc chỉ số còn thiếu" variant={sheet?'table':'none'} rows={3} />;
  if(query.isError)return <p role="alert" className="text-sm">Không tải được hồ sơ chờ chỉ số. <Button variant="link" onClick={()=>void query.refetch()}>Thử lại</Button></p>;
  if(!query.data?.total)return sheet?<p className="p-8 text-center text-sm text-muted-foreground">Không còn hồ sơ chờ chỉ số.</p>:null;
  // Server chỉ trả việc thật (chủ chốt 08/10/2026): đã quyết toán mà chưa có chỉ số chốt (trừ bỏ cọc), hoặc
  // số bổ sung chưa khớp số đã tính tiền. Hồ sơ còn chờ quyết toán không vào khung này. Tên vùng, tiêu đề
  // và nút giữ nguyên vì spec fleet contract-workspace-tabs khẳng định chúng.
  return <section aria-label="Chờ bổ sung chỉ số bàn giao" className={sheet?'cm-qlist':'rounded-lg border p-3'}>
    {!sheet&&<><h2 className="font-semibold">Chờ bổ sung / kiểm tra chỉ số ({query.data.total})</h2>
    <p className="text-xs text-muted-foreground">Hồ sơ đã quyết toán nhưng chưa có chỉ số chốt, hoặc số bổ sung chưa khớp số đã tính tiền.</p></>}
    <div className={sheet?'cm-qrows':'divide-y'}>{query.data.items.map(item=>sheet?<ContractQueueSheetRow key={item.id} contractId={item.contract_id} room={item.room_name} building={item.building_name}
      tag={item.state==='MISSING'?'Thiếu chỉ số chốt':'Số bổ sung chưa khớp'}
      detail={`Bàn giao ${item.effective_on.split('-').reverse().join('/')}`}
      code={item.contract_number||'Hợp đồng cũ'}
      actions={<Button variant="outline" className="cm-qbtn" asChild><Link to={`/contracts/${item.contract_id}`}>Mở mốc bàn giao</Link></Button>} />:<div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" key={item.id}>
      <div><p>{item.building_name} · {item.room_name} · {item.contract_number||'Hợp đồng cũ'}</p>
        <p>{item.effective_on.split('-').reverse().join('/')} · {item.state==='MISSING'?'Đã quyết toán, chưa có chỉ số chốt':'Số bổ sung chưa khớp số đã tính tiền, cần đối soát'}</p></div>
      <Button size="sm" variant="outline" asChild><Link to={`/contracts/${item.contract_id}`}>Mở mốc bàn giao</Link></Button>
    </div>)}</div>
    {query.data.total>10&&<div className="flex items-center justify-end gap-2 text-sm">
      <Button size="sm" variant="ghost" disabled={!page} onClick={()=>setPage(value=>value-1)}>Trước</Button>
      <span>{page+1}/{Math.ceil(query.data.total/10)}</span>
      <Button size="sm" variant="ghost" disabled={(page+1)*10>=query.data.total} onClick={()=>setPage(value=>value+1)}>Sau</Button>
    </div>}
  </section>;
}
