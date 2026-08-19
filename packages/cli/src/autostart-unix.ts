/**
 * Starting the daemon at login on macOS and Linux.
 *
 * Split from `autostart.ts` because the Windows path is a Scheduled Task and
 * shares nothing with these but the shape of the answer. Keeping them in one
 * file would mean three implementations interleaved by `if (platform)`, and the
 * reason each one is the way it is would be impossible to read.
 *
 * All three agree on one rule: **no administrator rights, ever.** A per-user
 * observer that asks for root has misunderstood what it is. That is why this is
 * a LaunchAgent rather than a LaunchDaemon, and a `systemd --user` unit rather
 * than a system one — and it is also why the Linux unit can make a promise the
 * other two cannot (see below).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { configDir, dataDir } from '@vibetracker/platform';
import { t, tr } from '@vibetracker/core';

const exec = promisify(execFile);

/** Reverse-DNS on macOS, a plain unit name on Linux. Both are conventional. */
export const LAUNCH_LABEL = 'dev.vibetracker.daemon';
export const SYSTEMD_UNIT = 'vibetracker';

/** How long launchd/systemd wait before restarting a daemon that died. */
const THROTTLE_SEC = 30;

export interface UnixAutostart {
  supported: boolean;
  installed: boolean;
  stale?: boolean;
  detail: string;
  /**
   * The thing that would have to be removed, named the way the system names
   * it.
   *
   * Reported rather than derived by the caller, because on Linux it depends on
   * the machine and not on the platform: a session with systemd gets a user
   * unit, one without gets an XDG desktop entry, and `vt uninstall` prints a
   * manifest of what it touched. Guessing "systemd" on a box that has none
   * would be the manifest naming something that was never there.
   */
  where: string;
  /**
   * Will it actually start at the next login?
   *
   * Separate from `installed` because systemd separates them: writing the unit
   * file and enabling it are two steps, and a unit that exists but was never
   * enabled starts nothing. Undefined means the question does not apply — a
   * LaunchAgent, a Scheduled Task and an XDG entry are live the moment they
   * exist.
   */
  active?: boolean;
}

export function launchAgentPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
}

export function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${SYSTEMD_UNIT}.service`);
}

/** Escape for an XML text node — a path can contain `&`. */
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The LaunchAgent.
 *
 * `KeepAlive` is a dictionary rather than `true` on purpose. Plain `true`
 * restarts the daemon after *any* exit, including the clean one from
 * `vt daemon stop` — so stopping it would be impossible without also
 * unloading the agent. `SuccessfulExit: false` means "restart only when it
 * failed", which is what the watchdog's `exit(1)` produces and what a
 * deliberate stop does not.
 *
 * `ProcessType: Background` asks the scheduler to treat this as what it is.
 * Without it macOS applies interactive-application timer coalescing rules to a
 * process that polls every three seconds, which is the wrong bargain in both
 * directions.
 */
export function plist(node: string, entry: string): string {
  const log = join(dataDir(), 'daemon.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(entry)}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>${THROTTLE_SEC}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/**
 * Quote a path for a systemd command line, and for an XDG `Exec=`.
 *
 * Both split on whitespace and both understand double quotes, and neither is
 * a shell — so this is quoting, not escaping-for-a-shell, and the only two
 * characters that need a backslash inside the quotes are the backslash and
 * the quote itself.
 *
 * Not hypothetical on macOS or Linux: `nvm` installs Node under a versioned
 * directory, a checkout can live under a directory with a space in it, and
 * `ExecStart=/home/a b/node /home/a b/vt daemon` is read as four arguments and
 * an executable that does not exist. The unit installs, `systemctl` reports it
 * enabled, and it never starts.
 */
export function quotePath(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The systemd user unit.
 *
 * Two lines here are load-bearing and neither is boilerplate.
 *
 * **`ProtectHome=read-only` plus `ReadWritePaths`.** This is the only platform
 * where "VibeTracker never writes to your projects and never writes to an
 * agent's state directory" stops being a promise in a README and becomes a
 * kernel-enforced fact. The daemon can read all of `$HOME` and can write to
 * exactly two directories, both its own. A bug cannot violate it; neither can a
 * fork that quietly removes the check. The paths are computed at install time
 * from the same functions the daemon uses, so an unusual `XDG_DATA_HOME` cannot
 * leave it unable to write its own database.
 *
 * **`MemoryDenyWriteExecute` is deliberately absent.** It is the first line
 * people add when hardening a unit, and it silently breaks V8's JIT — the
 * daemon would start, run slowly or crash, and nothing would say why.
 */
export function unit(node: string, entry: string): string {
  const data = dataDir();
  const config = configDir();
  return `[Unit]
