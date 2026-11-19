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
 * TRONG LUỒNG, KHÔNG NỔI (RT-CLIENT-8, re-review 22/10/2026): bản nổi `fixed`
 * z-[60] che nút đầu khung Chat Zalo trên điện thoại (y 72–118) và đè lên
 * Sheet/Dialog (z-50) — không tắt được nên khi gián đoạn kéo dài các nút đó bị khoá.
 * Dải là một hàng `shrink-0` ngay đầu <main>; với trang fullBleed, MainLayout cho
 * <main> cao cố định theo viewport và xếp cột (dải + khối nội dung flex-1 min-h-0),
 * nên dải lấy chỗ của nội dung chứ không đẩy ô soạn/nút gửi khỏi mép dưới.
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
    <div data-testid="realtime-sync-banner" className="shrink-0">
      <div
        role="status"
        aria-live="polite"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/90 dark:text-amber-100 sm:text-sm lg:px-6"
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
