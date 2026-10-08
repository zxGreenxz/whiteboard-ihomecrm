---
status: current
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
| RPC được gọi từ mã nguồn | 367 |
| Hàm trong catalog (public + api) | 1261 |
| File mã nguồn đã quét | 2488 |
| SECURITY DEFINER | 350 |
| **Gọi mà server KHÔNG CÓ** | **2** |

## Theo mức rủi ro

| Mức | Số RPC | Nghĩa là |
|---|---|---|
| thường | 265 | còn lại |
| tiền | 102 | có nơi gọi nằm trong màn tiền — sai là sai sổ sách |

## 102 RPC chạm TIỀN

Đây là danh sách đáng đọc nhất trong trang này: mỗi dòng là một đường ghi hoặc
đọc có thể làm lệch số trên sổ.

| RPC | DEFINER | Nơi gọi |
|---|---|---|
| `adjust_invoice_v2` | ✔ | lib/invoiceAdjustmentRpc.ts |
| `annotate_income_expense_v1` | ✔ | hooks/income-expenses/annotateMutations.ts |
| `append_income_expense_supplement_v1` | ✔ | hooks/income-expenses/supplements.ts |
| `approve_invoice_v1` | ✔ | hooks/useInvoices.ts |
| `approve_pending_income_expense_checked_v1` | ✔ | hooks/income-expenses/revisions.ts |
| `assign_commission_manager_v1` | ✔ | hooks/useCommissionManager.ts |
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
| `change_collection_tender_method_v1` | ✔ | hooks/useReceivingCashbooks.ts |
| `commission_manager_options_v1` | ✔ | hooks/useCommissionManager.ts |
| `confirm_cashbook_closing_v1` | ✔ | hooks/useCashbookClosing.ts |
| `create_income_expense_v1` | ✔ | hooks/income-expenses/mutations.ts |
| `create_invoice_refund_obligation_v2` | ✔ | hooks/useInvoicePayments.ts |
| `decide_owned_income_expense_v2` | ✔ | hooks/income-expenses/statusMutations.ts |
| `distribute_shareholder_profit_v1` | ✔ | hooks/income-expenses/specialized.ts |
| `execute_commission_request_v1` | ✔ | lib/contractCommissionFollowup.ts |
| `generate_recurring_vouchers_v2` | ✔ | hooks/income-expenses/recurring.ts |
| `get_commission_voucher_facts_v1` | ✔ | hooks/useCommissionVoucher.ts |
| `get_customer_credit_balance_v1` | ✔ | hooks/useInvoices.ts |
| `get_deposits_report_summary` |  | hooks/reports/financeReports.ts |
| `get_income_expense_history` |  | hooks/income-expenses/queries.ts |
| `get_income_expense_layer_stats` |  | hooks/income-expenses/queries.ts, hooks/useProfitVerification.ts |
| `get_invoice_statistics_v2` | ✔ | hooks/useInvoices.ts, hooks/useProfitVerification.ts, hooks/useUtilityBills.ts |
| `get_my_permissions` | ✔ | hooks/personal-finance/usePersonalFinancePermissions.ts, hooks/useMyPermissions.ts |
| `get_overpayment_summary` |  | hooks/reports/financeReports.ts |
| `get_receiving_cashbooks_v1` | ✔ | hooks/useReceivingCashbooks.ts |
| `get_salary_v5_config` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts, hooks/useSalaryV5Config.ts |
| `get_voucher_cancellation_v1` | ✔ | hooks/income-expenses/flexMutations.ts |
| `get_voucher_change_log_v1` | ✔ | hooks/income-expenses/flexMutations.ts |
| `get_voucher_slot_warning_v1` | ✔ | hooks/useVoucherSlotWarning.ts |
| `ie_compat_update_pending_v2` | ✔ | hooks/useUploadPaymentReceipt.ts |
| `ie_stop_recurring_v1` | ✔ | hooks/income-expenses/recurring.ts |
| `invoice_active_payment_methods` |  | hooks/useInvoices.ts |
| `invoice_payment_method_drilldown` |  | hooks/useInvoices.ts |
| `is_admin` | ✔ | hooks/useIsAdmin.ts, supabase/functions/salary-v5-jobs/index.ts |
| `list_cashbook_closings_v1` | ✔ | hooks/useCashbookClosing.ts |
| `list_contract_commission_followups_v2` | ✔ | lib/contractCommissionFollowup.ts |
| `list_receiving_cashbook_settings_v1` | ✔ | hooks/useReceivingCashbooks.ts |
| `lock_salary_month_v2` | ✔ | hooks/useManagerSalary.ts |
| `log_income_expense_action` | ✔ | hooks/income-expenses/statusMutations.ts |
| `manager_salary_payout_v1` | ✔ | hooks/income-expenses/specialized.ts |
| `mark_overdue_invoices_v1` | ✔ | hooks/useInvoices.ts |
| `notify_claim_push_batch_v1` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `notify_settle_push_batch_v1` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `personal_finance_bootstrap` | ✔ | hooks/personal-finance/usePersonalFinance.ts |
| `personal_finance_mutate` | ✔ | hooks/personal-finance/usePersonalFinance.ts |
| `personal_finance_snapshot` |  | hooks/personal-finance/usePersonalFinance.ts |
| `prepare_commission_requests_v1` | ✔ | lib/contractCommissionFollowup.ts |
| `propose_cashbook_closing_v1` | ✔ | hooks/useCashbookClosing.ts |
| `quote_contract_rent_support_v1` | ✔ | lib/invoiceRentSupport.ts, lib/rentSupportApi.ts |
| `read_rent_support_salary_parts_v1` | ✔ | lib/rentSupportSalary.ts |
| `record_contract_commission_event_v1` | ✔ | lib/contractCommissionFollowup.ts |
| `record_payment_gps` | ✔ | lib/v5PaymentGps.ts |
| `rent_support_salary_bridge_required_v1` | ✔ | lib/rentSupportSalary.ts |
| `restore_income_expense` | ✔ | hooks/income-expenses/statusMutations.ts |
| `reverse_posted_income_expense_v2` | ✔ | hooks/income-expenses/statusMutations.ts |
| `review_invoice_adjustment_v2` | ✔ | lib/invoiceAdjustmentRpc.ts |
| `revise_pending_income_expense_v1` | ✔ | hooks/income-expenses/revisions.ts |
| `salary_can_edit_amounts_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_commission_meta_v1` | ✔ | hooks/useManagerSalary.ts |
| `salary_line_override_list_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_line_override_set_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_payout_v1` | ✔ | hooks/useManagerSalary.ts |
| `salary_recurring_create_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_recurring_delete_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_recurring_list_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_recurring_version_add_v1` | ✔ | hooks/useSalaryExtras.ts |
| `salary_staff_months` | ✔ | hooks/useManagerSalary.ts |
| `salary_work_ledger` | ✔ | hooks/useManagerSalary.ts |
| `set_building_receiving_cashbooks_v1` | ✔ | hooks/useReceivingCashbooks.ts |
| `set_forfeit_voucher_kqkd_v1` | ✔ | hooks/income-expenses/forfeitKqkd.ts |
| `set_personal_cash_book_v1` | ✔ | hooks/useReceivingCashbooks.ts |
| `set_salary_v5_config` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `unapprove_invoice_v1` | ✔ | hooks/useInvoices.ts |
| `unapprove_voucher` | ✔ | hooks/income-expenses/statusMutations.ts |
| `unlock_salary_month_v2` | ✔ | hooks/useManagerSalary.ts |
| `update_invoice_v1` | ✔ | hooks/useInvoices.ts |
| `v5_apply_lock_adjustments` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `v5_cron_finish` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_cron_start` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_lock_assert` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `v5_month_money_bulk` | ✔ | hooks/useManagerSalary.ts |
| `v5_run_digest` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_run_job` | ✔ | supabase/functions/salary-v5-jobs/index.ts |
| `v5_shadow_report` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `v5_verdict` | ✔ | hooks/salary-v5/useSalaryV5Admin.ts |
| `verify_income_expense` | ✔ | hooks/income-expenses/statusMutations.ts |
| `verify_income_expense_v1` | ✔ | hooks/income-expenses/statusMutations.ts |

## 0 RPC mức an ninh

| RPC | Nơi gọi |
|---|---|
