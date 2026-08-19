import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dataDir } from '@vibetracker/platform';
import { t, tr } from '@vibetracker/core';
import {
  unixAutostartInstall,
  unixAutostartStatus,
  unixAutostartUninstall,
} from './autostart-unix.ts';

const exec = promisify(execFile);

/**
 * Starting the daemon at logon.
 *
 * Windows here; macOS and Linux in `autostart-unix.ts`. What the three share is
 * one rule — **no administrator rights, ever** — and nothing else, which is why
 * they are not one function with platform branches.
 *
 * On Windows this is deliberately a *Scheduled Task* rather than a
 * Windows Service. A service runs in session 0 as a service account, so
 * `%USERPROFILE%` resolves to the service profile — and the entire tool is
 * built on reading the user's agent state directory. A service would therefore
 * look installed, start cleanly, and observe nothing. It would also require
 * administrator rights, which a per-user observer has no business asking for.
 *
 * Three things here were measured on Windows 11 rather than assumed:
 *
 * 1. Of the three logon types, only `InteractiveToken` registers without
 *    administrator rights. `S4U` — the usual trick for a windowless task — is
 *    rejected with "Access is denied", and `Password` needs a stored password.
 *    So the daemon runs in the user's own interactive session.
 * 2. Which means a plain `node.exe` action opens a console window at every
 *    logon (verified: window count 0 → 1). Launching through
 *    `powershell -WindowStyle Hidden -> Start-Process -WindowStyle Hidden`
 *    starts the same daemon with no window at all (verified: 0 → 0). No
 *    VBScript shim, which is being removed from Windows, and no native helper.
 * 3. That launcher exits as soon as it has spawned the daemon, so the task
 *    itself is never "running" and `RestartOnFailure` would never fire. The
 *    supervisor is therefore the trigger: it repeats every five minutes, and a
 *    run that finds the daemon already alive costs one short-lived process and
 *    exits. That also revives a daemon killed by anything at all — its own
 *    watchdog, a task manager, an OOM — not just by failures the scheduler
 *    happens to notice.
 */

export const TASK_NAME = 'VibeTracker';

/** How often the trigger re-checks that the daemon is alive. */
const REVIVE_MINUTES = 5;

export interface AutostartStatus {
  supported: boolean;
  installed: boolean;
  /** True when a task exists but points at a different install than this one. */
  stale?: boolean;
  detail: string;
  /**
   * What would have to be removed, named the way the system names it — a
   * Scheduled Task here, a LaunchAgent or a systemd unit or an XDG entry
   * elsewhere. `vt uninstall` prints it as part of a manifest of what was
   * touched, so it has to be the object that actually exists on this machine
   * rather than the one this platform usually uses.
   */
  where: string;
  /** False when the registration exists but would not start anything. */
  active?: boolean;
}

/** The Windows answer, in one place because two call sites print it. */
const TASK_WHERE = (): string => t`Zamanlanmış Görev: ${TASK_NAME}`;

/** Absolute path of the CLI entry point, whatever the install layout is. */
function cliEntry(): string {
  return fileURLToPath(new URL('./index.ts', import.meta.url));
}

export async function autostartStatus(): Promise<AutostartStatus> {
  if (process.platform !== 'win32') return unixAutostartStatus(cliEntry());

  let xml: string;
  try {
    const { stdout } = await exec('schtasks', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE'], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    xml = stdout;
  } catch {
    return { supported: true, installed: false, where: TASK_WHERE(), detail: tr('kurulu değil') };
  }

  // A moved or reinstalled checkout leaves a task pointing at a path that no
  // longer exists. Silently "installed" would be the worst answer here.
  // Compare against the escaped form: the entry path sits inside an XML
  // attribute, so a path containing `&` is stored as `&amp;`.
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)?.[1] ?? '';
  const stale = !args.includes(esc(cliEntry()));
  return {
    supported: true,
    installed: true,
    stale,
    where: TASK_WHERE(),
    detail: stale
      ? t`görev "${TASK_NAME}" var ama başka bir kuruluma işaret ediyor`
      : t`görev "${TASK_NAME}" kurulu · oturum açılışında (30 sn gecikmeli) + ${REVIVE_MINUTES} dk'da bir canlılık kontrolü`,
  };
}

