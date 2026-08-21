import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FINISH_EPS,
  LEAD_CAP,
  MAX_STEP,
  RACE_ANIMALS,
  allHome,
  allWinnersHome,
  assignAnimals,
  hashId,
  initialRaceState,
  isPhotoFinish,
  leaderLane,
  makeRacePlan,
  medalFor,
  stepRace,
  type RacePlan,
  type RaceState,
} from '../animalRace';

/** Bộ sinh số giả ngẫu nhiên tất định (mulberry32) — cùng seed, cùng kịch bản. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bốc `k` làn khác nhau trong `n` làn, tất định theo seed. */
function bocWinners(n: number, k: number, seed: number): number[] {
  const rng = seeded(seed);
  const ds = Array.from({ length: n }, (_, i) => i);
  for (let i = ds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ds[i], ds[j]] = [ds[j], ds[i]];
  }
  return ds.slice(0, Math.min(k, n));
}

/** Chạy tới khi cả đàn về đích. Trả về thứ tự về đích. */
function runToEnd(
  plan: RacePlan,
  st: RaceState,
  dtOf: (step: number) => number,
  maxSeconds = 400,
): number[] {
  const order: number[] = [];
  let step = 0;
  while (st.t < maxSeconds && order.length < plan.count) {
    order.push(...stepRace(plan, st, dtOf(step++)).finished);
  }
  return order;
}

