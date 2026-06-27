import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ChevronRight, Plus, Share2, SlidersHorizontal, Info,
  Repeat, LayoutGrid, BarChart3, Monitor,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import '@/styles/mobileApp.css';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type { ActionKey } from '@/lib/permissions';
import { useMyAvailableRooms } from '@/hooks/useMyAvailableRooms';
import { usePublicRoomTokens } from '@/hooks/usePublicRoomTokens';
import { usePassListings } from '@/hooks/usePassListings';
import PhongTrongPage from '@/pages/phong-trong/PhongTrongPage';
import type { HeaderAction } from '@/components/sale-phong/mobile/types';

// Tab quản trị mobile (lazy để không phình chunk mobile mặc định).
const MobileShareTokens = lazy(() => import('@/components/sale-phong/mobile/MobileShareTokens'));
const MobileDisplaySettings = lazy(() => import('@/components/sale-phong/mobile/MobileDisplaySettings'));
const MobileSaleInfo = lazy(() => import('@/components/sale-phong/mobile/MobileSaleInfo'));
const MobilePassListings = lazy(() => import('@/components/sale-phong/mobile/MobilePassListings'));
const MobileAnalytics = lazy(() => import('@/components/sale-phong/mobile/MobileAnalytics'));

type TabKey = 'tokens' | 'settings' | 'images' | 'pass' | 'floorplan' | 'analytics';
type Mode = 'browse' | 'admin';

interface TabDef {
  key: TabKey;
  label: string;
  desc: string;
  icon: LucideIcon;
  accent: string;
  action: ActionKey;
}

const TAB_DEFS: TabDef[] = [
  { key: 'tokens', label: 'Link chia sẻ', desc: 'Tạo & quản lý link gửi khách', icon: Share2, accent: 'var(--acc-blue)', action: 'manage_tokens' },
  { key: 'settings', label: 'Cài đặt hiển thị', desc: 'Ngày "sắp trống", hotline', icon: SlidersHorizontal, accent: 'var(--acc-cyan)', action: 'manage_settings' },
  { key: 'images', label: 'Thông tin sale', desc: 'Liên hệ toà, nội thất & ảnh phòng', icon: Info, accent: 'var(--acc-violet)', action: 'manage_images' },
  { key: 'pass', label: 'Khách nhờ sale', desc: 'Phòng khách nhờ pass', icon: Repeat, accent: 'var(--acc-amber)', action: 'manage_pass_listings' },
  { key: 'floorplan', label: 'Sơ đồ tòa nhà', desc: 'Bố trí tọa độ từng tầng', icon: LayoutGrid, accent: 'var(--acc-teal)', action: 'edit_floor_plan' },
  { key: 'analytics', label: 'Thống kê', desc: 'Lượt xem, tương tác', icon: BarChart3, accent: 'var(--acc-slate)', action: 'view_analytics' },
];

/**
 * "Phòng trống" — màn app full-screen mobile (web-app), shell .cm-*. Redesign theo
 * handoff Claude Design "Quản lý phòng trống".
 *  - Phòng trống (mặc định): nhúng PhongTrongPage với data in-app (useMyAvailableRooms).
 *  - Quản lý: 6 hàng tab quản trị (gate quyền). Chạm 1 hàng → mở màn tab full-screen,
 *    mỗi tab là component mobile-native riêng (bottom-sheet thay dialog desktop).
 */
export default function SalePhongMobilePage() {
  const navigate = useNavigate();
  const { data: perms } = useMyPermissions();
  const { data: buildings, isLoading } = useMyAvailableRooms();
  const { data: tokens } = usePublicRoomTokens();
  const { data: passListings } = usePassListings();

  const [mode, setMode] = useState<Mode>('browse');
  const [openTab, setOpenTab] = useState<TabKey | null>(null);
  const [headerAction, setHeaderAction] = useState<HeaderAction | null>(null);

  // Reset header action khi đổi/đóng tab.
  useEffect(() => { setHeaderAction(null); }, [openTab]);

  const adminTabs = useMemo(
    () => TAB_DEFS.filter((t) => canUse(perms, 'sale_phong', t.action)),
    [perms],
  );

  const activeTabDef = openTab ? TAB_DEFS.find((t) => t.key === openTab) : null;

  const statFor = (key: TabKey): string | null => {
    if (key === 'tokens' && tokens) return `${tokens.length} link`;
    if (key === 'pass' && passListings) return `${passListings.length} phòng`;
    return null;
  };
  const statColor = (key: TabKey) =>
    key === 'tokens' ? 'rgba(37,99,235,.09)' : 'rgba(217,119,6,.1)';

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
            {openTab && headerAction && (
              <div className="mtop-act">
                <button className="mtop-btn solid" onClick={headerAction.onClick}>
                  <Plus />{headerAction.label}
                </button>
              </div>
            )}
          </div>

          {/* Segmented control chỉ ở cấp 1 */}
          {!openTab && (
            <div className="sp-seg">
              <div className="sp-pillseg">
                <button className={mode === 'browse' ? 'on' : ''} onClick={() => setMode('browse')}>Phòng trống</button>
                <button className={mode === 'admin' ? 'on' : ''} onClick={() => setMode('admin')}>Quản lý</button>
              </div>
            </div>
          )}

          {/* Nội dung */}
          {openTab ? (
            <div className="mbody" style={{ padding: 0 }}>
              <Suspense fallback={<div className="stub"><p>Đang tải…</p></div>}>
                {renderTab(openTab, setHeaderAction)}
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
                  {adminTabs.map((t) => {
                    const stat = statFor(t.key);
                    return (
                      <button key={t.key} className="sp-navrow" onClick={() => setOpenTab(t.key)}>
                        <span className="ic" style={{ background: t.accent }}>
                          <t.icon size={20} />
                        </span>
                        <span className="tx">
                          <b>{t.label}</b>
                          <span>{t.desc}</span>
                          {stat && (
                            <span className="statpill" style={{ background: statColor(t.key), color: t.accent }}>{stat}</span>
                          )}
                        </span>
                        <ChevronRight className="chev" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function renderTab(key: TabKey, setHeaderAction: (a: HeaderAction | null) => void) {
  switch (key) {
    case 'tokens':
      return <MobileShareTokens onHeaderAction={setHeaderAction} />;
    case 'settings':
      return <MobileDisplaySettings />;
    case 'images':
      return <MobileSaleInfo />;
    case 'pass':
      return <MobilePassListings onHeaderAction={setHeaderAction} />;
    case 'analytics':
      return <MobileAnalytics />;
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
