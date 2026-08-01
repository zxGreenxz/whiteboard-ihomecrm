/**
 * Maintenance service entry point. It wires the runners; all policy lives in the
 * modules so it stays unit-testable without a live runtime.
 */

export { authorizeMaintenance, MAINTENANCE_WORK_KINDS } from "./runtime-client.js";
export { planRetentionWork, validateRetentionReceipt } from "./retention-runner.js";
export {
  AnchorReceiptStore,
  computeAnchorRoot,
  verifyAnchorReceipt,
} from "./audit-anchor-runner.js";
export { evaluateMaintenanceReadiness } from "./health.js";