describe('animalRace — thứ hạng về đích phải đúng như server đã chốt', () => {
  it('property: mọi (số làn, số giải, độ dài, nhịp khung hình) đều ra ĐÚNG THỨ HẠNG', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 6 }),
        fc.double({ min: 8, max: 45, noNaN: true }),
        fc.integer({ min: 1, max: 0xffffffff }),
        // Nhịp khung hình xấu: 240Hz cho tới 10Hz giật cục.
        fc.double({ min: 0.004, max: 0.1, noNaN: true }),
        (count, soGiai, seconds, seed, dt) => {
          const Ws = bocWinners(count, soGiai, seed);
          const plan = makeRacePlan(count, Ws, seconds, seeded(seed));
          const st = initialRaceState(plan);
          const order = runToEnd(plan, st, () => dt);
          expect(order).toHaveLength(count);
          // Đúng k người đầu tiên, ĐÚNG THỨ TỰ.
          expect(order.slice(0, plan.winners.length)).toEqual([...plan.winners]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: nhịp khung hình NGẪU NHIÊN từng bước (máy giật) cũng không đổi thứ hạng', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 0xffffffff }),
        (count, soGiai, seed) => {
          const plan = makeRacePlan(count, bocWinners(count, soGiai, seed), 20, seeded(seed));
          const st = initialRaceState(plan);
          const jitter = seeded(seed ^ 0x5bf03635);
          const order = runToEnd(plan, st, () => 0.002 + jitter() * 0.3);
          expect(order.slice(0, plan.winners.length)).toEqual([...plan.winners]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('mỗi bước tối đa MỘT vé trúng cán đích — không bao giờ hoà hạng', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = makeRacePlan(9, bocWinners(9, 3, seed), 20, seeded(seed));
      const st = initialRaceState(plan);
      while (!allHome(st) && st.t < 200) {
        const r = stepRace(plan, st, 0.05);
        expect(r.wonNow.length, 'hai vé trúng cùng cán đích một khung hình').toBeLessThanOrEqual(1);
      }
      expect(st.winnersHome).toBe(3);
    }
  });

  it('wonNow báo đúng thứ hạng, theo đúng trình tự 0,1,2…', () => {
    const plan = makeRacePlan(9, [7, 2, 5], 22, seeded(4));
    const st = initialRaceState(plan);
    const thuTu: { lane: number; pos: number }[] = [];
    while (!allHome(st) && st.t < 200) thuTu.push(...stepRace(plan, st, 0.016).wonNow);
    expect(thuTu).toEqual([
      { lane: 7, pos: 0 },
      { lane: 2, pos: 1 },
      { lane: 5, pos: 2 },
    ]);
  });

  it('một khung hình dài bất thường (tab ẩn 30 giây) không phá thứ hạng', () => {
    const plan = makeRacePlan(9, [4, 1], 20, seeded(7));
    const st = initialRaceState(plan);
    const r = stepRace(plan, st, 30);
    expect(r.finished).toEqual([]);
    expect(st.t).toBeCloseTo(MAX_STEP, 10);
    expect(runToEnd(plan, st, () => 0.016).slice(0, 2)).toEqual([4, 1]);
  });

  it('dt rác (NaN, âm, vô cực) không làm vỡ trạng thái', () => {
    const plan = makeRacePlan(6, [2, 4], 20, seeded(13));
    const st = initialRaceState(plan);
    for (const bad of [NaN, -5, Infinity, -Infinity]) {
      stepRace(plan, st, bad);
      expect(Number.isFinite(st.t)).toBe(true);
      expect(st.progress.every(Number.isFinite)).toBe(true);
    }
    expect(runToEnd(plan, st, () => 0.016).slice(0, 2)).toEqual([2, 4]);
  });

  it('vé chưa tới lượt bị kẹp ở LEAD_CAP — kể cả vé trúng hạng dưới', () => {
    const plan = makeRacePlan(9, [3, 6, 0], 20, seeded(99));
    const st = initialRaceState(plan);
    let hong = '';
    while (!allWinnersHome(plan, st) && st.t < 400) {
      const daVe = st.winnersHome;
      stepRace(plan, st, 0.016);
      for (let i = 0; i < plan.count; i++) {
        const r = plan.rank[i];
        const duocQua = r >= 0 ? daVe >= r : daVe >= plan.winners.length;
        if (!duocQua && st.progress[i] > LEAD_CAP + 1e-12) {
          hong = `làn ${i} (hạng ${r}) vượt trần khi mới ${daVe} vé về`;
        }
      }
      if (hong) break;
    }
    expect(hong).toBe('');
    expect(allWinnersHome(plan, st)).toBe(true);
  });

  it('property: tiến độ luôn trong [0,1] và không bao giờ lùi', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 0xffffffff }),
        (count, soGiai, seed) => {
          const plan = makeRacePlan(count, bocWinners(count, soGiai, seed), 16, seeded(seed));
          const st = initialRaceState(plan);
          const prev = [...st.progress];
          // Kiểm bằng biến cờ chứ không gọi expect() trong vòng lặp nóng:
          // hàng triệu lời gọi đủ để test timeout — đỏ vì CHẬM chứ không phải vì SAI.
          let hong = '';
          while (!allHome(st) && st.t < 120) {
            stepRace(plan, st, 0.016);
            for (let i = 0; i < count; i++) {
              const p = st.progress[i];
              if (!(p >= prev[i] && p >= 0 && p <= 1)) hong = `làn ${i}: ${prev[i]} → ${p}`;
              prev[i] = p;
            }
            if (hong) break;
          }
          expect(hong).toBe('');
          expect(allHome(st)).toBe(true);
        },
      ),
      { numRuns: 120 },
    );
  });

  it('BẪY DẤU PHẨY ĐỘNG: p += k·(1−p) không tự chạm 1 — phải snap, nếu không đua treo', () => {
    let p = 0;
    for (let k = 0; k < 100000; k++) {
      const np = p + 0.32 * (1 - p);
      if (np === p) break;
      p = np;
    }
    expect(p).toBeLessThan(1);
    expect(1 - p).toBeLessThan(FINISH_EPS);

    const plan = makeRacePlan(3, [0], 12, seeded(5));
    const st = initialRaceState(plan);
    runToEnd(plan, st, () => 0.016);
    expect(st.progress[0]).toBe(1);
  });

  it('LUỒNG CHƠI: đủ số giải là công bố được NGAY, không chờ cả đàn về', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const plan = makeRacePlan(9, bocWinners(9, 3, seed), 20, seeded(seed));
      const st = initialRaceState(plan);
      let tCongBo: number | null = null;
      while (!allHome(st) && st.t < 200) {
        const r = stepRace(plan, st, 0.016);
        if (r.allWinnersHome && tCongBo == null) {
          tCongBo = st.t;
          // Đúng khoảnh khắc công bố, đàn thua vẫn đang chạy.
          expect(st.finishedAt.filter((f) => f == null).length).toBeGreaterThan(0);
        }
      }
      expect(tCongBo).not.toBeNull();
      expect(allHome(st)).toBe(true);
      expect(st.t).toBeGreaterThan(tCongBo as number);
    }
  });

  it('cuộc đua kết thúc trong khoảng thời gian đã hẹn, không kéo lê vô tận', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const Ws = bocWinners(9, 3, seed);
      const plan = makeRacePlan(9, Ws, 20, seeded(seed));
      const st = initialRaceState(plan);
      runToEnd(plan, st, () => 0.016);
      const tCuoi = st.finishedAt[Ws[Ws.length - 1]] as number;
      expect(tCuoi).not.toBeNull();
      // 20s: T = 20 - 4 - 2×0.9 = 14.2, vé cuối về quanh 16.
      expect(tCuoi).toBeGreaterThan(9);
      expect(tCuoi).toBeLessThan(24);
      expect(Math.max(...(st.finishedAt as number[]))).toBeLessThan(tCuoi + 8);
    }
  });

  it('số giải bằng số làn: mọi vé đều trúng, vẫn đúng thứ hạng', () => {
    const plan = makeRacePlan(4, [3, 1, 0, 2], 20, seeded(8));
    const st = initialRaceState(plan);
    expect(runToEnd(plan, st, () => 0.016)).toEqual([3, 1, 0, 2]);
  });

  it('một mình một làn thì vẫn về đích (sự kiện chỉ có 1 vé điểm danh)', () => {
    const plan = makeRacePlan(1, [0], 12, seeded(3));
    const st = initialRaceState(plan);
    expect(runToEnd(plan, st, () => 0.016)).toEqual([0]);
    expect(isPhotoFinish(plan, st)).toBe(false);
  });

  it('danh sách trúng bẩn (trùng, âm, ngoài miền, rỗng) bị lọc thay vì làm vỡ', () => {
    const p1 = makeRacePlan(5, [2, 2, -1, 99, 3], 20, seeded(5));
    expect(p1.winners).toEqual([2, 3]);

    const p2 = makeRacePlan(5, [], 20, seeded(5));
    expect(p2.winners).toEqual([0]);

    const p3 = makeRacePlan(0, [9], 0.1, seeded(5));
    expect(p3.count).toBe(1);
    expect(p3.winners).toEqual([0]);
    expect(p3.winnerFinish).toBeGreaterThanOrEqual(6);

    const p4 = makeRacePlan(5, [1], 9999, seeded(5));
    expect(p4.winnerFinish).toBeLessThanOrEqual(41);
  });

  it('RacePlan bất biến: dựng state mới là đua lại y hệt (nút "xem lại")', () => {
    const plan = makeRacePlan(9, [6, 1], 20, seeded(42));
    const goc = JSON.stringify(plan);

    const chay = () => {
      const st = initialRaceState(plan);
      const moc: string[] = [];
      while (!allHome(st) && st.t < 200) {
        const r = stepRace(plan, st, 0.016);
        for (const l of r.boosted) moc.push(`boost:${l}@${st.t.toFixed(3)}`);
        for (const l of r.finished) moc.push(`fin:${l}@${st.t.toFixed(3)}`);
      }
      return moc;
    };

    const lan1 = chay();
    expect(JSON.stringify(plan)).toBe(goc); // stepRace không chạm vào plan
    expect(chay()).toEqual(lan1);
    expect(lan1.filter((m) => m.startsWith('boost:')).length).toBe(plan.boosts.length);
  });

  it('leaderLane bỏ qua làn đã về, hết người chạy thì trả -1', () => {
    const plan = makeRacePlan(4, [1], 12, seeded(11));
    const st = initialRaceState(plan);
    expect(leaderLane(st)).toBe(0);
    runToEnd(plan, st, () => 0.016);
    expect(leaderLane(st)).toBe(-1);
  });

  it('mỗi cú tăng tốc chỉ báo MỘT lần dù kéo dài nhiều khung hình', () => {
    const plan = makeRacePlan(9, [0, 4], 20, seeded(21));
    const st = initialRaceState(plan);
    const dem = new Map<number, number>();
    while (!allHome(st) && st.t < 200) {
      for (const l of stepRace(plan, st, 0.016).boosted) dem.set(l, (dem.get(l) ?? 0) + 1);
    }
    expect(dem.size).toBeGreaterThan(0);
    for (const [, lan] of dem) expect(lan).toBe(1);
  });

  it('sát nút chỉ xảy ra ở SUẤT CUỐI của lượt được dàn cảnh', () => {
    let coDanCanh = 0;
    let khongDanCanh = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const plan = makeRacePlan(9, bocWinners(9, 3, seed), 20, seeded(seed));
      const st = initialRaceState(plan);
      let batGap = false;
      while (!allHome(st) && st.t < 200) {
        stepRace(plan, st, 0.016);
        if (isPhotoFinish(plan, st)) {
          batGap = true;
          expect(plan.photoFinish).toBe(true);
          // Chỉ nín thở khi đã trao xong các suất trên.
          expect(st.winnersHome).toBe(plan.winners.length - 1);
        }
      }
      if (plan.photoFinish) coDanCanh++;
      else {
        khongDanCanh++;
        expect(batGap).toBe(false);
      }
    }
    expect(coDanCanh).toBeGreaterThan(0);
    expect(khongDanCanh).toBeGreaterThan(0);
  });

  it('huy chương: một giải thì cúp, nhiều giải thì vàng/bạc/đồng', () => {
    expect(medalFor(0, 1)).toBe('🏆');
    expect(medalFor(0, 3)).toBe('🥇');
    expect(medalFor(1, 3)).toBe('🥈');
    expect(medalFor(2, 3)).toBe('🥉');
    expect(medalFor(3, 5)).toBe('#4');
  });
});

