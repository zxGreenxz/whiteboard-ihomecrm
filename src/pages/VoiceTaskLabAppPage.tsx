import { useMemo } from 'react';
import { ArrowLeft, Mic } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import { withAuthBootstrapTimeout } from '@/lib/authBootstrap';
import { createAppLabClient } from '@/lib/voice-task-lab/appClient';
import { LabApiError } from '@/lib/voice-task-lab/client';
import MainLayout from '@/components/layout/MainLayout';
import VoiceTaskLabPage from './VoiceTaskLabPage';

export default function VoiceTaskLabAppPage() {
  const { data: user } = useAuth();
  const { selectedOrganizationId, isLoading, isError } = useOrganization();
  const isPhone = usePhoneViewport();
  const client = useMemo(() => user?.id && selectedOrganizationId ? createAppLabClient({
    userId: user.id,
    organizationId: selectedOrganizationId,
    getSession: async () => {
      const { data, error } = await withAuthBootstrapTimeout(supabase.auth.getSession());
      if (error) throw new LabApiError('Chưa đọc được phiên đăng nhập CRM. Vui lòng thử lại.', 401);
      return data.session;
    },
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
  }) : null, [user?.id, selectedOrganizationId]);
  const content = <>
    <div className="border-b border-slate-200 bg-white px-5 py-3"><Link to="/" className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-teal-800"><ArrowLeft className="size-4" />Về trang chủ</Link></div>
    {client ? <VoiceTaskLabPage key={`${user?.id}:${selectedOrganizationId}`} client={client} accessMode="app" maxAudioBytes={2 * 1024 * 1024} /> : <div role="status" className="p-6 text-sm text-slate-600">{isLoading ? 'Đang xác định tổ chức…' : isError ? 'Chưa tải được tổ chức. Hãy trở về trang chủ và thử lại.' : 'Hãy chọn tổ chức ở trang chủ trước khi mở bản thử nghiệm.'}</div>}
  </>;
  return isPhone ? content : <MainLayout title="Thử giọng nói" icon={Mic}>{content}</MainLayout>;
}
