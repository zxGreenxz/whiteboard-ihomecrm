import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Sự thật về CẤU TRÚC của migration bật chế độ nháp Copilot (bảng ngữ cảnh, bảng capability, cờ bật
// sau khi thay writer, phát lại được) — các bảng này chưa migration nào định nghĩa lại, nên đọc chính
// file đó là đo đúng. Hành vi của hàm writer dùng chung (định nghĩa sống, đã forward-fix nhiều lần)
// được đo ở copilotDraftWriterMigration.test.ts.
const migrationPath =
  'supabase/migrations/20260830183259_copilot_draft_writer_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

describe('Copilot draft writer migration — cấu trúc', () => {
  it('ghi rõ ngữ cảnh writer riêng tư (không dựa vào GUC client đặt)', () => {
    expect(migration).toMatch(/copilot_writer_context/i);
  });

  it('enables the private capability only after replacing the shared writer', () => {
    expect(migration).toMatch(
      /UPDATE app_private\.copilot_ie_writer_capabilities_v1[\s\S]{0,500}enabled\s*=\s*true/i,
    );
    expect(migration).toMatch(/writer_version\s*=\s*'draft-v1'/i);
  });

  it('can replay the writer migration without relying on the preceding migration transaction', () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_ie_writer_context_v1/i,
    );
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_ie_writer_capabilities_v1/i,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION app_private\.copilot_ie_writer_ready_v1/i,
    );
  });
});
