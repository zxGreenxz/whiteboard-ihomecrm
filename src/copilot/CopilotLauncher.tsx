// Nút nổi mở AI Copilot — gate 3 lớp: session + entitlement (server-owned,
// SELECT own) + quyền ai_copilot.view (canUse). Ẩn trên route public.
// LƯU Ý: đây chỉ là gate UI — gate THẬT nằm trong RPC reserve_ai_usage (F14).
import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { useCopilotEntitlement } from './useAiProviders';

const ChatPanel = lazy(() => import('./ChatPanel'));

const PUBLIC_PREFIXES = [
  '/login', '/register', '/forgot-password', '/reset-password',
  '/c/', '/r/', '/phongtrong',
];

export default function CopilotLauncher() {
  const location = useLocation();
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) setHasSession(!!data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (mounted) setHasSession(!!session);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const isPublic = PUBLIC_PREFIXES.some(
    (p) => location.pathname === p || location.pathname.startsWith(p),
  );

  // Query entitlement/permission chỉ chạy khi có session + không phải trang
  // public (component con mount có điều kiện — tránh query mồ côi).
  if (!hasSession || isPublic) return null;
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
          className="fixed bottom-4 right-4 z-[9997] flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition hover:bg-blue-700"
          title="Trợ lý AI"
          onClick={() => setOpen(true)}
          data-testid="copilot-launcher"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}
    </>
  );
}