Description=VibeTracker izleme daemon'ı
Documentation=https://github.com/vibetracker/vibetracker
After=default.target

[Service]
Type=simple
ExecStart=${quotePath(node)} ${quotePath(entry)} daemon
Restart=on-failure
RestartSec=${THROTTLE_SEC}
# Read anything in the home directory; write only our own two directories.
# This is the guarantee, not a hardening flourish.
ProtectHome=read-only
ReadWritePaths=${quotePath(data)} ${quotePath(config)}
NoNewPrivileges=yes
# MemoryDenyWriteExecute is NOT set: it breaks V8's JIT silently.

[Install]
WantedBy=default.target
`;
}

// ── macOS ─────────────────────────────────────────────────────────────────

function gui(): string {
  return `gui/${userInfo().uid}`;
}

function agentWhere(): string {
  return t`LaunchAgent: ${LAUNCH_LABEL}`;
}

async function darwinStatus(entry: string): Promise<UnixAutostart> {
  const path = launchAgentPath();
  if (!existsSync(path)) {
    return { supported: true, installed: false, detail: tr('kurulu değil'), where: agentWhere() };
  }
  let body = '';
  try {
    body = await readFile(path, 'utf8');
  } catch {
    /* unreadable: treated as pointing somewhere else */
  }
  // A moved or reinstalled checkout leaves an agent pointing at a path that no
  // longer exists. Reporting that as "installed" is the worst answer available.
  const stale = !body.includes(xml(entry));
  return {
    supported: true,
    installed: true,
    stale,
    where: agentWhere(),
    detail: stale
      ? t`LaunchAgent "${LAUNCH_LABEL}" var ama başka bir kuruluma işaret ediyor`
      : t`LaunchAgent "${LAUNCH_LABEL}" kurulu · girişte başlar, çökerse ${THROTTLE_SEC} sn sonra döner`,
  };
}

async function darwinInstall(node: string, entry: string): Promise<number> {
  const path = launchAgentPath();
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(dataDir(), { recursive: true });
  await writeFile(path, plist(node, entry), 'utf8');

  // Replacing an existing agent: bootout first, and ignore its failure — "not
  // loaded" is the normal case on a first install and is not an error.
  await exec('launchctl', ['bootout', `${gui()}/${LAUNCH_LABEL}`], { timeout: 10_000 }).catch(
    () => {},
  );
  try {
    await exec('launchctl', ['bootstrap', gui(), path], { timeout: 15_000 });
  } catch (err) {
    // `bootstrap` is the modern verb and the only one Apple documents now, but
    // it did not exist before 10.11 and some managed images restrict it.
    try {
      await exec('launchctl', ['load', '-w', path], { timeout: 15_000 });
    } catch {
      const e = err as { stderr?: string; stdout?: string; message: string };
      process.stderr.write(t`LaunchAgent yüklenemedi.\n${(e.stderr || e.stdout || e.message).trim()}\n`);
      process.stderr.write(t`Dosya yazıldı: ${path}\nElle: launchctl bootstrap ${gui()} ${path}\n`);
      return 4;
    }
  }
  process.stdout.write(t`Otomatik başlatma kuruldu: ${path}\n`);
  process.stdout.write(t`  girişte başlar · yalnızca hata ile çıkarsa yeniden başlatılır\n`);
  process.stdout.write(t`  yönetici hakkı istemez (LaunchDaemon değil, LaunchAgent)\n`);
  process.stdout.write(t`  günlük: ${join(dataDir(), 'daemon.log')}\n`);
  process.stdout.write(tr('Kaldırmak için: vt autostart uninstall\n'));
  return 0;
}

async function darwinUninstall(): Promise<number> {
  const path = launchAgentPath();
  if (!existsSync(path)) {
    process.stderr.write(t`LaunchAgent "${LAUNCH_LABEL}" bulunamadı.\n`);
    return 3;
  }
  await exec('launchctl', ['bootout', `${gui()}/${LAUNCH_LABEL}`], { timeout: 15_000 }).catch(
    async () => {
      await exec('launchctl', ['unload', '-w', path], { timeout: 15_000 }).catch(() => {});
    },
  );
  await unlink(path).catch(() => {});
  process.stdout.write(t`Otomatik başlatma kaldırıldı: ${path}\n`);
  return 0;
}

// ── Linux ─────────────────────────────────────────────────────────────────

async function hasSystemd(): Promise<boolean> {
  try {
    await exec('systemctl', ['--user', '--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** XDG autostart, for a session with no systemd at all. */
export function desktopEntry(node: string, entry: string): string {
  return `[Desktop Entry]
