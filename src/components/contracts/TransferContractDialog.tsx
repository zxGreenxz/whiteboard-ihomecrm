import { Link } from 'react-router-dom';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ContractWithRelations } from '@/types/contract';

interface TransferContractDialogProps {
  open:boolean;onOpenChange:(open:boolean)=>void;contract:ContractWithRelations;onStartReturn:()=>void;
}
/** Assignment starts a separate new contract, preserving the old customer's history. */
export function TransferContractDialog({open,onOpenChange,contract,onStartReturn}:TransferContractDialogProps){
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Nhượng hợp đồng</DialogTitle>
      <DialogDescription>Hợp đồng cũ và hợp đồng khách mới có liên kết để đối soát.</DialogDescription></DialogHeader>
    <ol className="list-decimal space-y-3 pl-5 text-sm">
      <li>Khi khách cũ đã bàn giao: ghi ngày trả, chọn loại thanh lý và chọn <strong>Trả phòng, quyết toán sau</strong>.</li>
      <li>Soạn nháp cho khách mới cùng phòng. Trong hồ sơ cũ hoặc nháp mới, chọn <strong>Liên kết nhượng</strong>, ghi tự tìm khách hay qua môi giới và hạn hợp đồng.</li>
      <li>Quyết toán hợp đồng cũ và ký hợp đồng mới theo cách hiện tại. Với môi giới, phí nhượng là 50% cọc cũ; khách mới đóng đủ cọc mới.</li>
    </ol>
    <p className="text-xs text-muted-foreground">Khách chưa dọn đi thì báo ngày dự kiến trả và chuẩn bị nháp trước; chỉ xác nhận trả khi đã bàn giao thực tế.</p>
    <DialogFooter>
      <Button variant="outline" onClick={()=>onOpenChange(false)}>Đóng</Button>
      {contract.status==='TERMINATED'?<Button asChild><Link to={'/contracts/'+contract.id} onClick={()=>onOpenChange(false)}>Mở hồ sơ cũ</Link></Button>:
      <Button onClick={()=>{onOpenChange(false);onStartReturn();}}>Ghi nhận khách đã trả phòng</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}
