---
status: current
reviewed: 2026-08-22
source_paths:
  - contracts/surfaces/rpc-surface.json
copilot_ingest: false
risk: normal
---

> **SINH TỰ ĐỘNG — đừng sửa tay.** `node scripts/generate-docs-views.mjs`
> Sửa ở đây tạo nguồn sự thật thứ hai, và nó sẽ trôi khỏi manifest trong vài ngày.

# Bề mặt RPC — TypeScript gọi gì trên PostgreSQL

Biên này là **một chuỗi ký tự**: `supabase.rpc('ten_ham')`. Không trình biên dịch
nào chứng minh tên đó tồn tại trên server — types.ts chỉ che phần `src/` mà tsc soi,
còn Edge Function (Deno), `services/` và `infra/` nằm ngoài hoàn toàn.

| Chỉ số | Giá trị |
|---|---|
| RPC được gọi từ mã nguồn | 254 |
| Hàm trong catalog (public + api) | 1087 |
| File mã nguồn đã quét | 1682 |
| SECURITY DEFINER | 238 |
| **Gọi mà server KHÔNG CÓ** | **0** |

## Theo mức rủi ro

| Mức | Số RPC | Nghĩa là |
|---|---|---|
| thường | 174 | còn lại |
| tiền | 74 | có nơi gọi nằm trong màn tiền — sai là sai sổ sách |
| an ninh | 6 | nơi gọi thuộc OpenClaw |

## 74 RPC chạm TIỀN

Đây là danh sách đáng đọc nhất trong trang này: mỗi dòng là một đường ghi hoặc
đọc có thể làm lệch số trên sổ.

