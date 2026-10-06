import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each(['SIGINT', 'SIGTERM'])('%s leaves PGPASS available until asynchronous finally and removes it at actual exit', signal => {
  const moduleUrl = new URL('../test-env/lib.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { existsSync } from 'node:fs';
    import { dangKyMatKhau } from ${JSON.stringify(moduleUrl)};
    dangKyMatKhau([{ host: 'invalid.local', user: 'test', password: 'test-only-not-a-secret' }]);
    console.log('PASSFILE=' + process.env.PGPASSFILE);
    try { process.emit(${JSON.stringify(signal)}); }
    finally {
      await new Promise(resolve => setTimeout(resolve, 20));
      console.log('ASYNC_CLEANUP=' + existsSync(process.env.PGPASSFILE));
    }
  `], { encoding: 'utf8' });
  expect(result.stdout).toContain('ASYNC_CLEANUP=true');
  expect(result.status).toBe(signal === 'SIGINT' ? 130 : 143);
  const passFile = result.stdout.match(/PASSFILE=(.+)/)?.[1]?.trim();
  expect(passFile).toBeTruthy(); expect(existsSync(passFile)).toBe(false);
});
