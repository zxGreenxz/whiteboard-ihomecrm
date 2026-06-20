import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Search, TrendingUp, Wallet, Building2 } from 'lucide-react';
import './homeLauncher.css';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useDashboardStats } from '@/hooks/useDashboard';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { LAUNCHER_SECTIONS, type LauncherTile } from './launcherTiles';
import { runLauncherPrefetch } from './launcherPrefetch';

// Rút gọn tiền cho ô hero: 18.4tr · 84.5tr · 1.2 tỷ (đồng bộ style Space Mono
// của Thu tiền). Số nhỏ < 1.000 thì để nguyên.
const fmtShort = (n: number): string => {
  const x = Number(n) || 0;
  const v = Math.abs(x);
  if (v >= 1_000_000_000) return (x / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + ' tỷ';
  if (v >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'tr';
  if (v >= 1_000) return Math.round(x / 1_000) + 'k';
  return String(x);
};

const greetByHour = (): string => {
  const h = new Date().getHours();
  if (h < 11) return 'Chào buổi sáng,';
  if (h < 13) return 'Chào buổi trưa,';
  if (h < 18) return 'Chào buổi chiều,';
  return 'Chào buổi tối,';
};

// Chữ cái đầu của TÊN (từ cuối) cho avatar — giống cách Header lấy initials.
const avatarInitial = (name?: string | null, email?: string | null): string => {
  const n = name?.trim();
  if (n) {
    const parts = n.split(/\s+/);
    return parts[parts.length - 1][0].toUpperCase();
  }
  return (email?.[0] || 'U').toUpperCase();
};

/**
 * Home launcher — màn hình chủ dạng app (mobile web-app).
 * Dựng pixel theo handoff Claude Design (ui_kits/mobile-app: index.html +
 * Home.jsx), nhưng nối dữ liệu THẬT: tên user (useProfile), 2 thẻ hero
 * (useDashboardStats), ô phân mục lọc theo quyền (useMyPermissions + canUse),
 * mỗi ô là <Link> tới đúng route đang có. CSS scope riêng (.hl-stage/.hl-app),
 * KHÔNG bọc MainLayout — đây là shell độc lập như Thu tiền.
 */
const HomeLauncher = () => {
  const { data: user } = useAuth();
  const { data: profile } = useProfile();
  const { data: stats } = useDashboardStats(null);
  const { data: perms } = useMyPermissions();

  // Prefetch code + data của trang ngay khi ngón tay chạm ô (pointerdown) hoặc rê
  // chuột (thiết bị có con trỏ) → vào trang là có sẵn, không nháy "Đang tải".
  const queryClient = useQueryClient();
  const fired = useRef<Set<string>>(new Set());
  const prefetch = (id: string) => {
    if (fired.current.has(id)) return;
    fired.current.add(id);
    runLauncherPrefetch(id, queryClient);
  };

  const name = profile?.full_name || user?.email || 'Bạn';

  // Ô chỉ hiện khi có quyền XEM tương ứng (khớp đúng route guard). Section rỗng → ẩn.
  const canShow = (t: LauncherTile) => !t.module || canUse(perms, t.module, t.action ?? 'view');
  const sections = LAUNCHER_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter(canShow) }))
    .filter((s) => s.items.length > 0);

  const badgeOf = (t: LauncherTile): string | null => {
    if (t.badge === 'totalRooms' && stats?.totalRooms) return String(stats.totalRooms);
    return null;
  };

  return (
    <div className="hl-stage">
      <div className="hl-app">
        <div className="route route-anim">
          <header className="home-hdr">
            <div className="hh-top">
              <div className="hh-mark"><Building2 /></div>
              <div className="hh-greet">
                <span className="hh-hello">{greetByHour()}</span>
                <span className="hh-name">{name}</span>
              </div>
              <div className="hh-actions">
                <Link to="/notifications" className="hh-icbtn" aria-label="Thông báo">
                  <Bell /><span className="nt" />
                </Link>
                <Link to="/account/profile" className="hh-avatar" aria-label="Tài khoản">
                  {avatarInitial(profile?.full_name, profile?.email || user?.email)}
                </Link>
              </div>
            </div>
            <div className="hh-search">
              <Search />
              <span>Tìm phòng, khách, hoá đơn…</span>
            </div>
          </header>

          <div className="home-body">
            <div className="hero">
              <div className="hero-card rev">
                <div className="hero-l"><TrendingUp />THU THÁNG NÀY</div>
                <div className="hero-v">{stats ? fmtShort(stats.revenueThisMonth) : '—'}<small>₫</small></div>
                <div className="hero-s">{stats ? `${stats.occupiedRooms} phòng đang thuê` : ' '}</div>
              </div>
              <div className="hero-card debt">
                <div className="hero-l"><Wallet />CÔNG NỢ</div>
                <div className="hero-v">{stats ? fmtShort(stats.totalDebt) : '—'}<small>₫</small></div>
                <div className="hero-s">{stats ? 'Tổng còn phải thu' : ' '}</div>
              </div>
            </div>

            {sections.map((sec) => (
              <section className="lsec" key={sec.label}>
                <p className="lsec-lbl">{sec.label}</p>
                <div className="lgrid">
                  {sec.items.map((t) => {
                    const Icon = t.icon;
                    const badge = badgeOf(t);
                    const soft = !(t.id === 'thu-tien' || t.id === 'invoices');
                    return (
                      <Link
                        key={t.id}
                        to={t.href}
                        className={'tile' + (t.hot ? ' hot' : '')}
                        onPointerDown={() => prefetch(t.id)}
                        onMouseEnter={() => prefetch(t.id)}
                      >
                        <span className="tile-ic" style={{ background: t.accent }}>
                          <Icon />
                          {badge ? (
                            <span className={'tile-badge' + (soft ? ' soft' : '')}>{badge}</span>
                          ) : null}
                        </span>
                        <span className="tile-lbl">{t.title}</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomeLauncher;
