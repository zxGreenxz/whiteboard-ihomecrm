/**
 * Đường đua thú — trò chơi thứ hai của /quayso, dùng chung cho trang điểm danh
 * `/quayso/<slug>` và màn chiếu `/quayso/<slug>/quay`.
 *
 * HỢP ĐỒNG GIỐNG `LuckyWheelCanvas`: server đã chốt kết quả, component chỉ diễn
 * lại. Khác một điểm — một lượt có thể có NHIỀU SUẤT, nên nhận `winnerIds` là
 * MẢNG đã xếp theo thứ hạng thay vì một id. Toán học ở `src/lib/animalRace.ts`
 * (có property test cho bất biến thứ hạng).
 *
 * BỐN QUYẾT ĐỊNH VỀ LUỒNG, đều có lý do:
 *
 *  1. ĐÓNG BĂNG DANH SÁCH VÉ LÚC XUẤT PHÁT. Trang cha poll 4 giây một lần; một
 *     vé điểm danh muộn xen vào giữa cuộc đua sẽ làm lệch toàn bộ chỉ số làn so
 *     với `RacePlan` — con đang dẫn đầu bỗng đổi tên, và tệ hơn là chỉ số vé
 *     trúng trỏ sang vé khác. Chụp ảnh danh sách một lần rồi chạy trên bản chụp.
 *
 *  2. CÔNG BỐ NGAY KHI ĐỦ SỐ SUẤT, không chờ cả đàn về. Đàn còn lại chạy nốt về
 *     vạch trong lúc pháo giấy đã nổ — giống trường đua thật.
 *
 *  3. MỘT ĐỒNG HỒ CHO CẢ HÌNH LẪN TIẾNG. Đếm ngược lấy mốc từ `performance.now()`
 *     trong vòng RAF, còn tiếng bíp đặt lịch trên đồng hồ âm thanh tại đúng
 *     khoảnh khắc đó. Không dùng `setInterval` cho bất cứ thứ gì phải khớp nhịp.
 *
 *  4. SAU KHI CÔNG BỐ THÌ NGƯNG BÌNH LUẬN. Vòng lặp còn sống thêm vài giây cho
 *     đàn thua về nốt; để `talk()` chạy tiếp thì lời bình bị ghi đè thành
 *     "<vé thua> băng băng về đích!" ngay dưới tấm bảng ghi tên vé trúng.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  allHome,
  assignAnimals,
  initialRaceState,
  isPhotoFinish,
  leaderLane,
  makeRacePlan,
  medalFor,
  stepRace,
  type RacePlan,
  type RaceState,
} from '@/lib/animalRace';
import type { LuckyTeamPublic } from '@/lib/luckyDrawApi';
import { RaceAudio } from './raceAudio';

/* Tên ô localStorage nhớ lựa chọn bật/tắt tiếng. KHÔNG đặt tên hằng kết thúc
   bằng `_KEY`: luật `generic-api-key` của gitleaks bắt đúng mẫu `*KEY = '<chuỗi
   dài>'` và báo dương tính giả, phải khai fingerprint vào `.gitleaksignore`
   vĩnh viễn vì lịch sử commit không xoá được. */
const MUTE_PREF = 'qs_race_muted_v1';

/** Số làn tối đa còn chia đều vừa khung; hơn thì làn co lại và cho cuộn. */
const LANES_FIT = 12;

export interface AnimalRaceTrackProps {
  /** Vé trên đường đua — đã lọc `inWheel` + `checkedIn` ở trang cha. */
  teams: LuckyTeamPublic[];
  /** Vé trúng của LƯỢT NÀY, xếp theo thứ hạng (hạng nhất trước). Server đã chốt. */
  winnerIds: string[];
  /** Đổi giá trị = chạy một lượt đua. null = đứng yên chờ. */
  spinToken: string | null;
  /** Gọi ĐÚNG MỘT LẦN mỗi lượt, ngay khi suất cuối của lượt cán đích. */
  onSpinDone: () => void;
  /** Độ dài cuộc đua (giây), tính cả đoạn ăn mừng. */
  seconds?: number;
  /** Nhãn giải của lượt này, hiện trong lời bình và huy hiệu (vd "100K"). */
  prizeLabel?: string;
  /** Huy hiệu vé đã trúng ở CÁC LƯỢT TRƯỚC — `{ teamId: ['🥇100K', …] }`. */
  priorBadges?: Record<string, string[]>;
  /** Màn chiếu: làn cao hơn, chữ to hơn. */
  big?: boolean;
}

