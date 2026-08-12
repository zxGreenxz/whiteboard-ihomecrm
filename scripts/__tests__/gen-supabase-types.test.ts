import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const temporaryDirectories: string[] = [];

type WrapperModule = typeof import('../gen-supabase-types.mjs');

async function loadWrapper(): Promise<WrapperModule> {
  return import('../gen-supabase-types.mjs');
}

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'gen-supabase-types-'));
  temporaryDirectories.push(directory);
  return directory;
}

const REQUIRED_OPENCLAW_TABLE_NAMES = [
  'openclaw_conversations',
  'openclaw_outbox',
  'openclaw_retention_policies',
  'openclaw_runtime_cells',
];
const REQUIRED_OPENCLAW_FUNCTION_NAMES = [
  'openclaw_create_send_intent_v1',
  'openclaw_get_bootstrap_v1',
  'openclaw_service_acquire_cell_lease_v1',
];

function makeOptionalFields(fields: string) {
  return fields.replace(/^(\s+[A-Za-z_][A-Za-z0-9_]*):/gm, '$1?:');
}

function buildTableBlock(name: string, fields = '          id: string') {
  return `      ${name}: {
        Row: {
${fields}
        }
        Insert: {
${makeOptionalFields(fields)}
        }
        Update: {
${makeOptionalFields(fields)}
        }
        Relationships: []
      }`;
}

function buildRequiredOpenClawTables(accountsTable?: string) {
  const accounts = accountsTable ?? buildTableBlock(
    'openclaw_accounts',
    `          connection_generation: number
          id: string
          organization_id: string
          session_generation: number`,
  );
  return [
    accounts,
    ...REQUIRED_OPENCLAW_TABLE_NAMES.map((name) => buildTableBlock(name)),
  ].join('\n');
}

function buildRequiredOpenClawFunctions() {
  return REQUIRED_OPENCLAW_FUNCTION_NAMES.map(
    (name) => `      ${name}: { Args: never; Returns: Json }`,
  ).join('\n');
}

