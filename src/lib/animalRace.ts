/**
 * Toán học trò "đua thú" (/quayso — trò chơi thứ hai bên cạnh vòng xoay).
 *
 * CÙNG MỘT LUẬT VỚI BÁNH XE: server đã chốt đội trúng (`lucky_draw_v1`), client
 * chỉ diễn lại kết quả đó cho đẹp. Nên bất biến quan trọng nhất ở đây giống hệt
 * bất biến "kim dừng đúng ô" của `luckyWheel.ts`:
 *
 *   → CON THÚ CỦA ĐỘI TRÚNG LUÔN VỀ NHẤT, với mọi nhịp khung hình.
 *
 * Cách bảo đảm: các làn KHÔNG trúng bị KẸP TRẦN ở `LEAD_CAP` (< 1) cho tới khi
 * làn trúng cán đích. Không dựa vào "chạy nhanh hơn" — vì `dt` do trình duyệt
 * quyết, một khung hình rớt dài (tab ẩn, máy yếu) đủ để một con khác nhảy qua
 * vạch trước. Kẹp trần là bất biến cứng, tốc độ chỉ còn là chuyện thẩm mỹ.
 *
 * Mô hình vận tốc (mượn từ bản thiết kế "Quay Live Đêm Tổng Kết"):
 *   v = (1 - p) / (finishAt - t)      → tự hiệu chỉnh để cán đích đúng giờ đã định
 *   v *= (1 + surge)                  → nhấp nhô sin cho ra dáng đua, tắt dần về cuối
 * Làn trúng còn bị ghìm bớt trong 60% đầu để nó bứt lên ở đoạn cuối, không dẫn
 * một mạch từ đầu (dẫn từ đầu là lộ đáp án, mất hết hồi hộp). Tính ra thì nó
 * vượt lên dẫn đầu vào khoảng 80% chặng đường.
 *
 * BA CÁI BẪY ĐÃ TRẢ GIÁ, đừng gỡ:
 *
 *  1. `FINISH_EPS` — công thức `p += k*(1-p)` KHÔNG BAO GIỜ chạm 1 trong số
 *     thực dấu phẩy động: tới khi `1-p` nhỏ hơn nửa ulp (5.6e-17) thì phép cộng
 *     làm tròn về đúng `p` cũ và vòng lặp đứng yên vĩnh viễn ở
 *     0.9999999999999999. Triệu chứng ở người dùng: con thú dừng SÁT vạch, kết
 *     quả không bao giờ công bố. Phải snap về 1 khi đã đủ gần.
 *
 *  2. Sau khi làn trúng về, các làn khác PHẢI chạy tiếp về đích chứ không đóng
 *     băng tại chỗ. Đóng băng làm cả đàn đứng chết giữa đường trong lúc pháo
 *     giấy nổ — nhìn như web treo.
 *
 *  3. `RacePlan` là BẤT BIẾN, mọi thứ thay đổi theo thời gian nằm ở `RaceState`.
 *     Nếu nhét cờ "đã báo tăng tốc" vào plan thì bấm "xem lại" lần hai sẽ mất
 *     sạch lời bình, vì plan đã bị bước chạy trước làm bẩn.
 */

/** Trần tiến độ của làn KHÔNG trúng khi làn trúng còn chạy. */
export const LEAD_CAP = 0.93;

/** Nhịp khung hình tối đa được nạp vào một bước (giây). Tab ẩn → dt khổng lồ. */
export const MAX_STEP = 0.05;

/**
 * Còn cách vạch dưới ngần này thì coi như đã tới. Xem bẫy #1 ở đầu file.
 * 1e-6 của chiều dài đường đua là dưới một phần nghìn pixel — mắt không thấy.
 */
export const FINISH_EPS = 1e-6;

