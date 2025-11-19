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
import { useConvertLeadToDeposit, type LeadWithRelations } from '@/hooks/useLeads';
import { useTenants, useCreateTenant } from '@/hooks/useTenants';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { useBeds } from '@/hooks/useBeds';
import { Card } from '@/components/ui/card';
import { format } from 'date-fns';

// =============================================
// Validation Schema
// =============================================

const convertLeadSchema = z.object({
  // Tenant selection
  tenant_option: z.enum(['existing', 'new']),
  tenant_id: z.string().optional(),

  // New tenant info (if creating new)
  new_tenant_name: z.string().optional(),
  new_tenant_phone: z.string().optional(),
  new_tenant_email: z.string().optional(),
  new_tenant_id_number: z.string().optional(),

  // Room selection
  building_id: z.string().min(1, 'Vui lòng chọn tòa nhà'),
  room_id: z.string().optional(),
  bed_id: z.string().optional(),

  // Deposit info
  amount: z.string().min(1, 'Vui lòng nhập số tiền đặt cọc'),
  deposit_date: z.string().min(1, 'Vui lòng chọn ngày đặt cọc'),
  hold_until: z.string().optional(),
  notes: z.string().optional(),
}).refine(
  (data) => {
    if (data.tenant_option === 'existing') {
      return !!data.tenant_id;
    }
    return !!data.new_tenant_name && !!data.new_tenant_phone;
  },
  {
    message: 'Vui lòng chọn khách hàng hoặc nhập thông tin khách hàng mới',
    path: ['tenant_id'],
  }
);

type ConvertLeadFormData = z.infer<typeof convertLeadSchema>;

// =============================================
// Component
// =============================================

interface ConvertLeadToDepositDialogProps {
  lead: LeadWithRelations;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ConvertLeadToDepositDialog({
  lead,
  open,
  onOpenChange,
}: ConvertLeadToDepositDialogProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState(lead.building_id || '');
  const [selectedRoomId, setSelectedRoomId] = useState(lead.room_id || '');

  // Hooks
  const convertLead = useConvertLeadToDeposit();
  const createTenant = useCreateTenant();
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
  const form = useForm<ConvertLeadFormData>({
    resolver: zodResolver(convertLeadSchema),
    defaultValues: {
      tenant_option: 'new',
      tenant_id: '',
      new_tenant_name: lead.customer_name,
      new_tenant_phone: lead.phone,
      new_tenant_email: lead.email || '',
      new_tenant_id_number: '',
      building_id: lead.building_id || '',
      room_id: lead.room_id || '',
      bed_id: '',
      amount: '',
      deposit_date: format(new Date(), "yyyy-MM-dd"),
      hold_until: '',
      notes: lead.notes || '',
    },
  });

  const tenantOption = form.watch('tenant_option');

  // =============================================
  // Handlers
  // =============================================

  const onSubmit = async (data: ConvertLeadFormData) => {
    try {
      let tenantId = data.tenant_id;

      // Create new tenant if needed
      if (data.tenant_option === 'new') {
        const newTenant = await createTenant.mutateAsync({
          full_name: data.new_tenant_name!,
          phone: data.new_tenant_phone!,
          email: data.new_tenant_email || undefined,
          id_number: data.new_tenant_id_number || undefined,
        });
        tenantId = newTenant.id;
      }

      if (!tenantId) {
        throw new Error('Không thể tạo hoặc chọn khách hàng');
      }

      // Convert lead to deposit
      await convertLead.mutateAsync({
        leadId: lead.id,
        depositData: {
          tenant_id: tenantId,
          room_id: data.room_id || undefined,
          bed_id: data.bed_id || undefined,
          amount: parseFloat(data.amount),
          deposit_date: data.deposit_date,
          hold_until: data.hold_until || undefined,
          notes: data.notes || undefined,
        },
      });

      onOpenChange(false);
    } catch (error) {
      console.error('Error converting lead:', error);
    }
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
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chuyển khách hẹn thành đặt cọc</DialogTitle>
          <DialogDescription>
            Tạo đặt cọc cho khách hàng <strong>{lead.customer_name}</strong>. Phòng sẽ được giữ chỗ sau khi đặt cọc.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* =============================================
                Tenant Selection
                ============================================= */}
            <Card className="p-4 space-y-4">
              <h3 className="font-semibold">Thông tin khách hàng</h3>

              <FormField
                control={form.control}
                name="tenant_option"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chọn tùy chọn</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="new">Tạo khách hàng mới</SelectItem>
                        <SelectItem value="existing">Chọn khách hàng có sẵn</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {tenantOption === 'new' ? (
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="new_tenant_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tên khách hàng *</FormLabel>
                        <FormControl>
                          <Input placeholder="Nhập tên khách hàng" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="new_tenant_phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Số điện thoại *</FormLabel>
                          <FormControl>
                            <Input placeholder="0912345678" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="new_tenant_email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <FormControl>
                            <Input placeholder="email@example.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="new_tenant_id_number"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>CMND/CCCD</FormLabel>
                        <FormControl>
                          <Input placeholder="Số CMND/CCCD" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ) : (
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
              )}
            </Card>

            {/* =============================================
                Room Selection
                ============================================= */}
            <Card className="p-4 space-y-4">
              <h3 className="font-semibold">Chọn phòng giữ chỗ</h3>

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
            </Card>

            {/* =============================================
                Deposit Info
                ============================================= */}
            <Card className="p-4 space-y-4">
              <h3 className="font-semibold">Thông tin đặt cọc</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số tiền đặt cọc (VNĐ) *</FormLabel>
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
            </Card>

            {/* =============================================
                Actions
                ============================================= */}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={convertLead.isPending || createTenant.isPending}
              >
                {convertLead.isPending || createTenant.isPending
                  ? 'Đang xử lý...'
                  : 'Tạo đặt cọc'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
