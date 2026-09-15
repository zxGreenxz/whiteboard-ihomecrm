# Rà soát toàn hệ thống 15/09/2026 — 13 plan con chạy song song

Plan tổng (đã duyệt): `docs/plans/ra-soat-2026-09-15/00-PLAN-TONG.md`. Mỗi file dưới đây là phần việc của **một session/worktree**.

## Cách chạy

1. Mở đúng thư mục worktree `C:\Users\Nguyen Tam\rasoat-worktrees\<X>` trong một cửa sổ VS Code riêng.
2. Chạy Claude Code và dán: `Đọc docs/plans/ra-soat-2026-09-15/<X>.md và thực hiện đúng plan đó. Chỉ sửa file trong bảng sở hữu của plan <X>. Không push. Xong thì báo cáo theo mẫu ở cuối file.`
3. Tối đa 5–6 session một lượt: đợt 1 = A, C, H1, H2, I1; đợt 2 = D, F, I2, I3; đợt 3 = B, E, G, H3.
4. Không session nào push. Người gộp rà diff, chạy gate, rebase, gộp theo thứ tự: A → C → I2 → D → B → E (frontend), rồi F → H1 → H2 → H3 → I1 → I3 (migration), G độc lập.

## Danh sách

- [A](A.md) — 2. Plan con A (P0) — Bug: tạo HĐ xong mở phiếu hoa hồng, đang điền thì form tự xoá rồi kẹt "Đang tải thông tin hợp đồng..."
- [B](B.md) — 3. Plan con B (P1) — Hub realtime tự đánh lại mutation của chính mình + bão prefetch
- [C](C.md) — 4. Plan con C (P0) — Lỗi bị biến thành dữ liệu rỗng (đọc)
- [D](D.md) — 5. Plan con D (P0/P1) — Query không giới hạn, dialog fetch sớm, N+1
- [E](E.md) — 6. Plan con E (P1) — Render: ảo hoá + memo cho 3 màn nặng nhất
- [F](F.md) — 7. Plan con F (P0/P1) — Database (đã đối chiếu catalog production 15/09)
- [G](G.md) — 8. Plan con G (P1) — CI/CD, quy trình, vệ sinh repo
- [H1](H1.md) — 9. Plan con H — Logic nghiệp vụ (tiền) — chia 3 session H1/H2/H3, mỗi session một cụm migration riêng
- [H2](H2.md) — 9. Plan con H — Logic nghiệp vụ (tiền) — chia 3 session H1/H2/H3, mỗi session một cụm migration riêng
- [H3](H3.md) — 9. Plan con H — Logic nghiệp vụ (tiền) — chia 3 session H1/H2/H3, mỗi session một cụm migration riêng
- [I1](I1.md) — 10. Plan con I — Phân quyền công ty / người dùng — chia 3 session I1/I2/I3
- [I2](I2.md) — 10. Plan con I — Phân quyền công ty / người dùng — chia 3 session I1/I2/I3
- [I3](I3.md) — 10. Plan con I — Phân quyền công ty / người dùng — chia 3 session I1/I2/I3

## Bảng sở hữu file (toàn bộ)

| Plan | Sở hữu | Không được đụng |
|---|---|---|
| A | CommissionVoucherModal.tsx, useCommissionVoucher.ts, realtime/finance.ts (dòng 67), spec E2E mới | useRealtimeDataSync.ts |
| B | useRealtimeDataSync.ts, prefetchPages.ts, useContracts.ts (onSuccess 612-621), useInvoices.ts (46-59) | finance.ts |
| C | 39 hook nuốt lỗi, useMyPermissions, RequirePermission, QueryProvider, ratchet error-swallow | useRooms.ts (D sở hữu) |
| D | IncomeExpenseForm, useRooms, useRoomsWithContracts, useMeters, useLeads, useMaterials, useTenants, useManagerSalary (330-345), 11 dialog, OrganizationContext, migration v5_month_money_bulk | AssetsPage (E) |
| E | AssetsPage, useAssets, RoomsPage, RoomListTable, DepositsPage, LeadsPage, package.json, bundle-baseline | hooks của D |
| F | migration mới ×4–5, surfaces/generated regen | src/** |
| G | kiem-nhanh-truoc-push.mjs, .gitignore, ci-gates.yml (paths), known-gaps.yaml, check-known-gaps.mjs | src/** |
| H1 | migration `hoa_don_*`, invoiceUtils.ts, useInvoices.ts (khối cancel), test | recompute deposit (H2) |
| H2 | migration `coc_thanh_ly_*`, terminationSettlement.ts, useContracts.ts (khối termination 1150-1200), test | update_room_status (F) |
| H3 | migration `phieu_*`, statusMutations.ts, useAccounts.ts (dòng 104 → RPC), test | create_commission_voucher amount (chờ chủ) |
| I1 | migration `luong_authz_*` (guard v5_month_money/v5_n_chuan/config + RPC bulk `v5_month_money_bulk`), useManagerSalary.ts (330-345), scripts/test-cross-tenant.mjs | — (D.4 chuyển sang I1) |
| I2 | migration `get_my_permissions_v2_*`, permissionPages.ts (canUse), RequirePermission.tsx (buildingId), scripts/check-definer-body-authz.mjs + test, package.json (1 dòng gate) | useMyPermissions.ts phần throw (C) |
| I3 | migration `org_autofill_strict_*`, `chu_cong_ty_system_key_*`, `buildings_insert_v3_*`, publicRoutes.tsx, useAuth.ts (signUp) | — |

Mọi session tạo migration đều đụng `supabase/migration-provenance.json` + `docs/generated/*` khi chạy `provenance:generate` → **KHÔNG commit hai file máy sinh đó trong session con**; tôi regen một lần sau khi gộp.

Thứ tự gộp khi về: **A → C → I2 → D → B → E** (frontend), rồi **F → H1 → H2 → H3 → I1 → I3** (migration, tôi dry-run + apply từng file, backup trước), G độc lập. C và D cùng đụng "hook đọc lỗi" nên D không sửa phần `if (error)` của hook mình sở hữu — để C làm; D chỉ sửa range/enabled.
