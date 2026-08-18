/**
 * Which voices this machine can actually speak with.
 *
 * Read for one reason: the note says a project's name out loud, and whether
 * that sentence comes out in the interface language is not something the
 * product can decide — it depends on what the user has installed. So the
 * answer has to be reportable rather than assumed.
 *
 * There are two engines and they do not see the same voices.
 *
 * - `System.Speech` (SAPI5) reads `HKLM\SOFTWARE\Microsoft\Speech\Voices\Tokens`.
 * - The WinRT synthesiser also reads `…\Speech_OneCore\Voices\Tokens`, which is
 *   where *Settings → Time & language → Speech* writes everything it installs.
 *
 * Measured on the reference machine: SAPI5 sees two voices, WinRT sees three.
 * That gap is not cosmetic — it means the obvious way to add a language
 * produces a voice the older engine cannot use at all. Reporting both is how a
 * user finds out that the voice they installed is there and being used, rather
 * than guessing from an accent.
 *
 * Nothing here installs, downloads or changes a voice. Which voices exist is
 * the user's decision, made in Windows, and this only reads the answer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Voice {
  name: string;
  /** BCP-47 tag from WinRT (`tr-TR`) or the .NET culture name from SAPI5. */
  lang: string;
}

export interface VoiceReport {
  /** False when no engine could be reached at all, including off-Windows. */
  supported: boolean;
  /** The engine the note would use — the same preference order it applies. */
  engine: 'winrt' | 'sapi' | 'none';
  /** Voices of the chosen engine. */
  voices: Voice[];
  /** How many each engine sees, so a OneCore-only voice is visible as a gap. */
  winrtCount: number;
  sapiCount: number;
  /** The voice Windows itself would use, when an engine could name one. */
  defaultVoice?: string;
  error?: string;
}

/**
 * One PowerShell round-trip, both engines, JSON out.
 *
 * Written as a single script rather than two calls because starting PowerShell
 * costs far more than either query, and `vt doctor` runs this once.
 */
const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ winrt = @(); sapi = @(); engine = 'none'; def = '' }
try {
  $t = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
  $s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $out.winrt = @($t::AllVoices | ForEach-Object { @{ name = $_.DisplayName; lang = $_.Language } })
  if ($out.winrt.Count -gt 0) { $out.engine = 'winrt'; $out.def = [string]$s.Voice.DisplayName }
} catch { }
try {
  Add-Type -AssemblyName System.Speech
  $p = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $out.sapi = @($p.GetInstalledVoices() | Where-Object { $_.Enabled } |
    ForEach-Object { @{ name = $_.VoiceInfo.Name; lang = $_.VoiceInfo.Culture.Name } })
  if ($out.engine -eq 'none' -and $out.sapi.Count -gt 0) {
    $out.engine = 'sapi'; $out.def = [string]$p.Voice.Name
  }
} catch { }
[Console]::Out.Write((ConvertTo-Json $out -Depth 4 -Compress))
`;

const UNSUPPORTED: VoiceReport = {
  supported: false,
  engine: 'none',
  voices: [],
  winrtCount: 0,
  sapiCount: 0,
};

function asVoices(raw: unknown): Voice[] {
  if (!Array.isArray(raw)) return [];
  const out: Voice[] = [];
  for (const v of raw) {
    const o = v as { name?: unknown; lang?: unknown };
    if (typeof o.name === 'string' && o.name) {
      out.push({ name: o.name, lang: typeof o.lang === 'string' ? o.lang : '' });
    }
  }
  return out;
}

export async function listVoices(): Promise<VoiceReport> {
  if (process.platform !== 'win32') return UNSUPPORTED;
  let stdout: string;
  try {
    const r = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE],
      { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (err) {
    return { ...UNSUPPORTED, error: (err as Error).message };
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      winrt?: unknown;
      sapi?: unknown;
      engine?: unknown;
      def?: unknown;
    };
    const winrt = asVoices(parsed.winrt);
    const sapi = asVoices(parsed.sapi);
    const engine =
      parsed.engine === 'winrt' ? 'winrt' : parsed.engine === 'sapi' ? 'sapi' : 'none';
    return {
      supported: engine !== 'none',
      engine,
      voices: engine === 'winrt' ? winrt : engine === 'sapi' ? sapi : [],
      winrtCount: winrt.length,
      sapiCount: sapi.length,
      defaultVoice: typeof parsed.def === 'string' && parsed.def ? parsed.def : undefined,
    };
  } catch (err) {
    return { ...UNSUPPORTED, error: (err as Error).message };
  }
}

/**
 * Does anything installed speak `lang`?
 *
 * Two letters compared against the start of the tag, which is all the note
 * does too: `tr` has to match `tr-TR`, and nothing finer than the language
 * matters for deciding whether a sentence will be mangled.
 */
export function speaksLanguage(report: VoiceReport, lang: string): Voice | null {
  const want = lang.slice(0, 2).toLowerCase();
  if (!want) return null;
  for (const v of report.voices) {
    if (v.lang.slice(0, 2).toLowerCase() === want) return v;
  }
  return null;
}
