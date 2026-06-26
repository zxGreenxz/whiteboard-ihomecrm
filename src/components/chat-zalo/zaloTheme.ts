// Bảng màu + helper cho Chat Zalo — port nguyên TONE/TAG từ design
// `Chat Zalo.dc.html`. Trả về React.CSSProperties để giữ pixel fidelity.
import type { CSSProperties } from 'react';
import type { ToneKey, TagKey } from './types';

/** Màu nền/chữ avatar theo tông. */
export const TONE: Record<ToneKey, { bg: string; fg: string }> = {
  emerald: { bg: 'hsl(152 40% 90%)', fg: 'hsl(152 69% 28%)' },
  blue: { bg: 'hsl(214 95% 92%)', fg: 'hsl(224 76% 48%)' },
  purple: { bg: 'hsl(269 100% 95%)', fg: 'hsl(273 67% 45%)' },
  orange: { bg: 'hsl(34 100% 92%)', fg: 'hsl(17 88% 42%)' },
  rose: { bg: 'hsl(0 86% 94%)', fg: 'hsl(0 70% 48%)' },
  slate: { bg: 'hsl(210 40% 93%)', fg: 'hsl(215 25% 35%)' },
};

/** Màu nền/chữ badge theo loại. */
export const TAG: Record<TagKey, { bg: string; fg: string }> = {
  success: { bg: 'hsl(138 76% 97%)', fg: 'hsl(142 72% 29%)' },
  info: { bg: 'hsl(214 95% 94%)', fg: 'hsl(224 76% 46%)' },
  debt: { bg: 'hsl(34 100% 92%)', fg: 'hsl(17 88% 40%)' },
  danger: { bg: 'hsl(0 86% 96%)', fg: 'hsl(0 70% 45%)' },
  warning: { bg: 'hsl(55 97% 88%)', fg: 'hsl(32 81% 29%)' },
  purple: { bg: 'hsl(269 100% 95%)', fg: 'hsl(273 67% 42%)' },
  neutral: { bg: 'hsl(210 20% 95%)', fg: 'hsl(215 25% 35%)' },
};

/** Màu chủ đạo (emerald) — trùng --primary của app. */
export const EMERALD = 'hsl(152 69% 31%)';
export const MONO = "'Space Mono', ui-monospace, monospace";

export function toneOf(tone?: ToneKey | null) {
  return TONE[(tone as ToneKey) ?? 'emerald'] ?? TONE.emerald;
}

/** Style badge theo TAG (giống tagStyle() trong design). */
export function tagStyle(t: TagKey, extra?: CSSProperties): CSSProperties {
  const c = TAG[t] || TAG.neutral;
  return {
    background: c.bg,
    color: c.fg,
    fontSize: '11px',
    fontWeight: 700,
    padding: '3px 10px',
    borderRadius: '8px',
    whiteSpace: 'nowrap',
    ...extra,
  };
}

/** Style avatar tròn theo tông. */
export function avatarStyle(tone: ToneKey | null | undefined, size = 46, fontSize = 15): CSSProperties {
  const c = toneOf(tone);
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    background: c.bg,
    color: c.fg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize,
    flex: 'none',
  };
}

/** Gradient cho tile ảnh trong bong bóng. */
export const IMG_GRADS: Record<string, string> = {
  neutral: 'linear-gradient(135deg, hsl(152 25% 94%), hsl(210 25% 93%))',
  room: 'linear-gradient(135deg, hsl(152 26% 91%), hsl(200 24% 90%))',
  warm: 'linear-gradient(135deg, hsl(34 40% 90%), hsl(20 40% 88%))',
};