function buildOpenClawMergeFixture({
  leadActivityFields = `          openclaw_schedule_revision: number
          openclaw_schedule_timezone: string
          openclaw_scheduled_at_utc: string | null`,
  additionalTables = '',
  functions = '',
  includeRequiredSurface = true,
  accountsTable,
}: {
  leadActivityFields?: string;
  additionalTables?: string;
  functions?: string;
  includeRequiredSurface?: boolean;
  accountsTable?: string;
} = {}) {
  const requiredTables = includeRequiredSurface
    ? `${buildRequiredOpenClawTables(accountsTable)}
${buildTableBlock('leads', '          openclaw_assignment_revision: number')}
${buildTableBlock('rooms', '          openclaw_availability_revision: number')}`
    : '';
  const requiredFunctions = includeRequiredSurface
    ? buildRequiredOpenClawFunctions()
    : '';
  return `export type Json = string
export type Database = {
  public: {
    Tables: {
      lead_activities: {
        Row: {
          "legacy-lead-field": string
          legacy_column: string
${leadActivityFields}
        }
        Insert: {
          "legacy-lead-field": string
          legacy_column: string
${makeOptionalFields(leadActivityFields)}
        }
        Update: {
          "legacy-lead-field"?: string
          legacy_column?: string
${makeOptionalFields(leadActivityFields)}
        }
        Relationships: []
      }
${requiredTables}
${additionalTables}
    }
    Views: {
      legacy_view: {
        Row: {
          id: string
        }
        Relationships: []
      }
    }
    Functions: {
${requiredFunctions}
${functions}
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
`;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('gen-supabase-types wrapper', () => {
  test('reads the project ref and PAT from repository configuration', async () => {
    const { extractSupabaseAccessToken, resolveProjectRef } = await loadWrapper();
    const fakePat = 'sbp_test_PAT-1234567890';

    expect(
      resolveProjectRef({
        configToml: 'project_id = "tryymsxyyckgbrmmvozx"\n',
        linkedProjectRef: '',
        packageJson: '{}',
      }),
    ).toBe('tryymsxyyckgbrmmvozx');
    expect(extractSupabaseAccessToken({ environment: {}, localConfig: `PAT: ${fakePat}` })).toBe(
      fakePat,
    );
  });

  test('normalizes generated output and restores the exact repository header', async () => {
    const { GENERATED_TYPES_HEADER, buildGeneratedTypesFile } = await loadWrapper();
    const generated = '\uFEFFexport type Json = string\r\n\r\nexport type Database = {}\r\n';

    expect(buildGeneratedTypesFile(generated)).toBe(
      `${GENERATED_TYPES_HEADER}\nexport type Json = string\n\nexport type Database = {}\n`,
    );
    expect(() => buildGeneratedTypesFile('Supabase CLI warning only\n')).toThrow(
      /valid TypeScript database types/i,
    );
  });

  test('builds a pinned, shell-free CLI invocation on Windows and POSIX', async () => {
    const { SUPABASE_CLI_VERSION, buildSupabaseCliInvocation } = await loadWrapper();
    const generatorArgs = [
      'gen',
      'types',
      'typescript',
      '--project-id',
      'tryymsxyyckgbrmmvozx',
      '--schema',
      'public',
    ];
    const posixArgs = [
      '--yes',
      `supabase@${SUPABASE_CLI_VERSION}`,
      ...generatorArgs,
    ];

    expect(SUPABASE_CLI_VERSION).toBe('2.109.1');
    expect(
      buildSupabaseCliInvocation('tryymsxyyckgbrmmvozx', 'win32', {
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      }),
    ).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'exec',
        '--yes',
        '--package',
        `supabase@${SUPABASE_CLI_VERSION}`,
        '--',
        'supabase',
        ...generatorArgs,
      ],
      shell: false,
    });
    expect(buildSupabaseCliInvocation('tryymsxyyckgbrmmvozx', 'linux')).toEqual({
      command: 'npx',
      args: posixArgs,
      shell: false,
    });
  });

  test('builds a pinned, shell-free postgres-meta PGlite invocation', async () => {
    const {
      PGLITE_SOCKET_VERSION,
      POSTGRES_META_VERSION,
      buildOpenClawPgliteTypegenInvocation,
    } = await loadWrapper();
    const invocation = buildOpenClawPgliteTypegenInvocation(
      'C:\\repo',
      'win32',
      {
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      },
    );
    expect(invocation.shell).toBe(false);
    expect(invocation.command).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(invocation.args).toContain(`@supabase/postgres-meta@${POSTGRES_META_VERSION}`);
    expect(invocation.args).toContain(`@electric-sql/pglite-socket@${PGLITE_SOCKET_VERSION}`);
    expect(invocation.args).toContain('@electric-sql/pglite@0.5.4');
    expect(invocation.args[invocation.args.length - 2]).toBe('node');
    // Dựng kỳ vọng bằng `join` thay vì ghim cứng dấu `\`.
    //
    // Tham số 'win32' ở trên chỉ quyết định HÌNH DẠNG LỆNH (gọi npm-cli.js qua
    // node thay vì npx), còn đường dẫn thì hàm ghép bằng `join` của node — tức
    // theo nền đang chạy, không theo tham số. Trong dùng thật hai thứ luôn trùng
    // nhau vì platform mặc định là `process.platform`, nên đây không phải lỗi
    // của hàm; chỉ kịch bản chéo-nền do chính test dựng ra mới tách chúng.
    //
    // Ghim `\` làm test xanh trên Windows và ĐỎ trên Linux — đúng như CI vừa
    // gặp: `C:\repo/scripts/...` khác `C:\repo\scripts\...`. Test chỉ có ý
    // khẳng định "đối số cuối là script sinh type pglite", nên nói đúng chừng đó.
    expect(invocation.args[invocation.args.length - 1]).toBe(
      join('C:\\repo', 'scripts', 'generate-openclaw-pglite-types.mjs'),
    );
  });

  test('builds local types without resolving or exposing a project ref or PAT', async () => {
    const { GENERATED_TYPES_HEADER, SUPABASE_CLI_VERSION, generateSupabaseTypes } =
      await loadWrapper();
    const repoRoot = await makeTemporaryDirectory();
    const targetDirectory = join(repoRoot, 'src', 'integrations', 'supabase');
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(repoRoot, 'package.json'), '{"name":"local-types"}\n', 'utf8');

    await generateSupabaseTypes({
      repoRoot,
      environment: {
        PATH: process.env.PATH,
        SUPABASE_TYPES_SOURCE: 'local',
        SUPABASE_PAT: 'sbp_must_not_reach_child-1234567890',
        OPENAI_API_KEY: 'model-key-must-not-reach-child',
        UNRELATED_SECRET: 'unrelated-secret-must-not-reach-child',
      },
      platform: 'linux',
      runCli: async ({ command, args, env, shell }) => {
        expect(command).toBe('npx');
        expect(args).toEqual([
          '--yes',
          `supabase@${SUPABASE_CLI_VERSION}`,
          'gen',
          'types',
          'typescript',
          '--local',
          '--schema',
          'public',
        ]);
        expect(shell).toBe(false);
        expect(env.SUPABASE_TYPES_SOURCE).toBe('local');
        expect(env.SUPABASE_PAT).toBeUndefined();
        expect(env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.UNRELATED_SECRET).toBeUndefined();
        expect(args.join(' ')).not.toContain('project-id');
        return {
          exitCode: 0,
          stdout: 'export type Json = string\nexport type Database = {}\n',
          stderr: '',
        };
      },
    });

    expect(await readFile(join(targetDirectory, 'types.ts'), 'utf8')).toBe(
      `${GENERATED_TYPES_HEADER}\nexport type Json = string\nexport type Database = {}\n`,
    );
  });

  test('merges PGlite OpenClaw types without replacing the existing schema', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const baseline = buildOpenClawMergeFixture({
      additionalTables: `      "legacy-table": {
        Row: {
          "legacy-field": string
        }
        Insert: {
          "legacy-field": string
        }
        Update: {
          "legacy-field"?: string
        }
        Relationships: []
      }`,
    });
    const generated = buildOpenClawMergeFixture({
      functions: `      openclaw_status_v1: {
        Args: never
        Returns: Json
      }`,
    });

    const merged = mergeOpenClawGeneratedTypes(baseline, generated);
    expect(merged).toContain('legacy_column: string');
    expect(merged).toContain('"legacy-table": {');
    expect(merged).toContain('"legacy-lead-field": string');
    expect(merged).toContain('openclaw_schedule_revision: number');
    expect(merged).toContain('openclaw_accounts: {');
    expect(merged).toContain('openclaw_status_v1: {');
    expect(merged).toContain('legacy_view: {');
    expect(merged).toContain('[_ in never]: never');
  });

  test('removes an OpenClaw table that is absent from the current PGlite output', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const staleTable = `      openclaw_retired_jobs: {
        Row: {
          id: string
        }
        Insert: {
          id?: string
        }
        Update: {
          id?: string
        }
        Relationships: []
      }`;
    const baseline = buildOpenClawMergeFixture({
      additionalTables: staleTable,
    });
    const generated = buildOpenClawMergeFixture();

    const merged = mergeOpenClawGeneratedTypes(baseline, generated);

    expect(merged).not.toContain('openclaw_retired_jobs: {');
    expect(merged).toContain('openclaw_accounts: {');
    expect(merged).toContain('legacy_view: {');
  });

  test('removes an OpenClaw function that is absent from the current PGlite output', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const currentFunction = `      openclaw_status_v1: {
        Args: never
        Returns: Json
      }`;
    const staleFunction = currentFunction.replace('openclaw_status_v1', 'openclaw_retired_v1');
    const baseline = buildOpenClawMergeFixture({
      functions: `${staleFunction}\n${currentFunction}`,
    });
    const generated = buildOpenClawMergeFixture({
      functions: currentFunction,
    });

    const merged = mergeOpenClawGeneratedTypes(baseline, generated);

    expect(merged).not.toContain('openclaw_retired_v1: {');
    expect(merged).toContain('openclaw_status_v1: {');
  });

  test('removes an OpenClaw column that is absent from the current PGlite output', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const currentSharedTable = `      customer_records: {
        Row: {
          id: string
          openclaw_current_revision: number
        }
        Insert: {
          id?: string
          openclaw_current_revision?: number
        }
        Update: {
          id?: string
          openclaw_current_revision?: number
        }
        Relationships: []
      }`;
    const staleSharedTable = currentSharedTable
      .replace(
        '          openclaw_current_revision: number',
        `          openclaw_current_revision: number
          openclaw_retired_revision: number`,
      )
      .replaceAll(
        '          openclaw_current_revision?: number',
        `          openclaw_current_revision?: number
          openclaw_retired_revision?: number`,
      );
    const baseline = buildOpenClawMergeFixture({
      additionalTables: staleSharedTable,
    });
    const generated = buildOpenClawMergeFixture({
      additionalTables: currentSharedTable,
    });

    const merged = mergeOpenClawGeneratedTypes(baseline, generated);

    expect(merged).not.toContain('openclaw_retired_revision');
    expect(merged).toContain('openclaw_current_revision: number');
    expect(merged).toContain('id: string');
  });

  test('rejects structurally valid generated types with no required OpenClaw schema', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const baseline = buildOpenClawMergeFixture();
    const generated = buildOpenClawMergeFixture({
      leadActivityFields: '',
      includeRequiredSurface: false,
    });

    expect(() => mergeOpenClawGeneratedTypes(baseline, generated)).toThrow(
      /required OpenClaw schema/i,
    );
  });

  test('rejects a malformed required OpenClaw accounts table shape', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const baseline = buildOpenClawMergeFixture();
    const generated = buildOpenClawMergeFixture({
      accountsTable: `      openclaw_accounts: {
        BROKEN: never
      }`,
    });

    expect(() => mergeOpenClawGeneratedTypes(baseline, generated)).toThrow(
      /required OpenClaw schema.*openclaw_accounts\.Row/i,
    );
  });

  test('rejects a partial OpenClaw surface even when the old sentinels are present', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const baseline = buildOpenClawMergeFixture();
    const generated = buildOpenClawMergeFixture({
      leadActivityFields: '          openclaw_schedule_revision: number',
      includeRequiredSurface: false,
      additionalTables: `      openclaw_accounts: {
        Row: {
        }
        Insert: {
        }
        Update: {
        }
        Relationships: []
      }`,
    });

    expect(() => mergeOpenClawGeneratedTypes(baseline, generated)).toThrow(
      /required OpenClaw schema/i,
    );
  });

  test('orders generated OpenClaw entries by deterministic ASCII code points', async () => {
    const { mergeOpenClawGeneratedTypes } = await loadWrapper();
    const generated = buildOpenClawMergeFixture({
      additionalTables: `${buildTableBlock('openclaw_a_')}
${buildTableBlock('openclaw_a0')}`,
    });

    const merged = mergeOpenClawGeneratedTypes(buildOpenClawMergeFixture(), generated);

    expect(merged.indexOf('      openclaw_a0: {')).toBeLessThan(
      merged.indexOf('      openclaw_a_: {'),
    );
  });

  test('uses the explicit PGlite engine without invoking the Supabase CLI', async () => {
    const { GENERATED_TYPES_HEADER, generateSupabaseTypes } = await loadWrapper();
    const repoRoot = await makeTemporaryDirectory();
    const targetDirectory = join(repoRoot, 'src', 'integrations', 'supabase');
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(repoRoot, 'package.json'), '{"name":"pglite-types"}\n', 'utf8');
    const baseline = buildOpenClawMergeFixture();
    const generated = buildOpenClawMergeFixture();
    await writeFile(
      join(targetDirectory, 'types.ts'),
      `${GENERATED_TYPES_HEADER}\n${baseline}`,
      'utf8',
    );
    let cliCalled = false;

    await generateSupabaseTypes({
      repoRoot,
      environment: {
        PATH: process.env.PATH,
        SUPABASE_TYPES_SOURCE: 'local',
        SUPABASE_TYPES_LOCAL_ENGINE: 'pglite',
      },
      runCli: async () => {
        cliCalled = true;
        throw new Error('CLI must not run');
      },
      runLocalPglite: async () => generated,
    });

    const output = await readFile(join(targetDirectory, 'types.ts'), 'utf8');
    expect(cliCalled).toBe(false);
    expect(output).toContain('legacy_column: string');
    expect(output).toContain('openclaw_accounts: {');
    expect(output).toContain('openclaw_schedule_revision: number');
  });

  test('writes generated types atomically and clears the child PAT environment', async () => {
    const { GENERATED_TYPES_HEADER, generateSupabaseTypes } = await loadWrapper();
    const repoRoot = await makeTemporaryDirectory();
    const fakePat = 'sbp_test_secret-1234567890';
    const targetDirectory = join(repoRoot, 'src', 'integrations', 'supabase');
    await mkdir(join(repoRoot, 'supabase'), { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(
      join(repoRoot, 'supabase', 'config.toml'),
      'project_id = "tryymsxyyckgbrmmvozx"\n',
      'utf8',
    );
    await writeFile(join(repoRoot, 'package.json'), '{"name":"test"}\n', 'utf8');
    await writeFile(join(repoRoot, 'CLAUDE.local.md'), `Supabase PAT: ${fakePat}\n`, 'utf8');

    let childEnvironment: NodeJS.ProcessEnv | undefined;
    await generateSupabaseTypes({
      repoRoot,
      environment: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: 'model-key-must-not-reach-child',
        UNRELATED_SECRET: 'unrelated-secret-must-not-reach-child',
      },
      platform: 'win32',
      runCli: async ({ command, args, env, shell }) => {
        childEnvironment = env;
        expect(command).toBe(process.execPath);
        expect(args[0]).toMatch(/npm-cli\.js$/);
        expect(args).toContain('tryymsxyyckgbrmmvozx');
        expect(shell).toBe(false);
        expect(env.SUPABASE_ACCESS_TOKEN).toBe(fakePat);
        expect(env.SUPABASE_PAT).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.UNRELATED_SECRET).toBeUndefined();
        return {
          exitCode: 0,
          stdout: 'export type Json = string\r\nexport type Database = {}\r\n',
          stderr: '',
        };
      },
    });

    expect(childEnvironment?.SUPABASE_ACCESS_TOKEN).toBeUndefined();
    expect(await readFile(join(targetDirectory, 'types.ts'), 'utf8')).toBe(
      `${GENERATED_TYPES_HEADER}\nexport type Json = string\nexport type Database = {}\n`,
    );
    expect((await readdir(targetDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('redacts PAT failures and removes a temporary file when replacement fails', async () => {
    const { atomicWriteUtf8, generateSupabaseTypes } = await loadWrapper();
    const repoRoot = await makeTemporaryDirectory();
    const fakePat = 'sbp_test_secret-0987654321';
    const targetDirectory = join(repoRoot, 'src', 'integrations', 'supabase');
    await mkdir(join(repoRoot, 'supabase'), { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(
      join(repoRoot, 'supabase', 'config.toml'),
      'project_id = "tryymsxyyckgbrmmvozx"\n',
      'utf8',
    );
    await writeFile(join(repoRoot, 'package.json'), '{}\n', 'utf8');
    await writeFile(join(repoRoot, 'CLAUDE.local.md'), fakePat, 'utf8');
    await writeFile(join(targetDirectory, 'types.ts'), 'original\n', 'utf8');

    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const failure = generateSupabaseTypes({
      repoRoot,
      environment: {},
      runCli: async ({ env }) => {
        childEnvironment = env;
        return { exitCode: 1, stdout: '', stderr: `request failed for ${fakePat}` };
      },
    });
    await expect(failure).rejects.toThrow(/\[REDACTED\]/);
    await expect(failure).rejects.not.toThrow(fakePat);
    expect(childEnvironment?.SUPABASE_ACCESS_TOKEN).toBeUndefined();
    expect(await readFile(join(targetDirectory, 'types.ts'), 'utf8')).toBe('original\n');

    const blockedTarget = join(targetDirectory, 'blocked-target');
    await mkdir(blockedTarget);
    await expect(atomicWriteUtf8(blockedTarget, 'replacement\n')).rejects.toThrow();
    expect((await readdir(targetDirectory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