describe('animalRace — gán con thú', () => {
  it('không vé nào trùng con thú khi số vé ≤ số con thú', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: RACE_ANIMALS.length }),
        (ids) => {
          const map = assignAnimals(ids);
          expect(Object.keys(map)).toHaveLength(ids.length);
          expect(new Set(Object.values(map)).size).toBe(ids.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('vượt quá số con thú thì cho phép trùng, nhưng vẫn gán đủ mọi vé', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `team-${i}`);
    const map = assignAnimals(ids);
    expect(Object.keys(map)).toHaveLength(40);
    for (const id of ids) expect(RACE_ANIMALS).toContain(map[id]);
  });

  it('ổn định: cùng danh sách vé thì cùng kết quả, thứ tự truyền vào không đổi gì', () => {
    const ids = ['c', 'a', 'b', 'd', 'e'];
    expect(assignAnimals([...ids].reverse())).toEqual(assignAnimals(ids));
  });

  it('thêm một vé mới không xáo trộn con thú của các vé cũ khi chưa đụng ô', () => {
    const cu = ['aaa', 'bbb', 'ccc'];
    const truoc = assignAnimals(cu);
    const sau = assignAnimals([...cu, 'zzz']);
    for (const id of cu) {
      if (sau[id] !== truoc[id]) expect(sau['zzz']).toBe(truoc[id]);
    }
  });

  it('hashId tất định và không âm', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const h = hashId(s);
        expect(h).toBe(hashId(s));
        expect(h).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(h)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});
