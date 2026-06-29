import { useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useCustomer } from '@/hooks/useCustomers';
import { useCreateCT01Declaration } from '@/hooks/useCT01Declarations';
import { CT01Form } from '@/components/customers/CT01Form';
import CT01PrintLayout from '@/components/customers/CT01PrintLayout';
import type { CT01FormValues } from '@/lib/ct01Validation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function CT01FormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const printRef = useRef<HTMLDivElement>(null);
  const [printData, setPrintData] = useState<CT01FormValues | null>(null);

  const { data: customer, isLoading } = useCustomer(id ?? '');
  const createDeclaration = useCreateCT01Declaration();

  const handleSubmitAndPrint = async (values: CT01FormValues) => {
    if (!id) return;
    await createDeclaration.mutateAsync({ customerId: id, data: values });
    setPrintData(values);
    setTimeout(() => window.print(), 100);
  };

  const handlePrintOnly = () => {
    if (printData) {
      window.print();
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Đang tải...</p>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-destructive">Không tìm thấy khách hàng.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/customers')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Tờ khai thay đổi thông tin cư trú (CT01)</h1>
          <p className="text-sm text-muted-foreground">{customer.full_name}</p>
        </div>
      </div>

      {/* Form Card */}
      <Card>
        <CardHeader>
          <CardTitle>Thông tin tờ khai</CardTitle>
        </CardHeader>
        <CardContent>
          <CT01Form
            customer={customer}
            onSubmit={handleSubmitAndPrint}
            isLoading={createDeclaration.isPending}
          />
        </CardContent>
      </Card>

      {/* Action buttons */}
      {printData && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handlePrintOnly}>
            Chỉ in
          </Button>
        </div>
      )}

      {/* Print layout (hidden on screen, visible when printing) */}
      {printData && (
        <CT01PrintLayout ref={printRef} data={printData} />
      )}
    </div>
  );
}
