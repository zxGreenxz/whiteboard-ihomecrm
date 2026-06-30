// =============================================================================
// perfTrace — lưu vết hiệu năng nhẹ (không cần sửa từng call site).
//
// Dùng PerformanceObserver('resource') để đo MỌI request mạng tới Supabase
// (REST/RPC/auth/storage) ngay trên trình duyệt thật của người dùng:
//   - Cảnh báo console khi 1 request chậm > SLOW_MS (mặc định 1000ms).
//   - Giữ ring buffer 200 bản ghi gần nhất + bộ đếm tổng để đánh giá.
//
// Mục tiêu: có DỮ LIỆU đo lường cho các đợt tối ưu sau (đếm số query/trang,
// endpoint nào chậm/nhiều nhất) thay vì đoán. Chi phí gần như bằng 0
// (PerformanceObserver gom theo batch, không hook fetch).
//
// Cách xem trong DevTools Console:
//   __perfReport()   → bảng tổng hợp: số lần gọi, p50/p95/max, tổng thời gian theo endpoint
//   __perf           → 200 request gần nhất (mảng {label, ms, at})
//   __perfReset()    → xoá số liệu để đo lại 1 phiên mới
// =============================================================================

const SLOW_MS = 1000;
const RING_SIZE = 200;

interface PerfEntry {
  label: string; // ví dụ: "rest:invoices", "rpc:get_invoice_statistics_v2", "auth", "storage"
  url: string;
  ms: number;
  at: number; // performance.now() khi xong
}

interface Agg {
  count: number;
  total: number;
  max: number;
  samples: number[]; // để tính p50/p95 (giữ tối đa 500 mẫu/endpoint)
}

const ring: PerfEntry[] = [];
const agg = new Map<string, Agg>();
let started = false;

/** Suy nhãn endpoint gọn từ URL Supabase. */
function labelFor(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/supabase\.(co|in)|supabase\./.test(u.host) && !u.pathname.startsWith('/rest/') && !u.pathname.startsWith('/auth/') && !u.pathname.startsWith('/storage/')) {
      // Không phải request Supabase → bỏ qua (chỉ quan tâm DB/API).
      return null;
    }
    const p = u.pathname;
    if (p.includes('/rest/v1/rpc/')) return 'rpc:' + p.split('/rest/v1/rpc/')[1];
    if (p.includes('/rest/v1/')) return 'rest:' + (p.split('/rest/v1/')[1] || '').split('/')[0];
    if (p.includes('/auth/v1/')) return 'auth';
    if (p.includes('/storage/v1/')) return 'storage';
    return null;
  } catch {
    return null;
  }
}

function record(label: string, url: string, ms: number) {
  ring.push({ label, url, ms, at: Math.round(performance.now()) });
  if (ring.length > RING_SIZE) ring.shift();

  let a = agg.get(label);
  if (!a) {
    a = { count: 0, total: 0, max: 0, samples: [] };
    agg.set(label, a);
  }
  a.count += 1;
  a.total += ms;
  if (ms > a.max) a.max = ms;
  if (a.samples.length < 500) a.samples.push(ms);

  if (ms >= SLOW_MS) {
    // eslint-disable-next-line no-console
    console.warn(`[perf] CHẬM ${Math.round(ms)}ms — ${label}`);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

function report() {
  const rows = [...agg.entries()]
    .map(([label, a]) => {
      const s = [...a.samples].sort((x, y) => x - y);
      return {
        endpoint: label,
        calls: a.count,
        p50: percentile(s, 50),
        p95: percentile(s, 95),
        max: Math.round(a.max),
        total_ms: Math.round(a.total),
      };
    })
    .sort((x, y) => y.total_ms - x.total_ms);
  // eslint-disable-next-line no-console
  console.table(rows);
  return rows;
}

/** Khởi tạo 1 lần ở main.tsx. An toàn nếu trình duyệt không hỗ trợ. */
export function initPerfTrace(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  started = true;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        const label = labelFor(e.name);
        if (!label) continue;
        record(label, e.name, e.duration);
      }
    });
    obs.observe({ type: 'resource', buffered: true });
  } catch {
    // Trình duyệt cũ không hỗ trợ entrytype 'resource' → bỏ qua.
  }

  // Phơi helper ra window để xem trong DevTools Console.
  const w = window as any;
  w.__perf = ring;
  w.__perfReport = report;
  w.__perfReset = () => {
    ring.length = 0;
    agg.clear();
    // eslint-disable-next-line no-console
    console.info('[perf] đã reset số liệu');
  };
}
