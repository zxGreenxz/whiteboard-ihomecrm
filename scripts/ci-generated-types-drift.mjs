#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Generation writes this file; restore it even when the generator or comparison fails.
const path = 'src/integrations/supabase/types.ts';
const original = readFileSync(path);
try {
  execFileSync(process.execPath, ['scripts/gen-supabase-types.mjs'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/normalize-supabase-types.mjs', '--write'], { stdio: 'inherit' });
  if (!original.equals(readFileSync(path))) throw new Error('Generated types differ from committed normalized types');
  console.log('Generated types match the committed normalized types.');
} finally { writeFileSync(path, original); }