export async function installAutostart(): Promise<number> {
  if (process.platform !== 'win32') {
    return unixAutostartInstall(process.execPath, cliEntry());
  }

  const node = process.execPath;
  const entry = cliEntry();
  const logDir = dataDir();
  const xml = taskXml(node, entry);

  // schtasks reads task XML as UTF-16; a UTF-8 file is rejected with an
  // unhelpful parse error.
  const tmp = join(tmpdir(), `vibetracker-task-${process.pid}.xml`);
  await writeFile(tmp, '﻿' + xml, 'utf16le');
  try {
    await exec('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', tmp, '/F'], { timeout: 15_000 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    process.stderr.write(t`Görev oluşturulamadı.\n${(e.stderr || e.stdout || e.message).trim()}\n`);
    process.stderr.write(
      tr('\nGörev, yönetici hakkı gerektirmeyen InteractiveToken tipiyle kaydediliyor. ') +
        tr('Reddedildiyse büyük olasılıkla bir grup ilkesi görev oluşturmayı kısıtlıyor; ') +
        tr('Görev Zamanlayıcı üzerinden elle oluşturabilirsin.\n'),
    );
    return 4;
  } finally {
    await unlink(tmp).catch(() => {});
  }

  process.stdout.write(t`Otomatik başlatma kuruldu: görev "${TASK_NAME}"\n`);
  process.stdout.write(t`  oturum açılışından 30 sn sonra başlar, pencere açmaz\n`);
  process.stdout.write(t`  ${REVIVE_MINUTES} dk'da bir canlılık kontrolü — ölmüşse yeniden başlatır\n`);
  process.stdout.write(t`  yönetici hakkı istemez · ${node} ${entry} daemon\n`);
  process.stdout.write(t`  günlük: ${join(logDir, 'daemon.log')}\n`);
  process.stdout.write(t`Kaldırmak için: vt autostart uninstall\n`);
  return 0;
}

export async function uninstallAutostart(): Promise<number> {
  if (process.platform !== 'win32') return unixAutostartUninstall();
  try {
    await exec('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { timeout: 10_000 });
    process.stdout.write(t`Otomatik başlatma kaldırıldı: görev "${TASK_NAME}"\n`);
    return 0;
  } catch {
    process.stderr.write(t`Görev "${TASK_NAME}" bulunamadı.\n`);
    return 3;
  }
}

export async function showAutostart(): Promise<number> {
  const st = await autostartStatus();
  process.stdout.write(`${st.detail}\n`);
  if (st.stale) process.stdout.write(tr('`vt autostart install` ile tazele.\n'));
  return 0;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The hidden launcher.
 *
 * Single quotes throughout because the whole thing is one XML attribute value
 * inside a double-quoted PowerShell `-Command`. A path containing a single
 * quote would break it, so those are doubled — PowerShell's own escape.
 */
function hiddenLauncherArgs(node: string, entry: string): string {
  const q = (s: string): string => s.replace(/'/g, "''");
  return (
    `-NoProfile -NonInteractive -WindowStyle Hidden -Command ` +
    `"Start-Process -FilePath '${q(node)}' ` +
    `-ArgumentList '\`"${q(entry)}\`"','daemon' -WindowStyle Hidden"`
  );
}

/** Exported so the registration can be validated without claiming the real name. */
export function taskXml(node: string, entry: string): string {
  const user = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : (process.env.USERNAME ?? '');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>VibeTracker</Author>
    <Description>VibeTracker izleme daemon'ı. Yalnızca yerel dosyaları okur, ağa çıkmaz. Yönetici hakkı istemez.</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(user)}</UserId>
      <Delay>PT30S</Delay>
      <Repetition>
        <Interval>PT${REVIVE_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${esc(hiddenLauncherArgs(node, entry))}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}
