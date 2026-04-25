# Sổ Quỹ — Thiết kế Giao diện Mobile App (`#cashbook`)

> **Module**: `/soquy/index.html#cashbook`
> **Mục tiêu**: Tài liệu chi tiết cách thiết kế giao diện mobile cho tab Sổ Quỹ — đi từ trạng thái hiện tại (responsive web) → mobile-first app-like UX.
> **Đọc cùng**: [docs/architecture/SOQUY.md](../architecture/SOQUY.md), [soquy/css/soquy.css](../../soquy/css/soquy.css), [soquy/index.html](../../soquy/index.html)

---

## Mục lục

1. [Triết lý thiết kế](#1-triết-lý-thiết-kế)
2. [Phân tích trạng thái hiện tại](#2-phân-tích-trạng-thái-hiện-tại)
3. [Breakpoints & Layout System](#3-breakpoints--layout-system)
4. [Information Architecture](#4-information-architecture)
5. [Component Library — Mobile](#5-component-library--mobile)
6. [Màn hình chính (Cashbook List)](#6-màn-hình-chính-cashbook-list)
7. [Filter Drawer (Bottom Sheet)](#7-filter-drawer-bottom-sheet)
8. [Voucher Detail Sheet](#8-voucher-detail-sheet)
9. [Form Tạo/Sửa phiếu (Full-screen)](#9-form-tạosửa-phiếu-full-screen)
10. [Navigation Pattern](#10-navigation-pattern)
11. [Floating Action Button (FAB)](#11-floating-action-button-fab)
12. [Design Tokens (CSS Variables)](#12-design-tokens-css-variables)
13. [Touch Targets & Gestures](#13-touch-targets--gestures)
14. [Performance & Loading States](#14-performance--loading-states)
15. [Accessibility](#15-accessibility)
16. [Roadmap triển khai](#16-roadmap-triển-khai)

---

## 1. Triết lý thiết kế

### 1.1 Nguyên tắc

| # | Nguyên tắc | Áp dụng cụ thể |
|---|------------|----------------|
| 1 | **Thumb-first** | Tất cả tương tác chính (FAB, nav, primary actions) nằm trong vùng ngón cái — bottom-half màn hình |
| 2 | **One-task-one-screen** | Không nhồi nhét: list → detail sheet → form là 3 surface tách biệt |
| 3 | **Glance-first reading** | Stat cards phải scan được trong 1 giây; voucher cards có hierarchy rõ |
| 4 | **Progressive disclosure** | Filter dài 7 nhóm → ẩn trong drawer; cột bảng 18 → ẩn trong card chi tiết |
| 5 | **Native gesture parity** | Swipe-to-cancel, pull-to-refresh, swipe-down-to-close sheet |
| 6 | **No horizontal scroll** | Bảng desktop → card layout dọc; số dài → format compact (`1.5tr`, `999k`) |
| 7 | **Edge-to-edge** | Tận dụng full width 360–430px; padding outer 12–16px; padding card 14–16px |

### 1.2 Style direction

Áp dụng từ [`.claude/rules/web/design-quality.md`](../../.claude/rules/web/design-quality.md): **Clean SaaS minimal + light mode mặc định**, accent màu xanh primary, semantic color cho thu (xanh) / chi (đỏ) / cân bằng (success). Tránh "default Tailwind template" → có:
- Layered surface (card có border-left-color theo loại phiếu)
- Hierarchy bằng scale contrast (mã phiếu 14px medium · ghi chú 13px regular · thời gian 12px muted)
- Hover/active state designed (card press → scale 0.98 + bg-hover)
- Empty state có illustration thay vì text trống

---

## 2. Phân tích trạng thái hiện tại

Giao diện mobile hiện tại đã có nền tảng tốt (xem ảnh tham chiếu). **Đã đúng**:

| Thành phần | Trạng thái | Vị trí |
|-----------|-----------|--------|
| Tab header navigation icons-only | OK | top bar |
| Search bar + filter button rời | OK | dưới top bar |
| Stat cards 2×2 + tồn quỹ wide | OK | `.cashbook-summary` |
| Voucher cards thay bảng | OK | `#mobileVoucherCards` |
| Border-left color theo loại phiếu | OK | đỏ cho chi |
| Status tag inline (`Đã hủy`) | OK | bên cạnh loại phiếu |
| FAB (+) bottom-right | OK | `#mobileFabContainer` |
| Filter drawer slide-in từ trái | OK | `#mobileFilterCloseBtn` |
| Bottom nav "Chat / Thêm" | OK | shared nav |

### 2.1 Cần cải thiện

| Vấn đề hiện tại | Đề xuất | Section |
|-----------------|---------|---------|
| Stat cards chữ "0" lớn nhưng không cho biết currency, không format `1.5tr` | Format compact + đơn vị nhỏ; Tồn quỹ to hơn 2 dòng (số + delta vs đầu kỳ) | [§6.2](#62-summary-cards) |
| Voucher card có 4 dòng meta (loại, ghi chú, thời gian, mã) → chiếm chiều cao lớn, list ngắn | Compress thành 2-row layout: row1 = code + amount; row2 = ghi chú/người + thời gian | [§6.3](#63-voucher-cards) |
| `Phiếu chi CN` + `Đã hủy` 2 chip rời → tốn ngang | Gộp thành 1 chip combined hoặc dùng dot indicator | [§5.2](#52-status-tag) |
| Filter drawer slide từ **trái** trên mobile → kém ergonomic vì thumb phải | Slide từ **phải** hoặc **bottom sheet** kéo lên | [§7](#7-filter-drawer-bottom-sheet) |
| Filter drawer chiều dài → scroll nội bộ trong khi list cũng scroll → confuse | Bottom sheet với drag handle + snap points (40%, 90%) | [§7.1](#71-bottom-sheet-pattern) |
| FAB chỉ có (+) icon → user không biết menu mở ra gì | Press → expand 4 sub-action có label ngay | [§11](#11-floating-action-button-fab) |
| Không có pull-to-refresh | Add | [§13.2](#132-gestures) |
| Detail xem phiếu hiện open modal full-screen → cảm giác như web | Bottom sheet 90% height kéo lên | [§8](#8-voucher-detail-sheet) |
| Ảnh chứng từ trong card không hiển thị thumbnail → user phải tap detail mới thấy | Thumbnail 40×40 góc phải card nếu có | [§6.3](#63-voucher-cards) |

---

## 3. Breakpoints & Layout System

### 3.1 Breakpoints

```css
/* Source: soquy/css/soquy.css existing media queries */
:root {
  --bp-mobile-sm: 360px;   /* iPhone SE, small Android */
  --bp-mobile:    480px;   /* default mobile */
  --bp-tablet:    768px;   /* iPad portrait, large phone landscape */
  --bp-desktop:   1024px;  /* iPad landscape trở lên */
}

/* Mobile range: < 768px → áp dụng full mobile design */
@media (max-width: 768px) { /* ... */ }
@media (max-width: 480px) { /* tighter spacing, compact stats */ }
```

### 3.2 Container & Safe Area

```css
.cashbook-mobile {
  padding-top: env(safe-area-inset-top, 0);
  padding-bottom: calc(env(safe-area-inset-bottom, 0) + 56px); /* room for bottom nav */
  padding-left: env(safe-area-inset-left, 0);
  padding-right: env(safe-area-inset-right, 0);
}
```

### 3.3 Spacing scale

| Token | px | Use |
|-------|----|-----|
| `--space-1` | 4 | inline icon gap |
| `--space-2` | 8 | tag padding, small gap |
| `--space-3` | 12 | card inner padding (mobile) |
| `--space-4` | 16 | section padding, card outer margin |
| `--space-5` | 20 | between major blocks |
| `--space-6` | 24 | sheet header padding |
| `--space-8` | 32 | empty-state vertical |

### 3.4 Grid

- **Outer container**: 100vw, padding-x 12px (mobile-sm) / 16px (mobile).
- **Stat row**: `grid-template-columns: 1fr 1fr; gap: 8px` cho 4 stats nhỏ; `grid-column: 1 / -1` cho stat lớn (Tồn quỹ).
- **Voucher list**: 1 column flex, gap 10px between cards.

---

## 4. Information Architecture

```
┌─────────────────────────────────────────┐
│ TOP BAR                                 │  56px
│  [≡] [Tab icons: nv|sq|bc|lsu]    [⋯]   │
├─────────────────────────────────────────┤
│ SEARCH ROW                              │  48px
│  [🔍 Theo mã phiếu, ...] [≡] [▼filter]   │
├─────────────────────────────────────────┤
│ STATS GRID                              │  ~120px
│  ┌──────────┐ ┌──────────┐              │
│  │ Đầu kỳ   │ │ Tổng thu │              │
│  │ 12.5tr   │ │ 8.3tr ↑  │              │
│  └──────────┘ └──────────┘              │
│  ┌──────────┐ ┌──────────┐              │
│  │ Chi CN   │ │ Chi KD   │              │
│  │ 2.1tr ↓  │ │ 4.8tr ↓  │              │
│  └──────────┘ └──────────┘              │
│  ┌─────────────────────────┐            │
│  │ TỒN QUỸ                 │            │
│  │ 13.9tr  +1.4tr so đầu kỳ│            │
│  └─────────────────────────┘            │
├─────────────────────────────────────────┤
│ VOUCHER LIST (scrollable)               │  flex-1
│  ┌───────────────────────────────────┐  │
│  │▍#CCN000075   Phiếu chi CN  -130k │  │
│  │ MOON + MIN · Grab chở min lên BV │  │
│  │ 03/10/2026 09:06            [📷] │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │▍#TTM000511   Phiếu thu     +5.5tr│  │
│  │ ...                              │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│ BOTTOM NAV (shared/navigation-modern)   │  56px + safe-area
│  [💬 Chat]              [⋯ Thêm]        │
└─────────────────────────────────────────┘
                                    ╔═══╗
                                    ║ + ║ FAB (floating, 56px)
                                    ╚═══╝
```

---

## 5. Component Library — Mobile

### 5.1 Voucher card

```css
.voucher-card-mobile {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto auto;
  row-gap: 4px;
  column-gap: 12px;
  padding: 14px 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent-line); /* dynamic per type */
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.voucher-card-mobile:active {
  transform: scale(0.985);
  box-shadow: 0 0 0 transparent;
}

/* Type-specific accent line color */
.voucher-card-mobile[data-type="receipt"]   { --color-accent-line: var(--color-success); }
.voucher-card-mobile[data-type="payment_cn"]{ --color-accent-line: var(--color-danger); }
.voucher-card-mobile[data-type="payment_kd"]{ --color-accent-line: var(--color-warning); }
.voucher-card-mobile[data-status="cancelled"] { opacity: 0.6; }
```

Layout grid:

```
┌──────────────────────────────────────────────┐
│ #CCN000075  Chi CN  Đã hủy        -130.000 │ row 1
│ MOON + MIN · Grab chở min lên bệnh viện     │ row 2 (line-clamp 1)
│ 03/10/2026 09:06                       [📷] │ row 3
└──────────────────────────────────────────────┘
   ↑ flex-1 ───────────────────────────  ↑ shrink-0
```

- **Row 1**: code (mono, 14px medium) + chips + amount (right-aligned, 15px bold, color-coded).
- **Row 2**: `loại phiếu · ghi chú` (single line, ellipsis, 13px, color-text-secondary).
- **Row 3**: timestamp (12px muted) + thumbnail ảnh nếu có (40×40, border-radius 6px).

### 5.2 Status tag

Thay vì 2 chip rời, dùng **combined chip + dot**:

```html
<span class="vc-chip vc-chip--type-payment-cn">
  Chi CN
  <span class="vc-chip-dot vc-chip-dot--cancelled" aria-label="Đã hủy"></span>
</span>
```

```css
.vc-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  border-radius: 999px;
  background: var(--color-chip-bg);
  color: var(--color-chip-fg);
}
.vc-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success);
}
.vc-chip-dot--cancelled { background: var(--color-danger); }
```

### 5.3 Stat card

```html
<div class="stat-card-mobile" data-tone="receipt">
  <span class="stat-label">TỔNG THU</span>
  <span class="stat-value">8.3<span class="stat-unit">tr</span></span>
  <span class="stat-delta stat-delta--up">↑ 12% vs kỳ trước</span>
</div>
```

```css
.stat-card-mobile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  min-height: 76px;
}
.stat-label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  text-transform: uppercase;
}
.stat-value {
  font-size: 20px;
  font-weight: 700;
  font-feature-settings: "tnum" 1; /* tabular numerals */
  line-height: 1.1;
}
.stat-unit {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-left: 2px;
}
.stat-delta {
  font-size: 11px;
  color: var(--color-text-muted);
}
.stat-card-mobile[data-tone="receipt"]    .stat-value { color: var(--color-primary); }
.stat-card-mobile[data-tone="payment"]    .stat-value { color: var(--color-danger); }
.stat-card-mobile[data-tone="balance"]    .stat-value { color: var(--color-success); }
```

### 5.4 Bottom sheet primitive

```html
<div class="bsheet" role="dialog" aria-modal="true">
  <div class="bsheet-backdrop" data-close></div>
  <div class="bsheet-panel" data-snap="40">
    <div class="bsheet-handle" aria-hidden="true"></div>
    <header class="bsheet-header">
      <h2 class="bsheet-title">Bộ lọc</h2>
      <button class="bsheet-close" aria-label="Đóng"><svg .../></button>
    </header>
    <div class="bsheet-body">...</div>
    <footer class="bsheet-footer">
      <button class="btn-ghost">Đặt lại</button>
      <button class="btn-primary">Áp dụng</button>
    </footer>
  </div>
</div>
```

```css
.bsheet-panel {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  max-height: 90vh;
  background: var(--color-surface);
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.12);
  transform: translateY(100%);
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  flex-direction: column;
}
.bsheet[aria-hidden="false"] .bsheet-panel { transform: translateY(0); }

.bsheet-handle {
  width: 40px;
  height: 4px;
  margin: 8px auto 4px;
  background: var(--color-border);
  border-radius: 2px;
}
```

---

## 6. Màn hình chính (Cashbook List)

### 6.1 Top bar (sticky)

- Height **56px**, sticky top, white bg, border-bottom 1px.
- **Trái**: hamburger menu (`shared/navigation-modern`) → menu app-wide.
- **Giữa**: 4 tab icon-only (Nhân viên, Sổ Quỹ active, Báo cáo, Lịch sử) — chỉ admin thấy đủ 4; user thường chỉ thấy "Sổ Quỹ" → có thể ẩn cả strip.
- **Phải**: avatar / menu overflow.

> **Note**: Tab "Sổ Quỹ" hiện đang highlight underline blue ở ảnh — giữ pattern này.

### 6.2 Summary cards

```html
<section class="cashbook-summary-mobile" aria-label="Tóm tắt sổ quỹ">
  <div class="stat-card-mobile" data-tone="neutral">
    <span class="stat-label">QUỸ ĐẦU KỲ</span>
    <span class="stat-value" id="statOpeningBalance">0</span>
  </div>
  <div class="stat-card-mobile" data-tone="receipt">
    <span class="stat-label">TỔNG THU</span>
    <span class="stat-value" id="statTotalReceipts">0</span>
  </div>
  <div class="stat-card-mobile" data-tone="payment">
    <span class="stat-label">TỔNG CHI CN</span>
    <span class="stat-value" id="statTotalPaymentsCN">0</span>
  </div>
  <div class="stat-card-mobile" data-tone="payment">
    <span class="stat-label">TỔNG CHI KD</span>
    <span class="stat-value" id="statTotalPaymentsKD">0</span>
  </div>
  <div class="stat-card-mobile stat-card--wide" data-tone="balance">
    <span class="stat-label">TỒN QUỸ</span>
    <span class="stat-value stat-value--xl" id="statClosingBalance">0</span>
    <span class="stat-delta">+1.4tr so đầu kỳ</span>
  </div>
</section>
```

```css
.cashbook-summary-mobile {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px 16px 4px;
}
.stat-card--wide {
  grid-column: 1 / -1;
  background: linear-gradient(135deg, #f0f9ff 0%, #ecfdf5 100%);
  border-color: var(--color-success-soft);
}
.stat-value--xl { font-size: 24px; }
```

**Format số**:
- `formatCompact(amount)` → `1.500.000` thành `1.5tr`, `999.000` → `999k`, `< 1000` giữ nguyên.
- Với phiếu chi: prefix `-`; với phiếu thu: prefix `+`.

### 6.3 Voucher cards

```html
<article class="voucher-card-mobile"
         data-type="payment_cn"
         data-status="cancelled"
         data-voucher-id="abc123"
         tabindex="0">
  <div class="vc-row vc-row--head">
    <div class="vc-head-left">
      <span class="vc-code">#CCN000075</span>
      <span class="vc-chip vc-chip--type-payment-cn">
        Chi CN
        <span class="vc-chip-dot vc-chip-dot--cancelled"></span>
      </span>
    </div>
    <span class="vc-amount vc-amount--negative">-130k</span>
  </div>
  <div class="vc-row vc-row--meta">
    <span class="vc-category">MOON + MIN</span>
    <span class="vc-sep">·</span>
    <span class="vc-note">Grab chở min lên bệnh viện</span>
  </div>
  <div class="vc-row vc-row--foot">
    <time class="vc-time" datetime="2026-10-03T09:06">03/10 09:06</time>
    <img class="vc-thumb" src="..." alt="" loading="lazy" width="32" height="32">
  </div>
</article>
```

**Empty state** (`#mobileVoucherCards` rỗng):

```html
<div class="vc-empty">
  <svg class="vc-empty-illustration" .../>
  <h3>Chưa có phiếu nào</h3>
  <p>Thử nới lỏng bộ lọc hoặc tạo phiếu mới bằng nút <kbd>+</kbd> bên dưới.</p>
  <button class="btn-ghost" data-clear-filters>Xóa bộ lọc</button>
</div>
```

### 6.4 Pull-to-refresh

```js
// Pseudo, sử dụng touch events
let pullStart = 0;
list.addEventListener('touchstart', e => {
  if (list.scrollTop === 0) pullStart = e.touches[0].clientY;
});
list.addEventListener('touchmove', e => {
  if (!pullStart) return;
  const delta = e.touches[0].clientY - pullStart;
  if (delta > 60) showPullIndicator();
});
list.addEventListener('touchend', () => {
  if (pullIndicatorVisible) refreshVouchers();
  pullStart = 0;
});
```

### 6.5 Infinite scroll vs pagination

Hiện tại desktop dùng pagination (15/30/50/100 dòng). Mobile **chuyển sang infinite scroll** với `IntersectionObserver`:

```js
const sentinel = document.querySelector('#listSentinel');
const io = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !state.isLoading && state.currentPage < state.totalPages) {
    state.currentPage++;
    appendNextPage();
  }
}, { rootMargin: '200px' });
io.observe(sentinel);
```

Hiển thị "Đang tải thêm..." spinner ở cuối list khi loading.

---

## 7. Filter Drawer (Bottom Sheet)

### 7.1 Bottom sheet pattern

Hiện ảnh cho thấy filter slide từ trái → đổi sang **bottom sheet** với drag-to-dismiss + snap points.

- **Snap 0%** (đóng hoàn toàn) — dismiss
- **Snap 60%** (peek — thấy 3 nhóm filter đầu)
- **Snap 95%** (full — kéo lên để thấy hết)

```css
.filter-bsheet[data-snap="60"]  { transform: translateY(40%); }
.filter-bsheet[data-snap="95"]  { transform: translateY(5%); }
.filter-bsheet[data-snap="0"]   { transform: translateY(100%); }
```

### 7.2 Filter sections (giữ nguyên 7 nhóm)

```
┌─ Bộ lọc ──────────────── × ─┐
│ ━━━━━ (drag handle)         │
├─────────────────────────────┤
│ ▼ Thời gian                 │
│   ○ Tháng này  ▾            │
│   ● Tùy chọn                │
│       [01/03/2026]          │
│       [12/03/2026]          │
├─────────────────────────────┤
│ ▼ Loại chứng từ             │
│   ☐ Phiếu thu               │
│   ☑ Phiếu chi CN            │
│   ☐ Phiếu chi KD            │
├─────────────────────────────┤
│ ▼ Loại thu chi              │
│   [🔍 Tìm loại thu chi]     │
├─────────────────────────────┤
│ ▼ Nguồn                     │
│ ▼ Trạng thái                │
│ ▼ Người tạo                 │
│ ▼ Nhân viên                 │
├─────────────────────────────┤
│ STICKY FOOTER                │
│ [Đặt lại]    [Áp dụng (12)] │
└─────────────────────────────┘
```

### 7.3 Filter chip summary (above list)

Sau khi áp dụng filter → hiện chip summary trên cùng list (ẩn search bar):

```html
<div class="filter-chips" id="filterChips">
  <button class="filter-chip">Tháng này <span>×</span></button>
  <button class="filter-chip filter-chip--active">Phiếu chi CN <span>×</span></button>
  <button class="filter-chip">Đã hủy <span>×</span></button>
  <button class="filter-chip filter-chip--clear">Xóa tất cả</button>
</div>
```

```css
.filter-chips {
  display: flex;
  gap: 6px;
  padding: 8px 16px;
  overflow-x: auto;
  scrollbar-width: none;
  scroll-snap-type: x mandatory;
}
.filter-chip {
  flex-shrink: 0;
  scroll-snap-align: start;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-surface);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.filter-chip--active {
  background: var(--color-primary-soft);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
```

### 7.4 Áp dụng filter

- Realtime preview ở footer: **"Áp dụng (12)"** số phiếu match — debounce 300ms khi thay đổi filter.
- Nhấn "Áp dụng" → close sheet + scroll list lên top + show toast "Đã áp dụng X bộ lọc".

---

## 8. Voucher Detail Sheet

Khi tap vào card → mở **bottom sheet 90% height** (không phải modal full-screen):

```
┌─ Chi tiết phiếu  ──────  × ─┐
│ ━━━━━                       │
├─────────────────────────────┤
│ #CCN000075                  │
│ Chi CN · Đã hủy             │
│                             │
│ ─130.000 ₫                  │
│                             │
├─ THÔNG TIN PHIẾU ───────────┤
│ Loại         MOON + MIN     │
│ Nguồn        AA - Bán hàng  │
│ Quỹ          Tiền mặt       │
│ Thời gian    03/10/26 09:06 │
│ Người tạo    Admin          │
├─ ĐỐI TƯỢNG ────────────────┤
│ Tên          Nguyễn Văn A   │
│ SĐT          0901234567     │
├─ GHI CHÚ ──────────────────┤
│ Grab chở min lên bệnh viện  │
├─ ẢNH CHỨNG TỪ ─────────────┤
│ ┌─────────────────────────┐ │
│ │       (image preview)   │ │
│ └─────────────────────────┘ │
├─ STICKY FOOTER ────────────┤
│  [Hủy phiếu]  [Sửa]        │
└─────────────────────────────┘
```

Permissions: nút Sửa / Hủy ẩn nếu user không có quyền (`edit_voucher`, `cancel_voucher`).

**Swipe down** trên drag handle hoặc trong vùng header → close sheet.
**Tap ảnh** → open lightbox full-screen với pinch-to-zoom.

---

## 9. Form Tạo/Sửa phiếu (Full-screen)

Form là task chính → **full-screen page** thay vì modal/sheet (giống native iOS/Android pattern).

### 9.1 Layout

```
┌──────────────────────────────┐
│ [×]  Tạo phiếu chi CN  [Lưu] │  56px sticky top
├──────────────────────────────┤
│                              │
│ Loại quỹ *                   │
│ ┌──┐ ┌──────────┐ ┌────┐    │
│ │TM│ │Ngân hàng │ │Ví  │    │ segmented control
│ └──┘ └──────────┘ └────┘    │
│                              │
│ Số tiền *                    │
│ ┌──────────────────────────┐ │
│ │  130.000 ₫              │ │ large numeric input
│ └──────────────────────────┘ │
│                              │
│ Loại thu chi *               │
│ [▼ Chọn loại]                │
│                              │
│ Nguồn                        │
│ [▼ Chọn nguồn]               │
│                              │
│ Người nộp/nhận               │
│ [Tên]                        │
│ [SĐT]                        │
│                              │
│ Ghi chú                      │
│ [_________________________]  │
│ [_________________________]  │
│                              │
│ Ảnh chứng từ                 │
│ ┌────────┐ ┌────────┐        │
│ │  +     │ │ [×]    │        │ camera/upload tiles
│ └────────┘ └────────┘        │
│                              │
│ ╭─ Thời gian ─────────────╮  │
│ │ 03/10/2026  09:06       │  │
│ ╰─────────────────────────╯  │
│                              │
└──────────────────────────────┘
```

### 9.2 Numeric keypad cho amount

```html
<input
  type="text"
  inputmode="numeric"
  pattern="[0-9.]*"
  class="amount-input-mobile"
  placeholder="0"
  aria-label="Số tiền">
```

- `inputmode="numeric"` → mobile mở keypad số.
- Auto-format `.` (1.500.000) khi blur.
- Suffix "₫" sticky right.

### 9.3 Image capture

```html
<input type="file" accept="image/*" capture="environment" id="voucherImage">
```

`capture="environment"` → mở camera sau (rear) trên mobile. User có thể chọn from gallery vẫn được.

Sau khi chọn → compress về < 200KB qua `soquy-ui.js compressImage()` → preview thumbnail.

### 9.4 Validation inline

```css
.field--invalid {
  border-color: var(--color-danger);
}
.field-error {
  display: block;
  font-size: 12px;
  color: var(--color-danger);
  margin-top: 4px;
}
```

Hiện lỗi ngay khi blur field, không đợi submit. Submit button disabled cho đến khi tất cả `*` field hợp lệ.

### 9.5 Sticky save button

Nút "Lưu" trong top bar **và** thêm nút full-width sticky bottom (trên mobile, ngón cái dễ với):

```html
<div class="form-footer-sticky">
  <button class="btn-primary btn-block" type="submit">
    Lưu phiếu chi CN
  </button>
</div>
```

```css
.form-footer-sticky {
  position: sticky;
  bottom: 0;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.04);
}
```

---

## 10. Navigation Pattern

### 10.1 Tab strip

Tab "Nhân viên / Sổ Quỹ / Báo cáo / Lịch sử" hiện ở top bar. Trên mobile, **chỉ admin** thấy đủ 4 tab — user thường thấy 1 tab (Sổ Quỹ) → ẩn strip.

Khi có ≥ 2 tab → giữ icon-only ở mobile (như ảnh hiện tại).

### 10.2 Back navigation

- **List → Detail sheet**: swipe down hoặc tap × → close sheet, không thay đổi URL.
- **List → Form (full-screen)**: tap × → confirm dialog nếu form dirty; URL `#cashbook` (không thay đổi).
- **Filter sheet**: swipe down để dismiss; nếu có filter thay đổi chưa apply → confirm "Bỏ thay đổi?".

### 10.3 URL hash

Giữ nguyên hash routing đã có:
- `#cashbook` → list
- `#cashbook?id=abc123` (proposed) → mở detail sheet với voucher abc123 — hỗ trợ deep-link/share.

---

## 11. Floating Action Button (FAB)

### 11.1 Hiện trạng (ảnh)

FAB chỉ là icon `+` ở góc dưới phải. Tap → expand 4 sub-action (đã có trong code: `fabOpenAI`, `fabCreateReceipt`, `fabCreatePaymentKD`, `fabCreatePaymentCN`).

### 11.2 Đề xuất

Speed-dial pattern với label hiện luôn khi expand:

```
                          ╭──────────────╮
                       ╭──┤ Trợ lý AI  AI│
                       │  ╰──────────────╯
                       │  ╭──────────────╮
                       ├──┤ Phiếu thu  Thu│
                       │  ╰──────────────╯
                       │  ╭──────────────╮
                       ├──┤ Chi KD     KD│
                       │  ╰──────────────╯
                       │  ╭──────────────╮
                       ╰──┤ Chi CN     CN│
                          ╰──────────────╯
                          ╔═══╗
                          ║ × ║  (rotate from + to ×)
                          ╚═══╝
```

### 11.3 Style

```css
.mobile-fab-btn {
  position: fixed;
  right: 16px;
  bottom: calc(72px + env(safe-area-inset-bottom)); /* above bottom nav */
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--color-primary);
  color: white;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
  display: grid;
  place-items: center;
  z-index: 40;
  transition: transform 0.18s ease;
}
.mobile-fab-btn:active { transform: scale(0.92); }
.mobile-fab-container.open .mobile-fab-btn { transform: rotate(45deg); }

.mobile-fab-menu {
  position: fixed;
  right: 16px;
  bottom: calc(140px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-end;
  pointer-events: none;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 0.18s, transform 0.18s;
}
.mobile-fab-container.open .mobile-fab-menu {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
.mobile-fab-item {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  background: white;
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
}
```

### 11.4 Backdrop

Khi FAB mở → render backdrop `rgba(0,0,0,0.3)` để tap ngoài đóng menu:

```css
.fab-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0);
  pointer-events: none;
  z-index: 30;
  transition: background 0.2s;
}
.mobile-fab-container.open ~ .fab-backdrop {
  background: rgba(0,0,0,0.3);
  pointer-events: auto;
}
```

---

## 12. Design Tokens (CSS Variables)

```css
:root {
  /* Color — semantic */
  --color-primary:        #2563eb;
  --color-primary-soft:   #eff6ff;
  --color-success:        #10b981;
  --color-success-soft:   #ecfdf5;
  --color-danger:         #ef4444;
  --color-danger-soft:    #fef2f2;
  --color-warning:        #f59e0b;
  --color-warning-soft:   #fffbeb;

  /* Color — neutral */
  --color-surface:        #ffffff;
  --color-bg:             #f7f8fa;
  --color-border:         #e5e7eb;
  --color-text:           #111827;
  --color-text-secondary: #4b5563;
  --color-text-muted:     #9ca3af;

  /* Typography */
  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", Consolas, monospace;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;

  /* Radius */
  --radius-sm:  6px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 999px;

  /* Shadow (subtle on mobile to avoid heavy paint) */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.08);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.12);

  /* Motion */
  --duration-fast: 120ms;
  --duration-normal: 220ms;
  --duration-slow: 280ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

---

## 13. Touch Targets & Gestures

### 13.1 Touch target sizing

| Element | Min size | Notes |
|---------|---------|-------|
| Buttons (icon-only) | 44×44 | Apple HIG, hit area có thể lớn hơn visual |
| Links inline | 32px height | OK nếu không phải primary action |
| Tab bar items | 48×48 | spacing giữa các tab ≥ 8px |
| Voucher card | full width × 76px+ | tap toàn card → mở detail |
| FAB | 56×56 | floating, có ring 8px ngoài hit area |
| Form fields | 44px height | input + select |

### 13.2 Gestures

| Gesture | Hành động |
|---------|-----------|
| Tap voucher card | Mở detail sheet |
| Long-press card | Show context menu (Sửa / Hủy / Sao chép mã) |
| Swipe-left card | Reveal "Hủy phiếu" action (nếu có quyền) |
| Swipe-right card | Reveal "Sửa" action |
| Pull-down list top | Refresh dữ liệu |
| Swipe-down sheet header | Đóng sheet |
| Pinch ảnh trong detail | Zoom |

Implement swipe actions bằng touch events hoặc thư viện nhẹ (e.g. `swiped-events`, ~1KB).

### 13.3 Haptic feedback

```js
function haptic(type = 'light') {
  if (!navigator.vibrate) return;
  const pattern = { light: 10, medium: 20, heavy: [10, 20, 10] }[type];
  navigator.vibrate(pattern);
}

// Khi swipe action confirm
haptic('medium');
// Khi long-press
haptic('light');
```

---

## 14. Performance & Loading States

### 14.1 Skeleton screen

Trong khi `await getVouchers()` — render 6 skeleton cards thay vì spinner trống:

```html
<article class="voucher-card-mobile vc-skeleton" aria-hidden="true">
  <span class="skl skl-line w-30"></span>
  <span class="skl skl-line w-20"></span>
  <span class="skl skl-line w-50"></span>
</article>
```

```css
.skl {
  display: block;
  background: linear-gradient(90deg, #f0f0f0 25%, #e6e6e6 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: skl-pulse 1.4s ease infinite;
  border-radius: 4px;
}
@keyframes skl-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.skl-line { height: 12px; margin: 4px 0; }
.w-20 { width: 20%; } .w-30 { width: 30%; } .w-50 { width: 50%; }
```

### 14.2 Image lazy loading

```html
<img class="vc-thumb"
     src="data:image/svg+xml;base64,..."
     data-src="<actual base64>"
     loading="lazy"
     decoding="async">
```

Vouchers có ảnh base64 trong field `imageData` → không lazy được nếu inline. Giải pháp:
- Render `<img>` chỉ khi card vào viewport (IntersectionObserver).
- Card ngoài viewport → render placeholder div.

### 14.3 List virtualization

Khi `vouchers.length > 200`, áp dụng virtualization (mỗi card height ~ 92px):

```js
const ITEM_HEIGHT = 92;
function renderVisibleRange() {
  const scrollTop = list.scrollTop;
  const startIdx = Math.floor(scrollTop / ITEM_HEIGHT);
  const endIdx = Math.min(startIdx + Math.ceil(window.innerHeight / ITEM_HEIGHT) + 5, total);
  // Render only [startIdx, endIdx]
}
```

Hoặc dùng `<virtualizer>` của Lit / IntersectionObserver primitive nếu không muốn dependency.

### 14.4 Bundle budget

| Layer | Target gzipped |
|-------|-----------------|
| Critical CSS (inline) | < 8 KB |
| Mobile-only JS | < 30 KB |
| Total mobile JS | < 200 KB |

Defer tải `xlsx.full.min.js`, `lucide.min.js` (lazy chỉ khi cần).

---

## 15. Accessibility

### 15.1 ARIA roles

```html
<section aria-label="Tóm tắt sổ quỹ">
  <div class="stat-card-mobile" role="figure" aria-labelledby="lblOpening">
    <span class="stat-label" id="lblOpening">QUỸ ĐẦU KỲ</span>
    <span class="stat-value">12.500.000 ₫</span>
  </div>
</section>

<ul class="voucher-list" role="list">
  <li>
    <article class="voucher-card-mobile"
             role="button"
             tabindex="0"
             aria-labelledby="vc-001-code"
             aria-describedby="vc-001-amount">
      ...
    </article>
  </li>
</ul>
```

### 15.2 Focus management

- Khi mở sheet → focus chuyển vào sheet, trap focus bên trong.
- Khi đóng → focus trở về trigger element (card, button).
- Skip link "Bỏ qua bộ lọc" cho keyboard user.

### 15.3 Color contrast

- Text trên surface: contrast ≥ 4.5:1.
- Số tiền (text-success/danger) trên surface: kiểm tra `#10b981` trên `#fff` = 3.4 → **fail AA**. → dùng `#059669` (5.0:1).
- `text-muted` (`#9ca3af` trên `#fff` = 2.85) chỉ dùng cho text không quan trọng (timestamp, label).

### 15.4 Screen reader

- Số tiền: `aria-label="Trừ một trăm ba mươi nghìn đồng"` thay vì đọc raw `-130.000`.
- Status tag: `aria-label="Đã hủy"` cho dot indicator.
- Empty state: `role="status"` để SR đọc thông báo.

### 15.5 Reduced motion

Đã handle ở §12 — disable animation khi `prefers-reduced-motion: reduce`.

---

## 16. Roadmap triển khai

### Phase 1 — Polish responsive hiện tại (1 sprint)

- [ ] Compact stat cards (2x2 + wide), format `tr/k` theo §6.2
- [ ] Voucher card 2-row layout theo §6.3
- [ ] Combined chip + dot status theo §5.2
- [ ] Border-left color theo loại phiếu (đã có cho `payment_cn`, thêm cho `receipt`/`payment_kd`)
- [ ] Format compact amount với `formatCompact()` helper
- [ ] FAB sub-action có label luôn hiện khi expand

**Files đụng đến:**
- [`soquy/css/soquy.css`](../../soquy/css/soquy.css) — section `@media (max-width: 768px)` từ dòng 3176
- [`soquy/js/soquy-ui.js`](../../soquy/js/soquy-ui.js) — function render mobile cards

### Phase 2 — Bottom sheet refactor (1 sprint)

- [ ] Tạo primitive `bsheet` component (CSS + JS)
- [ ] Đổi filter từ side drawer → bottom sheet với snap points
- [ ] Đổi voucher detail từ modal full-screen → bottom sheet 90%
- [ ] Filter chip summary trên top of list
- [ ] Apply/Reset footer sticky

**Files đụng đến:**
- New: [`soquy/css/mobile-bsheet.css`](../../soquy/css/mobile-bsheet.css)
- New: [`soquy/js/mobile-bsheet.js`](../../soquy/js/mobile-bsheet.js)
- Modify: [`soquy/index.html`](../../soquy/index.html) — wrap filter, detail vào bsheet
- Modify: [`soquy/js/soquy-ui.js`](../../soquy/js/soquy-ui.js) — open/close handlers

### Phase 3 — Form full-screen + camera (1 sprint)

- [ ] Tách form Tạo/Sửa thành full-screen page (route `#cashbook/new?type=...`)
- [ ] Numeric keypad cho amount field
- [ ] `capture="environment"` cho image input
- [ ] Sticky save button bottom
- [ ] Inline validation per field

### Phase 4 — Gestures + perf (1 sprint)

- [ ] Pull-to-refresh
- [ ] Swipe actions trên card (Sửa/Hủy)
- [ ] Long-press context menu
- [ ] Skeleton screens
- [ ] Infinite scroll thay pagination
- [ ] List virtualization khi > 200 items
- [ ] Haptic feedback cho swipe/long-press

### Phase 5 — A11y + polish (1 sprint)

- [ ] ARIA labels đầy đủ
- [ ] Focus trap trong sheet
- [ ] Color contrast audit
- [ ] Reduced motion
- [ ] Screen reader testing (VoiceOver / TalkBack)

---

## Phụ lục A — Mapping component → file/dòng hiện có

| Mobile component | File hiện tại | Section |
|------------------|---------------|---------|
| Mobile filter drawer | [`index.html:367`](../../soquy/index.html#L367), CSS [`soquy.css:3273`](../../soquy/css/soquy.css#L3273) | §7 |
| Mobile voucher cards | [`index.html:638`](../../soquy/index.html#L638), CSS [`soquy.css:3369`](../../soquy/css/soquy.css#L3369) | §6.3 |
| FAB container | [`index.html:670-693`](../../soquy/index.html#L670-L693), CSS [`soquy.css:3612-3700`](../../soquy/css/soquy.css#L3612-L3700) | §11 |
| Stats grid | [`index.html:587-608`](../../soquy/index.html#L587-L608) | §6.2 |
| Filter chips (proposed) | _new_ | §7.3 |
| Bottom sheet primitive | _new_ | §5.4 |

## Phụ lục B — Sự khác biệt với phiên bản desktop

| Yếu tố | Desktop | Mobile |
|--------|---------|--------|
| Filter | Sidebar trái 280px luôn hiện | Bottom sheet, hidden by default |
| List | Bảng 18 cột, horizontal scroll | Card 1 cột, key info only |
| Detail | Modal full-screen | Bottom sheet 90% |
| Form | Modal centered 600×auto | Full-screen route |
| Pagination | Số trang + select page size | Infinite scroll |
| Tabs | Text + icon | Icon-only |
| Action buttons | Inline trong top bar | FAB + sub-actions |
| Cột visibility toggle | Dropdown | Bỏ — luôn show key info |

---

**Bản này là bản gốc. Mọi thay đổi UX mobile tương lai phải cập nhật doc này song song với code.**
