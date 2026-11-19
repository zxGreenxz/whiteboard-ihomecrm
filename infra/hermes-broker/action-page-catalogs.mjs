// Danh mục thao tác ghi mà connector nạp (server.mjs): PRODUCTION_ACTIONS luôn nạp; trang trong ACTION_PAGE_CATALOGS chỉ nạp khi
// cấu hình host bật bằng actionPages (mỗi trang một dòng). Một nguồn cho server.mjs và catalog-names.mjs (hướng dẫn chuẩn
// infra/hermes-skills kiểm mã thao tác theo đúng danh mục này, không chép danh sách tay).
import { EXPENSE_ACTIONS } from './expense-actions-contract.mjs';
import { TASK_ACTIONS } from './task-actions-contract.mjs';
import { INVOICE_ACTIONS } from './invoice-actions-contract.mjs';
import { CONTRACT_ACTIONS } from './contract-action-contract.mjs';
import { LEARNING_ACTIONS } from './learning-action-contract.mjs';

export const PRODUCTION_ACTIONS = Object.freeze([...EXPENSE_ACTIONS, ...TASK_ACTIONS, ...INVOICE_ACTIONS]);
// learning (đợt 3 học có kiểm duyệt): tin tối 21:00 + duyệt qua Zalo; host bật khi migration của trang đã áp.
export const ACTION_PAGE_CATALOGS = Object.freeze({ contract: CONTRACT_ACTIONS, learning: LEARNING_ACTIONS });