| RPC | DEFINER | Nơi gọi |
|---|---|---|
| `annotate_income_expense_v1` | ✔ | hooks/income-expenses/annotateMutations.ts |
| `approve_income_expense_v1` | ✔ | hooks/income-expenses/statusMutations.ts |
| `approve_invoice_v1` | ✔ | hooks/useInvoices.ts |
| `approve_voucher` | ✔ | hooks/income-expenses/statusMutations.ts |
| `award_job_bonus` | ✔ | lib/salaryBonusNotify.ts |
| `bulk_approve_invoices_v1` | ✔ | hooks/useInvoices.ts |
| `can_cancel_income_voucher_v1` | ✔ | hooks/income-expenses/incomeVoucherCancel.ts |
| `can_flex_cancel_v1` | ✔ | hooks/income-expenses/flexMutations.ts |
| `can_reverse_collection_v1` | ✔ | hooks/useDeletePayment.ts |
| `cancel_cashbook_closing_v1` | ✔ | hooks/useCashbookClosing.ts |
| `cancel_income_expense_flex_v1` | ✔ | hooks/income-expenses/flexMutations.ts, hooks/income-expenses/statusMutations.ts |
| `cancel_income_expense_v1` | ✔ | hooks/income-expenses/statusMutations.ts |
| `cancel_income_voucher_v1` | ✔ | hooks/income-expenses/incomeVoucherCancel.ts |
| `cashbook_balance_as_of_v1` | ✔ | hooks/useCashbookClosing.ts |
| `cashbook_close_confirmers_v1` | ✔ | hooks/useCashbookClosing.ts |
| `cashbook_closing_blockers_v1` | ✔ | hooks/useCashbookClosing.ts |
| `cashbook_closing_monthly_status_v1` | ✔ | hooks/useCashbookClosing.ts |
| `cashbook_opening_balance` | ✔ | hooks/useCashBook.ts |
| `cashbook_period_totals` | ✔ | hooks/useCashBook.ts |
| `cashflow_by_day` | ✔ | hooks/useCashBook.ts |
| `confirm_cashbook_closing_v1` | ✔ | hooks/useCashbookClosing.ts |
| `create_commission_voucher` | ✔ | hooks/useCommissionVoucher.ts |
| `create_income_expense_v1` | ✔ | hooks/income-expenses/mutations.ts |
| `create_invoice_refund_obligation_v2` | ✔ | hooks/useInvoicePayments.ts |
| `decide_owned_income_expense_v2` | ✔ | hooks/income-expenses/statusMutations.ts |
| `distribute_shareholder_profit_v1` | ✔ | hooks/income-expenses/specialized.ts |
| `generate_recurring_vouchers_v2` | ✔ | hooks/income-expenses/recurring.ts |
| `get_customer_credit_balance_v1` | ✔ | hooks/useInvoices.ts |
| `get_deposits_report_summary` |  | hooks/reports/financeReports.ts |
| `get_income_expense_history` |  | hooks/income-expenses/queries.ts |
| `get_income_expense_layer_stats` |  | hooks/income-expenses/queries.ts, hooks/useProfitVerification.ts |
| `get_invoice_statistics_v2` | ✔ | copilot/tools/nghiepVuTools.ts, hooks/useInvoices.ts, hooks/useProfitVerification.ts … (+1) |
| `get_overpayment_summary` |  | hooks/reports/financeReports.ts |
| `get_salary_v5_config` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts, hooks/useSalaryV5Config.ts |
| `get_voucher_cancellation_v1` | ✔ | hooks/income-expenses/flexMutations.ts |
| `get_voucher_change_log_v1` | ✔ | hooks/income-expenses/flexMutations.ts |
| `get_voucher_slot_warning_v1` | ✔ | hooks/useVoucherSlotWarning.ts |
| `ie_compat_update_pending_v2` | ✔ | hooks/useUpdatePaymentMethod.ts, hooks/useUploadPaymentReceipt.ts |
| `invoice_active_payment_methods` |  | hooks/useInvoices.ts |
| `invoice_payment_method_drilldown` |  | hooks/useInvoices.ts |
| `is_admin` | ✔ | hooks/useIsAdmin.ts, supabase/functions/salary-v5-jobs/index.ts |
| `list_cashbook_closings_v1` | ✔ | hooks/useCashbookClosing.ts |
| `list_my_cashbook_access_v2` | ✔ | hooks/income-expenses/incomeVoucherCashbook.ts |
| `lock_salary_month_v1` | ✔ | hooks/useManagerSalary.ts |
| `log_income_expense_action` | ✔ | hooks/income-expenses/statusMutations.ts |
| `manager_salary_payout_v1` | ✔ | hooks/income-expenses/specialized.ts |
| `mark_overdue_invoices_v1` | ✔ | hooks/useInvoices.ts |
| `move_income_voucher_cashbook_v1` | ✔ | hooks/income-expenses/incomeVoucherCashbook.ts |
| `notify_claim_push_batch_v1` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `notify_settle_push_batch_v1` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `propose_cashbook_closing_v1` | ✔ | hooks/useCashbookClosing.ts |
| `record_payment_gps` | ✔ | lib/v5PaymentGps.ts |
| `restore_income_expense` | ✔ | hooks/income-expenses/statusMutations.ts |
| `reverse_posted_income_expense_v2` | ✔ | hooks/income-expenses/statusMutations.ts |
| `salary_payout_v1` | ✔ | hooks/useManagerSalary.ts |
| `salary_staff_months` | ✔ | hooks/useManagerSalary.ts |
| `salary_work_ledger` | ✔ | hooks/useManagerSalary.ts |
| `set_salary_v5_config` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `unapprove_invoice_v1` | ✔ | hooks/useInvoices.ts |
| `unapprove_voucher` | ✔ | hooks/income-expenses/statusMutations.ts |
| `unlock_salary_month_v1` | ✔ | hooks/useManagerSalary.ts |
| `update_income_expense_quick` | ✔ | hooks/income-expenses/mutations.ts |
| `update_invoice_v1` | ✔ | hooks/useInvoices.ts |
| `v5_apply_lock_adjustments` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `v5_cron_finish` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_cron_start` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_lock_assert` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `v5_month_money` | ✔ | hooks/useManagerSalary.ts |
| `v5_run_digest` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_run_job` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_shadow_report` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `v5_verdict` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `verify_income_expense` | ✔ | hooks/income-expenses/statusMutations.ts |
| `verify_income_expense_v1` | ✔ | hooks/income-expenses/statusMutations.ts |

## 6 RPC thuộc OpenClaw

| RPC | Nơi gọi |
|---|---|
| `get_authorization_context_v1` | src/components/openclaw-zalo/OpenClawRouteGuard.tsx, src/hooks/openclaw-zalo/useOpenClawPermissions.ts |
| `openclaw_get_bootstrap_v1` | src/hooks/openclaw-zalo/useOpenClawBootstrap.ts |
| `openclaw_get_overview_v1` | src/hooks/openclaw-zalo/useOpenClawOverview.ts |
| `openclaw_list_conversations_v1` | src/hooks/openclaw-zalo/useOpenClawInbox.ts |
| `openclaw_list_messages_v1` | src/hooks/openclaw-zalo/useOpenClawInbox.ts |
| `openclaw_list_my_organizations_v1` | src/hooks/openclaw-zalo/useOpenClawOrganization.ts |
