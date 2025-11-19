import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateDeposit, type CreateDepositData } from '@/hooks/useDeposits';
import { useTenants } from '@/hooks/useTenants';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { format } from 'date-fns';

// =============================================
// Validation Schema
// =============================================

const depositSchema = z.object({
  tenant_id: z.string().min(1, 'Vui lòng chọn khách hàng'),
  building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
  room_id: z.string().optional(),
  bed_id: z.string().optional(),
  amount: z.string().min(1, 'Vui lòng nhập số tiền'),
  deposit_date: z.string().min(1, 'Vui lòng chọn ngày đặt cọc'),
  hold_until: z.string().optional(),
  notes: z.string().optional(),
});

type DepositFormData = z.infer<typeof depositSchema>;

// =============================================
// Component
// =============================================

interface CreateDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CreateDepositDialog({ open, onOpenChange }: CreateDepositDialogProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [selectedRoomId, setSelectedRoomId] = useState('');

  // Hooks
  const createDeposit = useCreateDeposit();
  const { data: tenants = [] } = useTenants();
  const { data: buildings = [] } = useBuildings();
  const { data: allRooms = [] } = useRooms();
  const { data: allBeds = [] } = useBeds();

  // Filter rooms and beds
  const rooms = selectedBuildingId
    ? allRooms.filter((room) => room.building_id === selectedBuildingId && room.status === 'AVAILABLE')
    : [];
  const beds = selectedRoomId
    ? allBeds.filter((bed) => bed.room_id === selectedRoomId && bed.status === 'AVAILABLE')
    : [];

  // Form
  const form = useForm<DepositFormData>({
    resolver: zodResolver(depositSchema),
    defaultValues: {
      tenant_id: '',
      building_id: '',
      room_id: '',
      bed_id: '',
      amount: '',
      deposit_date: format(new Date(), 'yyyy-MM-dd'),
      hold_until: '',
      notes: '',
    },
  });

  // =============================================
  // Handlers
  // =============================================

  const onSubmit = async (data: DepositFormData) => {
    const depositData: CreateDepositData = {
      tenant_id: data.tenant_id,
      room_id: data.room_id || undefined,
      bed_id: data.bed_id || undefined,
      amount: parseFloat(data.amount),
      deposit_date: data.deposit_date,
      hold_until: data.hold_until || undefined,
      notes: data.notes || undefined,
    };

    createDeposit.mutate(depositData, {
      onSuccess: () => {
        form.reset();
        setSelectedBuildingId('');
        setSelectedRoomId('');
        onOpenChange(false);
      },
    });
  };

  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    form.setValue('building_id', buildingId);
    form.setValue('room_id', '');
    form.setValue('bed_id', '');
    setSelectedRoomId('');
  };

  const handleRoomChange = (roomId: string) => {
    setSelectedRoomId(roomId);
    form.setValue('room_id', roomId);
    form.setValue('bed_id', '');
  };

  // =============================================
  // Render
  // =============================================

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo đặt cọc mới</DialogTitle>
          <DialogDescription>
            Tạo đặt cọc để giữ phòng cho khách hàng. Phòng/giường sẽ được đặt trạng thái "Đã giữ chỗ".
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* =============================================
                Tenant Selection
                ============================================= */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Khách hàng</h3>

              <FormField
                control={form.control}
                name="tenant_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chọn khách hàng *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn khách hàng" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {tenants.map((tenant) => (
                          <SelectItem key={tenant.id} value={tenant.id}>
                            {tenant.full_name} - {tenant.phone}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* =============================================
                Room Selection
                ============================================= */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Phòng giữ chỗ</h3>

              <FormField
                control={form.control}
                name="building_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tòa nhà *</FormLabel>
                    <Select onValueChange={handleBuildingChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn tòa nhà" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {buildings.map((building) => (
                          <SelectItem key={building.id} value={building.id}>
                            {building.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="room_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phòng (tùy chọn)</FormLabel>
                    <Select
                      onValueChange={handleRoomChange}
                      value={field.value}
                      disabled={!selectedBuildingId}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn phòng" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rooms.map((room) => (
                          <SelectItem key={room.id} value={room.id}>
                            {room.name} ({room.code}) - {room.room_type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedRoomId && beds.length > 0 && (
                <FormField
                  control={form.control}
                  name="bed_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giường (tùy chọn)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn giường" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {beds.map((bed) => (
                            <SelectItem key={bed.id} value={bed.id}>
                              {bed.name} ({bed.code})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            {/* =============================================
                Deposit Information
                ============================================= */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Thông tin đặt cọc</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số tiền (VNĐ) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="1000000"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="deposit_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngày đặt cọc *</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="hold_until"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Giữ chỗ đến ngày</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ghi chú</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Thêm ghi chú về đặt cọc..."
                        className="min-h-[100px]"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* =============================================
                Actions
                ============================================= */}
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={createDeposit.isPending}>
                {createDeposit.isPending ? 'Đang tạo...' : 'Tạo đặt cọc'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
