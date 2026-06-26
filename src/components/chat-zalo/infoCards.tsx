import type { CSSProperties, ReactNode } from 'react';
import { MONO } from './zaloTheme';

/** Card khung trắng bo góc dùng chung trong panel thông tin. */
export function InfoCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: '1px solid hsl(210 20% 90%)', borderRadius: 12, padding: '13px 14px', ...style }}>
      {children}
    </div>
  );
}

/** Nhãn nhỏ in hoa phía trên mỗi card. */
export function CardLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'hsl(210 10% 50%)', marginBottom: 8, ...style }}>
      {children}
    </div>
  );
}

export const mono = (extra?: CSSProperties): CSSProperties => ({ fontFamily: MONO, ...extra });
