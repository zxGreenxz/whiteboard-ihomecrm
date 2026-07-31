/**
 * Trang CÔNG KHAI /quayso — sale không đăng nhập.
 *
 * Luồng: nhập mã 6 số (web cấp sẵn cho từng đội) → điểm danh → chờ đếm ngược
 * tới giờ mở thưởng (draw_at do quản trị hẹn) → server chốt đội trúng MỘT lần
 * (lucky_draw_v1, mọi client gọi đều idempotent) → mọi máy quay bánh xe về
 * cùng một đội.
 *
 * - Poll trạng thái 4s (1.2s trong 30s chót) — không dùng realtime để khỏi mở
 *   RLS SELECT cho anon (lộ mã đội).
 * - Đồng hồ đếm ngược chạy theo GIỜ SERVER (serverNow + offset), không tin
 *   đồng hồ máy sale.
 * - Gọi RPC bằng fetch thuần (án lệ webview Zalo/Messenger — xem luckyDrawApi).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  fetchLuckyPublicState,
  formatVnd,
  luckyCheckin,
  luckyDraw,
  luckySavePayout,
  serverClockOffset,
  uploadLuckyProof,
  PROOF_MAX_FILES,
  type LuckyProof,
  type LuckyPublicState,
  type LuckyTeamPublic,
} from '@/lib/luckyDrawApi';
import {
  POINTER_ANGLE,
  easeOutQuint,
  formatCountdown,
  indexAtPointer,
  normalizeAngle,
  targetRotation,
} from '@/lib/luckyWheel';
import './quayso.css';

const CODE_KEY = 'qs_code_v1';

/* ─────────────────────────── Vòng xoay (canvas) ─────────────────────────── */

interface WheelProps {
  teams: LuckyTeamPublic[];          // chỉ các đội in_wheel + đã điểm danh
  winnerId: string | null;           // server đã chốt → quay về đội này
  /** Đổi giá trị = quay một lần. null = đứng yên (vào trang sau khi đã quay,
   *  chờ người xem bấm "Xem lại kết quả quay"). */
  spinToken: string | null;
  onSpinDone: () => void;
}

