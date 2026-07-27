import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Trạng thái thu gọn / mở rộng của sidebar desktop.
 *
 * Theo mock "Sidebar Auto Hide.dc.html" (Claude Design) — phương án 1a làm mặc
 * định, phủ thêm 1d:
 *  - 1a: mặc định là RAIL 72px chỉ hiện icon; rê chuột vào rail → panel bung ra
 *    264px NỔI ĐÈ lên nội dung (không đẩy bảng). Nút ghim khoá trạng thái mở,
 *    khi đã ghim thì sidebar đẩy nội dung như bình thường.
 *  - 1d: lần đầu vào (chưa ghim tay) hệ thống tự chọn theo bề ngang màn hình —
 *    ≥ 1440px mở đầy đủ, 1024–1440px thu về rail, < 1024px là drawer (mobile,
 *    do MainLayout xử lý bằng Sheet). Người dùng bấm tay 1 lần là quyền quyết
 *    định thuộc về họ: hệ thống thôi tự đổi.
 */

/** Bề ngang rail (chỉ icon). */
export const SIDEBAR_RAIL_WIDTH = 72;
/** Bề ngang khi mở đầy đủ. */
export const SIDEBAR_FULL_WIDTH = 264;
/** Trễ MỞ khi rê chuột vào rail — đủ để chuột lướt ngang không làm bung sidebar. */
export const SIDEBAR_HOVER_OPEN_MS = 120;
/** Trễ ĐÓNG khi chuột rời panel. */
export const SIDEBAR_HOVER_CLOSE_MS = 220;
/** Thời lượng chuyển động width/transform/opacity. */
export const SIDEBAR_TRANSITION_MS = 220;
export const SIDEBAR_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** Ngưỡng 1d: từ đây trở lên thì tự mở đầy đủ. */
export const SIDEBAR_AUTO_EXPAND_PX = 1440;

const STORAGE_PREFIX = 'ihomecrm:sidebar-pinned:';

const storageKey = (userId?: string | null) => `${STORAGE_PREFIX}${userId ?? 'anon'}`;

/** null = chưa chọn tay → để 1d tự quyết. */
type PinnedState = boolean | null;

const readPinned = (key: string): PinnedState => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage bị chặn (private mode / iframe) — coi như chưa chọn.
  }
  return null;
};

const autoExpandedFor = (width: number) => width >= SIDEBAR_AUTO_EXPAND_PX;

export interface SidebarState {
  /** Sidebar chiếm chỗ trong luồng bố cục (đẩy nội dung) — tức đang ghim mở. */
  expanded: boolean;
  /** Panel đang hiện đầy đủ 264px (do ghim HOẶC do rê chuột). */
  panelExpanded: boolean;
  /** Panel đang nổi đè lên nội dung (mở tạm bằng chuột, chưa ghim). */
  floating: boolean;
  /** Đã ghim mở hay chưa (dùng cho icon nút ghim + aria). */
  pinned: boolean;
  /** Bề ngang chỗ sidebar chiếm trong luồng. */
  flowWidth: number;
  /** Bề ngang panel thật. */
  panelWidth: number;
  /** 0 khi user bật prefers-reduced-motion. */
  durationMs: number;
  toggle: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export const useSidebarState = (userId?: string | null): SidebarState => {
  const key = storageKey(userId);

  const [pinned, setPinned] = useState<PinnedState>(() => readPinned(storageKey(userId)));
  const [hovering, setHovering] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? SIDEBAR_AUTO_EXPAND_PX : window.innerWidth
  );
  const [reducedMotion, setReducedMotion] = useState(false);

  const openTimer = useRef<ReturnType<typeof setTimeout>>();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  // Đổi tài khoản (hoặc userId về muộn sau khi useAuth resolve) → đọc lại lựa
  // chọn đã lưu của đúng tài khoản đó.
  useEffect(() => {
    setPinned(readPinned(key));
  }, [key]);

  // Đồng bộ giữa các tab đang mở: tab kia ghim/bỏ ghim thì tab này đổi theo.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      setPinned(e.newValue === 'true' ? true : e.newValue === 'false' ? false : null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    []
  );

  // 1d: chưa chọn tay thì hệ thống tự quyết theo bề ngang màn hình.
  const expanded = pinned ?? autoExpandedFor(viewportWidth);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const toggle = useCallback(() => {
    const next = !expandedRef.current;
    setPinned(next);
    setHovering(false);
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(key, String(next));
      } catch {
        // Không lưu được thì vẫn đổi trạng thái trong phiên hiện tại.
      }
    }
  }, [key]);

  // Ctrl/⌘ + B — phím tắt chuẩn của sidebar.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if ((e.key || '').toLowerCase() !== 'b') return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const onPointerEnter = useCallback(() => {
    clearTimeout(closeTimer.current);
    if (expandedRef.current) return;
    openTimer.current = setTimeout(() => setHovering(true), SIDEBAR_HOVER_OPEN_MS);
  }, []);

  const onPointerLeave = useCallback(() => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setHovering(false), SIDEBAR_HOVER_CLOSE_MS);
  }, []);

  return useMemo(() => {
    const panelExpanded = expanded || hovering;
    return {
      expanded,
      panelExpanded,
      floating: panelExpanded && !expanded,
      pinned: expanded,
      flowWidth: expanded ? SIDEBAR_FULL_WIDTH : SIDEBAR_RAIL_WIDTH,
      panelWidth: panelExpanded ? SIDEBAR_FULL_WIDTH : SIDEBAR_RAIL_WIDTH,
      durationMs: reducedMotion ? 0 : SIDEBAR_TRANSITION_MS,
      toggle,
      onPointerEnter,
      onPointerLeave,
    };
  }, [expanded, hovering, reducedMotion, toggle, onPointerEnter, onPointerLeave]);
};
