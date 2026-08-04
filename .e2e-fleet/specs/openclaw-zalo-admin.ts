/**
 * Fixture admin for the OpenClaw E2E, and the guard that stands in front of it.
 *
 * Every other spec in this fleet runs against the production deployment by
 * default (`playwright.config.ts` falls back to https://ptcrm.vercel.app). These
 * scenarios do the opposite of read-only: they drive a fake Zalo adapter, force
 * session kicks, move a deterministic clock, and delete retention subjects. Run
 * against the shared project that would corrupt real tenant data.
 *
 * So the environment is not defaulted, it is DEMANDED. Nothing here inherits a
 * fleet default, and the guard runs before any network access - if it is going to
 * refuse, it refuses before a browser starts rather than halfway through a
 * scenario that has already written rows.
 */

/** The only organization these scenarios may touch. */
export const DEMO_ORG_ID = 'dddd0000-0000-4000-8000-000000000001';

/** The production organization. Named so the guard can refuse it by identity. */
const PRODUCTION_ORG_ID = 'aaaa0000-0000-4000-8000-000000000001';

/** The fleet's production default; reaching it from this spec is a bug, not a choice. */
const PRODUCTION_BASE_URL = 'https://ptcrm.vercel.app';

/** The shared Supabase project. Fixtures must never point at it. */
const PRODUCTION_PROJECT_REF = 'tryymsxyyckgbrmmvozx';

const REQUIRED = {
  FLEET_BASE_URL: 'http://127.0.0.1:4173',
  FLEET_OPENCLAW_FIXTURE_ENV: 'local-preview',
  FLEET_OPENCLAW_PROJECT_REF: 'local',
} as const;

export interface OpenClawFixtureEnv {
  baseUrl: string;
  fixtureEnv: string;
  projectRef: string;
  /** Prefix every fixture row carries, so cleanup can find its own leavings. */
  markerPrefix: string;
}

/**
 * Reads and checks the preproduction inputs.
 *
 * Exact equality, not "contains" or "starts with": a base URL of
 * `http://127.0.0.1:4173.evil.example` contains the expected value, and a project
 * ref of `local-copy-of-production` starts with `local`. Both would pass a lenient
 * check and neither is what was asked for.
 */
export function requireLocalPreviewEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenClawFixtureEnv {
  const problems: string[] = [];

  for (const [name, expected] of Object.entries(REQUIRED)) {
    const actual = env[name];
    if (actual === undefined || actual === '') {
      problems.push(`${name} chưa đặt (phải bằng đúng "${expected}")`);
    } else if (actual !== expected) {
      problems.push(`${name}="${actual}" không đúng (phải bằng đúng "${expected}")`);
    }
  }

  // Checked separately and by identity, so the refusal names the real danger
  // rather than repeating the generic mismatch message above.
  if (env.FLEET_BASE_URL === PRODUCTION_BASE_URL) {
    problems.push(
      `FLEET_BASE_URL đang trỏ vào production (${PRODUCTION_BASE_URL}). ` +
        'Bộ test này điều khiển adapter giả, đá phiên, và xoá dữ liệu lưu trữ — ' +
        'chạy trên production sẽ phá dữ liệu khách hàng thật.',
    );
  }
  if (env.FLEET_OPENCLAW_PROJECT_REF === PRODUCTION_PROJECT_REF) {
    problems.push(
      `FLEET_OPENCLAW_PROJECT_REF đang là project dùng chung (${PRODUCTION_PROJECT_REF}). ` +
        'Fixture chỉ được ghi vào một Supabase local.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      'Môi trường cho E2E OpenClaw chưa đúng, dừng TRƯỚC khi mở trình duyệt:\n' +
        problems.map(problem => `  - ${problem}`).join('\n') +
        '\n\nChạy đúng cách:\n' +
        Object.entries(REQUIRED).map(([name, value]) => `  ${name}=${value}`).join('\n') +
        '\n  (kèm supabase local đang chạy và `npm run preview` ở 127.0.0.1:4173)',
    );
  }

  return {
    baseUrl: REQUIRED.FLEET_BASE_URL,
    fixtureEnv: REQUIRED.FLEET_OPENCLAW_FIXTURE_ENV,
    projectRef: REQUIRED.FLEET_OPENCLAW_PROJECT_REF,
    markerPrefix: 'e2e-openclaw-',
  };
}

/**
 * Refuses any organization that is not DEMO.
 *
 * Called by every fixture mutation rather than once at startup: a scenario that
 * derives an organization id from page state could otherwise carry a production
 * id into a write, and the startup check would have passed long before.
 */
export function assertDemoOrganization(organizationId: string): string {
  if (organizationId === PRODUCTION_ORG_ID) {
    throw new Error(
      `Fixture từ chối tổ chức production ${PRODUCTION_ORG_ID}. Chỉ được ghi vào DEMO.`,
    );
  }
  if (organizationId !== DEMO_ORG_ID) {
    throw new Error(
      `Fixture chỉ được ghi vào tổ chức DEMO ${DEMO_ORG_ID}, nhận được ${organizationId}.`,
    );
  }
  return organizationId;
}

/**
 * A marker that ties every fixture row to the test that made it.
 *
 * Cleanup deletes by prefix, so a scenario that dies mid-way still leaves rows a
 * later run can identify and remove rather than rows nobody can tell apart from
 * real ones.
 */
export function fixtureMarker(env: OpenClawFixtureEnv, scenario: string): string {
  return `${env.markerPrefix}${scenario}`;
}
