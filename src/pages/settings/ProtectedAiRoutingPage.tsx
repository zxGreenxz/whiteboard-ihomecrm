import { RequireSuperAdmin } from '@/components/auth/RequireSuperAdmin';
import { lazyWithRetry } from '@/lib/lazyWithRetry';

const AiRoutingPage = lazyWithRetry(() => import('./AiRoutingPage'));

export default function ProtectedAiRoutingPage() {
  return <RequireSuperAdmin><AiRoutingPage /></RequireSuperAdmin>;
}
