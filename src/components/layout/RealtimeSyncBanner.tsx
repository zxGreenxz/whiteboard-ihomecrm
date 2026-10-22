import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requestResyncAll, useRealtimeHealth } from '@/lib/realtime/channelHealth';

/** Gián đoạn ngắn hơn ngưỡng này thì im: socket nối lại sau vài giây là chuyện thường. */
export const NGUONG_HIEN_DAI_MS = 10_000;
/** Nút khoá trong khoảng này sau khi bấm — đủ để các màn kịp gửi lượt tải lại. */
export const KHOA_NUT_SAU_BAM_MS = 2_000;

/**
 * Dải "Mất kết nối cập nhật tự động" (21/10/2026, plan realtime + thông báo, A6 /
 * RT-HUB-9).
 *
 * VÌ SAO: realtime đứt thì màn hình chỉ đơn giản ngừng tự cập nhật — không lỗi,
 * không cảnh báo, người dùng tiếp tục ra quyết định trên số cũ. Store
 * channelHealth gom trạng thái mọi kênh (hub, chuông, Zalo, Network Center) về
 * MỘT tín hiệu; dải này hiện khi tín hiệu đó báo gián đoạn ≥10 s, và tự ẩn khi
 * kênh nối lại (lúc đó subscribeResilient đã tự bắt kịp).
 *
 * Nút "Tải lại dữ liệu" gọi requestResyncAll(): mọi kênh đang sống làm tươi query
 * của mình NGAY, không đợi nối lại. Không hứa "đã cập nhật" — chỉ báo đang gửi
 * lượt tải lại; kết quả từng màn tự hiện ở chính màn đó.
 *
 * Không props: gói C mount một bản ở MainLayout.
 *
 * NỔI, KHÔNG CHIẾM LUỒNG (RT-CLIENT-8, 22/10/2026): MainLayout đặt dải này ngay
 * trên khối fullBleed cao cố định (h-[calc(100vh-4rem)] / lg:h-screen — Chat
 * Zalo, chi tiết HĐ). Nằm trong luồng thì tổng chiều cao vượt viewport ~40 px và
 * ô soạn/nút gửi Zalo bị đẩy khỏi mép dưới đúng lúc người dùng đang gặp sự cố
 * mạng. Nên dải là một viên `fixed` ở trên: mobile nằm DƯỚI header 4rem (không
 * che nút menu/chuông), desktop sát mép trên (không có header); cộng
 * safe-area-inset-top (viewport-fit=cover); z-[60] trên header (z-50) và sidebar
 * (z-40), dưới toast (z-100). Lớp bọc ngoài trong suốt với con trỏ để không chặn
 * bấm vào nội dung hai bên viên.
 */
export default function RealtimeSyncBanner() {
  const { state, interruptedSince } = useRealtimeHealth();
  // Mốc gián đoạn ĐÃ quá ngưỡng — so bằng giá trị mốc, nên một lần gián đoạn
  // mới (mốc khác) phải tự đợi đủ 10 s của riêng nó.
  const [mocDaQuaNguong, setMocDaQuaNguong] = useState<number | null>(null);
  const [dangTaiLai, setDangTaiLai] = useState(false);
  const mocGianDoan = state === 'interrupted' ? interruptedSince : null;

  // Tự hiện đúng mốc 10 s mà không cần event nào khác: hẹn một timer tới mốc
  // (đã quá hạn thì timer 0 ms — vẫn qua callback, không setState đồng bộ).
  useEffect(() => {
    if (mocGianDoan === null) return undefined;
    const conLai = Math.max(0, mocGianDoan + NGUONG_HIEN_DAI_MS - Date.now());
    const timer = setTimeout(() => setMocDaQuaNguong(mocGianDoan), conLai);
    return () => clearTimeout(timer);
  }, [mocGianDoan]);

  useEffect(() => {
    if (!dangTaiLai) return undefined;
    const timer = setTimeout(() => setDangTaiLai(false), KHOA_NUT_SAU_BAM_MS);
    return () => clearTimeout(timer);
  }, [dangTaiLai]);

  if (mocGianDoan === null || mocDaQuaNguong !== mocGianDoan) return null;

  const taiLai = () => {
    setDangTaiLai(true);
    requestResyncAll();
  };

  return (
    <div
      data-testid="realtime-sync-banner"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[60] flex justify-center px-4 lg:top-[calc(env(safe-area-inset-top)+0.75rem)]"
    >
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-1.5 text-xs text-amber-900 shadow-md backdrop-blur-sm dark:border-amber-900/60 dark:bg-amber-950/90 dark:text-amber-100 sm:w-auto sm:px-4 sm:text-sm"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">Mất kết nối cập nhật tự động — đang nối lại…</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={taiLai}
          disabled={dangTaiLai}
          className="h-7 shrink-0 border-amber-300 bg-white px-2.5 text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-900/40"
        >
          <RefreshCw className={dangTaiLai ? 'animate-spin' : undefined} aria-hidden="true" />
          {dangTaiLai ? 'Đang tải lại…' : 'Tải lại dữ liệu'}
        </Button>
      </div>
    </div>
  );
}
