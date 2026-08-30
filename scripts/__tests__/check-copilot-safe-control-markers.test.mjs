import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSafeControlMarkers } from '../check-copilot-safe-control-markers.mjs';

test('requires exactly the declared page-qualified safe-control markers', () => {
  const contracts = [
    { key: 'rooms.list', safeControlIds: ['room.search', 'room.status-filter'] },
    { key: 'invoices.list', safeControlIds: ['invoice.month-filter', 'invoice.status-filter', 'invoice.search'] },
    { key: 'customers.list', safeControlIds: ['customer.search'] },
  ];
  const sourceByFile = new Map([
    ['rooms.tsx', '<input data-ai-safe="rooms.list.room.search" /><button data-ai-safe="rooms.list.room.status-filter" />'],
    ['invoices.tsx', '<button data-ai-safe="invoices.list.invoice.month-filter" /><button data-ai-safe="invoices.list.invoice.status-filter" /><input data-ai-safe="invoices.list.invoice.search" />'],
    ['customers.tsx', '<input data-ai-safe="customers.list.customer.search" />'],
  ]);

  assert.deepEqual(validateSafeControlMarkers(contracts, sourceByFile), []);
  assert.match(
    validateSafeControlMarkers(
      [{ key: 'rooms.list', safeControlIds: ['room.search'] }],
      new Map([['rooms.tsx', '<input data-ai-safe="rooms.list.room.search" /><input data-ai-safe="rooms.list.room.search" />']]),
    ).join('\n'),
    /duplicate marker/,
  );
  assert.match(
    validateSafeControlMarkers(
      [{ key: 'rooms.list', safeControlIds: ['room.search'] }],
      new Map([['rooms.tsx', '<input data-ai-safe="rooms.list.room.unknown" />']]),
    ).join('\n'),
    /unknown marker/,
  );
});
