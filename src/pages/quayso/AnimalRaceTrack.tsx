/**
 * Đường đua thú (canvas DOM) — trò chơi thứ hai của /quayso, dùng chung cho
 * trang điểm danh `/quayso/<slug>` và màn chiếu `/quayso/<slug>/quay`.
 *
 * HỢP ĐỒNG GIỐNG HỆT `LuckyWheelCanvas`: server đã chốt đội trúng, component
 * chỉ diễn lại. Đổi trò chơi không đổi luật chơi — cùng `spinToken`, cùng
 * `onSpinDone`, nên hai trang gọi chúng thay nhau được mà không sửa gì thêm.
 * Toán học nằm ở `src/lib/animalRace.ts` (có unit test).
 *
 * BA QUYẾT ĐỊNH VỀ LUỒNG, đều có lý do:
 *
 *  1. ĐÓNG BĂNG DANH SÁCH ĐỘI LÚC XUẤT PHÁT. Trang cha poll 4 giây một lần; một
 *     đội điểm danh muộn xen vào giữa cuộc đua sẽ làm lệch toàn bộ chỉ số làn so
 *     với `RacePlan` — con đang dẫn đầu bỗng đổi tên, và tệ hơn là chỉ số đội
 *     trúng trỏ sang đội khác. Chụp ảnh danh sách một lần rồi chạy trên bản chụp.
 *
 *  2. CÔNG BỐ NGAY KHI ĐỘI TRÚNG CÁN ĐÍCH, không chờ cả đàn về. Đàn còn lại chạy
 *     nốt về vạch trong lúc pháo giấy đã nổ — giống trường đua thật.
 *
 *  3. MỘT ĐỒNG HỒ CHO CẢ HÌNH LẪN TIẾNG. Đếm ngược lấy mốc từ `performance.now()`
 *     trong vòng RAF, còn tiếng bíp đặt lịch trên đồng hồ âm thanh tại đúng
 *     khoảnh khắc đó. Không dùng `setInterval` cho bất cứ thứ gì phải khớp nhịp.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  allHome,
  assignAnimals,
  initialRaceState,
  isPhotoFinish,
  leaderLane,
  makeRacePlan,
  stepRace,
  type RacePlan,
  type RaceState,
} from '@/lib/animalRace';
import type { LuckyTeamPublic } from '@/lib/luckyDrawApi';
import { RaceAudio } from './raceAudio';

const MUTE_KEY = 'qs_race_muted_v1';

/** Số làn tối đa còn chia đều vừa khung; hơn thì làn co lại và cho cuộn. */
const LANES_FIT = 12;

export interface AnimalRaceTrackProps {
  /** Đội trên đường đua — đã lọc `inWheel` + `checkedIn` ở trang cha. */
  teams: LuckyTeamPublic[];
  /** Server đã chốt → con thú của đội này về nhất. */
  winnerId: string | null;
  /** Đổi giá trị = chạy một lượt đua. null = đứng yên chờ. */
  spinToken: string | null;
  /** Gọi ĐÚNG MỘT LẦN mỗi lượt, ngay khi đội trúng cán đích. */
  onSpinDone: () => void;
  /** Độ dài cuộc đua (giây), tính cả đoạn ăn mừng. */
  seconds?: number;
  /** Màn chiếu: làn cao hơn, chữ to hơn. */
  big?: boolean;
}

type Phase = 'idle' | 'countdown' | 'racing' | 'done';

interface Snapshot {
  teams: LuckyTeamPublic[];
  animals: Record<string, string>;
  plan: RacePlan;
  state: RaceState;
}

function docReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function AnimalRaceTrack({
  teams,
  winnerId,
  spinToken,
  onSpinDone,
  seconds = 20,
  big = false,
}: AnimalRaceTrackProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const [commentary, setCommentary] = useState('Đàn thú đang vào vạch xuất phát…');
  const [flash, setFlash] = useState(false);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(MUTE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  /** Bản chụp danh sách đội đang chạy — null = đang hiển thị danh sách sống. */
  const [frozen, setFrozen] = useState<LuckyTeamPublic[] | null>(null);

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

  /* ── Tiếng: khôi phục lựa chọn cũ, dọn khi rời trang ── */
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
        localStorage.setItem(MUTE_KEY, next ? '1' : '0');
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

      const bolt = boltRefs.current[i];
      if (bolt) bolt.style.opacity = state.t < state.boostUntil[i] ? '1' : '0';

      // Con NÀO còn chạy thì con đó nhấp nhô. Trước đây gắn theo `phase` chung
      // nên lúc đội trúng về đích (phase → 'done') cả đàn đứng đơ giữa đường
      // trong khi vẫn đang trườn về vạch — nhìn như tranh bị kéo.
      const an = animalRefs.current[i];
      if (an) an.classList.toggle('qs-lane-run', state.finishedAt[i] == null);

      const chip = chipRefs.current[i];
      if (chip) {
        const home = state.finishedAt[i] != null;
        // Vàng chỉ dành cho con ĐANG DẪN ĐẦU và con TRÚNG GIẢI. Trước đây mọi
        // con cán đích đều vàng, nên lúc cả đàn về hết thì chín làn vàng như
        // nhau và đội trúng chìm nghỉm giữa đám đông.
        chip.classList.toggle('qs-lane-hot', i === lead || (home && i === plan.winner));
        chip.classList.toggle('qs-lane-home', home && i === plan.winner);
      }
    }

    // Nhiều đội → khung cuộn được; kéo theo con dẫn đầu để không mất dấu.
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
    const { state, plan, teams: list } = snap;
    if (state.t < nextTalkRef.current) return;
    nextTalkRef.current = state.t + 2.4;
    const lead = leaderLane(state);
    if (lead < 0) return;
    const tm = list[lead];
    const emo = snap.animals[tm.id];
    let msg: string;
    if (state.t > plan.winnerFinish * 0.78) {
      msg = `🏁 Nước rút! ${emo} ${tm.name} băng băng về đích!`;
    } else if (prevLeaderRef.current >= 0 && prevLeaderRef.current !== lead) {
      msg = `Đổi ngôi! ${emo} ${tm.name} vươn lên dẫn đầu!`;
    } else {
      msg = [
        `${emo} ${tm.name} đang dẫn đầu!`,
        `${emo} ${tm.name} giữ ngôi đầu — phía sau bám sát!`,
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
      const { plan, state } = snap;

      // Tiếng khớp hình: phát NGAY trong khung hình phát hiện sự kiện.
      for (const lane of r.boosted) {
        audio?.boost();
        // Đã công bố rồi thì chỉ còn tiếng, KHÔNG đổi chữ nữa — xem chú thích ở
        // nhánh công bố bên dưới.
        if (r.winnerHome) continue;
        const tm = snap.teams[lane];
        setCommentary(`⚡ ${snap.animals[tm.id]} ${tm.name} tăng tốc bất ngờ!`);
        nextTalkRef.current = state.t + 1.6;
      }

      audio?.setTension(state.progress[leaderLane(state)] ?? state.progress[plan.winner]);

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

      if (r.finished.includes(plan.winner)) {
        // ── Công bố NGAY, không chờ đàn còn lại (luồng chơi đã chốt) ──
        const tm = snap.teams[plan.winner];
        audio?.finish();
        audio?.cheer();
        audio?.stopRace();
        setCommentary(`🏆 ${snap.animals[tm.id]} ${tm.name} về nhất — trúng giải!`);
        setPhase('done');
        if (doneCalledRef.current !== ranForRef.current) {
          doneCalledRef.current = ranForRef.current;
          onDoneRef.current();
        }
      } else if (!r.winnerHome) {
        // CHỈ bình luận khi CHƯA công bố.
        //
        // Đàn thua vẫn chạy tiếp sau khi đội trúng cán đích (đúng ý đồ), nên
        // vòng lặp còn sống thêm vài giây. Trước đây nhánh này vẫn chạy trong
        // quãng đó và `leaderLane` lúc ấy trả về con dẫn đầu trong ĐÁM CÒN LẠI —
        // lời bình bị ghi đè thành "Nước rút! <đội thua> băng băng về đích!"
        // ngay bên dưới tấm bảng ghi tên đội trúng. Người xem đọc hai cái tên
        // khác nhau cùng lúc và không biết tin cái nào.
        talk(snap);
      }

      paint();

      if (allHome(state)) {
        audio?.stopRace();
        return; // cả đàn đã về — thôi đốt khung hình
      }
      loop();
    });
  }, [paint, talk]);

  /* ── Khởi động một lượt đua khi `spinToken` đổi ── */
  useEffect(() => {
    if (!spinToken || spinToken === ranForRef.current) return;
    const live = teams;
    const winIdx = live.findIndex((t) => t.id === winnerId);
    // Chưa có đội trúng (server chưa chốt) hoặc đội trúng không có trên đường
    // đua → không chạy, thà đứng yên còn hơn diễn sai kết quả.
    if (winIdx < 0 || live.length === 0) return;

    ranForRef.current = spinToken;
    cancelAnimationFrame(rafRef.current);

    const audio = audioRef.current;
    audio?.setMuted(muted);

    // Đóng băng danh sách (bẫy #1 ở đầu file).
    const snapTeams = [...live];
    const plan = makeRacePlan(
      snapTeams.length,
      winIdx,
      docReducedMotion() ? 9 : seconds,
    );
    const snap: Snapshot = {
      teams: snapTeams,
      animals: assignAnimals(snapTeams.map((t) => t.id)),
      plan,
      state: initialRaceState(plan),
    };
    snapRef.current = snap;
    setFrozen(snapTeams);

    timeScaleRef.current = 1;
    photoUsedRef.current = false;
    nextTalkRef.current = 0;
    prevLeaderRef.current = -1;
    setFlash(false);
    setPhase('countdown');
    setCount(3);
    setCommentary(`${snapTeams.length} đội vào vạch xuất phát…`);
    requestAnimationFrame(() => paint());

    // Đếm ngược: tiếng đặt lịch trên đồng hồ âm thanh, hình chạy trên RAF, cả
    // hai lấy mốc từ CÙNG một khoảnh khắc nên không lệch (bẫy #3).
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
  }, [spinToken, teams, winnerId, seconds, muted, paint, loop]);

  /* ── Vẽ lại khi đổi kích thước / danh sách lúc đang rảnh ── */
  useEffect(() => {
    const onRz = () => paint();
    window.addEventListener('resize', onRz);
    return () => window.removeEventListener('resize', onRz);
  }, [paint]);

  const winnerTeam = shown.find((t) => t.id === winnerId) ?? null;
  const revealed = phase === 'done';

  return (
    <div className={`qs-race ${big ? 'qs-race-big' : ''}`}>
      <div className="qs-race-bar">
        <span className="qs-race-tag">
          {shown.length} đội · {phase === 'idle'
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
          <p className="qs-track-empty">Chưa có đội nào điểm danh — đường đua còn trống.</p>
        ) : (
          shown.map((t, i) => (
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
                {revealed && t.id === winnerId && <span className="qs-lane-badge">🏆 Trúng giải</span>}
                <span
                  className="qs-lane-chip"
                  ref={(el) => {
                    chipRefs.current[i] = el;
                  }}
                >
                  {t.name}
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
          ))
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

      {revealed && winnerTeam && (
        <p className="qs-race-win">
          {animals[winnerTeam.id]} <strong>{winnerTeam.name}</strong> về nhất
        </p>
      )}
    </div>
  );
}
