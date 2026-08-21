/**
 * MÀN QUAY công khai — /quayso/<slug>/quay
 *
 * Chỉ có bánh xe + nút quay + công bố, vừa khít một màn hình ĐIỆN THOẠI DỌC
 * (không cuộn) để chủ sự kiện quay video màn hình gửi lên group.
 *
 * - KHÔNG cần đăng nhập.
 * - Kết quả do server chốt một lần (lucky_draw_v1); bấm lại chỉ quay lại đúng
 *   đội đó, không đổi kết quả ⇒ quay hỏng thì ghi lại bao nhiêu lần cũng được.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchLuckyPublicState,
  formatVnd,
  luckyDraw,
  luckyGameOf,
  type LuckyPublicState,
} from '@/lib/luckyDrawApi';
import LuckyWheelCanvas, { fireConfetti } from './LuckyWheelCanvas';
import AnimalRaceTrack from './AnimalRaceTrack';
import './quayso.css';

export default function QuaySoScreenPage() {
  const { slug: slugParam } = useParams<{ slug?: string }>();
  const [params] = useSearchParams();
  const slug = slugParam ?? null;
  const eventParam = params.get('e');
  const queryClient = useQueryClient();

  const [spinNonce, setSpinNonce] = useState(0);
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confettiRef = useRef<HTMLCanvasElement | null>(null);

  const queryKey = ['quayso-screen', eventParam, slug] as const;
  const stateQuery = useQuery<LuckyPublicState>({
    queryKey,
    enabled: Boolean(eventParam || slug),
    queryFn: () => fetchLuckyPublicState(eventParam, null, slug),
    refetchInterval: 5000,
  });

  const state = stateQuery.data;
  const event = state?.ok ? state.event : undefined;
  const teams = state?.ok ? state.teams ?? [] : [];
  const entrants = teams.filter((t) => t.inWheel && t.checkedIn);
  const winner = teams.find((t) => t.id === event?.winnerTeamId) ?? null;
  // Trò chơi do chủ giải chọn lúc tổ chức. Sự kiện cũ không có cột này → vòng xoay.
  const game = luckyGameOf(event?.game);

  const drawn = event?.status === 'drawn';
  const revealed = drawn && !!event?.drawnAt && revealedFor === event.drawnAt;
  // Màn này KHÔNG tự quay: chủ sự kiện bấm nút thì mới quay, để canh lúc bấm ghi hình.
  const spinToken = drawn && event?.drawnAt && spinNonce > 0 ? `${event.drawnAt}#${spinNonce}` : null;

  const onSpinDone = useCallback(() => {
    if (event?.drawnAt) setRevealedFor(event.drawnAt);
    fireConfetti(confettiRef.current, 180);
    if (navigator.vibrate) {
      try {
        navigator.vibrate([30, 60, 120]);
      } catch {
        /* không hỗ trợ */
      }
    }
  }, [event?.drawnAt]);

  // Giữ màn hình không tắt trong lúc quay video (Android/Chrome, iOS 16.4+).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => { /* trình duyệt không cho */ });
    return () => { void lock?.release().catch(() => {}); };
  }, []);

  const handleSpin = async () => {
    if (busy || !event) return;
    setErr(null);
    // Đã có kết quả → chỉ quay lại cho đẹp, không gọi server.
    if (drawn) {
      setRevealedFor(null);
      setSpinNonce((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      const res = await luckyDraw(event.id);
      if (!res.ok) {
        setErr(
          res.reason === 'no_checked_in_teams'
            ? 'Chưa có đội nào điểm danh — chưa quay được.'
            : res.reason === 'not_time'
              ? 'Chưa tới giờ mở thưởng đã hẹn.'
              : 'Không quay được, thử lại.',
        );
        return;
      }
      queryClient.setQueryData(queryKey, res);
      setRevealedFor(null);
      setSpinNonce((n) => n + 1);
    } catch {
      setErr('Mạng chập chờn — thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const canSpin = !!event && (drawn || entrants.length > 0) && !busy;

  return (
    <div className="qs-page qs-screen">
      <div className="qs-screen-inner">
        <header className="qs-screen-head">
          {event ? (
            <>
              <h1 className="qs-display">
                <span className="qs-skew qs-goldtext">{event.title}</span>
              </h1>
              <p className="qs-screen-prize">
                {event.prizeLabel} · <b>{formatVnd(event.prizeAmount)}</b> ·{' '}
                {entrants.length} đội
              </p>
            </>
          ) : (
            <h1 className="qs-display"><span className="qs-skew qs-goldtext">Vòng xoay</span></h1>
          )}
        </header>

        {game === 'race' ? (
          <AnimalRaceTrack
            teams={entrants}
            winnerId={event?.winnerTeamId ?? null}
            spinToken={spinToken}
            onSpinDone={onSpinDone}
            seconds={22}
            big
          />
        ) : (
          <LuckyWheelCanvas
            teams={entrants}
            winnerId={event?.winnerTeamId ?? null}
            spinToken={spinToken}
            onSpinDone={onSpinDone}
            maxSize={560}
            hubLabel="IHOME"
          />
        )}

        <footer className="qs-screen-foot">
          {revealed && winner ? (
            <div className="qs-screen-winner">
              <span>Đội trúng {event?.prizeLabel.toLowerCase()}</span>
              <strong className="qs-goldtext">{winner.name}</strong>
              <b>{event ? formatVnd(event.prizeAmount) : ''}</b>
            </div>
          ) : (
            <button
              type="button"
              className="qs-screen-btn"
              disabled={!canSpin}
              onClick={() => void handleSpin()}
            >
              {busy
                ? 'Đang chốt…'
                : game === 'race'
                  ? (drawn ? '▶ Đua lại' : '▶ Xuất phát')
                  : (drawn ? '▶ Quay lại' : '▶ Quay số')}
            </button>
          )}

          {revealed && (
            <button
              type="button"
              className="qs-replay-mini"
              onClick={() => {
                setRevealedFor(null);
                setSpinNonce((n) => n + 1);
              }}
            >
              {game === 'race' ? '↺ Đua lại lần nữa' : '↺ Quay lại lần nữa'}
            </button>
          )}

          {err && <p className="qs-codeerr">{err}</p>}
          {!event && !stateQuery.isLoading && (
            <p className="qs-codeerr">Không tìm thấy sự kiện — kiểm tra lại link.</p>
          )}
          {event && entrants.length === 0 && !drawn && (
            <p className="qs-screen-hint">
              Chưa đội nào điểm danh — bảo anh em vào link điểm danh trước.
            </p>
          )}
        </footer>
      </div>

      <canvas className="qs-confetti" ref={confettiRef} aria-hidden="true" />
    </div>
  );
}
