import { Suspense, lazy, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ChevronRight, Share2, SlidersHorizontal, Image as ImageIcon,
  Repeat, LayoutGrid, BarChart3, Monitor,
} from 'lucide-react';
import '@/styles/mobileApp.css';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type { ActionKey } from '@/lib/permissions';
import { useMyAvailableRooms } from '@/hooks/useMyAvailableRooms';
import PhongTrongPage from '@/pages/phong-trong/PhongTrongPage';

// Tab quản trị (component desktop) — lazy để không phình chunk mobile.
const ShareTokensTab = lazy(() => import('@/components/sale-phong/ShareTokensTab'));
const DisplaySettingsTab = lazy(() => import('@/components/sale-phong/DisplaySettingsTab'));
const SaleImagesTab = lazy(() => import('@/components/sale-phong/SaleImagesTab'));
const PassListingsTab = lazy(() => import('@/components/sale-phong/PassListingsTab'));
const AnalyticsTab = lazy(() => import('@/components/sale-phong/AnalyticsTab'));

type TabKey = 'tokens' | 'settings' | 'images' | 'pass' | 'floorplan' | 'analytics';
type Mode = 'browse' | 'admin';

interface TabDef {
  key: TabKey;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  action: ActionKey;
}

const TAB_DEFS: TabDef[] = [
  { key: 'tokens', label: 'Link chia sẻ', desc: 'Tạo & quản lý link gửi khách', icon: Share2, accent: '#2563eb', action: 'manage_tokens' },
  { key: 'settings', label: 'Cài đặt hiển thị', desc: 'Ngày "sắp trống", hotline', icon: SlidersHorizontal, accent: '#0891b2', action: 'manage_settings' },
  { key: 'images', label: 'Hình ảnh sale', desc: 'Ảnh phòng cho trang công khai', icon: ImageIcon, accent: '#7c3aed', action: 'manage_images' },
  { key: 'pass', label: 'Khách nhờ sale', desc: 'Phòng khách nhờ pass', icon: Repeat, accent: '#d97706', action: 'manage_pass_listings' },
  { key: 'floorplan', label: 'Sơ đồ tòa nhà', desc: 'Bố trí tọa độ từng tầng', icon: LayoutGrid, accent: '#0d9488', action: 'edit_floor_plan' },
  { key: 'analytics', label: 'Thống kê', desc: 'Lượt xem, tương tác', icon: BarChart3, accent: '#475569', action: 'view_analytics' },
];

/**
 * "Phòng trống" — màn hình app full-screen trên mobile (web-app), shell .cm-*.
 * Gồm 2 chế độ qua segmented control:
 *  - Phòng trống (mặc định): nhúng lại PhongTrongPage với data in-app
 *    (useMyAvailableRooms) — list/sơ đồ/chi tiết/tạo cọc như trang công khai.
 *  - Quản lý: danh sách tab quản trị Sale Phòng (gate theo quyền chi tiết),
 *    chạm 1 hàng → mở component tab đó full-screen (back về danh sách).
 */
export default function SalePhongMobilePage() {
  const navigate = useNavigate();
  const { data: perms } = useMyPermissions();
  const { data: buildings, isLoading } = useMyAvailableRooms();

  const [mode, setMode] = useState<Mode>('browse');
  const [openTab, setOpenTab] = useState<TabKey | null>(null);

  const adminTabs = useMemo(
    () => TAB_DEFS.filter((t) => canUse(perms, 'sale_phong', t.action)),
    [perms],
  );

  const activeTabDef = openTab ? TAB_DEFS.find((t) => t.key === openTab) : null;

  const goBack = () => {
    if (openTab) setOpenTab(null);
    else navigate('/');
  };

  const title = activeTabDef ? activeTabDef.label : 'Phòng trống';
  const subtitle = activeTabDef
    ? 'Sale Phòng'
    : mode === 'browse'
      ? 'Bảng phòng trống của bạn'
      : 'Quản lý Sale Phòng';

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={goBack} aria-label={openTab ? 'Quay lại' : 'Về trang chủ'}>
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>{title}</h1>
              <p>{subtitle}</p>
            </div>
          </div>

          {/* Segmented control chỉ hiện ở cấp 1 (chưa mở tab quản trị). */}
          {!openTab && (
            <div className="sp-seg">
              <div className="lfilter">
                <button className={'lchip' + (mode === 'browse' ? ' on' : '')} onClick={() => setMode('browse')}>
                  Phòng trống
                </button>
                <button className={'lchip' + (mode === 'admin' ? ' on' : '')} onClick={() => setMode('admin')}>
                  Quản lý
                </button>
              </div>
            </div>
          )}

          {/* Nội dung */}
          {openTab ? (
            <div className="mbody">
              <Suspense fallback={<div className="stub"><p>Đang tải…</p></div>}>
                {renderTab(openTab)}
              </Suspense>
            </div>
          ) : mode === 'browse' ? (
            isLoading ? (
              <div className="mbody"><div className="stub"><p>Đang tải danh sách phòng…</p></div></div>
            ) : (
              <div className="sp-embed">
                <PhongTrongPage buildings={buildings ?? []} embedded />
              </div>
            )
          ) : (
            <div className="mbody">
              {adminTabs.length === 0 ? (
                <div className="stub">
                  <p>
                    Bạn chỉ có quyền xem trang này — chưa được cấp quyền quản lý link chia sẻ,
                    cài đặt, hình ảnh hay sơ đồ. Liên hệ quản trị viên nếu cần thêm quyền.
                  </p>
                </div>
              ) : (
                <div className="rowlist">
                  {adminTabs.map((t) => (
                    <button key={t.key} className="sp-navrow" onClick={() => setOpenTab(t.key)}>
                      <span className="ic" style={{ background: t.accent }}>
                        <t.icon />
                      </span>
                      <span className="tx">
                        <b>{t.label}</b>
                        <span>{t.desc}</span>
                      </span>
                      <ChevronRight className="chev" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function renderTab(key: TabKey) {
  switch (key) {
    case 'tokens':
      return <div className="sp-tabhost"><ShareTokensTab /></div>;
    case 'settings':
      return <div className="sp-tabhost"><DisplaySettingsTab /></div>;
    case 'images':
      return <div className="sp-tabhost"><SaleImagesTab /></div>;
    case 'pass':
      return <div className="sp-tabhost"><PassListingsTab /></div>;
    case 'analytics':
      return <div className="sp-tabhost scrollx"><AnalyticsTab /></div>;
    case 'floorplan':
      return (
        <div className="stub">
          <span className="stub-ic"><Monitor /></span>
          <p>
            Trình chỉnh sửa <b>Sơ đồ tòa nhà</b> dùng thao tác kéo–thả, phù hợp màn hình lớn.
            Vui lòng mở trên máy tính để chỉnh sửa sơ đồ.
          </p>
        </div>
      );
    default:
      return null;
  }
}