Type=Application
Name=VibeTracker
Comment=VibeTracker izleme daemon'ı
Exec=${quotePath(node)} ${quotePath(entry)} daemon
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function desktopEntryPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'autostart', 'vibetracker.desktop');
}

async function linuxStatus(entry: string): Promise<UnixAutostart> {
  const path = systemdUnitPath();
  if (existsSync(path)) {
    let body = '';
    try {
      body = await readFile(path, 'utf8');
    } catch {
      /* unreadable */
    }
    // Compared in the quoted form the file actually holds, the way the macOS
    // branch compares against the XML-escaped form. Looking for the raw path
    // would report a correctly installed unit as stale on any path that
    // needed escaping.
    const stale = !body.includes(quotePath(entry));
    let enabled = false;
    try {
      const { stdout } = await exec('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT], {
        timeout: 5_000,
      });
      enabled = stdout.trim() === 'enabled';
    } catch {
      enabled = false;
    }
    return {
      supported: true,
      installed: true,
      stale,
      active: enabled,
      where: t`systemd --user: ${SYSTEMD_UNIT}.service`,
      detail: stale
        ? t`birim "${SYSTEMD_UNIT}" var ama başka bir kuruluma işaret ediyor`
        : enabled
          ? t`birim "${SYSTEMD_UNIT}" etkin · girişte başlar, çökerse ${THROTTLE_SEC} sn sonra döner`
          : t`birim "${SYSTEMD_UNIT}" yazılmış ama etkin değil — vt autostart install`,
    };
  }
  if (existsSync(desktopEntryPath())) {
    return {
      supported: true,
      installed: true,
      where: desktopEntryPath(),
      detail: t`XDG autostart girdisi kurulu (systemd yok) · ${desktopEntryPath()}`,
    };
  }
  const systemd = await hasSystemd();
  return {
    supported: true,
    installed: false,
    where: systemd ? t`systemd --user: ${SYSTEMD_UNIT}.service` : desktopEntryPath(),
    detail: systemd
      ? tr('kurulu değil')
      : tr('kurulu değil · systemd yok, XDG autostart kullanılacak'),
  };
}

/**
 * Is the session lingering?
 *
 * Without it a `--user` unit stops when the last session for that user closes,
 * which on a desktop means the daemon dies at logout and comes back at login —
 * survivable — and on a headless box means it dies and stays dead. Enabling it
 * usually needs polkit authentication, so it is *reported* rather than
 * attempted: a tool that pops an authentication dialog during an install the
 * user did not ask to be privileged is a tool people uninstall.
 */
async function lingerEnabled(): Promise<boolean> {
  try {
    const { stdout } = await exec('loginctl', ['show-user', userInfo().username, '-p', 'Linger'], {
      timeout: 5_000,
    });
    return stdout.trim().endsWith('=yes');
  } catch {
    return false;
  }
}

