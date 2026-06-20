import { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';

const DISMISS_KEY = 'pwa-install-hint-dismissed';

/**
 * Banner gợi ý cài app, hiển thị trong Home launcher (mobile).
 * - Android/Chrome: nút "Cài đặt" gọi prompt hệ thống.
 * - iOS Safari: hướng dẫn "Chia sẻ → Thêm vào MH chính" (iOS không có prompt).
 * - Ẩn khi đã cài (standalone) hoặc user đã tắt (localStorage).
 * Style scope dưới `.hl-app` (xem homeLauncher.css).
 */
const InstallHint = () => {
  const { canInstall, isIOS, promptInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;
  if (!canInstall && !isIOS) return null;

  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="ihint" role="note">
      <span className="ihint-ic">{canInstall ? <Download /> : <Share />}</span>
      <div className="ihint-body">
        <div className="ihint-t">Cài CRM lên máy</div>
        <div className="ihint-s">
          {canInstall
            ? 'Mở nhanh như app, không thanh địa chỉ.'
            : 'Chạm Chia sẻ ⬆️ → "Thêm vào MH chính".'}
        </div>
      </div>
      {canInstall ? (
        <button
          type="button"
          className="ihint-btn"
          onClick={() => {
            void promptInstall();
          }}
        >
          Cài đặt
        </button>
      ) : null}
      <button type="button" className="ihint-x" aria-label="Đóng" onClick={close}>
        <X />
      </button>
    </div>
  );
};

export default InstallHint;
