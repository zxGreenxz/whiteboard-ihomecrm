import { useCallback, useEffect, useState } from 'react';

/**
 * Trạng thái cài app (PWA) cho gợi ý "Thêm vào màn hình chính".
 * - Android/Chrome: bắt `beforeinstallprompt` → expose `promptInstall()`.
 * - iOS Safari: không có prompt → trả `isIOS` để hiện hướng dẫn thủ công.
 * - Ẩn khi đã chạy standalone (đã cài).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isStandaloneNow = (): boolean => {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari dùng navigator.standalone (không chuẩn)
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
};

const detectIOSSafari = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ giả dạng Mac nhưng có cảm ứng
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Loại Chrome/Firefox/Edge trên iOS (A2HS khác) — chỉ Safari mới đúng hướng dẫn.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return iOS && isSafari;
};

export function usePwaInstall() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const standalone = isStandaloneNow();
  const isIOS = detectIOSSafari();

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // chặn mini-infobar mặc định để tự đặt nút
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return null;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    return choice.outcome;
  }, [deferred]);

  return {
    /** Android/Chrome sẵn sàng prompt cài. */
    canInstall: !!deferred && !standalone && !installed,
    /** iOS Safari chưa cài → cần hướng dẫn thủ công. */
    isIOS: isIOS && !standalone && !installed,
    /** Đang chạy như app đã cài. */
    isStandalone: standalone,
    promptInstall,
  };
}
