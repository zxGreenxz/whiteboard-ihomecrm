/**
 * Toán học trò "đua thú" (/quayso — trò chơi thứ hai bên cạnh vòng xoay).
 *
 * CÙNG MỘT LUẬT VỚI BÁNH XE: server đã chốt danh sách vé trúng cho lượt này
 * (`lucky_draw_round_v1`), client chỉ diễn lại. Nên bất biến quan trọng nhất ở
 * đây giống hệt bất biến "kim dừng đúng ô" của `luckyWheel.ts`, chỉ mạnh hơn vì
 * một lượt có thể có nhiều giải:
 *
 *   → CÁC VÉ TRÚNG VỀ ĐÍCH ĐÚNG THỨ HẠNG SERVER ĐÃ CHỐT, TRƯỚC MỌI VÉ KHÁC,
 *     với mọi nhịp khung hình.
 *
 * Cách bảo đảm — DÂY CHUYỀN KẸP TRẦN, không dựa vào "chạy nhanh hơn":
 *   · Vé hạng r chỉ được vượt `LEAD_CAP` khi mọi hạng 0..r-1 ĐÃ về.
 *   · Vé không trúng chỉ được vượt trần khi TẤT CẢ vé trúng đã về.
 * `dt` do trình duyệt quyết; một khung hình rớt dài (tab ẩn, máy yếu) đủ để con
 * khác nhảy qua vạch trước. Trần là bất biến cứng, tốc độ chỉ còn là thẩm mỹ.
 *
 * Mô hình vận tốc (mượn từ bản thiết kế "Quay Live Đêm Tổng Kết"):
 *   v = (1 - p) / (finishAt - t)      → tự hiệu chỉnh để cán đích đúng giờ đã định
 *   v *= (1 + surge)                  → nhấp nhô sin cho ra dáng đua, tắt dần về cuối
 * Vé trúng còn bị ghìm bớt trong 60% đầu để bứt lên ở đoạn cuối, không dẫn một
 * mạch từ đầu (dẫn từ đầu là lộ đáp án, mất hết hồi hộp).
 *
 * BA CÁI BẪY ĐÃ TRẢ GIÁ, đừng gỡ:
 *
 *  1. `FINISH_EPS` — công thức `p += k*(1-p)` KHÔNG BAO GIỜ chạm 1 trong số
 *     thực dấu phẩy động: tới khi `1-p` nhỏ hơn nửa ulp (5.6e-17) thì phép cộng
 *     làm tròn về đúng `p` cũ và vòng lặp đứng yên vĩnh viễn ở
 *     0.9999999999999999. Triệu chứng ở người dùng: con thú dừng SÁT vạch, kết
 *     quả không bao giờ công bố. Phải snap về 1 khi đã đủ gần.
 *
 *  2. Sau khi vé trúng cuối cùng về, đàn còn lại PHẢI chạy tiếp về đích chứ
 *     không đóng băng tại chỗ. Đóng băng làm cả đàn đứng chết giữa đường trong
 *     lúc pháo giấy nổ — nhìn như web treo.
 *
 *  3. `RacePlan` là BẤT BIẾN, mọi thứ thay đổi theo thời gian nằm ở `RaceState`.
 *     Nếu nhét cờ "đã báo tăng tốc" vào plan thì bấm "xem lại" lần hai sẽ mất
 *     sạch lời bình, vì plan đã bị bước chạy trước làm bẩn.
 */

/** Trần tiến độ của làn CHƯA tới lượt được về đích. */
export const LEAD_CAP = 0.93;

/** Nhịp khung hình tối đa được nạp vào một bước (giây). Tab ẩn → dt khổng lồ. */
export const MAX_STEP = 0.05;

/**
 * Còn cách vạch dưới ngần này thì coi như đã tới. Xem bẫy #1 ở đầu file.
 * 1e-6 của chiều dài đường đua là dưới một phần nghìn pixel — mắt không thấy.
 */
export const FINISH_EPS = 1e-6;

/** Khoảng cách giữa hai vé trúng liên tiếp khi cán đích (giây). */
const KHOANG_HANG = 0.9;

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

/** Huy chương theo thứ hạng trong một lượt. */
export const MEDALS = ['🥇', '🥈', '🥉'] as const;

