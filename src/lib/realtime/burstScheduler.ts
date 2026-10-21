// =============================================================
// Nhịp gom sự kiện cho các kênh realtime NGOÀI hub (Network Center, Zalo).
// (21/10/2026, plan realtime + thông báo, A7/A8 — RT-OTHER-1/3.)
//
// Ba tính chất mà hai kênh đó đều thiếu:
//   1. TRẦN CHỜ. Debounce trailing thuần bị đẩy lùi vô hạn khi bão kéo dài
//      (giờ cao điểm Zalo ~24 tin/phút; debounce 400 ms gần như không gộp được
//      gì mà cũng không có mốc nhả muộn nhất).
//   2. TAB ẨN THÌ CHỈ GIỮ CỜ. invalidateQueries → refetchQueries của TanStack
//      không xét focus: tab ẩn vẫn refetch theo từng cụm (NC ~21 RPC mỗi nhịp tim,
//      Zalo ~2 MB mỗi tin). Ẩn ⇒ đánh dấu "có việc chờ", hiện lại ⇒ nhả MỘT lần.
//   3. DỌN KHÔNG LÀM RƠI VIỆC. Cleanup cũ chỉ clearTimeout nên cập nhật của 5 s
//      cuối trước khi đổi toà/đổi hội thoại bị bỏ; nay dispose({ flush: true }).
//
// Bộ này chỉ giữ NHỊP — dữ liệu chờ (toà nào, key nào) do người gọi tự gom,
// `flush` đọc chúng lúc nhả.
// =============================================================

export interface BurstSchedulerOptions {
  /** Im lặng chừng này sau event cuối thì nhả. */
  debounceMs: number;
  /** Mốc muộn nhất tính từ event ĐẦU của cụm. */
  maxWaitMs: number;
  flush: () => void;
}

export interface BurstScheduler {
  /** Có event: đánh dấu chờ và (nếu tab đang hiện) hẹn nhả. */
  poke(): void;
  /** Bỏ việc đang chờ — dùng khi một lượt bắt kịp đã phủ mọi thứ. */
  cancel(): void;
  dispose(options?: { flush?: boolean }): void;
}

function tabDangAn(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function createBurstScheduler(options: BurstSchedulerOptions): BurstScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mocDauCum = 0;
  let dangCho = false;
  let disposed = false;

  const huyTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const nha = () => {
    timer = undefined;
    if (!dangCho || disposed) return;
    // Tab ẩn đi sau khi đã hẹn: giữ cờ, đợi visibilitychange.
    if (tabDangAn()) return;
    dangCho = false;
    options.flush();
  };

  const hen = (delay: number) => {
    huyTimer();
    timer = setTimeout(nha, Math.max(0, delay));
  };

  const onVisibility = () => {
    if (disposed || tabDangAn() || !dangCho) return;
    // Tab vừa hiện lại với việc tồn: nhả ngay một lần cho cả quãng ẩn.
    hen(0);
  };
  const coDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";
  if (coDocument) document.addEventListener("visibilitychange", onVisibility);

  return {
    poke() {
      if (disposed) return;
      const bayGio = Date.now();
      if (!dangCho) mocDauCum = bayGio;
      dangCho = true;
      if (tabDangAn()) {
        huyTimer();
        return;
      }
      hen(Math.min(options.debounceMs, mocDauCum + options.maxWaitMs - bayGio));
    },
    cancel() {
      huyTimer();
      dangCho = false;
    },
    dispose({ flush = false } = {}) {
      if (disposed) return;
      huyTimer();
      if (coDocument) document.removeEventListener("visibilitychange", onVisibility);
      const conViec = dangCho;
      dangCho = false;
      disposed = true;
      if (flush && conViec) options.flush();
    },
  };
}
