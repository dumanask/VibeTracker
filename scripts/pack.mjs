/**
 * Assemble the publishable tarball.
 *
 * Development has no build step — Node strips the types and runs the sources
 * directly, which is why `packages/*` cross-import through workspace names.
 * npm has no workspace links, so publishing has exactly one job: turn those
 * bare specifiers into relative paths and flatten the layout.
 *
 * That is a *packaging* transform, not a build. It runs only here, it emits
 * the same TypeScript it consumed, and the published files stay readable and
 * debuggable — someone who opens `node_modules/vibetracker/src/core/derive.ts`
 * sees the file this repository holds, with the comments intact.
 *
 * Two things this script refuses to do:
 *  - guess a license (see LICENSE_NOTE below)
 *  - include anything not named in COPY, so a stray fixture or a scratch file
 *    cannot ride along
 *
 * Usage:  node scripts/pack.mjs [--out <dir>]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : join(ROOT, '.pack');

/** Workspace packages, and which file their name resolves to. */
// `fixtures` ships deliberately: `vt demo` uses it, and so does anyone
// reproducing a bug. It is the same generator CI runs, which is what stops
// the demo drifting into a prettier version of reality.
const PACKAGES = ['shared', 'core', 'platform', 'engine', 'daemon', 'fixtures', 'cli'];

/** Everything that goes in the tarball. Nothing else does. */
const COPY = [
  { from: 'packages/daemon/public', to: 'src/public' },
  { from: 'packages/core/lexicons', to: 'src/lexicons' },
  { from: 'packages/core/locales', to: 'src/locales' },
  { from: 'packages/core/dialects', to: 'src/dialects' },
  { from: 'README.md', to: 'README.md' },
  { from: 'PRIVACY.md', to: 'PRIVACY.md' },
  { from: 'SECURITY.md', to: 'SECURITY.md' },
];

const LICENSE_NOTE =
  'Lisans henüz seçilmedi. `npm publish` bilerek engellendi: lisanssız yayın,\n' +
  'kullanma hakkı belirsiz kod dağıtmak demektir. Bir LICENSE dosyası ekle\n' +
  '(plan Apache-2.0 öneriyor) ve package.json içindeki "license" alanını güncelle.';

