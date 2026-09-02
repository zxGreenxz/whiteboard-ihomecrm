// Nút nổi mở AI Copilot — gate 3 lớp: session + entitlement (server-owned,
// SELECT own) + quyền ai_copilot.view (canUse). Ẩn trên route public.
// LƯU Ý: đây chỉ là gate UI — gate THẬT nằm trong RPC reserve_ai_usage (F14).
import { lazy, Suspense, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { useCopilotEntitlement } from './useAiProviders';
import { BeChiu, TEN_LINH_THU } from './BeChiu';

const ChatPanel = lazy(() => import('./ChatPanel'));

const HIDDEN_PREFIXES = [
  '/login', '/register', '/forgot-password', '/reset-password',
  '/c/', '/r/', '/phongtrong', '/network-center',
];

export default function CopilotLauncher() {
  const location = useLocation();
  const { data: user } = useAuth();

  const isHidden = HIDDEN_PREFIXES.some(
    (p) => location.pathname === p || location.pathname.startsWith(p),
  );

  // Query entitlement/permission chỉ chạy khi có session + không phải trang
  // public (component con mount có điều kiện — tránh query mồ côi).
  if (!user || isHidden) return null;
  return <GatedLauncher />;
}

function GatedLauncher() {
  const [open, setOpen] = useState(false);
  const { data: entitlement } = useCopilotEntitlement();
  const { data: perms } = useMyPermissions();

  if (!entitlement?.chat_enabled) return null;
  if (!perms || !canUse(perms, 'ai_copilot', 'view')) return null;

  return (
    <>
      {open && (
        <Suspense fallback={null}>
          <ChatPanel onClose={() => setOpen(false)} />
        </Suspense>
      )}
      {!open && (
        <button
          // Trên ĐIỆN THOẠI nút nằm sát mép TRÁI: góc phải là chỗ của cột thao
          // tác trong các bảng (thu chi, hoá đơn) và nút z-9997 này đè lên tất
          // cả — .cm-stage là stacking context z-0 nên không gì trong trang vượt
          // lên trên được. Từ sm trở lên trả về góc phải: góc trái desktop là
          // chân sidebar (avatar, chuông thông báo).
          className="bc-goc bc-launcher fixed bottom-4 left-1 sm:left-auto sm:right-4 z-[9997]"
          title={`Chat với ${TEN_LINH_THU}`}
          onClick={() => setOpen(true)}
          data-testid="copilot-launcher"
        >
          <BeChiu size={38} animated smoke blush cuaSo />
          <span className="bc-cham-online" />
        </button>
      )}
    </>
  );
}