async function linuxInstall(node: string, entry: string): Promise<number> {
  await mkdir(dataDir(), { recursive: true });
  await mkdir(configDir(), { recursive: true });

  if (!(await hasSystemd())) {
    const path = desktopEntryPath();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, desktopEntry(node, entry), 'utf8');
    process.stdout.write(t`systemd bulunamadı; XDG autostart girdisi yazıldı: ${path}\n`);
    process.stdout.write(
      tr('  Bu girdi oturum açılışında başlatır ama çöken bir daemon\'ı geri getirmez.\n'),
    );
    return 0;
  }

  const path = systemdUnitPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, unit(node, entry), 'utf8');
  try {
    await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 });
    await exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { timeout: 20_000 });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    process.stderr.write(t`Birim etkinleştirilemedi.\n${(e.stderr || e.stdout || e.message).trim()}\n`);
    process.stderr.write(t`Dosya yazıldı: ${path}\nElle: systemctl --user enable --now ${SYSTEMD_UNIT}\n`);
    return 4;
  }

  process.stdout.write(t`Otomatik başlatma kuruldu: ${path}\n`);
  process.stdout.write(t`  girişte başlar · yalnızca hata ile çıkarsa ${THROTTLE_SEC} sn sonra döner\n`);
  process.stdout.write(
    t`  ProtectHome=read-only · yazma izni yalnızca ${dataDir()} ve ${configDir()}\n`,
  );
  process.stdout.write(tr('  günlük: journalctl --user -u vibetracker -f\n'));

  if (!(await lingerEnabled())) {
    // Reported, not done: enabling it usually needs a polkit prompt.
    process.stdout.write(
      tr('\nNot: oturum "linger" kapalı. Böyle bir kurulumda daemon oturumu kapatınca durur\n') +
        tr('ve bir sonraki girişte döner. Sürekli çalışmasını istiyorsan:\n') +
        t`  loginctl enable-linger ${userInfo().username}\n`,
    );
  }
  process.stdout.write(tr('Kaldırmak için: vt autostart uninstall\n'));
  return 0;
}

async function linuxUninstall(): Promise<number> {
  let removed = false;
  const path = systemdUnitPath();
  if (existsSync(path)) {
    await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], {
      timeout: 20_000,
    }).catch(() => {});
    await unlink(path).catch(() => {});
    await exec('systemctl', ['--user', 'daemon-reload'], { timeout: 15_000 }).catch(() => {});
    process.stdout.write(t`Otomatik başlatma kaldırıldı: ${path}\n`);
    removed = true;
  }
  const desktop = desktopEntryPath();
  if (existsSync(desktop)) {
    await unlink(desktop).catch(() => {});
    process.stdout.write(t`XDG autostart girdisi kaldırıldı: ${desktop}\n`);
    removed = true;
  }
  if (!removed) {
    process.stderr.write(tr('Kurulu bir otomatik başlatma bulunamadı.\n'));
    return 3;
  }
  return 0;
}

// ── the three verbs ───────────────────────────────────────────────────────

export async function unixAutostartStatus(entry: string): Promise<UnixAutostart> {
  if (process.platform === 'darwin') return darwinStatus(entry);
  if (process.platform === 'linux') return linuxStatus(entry);
  return {
    supported: false,
    installed: false,
    where: '—',
    detail: tr('bu platformda desteklenmiyor'),
  };
}

export async function unixAutostartInstall(node: string, entry: string): Promise<number> {
  if (process.platform === 'darwin') return darwinInstall(node, entry);
  if (process.platform === 'linux') return linuxInstall(node, entry);
  process.stderr.write(tr('Bu platformda otomatik başlatma yok. `vt daemon` komutunu elle çalıştır.\n'));
  return 2;
}

export async function unixAutostartUninstall(): Promise<number> {
  if (process.platform === 'darwin') return darwinUninstall();
  if (process.platform === 'linux') return linuxUninstall();
  return 2;
}
