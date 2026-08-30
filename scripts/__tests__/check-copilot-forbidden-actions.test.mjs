import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORBIDDEN_COPILOT_ACTIONS,
  inventoryFromCopilotSource,
  validateCopilotActionInventory,
} from '../check-copilot-forbidden-actions.mjs';

const SAFE_TOOLS = [
  {
    name: 'tao_phieu_thu_chi_nhap',
    description: 'Create one UNAPPROVED finance draft after an explicit human confirmation.',
    executionKind: 'draft',
  },
  {
    name: 'huong_dan',
    description: 'Explain the normal human workflow for approvals, posting, permissions, and deployment.',
    executionKind: 'guidance',
  },
];

test('draft and guidance actions are allowed when no forbidden executor is exposed', () => {
  assert.deepEqual(validateCopilotActionInventory(SAFE_TOOLS), []);
});

test('every L5/L6 boundary fails validation when exposed as an executable tool', () => {
  for (const action of FORBIDDEN_COPILOT_ACTIONS) {
    const problems = validateCopilotActionInventory([
      ...SAFE_TOOLS,
      {
        name: `copilot_${action}_v1`,
        description: `Execute ${action} immediately`,
        executionKind: action,
      },
    ]);
    assert.equal(problems.length, 1, `${action} must be rejected`);
    assert.match(problems[0], new RegExp(action));
  }
});

test('unknown executable action kinds fail closed instead of silently becoming safe', () => {
  const problems = validateCopilotActionInventory([
    { name: 'mystery_executor', description: 'Do something privileged', executionKind: 'mystery' },
  ]);
  assert.deepEqual(problems, ['mystery_executor: unknown execution kind "mystery"']);
});

test('duplicate tool names fail validation so a safe declaration cannot hide a forbidden executor', () => {
  const problems = validateCopilotActionInventory([
    SAFE_TOOLS[0],
    { ...SAFE_TOOLS[0], executionKind: 'approval' },
  ]);
  assert.match(problems.join('\n'), /duplicate tool name/);
  assert.match(problems.join('\n'), /approval/);
});

test('source inventory classifies approval/posting executors instead of trusting descriptions', () => {
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts': `
      dt({ name: 'dangerous', description: 'Looks safe', execute: async () => approve_income_expense_v1() });
      dt({ name: 'safe_draft', execute: async () => copilot_preview_income_expense_v1({ nonce: true }) });
    `,
  });
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.executionKind]),
    [
      ['dangerous', 'approval'],
      ['safe_draft', 'draft'],
    ],
  );
  assert.match(validateCopilotActionInventory(tools).join('\n'), /forbidden executable action "approval"/);
});

test('source inventory catches destructive, permission, SQL, secret, and deploy identifiers', () => {
  const tools = inventoryFromCopilotSource({
    'src/copilot/tools/registry.ts': `
      dt({ name: 'remove_row', execute: async () => supabase.from('x').delete() });
      dt({ name: 'grant_role', execute: async () => grant_user_permissions('admin') });
      dt({ name: 'sql_runner', execute: async () => execute_sql('select 1') });
      dt({ name: 'secret_writer', execute: async () => saveApiKey('secret') });
      dt({ name: 'deployer', execute: async () => deploy_release('prod') });
    `,
  });
  assert.deepEqual(
    tools.map((tool) => tool.executionKind),
    ['delete', 'permission', 'sql', 'secret', 'deploy'],
  );
  assert.equal(validateCopilotActionInventory(tools).length, 5);
});
