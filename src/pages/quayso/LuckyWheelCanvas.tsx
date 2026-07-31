/**
 * Bánh xe quay số (canvas) — dùng chung cho trang điểm danh /quayso/<slug>
 * và màn chiếu /quayso/<slug>/quay.
 *
 * Server đã chốt đội trúng; component này chỉ quay bánh xe dừng ĐÚNG ô đó.
 * Toán học nằm ở src/lib/luckyWheel.ts (có unit test).
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  POINTER_ANGLE,
  easeOutQuint,
  indexAtPointer,
  normalizeAngle,
  targetRotation,
} from '@/lib/luckyWheel';
import type { LuckyTeamPublic } from '@/lib/luckyDrawApi';

export interface LuckyWheelCanvasProps {
  teams: LuckyTeamPublic[];          // chỉ các đội in_wheel + đã điểm danh
  winnerId: string | null;           // server đã chốt → quay về đội này
  /** Đổi giá trị = quay một lần. null = đứng yên (chờ người xem bấm quay). */
  spinToken: string | null;
  onSpinDone: () => void;
  /** Trần kích thước bánh xe. Trang điểm danh 360; màn chiếu lớn hơn nhiều. */
  maxSize?: number;
  /** Chữ ở tâm bánh xe. */
  hubLabel?: string;
}

export default function LuckyWheelCanvas({
  teams,
  winnerId,
  spinToken,
  onSpinDone,
  maxSize = 360,
  hubLabel = 'IHOME',
}: LuckyWheelCanvasProps) {
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
      ctx.font = `600 ${Math.max(13, size / 24)}px ${stack}`;
      ctx.textAlign = 'center';
      ctx.fillText('Chưa có đội nào', 0, -6);
      ctx.fillText('điểm danh', 0, size / 18 + 8);
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
      ctx.lineWidth = Math.max(1.4, size / 240);
      ctx.stroke();

      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFF2E4';
      // Cỡ chữ theo bán kính để màn chiếu lớn đọc được từ xa.
      const base = n > 9 ? 0.068 : n > 6 ? 0.078 : 0.09;
      ctx.font = `800 ${Math.max(11, size * base)}px ${stack}`;
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 3;
      ctx.fillText(list[i].name.toUpperCase(), R - size * 0.05, 0, R - size * 0.14);
      ctx.restore();
    }
    ctx.restore();

    // Vành vàng + chấm đèn
    ctx.save();
    ctx.translate(R, R);
    ctx.beginPath();
    ctx.arc(0, 0, R - 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFC23C';
    ctx.lineWidth = Math.max(3, size / 120);
    ctx.stroke();
    const dots = size > 460 ? 24 : 16;
    for (let k = 0; k < dots; k++) {
      const ang = (k / dots) * Math.PI * 2 + rot * 0.35;
      const rr = Math.max(2.1, size / 140);
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * (R - size * 0.026), Math.sin(ang) * (R - size * 0.026), rr, 0, Math.PI * 2);
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
    // Màn chiếu: giới hạn thêm theo chiều cao để bánh xe không tràn khỏi khung hình.
    const capH = maxSize > 400 ? (window.innerHeight || 800) * 0.62 : Infinity;
    const size = Math.max(220, Math.min(maxSize, w - 24, capH));
    sizeRef.current = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }, [draw, maxSize]);

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

  // Vẽ lại khi danh sách đổi (điểm danh thêm).
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
      {/* Lớp bọc ôm SÁT canvas: kim và nắp trục neo theo bánh xe, không theo
          khung sân khấu — khung này bị kéo cao ở màn quay nên nếu neo theo nó
          thì kim trôi hẳn lên trên, rời khỏi bánh xe. */}
      <div className="qs-wheelbox">
        <svg className="qs-needle" ref={needleRef} viewBox="0 0 30 40" aria-hidden="true">
          <path d="M15 40 L2 8 A14 14 0 0 1 28 8 Z" fill="#FFC23C" stroke="#8A5D08" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="15" cy="10" r="4.4" fill="#8A5D08" />
        </svg>
        <canvas ref={canvasRef} role="img" aria-label="Vòng xoay may mắn" />
        <div className="qs-hub" aria-hidden="true">{hubLabel}</div>
      </div>
    </div>
  );
}

/** Pháo giấy ăn mừng — vẽ lên canvas phủ toàn màn hình. */
export function fireConfetti(canvas: HTMLCanvasElement | null, count = 150) {
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
  const bits = Array.from({ length: count }, (_, i) => ({
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
