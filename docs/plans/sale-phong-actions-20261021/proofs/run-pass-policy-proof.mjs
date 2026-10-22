import { startVitest } from 'vitest/node';

const proof = 'docs/plans/sale-phong-actions-20261021/proofs/pass-policy.proof.mjs';
let context;
try {
  context = await startVitest('test', [], {
    include: [proof],
    run: true,
    watch: false,
    maxWorkers: 1,
    reporters: ['default', 'json'],
    outputFile: { json: 'docs/plans/sale-phong-actions-20261021/proofs/pass-policy-vitest-result.json' },
  });
  if (!context) throw new Error('Vitest did not create the proof context');
  const collected = context.state.getFiles();
  if (collected.length !== 1 || !collected[0].filepath.replaceAll('\\', '/').endsWith(proof))
    throw new Error('Audit proof collection differs from the one requested file');
} finally {
  await context?.close();
}
