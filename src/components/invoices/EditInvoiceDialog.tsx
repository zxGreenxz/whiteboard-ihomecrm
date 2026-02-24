import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateInvoice } from '@/hooks/useInvoices';
import InvoiceForm from './InvoiceForm';
import type { InvoiceWithRelations, InvoiceFormData, InvoiceFormItem } from '@/types/invoice';

interface EditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations;
}

/**
 * Convert an InvoiceWithRelations object into the shape expected by InvoiceForm defaultValues.
 */
function invoiceToFormData(invoice: InvoiceWithRelations): Partial<InvoiceFormData> {
  const items: InvoiceFormItem[] = (invoice.invoice_items ?? []).map((item, idx) => ({
    service_id: item.service_id,
    type: item.type,
    description: item.description,
    unit_price: item.unit_price,
    quantity: item.quantity,
    coefficient: item.coefficient,
    previous_reading: item.previous_reading,
    current_reading: item.current_reading,
    from_date: item.from_date,
    to_date: item.to_date,
    sort_order: item.sort_order ?? idx,
  }));

  return {
    building_id: invoice.building_id,
    room_id: invoice.room_id,
    bed_id: invoice.bed_id,
    contract_id: invoice.contract_id,
    billing_month: invoice.billing_month,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    template_id: invoice.template_id,
    notes: invoice.notes,
    discount_amount: invoice.discount_amount ?? 0,
    tax_percent: invoice.tax_percent ?? 0,
    prepaid_amount: invoice.prepaid_amount ?? 0,
    previous_debt: invoice.previous_debt ?? 0,
    items,
  };
}

const EditInvoiceDialog = ({
  open,
  onOpenChange,
  invoice,
}: EditInvoiceDialogProps) => {
  const updateMutation = useUpdateInvoice();

  const handleSubmit = (formData: InvoiceFormData) => {
    updateMutation.mutate(
      { id: invoice.id, formData },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa hoá đơn</DialogTitle>
          <DialogDescription>
            Chỉnh sửa thông tin hoá đơn. Chỉ có thể chỉnh sửa hoá đơn ở trạng thái nháp.
          </DialogDescription>
        </DialogHeader>

        <InvoiceForm
          defaultValues={invoiceToFormData(invoice)}
          onSubmit={handleSubmit}
          isSubmitting={updateMutation.isPending}
          mode="edit"
        />
      </DialogContent>
    </Dialog>
  );
};

export default EditInvoiceDialog;
