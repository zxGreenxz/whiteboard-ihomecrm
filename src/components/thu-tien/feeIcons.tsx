// Map registry icon-key → lucide component (giữ feeCategories.ts pure, không import React).
import {
  LayoutGrid, Plug, Home, Wifi, Briefcase, Sparkles, Shield, Trash2, Percent, Wrench,
  Wallet, HandCoins, PiggyBank,
  type LucideIcon,
} from 'lucide-react';

// Thang máy: lucide không có → SVG tùy biến (khớp mockup: hộp + chevron lên/xuống).
export function ElevatorIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <path d="m9 10 3-3 3 3" />
      <path d="m9 14 3 3 3-3" />
    </svg>
  );
}

const MAP: Record<string, LucideIcon | typeof ElevatorIcon> = {
  overview: LayoutGrid,
  plug: Plug,
  home: Home,
  wifi: Wifi,
  briefcase: Briefcase,
  sparkles: Sparkles,
  shield: Shield,
  trash: Trash2,
  elevator: ElevatorIcon,
  percent: Percent,
  wrench: Wrench,
  wallet: Wallet,
  handcoins: HandCoins,
  piggybank: PiggyBank,
};

export function FeeIcon({ name, ...props }: { name: string } & React.SVGProps<SVGSVGElement>) {
  const C = MAP[name] ?? LayoutGrid;
  return <C {...props} />;
}