function LuckyWheelCanvas({ teams, winnerId, spinToken, onSpinDone }: WheelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const needleRef = useRef<SVGSVGElement | null>(null);
  const rotRef = useRef(POINTER_ANGLE);
  const rafRef = useRef(0);
  const animatedForRef = useRef<string | null>(null);
  const sizeRef = useRef(300);
  const teamsRef = useRef(teams);
  teamsRef.current = teams;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = sizeRef.current;
    const list = teamsRef.current;
    const R = size / 2;
    const rot = rotRef.current;
    const stack = getComputedStyle(canvas).fontFamily;
    ctx.clearRect(0, 0, size, size);

    if (!list.length) {
      ctx.save();
      ctx.translate(R, R);
      ctx.beginPath();
      ctx.arc(0, 0, R - 2, 0, Math.PI * 2);
      ctx.fillStyle = '#2E1622';
      ctx.fill();
      ctx.fillStyle = '#B08F9C';
      ctx.font = `600 13px ${stack}`;
      ctx.textAlign = 'center';
      ctx.fillText('Chưa có đội nào', 0, -6);
      ctx.fillText('điểm danh', 0, 14);
      ctx.restore();
      return;
    }

    const n = list.length;
    const seg = (Math.PI * 2) / n;
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(rot);
    for (let i = 0; i < n; i++) {
      const a0 = i * seg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R - 3, a0, a0 + seg);
      ctx.closePath();
      // Số ô lẻ: ô cuối kề ô 0 nên dùng sắc thứ ba, tránh dính màu.
      ctx.fillStyle = n % 2 === 1 && i === n - 1 ? '#93111C' : i % 2 ? '#7C0E19' : '#B01521';
      ctx.fill();
      ctx.strokeStyle = '#FFC23C';
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFF2E4';
      const fs = n > 9 ? 12.5 : n > 6 ? 14 : 16;
      ctx.font = `800 ${fs}px ${stack}`;
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 3;
      ctx.fillText(list[i].name.toUpperCase(), R - 18, 0, R - 48);
      ctx.restore();
    }
    ctx.restore();

    // Vành vàng + chấm đèn
    ctx.save();
    ctx.translate(R, R);
    ctx.beginPath();
    ctx.arc(0, 0, R - 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFC23C';
    ctx.lineWidth = 3;
    ctx.stroke();
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2 + rot * 0.35;
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * (R - 9), Math.sin(ang) * (R - 9), 2.1, 0, Math.PI * 2);
      ctx.fillStyle = k % 2 ? '#FFEDB0' : '#C98A12';
      ctx.fill();
    }
    ctx.restore();
  }, []);

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    let w = stage.clientWidth;
    if (!w) w = Math.min(520, window.innerWidth || 360) - 64;
    const size = Math.max(220, Math.min(360, w - 24));
    sizeRef.current = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }, [draw]);

  useEffect(() => {
    fit();
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fit, 120);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [fit]);

  // Vẽ lại khi danh sách đổi (điểm danh thêm) — trừ lúc đang animate.
  useEffect(() => {
    draw();
  }, [teams, draw]);

  // Quay MỘT lần cho mỗi spinToken.
  useEffect(() => {
    if (!winnerId || !spinToken) {
      animatedForRef.current = null;
      return;
    }
    if (animatedForRef.current === spinToken) return;
    const list = teamsRef.current;
    const winIdx = list.findIndex((t) => t.id === winnerId);
    if (winIdx < 0) return; // đợi poll mang danh sách đủ rồi tính tiếp
    animatedForRef.current = spinToken;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const to = targetRotation(winIdx, list.length, Math.random(), 6 + Math.floor(Math.random() * 3));
    if (reduce) {
      rotRef.current = normalizeAngle(to);
      draw();
      onSpinDone();
      return;
    }

    const from = rotRef.current;
    const DUR = 5200;
    let t0: number | null = null;
    let lastIdx = indexAtPointer(from, list.length);
    const frame = (ts: number) => {
      if (t0 === null) t0 = ts;
      const p = Math.min(1, (ts - t0) / DUR);
      rotRef.current = from + (to - from) * easeOutQuint(p);
      draw();
      const nowIdx = indexAtPointer(rotRef.current, list.length);
      if (nowIdx !== lastIdx) {
        lastIdx = nowIdx;
        const needle = needleRef.current;
        if (needle) {
          needle.classList.add('qs-kick');
          window.setTimeout(() => needle.classList.remove('qs-kick'), 70);
        }
      }
      if (p < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        rotRef.current = normalizeAngle(to);
        draw();
        onSpinDone();
      }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(frame);
  }, [winnerId, spinToken, teams, draw, onSpinDone]);

  return (
    <div className="qs-stage" ref={stageRef}>
      <svg className="qs-needle" ref={needleRef} viewBox="0 0 30 40" aria-hidden="true">
        <path d="M15 40 L2 8 A14 14 0 0 1 28 8 Z" fill="#FFC23C" stroke="#8A5D08" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="15" cy="10" r="4.4" fill="#8A5D08" />
      </svg>
      <canvas ref={canvasRef} role="img" aria-label="Vòng xoay may mắn" />
      <div className="qs-hub" aria-hidden="true">IHOME</div>
    </div>
  );
}

/* ─────────────────────────────── Pháo giấy ──────────────────────────────── */

function fireConfetti(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#FFC23C', '#FFEDB0', '#F5333F', '#FFF2E4', '#C98A12'];
  const W = window.innerWidth;
  const bits = Array.from({ length: 150 }, (_, i) => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.55,
    y: window.innerHeight * 0.42 + (Math.random() - 0.5) * 60,
    vx: (Math.random() - 0.5) * 13,
    vy: -7 - Math.random() * 13,
    w: 5 + Math.random() * 7,
    h: 8 + Math.random() * 9,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.34,
    c: colors[i % colors.length],
    life: 1,
  }));
  const tick = () => {
    const H = window.innerHeight;
    ctx.clearRect(0, 0, window.innerWidth, H);
    let alive = 0;
    for (const b of bits) {
      b.vy += 0.42;
      b.vx *= 0.992;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      if (b.y > H * 0.62) b.life -= 0.016;
      if (b.life <= 0) continue;
      alive++;
      ctx.save();
      ctx.globalAlpha = Math.max(0, b.life);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (alive > 0) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, window.innerWidth, H);
  };
  requestAnimationFrame(tick);
}

/* ────────────────────── Hồ sơ nhận thưởng của đội ───────────────────────── */

interface PayoutFormProps {
  eventId: string;
  code: string;
  team: LuckyTeamPublic;
  onSaved: (s: LuckyPublicState) => void;
}