type Phase = 'idle' | 'countdown' | 'racing' | 'done';

interface Snapshot {
  teams: LuckyTeamPublic[];
  animals: Record<string, string>;
  plan: RacePlan;
  state: RaceState;
  /** Nhãn hiển thị của từng làn, dựng sẵn để khỏi ghép chuỗi mỗi khung hình. */
  labels: string[];
}

function docReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** "HK 302 · 1392QT" — vé không khai sale thì chỉ hiện tên. */
export function veLabel(t: LuckyTeamPublic): string {
  const sale = t.sale?.trim();
  return sale ? `${t.name} · ${sale}` : t.name;
}

export default function AnimalRaceTrack({
  teams,
  winnerIds,
  spinToken,
  onSpinDone,
  seconds = 20,
  prizeLabel = '',
  priorBadges,
  big = false,
}: AnimalRaceTrackProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const [commentary, setCommentary] = useState('Đàn thú đang vào vạch xuất phát…');
  const [flash, setFlash] = useState(false);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTE_PREF) !== '0';
    } catch {
      return true;
    }
  });
  /** Bản chụp danh sách vé đang chạy — null = đang hiển thị danh sách sống. */
  const [frozen, setFrozen] = useState<LuckyTeamPublic[] | null>(null);
  /** Thứ hạng đã trao trong lượt NÀY: `{ teamId: pos }`. */
  const [wonNow, setWonNow] = useState<Record<string, number>>({});

  const trackRef = useRef<HTMLDivElement | null>(null);
  const runnerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const chipRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const boltRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const animalRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const flashTimerRef = useRef(0);

  const rafRef = useRef(0);
  const snapRef = useRef<Snapshot | null>(null);
  const ranForRef = useRef<string | null>(null);
  const doneCalledRef = useRef<string | null>(null);
  const lastTsRef = useRef(0);
  const timeScaleRef = useRef(1);
  const photoUsedRef = useRef(false);
  const nextTalkRef = useRef(0);
  const prevLeaderRef = useRef(-1);
  const audioRef = useRef<RaceAudio | null>(null);
  const onDoneRef = useRef(onSpinDone);
  onDoneRef.current = onSpinDone;

  if (audioRef.current == null) audioRef.current = new RaceAudio();

  /** Danh sách đang vẽ: bản chụp khi đua, danh sách sống khi rảnh. */
  const shown = frozen ?? teams;
  // Tất định theo danh sách id, nên bản chụp và danh sách sống cho cùng kết quả.
  const animals = useMemo(() => assignAnimals(shown.map((t) => t.id)), [shown]);

  /* ── Tiếng: dọn khi rời trang ── */
  useEffect(() => {
    const a = audioRef.current;
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.clearTimeout(flashTimerRef.current);
      a?.dispose();
    };
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      audioRef.current?.setMuted(next);
      try {
        localStorage.setItem(MUTE_PREF, next ? '1' : '0');
      } catch {
        /* chế độ riêng tư chặn — vẫn chạy trong phiên */
      }
      return next;
    });
  }, []);

  /* ── Vẽ một khung hình: đặt transform thẳng lên DOM, KHÔNG qua React ── */
  const paint = useCallback(() => {
    const snap = snapRef.current;
    const track = trackRef.current;
    if (!snap || !track) return;
    const { state, plan } = snap;
    const lead = leaderLane(state);

    for (let i = 0; i < snap.teams.length; i++) {
      const el = runnerRefs.current[i];
      if (!el) continue;
      const lane = el.parentElement;
      if (!lane) continue;
      // Chừa chỗ cho vạch đích kẻ caro bên phải (20px) + lề.
      const max = Math.max(0, lane.clientWidth - el.offsetWidth - 30);
      el.style.transform = `translate(${state.progress[i] * max}px,-50%)`;

      const veDich = state.finishedAt[i] != null;
      // Trạng thái cán đích của TỪNG làn, phơi ra DOM. Không phải hook cho test
      // cho vui: bất biến "công bố ngay khi đủ suất, không chờ cả đàn" chỉ chứng
      // minh được nếu nhìn thấy lúc công bố CÒN LÀN NÀO CHƯA VỀ. Đo gián tiếp
      // bằng khoảng cách pixel thì phụ thuộc nhịp khung hình — dưới tải, ảnh
      // chụp trễ vài khung là khoảng cách co lại và bài đỏ vì máy chậm.
      el.dataset.veDich = veDich ? '1' : '0';

      const bolt = boltRefs.current[i];
      if (bolt) bolt.style.opacity = state.t < state.boostUntil[i] ? '1' : '0';

      // Con NÀO còn chạy thì con đó nhấp nhô. Gắn theo `phase` chung thì lúc
      // công bố cả đàn đứng đơ giữa đường trong khi vẫn đang trườn về vạch.
      const an = animalRefs.current[i];
      if (an) an.classList.toggle('qs-lane-run', !veDich);

      const chip = chipRefs.current[i];
      if (chip) {
        // Vàng chỉ dành cho con ĐANG DẪN ĐẦU và con TRÚNG GIẢI. Cho mọi con cán
        // đích đều vàng thì lúc cả đàn về hết, vé trúng chìm nghỉm giữa đám đông.
        const trung = plan.rank[i] >= 0 && veDich;
        chip.classList.toggle('qs-lane-hot', i === lead || trung);
        chip.classList.toggle('qs-lane-home', trung);
      }
    }

    // Nhiều vé → khung cuộn được; kéo theo con dẫn đầu để không mất dấu.
    if (snap.teams.length > LANES_FIT && lead >= 0) {
      const el = runnerRefs.current[lead];
      const laneEl = el?.parentElement;
      if (laneEl) {
        const want = laneEl.offsetTop - track.clientHeight / 2 + laneEl.clientHeight / 2;
        track.scrollTop += (want - track.scrollTop) * 0.12;
      }
    }
  }, []);

  /* ── Lời bình: đổi chậm thôi, đọc không kịp thì thành nhiễu ── */
  const talk = useCallback((snap: Snapshot) => {
    const { state, plan, labels } = snap;
    if (state.t < nextTalkRef.current) return;
    nextTalkRef.current = state.t + 2.4;
    const lead = leaderLane(state);
    if (lead < 0) return;
    const emo = snap.animals[snap.teams[lead].id];
    const ten = labels[lead];
    let msg: string;
    if (state.t > plan.winnerFinish * 0.78) {
      msg = `🏁 Nước rút! ${emo} ${ten} băng băng về đích!`;
    } else if (prevLeaderRef.current >= 0 && prevLeaderRef.current !== lead) {
      msg = `Đổi ngôi! ${emo} ${ten} vươn lên dẫn đầu!`;
    } else {
      msg = [
        `${emo} ${ten} đang dẫn đầu!`,
        `${emo} ${ten} giữ ngôi đầu — phía sau bám sát!`,
        'Cả đàn so kè quyết liệt! 🔥',
      ][Math.floor(Math.random() * 3)];
    }
    prevLeaderRef.current = lead;
    setCommentary(msg);
  }, []);

  /* ── Vòng lặp cuộc đua ── */
  const loop = useCallback(() => {
    rafRef.current = requestAnimationFrame((ts) => {
      const snap = snapRef.current;
      if (!snap) return;
      const audio = audioRef.current;
      const dt = ((ts - lastTsRef.current) / 1000) * timeScaleRef.current;
      lastTsRef.current = ts;

      const r = stepRace(snap.plan, snap.state, dt);
      const { plan, state, labels } = snap;
      const soSuat = plan.winners.length;

      // Tiếng khớp hình: phát NGAY trong khung hình phát hiện sự kiện.
      for (const lane of r.boosted) {
        audio?.boost();
        // Đã công bố rồi thì chỉ còn tiếng, KHÔNG đổi chữ nữa (quyết định #4).
        if (r.allWinnersHome) continue;
        setCommentary(`⚡ ${snap.animals[snap.teams[lane].id]} ${labels[lane]} tăng tốc bất ngờ!`);
        nextTalkRef.current = state.t + 1.6;
      }

      audio?.setTension(state.progress[leaderLane(state)] ?? 1);

      // Sát nút: quay chậm + chớp flash + trống dồn, đúng một lần.
      if (!photoUsedRef.current && isPhotoFinish(plan, state)) {
        photoUsedRef.current = true;
        timeScaleRef.current = 0.34;
        audio?.suspense();
        setFlash(true);
        setCommentary('📸 SÁT NÚT — nín thở…');
        nextTalkRef.current = state.t + 3;
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => {
          timeScaleRef.current = 1;
          setFlash(false);
        }, 1100);
      }

      // Mỗi suất cán đích: báo tiếng + ghi thứ hạng.
      if (r.wonNow.length) {
        const moi: Record<string, number> = {};
        for (const w of r.wonNow) {
          moi[snap.teams[w.lane].id] = w.pos;
          const md = medalFor(w.pos, soSuat);
          const emo = snap.animals[snap.teams[w.lane].id];
          setCommentary(
            `${md} ${emo} ${labels[w.lane]} cán đích${prizeLabel ? ` — ăn ${prizeLabel}!` : '!'}`,
          );
        }
        setWonNow((cu) => ({ ...cu, ...moi }));
        audio?.finish();
        nextTalkRef.current = state.t + 1.4;
      }

      if (r.allWinnersHome) {
        // ── Đủ suất là CÔNG BỐ, không chờ đàn còn lại (quyết định #2) ──
        if (doneCalledRef.current !== ranForRef.current) {
          doneCalledRef.current = ranForRef.current;
          audio?.cheer();
          audio?.stopRace();
          setPhase('done');
          onDoneRef.current();
        }
      } else {
        talk(snap);
      }

      paint();

      if (allHome(state)) {
        audio?.stopRace();
        return; // cả đàn đã về — thôi đốt khung hình
      }
      loop();
    });
  }, [paint, talk, prizeLabel]);

  /* ── Khởi động một lượt đua khi `spinToken` đổi ── */
  useEffect(() => {
    if (!spinToken || spinToken === ranForRef.current) return;
    const live = teams;
    const idx = winnerIds
      .map((id) => live.findIndex((t) => t.id === id))
      .filter((i) => i >= 0);
    // Chưa có kết quả (server chưa chốt) hoặc vé trúng không có trên đường đua
    // → không chạy, thà đứng yên còn hơn diễn sai kết quả.
    if (!idx.length || live.length === 0) return;

    ranForRef.current = spinToken;
    cancelAnimationFrame(rafRef.current);

    const audio = audioRef.current;
    audio?.setMuted(muted);

    // Đóng băng danh sách (quyết định #1).
    const snapTeams = [...live];
    const plan = makeRacePlan(
      snapTeams.length,
      idx,
      docReducedMotion() ? 9 : seconds,
    );
    const snap: Snapshot = {
      teams: snapTeams,
      animals: assignAnimals(snapTeams.map((t) => t.id)),
      plan,
      state: initialRaceState(plan),
      labels: snapTeams.map(veLabel),
    };
    snapRef.current = snap;
    setFrozen(snapTeams);
    setWonNow({});

    timeScaleRef.current = 1;
    photoUsedRef.current = false;
    nextTalkRef.current = 0;
    prevLeaderRef.current = -1;
    setFlash(false);
    setPhase('countdown');
    setCount(3);
    setCommentary(
      `${snapTeams.length} vé vào vạch xuất phát — ${idx.length} suất${prizeLabel ? ` ${prizeLabel}` : ''}…`,
    );
    requestAnimationFrame(() => paint());

    // Đếm ngược: tiếng đặt lịch trên đồng hồ âm thanh, hình chạy trên RAF, cả
    // hai lấy mốc từ CÙNG một khoảnh khắc nên không lệch (quyết định #3).
    audio?.countdown(3);
    const t0 = performance.now();
    const tickDown = () => {
      rafRef.current = requestAnimationFrame((ts) => {
        const el = (ts - t0) / 1000;
        if (el >= 3) {
          setCount(0);
          setPhase('racing');
          setCommentary('XUẤT PHÁT! 🏁 Cả đàn lao đi!');
          audio?.startRace();
          lastTsRef.current = performance.now();
          loop();
          return;
        }
        setCount(3 - Math.floor(el));
        tickDown();
      });
    };
    tickDown();
  }, [spinToken, teams, winnerIds, seconds, muted, prizeLabel, paint, loop]);

  /* ── Vẽ lại khi đổi kích thước ── */
  useEffect(() => {
    const onRz = () => paint();
    window.addEventListener('resize', onRz);
    return () => window.removeEventListener('resize', onRz);
  }, [paint]);

  const soSuat = winnerIds.length;

  return (
    <div className={`qs-race ${big ? 'qs-race-big' : ''}`}>
      <div className="qs-race-bar">
        <span className="qs-race-tag">
          {shown.length} vé · {phase === 'idle'
            ? 'chờ xuất phát'
            : phase === 'countdown'
              ? 'chuẩn bị'
              : phase === 'racing'
                ? 'đang đua'
                : 'đã về đích'}
        </span>
        <button
          type="button"
          className="qs-race-mute"
          onClick={toggleMute}
          aria-label={muted ? 'Bật âm thanh trường đua' : 'Tắt âm thanh trường đua'}
          aria-pressed={!muted}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      </div>

      <div
        className={`qs-track ${shown.length > LANES_FIT ? 'qs-track-scroll' : ''}`}
        ref={trackRef}
      >
        <div className="qs-track-grid" aria-hidden="true" />
        <div className="qs-track-finish" aria-hidden="true" />

        {shown.length === 0 ? (
          <p className="qs-track-empty">Chưa có vé nào điểm danh — đường đua còn trống.</p>
        ) : (
          shown.map((t, i) => {
            const pos = wonNow[t.id];
            const cu = priorBadges?.[t.id] ?? [];
            const nhan = [...cu, ...(pos != null ? [`${medalFor(pos, soSuat)}${prizeLabel}`] : [])];
            return (
              <div className="qs-lane" key={t.id}>
                <span className="qs-lane-no" aria-hidden="true">L{i + 1}</span>
                <div
                  className="qs-runner"
                  ref={(el) => {
                    runnerRefs.current[i] = el;
                  }}
                >
                  <span
                    className="qs-lane-bolt"
                    aria-hidden="true"
                    ref={(el) => {
                      boltRefs.current[i] = el;
                    }}
                  >
                    ⚡
                  </span>
                  {nhan.length > 0 && <span className="qs-lane-badge">{nhan.join(' ')}</span>}
                  <span
                    className="qs-lane-chip"
                    ref={(el) => {
                      chipRefs.current[i] = el;
                    }}
                  >
                    {veLabel(t)}
                  </span>
                  <span
                    className="qs-lane-animal"
                    ref={(el) => {
                      animalRefs.current[i] = el;
                    }}
                  >
                    {animals[t.id] ?? '🐎'}
                  </span>
                </div>
              </div>
            );
          })
        )}

        {phase === 'countdown' && (
          <div className="qs-track-count" aria-hidden="true">
            <span>{count > 0 ? count : 'GO!'}</span>
          </div>
        )}
        {flash && <div className="qs-track-flash" aria-hidden="true">📸 Photo finish</div>}
      </div>

      <p className="qs-race-say" role="status">
        <span aria-hidden="true">📣</span> {commentary}
      </p>
    </div>
  );
}
