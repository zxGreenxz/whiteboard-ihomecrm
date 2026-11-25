import { Suspense } from 'react';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { lazyWithRetry } from '@/lib/lazyWithRetry';

const Mobile = lazyWithRetry(() => import('./DepositsMobilePage'));
const Desktop = lazyWithRetry(() => import('./DepositsPage'));

export default function DepositsLayout() {
  const isPhone = usePhoneViewport();
  return <Suspense fallback={null}>{isPhone ? <Mobile /> : <Desktop />}</Suspense>;
}
