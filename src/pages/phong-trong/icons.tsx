import React from "react";

type P = React.SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
  );
}

export const Icon = {
  Grid:  (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></Svg>,
  List:  (p: P) => <Svg {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></Svg>,
  Check: (p: P) => <Svg {...p}><polyline points="20 6 9 17 4 12"/></Svg>,
  Pin:   (p: P) => <Svg {...p}><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/></Svg>,
  Money: (p: P) => <Svg {...p}><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M9.5 9.5c0-1.1 1.1-1.8 2.5-1.8s2.5.7 2.5 1.8-1.1 1.6-2.5 1.6-2.5.6-2.5 1.7 1.1 1.8 2.5 1.8 2.5-.7 2.5-1.8"/></Svg>,
  Photo: (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 18 5-5 3 3 3-4 5 6"/></Svg>,
  Calendar: (p: P) => <Svg {...p}><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></Svg>,
  Copy:  (p: P) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></Svg>,
  Phone: (p: P) => <Svg {...p}><path d="M5 3.5h3.5l1.6 4.2-2.1 1.5a13 13 0 0 0 5.8 5.8l1.5-2.1 4.2 1.6V18a2.5 2.5 0 0 1-2.7 2.5A16.5 16.5 0 0 1 4.5 6.2 2.5 2.5 0 0 1 5 3.5Z"/></Svg>,
  Share: (p: P) => <Svg {...p}><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="m8.1 11 7.8-3.8M8.1 13l7.8 3.8"/></Svg>,
  Route: (p: P) => <Svg {...p}><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="6" r="2.2"/><path d="M9 18h6.5a2.5 2.5 0 0 0 0-5h-7a2.5 2.5 0 0 1 0-5H15"/></Svg>,
  Heart: (p: P) => <Svg {...p}><path d="M12 20s-7-4.5-9.2-9C1.3 8 2.6 4.5 6 4.5c2 0 3.3 1.3 4 2.5.7-1.2 2-2.5 4-2.5 3.4 0 4.7 3.5 3.2 6.5C19 15.5 12 20 12 20Z"/></Svg>,
  HeartFill: (p: P) => <Svg {...p} fill="currentColor" stroke="none"><path d="M12 20s-7-4.5-9.2-9C1.3 8 2.6 4.5 6 4.5c2 0 3.3 1.3 4 2.5.7-1.2 2-2.5 4-2.5 3.4 0 4.7 3.5 3.2 6.5C19 15.5 12 20 12 20Z"/></Svg>,
  Close: (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18"/></Svg>,
  Layers: (p: P) => <Svg {...p}><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></Svg>,
  Snow:  (p: P) => <Svg {...p}><path d="M12 2v20M4 6l16 12M20 6 4 18M2 12h20"/></Svg>,
  Bell:  (p: P) => <Svg {...p}><path d="M18 8a6 6 0 0 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8ZM10 19a2 2 0 0 0 4 0"/></Svg>,
  Sun:   (p: P) => <Svg {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></Svg>,
  Refresh: (p: P) => <Svg {...p}><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4"/></Svg>,
  Dot:   (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9"/></Svg>,
  Info:  (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></Svg>,
  Tag:   (p: P) => <Svg {...p}><path d="M3.5 12.5 11 5h6.5V11.5L10 19a2 2 0 0 1-2.8 0L3.5 15.3a2 2 0 0 1 0-2.8Z"/><circle cx="14.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/></Svg>,
  Chevron: (p: P) => <Svg {...p}><polyline points="9 6 15 12 9 18"/></Svg>,
  Elevator: (p: P) => <Svg {...p}><rect x="5" y="2.5" width="14" height="19" rx="2"/><line x1="12" y1="2.5" x2="12" y2="21.5"/><path d="M9.6 9.5 12 6.4l2.4 3.1z" fill="currentColor" stroke="none"/><path d="M9.6 14.5 12 17.6l2.4-3.1z" fill="currentColor" stroke="none"/></Svg>,
  Stairs:   (p: P) => <Svg {...p}><path d="M4 20v-3.4h3.4V13.2h3.4V9.8h3.4V6.4H21"/></Svg>,
};

export function amenIcon(name: string) {
  const map: Record<string, (p: P) => JSX.Element> = {
    "Máy lạnh": Icon.Snow, "View thành phố": Icon.Sun, "Cửa sổ lớn": Icon.Sun,
    "Ban công": Icon.Layers, "Gác lửng": Icon.Layers, "Wifi": Icon.Bell,
  };
  const C = map[name] || Icon.Check;
  return <C />;
}
