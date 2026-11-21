import { useSaleRoomNoticeContracts } from '@/hooks/useContractMoveOutNotice';
import { MoveOutNoticeDialog } from '@/components/contracts/MoveOutNoticeDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';


interface Props {
  roomId: string;
  roomLabel: string;
  organizationId: string;
  actorId: string;
  onClose: () => void;
}

export function SaleRoomNoticeDialog({ roomId, roomLabel, organizationId, actorId, onClose }: Props) {
  const contract = useSaleRoomNoticeContracts(organizationId, actorId, roomId);
  if (!contract.isError && contract.data?.length === 1) {
    return <MoveOutNoticeDialog open contract={contract.data[0]} roomLabel={roomLabel} onOpenChange={open => { if (!open) onClose(); }} />;
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>Báo sắp trống</DialogTitle><DialogDescription>{roomLabel}</DialogDescription></DialogHeader>
      {contract.isPending ? <p role="status">Đang tìm hợp đồng đang thuê…</p>
        : contract.isError ? <><p role="alert">Chưa tải được hợp đồng của phòng.</p><Button variant="outline" onClick={() => void contract.refetch()}>Thử tải lại</Button></>
        : <p role="alert">{contract.data?.length ? 'Có nhiều hợp đồng đang ở. Kiểm tra lại hồ sơ phòng trước khi báo trả.' : 'Chưa tìm thấy hợp đồng đang ở trong phạm vi của bạn.'}</p>}
      <Button variant="outline" onClick={onClose}>Đóng</Button>
    </DialogContent>
  </Dialog>;
}
