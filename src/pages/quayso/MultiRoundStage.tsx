/**
 * Sân khấu NHIỀU LƯỢT của /quayso — dùng chung cho trang điểm danh và màn chiếu.
 *
 * Một sự kiện có thể chia nhiều lượt, mỗi lượt trao vài suất cùng mệnh giá
 * (đêm tổng kết: 100K×3 → 200K×2 → 500K×1). Component này lo TOÀN BỘ việc điều
 * phối, hai trang chỉ việc đặt nó vào và nói mình là chủ giải hay người xem.
 *
 * ── HAI VAI, MỘT NGUỒN SỰ THẬT ────────────────────────────────────────────
 *   · `host`   (màn chiếu): bấm nút → gọi `lucky_draw_round_v1` chốt lượt kế.
 *   · `viewer` (trang điểm danh): KHÔNG chốt gì cả, chỉ poll và diễn lại lượt
 *     nào server đã chốt mà mình chưa diễn. Nhờ vậy mọi máy thấy cùng kết quả
 *     và chủ giải giữ được nhịp chương trình.
 *
 * ── VÌ SAO KHÔNG ĐỂ NGƯỜI XEM TỰ CHỐT LƯỢT ────────────────────────────────
 * `lucky_draw_round_v1` là public (án lệ quay tay 20260731130000). Nếu người
 * xem cũng gọi thì máy nào mở trang trước sẽ chốt luôn lượt kế trong khi chủ
 * giải chưa kịp giới thiệu — cháy lượt. Người xem chỉ ĐỌC.
 *
 * ── HAI TRÒ CHƠI, HAI NHỊP ────────────────────────────────────────────────
 *   · Đua thú: cả lượt diễn MỘT lần, n con về đích theo thứ hạng.
 *   · Vòng xoay: bánh xe chỉ chỉ được MỘT ô, nên lượt n suất phải quay n lần,
 *     mỗi lần một suất. Không có nhịp này thì admin chọn vòng xoay + nhiều suất
 *     sẽ ra một tổ hợp hỏng, mà tổ hợp đó admin tạo được.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatVnd,
  luckyDrawRound,
  luckyGameOf,
  nextPendingRound,
  tallyBySale,
  totalRoundsPrize,
  type LuckyEventPublic,
  type LuckyPublicState,
  type LuckyRoundPublic,
  type LuckyTeamPublic,
} from '@/lib/luckyDrawApi';
import { medalFor } from '@/lib/animalRace';
import LuckyWheelCanvas from './LuckyWheelCanvas';
import AnimalRaceTrack, { veLabel } from './AnimalRaceTrack';

export interface MultiRoundStageProps {
  event: LuckyEventPublic;
  /** Vé trên đường đua: `inWheel` + đã điểm danh. */
  entrants: LuckyTeamPublic[];
  /** Toàn bộ vé (kể cả chưa điểm danh) — để tra tên khi dựng bảng vàng. */
  allTeams: LuckyTeamPublic[];
  rounds: LuckyRoundPublic[];
  /** `host` được bấm chốt lượt; `viewer` chỉ diễn lại thứ server đã chốt. */
  mode: 'host' | 'viewer';
  /** Kết quả mới từ server — trang cha nhét vào cache để mọi chỗ cùng thấy. */
  onDrawn: (s: LuckyPublicState) => void;
  /** Ăn mừng khi trao xong một suất (pháo giấy, rung máy…). */
  onCelebrate?: () => void;
  big?: boolean;
}

/** Một ô giải trên dải trên cùng — mỗi SUẤT một ô, kể cả cùng lượt. */
interface PrizeSlot {
  key: string;
  ordinal: number;
  amount: number;
  /** Vé đã trúng ô này, hoặc null nếu chưa quay tới. */
  wonBy: LuckyTeamPublic | null;
  state: 'done' | 'current' | 'wait';
}

