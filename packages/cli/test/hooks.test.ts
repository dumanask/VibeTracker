import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, uninstallHooks } from '../src/hooks.ts';
import { parseWithPositions, child } from '@vibetracker/core';

/**
 * The whole risk of this feature is in one sentence: we write to a file that
 * belongs to the user's agent, and if we get it wrong their agent breaks.
 *
 * So the assertions here are not "our hook is present" — they are "everything
 * of theirs is still exactly as they wrote it".
 */

function sandbox(content: string): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'vt-hooks-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, content, 'utf8');
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ARGS = { yes: true, highFidelity: false, port: 47823 };

const USER_SETTINGS = `{
    "theme": "dark-daltonized",
    "effortLevel": "max",
    "hooks": {
        "Stop": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": "echo benim-kendi-hookum"
                    }
                ]
            }
        ]
    }
}
`;

test('installing preserves the user\'s own hook and formatting', async () => {
  const s = sandbox(USER_SETTINGS);
  try {
    const code = await installHooks({ ...ARGS, settingsPath: s.path });
    assert.equal(code, 0);
    const after = readFileSync(s.path, 'utf8');

    // Still valid, still four-space, still theirs.
    const root = parseWithPositions(after);
    assert.equal(child(root, 'theme')?.value, 'dark-daltonized');
    assert.ok(after.includes('echo benim-kendi-hookum'), 'kullanıcının hooku silinmiş');
    assert.ok(/\n {4}"theme"/.test(after), `girinti değişmiş:\n${after}`);

    // Ours landed on Stop as a *separate* matcher, not by editing theirs.
    const stop = child(child(root, 'hooks'), 'Stop')!;
    assert.equal(stop.items?.length, 2, 'kendi matcher\'ımız ayrı eklenmeliydi');

    // And a backup exists.
    assert.ok(
      readdirSync(s.dir).some((f) => f.includes('.vtbak-')),
      'yedek alınmamış',
    );
  } finally {
    s.cleanup();
  }
});

test('uninstalling removes only ours and restores the original meaning', async () => {
  const s = sandbox(USER_SETTINGS);
  try {
    await installHooks({ ...ARGS, settingsPath: s.path });
    await uninstallHooks({ ...ARGS, settingsPath: s.path });
    const after = readFileSync(s.path, 'utf8');

    assert.deepEqual(
      JSON.parse(after) as unknown,
      JSON.parse(USER_SETTINGS) as unknown,
      'kaldırma sonrası dosya anlamca aynı olmalı',
    );
    assert.ok(after.includes('echo benim-kendi-hookum'));
  } finally {
    s.cleanup();
  }
});

test('installing twice changes nothing the second time', async () => {
  const s = sandbox(USER_SETTINGS);
  try {
    await installHooks({ ...ARGS, settingsPath: s.path });
    const once = readFileSync(s.path, 'utf8');
    await installHooks({ ...ARGS, settingsPath: s.path });
    assert.equal(readFileSync(s.path, 'utf8'), once, 'ikinci kurulum dosyayı değiştirmemeli');
  } finally {
    s.cleanup();
  }
});

test('a missing settings file is created, not crashed on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vt-hooks-'));
  const path = join(dir, 'settings.json');
  try {
    const code = await installHooks({ ...ARGS, settingsPath: path });
    assert.equal(code, 0);
    assert.ok(existsSync(path));
    const root = parseWithPositions(readFileSync(path, 'utf8'));
    assert.ok(child(root, 'hooks'), 'hooks yazılmamış');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed settings are refused, never overwritten', async () => {
  const broken = `{ "theme": "dark",, }`;
  const s = sandbox(broken);
  try {
    const code = await installHooks({ ...ARGS, settingsPath: s.path });
    assert.equal(code, 5, 'bozuk dosyada hata kodu dönmeli');
    assert.equal(readFileSync(s.path, 'utf8'), broken, 'bozuk dosya değiştirilmiş');
  } finally {
    s.cleanup();
  }
});

test('every installed entry carries our marker and our url', async () => {
  const s = sandbox('{}\n');
  try {
    await installHooks({ ...ARGS, settingsPath: s.path });
    const hooks = child(parseWithPositions(readFileSync(s.path, 'utf8')), 'hooks')!;
    let n = 0;
    for (const m of hooks.members ?? []) {
      for (const matcher of m.value.items ?? []) {
        for (const h of child(matcher, 'hooks')?.items ?? []) {
          assert.equal(child(h, '_vt')?.value, true, `${m.key}: işaret yok`);
          assert.equal(child(h, 'url')?.value, 'http://127.0.0.1:47823/h/v1');
          assert.equal(child(h, 'type')?.value, 'http');
          n++;
        }
      }
    }
    assert.ok(n >= 13, `beklenenden az girdi: ${n}`);
  } finally {
    s.cleanup();
  }
});

test('high fidelity adds the tool events and nothing else changes', async () => {
  const s = sandbox('{}\n');
  try {
    await installHooks({ ...ARGS, settingsPath: s.path, highFidelity: true });
    const hooks = child(parseWithPositions(readFileSync(s.path, 'utf8')), 'hooks')!;
    const events = (hooks.members ?? []).map((m) => m.key);
    assert.ok(events.includes('PreToolUse'));
    assert.ok(events.includes('PostToolUse'));
    assert.ok(events.includes('PermissionRequest'));
    assert.ok(!events.includes('MessageDisplay'), 'MessageDisplay asla bağlanmamalı');
  } finally {
    s.cleanup();
  }
});
