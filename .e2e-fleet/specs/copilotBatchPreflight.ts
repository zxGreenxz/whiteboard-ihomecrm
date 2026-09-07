export interface BatchPolicySnapshot {
  maxDirectRisk: string;
  allowedRoles: string[];
}

export interface BatchPreviewProbe {
  status: number;
  detail?: string;
}

export function danhGiaTienDeBatch(
  policy: BatchPolicySnapshot,
  preview: BatchPreviewProbe,
): { dat: boolean; lyDo: string } {
  if (policy.maxDirectRisk !== 'L4' && policy.maxDirectRisk !== 'L5') {
    return {
      dat: false,
      lyDo: `trần rủi ro "${policy.maxDirectRisk}" không thuộc tập được hỗ trợ [L4, L5]`,
    };
  }
  if (!policy.allowedRoles.includes('superadmin')) {
    return {
      dat: false,
      lyDo: `actor sysadmin mang policy role superadmin nhưng không được cho phép; ` +
        `allowed_roles=[${policy.allowedRoles.join(', ')}]`,
    };
  }
  if (preview.status !== 200) {
    return {
      dat: false,
      lyDo: `actor sysadmin không qua được preview income_expenses.create trên DEMO ` +
        `(HTTP ${preview.status}): ${preview.detail ?? 'không có chi tiết'}`,
    };
  }
  return { dat: true, lyDo: '' };
}
