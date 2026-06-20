import { useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';
import { useContract } from '@/hooks/useContracts';
import { usePhoneViewport } from '@/hooks/use-mobile';
import ContractDetailView from '@/components/contracts/detail/ContractDetailView';

/**
 * Route /contracts/:id — deep-link chi tiết hợp đồng (khách hàng, toà nhà,
 * thông báo…). Nội dung dùng chung component ContractDetailView; trang này chỉ
 * lo khung (MainLayout desktop / full-screen mobile) và tiêu đề.
 */
const ContractDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isPhone = usePhoneViewport();
  const { data: contract } = useContract(id || '');
  const onBack = useCallback(() => navigate('/contracts'), [navigate]);

  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy hợp đồng" icon={FileText}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID hợp đồng không hợp lệ</p>
          <Button onClick={onBack} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  // Mobile (≤767px): ContractDetailView tự render trang chi tiết full-screen riêng.
  if (isPhone) {
    return <ContractDetailView id={id} onBack={onBack} />;
  }

  return (
    <MainLayout
      title={`Hợp đồng ${contract?.contract_number || id.slice(0, 8)}`}
      subtitle="Chi tiết hợp đồng"
      icon={FileText}
    >
      <ContractDetailView id={id} onBack={onBack} />
    </MainLayout>
  );
};

export default ContractDetailPage;
