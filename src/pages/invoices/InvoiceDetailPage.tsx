import { useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Receipt } from 'lucide-react';
import { useInvoice } from '@/hooks/useInvoices';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import InvoiceDetailView from '@/components/invoices/InvoiceDetailView';

/**
 * Route /invoices/:id — deep-link chi tiết hoá đơn (thông báo, HĐ trong HĐ thuê,
 * toà nhà…). Phần nội dung dùng chung component InvoiceDetailView; trang này chỉ
 * lo khung (MainLayout desktop / full-screen mobile) và tiêu đề.
 */
const InvoiceDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isPhone = usePhoneViewport();
  const { data: invoice } = useInvoice(id || '');
  const onBack = useCallback(() => navigate('/invoices'), [navigate]);

  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy hóa đơn" icon={Receipt}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID hóa đơn không hợp lệ</p>
          <Button onClick={onBack} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  // Mobile (≤767px): InvoiceDetailView tự render trang chi tiết full-screen riêng.
  if (isPhone) {
    return <InvoiceDetailView id={id} onBack={onBack} />;
  }

  return (
    <MainLayout
      title={invoice ? getInvoiceTitle(invoice) : 'Chi tiết hoá đơn'}
      subtitle={invoice?.invoice_number ? `Hoá đơn ${invoice.invoice_number}` : 'Chi tiết hoá đơn'}
      icon={Receipt}
    >
      <InvoiceDetailView id={id} onBack={onBack} />
    </MainLayout>
  );
};

export default InvoiceDetailPage;