/**
 * Bộ thú đua. 18 con, đủ khác nhau để nhìn lướt là phân biệt được — tránh mấy
 * con cùng bóng dáng (🐕/🐩, 🐂/🐃) đứng cạnh nhau trên đường đua nhỏ.
 *
 * Đường đua lật ngang con thú (`transform: scaleX(-1)`) để nó quay mặt về vạch
 * đích, vì hầu hết emoji động vật vẽ quay TRÁI. Vài con lại vẽ quay PHẢI và sau
 * khi lật thì thành chạy giật lùi — 🐘 đã bị loại vì lý do đó (đo trên Segoe UI
 * Emoji). Thêm con mới thì nhìn lại một lượt trước khi chốt.
 */
export const RACE_ANIMALS = [
  '🐎', '🐅', '🐆', '🐺', '🦌', '🐕', '🐇', '🦘', '🐖',
  '🐓', '🦆', '🐢', '🐈', '🐐', '🦓', '🐄', '🦔', '🦙',
] as const;

/** FNV-1a 32-bit — nhỏ, không phụ thuộc thư viện, đủ tản cho id dạng uuid. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Gán con thú cho từng đội — ỔN ĐỊNH theo id đội, và KHÔNG TRÙNG trong cùng một
 * sự kiện (khi số đội ≤ 18).
 *
 * Vì sao không chỉ `RACE_ANIMALS[hash % 18]`: 9 đội thì xác suất có ít nhất một
 * cặp trùng đã ~90% (nghịch lý ngày sinh). Hai đội cùng con 🐎 trên đường đua là
 * lỗi nhìn thấy được ngay.
 *
 * Vì sao duyệt theo id đã SẮP XẾP chứ không theo thứ tự hiển thị: thứ tự đội đổi
 * theo `top_rank`/thời điểm tạo, đội điểm danh sau chen vào giữa sẽ làm con thú
 * của người khác nhảy lung tung giữa hai lần tải trang. Sắp xếp rồi mới gán thì
 * chỉ khi DANH SÁCH ĐỘI đổi mới có thể đổi, và cũng chỉ đổi ở đội bị trùng chỗ.
 */
export function assignAnimals(teamIds: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const n = RACE_ANIMALS.length;
  const taken = new Set<number>();
  for (const id of [...teamIds].sort()) {
    let slot = hashId(id) % n;
    // Ô đã có chủ → dò tuyến tính sang phải. Quá 18 đội thì cho phép trùng lại,
    // vẫn hơn là bỏ trống làn.
    for (let k = 0; k < n && taken.has(slot); k++) slot = (slot + 1) % n;
    taken.add(slot);
    out[id] = RACE_ANIMALS[slot];
  }
  return out;
}

export interface RaceLane {
  /** Giây kể từ lúc xuất phát mà làn này chạm vạch (nếu không bị kẹp trần). */
  finishAt: number;
  /** Pha + tần số của sóng nhấp nhô, cho mỗi con một nhịp chạy riêng. */
  phase: number;
  freq: number;
}

export interface RaceBoost {
  lane: number;
  /** Giây bắt đầu tăng tốc. */
  at: number;
}

/** BẤT BIẾN sau khi dựng — xem bẫy #3 ở đầu file. */
export interface RacePlan {
  readonly count: number;
  /** Chỉ số làn của đội server đã chốt. */
  readonly winner: number;
  /** Làn về nhì — dùng để bắt khoảnh khắc "sát nút". */
  readonly runnerUp: number;
  /** Giây làn trúng cán đích. */
  readonly winnerFinish: number;
  /** Lượt này có dàn cảnh cảnh sát nút hay không (không phải lượt nào cũng nên có). */
  readonly photoFinish: boolean;
  readonly lanes: readonly RaceLane[];
  readonly boosts: readonly RaceBoost[];
}

export interface RaceState {
  /** Đồng hồ cuộc đua (giây), đã tính cả hệ số quay chậm. */
  t: number;
  progress: number[];
  /** Giây cán đích thực tế, null = chưa về. */
  finishedAt: (number | null)[];
  /** Giây mà hiệu ứng ⚡ của làn này tắt (0 = không có). */
  boostUntil: number[];
  /** Cú tăng tốc thứ k đã phát lời bình chưa. */
  boostAnnounced: boolean[];
}

