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
import { useCreateLead, type CreateLeadData } from '@/hooks/useLeads';
import { useBuildings } from '@/hooks/useBuildings';
import { useRooms } from '@/hooks/useRooms';
import { format } from 'date-fns';

// =============================================
// Validation Schema
// =============================================

const leadSchema = z.object({
  customer_name: z.string().min(1, 'Vui lòng nhập tên khách hàng'),
  phone: z.string().min(10, 'Số điện thoại phải có ít nhất 10 số'),
  email: z.string().email('Email không hợp lệ').optional().or(z.literal('')),
  source: z.string().optional(),
  building_id: z.string().optional(),
  room_id: z.string().optional(),
  appointment_date: z.string().optional(),
  notes: z.string().optional(),
});

type LeadFormData = z.infer<typeof leadSchema>;

// =============================================
// Lead Sources
// =============================================

const LEAD_SOURCES = [
  'Facebook',
  'Zalo',
  'Điện thoại',
  'Website',
  'Giới thiệu',
  'Walk-in',
  'Google',
  'Khác',
];

// =============================================
// Component
// =============================================

interface CreateLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CreateLeadDialog({ open, onOpenChange }: CreateLeadDialogProps) {
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');

  // Hooks
  const createLead = useCreateLead();
  const { data: buildings = [] } = useBuildings();
  const { data: allRooms = [] } = useRooms();

  // Filter rooms by selected building
  const rooms = selectedBuildingId
    ? allRooms.filter((room) => room.building_id === selectedBuildingId)
    : [];

  // Form
  const form = useForm<LeadFormData>({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      customer_name: '',
      phone: '',
      email: '',
      source: '',
      building_id: '',
      room_id: '',
      appointment_date: '',
      notes: '',
    },
  });

  // =============================================
  // Handlers
  // =============================================

  const onSubmit = async (data: LeadFormData) => {
    // Clean up data
    const cleanData: CreateLeadData = {
      customer_name: data.customer_name,
      phone: data.phone,
      email: data.email || undefined,
      source: data.source || undefined,
      building_id: data.building_id || undefined,
      room_id: data.room_id || undefined,
      appointment_date: data.appointment_date || undefined,
      notes: data.notes || undefined,
    };

    createLead.mutate(cleanData, {
      onSuccess: () => {
        form.reset();
        setSelectedBuildingId('');
        onOpenChange(false);
      },
    });
  };

  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    form.setValue('building_id', buildingId);
    form.setValue('room_id', ''); // Reset room when building changes
  };

  // =============================================
  // Render
  // =============================================

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo khách hẹn mới</DialogTitle>
          <DialogDescription>
            Thêm khách hàng tiềm năng vào hệ thống. Khách hẹn sẽ được tạo ở trạng thái "B1 Bắn khách".
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* =============================================
                Customer Information
                ============================================= */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Thông tin khách hàng</h3>

              <FormField
                control={form.control}
                name="customer_name"
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
                  name="phone"
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
                  name="email"
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
                name="source"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nguồn khách hàng</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn nguồn" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {LEAD_SOURCES.map((source) => (
                          <SelectItem key={source} value={source}>
                            {source}
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
              <h3 className="font-semibold text-sm">Phòng quan tâm</h3>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="building_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tòa nhà</FormLabel>
                      <Select
                        onValueChange={handleBuildingChange}
                        value={field.value}
                      >
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
                      <FormLabel>Phòng</FormLabel>
                      <Select
                        onValueChange={field.onChange}
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
                              {room.name} ({room.code})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* =============================================
                Appointment
                ============================================= */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm">Lịch hẹn</h3>

              <FormField
                control={form.control}
                name="appointment_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày giờ hẹn</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* =============================================
                Notes
                ============================================= */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Thêm ghi chú về khách hàng..."
                      className="min-h-[100px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
              <Button type="submit" disabled={createLead.isPending}>
                {createLead.isPending ? 'Đang tạo...' : 'Tạo khách hẹn'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