/** "100K" — nhãn ngắn cho huy hiệu và lời bình. */
export function shortVnd(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toString().replace(/\.0$/, '')}TR`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export default function MultiRoundStage({
  event,
  entrants,
  allTeams,
  rounds,
  mode,
  onDrawn,
  onCelebrate,
  big = false,
}: MultiRoundStageProps) {
  const game = luckyGameOf(event.game);
  const seconds = event.raceSeconds ?? 20;

  /** Lượt đã DIỄN XONG trên máy này (ordinal). 0 = chưa diễn lượt nào. */
  const [playedUpTo, setPlayedUpTo] = useState(0);
  /** Lượt đang diễn, null = đang đứng chờ. */
  const [active, setActive] = useState<LuckyRoundPublic | null>(null);
  /** Vòng xoay: suất thứ mấy trong lượt đang diễn (0-based). */
  const [slot, setSlot] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Lượt vừa diễn xong — để hiện bảng kết quả lượt. */
  const [justDone, setJustDone] = useState<LuckyRoundPublic | null>(null);

  const teamById = useMemo(
    () => new Map(allTeams.map((t) => [t.id, t])),
    [allTeams],
  );

  const sorted = useMemo(
    () => [...rounds].sort((a, b) => a.ordinal - b.ordinal),
    [rounds],
  );
  const pending = nextPendingRound(sorted);
  const allDrawn = sorted.length > 0 && !pending;
  /** Đã diễn hết mọi lượt server đã chốt chưa. */
  const doneAll = allDrawn && playedUpTo >= (sorted[sorted.length - 1]?.ordinal ?? 0);

  /* ── Người xem: tự diễn lượt nào server đã chốt mà mình chưa diễn ── */
  useEffect(() => {
    if (active) return;
    const tiep = sorted.find((r) => r.status === 'drawn' && r.ordinal > playedUpTo);
    if (!tiep || tiep.winners.length === 0) return;
    setActive(tiep);
    setSlot(0);
    setJustDone(null);
    setNonce((n) => n + 1);
  }, [sorted, playedUpTo, active]);

  /* ── Chủ giải: bấm chốt lượt kế ── */
  const drawNext = useCallback(async () => {
    if (busy || !pending) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await luckyDrawRound(event.id, pending.ordinal);
      if (!res.ok) {
        setErr(
          res.reason === 'no_checked_in_teams'
            ? 'Chưa có vé nào điểm danh — chưa quay được.'
            : res.reason === 'not_time'
              ? 'Chưa tới giờ mở thưởng đã hẹn.'
              : res.reason === 'previous_round_pending'
                ? 'Lượt trước chưa xong.'
                : 'Không quay được, thử lại.',
        );
        return;
      }
      onDrawn(res);
      // Không tự `setActive` ở đây: `res` đã cập nhật `rounds`, hiệu ứng bên
      // trên sẽ bắt lượt vừa chốt và chạy. Một đường vào duy nhất cho cả hai vai.
    } catch {
      setErr('Mạng chập chờn — thử lại.');
    } finally {
      setBusy(false);
    }
  }, [busy, pending, event.id, onDrawn]);

  /* ── Một suất (vòng xoay) hoặc cả lượt (đua thú) vừa xong ── */
  const onSpinDone = useCallback(() => {
    onCelebrate?.();
    if (!active) return;
    if (game === 'wheel' && slot + 1 < active.winners.length) {
      // Còn suất trong lượt → quay tiếp, nghỉ một nhịp cho người xem kịp đọc.
      window.setTimeout(() => {
        setSlot((k) => k + 1);
        setNonce((n) => n + 1);
      }, 1400);
      return;
    }
    setJustDone(active);
    setPlayedUpTo(active.ordinal);
    setActive(null);
  }, [active, game, slot, onCelebrate]);

  /* ── Dải ô giải trên cùng ── */
  const slots: PrizeSlot[] = useMemo(() => {
    const out: PrizeSlot[] = [];
    for (const r of sorted) {
      for (let k = 0; k < r.winnersCount; k++) {
        const w = r.winners.find((x) => x.position === k + 1) ?? null;
        const daDien = r.ordinal <= playedUpTo;
        out.push({
          key: `${r.id}#${k}`,
          ordinal: r.ordinal,
          amount: r.amount,
          // Chỉ lộ tên khi lượt đó ĐÃ DIỄN XONG trên máy này — server trả kết
          // quả ngay lúc chốt, hiện luôn là lộ đáp án trước khi con thú chạy.
          wonBy: daDien && w ? teamById.get(w.teamId) ?? null : null,
          state: daDien ? 'done' : active?.ordinal === r.ordinal ? 'current' : 'wait',
        });
      }
    }
    return out;
  }, [sorted, playedUpTo, active, teamById]);

  /** Huy hiệu vé đã trúng ở các lượt ĐÃ DIỄN — hiện ngay trên làn đua. */
  const priorBadges = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const r of sorted) {
      if (r.ordinal > playedUpTo) continue;
      for (const w of r.winners) {
        const md = medalFor(w.position - 1, r.winnersCount);
        (out[w.teamId] ??= []).push(`${md}${shortVnd(r.amount)}`);
      }
    }
    return out;
  }, [sorted, playedUpTo]);

  const winnerIds = useMemo(() => {
    if (!active) return [];
    const xep = [...active.winners].sort((a, b) => a.position - b.position);
    return game === 'wheel'
      ? [xep[slot]?.teamId].filter((x): x is string => !!x)
      : xep.map((w) => w.teamId);
  }, [active, game, slot]);

  const spinToken = active && winnerIds.length ? `${active.id}#${slot}#${nonce}` : null;
  const tally = useMemo(() => tallyBySale(sorted, allTeams), [sorted, allTeams]);
  const tong = totalRoundsPrize(sorted);

  const nhanLuot = (r: LuckyRoundPublic) =>
    `${formatVnd(r.amount)}${r.winnersCount > 1 ? ` ×${r.winnersCount}` : ''}`;

  return (
    <div className="qs-multi">
      {/* Dải ô giải */}
      <div className="qs-prizes" role="list">
        {slots.map((s) => (
          <div key={s.key} className={`qs-prize qs-prize-${s.state}`} role="listitem">
            <b>{shortVnd(s.amount)}</b>
            <span>
              {s.wonBy ? `🏅 ${s.wonBy.sale?.trim() || s.wonBy.name}`
                : s.state === 'current' ? 'đang quay' : 'chờ'}
            </span>
          </div>
        ))}
      </div>

      {game === 'race' ? (
        <AnimalRaceTrack
          teams={entrants}
          winnerIds={winnerIds}
          spinToken={spinToken}
          onSpinDone={onSpinDone}
          seconds={seconds}
          prizeLabel={active ? shortVnd(active.amount) : ''}
          priorBadges={priorBadges}
          big={big}
        />
      ) : (
        <LuckyWheelCanvas
          teams={entrants}
          winnerId={winnerIds[0] ?? null}
          spinToken={spinToken}
          onSpinDone={onSpinDone}
          maxSize={big ? 560 : 360}
          hubLabel="IHOME"
        />
      )}

      {/* Kết quả lượt vừa xong */}
      {justDone && !doneAll && (
        <div className="qs-roundwin">
          <span className="qs-eyebrow">Kết quả lượt {justDone.ordinal} · {nhanLuot(justDone)}</span>
          {[...justDone.winners].sort((a, b) => a.position - b.position).map((w) => {
            const t = teamById.get(w.teamId);
            return (
              <div className="qs-roundwin-row" key={w.teamId}>
                <span aria-hidden="true">{medalFor(w.position - 1, justDone.winnersCount)}</span>
                <strong>{t ? veLabel(t) : '—'}</strong>
                <b>{formatVnd(w.amount)}</b>
              </div>
            );
          })}
        </div>
      )}

      {/* Điều khiển */}
      {mode === 'host' && !active && pending && (
        <button type="button" className="qs-screen-btn" disabled={busy || !entrants.length}
          onClick={() => void drawNext()}>
          {busy ? 'Đang chốt…'
            : `▶ ${playedUpTo > 0 ? `Lượt ${pending.ordinal}` : 'Bắt đầu lượt 1'} · ${nhanLuot(pending)}`}
        </button>
      )}
      {mode === 'host' && !active && pending && (
        <p className="qs-screen-hint">
          Còn {sorted.length - playedUpTo} lượt · tổng giải {formatVnd(tong)}
        </p>
      )}
      {mode === 'viewer' && !active && pending && (
        <p className="qs-screen-hint">
          Chờ ban tổ chức mở lượt {pending.ordinal} · {nhanLuot(pending)}
        </p>
      )}

      {/* Bảng vàng */}
      {doneAll && (
        <div className="qs-goldboard">
          <span className="qs-eyebrow">🏆 Bảng vàng · {formatVnd(tong)}</span>
          {sorted.flatMap((r) =>
            [...r.winners].sort((a, b) => a.position - b.position).map((w) => {
              const t = teamById.get(w.teamId);
              return (
                <div className="qs-roundwin-row" key={`${r.id}-${w.teamId}`}>
                  <span aria-hidden="true">{medalFor(w.position - 1, r.winnersCount)}</span>
                  <strong>{t ? veLabel(t) : '—'}</strong>
                  <b>{formatVnd(r.amount)}</b>
                </div>
              );
            }))}
          {tally.length > 0 && (
            <p className="qs-tally">
              {tally.map((x) => `${x.sale}: ${shortVnd(x.total)}`).join(' · ')} 🎉
            </p>
          )}
          {mode === 'host' && (
            <button
              type="button"
              className="qs-replay-mini"
              onClick={() => {
                // Chỉ tua lại PHẦN NHÌN: kết quả đã chốt trên server không đổi,
                // hiệu ứng ở trên sẽ bắt lại lượt 1 rồi chạy tiếp từng lượt.
                // Muốn bốc lại kết quả thật thì vào trang quản trị bấm "Đặt lại".
                setJustDone(null);
                setPlayedUpTo(0);
              }}
            >
              ↺ Xem lại toàn bộ
            </button>
          )}
        </div>
      )}

      {err && <p className="qs-codeerr">{err}</p>}
      {mode === 'host' && !entrants.length && (
        <p className="qs-screen-hint">Chưa vé nào điểm danh — bảo anh em vào link điểm danh trước.</p>
      )}
    </div>
  );
}
