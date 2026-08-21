import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FINISH_EPS,
  LEAD_CAP,
  MAX_STEP,
  RACE_ANIMALS,
  allHome,
  assignAnimals,
  hashId,
  initialRaceState,
  isPhotoFinish,
  leaderLane,
  makeRacePlan,
  stepRace,
  winnerHome,
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

describe('animalRace — con thú của đội trúng phải về nhất', () => {
  it('property: mọi (số làn, làn trúng, độ dài, nhịp khung hình) đều cho làn trúng về đầu tiên', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 29 }),
        fc.double({ min: 8, max: 45, noNaN: true }),
        fc.integer({ min: 1, max: 0xffffffff }),
        // Nhịp khung hình xấu: 240Hz cho tới 10Hz giật cục.
        fc.double({ min: 0.004, max: 0.1, noNaN: true }),
        (count, winSeed, seconds, seed, dt) => {
          const winner = winSeed % count;
          const plan = makeRacePlan(count, winner, seconds, seeded(seed));
          const st = initialRaceState(plan);
          const order = runToEnd(plan, st, () => dt);
          expect(order).toHaveLength(count);
          expect(order[0]).toBe(plan.winner);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('property: nhịp khung hình NGẪU NHIÊN từng bước (máy giật) cũng không đổi người thắng', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 0, max: 19 }),
        fc.integer({ min: 1, max: 0xffffffff }),
        (count, winSeed, seed) => {
          const plan = makeRacePlan(count, winSeed % count, 20, seeded(seed));
          const st = initialRaceState(plan);
          const jitter = seeded(seed ^ 0x5bf03635);
          expect(runToEnd(plan, st, () => 0.002 + jitter() * 0.3)[0]).toBe(plan.winner);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('một khung hình dài bất thường (tab ẩn 30 giây) vẫn không cho làn thua vượt trước', () => {
    const plan = makeRacePlan(9, 4, 20, seeded(7));
    const st = initialRaceState(plan);
    const r = stepRace(plan, st, 30);
    expect(r.finished).toEqual([]);
    // Đồng hồ đua chỉ nhích đúng một bước tối đa, không nhảy 30 giây.
    expect(st.t).toBeCloseTo(MAX_STEP, 10);
    expect(runToEnd(plan, st, () => 0.016)[0]).toBe(4);
  });

  it('dt rác (NaN, âm, vô cực) không làm vỡ trạng thái', () => {
    const plan = makeRacePlan(6, 2, 20, seeded(13));
    const st = initialRaceState(plan);
    for (const bad of [NaN, -5, Infinity, -Infinity]) {
      stepRace(plan, st, bad);
      expect(Number.isFinite(st.t)).toBe(true);
      expect(st.progress.every(Number.isFinite)).toBe(true);
    }
    expect(runToEnd(plan, st, () => 0.016)[0]).toBe(2);
  });

  it('làn thua bị kẹp ở LEAD_CAP chừng nào làn trúng chưa về', () => {
    const plan = makeRacePlan(9, 3, 20, seeded(99));
    const st = initialRaceState(plan);
    while (!winnerHome(plan, st) && st.t < 400) {
      stepRace(plan, st, 0.016);
      for (let i = 0; i < plan.count; i++) {
        if (i === plan.winner) continue;
        expect(st.progress[i]).toBeLessThanOrEqual(LEAD_CAP + 1e-12);
      }
    }
    expect(winnerHome(plan, st)).toBe(true);
  });

  it('property: tiến độ luôn trong [0,1] và không bao giờ lùi', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 1, max: 0xffffffff }),
        (count, seed) => {
          const plan = makeRacePlan(count, seed % count, 16, seeded(seed));
          const st = initialRaceState(plan);
          const prev = [...st.progress];
          // Kiểm bằng biến cờ chứ không gọi expect() trong vòng lặp nóng:
          // 60 kịch bản × ~1500 bước × 16 làn là 1,4 triệu lời gọi, đủ để test
          // chạy quá 5 giây rồi timeout — đỏ vì CHẬM chứ không phải vì SAI.
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
    // Tái hiện đúng phép tính trong stepRace khi đã quá vạch thời gian:
    // v = (1-p)/0.05, dt = 0.016 → p += 0.32·(1-p). Không có FINISH_EPS thì kẹt.
    let p = 0;
    for (let k = 0; k < 100000; k++) {
      const np = p + 0.32 * (1 - p);
      if (np === p) break;
      p = np;
    }
    expect(p).toBeLessThan(1);
    expect(1 - p).toBeLessThan(FINISH_EPS);

    // Còn stepRace thì phải về được đích thật.
    const plan = makeRacePlan(3, 0, 12, seeded(5));
    const st = initialRaceState(plan);
    runToEnd(plan, st, () => 0.016);
    expect(st.progress[0]).toBe(1);
  });

  it('LUỒNG CHƠI: đội trúng cán đích là công bố được NGAY, không chờ cả đàn về', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const plan = makeRacePlan(9, seed % 9, 20, seeded(seed));
      const st = initialRaceState(plan);
      let tCongBo: number | null = null;
      while (!allHome(st) && st.t < 200) {
        const r = stepRace(plan, st, 0.016);
        if (r.winnerHome && tCongBo == null) {
          tCongBo = st.t;
          // Đúng khoảnh khắc công bố, các con khác vẫn đang chạy (chưa về hết)
          // — nghĩa là công bố không phải chờ ai.
          expect(st.finishedAt.filter((f) => f == null).length).toBeGreaterThan(0);
          expect(r.finished).toContain(plan.winner);
        }
      }
      expect(tCongBo).not.toBeNull();
      // Và đàn còn lại về nốt sau đó — không đứng chết giữa đường.
      expect(allHome(st)).toBe(true);
      expect(st.t).toBeGreaterThan(tCongBo as number);
    }
  });

  it('cuộc đua kết thúc trong khoảng thời gian đã hẹn, không kéo lê vô tận', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const plan = makeRacePlan(9, seed % 9, 20, seeded(seed));
      const st = initialRaceState(plan);
      runToEnd(plan, st, () => 0.016);
      // Đặt 20s → làn trúng về quanh giây thứ 16 (trừ hao 4s ăn mừng).
      const tWin = st.finishedAt[plan.winner];
      expect(tWin).not.toBeNull();
      expect(tWin as number).toBeGreaterThan(10);
      expect(tWin as number).toBeLessThan(24);
      // Con về bét cũng không lê quá 8 giây sau đội trúng.
      expect(Math.max(...(st.finishedAt as number[]))).toBeLessThan((tWin as number) + 8);
    }
  });

  it('một mình một làn thì vẫn về đích (sự kiện chỉ có 1 đội điểm danh)', () => {
    const plan = makeRacePlan(1, 0, 12, seeded(3));
    const st = initialRaceState(plan);
    expect(runToEnd(plan, st, () => 0.016)).toEqual([0]);
    expect(isPhotoFinish(plan, st)).toBe(false);
    expect(plan.photoFinish).toBe(false);
  });

  it('tham số ngoài miền bị kẹp thay vì làm vỡ cuộc đua', () => {
    const plan = makeRacePlan(0, 99, 0.1, seeded(5));
    expect(plan.count).toBe(1);
    expect(plan.winner).toBe(0);
    expect(plan.winnerFinish).toBeGreaterThanOrEqual(6);

    const dai = makeRacePlan(5, 2, 9999, seeded(5));
    expect(dai.winnerFinish).toBeLessThanOrEqual(41);
  });

  it('RacePlan bất biến: chạy xong rồi dựng state mới là đua lại y hệt (nút "xem lại")', () => {
    const plan = makeRacePlan(9, 6, 20, seeded(42));
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
    expect(chay()).toEqual(lan1);           // lượt hai giống hệt lượt một
    expect(lan1.filter((m) => m.startsWith('boost:')).length).toBe(plan.boosts.length);
  });

  it('leaderLane bỏ qua làn đã về, hết người chạy thì trả -1', () => {
    const plan = makeRacePlan(4, 1, 12, seeded(11));
    const st = initialRaceState(plan);
    expect(leaderLane(st)).toBe(0); // hoà 0 hết → làn đầu tiên
    runToEnd(plan, st, () => 0.016);
    expect(leaderLane(st)).toBe(-1);
  });

  it('mỗi cú tăng tốc chỉ báo MỘT lần dù kéo dài nhiều khung hình', () => {
    const plan = makeRacePlan(9, 0, 20, seeded(21));
    const st = initialRaceState(plan);
    const dem = new Map<number, number>();
    while (!allHome(st) && st.t < 200) {
      for (const l of stepRace(plan, st, 0.016).boosted) dem.set(l, (dem.get(l) ?? 0) + 1);
    }
    expect(dem.size).toBeGreaterThan(0);
    for (const [, lan] of dem) expect(lan).toBe(1);
  });

  it('sát nút chỉ xảy ra ở lượt được dàn cảnh, và chỉ ở đoạn cuối', () => {
    let coDanCanh = 0;
    let khongDanCanh = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const plan = makeRacePlan(9, seed % 9, 20, seeded(seed));
      const st = initialRaceState(plan);
      let batGap = false;
      while (!allHome(st) && st.t < 200) {
        stepRace(plan, st, 0.016);
        if (isPhotoFinish(plan, st)) {
          batGap = true;
          expect(plan.photoFinish).toBe(true);
          expect(st.progress[plan.winner]).toBeGreaterThanOrEqual(0.9);
        }
      }
      if (plan.photoFinish) coDanCanh++;
      else {
        khongDanCanh++;
        expect(batGap).toBe(false);
      }
    }
    // Không phải lượt nào cũng nín thở — nếu luôn có thì mất hết giá trị.
    expect(coDanCanh).toBeGreaterThan(0);
    expect(khongDanCanh).toBeGreaterThan(0);
  });
});

describe('animalRace — gán con thú', () => {
  it('không đội nào trùng con thú khi số đội ≤ số con thú', () => {
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

  it('vượt quá số con thú thì cho phép trùng, nhưng vẫn gán đủ mọi đội', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `team-${i}`);
    const map = assignAnimals(ids);
    expect(Object.keys(map)).toHaveLength(40);
    for (const id of ids) expect(RACE_ANIMALS).toContain(map[id]);
  });

  it('ổn định: cùng danh sách đội thì cùng kết quả, thứ tự truyền vào không đổi gì', () => {
    const ids = ['c', 'a', 'b', 'd', 'e'];
    const lan1 = assignAnimals(ids);
    expect(assignAnimals([...ids].reverse())).toEqual(lan1);
  });

  it('thêm một đội mới không làm xáo trộn con thú của các đội cũ khi chưa đụng ô', () => {
    const cu = ['aaa', 'bbb', 'ccc'];
    const truoc = assignAnimals(cu);
    const sau = assignAnimals([...cu, 'zzz']);
    for (const id of cu) {
      // Chỉ được đổi nếu đội mới cướp đúng ô — với 3 đội/18 ô thì hiếm.
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