function PayoutForm({ eventId, code, team, onSaved }: PayoutFormProps) {
  const [account, setAccount] = useState(team.payoutAccount ?? '');
  const [bank, setBank] = useState(team.payoutBank ?? '');
  const [holder, setHolder] = useState(team.payoutHolder ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [proofs, setProofs] = useState<LuckyProof[]>(team.proofs ?? []);
  // Đã có STK thì mở ở chế độ xem gọn; chưa có gì thì mở sẵn ô điền.
  const [editing, setEditing] = useState(
    !(team.payoutAccount || team.payoutBank || team.payoutHolder),
  );
  // Ảnh vừa chọn trong PHIÊN NÀY xem trước được (blob cục bộ). Bucket private,
  // anon không có quyền đọc nên tấm nộp từ phiên trước chỉ hiện tên file.
  const [localUrls, setLocalUrls] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Thu hồi blob URL khi rời trang để không rò bộ nhớ.
  const urlsRef = useRef(localUrls);
  urlsRef.current = localUrls;
  useEffect(() => () => { Object.values(urlsRef.current).forEach(URL.revokeObjectURL); }, []);

  const persist = async (next: LuckyProof[], okMsg: string) => {
    const res = await luckySavePayout(code, { proofs: next });
    if (!res.ok) throw new Error('Không lưu được giấy cọc.');
    setProofs(res.teams?.find((t) => t.isMine)?.proofs ?? next);
    setMsg(okMsg);
    onSaved(res);
  };

  const pickFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setErr(null);
    setMsg(null);
    setBusy(true);

    const room = PROOF_MAX_FILES - proofs.length;
    const take = list.slice(0, Math.max(0, room));
    const added: LuckyProof[] = [];
    const blobs: Record<string, string> = {};
    try {
      if (room <= 0) throw new Error(`Tối đa ${PROOF_MAX_FILES} tấm — xoá bớt rồi nộp tiếp nhé.`);
      for (let i = 0; i < take.length; i++) {
        setProgress(`Đang tải ${i + 1}/${take.length}…`);
        const up = await uploadLuckyProof(eventId, take[i]);
        added.push({ path: up.path, name: up.name });
        if (take[i].type.startsWith('image/')) blobs[up.path] = URL.createObjectURL(take[i]);
      }
      const next = [...proofs, ...added];
      setLocalUrls((m) => ({ ...m, ...blobs }));
      await persist(
        next,
        list.length > take.length
          ? `Đã nộp ${take.length} tấm (bỏ qua ${list.length - take.length} tấm vượt giới hạn) ✓`
          : `Đã nộp ${take.length} tấm giấy cọc ✓`,
      );
    } catch (e) {
      Object.values(blobs).forEach(URL.revokeObjectURL);
      setErr(e instanceof Error ? e.message : 'Tải ảnh không thành công, thử lại.');
    } finally {
      setBusy(false);
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeProof = async (path: string) => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await persist(proofs.filter((p) => p.path !== path), 'Đã bỏ tấm giấy cọc ✓');
      const url = localUrls[path];
      if (url) {
        URL.revokeObjectURL(url);
        setLocalUrls(({ [path]: _drop, ...rest }) => rest);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Không bỏ được, thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const saveAccount = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const res = await luckySavePayout(code, {
        payoutAccount: account,
        payoutBank: bank,
        payoutHolder: holder,
      });
      if (!res.ok) throw new Error('Không lưu được số tài khoản.');
      setMsg('Đã lưu số tài khoản ✓');
      setEditing(false);          // lưu xong thu gọn lại, muốn sửa thì bấm "Chỉnh sửa"
      onSaved(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Lưu không thành công, thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const cancelEdit = () => {
    setAccount(team.payoutAccount ?? '');
    setBank(team.payoutBank ?? '');
    setHolder(team.payoutHolder ?? '');
    setErr(null);
    setEditing(false);
  };

  return (
    <section className="qs-payout">
      <p className="qs-eyebrow">Hồ sơ nhận thưởng</p>
      <h2 className="qs-display"><span className="qs-skew">Nộp giấy cọc &amp; STK</span></h2>
      <p className="qs-payout-hint">
        Nộp trước cho gọn — trúng thưởng là BTC chuyển khoản luôn, khỏi hỏi tới hỏi lui.
      </p>

      {proofs.length > 0 && (
        <ul className="qs-prooflist">
          {proofs.map((p, i) => (
            <li key={p.path} className="qs-proof">
              {localUrls[p.path] ? (
                <img src={localUrls[p.path]} alt={p.name} />
              ) : (
                <span className="qs-proof-ph">{/\.pdf$/i.test(p.name) ? 'PDF' : `#${i + 1}`}</span>
              )}
              <span className="qs-proof-name">{p.name}</span>
              <button
                type="button"
                className="qs-proof-x"
                aria-label={`Bỏ ${p.name}`}
                disabled={busy}
                onClick={() => void removeProof(p.path)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="qs-uploadbox">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          disabled={busy}
          onChange={(e) => void pickFiles(e.target.files)}
        />
        <span className="qs-up-empty">
          <b>＋</b>
          {progress ?? (proofs.length ? 'Nộp thêm ảnh giấy cọc' : 'Chụp / chọn ảnh giấy cọc')}
          <em>
            Chọn nhiều tấm một lần · JPG, PNG, PDF · mỗi tấm ≤10MB
            {proofs.length ? ` · đã nộp ${proofs.length}/${PROOF_MAX_FILES}` : ''}
          </em>
        </span>
      </label>

      {editing ? (
        <div className="qs-fields">
          <label>
            Số tài khoản nhận thưởng
            <input
              inputMode="numeric"
              placeholder="vd 0123456789"
              value={account}
              disabled={busy}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
          <div className="qs-field2">
            <label>
              Ngân hàng
              <input
                placeholder="vd Vietcombank"
                value={bank}
                disabled={busy}
                onChange={(e) => setBank(e.target.value)}
              />
            </label>
            <label>
              Chủ tài khoản
              <input
                placeholder="vd NGUYEN VAN A"
                value={holder}
                disabled={busy}
                onChange={(e) => setHolder(e.target.value)}
              />
            </label>
          </div>
          <button type="button" className="qs-savebtn" disabled={busy} onClick={() => void saveAccount()}>
            {busy ? 'Đang lưu…' : 'Lưu số tài khoản'}
          </button>
          {(team.payoutAccount || team.payoutBank || team.payoutHolder) && (
            <button type="button" className="qs-cancelbtn" disabled={busy} onClick={cancelEdit}>
              Huỷ
            </button>
          )}
        </div>
      ) : (
        <div className="qs-savedbox">
          <div className="qs-savedrows">
            <div className="qs-savedrow">
              <span>Số tài khoản</span>
              <b>{account || '—'}</b>
            </div>
            <div className="qs-savedrow">
              <span>Ngân hàng</span>
              <b>{bank || '—'}</b>
            </div>
            <div className="qs-savedrow">
              <span>Chủ tài khoản</span>
              <b>{holder || '—'}</b>
            </div>
          </div>
          <button type="button" className="qs-editbtn" disabled={busy} onClick={() => setEditing(true)}>
            ✏️ Chỉnh sửa
          </button>
        </div>
      )}

      {msg && <p className="qs-okmsg">{msg}</p>}
      {err && <p className="qs-codeerr">{err}</p>}
    </section>
  );
}

/* ─────────────────────────────── Trang chính ────────────────────────────── */

export default function QuaySoPage() {
  const [params] = useSearchParams();
  const eventParam = params.get('e');
  const queryClient = useQueryClient();

  const [savedCode, setSavedCode] = useState<string>(() => {
    try {
      return localStorage.getItem(CODE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [showWin, setShowWin] = useState(false);
  const confettiRef = useRef<HTMLCanvasElement | null>(null);
  const drawCalledForRef = useRef<string | null>(null);

  // drawnAt đã được BÁNH XE quay xong và công bố. Trước mốc này phải giấu tên
  // đội trúng ở mọi chỗ, nếu không thì vừa bấm quay đã lộ đáp án, mất 5 giây
  // hồi hộp — và người vào sau cũng bị spoil trước khi kịp bấm "xem lại".
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  // Tăng lên mỗi lần bấm "Xem lại kết quả quay".
  const [spinNonce, setSpinNonce] = useState(0);
  // Trang có chứng kiến sự kiện lúc còn 'open' không? Có = đang xem trực tiếp
  // nên bánh xe tự quay; không = vào sau khi đã quay, chờ bấm nút.
  const sawOpenRef = useRef(false);

  // Đồng hồ 1s cho đếm ngược.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  void tick;

  const queryKey = useMemo(() => ['quayso', eventParam, savedCode] as const, [eventParam, savedCode]);

  const stateQuery = useQuery<LuckyPublicState>({
    queryKey,
    enabled: Boolean(eventParam || savedCode),
    queryFn: () => fetchLuckyPublicState(eventParam, savedCode || null),
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const s = query.state.data;
      if (!s?.ok || !s.event) return 4000;
      if (s.event.status === 'drawn') return 10000;
      if (s.event.drawAt) {
        const offset = serverClockOffset(s.event.serverNow);
        const left = new Date(s.event.drawAt).getTime() - (Date.now() + offset);
        if (left <= 30_000) return 1200;
      }
      return 4000;
    },
  });

  const state = stateQuery.data;
  const event = state?.ok ? state.event : undefined;
  const teams = useMemo(() => (state?.ok ? state.teams ?? [] : []), [state]);

  // Ghi nhận đã thấy sự kiện lúc còn mở → coi như đang xem trực tiếp.
  useEffect(() => {
    if (event?.status === 'open') sawOpenRef.current = true;
  }, [event?.status]);

  // Mã lưu sẵn nhưng server bảo sai (đổi sự kiện, mã bị cấp lại) → gỡ để nhập lại.
  useEffect(() => {
    if (!state || state.ok) return;
    if (savedCode && (state.reason === 'bad_code' || state.reason === 'code_other_event')) {
      setSavedCode('');
      try {
        localStorage.removeItem(CODE_KEY);
      } catch {
        /* riêng tư bị chặn */
      }
    }
  }, [state, savedCode]);

  const myTeam = teams.find((t) => t.isMine) ?? null;
  const topTeams = teams.filter((t) => t.topRank != null).sort((a, b) => (a.topRank ?? 9) - (b.topRank ?? 9));
  const wheelTeams = teams.filter((t) => t.inWheel);
  const wheelCheckedIn = wheelTeams.filter((t) => t.checkedIn);
  const winner = teams.find((t) => t.id === event?.winnerTeamId) ?? null;

  // Giờ server hiện tại (offset cập nhật mỗi lần poll).
  const offset = event ? serverClockOffset(event.serverNow) : 0;
  const serverNowMs = Date.now() + offset;
  const drawAtMs = event?.drawAt ? new Date(event.drawAt).getTime() : null;
  const msLeft = drawAtMs != null ? drawAtMs - serverNowMs : null;

  // Tới giờ + chưa chốt → xin server mở thưởng (mọi client gọi; server idempotent).
  useEffect(() => {
    if (!event || event.status !== 'open' || msLeft == null || msLeft > 0) return;
    if (drawCalledForRef.current === event.id + (event.drawAt ?? '')) return;
    drawCalledForRef.current = event.id + (event.drawAt ?? '');
    luckyDraw(event.id)
      .then((s) => {
        if (s.ok) queryClient.setQueryData(queryKey, (prev: LuckyPublicState | undefined) => ({
          ...s,
          // giữ isMine từ payload cũ: RPC draw không biết mã của máy này
          teams: s.teams?.map((t) => ({ ...t, isMine: prev?.teams?.some((p) => p.id === t.id && p.isMine) ?? false })),
        }));
        else void stateQuery.refetch();
      })
      .catch(() => {
        drawCalledForRef.current = null; // mạng lỗi → cho phép thử lại vòng poll sau
      });
  }, [event, msLeft, queryClient, queryKey, stateQuery]);

  // Bánh xe dừng → mới công bố. Ai cũng có popup, nhưng nội dung khác nhau:
  // đội trúng thì ăn mừng (kèm pháo giấy + rung), đội chưa trúng thì lời hẹn
  // nhẹ nhàng. Pháo giấy chỉ nổ cho đội trúng.
  const winnerIsMine = !!winner?.isMine;
  const onSpinDone = useCallback(() => {
    if (event?.drawnAt) setRevealedFor(event.drawnAt);
    setShowWin(true);
    if (!winnerIsMine) return;
    fireConfetti(confettiRef.current);
    if (navigator.vibrate) {
      try {
        navigator.vibrate([30, 60, 120]);
      } catch {
        /* không hỗ trợ */
      }
    }
  }, [event?.drawnAt, winnerIsMine]);

  const submitCode = async () => {
    const code = codeInput.trim();
    if (!/^\d{6,8}$/.test(code)) {
      setCodeError('Mã gồm 6 chữ số — xem lại tin nhắn BTC gửi cho đội bạn.');
      return;
    }
    setCheckinBusy(true);
    setCodeError(null);
    try {
      const res = await luckyCheckin(code);
      if (!res.ok) {
        setCodeError(
          res.reason === 'too_late'
            ? 'Đã trễ giờ điểm danh — đội bạn không tham gia quay thưởng lần này.'
            : res.reason === 'bad_code'
              ? 'Mã không đúng hoặc sự kiện đã đóng.'
              : 'Không điểm danh được, thử lại.',
        );
        return;
      }
      try {
        localStorage.setItem(CODE_KEY, code);
      } catch {
        /* riêng tư bị chặn — vẫn chạy trong phiên */
      }
      setSavedCode(code);
      setCodeInput('');
      queryClient.setQueryData(['quayso', eventParam, code], res);
      if (navigator.vibrate) {
        try {
          navigator.vibrate(18);
        } catch {
          /* không hỗ trợ */
        }
      }
    } catch {
      setCodeError('Mạng chập chờn — thử lại giúp mình.');
    } finally {
      setCheckinBusy(false);
    }
  };

  const forgetCode = () => {
    try {
      localStorage.removeItem(CODE_KEY);
    } catch {
      /* riêng tư bị chặn */
    }
    setSavedCode('');
  };

  /* ── Render ── */

  const noEntry = !eventParam && !savedCode;
  const drawn = event?.status === 'drawn';
  const closed = event?.status === 'closed';
  const soon = msLeft != null && msLeft <= 60_000 && msLeft > 0 && !drawn;

  // Đã công bố (bánh xe quay xong) chưa?
  const revealed = drawn && !!event?.drawnAt && revealedFor === event.drawnAt;
  // Khi nào bánh xe được phép quay.
  const spinToken =
    drawn && event?.drawnAt
      ? spinNonce > 0
        ? `${event.drawnAt}#${spinNonce}`   // người xem bấm "xem lại"
        : sawOpenRef.current
          ? event.drawnAt                   // đang xem trực tiếp → tự quay
          : null                            // vào sau → đứng yên chờ bấm
      : null;
  const canReplay = drawn && wheelCheckedIn.length > 0 && spinToken === null;

  return (
    <div className="qs-page">
      <div className="qs-ticker" aria-hidden="true">
        <div className="qs-ticker-track">
          {[0, 1].map((half) => (
            <span key={half}>
              {event
                ? `${event.title} ✦ ${event.prizeLabel} ${formatVnd(event.prizeAmount)} ✦ Điểm danh bằng mã 6 số ✦ Quay tự động đúng giờ ✦ `
                : 'IHOME · Vòng xoay may mắn ✦ Điểm danh bằng mã 6 số ✦ '}
            </span>
          ))}
        </div>
      </div>

      <main className="qs-shell">
        <section className="qs-hero">
          <span className="qs-flag">
            <i />
            {drawn ? 'Đã có kết quả' : closed ? 'Sự kiện đã đóng' : 'Đang điểm danh'}
          </span>
          <h1 className="qs-display">
            <span className="qs-skew qs-goldtext">{event ? event.title : 'Vòng xoay'}</span>
            <span className="qs-l2 qs-skew">May mắn</span>
          </h1>
          <p className="qs-tag">
            {event
              ? `${event.prizeLabel} ${formatVnd(event.prizeAmount)} — nhập mã đội để điểm danh và theo dõi giờ mở thưởng.`
              : 'Nhập mã 6 số BTC cấp cho đội bạn để vào sự kiện.'}
          </p>
        </section>

        {/* Nhập mã / đội của tôi */}
        {myTeam ? (
          <section className="qs-mine">
            <div className="qs-mine-txt">
              <small>Đội của bạn · {myTeam.deals} deal</small>
              <strong>{myTeam.name}</strong>
              <button type="button" onClick={forgetCode}>Đổi mã khác</button>
            </div>
            <span className="qs-ok">
              {myTeam.topRank ? `Đã có mặt nhận giải TOP ${myTeam.topRank} ✓` : 'Đã điểm danh ✓'}
            </span>
          </section>
        ) : (
          <section className="qs-codebox">
            <label htmlFor="qs-code">Mã điểm danh của đội (6 số, BTC đã gửi riêng):</label>
            <div className="qs-coderow">
              <input
                id="qs-code"
                className="qs-codeinput"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                placeholder="••••••"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCode();
                }}
              />
              <button type="button" className="qs-codebtn" disabled={checkinBusy} onClick={() => void submitCode()}>
                {checkinBusy ? '…' : 'Điểm danh'}
              </button>
            </div>
            {codeError && <p className="qs-codeerr">{codeError}</p>}
          </section>
        )}

        {/* Hồ sơ nhận thưởng — chỉ đội đã điểm danh mới nộp được */}
        {event && myTeam && savedCode && (
          <PayoutForm
            eventId={event.id}
            code={savedCode}
            team={myTeam}
            onSaved={(s) => queryClient.setQueryData(queryKey, s)}
          />
        )}

        {noEntry && (
          <div className="qs-empty">
            Chưa có mã? Hỏi BTC lấy mã 6 số của đội bạn — nhập mã là vào thẳng sự kiện.
          </div>
        )}

        {state && !state.ok && !noEntry && state.reason === 'missing_event' && (
          <div className="qs-empty">Link thiếu sự kiện — dùng đúng link BTC gửi, hoặc nhập mã đội ở trên.</div>
        )}

        {stateQuery.isError && (
          <div className="qs-empty">Mất kết nối — đang tự thử lại…</div>
        )}

        {event && (
          <>
            {/* Đếm ngược */}
            <section className="qs-count" aria-live="polite">
              {drawn ? (
                revealed ? (
                  <>
                    <p className="qs-eyebrow">Kết quả đã chốt</p>
                    <div className="qs-clock qs-goldtext">{winner ? winner.name.toUpperCase() : '—'}</div>
                    <span className="qs-when">
                      {event.drawnAt ? `Quay lúc ${new Date(event.drawnAt).toLocaleString('vi-VN')}` : ''}
                    </span>
                  </>
                ) : (
                  <>
                    <p className="qs-eyebrow">Đã quay xong</p>
                    <div className="qs-clock qs-soon">✦ ✦ ✦</div>
                    <span className="qs-when">
                      {canReplay ? 'Bấm “Xem lại kết quả quay” để mở đáp án.' : 'Bánh xe đang quay…'}
                    </span>
                  </>
                )
              ) : closed ? (
                <>
                  <p className="qs-eyebrow">Sự kiện đã đóng</p>
                  <div className="qs-clock">—</div>
                </>
              ) : msLeft == null ? (
                <>
                  <p className="qs-eyebrow">Giờ mở thưởng</p>
                  <div className="qs-clock">--:--:--</div>
                  <span className="qs-when">BTC chưa chốt giờ — cứ điểm danh trước.</span>
                </>
              ) : msLeft <= 0 ? (
                <>
                  <p className="qs-eyebrow">Đang mở thưởng</p>
                  <div className="qs-clock qs-soon">✦ ✦ ✦</div>
                  <span className="qs-when">Server đang chốt kết quả…</span>
                </>
              ) : (
                <>
                  <p className="qs-eyebrow">Mở thưởng sau</p>
                  <div className={`qs-clock ${soon ? 'qs-soon' : ''}`}>{formatCountdown(msLeft)}</div>
                  <span className="qs-when">
                    {new Date(event.drawAt as string).toLocaleString('vi-VN')} · quay tự động, không cần bấm gì
                  </span>
                </>
              )}
            </section>

            {/* 2 đội TOP */}
            {topTeams.length > 0 && (
              <section>
                <div className="qs-head">
                  <p className="qs-eyebrow">Trao giải</p>
                  <h2 className="qs-display"><span className="qs-skew qs-goldtext">Đội dẫn đầu</span></h2>
                  <p>Điểm danh có mặt để nhận giải.</p>
                </div>
                <div className="qs-champs">
                  {topTeams.map((t) => (
                    <div key={t.id} className={`qs-champ ${t.topRank === 1 ? 'qs-c1' : 'qs-c2'}`}>
                      <div className="qs-medal">{t.topRank}</div>
                      <div className="qs-who">
                        <strong>{t.name}</strong>
                        <span>{t.deals} deal</span>
                        <span className={t.checkedIn ? 'qs-here' : 'qs-await'}>
                          {t.checkedIn ? 'Đã có mặt · sẵn sàng nhận giải ✓' : 'Chưa điểm danh'}
                        </span>
                      </div>
                      {t.topPrizeAmount != null && <div className="qs-cash">{formatVnd(t.topPrizeAmount)}</div>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Lưới đội quay + bánh xe — CHỈ hiện khi thực sự có đội tham gia
                quay. Sự kiện chỉ gồm đội TOP (đã có giải, không vào bánh xe)
                thì vẽ vòng xoay rỗng là vô nghĩa. */}
            {wheelTeams.length > 0 && (
            <>
            <section>
              <div className="qs-head">
                <p className="qs-eyebrow">Vòng xoay {formatVnd(event.prizeAmount)}</p>
                <h2 className="qs-display"><span className="qs-skew">Đội tham gia</span></h2>
                <p>Đội điểm danh mới lên bánh xe. Mỗi đội một ô, cơ hội bằng nhau.</p>
              </div>
              <div className="qs-progress">
                <div className="qs-bar">
                  <i style={{ width: `${wheelTeams.length ? (wheelCheckedIn.length / wheelTeams.length) * 100 : 0}%` }} />
                </div>
                <span className="qs-pcount">
                  {wheelCheckedIn.length}/{wheelTeams.length} đội
                </span>
              </div>
              <div className="qs-grid">
                {wheelTeams.map((t) => (
                  <div
                    key={t.id}
                    className={[
                      'qs-team',
                      t.checkedIn ? 'qs-in' : '',
                      t.isMine ? 'qs-me' : '',
                      revealed && t.id === event.winnerTeamId ? 'qs-win' : '',
                    ].join(' ')}
                  >
                    <div className="qs-tname">{t.name}</div>
                    <div className="qs-tmeta">
                      <span>{t.deals} deal</span>
                      {revealed && t.id === event.winnerTeamId ? (
                        <span className="qs-winlabel">Trúng giải ✦</span>
                      ) : (
                        <span className="qs-tstate">{t.checkedIn ? 'Đã điểm danh ✓' : 'Chưa có mặt'}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Bánh xe */}
            <section className="qs-wheelwrap">
              <LuckyWheelCanvas
                teams={wheelCheckedIn}
                winnerId={event.winnerTeamId}
                spinToken={spinToken}
                onSpinDone={onSpinDone}
              />

              {/* Vào trang sau khi đã quay: bánh xe đứng yên, người xem tự bấm
                  để xem lại màn quay thay vì bị hiện thẳng đáp án. */}
              {canReplay && (
                <button type="button" className="qs-replay" onClick={() => setSpinNonce((n) => n + 1)}>
                  ▶ Xem lại kết quả quay
                </button>
              )}

              <p className="qs-wheelnote" role="status">
                {revealed && winner
                  ? `Chúc mừng ${winner.name} — ${event.prizeLabel} ${formatVnd(event.prizeAmount)}!`
                  : drawn
                    ? canReplay
                      ? 'Sự kiện đã quay xong — bấm nút trên để xem lại màn quay.'
                      : 'Bánh xe đang quay, nín thở…'
                    : wheelCheckedIn.length
                      ? `${wheelCheckedIn.length} đội trên bánh xe · mỗi đội ${(100 / wheelCheckedIn.length).toFixed(1).replace('.', ',')}% cơ hội · quay tự động đúng giờ.`
                      : 'Điểm danh để đội bạn xuất hiện trên bánh xe.'}
              </p>

              {revealed && winner && (
                <>
                  <div className="qs-lastwin">
                    <div className="qs-lw-txt">
                      <small>Đội trúng {event.prizeLabel.toLowerCase()}</small>
                      <strong>{winner.name}</strong>
                    </div>
                    <div className="qs-amt">{formatVnd(event.prizeAmount)}</div>
                  </div>
                  {/* Đội mình không trúng → cổ vũ, không im lặng cho hụt hẫng */}
                  {myTeam && !winnerIsMine && (
                    <div className="qs-cheer">
                      <strong>Chưa tới lượt {myTeam.name} thôi!</strong>
                      <span>
                        Cố lên team ơi — nỗ lực chốt phòng tham gia chương trình sale mới
                        để rinh thưởng đợt tới nhé! 💪🔥
                      </span>
                    </div>
                  )}
                  <button type="button" className="qs-replay-mini" onClick={() => setSpinNonce((n) => n + 1)}>
                    ↺ Quay lại màn công bố
                  </button>
                </>
              )}
            </section>
            </>
            )}
          </>
        )}

        <footer className="qs-footer">
          <p>Kết quả do hệ thống chốt một lần cho tất cả mọi người — ai mở trang cũng thấy cùng một đội trúng.</p>
        </footer>
      </main>

      <canvas className="qs-confetti" ref={confettiRef} aria-hidden="true" />

      {showWin && winner && event && (
        <div
          className="qs-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="qs-win-title"
          onClick={(e) => e.target === e.currentTarget && setShowWin(false)}
        >
          {winnerIsMine ? (
            <div className="qs-winbox">
              <p className="qs-eyebrow">{event.prizeLabel} gọi tên</p>
              <h3 className="qs-display qs-goldtext" id="qs-win-title">{winner.name}</h3>
              <div className="qs-winamount">{formatVnd(event.prizeAmount)}</div>
              <p className="qs-sub">Chính là đội bạn — lên nhận thưởng ngay! 🎉</p>
              <button type="button" onClick={() => setShowWin(false)}>Quá đã!</button>
            </div>
          ) : (
            <div className="qs-winbox qs-softbox">
              <p className="qs-eyebrow">Kết quả đã có</p>
              <h3 className="qs-display" id="qs-win-title">
                {myTeam ? <>Hẹn {myTeam.name} lần sau nhé!</> : <>Hẹn lần sau nhé!</>}
              </h3>
              <p className="qs-cheerline">
                Cố lên team ơi — nỗ lực chốt phòng tham gia chương trình sale mới
                để rinh thưởng đợt tới nhé! 💪🔥
              </p>
              <button type="button" onClick={() => setShowWin(false)}>Quyết tâm đợt tới!</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
