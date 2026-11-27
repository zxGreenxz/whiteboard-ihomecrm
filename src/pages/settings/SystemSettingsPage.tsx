import { RequireSuperAdmin } from '@/components/auth/RequireSuperAdmin';
import { lazyWithRetry } from '@/lib/lazyWithRetry';

const AiRoutingPage = lazyWithRetry(() => import('./AiRoutingPage'));
const GeneralSettingsPage = lazyWithRetry(() => import('./GeneralSettingsPage'));

export default function SystemSettingsPage({ section }: { section: 'general' | 'ai' }) {
  if (section === 'ai') return <RequireSuperAdmin><AiRoutingPage /></RequireSuperAdmin>;
  return <GeneralSettingsPage />;
}
