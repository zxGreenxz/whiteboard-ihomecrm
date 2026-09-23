import { useEffect } from 'react';
import { IS_TEST_ENV } from '@/lib/appEnvironment';

const TIEN_TO = '[TEST] ';

/**
 * Nhãn "MÔI TRƯỜNG TEST" cố định giữa mép trên màn hình, kèm tiền tố [TEST] trên
 * tiêu đề tab. Chỉ hiện ở bản build Preview (VITE_APP_ENV=test).
 *
 * `pointer-events-none`: nhãn đè lên mọi trang nhưng không được chặn cú bấm nào của
 * giao diện bên dưới — nó chỉ để nhìn.
 */
export default function TestEnvironmentBanner() {
  useEffect(() => {
    if (!IS_TEST_ENV) return undefined;
    const gan = () => {
      if (!document.title.startsWith(TIEN_TO)) document.title = `${TIEN_TO}${document.title}`;
    };
    gan();
    const quanSat = new MutationObserver(gan);
    const the = document.querySelector('title');
    if (the) quanSat.observe(the, { childList: true });
    return () => quanSat.disconnect();
  }, []);

  if (!IS_TEST_ENV) return null;
  return (
    <div
      role="status"
      aria-label="Môi trường TEST"
      className="pointer-events-none fixed left-1/2 top-0 z-[10000] -translate-x-1/2 rounded-b-md bg-amber-500 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-black shadow"
    >
      Môi trường TEST · bản sao dữ liệu production
    </div>
  );
}
