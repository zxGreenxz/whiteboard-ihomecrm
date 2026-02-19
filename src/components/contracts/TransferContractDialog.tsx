import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTransferContract } from '@/hooks/useContracts';
import { useTenantsLegacy } from '@/hooks/useTenants';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { ArrowRightLeft } from 'lucide-react';
import type { ContractWithRelations } from '@/hooks/useContracts';

interface TransferContractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations | null;
}

const transferSchema = z.object({
  transfer_type: z.enum(['TENANT_CHANGE', 'ROOM_CHANGE', 'BOTH_CHANGE']),
  new_tenant_id: z.string().optional(),
  new_room_id: z.string().optional(),
  new_bed_id: z.string().optional(),
  new_rent_price: z.number().min(0).optional(),
  transfer_fee: z.number().min(0).optional(),
  reason: z.string().optional(),
});

type TransferFormData = z.infer<typeof transferSchema>;

const TransferContractDialog = ({ open, onOpenChange, contract }: TransferContractDialogProps) => {
  const [transferType, setTransferType] = useState<'TENANT_CHANGE' | 'ROOM_CHANGE' | 'BOTH_CHANGE'>('ROOM_CHANGE');
  const transferMutation = useTransferContract();

  const { data: tenants } = useTenantsLegacy();
  const { data: rooms } = useRooms();
  const { data: beds } = useBeds();

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<TransferFormData>({
    resolver: zodResolver(transferSchema),
    defaultValues: {
      transfer_type: 'ROOM_CHANGE',
      transfer_fee: 0,
    },
  });

  const watchedNewRoomId = watch('new_room_id');
  const watchedNewBedId = watch('new_bed_id');

  const handleClose = () => {
    reset();
    setTransferType('ROOM_CHANGE');
    onOpenChange(false);
  };

  const onSubmit = (data: TransferFormData) => {
    if (!contract) return;

    transferMutation.mutate(
      {
        contract_id: contract.id,
        transfer_type: data.transfer_type,
        new_tenant_id: data.new_tenant_id,
        new_room_id: data.new_room_id,
        new_bed_id: data.new_bed_id,
        new_rent_price: data.new_rent_price,
        transfer_fee: data.transfer_fee,
        reason: data.reason,
      },
      {
        onSuccess: () => {
          handleClose();
        },
      }
    );
  };

  if (!contract) return null;

  const selectedNewRoom = rooms?.find(r => r.id === watchedNewRoomId);
  const selectedNewBed = beds?.find(b => b.id === watchedNewBedId);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Chuyển phòng / Nhượng hợp đồng
          </DialogTitle>
          <DialogDescription>
            Hợp đồng: {contract.contract_number || contract.id.slice(0, 8)}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Current Contract Info */}
          <div className="bg-gray-50 p-4 rounded-md space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Khách hiện tại:</span>
              <span className="font-medium">{contract.tenant?.full_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Phòng/Giường hiện tại:</span>
              <span className="font-medium">
                {contract.room ? `${contract.room.building?.name} - ${contract.room.name}` : ''}
                {contract.bed ? `${contract.bed.room?.building?.name} - ${contract.bed.room?.name} - ${contract.bed.name}` : ''}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Giá thuê hiện tại:</span>
              <span className="font-medium">
                {contract.rent_price.toLocaleString('vi-VN')} VND/tháng
              </span>
            </div>
          </div>

          {/* Transfer Type */}
          <div className="space-y-2">
            <Label>Loại chuyển đổi *</Label>
            <Select
              value={transferType}
              onValueChange={(value: typeof transferType) => {
                setTransferType(value);
                setValue('transfer_type', value);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ROOM_CHANGE">Chuyển phòng (cùng khách)</SelectItem>
                <SelectItem value="TENANT_CHANGE">Nhượng hợp đồng (cùng phòng)</SelectItem>
                <SelectItem value="BOTH_CHANGE">Cả hai (khách mới + phòng mới)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* New Tenant (for TENANT_CHANGE or BOTH_CHANGE) */}
          {(transferType === 'TENANT_CHANGE' || transferType === 'BOTH_CHANGE') && (
            <div className="space-y-2">
              <Label>Khách thuê mới *</Label>
              <Select
                onValueChange={(value) => setValue('new_tenant_id', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn khách thuê mới..." />
                </SelectTrigger>
                <SelectContent>
                  {tenants?.filter(t => t.id !== contract.tenant_id).map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id}>
                      {tenant.full_name} - {tenant.phone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.new_tenant_id && (
                <p className="text-sm text-red-500">{errors.new_tenant_id.message}</p>
              )}
            </div>
          )}

          {/* New Room/Bed (for ROOM_CHANGE or BOTH_CHANGE) */}
          {(transferType === 'ROOM_CHANGE' || transferType === 'BOTH_CHANGE') && (
            <>
              {contract.room && (
                <div className="space-y-2">
                  <Label>Phòng mới *</Label>
                  <Select
                    onValueChange={(value) => {
                      setValue('new_room_id', value);
                      // Auto-fill new rent price
                      const room = rooms?.find(r => r.id === value);
                      if (room?.rent_price) {
                        setValue('new_rent_price', room.rent_price);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn phòng trống..." />
                    </SelectTrigger>
                    <SelectContent>
                      {rooms?.map((room) => (
                        <SelectItem key={room.id} value={room.id}>
                          {room.building?.name} - {room.name} ({room.rent_price?.toLocaleString('vi-VN')} VND/tháng)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {contract.bed && (
                <div className="space-y-2">
                  <Label>Giường mới *</Label>
                  <Select
                    onValueChange={(value) => {
                      setValue('new_bed_id', value);
                      // Auto-fill new rent price
                      const bed = beds?.find(b => b.id === value);
                      if (bed?.rent_price) {
                        setValue('new_rent_price', bed.rent_price);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn giường trống..." />
                    </SelectTrigger>
                    <SelectContent>
                      {beds?.map((bed) => (
                        <SelectItem key={bed.id} value={bed.id}>
                          {bed.room?.building?.name} - {bed.room?.name} - {bed.name} ({bed.rent_price?.toLocaleString('vi-VN')} VND/tháng)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {(selectedNewRoom || selectedNewBed) && (
                <div className="bg-blue-50 border border-blue-200 p-4 rounded-md">
                  <p className="text-sm font-medium text-blue-900">
                    Phòng/Giường mới: {selectedNewRoom?.name || selectedNewBed?.name}
                  </p>
                  <p className="text-xs text-blue-700 mt-1">
                    Giá thuê mới: {(selectedNewRoom?.rent_price || selectedNewBed?.rent_price)?.toLocaleString('vi-VN')} VND/tháng
                  </p>
                </div>
              )}
            </>
          )}

          {/* New Rent Price (Optional Override) */}
          <div className="space-y-2">
            <Label htmlFor="new_rent_price">Giá thuê mới (VND/tháng)</Label>
            <Input
              id="new_rent_price"
              type="number"
              {...register('new_rent_price', { valueAsNumber: true })}
              placeholder="Để trống nếu giữ giá tự động"
            />
            <p className="text-xs text-gray-500">
              Hệ thống tự động lấy giá từ phòng/giường mới
            </p>
          </div>

          {/* Transfer Fee */}
          {transferType === 'TENANT_CHANGE' && (
            <div className="space-y-2">
              <Label htmlFor="transfer_fee">Phí nhượng hợp đồng (VND)</Label>
              <Input
                id="transfer_fee"
                type="number"
                {...register('transfer_fee', { valueAsNumber: true })}
                placeholder="0"
              />
              <p className="text-xs text-gray-500">
                Phí mà khách mới phải trả (nếu có)
              </p>
            </div>
          )}

          {/* Reason */}
          <div className="space-y-2">
            <Label htmlFor="reason">Lý do chuyển đổi</Label>
            <Textarea
              id="reason"
              {...register('reason')}
              placeholder="Lý do chuyển phòng/nhượng hợp đồng..."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              disabled={transferMutation.isPending}
            >
              {transferMutation.isPending ? 'Đang xử lý...' : 'Tạo yêu cầu chuyển đổi'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default TransferContractDialog;
