/**
 * Stage what the desktop app has to carry: a Node runtime and our sources.
 *
 * The decision this encodes is that the app bundles **the real Node binary and
 * the real source tree**, not a compiled single-file executable.
 *
 * `node:sea` was the obvious route and was rejected after looking at what it
 * costs here. SEA takes one CommonJS file, so it needs a bundler; this project
 * has no build step and no bundler, and adding one to produce the desktop
 * artifact would mean the thing users run is assembled by a toolchain nothing
 * else in the repository uses — a second way for the product to behave
 * differently from what the tests exercise. Node runs the TypeScript sources
 * directly, so carrying them is both simpler and closer to what is tested.
 *
 * The size is the same either way: the runtime dominates. Measured here,
 * `node.exe` is 85.6 MB and the sources are 960 KB.
 *
 * Under Apache-2.0 the sources travelling in readable form inside the app is a
 * feature rather than a leak.
 *
 * **One thing had to be rewritten, and this is the reason.** Node refuses to
 * strip types from any file under `node_modules` --
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and it is a deliberate policy,
 * not a bug. So the packages cannot be staged where a bare `@vibetracker/core`
 * would resolve, and the specifier has to become a relative path instead.
 *
 * That transform is the entire difference between what is tested and what is
 * shipped, and it is bounded: all 99 cross-package imports are plain
 * `@vibetracker/<name>` with no subpath, and every dynamic `import()` in the
 * tree is either `node:` or relative. A bundler would have been a much larger
 * difference for the same problem.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STAGE = join(ROOT, 'packages', 'desktop', 'src-tauri', 'runtime');

/**
 * Packages the CLI needs at run time. `fixtures` is in the list because
 * `vt demo` is a user-facing command, not only a test helper.
 */
const PACKAGES = ['cli', 'core', 'daemon', 'engine', 'fixtures', 'platform', 'shared'];

/**
 * Where each package's name actually points.
 *
 * Read from the package's own `exports`, never assumed. Six of the seven do
 * resolve to `src/index.ts` and the seventh does not — `@vibetracker/daemon`
 * is `src/main.ts` — so a rewrite that spelled the convention out shipped a
 * CLI whose `vt mini` died on ERR_MODULE_NOT_FOUND against a path that had
 * never existed in this repository either. The convention was the bug.
 */
const ENTRY = new Map(
  PACKAGES.map((pkg) => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'),
    );
    const entry = manifest.exports?.['.'] ?? manifest.main;
    // `cli` has no export map because nothing imports it; it is the entry.
    return [pkg, entry ? entry.replace(/^\.\//, '') : 'src/index.ts'];
  }),
);

/** Every path a rewrite pointed at, so the guard below can check they exist. */
const rewritten = new Set();

/**
 * Turn `@vibetracker/core` into a relative path from the importing file.
 *
 * `depth` is how far the file sits below its own package directory, so a file
 * at `packages/cli/src/a/b.ts` (depth 2 below `packages/cli`) reaches its
 * target by going up depth+1 levels.
 */
function rewriteImports(src, depth) {
  const up = '../'.repeat(depth + 1);
  return src.replace(/(['"])@vibetracker\/([a-z]+)\1/g, (_whole, q, pkg) => {
    const entry = ENTRY.get(pkg);
    if (!entry) throw new Error(`bilinmeyen paket: @vibetracker/${pkg}`);
    rewritten.add(`${pkg}/${entry}`);
    return `${q}${up}${pkg}/${entry}${q}`;
  });
}

/** Directories inside a package that must travel — data files, not just code. */
const DATA_DIRS = ['locales', 'lexicons', 'dialects', 'public'];

/**
 * Copy a tree. `depth` counts directories below the package root, and is what
 * the import rewrite needs; it is null for data directories, which are copied
 * byte for byte.
 */
function copyDir(from, to, filter, depth) {
  if (!existsSync(from)) return 0;
  let n = 0;
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test') continue;
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) {
      n += copyDir(src, dst, filter, depth === null ? null : depth + 1);
    } else if (filter(e.name)) {
      if (depth !== null && e.name.endsWith('.ts')) {
        writeFileSync(dst, rewriteImports(readFileSync(src, 'utf8'), depth), 'utf8');
      } else {
        copyFileSync(src, dst);
      }
      n++;
    }
  }
  return n;
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// ── the Node runtime ──────────────────────────────────────────────────────
// `process.execPath` is the interpreter running this script, which is the one
// the project is tested against. Taking it rather than downloading a release
// keeps the staged runtime and the tested runtime the same thing.
const node = process.execPath;
const nodeName = basename(node);
copyFileSync(node, join(STAGE, nodeName));
const nodeMb = statSync(node).size / 1e6;