function entryOf(pkg) {
  const meta = JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'));
  const exp = meta.exports?.['.'] ?? './src/index.ts';
  return exp.replace(/^\.\/src\//, '');
}

const ENTRY = Object.fromEntries(PACKAGES.map((p) => [p, entryOf(p)]));

/**
 * Rewrite `@vibetracker/core` to the relative path of its entry file, as seen
 * from the importing file's new home.
 */
function rewrite(text, fileDirInStage) {
  return text.replace(/(['"])@vibetracker\/([a-z]+)\1/g, (whole, quote, pkg) => {
    if (!PACKAGES.includes(pkg)) throw new Error(`bilinmeyen paket: ${pkg}`);
    let rel = relative(fileDirInStage, join(STAGE, 'src', pkg, ENTRY[pkg]));
    rel = rel.split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${quote}${rel}${quote}`;
  });
}

function copySources() {
  let files = 0;
  for (const pkg of PACKAGES) {
    const src = join(ROOT, 'packages', pkg, 'src');
    const dst = join(STAGE, 'src', pkg);
    for (const file of walk(src)) {
      const target = join(dst, relative(src, file));
      mkdirSync(dirname(target), { recursive: true });
      const text = readFileSync(file, 'utf8');
      writeFileSync(target, rewrite(text, dirname(target)), 'utf8');
      files++;
    }
  }
  return files;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function packageJson(version) {
  const hasLicense = existsSync(join(ROOT, 'LICENSE'));
  return {
    name: 'vibetracker',
    version,
    description:
      'Mission control for multi-agent, multi-project vibe coding — which agent is waiting, which project is where',
    type: 'module',
    // Node 22.20 runs TypeScript directly and ships node:sqlite without a
    // flag. Both are load-bearing: below this there is no way to start.
    engines: { node: '>=22.20' },
    bin: { vt: 'bin/vt.mjs' },
    // NOTICE travels with LICENSE, not as a courtesy: Apache-2.0 section 4(d)
    // requires anyone redistributing this to carry it, and they cannot carry
    // what we never shipped. It is also where the "not an official tool"
    // statement lives, which is the one thing a user of a fork most needs.
    files: [
      'bin/',
      'src/',
      'no-publish.mjs',
      'README.md',
      'PRIVACY.md',
      'SECURITY.md',
      'LICENSE',
      'NOTICE',
    ],
    keywords: ['claude-code', 'agent', 'monitor', 'dashboard', 'vibe-coding', 'cli'],
    license: hasLicense ? 'Apache-2.0' : 'UNLICENSED',
    // No runtime dependencies. Deliberate: every dependency is a way for an
    // install to fail on a machine we have never seen.
    dependencies: {},
    // The guard is a file, not an inline `node -e`: a one-liner with quotes
    // and newlines in it is mangled differently by cmd.exe and by sh, and a
    // guard that dies with a SyntaxError blocks publishing without telling
    // anyone why.
    scripts: hasLicense ? {} : { prepublishOnly: 'node ./no-publish.mjs' },
  };
}

/**
 * The launcher. It exists so the experimental-warning suppression lives in
 * one place rather than in everyone's shell history, and so the published
 * entry point stays a plain `.mjs` that any Node can at least parse and
 * explain itself from.
 */
const LAUNCHER = `#!/usr/bin/env node
// VibeTracker CLI launcher.
//
// Node runs the TypeScript sources directly (22.20+), which prints an
// experimental warning for node:sqlite and for type stripping. Re-executing
// once with the warnings disabled is the only way to suppress them without
// asking every user to remember a flag.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'cli', 'index.ts');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 20)) {
  console.error(
    \`VibeTracker Node 22.20+ gerektiriyor (bulunan: \${process.version}).\\n\` +
      'Bu sürüm, derleme adımı olmadan TypeScript çalıştırmak ve node:sqlite\\n' +
      'kullanmak için gerekli — daha eskisinde başlayamaz.',
  );
  process.exit(1);
}

const r = spawnSync(
  process.execPath,
  ['--no-warnings=ExperimentalWarning', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 70);
`;

// ── run ─────────────────────────────────────────────────────────────────
// The version lives in one place — the daemon — so a published tarball can
// never disagree with what `vt doctor` reports.
const mainSrc = readFileSync(join(ROOT, 'packages', 'daemon', 'src', 'main.ts'), 'utf8');
const versionMatch = /VERSION = '([^']+)'/.exec(mainSrc);
if (!versionMatch) {
  console.error('Sürüm bulunamadı: packages/daemon/src/main.ts içinde VERSION yok.');
  process.exit(1);
}
const version = versionMatch[1];

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const fileCount = copySources();

for (const item of COPY) {
  const from = join(ROOT, item.from);
  if (!existsSync(from)) {
    console.warn(`  atlandı (yok): ${item.from}`);
    continue;
  }
  const to = join(STAGE, item.to);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

mkdirSync(join(STAGE, 'bin'), { recursive: true });
writeFileSync(join(STAGE, 'bin', 'vt.mjs'), LAUNCHER, 'utf8');
writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(packageJson(version), null, 2)}\n`, 'utf8');
if (existsSync(join(ROOT, 'LICENSE'))) {
  cpSync(join(ROOT, 'LICENSE'), join(STAGE, 'LICENSE'));
  if (existsSync(join(ROOT, 'NOTICE'))) cpSync(join(ROOT, 'NOTICE'), join(STAGE, 'NOTICE'));
} else {
  const text = JSON.stringify(`\n${LICENSE_NOTE}\n`);
  writeFileSync(join(STAGE, 'no-publish.mjs'), `console.error(${text});\nprocess.exit(1);\n`, 'utf8');
}

// ── audit: nothing may leave that we did not name ─────────────────────────
const FORBIDDEN = [/\.env$/i, /credential/i, /\.pem$/i, /id_rsa/, /token$/i, /\.tgz$/];
const suspicious = [];
for (const f of walk(STAGE)) {
  const rel = relative(STAGE, f);
  if (FORBIDDEN.some((re) => re.test(rel))) suspicious.push(rel);
}
if (suspicious.length > 0) {
  console.error(`Şüpheli dosyalar pakete girecekti:\n  ${suspicious.join('\n  ')}`);
  process.exit(1);
}

// Any surviving workspace *specifier* means a file would fail to resolve
// after install — and it would fail for the user, not for us. Prose mentions
// of a package name in a comment are fine and stay; only quoted specifiers,
// exactly what `rewrite` targets, are errors.
const SPECIFIER = /(['"])@vibetracker\/[a-z]+/;
const leftovers = [];
for (const f of walk(join(STAGE, 'src'))) {
  if (!/\.(ts|mjs|js)$/.test(f)) continue;
  if (SPECIFIER.test(readFileSync(f, 'utf8'))) leftovers.push(relative(STAGE, f));
}
if (leftovers.length > 0) {
  console.error(`Çevrilmemiş paket adı kalmış:\n  ${leftovers.join('\n  ')}`);
  process.exit(1);
}

// And every relative import a rewrite produced has to name a file that is here.
//
// The check above only asks whether a bare specifier survived; a rewrite that
// pointed confidently at the wrong file passed it. Its twin in
// `desktop-stage.mjs` did exactly that — `@vibetracker/daemon` became
// `daemon/src/index.ts`, which has never existed — and the desktop package
// shipped a `vt mini` that died on ERR_MODULE_NOT_FOUND on a user's machine.
// This script reads each package's real entry from its `exports`, so that
// particular mistake is not available here; the guard is for the next one.
const missing = [];
for (const f of walk(join(STAGE, 'src'))) {
  if (!/\.(ts|mjs|js)$/.test(f)) continue;
  const dir = dirname(f);
  for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*(['"])(\.[^'"]+)\1/g)) {
    const target = resolve(dir, m[2]);
    if (!existsSync(target)) missing.push(`${relative(STAGE, f)} -> ${m[2]}`);
  }
}
if (missing.length > 0) {
  console.error(`Var olmayan dosyayı gösteren içe aktarım:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const bytes = [...walk(STAGE)].reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `\nPaket hazır: ${STAGE}\n` +
    `  ${fileCount} kaynak dosyası · toplam ${(bytes / 1024).toFixed(0)} KB\n` +
    `  sürüm ${version} · bağımlılık yok\n`,
);
if (!existsSync(join(ROOT, 'LICENSE'))) console.log(`  ⚠ ${LICENSE_NOTE.split('\n')[0]}\n`);
console.log(`Tarball:  cd ${relative(ROOT, STAGE) || '.'} && npm pack`);
console.log(`Deneme:   npm i -g ./${relative(ROOT, STAGE).split(sep).join('/')}\n`);
