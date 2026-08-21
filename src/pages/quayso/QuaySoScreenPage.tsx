/**
 * MÀN QUAY công khai — /quayso/<slug>/quay
 *
 * Màn hình để CHỦ GIẢI chiếu lên máy chiếu / quay video. Không cần đăng nhập.
 *
 * Hai chế độ, tự nhận theo dữ liệu:
 *   · Sự kiện có KHAI LƯỢT → sân khấu nhiều lượt (`MultiRoundStage`, vai host):
 *     bấm mở từng lượt, đua xong lượt này mới sang lượt sau, cuối cùng ra bảng
 *     vàng cộng theo sale.
 *   · Không khai lượt → giữ NGUYÊN đường cũ: một giải, một vé trúng, bấm quay.
 *
 * Kết quả do server chốt (`lucky_draw_round_v1` / `lucky_draw_v1`); bấm lại chỉ
 * diễn lại đúng kết quả đó ⇒ quay hỏng thì ghi lại bao nhiêu lần cũng được.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchLuckyPublicState,
  formatVnd,
  luckyDraw,
  luckyGameOf,
  totalRoundsPrize,
  type LuckyPublicState,
} from '@/lib/luckyDrawApi';
import LuckyWheelCanvas, { fireConfetti } from './LuckyWheelCanvas';
import AnimalRaceTrack from './AnimalRaceTrack';
import MultiRoundStage from './MultiRoundStage';
import './quayso.css';

/** Bật/tắt chế độ toàn màn hình thật (Fullscreen API). */
function useFullscreen() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const h = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        /* trình duyệt từ chối thoát — không có gì để quyết định */
      });
    } else {
      void document.documentElement.requestFullscreen().catch(() => {
        /* iOS Safari không cho toàn màn hình ở phần tử thường — vẫn dùng được */
      });
    }
  }, []);
  return { on, toggle };
}

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
  const fs = useFullscreen();

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
  const rounds = state?.ok ? state.rounds ?? [] : [];
  const entrants = teams.filter((t) => t.inWheel && t.checkedIn);
  const winner = teams.find((t) => t.id === event?.winnerTeamId) ?? null;
  const game = luckyGameOf(event?.game);
  const nhieuLuot = rounds.length > 0;

  const drawn = event?.status === 'drawn';
  const revealed = drawn && !!event?.drawnAt && revealedFor === event.drawnAt;
  // Màn này KHÔNG tự quay: chủ giải bấm nút thì mới quay, để canh lúc ghi hình.
  const spinToken = drawn && event?.drawnAt && spinNonce > 0 ? `${event.drawnAt}#${spinNonce}` : null;

  const anMung = useCallback(() => {
    fireConfetti(confettiRef.current, 180);
    if (navigator.vibrate) {
      try {
        navigator.vibrate([30, 60, 120]);
      } catch {
        /* không hỗ trợ */
      }
    }
  }, []);

  const onSpinDone = useCallback(() => {
    if (event?.drawnAt) setRevealedFor(event.drawnAt);
    anMung();
  }, [event?.drawnAt, anMung]);

  // Giữ màn hình không tắt trong lúc quay video (Android/Chrome, iOS 16.4+).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => { /* trình duyệt không cho */ });
    return () => { void lock?.release().catch(() => { /* đã nhả */ }); };
  }, []);

  /* ── Đường CŨ: một giải, một vé trúng ── */
  const handleSpin = async () => {
    if (busy || !event) return;
    setErr(null);
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
            ? 'Chưa có vé nào điểm danh — chưa quay được.'
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
  const tongGiai = nhieuLuot ? totalRoundsPrize(rounds) : (event?.prizeAmount ?? 0);

  return (
    <div className={`qs-page qs-screen ${game === 'race' ? 'qs-screen-race' : ''}`}>
      <div className="qs-screen-inner">
        <header className="qs-screen-head">
          <button
            type="button"
            className="qs-fs-btn"
            onClick={fs.toggle}
            aria-label={fs.on ? 'Thoát toàn màn hình' : 'Xem toàn màn hình'}
            title={fs.on ? 'Thoát toàn màn hình' : 'Xem toàn màn hình'}
          >
            {fs.on ? '🗗' : '⛶'}
          </button>
          {event ? (
            <>
              <h1 className="qs-display">
                <span className="qs-skew qs-goldtext">{event.title}</span>
              </h1>
              <p className="qs-screen-prize">
                {nhieuLuot
                  ? `${rounds.length} lượt · ${rounds.reduce((s, r) => s + r.winnersCount, 0)} giải`
                  : event.prizeLabel}
                {' · '}<b>{formatVnd(tongGiai)}</b>{' · '}{entrants.length} vé
              </p>
            </>
          ) : (
            <h1 className="qs-display"><span className="qs-skew qs-goldtext">Vòng xoay</span></h1>
          )}
        </header>

        {event && nhieuLuot ? (
          <MultiRoundStage
            event={event}
            entrants={entrants}
            allTeams={teams}
            rounds={rounds}
            mode="host"
            onDrawn={(s) => queryClient.setQueryData(queryKey, s)}
            onCelebrate={anMung}
            big
          />
        ) : (
          <>
            {game === 'race' ? (
              <AnimalRaceTrack
                teams={entrants}
                winnerIds={event?.winnerTeamId ? [event.winnerTeamId] : []}
                spinToken={spinToken}
                onSpinDone={onSpinDone}
                seconds={event?.raceSeconds ?? 22}
                prizeLabel={event ? formatVnd(event.prizeAmount) : ''}
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
                  <span>Vé trúng {event?.prizeLabel.toLowerCase()}</span>
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
              {event && entrants.length === 0 && !drawn && (
                <p className="qs-screen-hint">
                  Chưa vé nào điểm danh — bảo anh em vào link điểm danh trước.
                </p>
              )}
            </footer>
          </>
        )}

        {!event && !stateQuery.isLoading && (
          <p className="qs-codeerr">Không tìm thấy sự kiện — kiểm tra lại link.</p>
        )}
      </div>

      <canvas className="qs-confetti" ref={confettiRef} aria-hidden="true" />
    </div>
  );
}
