/**
 * Public repository boundaries: active backend vs archived web demo.
 *
 * This is a cross-component, structural test. It never starts the server, the
 * clock or the engine: it reads the committed layout and its public interface
 * files, so a reader can verify the ownership contract without reconstructing
 * the migration story.
 *
 * What it pins (S2/S3/S4/S6):
 *
 * 1. The root manifest is private Bun orchestration with `[backend]` as its only
 *    workspace and `bun backend/main.ts` as the single server command.
 * 2. The active dependency graph keeps the backend runtime dependency (Zod) and
 *    drops the retired frontend, Tailwind, GenAI and Express packages.
 * 3. The retired web sources live under `docs/archive/web-demo/` as historical
 *    source only, with their original manifests, and are excluded from the
 *    active typecheck/test/build/container scope.
 * 4. Backend-owned tests live under `backend/tests/`; `tests/integration/`
 *    remains the cross-component home.
 * 5. Container and CI entrypoints point at the active backend, and the required
 *    CI check name is unchanged.
 *
 * The archive is provenance, not a second application: nothing here asserts it
 * builds or runs.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file so the cwd never matters. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ARCHIVE = 'docs/archive/web-demo';
const RETIRED_PACKAGES = [
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  'vite',
  '@vitejs/plugin-react',
  '@tailwindcss/vite',
  'tailwindcss',
  'autoprefixer',
  'lucide-react',
  'motion',
  '@google/genai',
  'express',
  '@types/express',
  'dotenv',
  'esbuild',
  'tsx',
];

function absolute(repoRelative: string): string {
  return resolve(REPO_ROOT, repoRelative);
}

function readText(repoRelative: string): string {
  return readFileSync(absolute(repoRelative), 'utf8');
}

function readJson<T = Record<string, unknown>>(repoRelative: string): T {
  return JSON.parse(readText(repoRelative)) as T;
}

interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly workspaces?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function readManifest(repoRelative: string): Manifest {
  return readJson<Manifest>(repoRelative);
}

describe('root manifest: private Bun orchestration over the backend workspace', () => {
  test('the root package is private, named gigaforge and owns only the backend workspace', () => {
    const manifest = readManifest('package.json');

    assert.equal(manifest.private, true, 'the repository must never be publishable as a package');
    assert.equal(manifest.name, 'gigaforge', 'the active root package owns the product name');
    assert.deepEqual(manifest.workspaces, ['backend'], 'exactly one native workspace: the backend');
  });

  test('the root server command stays `bun backend/main.ts` (legacy CLI contract)', () => {
    const manifest = readManifest('package.json');

    assert.equal(
      manifest.scripts?.server,
      'bun backend/main.ts',
      'the documented server command keeps its entrypoint, CWD and env semantics',
    );
    assert.ok(existsSync(absolute('backend/main.ts')), 'backend/main.ts is the entrypoint the command runs');
    assert.match(
      readText('backend/main.ts'),
      /from '\.\/src\/main\.ts'/,
      'the entrypoint still hands off to the backend command surface',
    );
  });

  test('root test/lint/build scripts are scoped to the active backend', () => {
    const manifest = readManifest('package.json');
    const scripts = manifest.scripts ?? {};

    assert.equal(scripts.test, 'bun test backend/tests tests/integration');
    assert.equal(scripts['test:backend'], 'bun test backend/tests');
    assert.equal(scripts.build, 'bun run --cwd backend build', 'root delegates artifact ownership to the backend');
    assert.equal(
      readManifest('backend/package.json').scripts?.build,
      'bun build main.ts --target=bun --outdir=dist',
      'the backend owns its build output under backend/dist, never the retired root dist',
    );
    assert.doesNotMatch(scripts.build ?? '', /vite/, 'build no longer builds the retired frontend');
    assert.match(scripts.lint ?? '', /tsc/, 'lint remains a TypeScript check over the active scope');
  });
});

describe('active dependency graph excludes the retired web application', () => {
  test('no frontend, Tailwind, GenAI or Express package stays in the active graph', () => {
    const root = readManifest('package.json');
    const backend = readManifest('backend/package.json');
    const active = {
      ...root.dependencies,
      ...root.devDependencies,
      ...backend.dependencies,
      ...backend.devDependencies,
    };

    for (const retired of RETIRED_PACKAGES) {
      assert.equal(
        active[retired],
        undefined,
        `${retired} belongs to the archived demo; it must not stay in the active dependency graph`,
      );
    }
  });

  test('the backend package owns the runtime Zod dependency', () => {
    const backend = readManifest('backend/package.json');

    assert.equal(backend.private, true, 'the workspace package is not published on its own');
    assert.ok(backend.dependencies?.zod, 'Zod is the backend runtime dependency');
    assert.equal(readManifest('package.json').dependencies, undefined, 'root orchestration needs no runtime package');
  });

  test('one active lockfile records the root and backend workspaces', () => {
    // bun.lock is JSON-with-trailing-commas, so the boundary is asserted as text.
    const lock = readText('bun.lock');

    assert.match(lock, /"workspaces":\s*\{/, 'bun.lock records the native workspaces');
    assert.match(lock, /"name": "gigaforge"/, 'the root workspace is recorded in bun.lock');
    assert.match(lock, /"backend": \{/, 'the backend workspace is recorded in bun.lock');
    assert.match(lock, /"name": "@gigaforge\/backend"/, 'the backend workspace keeps its own identity');
    assert.match(lock, /"zod": "\^4\.6\.7"/, 'the backend workspace lock entry keeps Zod');
    assert.doesNotMatch(lock, /"react":/, 'no retired React runtime stays in the active lockfile');
    assert.doesNotMatch(lock, /"vite":/, 'no retired Vite toolchain stays in the active lockfile');
    assert.equal(existsSync(absolute('backend/bun.lock')), false, 'the workspace shares the root lockfile');
    assert.equal(
      existsSync(absolute('backend/bun.lockb')),
      false,
      'no second binary lockfile competes with the root one',
    );
  });
});

describe('archived web demo: historical source only', () => {
  test('the retired frontend sources moved under docs/archive/web-demo', () => {
    for (const retired of [
      `${ARCHIVE}/index.html`,
      `${ARCHIVE}/vite.config.ts`,
      `${ARCHIVE}/metadata.json`,
      `${ARCHIVE}/src/App.tsx`,
      `${ARCHIVE}/src/main.tsx`,
      `${ARCHIVE}/src/index.css`,
      `${ARCHIVE}/src/persistence/InMemorySettlementProvider.ts`,
      `${ARCHIVE}/public`,
    ]) {
      assert.ok(existsSync(absolute(retired)), `${retired} must exist in the archive, not at the root`);
    }

    for (const retiredRoot of [
      'index.html',
      'vite.config.ts',
      'metadata.json',
      'public',
      'src/App.tsx',
      'src/main.tsx',
      'src/index.css',
      'src/persistence/InMemorySettlementProvider.ts',
    ]) {
      assert.equal(existsSync(absolute(retiredRoot)), false, `${retiredRoot} is not an active file anymore`);
    }
  });

  test('the archive preserves the original frontend manifests verbatim', () => {
    const archived = readManifest(`${ARCHIVE}/package.json`);

    assert.equal(archived.name, 'react-example', 'the archived manifest keeps its historical identity');
    assert.ok(archived.dependencies?.react, 'historical React dependency stays for provenance');
    assert.ok(archived.dependencies?.vite, 'historical Vite dependency stays for provenance');
    assert.ok(existsSync(absolute(`${ARCHIVE}/bun.lock`)), 'the original frontend lockfile is preserved');
    assert.match(readText(`${ARCHIVE}/README.md`), /4a116ec/, 'the archive names the commit that can still run it');
  });

  test('the archive README states it is not a runnable supported application', () => {
    const readme = readText(`${ARCHIVE}/README.md`);

    assert.match(readme, /source only/i);
    assert.match(readme, /not a runnable/i, 'the archive must not be presented as an installable app');
    assert.match(readme, /historical commit/i, 'reproduction points at the saved commit, not the archive');
  });

  test('the archive holds no duplicated copy of the active backend core', () => {
    for (const duplicated of ['domain', 'engine', 'mcp']) {
      assert.equal(
        existsSync(absolute(`${ARCHIVE}/src/${duplicated}`)),
        false,
        `the archive must not copy the active ${duplicated} core`,
      );
    }
    assert.deepEqual(
      readdirSync(absolute(`${ARCHIVE}/src/persistence`)),
      ['InMemorySettlementProvider.ts'],
      'only the frozen browser provider belongs to the archive',
    );
  });
});

describe('active backend owns the core and its tests', () => {
  test('the active core lives under backend/src', () => {
    for (const owned of [
      'backend/src/domain',
      'backend/src/engine',
      'backend/src/mcp',
      'backend/src/persistence',
      'backend/src/domain/web3DomainModel.ts',
      'backend/src/persistence/bun-sqlite.d.ts',
    ]) {
      assert.ok(existsSync(absolute(owned)), `${owned} is active backend code`);
    }

    for (const retired of ['src/domain', 'src/engine', 'src/mcp', 'src/persistence']) {
      assert.equal(existsSync(absolute(retired)), false, `${retired} must not shadow the backend copy`);
    }
    assert.equal(
      existsSync(absolute('backend/src/persistence/InMemorySettlementProvider.ts')),
      false,
      'the browser-only provider is archived, never part of the server',
    );
  });

  test('backend-owned suites live in backend/tests and integration keeps its own home', () => {
    for (const suite of [
      'backend/tests/engine',
      'backend/tests/golden',
      'backend/tests/mcp',
      'backend/tests/persistence',
      'backend/tests/property',
      'backend/tests/regressions',
      'tests/integration/repository-boundaries.test.ts',
    ]) {
      assert.ok(existsSync(absolute(suite)), `${suite} must exist in its owning scope`);
    }

    for (const retired of [
      'backend/test',
      'tests/engine',
      'tests/golden',
      'tests/mcp',
      'tests/persistence',
      'tests/property',
      'tests/regressions',
      'tests/engine-material-shortage.test.ts',
    ]) {
      assert.equal(existsSync(absolute(retired)), false, `${retired} must not hold a second copy of a suite`);
    }
  });

  test('the P0 matrix resolves its files from the new backend tests depth', () => {
    const matrix = readText('backend/tests/regressions/p0-matrix.test.ts');

    assert.match(
      matrix,
      /const REPO_ROOT = resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.', '\.\.'\)/,
      'backend/tests/regressions is three levels below the repository root',
    );
    assert.match(
      matrix,
      /'backend\/tests\/regressions\/README\.md'/,
      'the README half of the matrix moved with the test',
    );
    assert.doesNotMatch(matrix, /'tests\/(engine|mcp|property)\//, 'no matrix entry points at a moved-away path');
    assert.doesNotMatch(matrix, /'backend\/test\//, 'no matrix entry points at the old flat backend test dir');
  });
});

describe('typecheck, container and CI scope follow the active backend', () => {
  test('the root TypeScript scope covers integration tests only and extends the backend config', () => {
    const root = readJson<{ extends?: string; include?: string[]; exclude?: string[] }>('tsconfig.json');

    assert.equal(root.extends, './backend/tsconfig.json', 'the root config reuses the backend compiler options');
    assert.deepEqual(root.include, ['tests/integration/**/*.ts'], 'the root only adds cross-component tests');
    assert.ok(root.exclude?.includes('docs'), 'the archived site stays outside the active typecheck');
  });

  test('the backend TypeScript scope needs no React, Vite or DOM types', () => {
    const backend = readJson<{
      include?: string[];
      exclude?: string[];
      compilerOptions?: Record<string, unknown>;
    }>('backend/tsconfig.json');
    const types = backend.compilerOptions?.types;
    const lib = backend.compilerOptions?.lib;

    assert.ok(backend.include?.includes('main.ts'));
    assert.ok(backend.include?.includes('src/**/*.ts'));
    assert.ok(backend.include?.includes('tests/**/*.ts'));
    assert.ok(backend.exclude?.includes('node_modules'));
    assert.equal(backend.compilerOptions?.jsx, undefined, 'Bun/Node sources do not compile JSX');
    assert.ok(Array.isArray(types), 'ambient types stay explicit instead of inheriting the environment');
    assert.deepEqual(types, ['node'], 'only Node/Bun ambient types are needed');
    assert.ok(Array.isArray(lib), 'the library surface is explicit');
    assert.equal(lib.includes('DOM'), false, 'no DOM library is needed for a server process');
    assert.equal(backend.compilerOptions?.noEmit, true);
  });

  test('the container build definition sits beside the backend it builds', () => {
    assert.equal(existsSync(absolute('Dockerfile')), false, 'the root no longer carries a frontend-era Dockerfile');

    const dockerfile = readText('backend/Dockerfile');
    assert.match(dockerfile, /oven\/bun:1\.4\.2/, 'the pinned runtime is unchanged');
    assert.match(dockerfile, /COPY backend\/src/, 'only the backend sources are copied');
    assert.doesNotMatch(dockerfile, /COPY src\//, 'the retired root sources are gone');
    assert.doesNotMatch(dockerfile, /backend\/test/, 'tests never reach the runtime image');

    const compose = readText('compose.yaml');
    assert.match(compose, /context: \./, 'the build context stays the repository root');
    assert.match(compose, /dockerfile: backend\/Dockerfile/, 'Compose selects the relocated Dockerfile');
  });

  test('the Docker build context excludes the archive, the tests and the game project', () => {
    const ignored = readText('.dockerignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    for (const excluded of ['docs', 'tests', 'backend/tests', 'gf', '.env']) {
      assert.ok(ignored.includes(excluded), `.dockerignore must exclude ${excluded} from the build context`);
    }
  });

  test('CI keeps its required check name and gates the active scoped commands', () => {
    const ci = readText('.github/workflows/ci.yml');

    assert.match(ci, /^ {4}name: test, lint, build \(headless\)$/m, 'the required check name is unchanged');
    assert.match(ci, /bun install --frozen-lockfile/, 'the single root lockfile installs frozen');
    assert.match(ci, /bun run test\b/, 'CI runs the scoped root test script');
    assert.match(ci, /bun run lint\b/, 'CI runs the lint gate');
    assert.match(ci, /bun run build\b/, 'CI builds the real backend');
  });
});
