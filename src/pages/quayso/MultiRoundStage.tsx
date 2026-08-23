/**
 * Sân khấu NHIỀU LƯỢT của /quayso — dùng chung cho trang điểm danh và màn chiếu.
 *
 * Một sự kiện có thể chia nhiều lượt, mỗi lượt trao vài suất cùng mệnh giá
 * (đêm tổng kết: 100K×3 → 200K×2 → 500K×1). Component này lo TOÀN BỘ việc điều
 * phối, hai trang chỉ việc đặt nó vào và nói mình là chủ giải hay người xem.
 *
 * ── SÂN KHẤU NÀY CHỈ DIỄN LẠI, KHÔNG CHỐT GÌ ──────────────────────────────
 * Cả hai trang công khai đều chỉ poll và diễn lại lượt nào server ĐÃ chốt mà
 * máy mình chưa diễn. Việc mở lượt nằm ở TRANG QUẢN TRỊ (`/quayso/admin`), và
 * server cưỡng chế điều đó chứ không phải giao diện.
 *
 * ── VÌ SAO KHÔNG CÓ NÚT Ở ĐÂY ─────────────────────────────────────────────
 * Bản đầu (21/08) có nút "mở lượt" ngay trên màn chiếu, gọi RPC mở cho `anon`
 * theo án lệ quay tay 20260731130000. Án lệ đó chỉ đúng cho sự kiện MỘT giải:
 * chốt một lần rồi khoá, ai bấm cũng như nhau. Với NHIỀU LƯỢT thì nó hỏng —
 * link màn chiếu là link công khai, nên một người cầm link bấm liên tiếp là
 * ĐỐT SẠCH cả 3 lượt trước khi chủ giải kịp giới thiệu lượt nào. Giấu nút đi
 * không cứu được: RPC gọi thẳng được. Migration 20260823060000 thu hồi quyền
 * của anon; đây là phần giao diện đi theo.
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
  luckyGameOf,
  nextPendingRound,
  tallyBySale,
  totalRoundsPrize,
  type LuckyEventPublic,
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

  /* ── Ban tổ chức đặt lại kết quả → quên luôn phần đã diễn ──
     Máy này nhớ "đã diễn tới lượt N". Nếu quản trị bấm "Huỷ kết quả" thì mọi
     lượt về `pending`, nhưng `playedUpTo` vẫn là N — và hiệu ứng bên dưới chỉ
     nhận lượt có `ordinal > playedUpTo`, nên khi lượt 1 được chốt lại thì máy
     này ĐỨNG IM, không diễn gì. Thấy lượt mình đã diễn nay không còn `drawn`
     nghĩa là có ai đó vừa đặt lại — quên hết và bắt đầu lại từ đầu. */
  useEffect(() => {
    if (playedUpTo === 0) return;
    const daDien = sorted.find((r) => r.ordinal === playedUpTo);
    if (daDien && daDien.status !== 'drawn') {
      setPlayedUpTo(0);
      setJustDone(null);
      setActive(null);
    }
  }, [sorted, playedUpTo]);

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

      {/* Đang chờ lượt kế — mở lượt là việc của trang quản trị */}
      {!active && pending && (
        <p className="qs-screen-hint">
          Chờ ban tổ chức mở lượt {pending.ordinal} · {nhanLuot(pending)}
          {' · '}còn {sorted.length - playedUpTo}/{sorted.length} lượt
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
          <button
            type="button"
            className="qs-replay-mini"
            onClick={() => {
              // Chỉ tua lại PHẦN NHÌN: kết quả đã chốt trên server không đổi,
              // hiệu ứng ở trên sẽ bắt lại lượt 1 rồi chạy tiếp từng lượt.
              // Muốn bốc lại kết quả THẬT thì vào trang quản trị bấm "Huỷ kết quả".
              setJustDone(null);
              setPlayedUpTo(0);
            }}
          >
            ↺ Xem lại toàn bộ
          </button>
        </div>
      )}

      {!entrants.length && (
        <p className="qs-screen-hint">Chưa vé nào điểm danh — bảo anh em vào link điểm danh trước.</p>
      )}
    </div>
  );
}
