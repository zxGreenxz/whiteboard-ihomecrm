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
    expect(invocation.args[invocation.args.length - 1]).toBe(
      'C:\\repo\\scripts\\generate-openclaw-pglite-types.mjs',
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
    const baseline = `export type Json = string
export type Database = {
  public: {
    Tables: {
      lead_activities: {
        Row: {
          legacy_column: string
        }
        Insert: {
          legacy_column: string
        }
        Update: {
          legacy_column?: string
        }
        Relationships: []
      }
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
      [_ in never]: never
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
    const generated = `export type Json = string
export type Database = {
  public: {
    Tables: {
      lead_activities: {
        Row: {
          openclaw_schedule_revision: number
        }
        Insert: {
          openclaw_schedule_revision?: number
        }
        Update: {
          openclaw_schedule_revision?: number
        }
        Relationships: []
      }
      openclaw_accounts: {
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
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      openclaw_status_v1: {
        Args: never
        Returns: Json
      }
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

    const merged = mergeOpenClawGeneratedTypes(baseline, generated);
    expect(merged).toContain('legacy_column: string');
    expect(merged).toContain('openclaw_schedule_revision: number');
    expect(merged).toContain('openclaw_accounts: {');
    expect(merged).toContain('openclaw_status_v1: {');
    expect(merged).toContain('legacy_view: {');
  });

  test('uses the explicit PGlite engine without invoking the Supabase CLI', async () => {
    const { GENERATED_TYPES_HEADER, generateSupabaseTypes } = await loadWrapper();
    const repoRoot = await makeTemporaryDirectory();
    const targetDirectory = join(repoRoot, 'src', 'integrations', 'supabase');
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(repoRoot, 'package.json'), '{"name":"pglite-types"}\n', 'utf8');
    const baseline = `export type Json = string
export type Database = {
  public: {
    Tables: {
      lead_activities: {
        Row: {
          legacy_column: string
        }
        Insert: {
          legacy_column: string
        }
        Update: {
          legacy_column?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
    const generated = `export type Json = string
export type Database = {
  public: {
    Tables: {
      lead_activities: {
        Row: {
          openclaw_schedule_revision: number
        }
        Insert: {
          openclaw_schedule_revision?: number
        }
        Update: {
          openclaw_schedule_revision?: number
        }
        Relationships: []
      }
      openclaw_accounts: {
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
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
