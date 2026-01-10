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
import { useUpdateInvoice, InvoiceWithRelations } from '@/hooks/useInvoices';
import { useState, useEffect } from 'react';
import { format } from 'date-fns';

interface EditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations;
}

const EditInvoiceDialog = ({
  open,
  onOpenChange,
  invoice,
}: EditInvoiceDialogProps) => {
  const updateMutation = useUpdateInvoice();

  const [formData, setFormData] = useState({
    title: '',
    billing_period_start: '',
    billing_period_end: '',
    issue_date: '',
    due_date: '',
    notes: '',
  });

  useEffect(() => {
    if (invoice && open) {
      setFormData({
        title: invoice.title || '',
        billing_period_start: invoice.billing_period_start || '',
        billing_period_end: invoice.billing_period_end || '',
        issue_date: invoice.issue_date || '',
        due_date: invoice.due_date || '',
        notes: invoice.notes || '',
      });
    }
  }, [invoice, open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    updateMutation.mutate(
      {
        id: invoice.id,
        ...formData,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa hóa đơn</DialogTitle>
          <DialogDescription>
            Chỉnh sửa thông tin hóa đơn nháp. Chỉ có thể chỉnh sửa hóa đơn ở trạng thái nháp.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Tiêu đề hóa đơn</Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) =>
                setFormData({ ...formData, title: e.target.value })
              }
              placeholder="VD: Tiền nhà tháng 01/2025"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="billing_period_start">Kỳ thanh toán từ</Label>
              <Input
                id="billing_period_start"
                type="date"
                value={formData.billing_period_start}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    billing_period_start: e.target.value,
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="billing_period_end">Đến</Label>
              <Input
                id="billing_period_end"
                type="date"
                value={formData.billing_period_end}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    billing_period_end: e.target.value,
                  })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="issue_date">Ngày phát hành</Label>
              <Input
                id="issue_date"
                type="date"
                value={formData.issue_date}
                onChange={(e) =>
                  setFormData({ ...formData, issue_date: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="due_date">Hạn thanh toán</Label>
              <Input
                id="due_date"
                type="date"
                value={formData.due_date}
                onChange={(e) =>
                  setFormData({ ...formData, due_date: e.target.value })
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Ghi chú</Label>
            <Textarea
              id="notes"
              value={formData.notes}
              onChange={(e) =>
                setFormData({ ...formData, notes: e.target.value })
              }
              placeholder="Ghi chú thêm cho hóa đơn..."
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Hủy
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default EditInvoiceDialog;