/** Huy chương cho hạng `pos` (0-based); quá 3 thì dùng số. */
export function medalFor(pos: number, total: number): string {
  if (total === 1) return '🏆';
  return MEDALS[pos] ?? `#${pos + 1}`;
}

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
 * Gán con thú cho từng vé — ỔN ĐỊNH theo id vé, và KHÔNG TRÙNG trong cùng một
 * sự kiện (khi số vé ≤ 18).
 *
 * Vì sao không chỉ `RACE_ANIMALS[hash % 18]`: 9 vé thì xác suất có ít nhất một
 * cặp trùng đã ~90% (nghịch lý ngày sinh). Hai vé cùng con 🐎 trên đường đua là
 * lỗi nhìn thấy được ngay.
 *
 * Vì sao duyệt theo id đã SẮP XẾP chứ không theo thứ tự hiển thị: thứ tự vé đổi
 * theo `top_rank`/thời điểm tạo, vé điểm danh sau chen vào giữa sẽ làm con thú
 * của người khác nhảy lung tung giữa hai lần tải trang. Sắp xếp rồi mới gán thì
 * chỉ khi DANH SÁCH VÉ đổi mới có thể đổi, và cũng chỉ đổi ở vé bị trùng chỗ.
 */
export function assignAnimals(teamIds: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const n = RACE_ANIMALS.length;
  const taken = new Set<number>();
  for (const id of [...teamIds].sort()) {
    let slot = hashId(id) % n;
    // Ô đã có chủ → dò tuyến tính sang phải. Quá 18 vé thì cho phép trùng lại,
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
  /** Làn của các vé trúng, THEO ĐÚNG THỨ HẠNG server đã chốt (hạng nhất trước). */
  readonly winners: readonly number[];
  /**
   * `rank[lane]` = thứ hạng trong danh sách trúng, hoặc -1 nếu không trúng.
   * Tra bảng thay vì `indexOf` — vòng lặp chạy 60 lần/giây × số làn.
   */
  readonly rank: readonly number[];
  /** Làn về ngay sau vé trúng cuối — dùng để bắt khoảnh khắc "sát nút". */
  readonly runnerUp: number;
  /** Giây vé trúng ĐẦU TIÊN cán đích. */
  readonly winnerFinish: number;
  /** Giây vé trúng CUỐI CÙNG cán đích — mốc kết thúc phần hồi hộp. */
  readonly lastWinnerFinish: number;
  /** Lượt này có dàn cảnh sát nút hay không (không phải lượt nào cũng nên có). */
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
  /** Bao nhiêu vé trúng đã về — con trỏ của dây chuyền kẹp trần. */
  winnersHome: number;
}

export interface RaceStepResult {
  /** Làn vừa chạm vạch trong bước này, theo thứ tự về đích. */
  finished: number[];
  /** Vé TRÚNG vừa chạm vạch trong bước này (kèm thứ hạng). */
  wonNow: { lane: number; pos: number }[];
  /** Làn vừa bắt đầu tăng tốc trong bước này. */
  boosted: number[];
  /** Đã đủ số vé trúng của lượt này chưa — mốc CÔNG BỐ. */
  allWinnersHome: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Lọc danh sách làn trúng về dạng dùng được: bỏ trùng, bỏ ngoài miền, cắt bớt
 * nếu nhiều hơn số làn. Rỗng thì lấy làn 0 — thà diễn sai một lượt còn hơn treo
 * cuộc đua vì không ai được phép qua vạch.
 */
function chuanHoaWinners(winners: readonly number[], count: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const w of winners) {
    const i = Math.floor(w);
    if (!Number.isFinite(i) || i < 0 || i >= count || seen.has(i)) continue;
    seen.add(i);
    out.push(i);
    if (out.length >= count) break;
  }
  return out.length ? out : [0];
}

/**
 * Dựng kịch bản một lượt đua.
 *
 * @param count    số làn (số vé đã điểm danh trên đường đua)
 * @param winners  làn của các vé trúng, THEO THỨ HẠNG — server đã chốt
 * @param seconds  độ dài mong muốn của cuộc đua
 * @param rng      nguồn ngẫu nhiên, tiêm được để test
 */
export function makeRacePlan(
  count: number,
  winners: readonly number[],
  seconds: number,
  rng: () => number = Math.random,
): RacePlan {
  const n = Math.max(1, Math.floor(count));
  const Ws = chuanHoaWinners(winners, n);

  // Dưới 8s không kịp thấy gì; trên 45s là người xem bỏ đi.
  const total = clamp(seconds, 8, 45);
  // Trừ hao 4s cho khoảnh khắc ăn mừng, cộng thời gian giãn hạng.
  const T = Math.max(6, total - 4 - (Ws.length - 1) * KHOANG_HANG);
  const lastT = T + (Ws.length - 1) * KHOANG_HANG;

  const rank: number[] = Array<number>(n).fill(-1);
  Ws.forEach((lane, pos) => { rank[lane] = pos; });

  const lanes: RaceLane[] = [];
  for (let i = 0; i < n; i++) {
    const r = rank[i];
    lanes.push({
      // Vé thua "định" về sau vé trúng cuối 6–24%. Vì bị kẹp trần nên con số
      // này thực chất điều khiển việc chúng bám sát tới đâu.
      finishAt: r >= 0 ? T + r * KHOANG_HANG : lastT * (1.06 + rng() * 0.18),
      phase: rng() * Math.PI * 2,
      freq: 1.2 + rng() * 1.6,
    });
  }

  // Về ngay sau vé trúng cuối = vé thua có finishAt nhỏ nhất.
  let runnerUp = -1;
  for (let i = 0; i < n; i++) {
    if (rank[i] >= 0) continue;
    if (runnerUp === -1 || lanes[i].finishAt < lanes[runnerUp].finishAt) runnerUp = i;
  }

  // Không phải lượt nào cũng sát nút — lượt nào cũng "nín thở" thì hết nín thở.
  const photoFinish = runnerUp !== -1 && rng() < 0.55;
  if (photoFinish) lanes[runnerUp].finishAt = lastT * 1.014;

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

  return {
    count: n,
    winners: Ws,
    rank,
    runnerUp: runnerUp === -1 ? Ws[Ws.length - 1] : runnerUp,
    winnerFinish: T,
    lastWinnerFinish: lastT,
    photoFinish,
    lanes,
    boosts,
  };
}

/** Trạng thái lúc cả đàn còn ở vạch xuất phát. */
export function initialRaceState(plan: RacePlan): RaceState {
  return {
    t: 0,
    progress: Array<number>(plan.count).fill(0),
    finishedAt: Array<number | null>(plan.count).fill(null),
    boostUntil: Array<number>(plan.count).fill(0),
    boostAnnounced: Array<boolean>(plan.boosts.length).fill(false),
    winnersHome: 0,
  };
}

/** Đã đủ số vé trúng của lượt này chưa — mốc được phép CÔNG BỐ. */
export function allWinnersHome(plan: RacePlan, st: RaceState): boolean {
  return st.winnersHome >= plan.winners.length;
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
  const { rank, winnerFinish: T, lanes } = plan;
  const soTrung = plan.winners.length;

  // Đọc MỘT LẦN trước vòng lặp: nếu đọc trong vòng lặp thì một vé cán đích ở
  // giữa bước sẽ nới trần cho những làn xử lý SAU nó ngay trong cùng khung hình,
  // và chúng có thể cùng chạm vạch ở bước đó — hoà, mất thứ hạng.
  const daVe = st.winnersHome;

  const finished: number[] = [];
  const wonNow: { lane: number; pos: number }[] = [];
  const boosted: number[] = [];

  for (let i = 0; i < plan.count; i++) {
    if (st.finishedAt[i] != null) continue;
    const p = st.progress[i];
    const lane = lanes[i];
    const r = rank[i];

    const tLeft = Math.max(0.05, lane.finishAt - t);
    const v = (1 - p) / tLeft;

    // Biên độ nhấp nhô tắt dần về cuối — cuối đường ai cũng chạy thẳng.
    const env = Math.max(0, 1 - t / T);
    let surge = Math.sin(t * lane.freq + lane.phase) * 0.32 * env;

    // Ghìm vé trúng ở nửa đầu để nó bứt lên đoạn cuối.
    if (r >= 0 && t < T * 0.6) surge -= 0.22;

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

    // ── DÂY CHUYỀN KẸP TRẦN — bất biến thứ hạng ──
    // Hạng r chỉ qua vạch được khi đủ r vé hạng trên đã về; vé thua (r = -1)
    // phải chờ hết. Nhờ vậy mỗi bước tối đa MỘT vé trúng cán đích, đúng thứ tự.
    const duocQuaVach = r >= 0 ? daVe >= r : daVe >= soTrung;
    if (!duocQuaVach) np = Math.min(np, LEAD_CAP);

    np = clamp(np, p, 1);
    // Bẫy #1: snap, nếu không thì kẹt ở 1-ulp mãi mãi.
    if (np > 1 - FINISH_EPS) np = 1;
    st.progress[i] = np;

    if (np >= 1) {
      st.finishedAt[i] = t;
      finished.push(i);
      if (r >= 0) {
        st.winnersHome++;
        wonNow.push({ lane: i, pos: r });
      }
    }
  }

  return { finished, wonNow, boosted, allWinnersHome: st.winnersHome >= soTrung };
}

/**
 * Khoảnh khắc "sát nút": vé trúng cuối sắp chạm vạch mà con bám sau còn dính.
 * Dùng để bật quay-chậm + chớp đèn flash. Chỉ đúng MỘT lần mỗi lượt đua nên
 * bên gọi tự nhớ đã dùng chưa.
 */
export function isPhotoFinish(plan: RacePlan, st: RaceState): boolean {
  if (!plan.photoFinish) return false;
  const cuoi = plan.winners[plan.winners.length - 1];
  if (st.finishedAt[cuoi] != null) return false;
  // Chỉ nín thở ở suất CUỐI: các suất trước còn giải phía sau, chưa phải cao trào.
  if (st.winnersHome < plan.winners.length - 1) return false;
  const w = st.progress[cuoi];
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
