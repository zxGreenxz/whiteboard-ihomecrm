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
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useUpdateLead, useDeleteLead, type LeadWithRelations } from '@/hooks/useLeads';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { Pencil, Trash2, ArrowRight } from 'lucide-react';
import ConvertLeadToDepositDialog from './ConvertLeadToDepositDialog';

// =============================================
// Validation Schema
// =============================================

const updateLeadSchema = z.object({
  appointment_date: z.string().optional(),
  notes: z.string().optional(),
});

type UpdateLeadFormData = z.infer<typeof updateLeadSchema>;

// =============================================
// Status Labels
// =============================================

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  B1_LEAD: { label: 'B1 Bắn khách', color: 'bg-blue-100 text-blue-700' },
  B2_APPOINTMENT: { label: 'B2 Hẹn khách', color: 'bg-purple-100 text-purple-700' },
  B3_CONSULTING: { label: 'B3 Tư vấn', color: 'bg-orange-100 text-orange-700' },
  CONVERTED: { label: 'Đã chuyển đổi', color: 'bg-green-100 text-green-700' },
  FAILED: { label: 'Thất bại', color: 'bg-red-100 text-red-700' },
};

// =============================================
// Component
// =============================================

interface LeadDetailDialogProps {
  lead: LeadWithRelations;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function LeadDetailDialog({
  lead,
  open,
  onOpenChange,
}: LeadDetailDialogProps) {
  const [editMode, setEditMode] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);

  // Hooks
  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();

  // Form
  const form = useForm<UpdateLeadFormData>({
    resolver: zodResolver(updateLeadSchema),
    defaultValues: {
      appointment_date: lead.appointment_date || '',
      notes: lead.notes || '',
    },
  });

  // =============================================
  // Handlers
  // =============================================

  const onSubmit = async (data: UpdateLeadFormData) => {
    updateLead.mutate(
      {
        leadId: lead.id,
        data,
      },
      {
        onSuccess: () => {
          setEditMode(false);
        },
      }
    );
  };

  const handleDelete = () => {
    deleteLead.mutate(lead.id, {
      onSuccess: () => {
        setDeleteDialogOpen(false);
        onOpenChange(false);
      },
    });
  };

  const statusInfo = STATUS_LABELS[lead.status || 'B1_LEAD'];
  const canConvert = ['B1_LEAD', 'B2_APPOINTMENT', 'B3_CONSULTING'].includes(lead.status || '');

  // =============================================
  // Render
  // =============================================

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Chi tiết khách hẹn</DialogTitle>
                <DialogDescription>
                  Xem và cập nhật thông tin khách hàng tiềm năng
                </DialogDescription>
              </div>
              <Badge className={statusInfo.color}>{statusInfo.label}</Badge>
            </div>
          </DialogHeader>

          <Tabs defaultValue="info" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Thông tin</TabsTrigger>
              <TabsTrigger value="edit">Chỉnh sửa</TabsTrigger>
            </TabsList>

            {/* =============================================
                Info Tab
                ============================================= */}
            <TabsContent value="info" className="space-y-4">
              <Card className="p-4 space-y-3">
                <h3 className="font-semibold">Thông tin khách hàng</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Tên khách hàng:</span>
                    <p className="font-semibold">{lead.customer_name}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Số điện thoại:</span>
                    <p className="font-semibold">{lead.phone}</p>
                  </div>
                  {lead.email && (
                    <div>
                      <span className="text-muted-foreground">Email:</span>
                      <p className="font-semibold">{lead.email}</p>
                    </div>
                  )}
                  {lead.source && (
                    <div>
                      <span className="text-muted-foreground">Nguồn:</span>
                      <Badge variant="outline">{lead.source}</Badge>
                    </div>
                  )}
                </div>
              </Card>

              {(lead.building || lead.room) && (
                <Card className="p-4 space-y-3">
                  <h3 className="font-semibold">Phòng quan tâm</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    {lead.building && (
                      <div>
                        <span className="text-muted-foreground">Tòa nhà:</span>
                        <p className="font-semibold">{lead.building.name}</p>
                      </div>
                    )}
                    {lead.room && (
                      <div>
                        <span className="text-muted-foreground">Phòng:</span>
                        <p className="font-semibold">
                          {lead.room.name} ({lead.room.code})
                        </p>
                      </div>
                    )}
                  </div>
                </Card>
              )}

              {lead.appointment_date && (
                <Card className="p-4 space-y-3">
                  <h3 className="font-semibold">Lịch hẹn</h3>
                  <div className="text-sm">
                    <span className="text-muted-foreground">Ngày giờ hẹn:</span>
                    <p className="font-semibold">
                      {format(new Date(lead.appointment_date), 'EEEE, dd/MM/yyyy HH:mm', {
                        locale: vi,
                      })}
                    </p>
                  </div>
                </Card>
              )}

              {lead.assigned_staff && (
                <Card className="p-4 space-y-3">
                  <h3 className="font-semibold">Người phụ trách</h3>
                  <div className="text-sm">
                    <p className="font-semibold">{lead.assigned_staff.full_name}</p>
                  </div>
                </Card>
              )}

              {lead.notes && (
                <Card className="p-4 space-y-3">
                  <h3 className="font-semibold">Ghi chú</h3>
                  <p className="text-sm">{lead.notes}</p>
                </Card>
              )}

              <Card className="p-4 space-y-3">
                <h3 className="font-semibold">Thông tin hệ thống</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Ngày tạo:</span>
                    <p>
                      {format(new Date(lead.created_at || ''), 'dd/MM/yyyy HH:mm', {
                        locale: vi,
                      })}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Cập nhật:</span>
                    <p>
                      {format(new Date(lead.updated_at || ''), 'dd/MM/yyyy HH:mm', {
                        locale: vi,
                      })}
                    </p>
                  </div>
                </div>
              </Card>

              {/* Actions */}
              <div className="flex justify-between pt-4">
                <Button
                  variant="destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={lead.status === 'CONVERTED'}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Xóa khách hẹn
                </Button>
                {canConvert && (
                  <Button onClick={() => setConvertDialogOpen(true)}>
                    <ArrowRight className="h-4 w-4 mr-2" />
                    Chuyển thành đặt cọc
                  </Button>
                )}
              </div>
            </TabsContent>

            {/* =============================================
                Edit Tab
                ============================================= */}
            <TabsContent value="edit">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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

                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ghi chú</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Thêm ghi chú về khách hàng..."
                            className="min-h-[150px]"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex justify-end gap-2 pt-4">
                    <Button type="submit" disabled={updateLead.isPending}>
                      {updateLead.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                    </Button>
                  </div>
                </form>
              </Form>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* =============================================
          Delete Confirmation Dialog
          ============================================= */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa khách hẹn</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa khách hẹn <strong>{lead.customer_name}</strong>?
              Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* =============================================
          Convert to Deposit Dialog
          ============================================= */}
      {convertDialogOpen && (
        <ConvertLeadToDepositDialog
          lead={lead}
          open={convertDialogOpen}
          onOpenChange={(open) => {
            setConvertDialogOpen(open);
            if (!open) {
              onOpenChange(false); // Close parent dialog too
            }
          }}
        />
      )}
    </>
  );
}