export interface RaceStepResult {
  /** Làn vừa chạm vạch trong bước này, theo thứ tự về đích. */
  finished: number[];
  /** Làn vừa bắt đầu tăng tốc trong bước này. */
  boosted: number[];
  /** Làn trúng đã về chưa. */
  winnerHome: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Dựng kịch bản một lượt đua.
 *
 * @param count    số làn (số đội đã điểm danh trên đường đua)
 * @param winner   chỉ số làn của đội trúng — server đã chốt
 * @param seconds  độ dài mong muốn của cuộc đua
 * @param rng      nguồn ngẫu nhiên, tiêm được để test
 */
export function makeRacePlan(
  count: number,
  winner: number,
  seconds: number,
  rng: () => number = Math.random,
): RacePlan {
  const n = Math.max(1, Math.floor(count));
  const win = clamp(Math.floor(winner), 0, n - 1);
  // Dưới 8s không kịp thấy gì; trên 45s là người xem bỏ đi.
  const total = clamp(seconds, 8, 45);
  // Trừ hao 4s cho khoảnh khắc ăn mừng ở cuối (đếm ngược nằm ngoài đồng hồ này).
  const T = Math.max(6, total - 4);

  const lanes: RaceLane[] = [];
  for (let i = 0; i < n; i++) {
    lanes.push({
      // Làn thua "định" về sau làn trúng 6–24%. Vì bị kẹp ở LEAD_CAP nên con số
      // này thực chất điều khiển việc chúng bám sát tới đâu.
      finishAt: i === win ? T : T * (1.06 + rng() * 0.18),
      phase: rng() * Math.PI * 2,
      freq: 1.2 + rng() * 1.6,
    });
  }

  // Về nhì = làn thua có finishAt nhỏ nhất. Một mình một làn thì tự nó về nhì.
  let runnerUp = win;
  for (let i = 0; i < n; i++) {
    if (i === win) continue;
    if (runnerUp === win || lanes[i].finishAt < lanes[runnerUp].finishAt) runnerUp = i;
  }

  // Không phải lượt nào cũng sát nút — lượt nào cũng "nín thở" thì hết nín thở.
  const photoFinish = n > 1 && runnerUp !== win && rng() < 0.55;
  if (photoFinish) lanes[runnerUp].finishAt = T * 1.014;

  const boosts: RaceBoost[] = [];
  const used = new Set<number>();
  const nBoost = Math.min(n, 2 + Math.floor(rng() * 2));
  for (let k = 0; k < nBoost; k++) {
    let lane = Math.floor(rng() * n) % n;
    for (let g = 0; g < n && used.has(lane); g++) lane = (lane + 1) % n;
    if (used.has(lane)) break;
    used.add(lane);
    boosts.push({ lane, at: T * (0.15 + rng() * 0.55) });
  }

  return { count: n, winner: win, runnerUp, winnerFinish: T, photoFinish, lanes, boosts };
}

/** Trạng thái lúc cả đàn còn ở vạch xuất phát. */
export function initialRaceState(plan: RacePlan): RaceState {
  return {
    t: 0,
    progress: Array<number>(plan.count).fill(0),
    finishedAt: Array<number | null>(plan.count).fill(null),
    boostUntil: Array<number>(plan.count).fill(0),
    boostAnnounced: Array<boolean>(plan.boosts.length).fill(false),
  };
}

/** Làn trúng đã chạm vạch chưa. */
export function winnerHome(plan: RacePlan, st: RaceState): boolean {
  return st.finishedAt[plan.winner] != null;
}

/** Cả đàn đã về hết chưa (dùng để tắt tiếng vó chạy). */
export function allHome(st: RaceState): boolean {
  return st.finishedAt.every((f) => f != null);
}

/**
 * Đẩy cuộc đua đi `dt` giây. MUTATE `st` tại chỗ (mỗi khung hình một lần, tránh
 * cấp phát mảng mới 60 lần/giây trên máy yếu) và trả về những gì vừa xảy ra để
 * lớp giao diện phát tiếng / đổi lời bình. `plan` KHÔNG bị chạm tới.
 */
export function stepRace(plan: RacePlan, st: RaceState, dtRaw: number): RaceStepResult {
  const dt = clamp(Number.isFinite(dtRaw) ? dtRaw : 0, 0, MAX_STEP);
  st.t += dt;
  const t = st.t;
  const { winner, winnerFinish: T, lanes } = plan;

  // Đọc MỘT LẦN trước vòng lặp: nếu đọc trong vòng lặp thì làn trúng cán đích ở
  // giữa bước sẽ nhả trần cho những làn xử lý SAU nó ngay trong cùng khung hình,
  // và chúng có thể cùng chạm vạch ở bước đó — hoà với đội trúng.
  const homeAlready = st.finishedAt[winner] != null;

  const finished: number[] = [];
  const boosted: number[] = [];

  for (let i = 0; i < plan.count; i++) {
    if (st.finishedAt[i] != null) continue;
    const p = st.progress[i];
    const lane = lanes[i];

    const tLeft = Math.max(0.05, lane.finishAt - t);
    const v = (1 - p) / tLeft;

    // Biên độ nhấp nhô tắt dần về cuối — cuối đường ai cũng chạy thẳng.
    const env = Math.max(0, 1 - t / T);
    let surge = Math.sin(t * lane.freq + lane.phase) * 0.32 * env;

    // Ghìm làn trúng ở nửa đầu để nó bứt lên đoạn cuối.
    if (i === winner && t < T * 0.6) surge -= 0.22;

    for (let k = 0; k < plan.boosts.length; k++) {
      const b = plan.boosts[k];
      if (b.lane !== i || t < b.at || t >= b.at + 1.2) continue;
      surge += 0.75;
      st.boostUntil[i] = b.at + 1.2;
      if (!st.boostAnnounced[k]) {
        st.boostAnnounced[k] = true;
        boosted.push(i);
      }
    }

    // (1 + surge) không bao giờ ≤ 0: đáy là 1 - 0.32 - 0.22 = 0.46.
    let np = p + v * (1 + surge) * dt;

    // ── Bất biến: làn thua không được vượt vạch trước làn trúng ──
    // Sau khi làn trúng về thì nhả trần cho chúng chạy nốt về đích (bẫy #2).
    if (i !== winner && !homeAlready) np = Math.min(np, LEAD_CAP);

    np = clamp(np, p, 1);
    // Bẫy #1: snap, nếu không thì kẹt ở 1-ulp mãi mãi.
    if (np > 1 - FINISH_EPS) np = 1;
    st.progress[i] = np;

    if (np >= 1) {
      st.finishedAt[i] = t;
      finished.push(i);
    }
  }

  return { finished, boosted, winnerHome: st.finishedAt[winner] != null };
}

/**
 * Khoảnh khắc "sát nút": làn trúng sắp chạm vạch mà con về nhì còn bám dính.
 * Dùng để bật quay-chậm + chớp đèn flash. Chỉ đúng MỘT lần mỗi lượt đua nên
 * bên gọi tự nhớ đã dùng chưa.
 */
export function isPhotoFinish(plan: RacePlan, st: RaceState): boolean {
  if (!plan.photoFinish) return false;
  if (st.finishedAt[plan.winner] != null) return false;
  const w = st.progress[plan.winner];
  if (w < 0.9) return false;
  const gap = w - st.progress[plan.runnerUp];
  return gap < 0.045 && gap > -0.02;
}

/** Làn đang dẫn đầu trong số các làn CHƯA về (−1 = cả đàn đã về). */
export function leaderLane(st: RaceState): number {
  let best = -1;
  for (let i = 0; i < st.progress.length; i++) {
    if (st.finishedAt[i] != null) continue;
    if (best === -1 || st.progress[i] > st.progress[best]) best = i;
  }
  return best;
}