// ── the sources ───────────────────────────────────────────────────────────
// Plain directories under `packages/`, deliberately NOT under `node_modules`:
// see the note at the top of this file. Cross-package imports are rewritten to
// relative paths on the way in.
const pkgRoot = join(STAGE, 'packages');
let files = 0;
for (const pkg of PACKAGES) {
  const from = join(ROOT, 'packages', pkg);
  const to = join(pkgRoot, pkg);
  files += copyDir(
    join(from, 'src'),
    join(to, 'src'),
    (n) => n.endsWith('.ts') || n.endsWith('.ps1') || n.endsWith('.html'),
    1,
  );
  for (const dir of DATA_DIRS) {
    files += copyDir(join(from, dir), join(to, dir), () => true, null);
  }
  copyFileSync(join(from, 'package.json'), join(to, 'package.json'));
  files++;
}

// Nothing may still be asking for a bare specifier: outside a workspace it
// would resolve to nothing, and the failure would only appear on a user's
// machine at the moment they opened the app.
const leftovers = [];
(function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) scan(f);
    else if (e.name.endsWith('.ts') && /(['"])@vibetracker\/[a-z]+/.test(readFileSync(f, 'utf8'))) {
      // Quoted specifiers only. Prose mentions of a package name in a comment
      // are not imports, and failing the build over one would teach people to
      // stop writing the comments.
      leftovers.push(relative(STAGE, f));
    }
  }
})(pkgRoot);
if (leftovers.length > 0) {
  process.stderr.write(
    `Files still carrying an unresolved package name:\n  ${leftovers.join('\n  ')}\n`,
  );
  process.exit(1);
}

// And every path a rewrite produced has to be a file that is actually here.
//
// The check above only asked whether any bare specifier survived; a rewrite
// that pointed confidently at the wrong file passed it. That is how the desktop
// package shipped a `vt mini` that could not start: `@vibetracker/daemon`
// became `daemon/src/index.ts`, which resolves to nothing, and nothing said so
// until the command was run on a user's machine.
const missing = [...rewritten].filter((rel) => !existsSync(join(STAGE, 'packages', rel)));
if (missing.length > 0) {
  process.stderr.write(
    `An import pointing at a file that does not exist:\n  ${missing.join('\n  ')}\n`,
  );
  process.exit(1);
}

// LICENSE and NOTICE travel with the code they cover.
for (const name of ['LICENSE', 'NOTICE']) {
  if (existsSync(join(ROOT, name))) copyFileSync(join(ROOT, name), join(STAGE, name));
}

writeFileSync(
  join(STAGE, 'README.txt'),
  [
    'VibeTracker desktop runtime',
    '',
    'Bu dizin, masaustu uygulamasinin tasidigi Node calisma zamani ve',
    'VibeTracker kaynaklarindan olusur. Elle duzenlenmez; her derlemede',
    'scripts/desktop-stage.mjs tarafindan yeniden uretilir.',
    '',
    'Lisans: Apache-2.0 (bkz. LICENSE). Node.js kendi lisansiyla gelir.',
    '',
  ].join('\n'),
  'utf8',
);

process.stdout.write(
  `Desktop runtime staged: ${STAGE}\n` +
    `  ${nodeName} · ${nodeMb.toFixed(1)} MB\n` +
    `  ${files} source files\n`,
);
