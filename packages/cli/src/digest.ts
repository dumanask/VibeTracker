/**
 * `vt digest` — the one command that can send anything anywhere.
 *
 * Everything else in this product reads. This writes to a network, and to
 * somebody else's machine, so it is built to be refused: it is off by default,
 * it is never called by the daemon, it shows the exact bytes before it sends
 * them, and the confirmation is a separate keystroke from the command.
 *
 * The other half of what it is for is the answer to "which model, though". The
 * summary is one paragraph of judgement, and requiring a particular vendor for
 * it would exclude most of the people the tool is for. So the provider is a
 * choice: one answer is a model on your own machine, one is a wire format
 * rather than a company, and three are "the agent CLI you already have" —
 * `claude`, `codex`, or a command you name yourself. See `provider.ts`.
 *
 * What it does **not** do: compute the percentage. That is counted locally out
 * of things that can be counted, and refused when they cannot. A model is
 * asked for a phase name, a blocker, a next action and an arbitration, and its
 * answer is validated into a closed schema before anything renders it.
 */
import {
  DEFAULT_BASE,
  DEFAULT_KEY_ENV,
  DEFAULT_MODEL,
  ProviderError,
  ScanContext,
  buildPayload,
  clearKeyFile,
  cliCommandLine,
  cliProgram,
  egress,
  isCliProvider,
  isLocal,
  keyFilePath,
  leavesMachine,
  maskKey,
  needsKey,
  readProjectProgress,
  resolveKey,
  runDigest,
  scan,
  writeKeyFile,
  type DigestInput,
  type ProviderConfig,
  type ProviderId,
} from '@vibetracker/engine';
import { readGitFacts, readRecentCommits, loadConfig, whichCommand } from '@vibetracker/platform';
import { getLang, say, t, tr } from '@vibetracker/core';
import { confirm, isInteractive } from './prompt.ts';
import type { ProjectView } from '@vibetracker/shared';

const COLOR = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const dim = wrap('2');
const bold = wrap('1');
const red = wrap('31');
const green = wrap('32');
const yellow = wrap('33');

export interface DigestArgs {
  sub?: string;
  operands: string[];
  json: boolean;
  yes: boolean;
  dryRun: boolean;
}

/** How much of each list travels with the payload. */
const MAX_COMMITS = 20;
const MAX_TITLES = 12;
const MAX_REMAINING = 15;

function providerConfig(cfg: Awaited<ReturnType<typeof loadConfig>>['config']): ProviderConfig {
  const d = cfg.digest;
  const key = resolveKey(d.provider, d.api_key_env);
  return {
    provider: d.provider,
    model: d.model,
    baseUrl: d.base_url,
    apiKey: key.key,
    command: d.command,
    args: d.args,
  };
}

/** The address a provider would use, or empty for the ones that have none. */
function baseFor(d: { provider: ProviderId; base_url: string }): string {
  if (d.provider === 'off' || isCliProvider(d.provider)) return '';
  return d.base_url || DEFAULT_BASE[d.provider];
}

/**
 * The egress line, in the three words that matter.
 *
 * `cli` runs a program this codebase did not write, so the honest answer is
 * that it does not know. Saying so is better than a green line that might be
 * a lie — the user chose that command and is the only one who can answer.
 */
function egressLine(p: ProviderConfig): string {
  switch (egress(p)) {
    case 'no':
      return green(tr('veri bu makineden çıkmaz'));
    case 'yes':
      return yellow(tr('veri bu makineden ÇIKAR'));
    default:
      return yellow(tr('veri çıkar mı — bilinmiyor: bu komutu sen seçtin'));
  }
}

/**
 * What is configured, whether it can work, and what else there is.
 *
 * The point of the last column is that a person who reads this should not have
 * to go looking for the list. "Not everyone has Claude" is only fixed if the
 * alternatives are visible from inside the tool.
 */
async function showProviders(json: boolean): Promise<number> {
  const { config } = await loadConfig();
  const d = config.digest;
  const p = providerConfig(config);
  const key = resolveKey(d.provider, d.api_key_env);
  const base = baseFor(d);
  const model = d.model || DEFAULT_MODEL[d.provider];
  const wantsKey = d.provider !== 'off' && needsKey(d.provider, d.base_url);
  // A CLI provider is only ready if the program is there. This is the failure
  // that would otherwise surface as a stack trace at the end of a minute of
  // waiting, on the one command that costs the user something.
  const exe = cliProgram(d);
  const exePath = exe ? whichCommand(exe) : null;
  const ready =
    d.provider === 'off'
      ? false
      : isCliProvider(d.provider)
        ? exe !== '' && exePath !== null
        : !wantsKey || key.key !== null;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          provider: d.provider,
          model,
          baseUrl: base,
          command: exe || null,
          commandPath: exePath,
          needsKey: wantsKey,
          keyFrom: key.from,
          keyEnv: key.envName ?? null,
          ready,
          egress: egress(p),
          leavesMachine: leavesMachine(p),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const out: string[] = [''];
  out.push(bold(tr('  Şu an yapılandırılmış')));
  out.push(`    ${tr('sağlayıcı')}   ${d.provider}`);
  if (d.provider !== 'off') {
    if (model) out.push(`    ${tr('model')}       ${model}`);
    if (base) out.push(`    ${tr('adres')}       ${base}`);
    if (isCliProvider(d.provider)) {
      out.push(`    ${tr('komut')}       ${cliCommandLine(p) || red(tr('yazılmamış'))}`);
      out.push(
        exePath === null
          ? `    ${red(tr('bulunamadı'))}  ${exe ? t`"${exe}" PATH'te yok` : tr('[digest] command boş')}`
          : dim(`    ${tr('yeri')}        ${exePath}`),
      );
    }
    if (wantsKey) {
      out.push(
        key.key === null
          ? `    ${red(tr('anahtar'))}    ${red(tr('yok'))}`
          : `    ${tr('anahtar')}     ${maskKey(key.key)} · ${key.from === 'env' ? (key.envName ?? '') : keyFilePath()}`,
      );
    } else {
      out.push(dim(`    ${tr('anahtar')}     ${tr('gerekmiyor')}`));
    }
    out.push(`    ${egressLine(p)}`);
    out.push(ready ? `    ${green(tr('hazır'))}` : `    ${red(tr('eksik yapılandırma'))}`);
  } else {
    out.push(dim(tr('    Panodaki her sayı yerel motorla hesaplanıyor. Hiçbir şey gönderilmiyor.')));
  }

  // The last column is the point of this command. "Not everyone has Claude" is
  // only fixed if the alternatives are visible from inside the tool — and the
  // installed ones are marked, because the cheapest answer for most people is
  // a program they are already paying for and already have.
  const mark = (name: string): string =>
    whichCommand(name) ? green(` ← ${tr('kurulu')}`) : dim(` ${tr('(kurulu değil)')}`);
  out.push('');
  out.push(bold(tr('  Seçebileceklerin')));
  out.push(`    off         ${tr('kapalı — yapısal motor tek başına çalışır')}`);
  out.push(`    ollama      ${tr('makinendeki model; anahtar yok, veri çıkmaz')}${mark('ollama')}`);
  out.push(`    claude-cli  ${tr('makinendeki claude komutu; aboneliğinin kotasından yer')}${mark('claude')}`);
  out.push(`    codex-cli   ${tr('makinendeki codex komutu; Codex aboneliğinden yer')}${mark('codex')}`);
  out.push(`    opencode-cli ${tr('makinendeki opencode komutu; onun aboneliğinden yer')}${mark('opencode')}`);
  out.push(`    gemini-cli  ${tr('makinendeki gemini komutu; Google hesabından yer')}${mark('gemini')}`);
  out.push(`    cli         ${tr('başka herhangi bir komut — command + args ile')}`);
  out.push(`    openai      ${tr('OpenAI biçimi: OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, LM Studio, vLLM…')}`);
  out.push(`    anthropic   ${tr('Anthropic API')}`);
  out.push('');
  // Two ways, and the panel is named first because it is the one that does not
  // require knowing where a TOML file lives on this operating system.
  out.push(dim(tr('  Değiştirmek için: panodaki "LLM özeti" bölümü — ya da config dosyası: vt config path')));
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

/** `vt digest key` — the 0600 file, for when an environment variable is not practical. */
async function manageKey(operands: string[]): Promise<number> {
  const action = operands[0];
  if (action === 'clear') {
    const had = clearKeyFile();
    process.stdout.write(
      had ? t`Anahtar dosyası silindi: ${keyFilePath()}\n` : tr('Anahtar dosyası yoktu.\n'),
    );
    return 0;
  }
  const value = action === 'set' ? operands[1] : action;
  if (!value) {
    const { config } = await loadConfig();
    const key = resolveKey(config.digest.provider, config.digest.api_key_env);
    process.stdout.write(
      key.key === null
        ? t`Anahtar yok. Kullanım: vt digest key <anahtar>  ·  ya da ${key.envName ?? 'ortam değişkeni'} ayarla\n`
        : t`Anahtar var: ${maskKey(key.key)} · ${key.from === 'env' ? (key.envName ?? 'ortam') : keyFilePath()}\n`,
    );
    return key.key === null ? 3 : 0;
  }
  const path = writeKeyFile(value);
  process.stdout.write(t`Yazıldı (0600): ${path}\n`);
  process.stdout.write(
    tr('  Ortam değişkeni her zaman bu dosyadan önce gelir. Config dosyasına asla yazılmaz.\n'),
  );
  return 0;
}

function pickProject(projects: ProjectView[], filter?: string): ProjectView | null {
  if (!filter) {
    // The project you are standing in, when you are standing in one. Falls
    // back to the busiest, because a digest of nothing is not useful.
    const here = process.cwd().toLowerCase().replace(/\\/g, '/');
    const inCwd = projects.find((p) =>
      p.workspaces.some((w) => here.startsWith(w.normPath.toLowerCase())),
    );
    if (inCwd) return inCwd;
    return projects.find((p) => p.tracked) ?? projects[0] ?? null;
  }
  const f = filter.toLowerCase();
  return (
    projects.find((p) => p.projectId === filter) ??
    projects.find((p) => p.displayName.toLowerCase() === f) ??
    projects.find((p) => p.displayName.toLowerCase().includes(f)) ??
    null
  );
}

export async function runDigestCmd(args: DigestArgs): Promise<number> {
  if (args.sub === 'providers' || args.sub === 'list') return await showProviders(args.json);
  if (args.sub === 'key') return await manageKey(args.operands);

  const { config } = await loadConfig();
  const provider = providerConfig(config);

  // Building the payload is free and reveals nothing, so `--dry-run` works
  // even with the provider off. That is deliberate: the way to decide whether
  // to turn this on is to see exactly what turning it on would send.
  if (provider.provider === 'off' && !args.dryRun) {
    process.stderr.write(tr('LLM özeti kapalı.\n'));
    process.stderr.write(tr('  Ne göndereceğini görmek için: vt digest --dry-run\n'));
    process.stderr.write(tr('  Seçenekler için: vt digest providers\n'));
    return 3;
  }

  const filter = args.sub && args.sub !== 'run' ? args.sub : args.operands[0];

  const ctx = new ScanContext();
  let report;
  try {
    report = await scan(
      { cpuSample: false, cpuSampleMs: 0, includeDead: false, includeTemp: false, tailBytes: 64 * 1024 },
      ctx,
    );
  } finally {
    await ctx.close();
  }

  const project = pickProject(report.projects, filter);
  if (!project) {
    process.stderr.write(tr('Eşleşen proje yok.\n'));
    return 3;
  }
  const root = project.workspaces[0]?.normPath;
  if (!root) {
    process.stderr.write(tr('Projenin bir dizini bilinmiyor.\n'));
    return 3;
  }

  const git = await readGitFacts(root);
  const progress = await readProjectProgress(root, { git });
  // Subjects only, and only when this is a repository at all. A project
  // identified by package name or by path has no history to send.
  const commits = git ? await readRecentCommits(root, MAX_COMMITS) : [];
  const now = Date.now();

  // The "what is left" lines the parser already lifted out of the documents,
  // so nothing is opened twice and nothing is read that was not already read.
  const remainingLines: string[] = [];
  for (const s of progress.sources) {
    if (remainingLines.length >= MAX_REMAINING) break;
    if (s.remaining) remainingLines.push(s.remaining);
  }

  const input: DigestInput = {
    facts: {
      projectId: project.projectId,
      displayName: project.displayName,
      rootName: root.split('/').pop() ?? root,
      identityKind: project.identityKind,
      branch: git?.branch ?? null,
      headSubject: git?.headSubject ?? null,
      headAtMs: git?.headAtMs ?? null,
      dirtyCount: git?.dirtyCount ?? 0,
      dirtyIsBuildNoise: git?.dirtyIsBuildNoise ?? false,
      workspaceCount: project.workspaces.length,
      flags: project.flags,
      live: project.summary.live,
      waiting: project.summary.waiting,
    },
    plan: {
      phaseLabel: progress.phase?.labelRaw ?? null,
      phaseUnit: progress.phase?.unit ?? null,
      phaseOrdinal: progress.phase?.ordinal ?? null,
      phaseTotal: progress.phase?.total ?? null,
      phaseBasis: progress.phase?.basis ?? null,
      percent: progress.percent,
      percentBasis: progress.basis,
      approximate: progress.approximate,
      sourceCount: progress.sourceCount,
      planCount: progress.planCount,
      observedAt: progress.observedAt,
      documents: progress.sources.slice(0, 20).map((s) => ({
        relPath: s.relPath,
        role: s.role,
        items: s.itemCount,
        percent: s.percent,
        ageDays: Math.max(0, Math.round((now - s.mtimeMs) / 86_400_000)),
      })),
      remaining: remainingLines,
      openItems: [],
      drift: progress.drift.map((d) => ({
        code: d.code,
        severity: d.severity,
        text: `${say(d.claim)} — ${say(d.evidence)}`,
      })),
    },
    activity: {
      commits,
      titles: project.sessions
        .map((s) => s.title ?? '')
        .filter((x): x is string => Boolean(x))
        .slice(0, MAX_TITLES),
    },
    lang: getLang() === 'en' ? 'en' : 'tr',
    now,
  };

  const payload = buildPayload(input);

  // ── the preview ──────────────────────────────────────────────────────
  // Shown before anything is sent, always, and shown in full. A preview that
  // summarised the payload would be a second thing to trust.
  const head: string[] = [''];
  head.push(bold(`  ${project.displayName} · ${progress.phase?.labelRaw ?? tr('faz bilinmiyor')}`));
  head.push(`  ${tr('sağlayıcı')}  ${provider.provider}${provider.model ? ' · ' + provider.model : ''}`);
  if (provider.provider !== 'off') {
    const base = baseFor(config.digest);
    if (base) head.push(`  ${tr('adres')}      ${base}${isLocal(base) ? ' ' + tr('(bu makine)') : ''}`);
    // Named before it runs, always. This is the one provider family where what
    // happens next is a program of the user's choosing, and approving a send
    // without seeing the command would be approving half the decision.
    if (isCliProvider(provider.provider)) {
      head.push(`  ${tr('komut')}      ${cliCommandLine(provider)}`);
    }
  }
  head.push(t`  yük        ${payload.tokens} token · ${payload.system.length + payload.user.length} karakter`);
  if (payload.dropped.length) {
    head.push(yellow(`  ${tr('sığmadı')}    ${payload.dropped.join(', ')}`));
  }
  head.push(
    egress(provider) === 'no'
      ? green(tr('  Bu metin bu makineden çıkmayacak.'))
      : egress(provider) === 'yes'
        ? yellow(tr('  Bu metin bu makineden çıkacak.'))
        : yellow(tr('  Bu metin yukarıdaki komuta verilecek. Nereye gittiğini o komut bilir.')),
  );
  process.stdout.write(`${head.join('\n')}\n\n`);
  process.stdout.write(dim('─'.repeat(60)) + '\n');
  process.stdout.write(payload.system + '\n\n' + payload.user + '\n');
  process.stdout.write(dim('─'.repeat(60)) + '\n');

  if (args.dryRun || provider.provider === 'off') {
    process.stdout.write(tr('\nGönderilmedi (--dry-run).\n'));
    return 0;
  }

  if (needsKey(provider.provider, provider.baseUrl) && !provider.apiKey) {
    const env = config.digest.api_key_env || DEFAULT_KEY_ENV[provider.provider] || '';
    process.stderr.write(t`\nAnahtar yok. ${env} ayarla ya da: vt digest key <anahtar>\n`);
    return 3;
  }

  // Checked here rather than discovered inside `spawn`: the answer is the same
  // either way, but this one arrives before the confirmation prompt instead of
  // after it.
  if (isCliProvider(provider.provider)) {
    // The program, asked for directly. Splitting the display line off the
    // front of a preview worked while every preset's first word happened to be
    // its program, which is a coincidence rather than a rule.
    const exe = cliProgram(provider);
    if (!exe) {
      process.stderr.write(tr('\nÇalıştırılacak komut yazılmamış: [digest] command\n'));
      return 3;
    }
    if (!whichCommand(exe)) {
      process.stderr.write(t`\n"${exe}" bulunamadı — kurulu mu, PATH'te mi?\n`);
      process.stderr.write(tr('  Seçenekler için: vt digest providers\n'));
      return 3;
    }
  }

  // Two gates, not one. The config switch says "this feature may run"; this
  // says "send this". A non-interactive run without `--yes` sends nothing,
  // because a script that silently ships a project summary to a third party is
  // exactly the accident this whole design is arranged around.
  if (config.digest.preview_before_send && !args.yes) {
    if (!isInteractive()) {
      process.stderr.write(tr('\nOnay gerekiyor ve terminal yok. --yes ile çalıştır.\n'));
      return 3;
    }
    const ok = await confirm(tr('\nGönderilsin mi?'), false);
    if (!ok) {
      process.stdout.write(tr('Gönderilmedi.\n'));
      return 0;
    }
  }

  let result;
  try {
    result = await runDigest(provider, input, {
      onAttempt: (n) => {
        if (n > 1) process.stdout.write(dim(tr('  yanıt şemaya uymadı, bir kez daha soruluyor…\n')));
      },
    });
  } catch (e) {
    const err = e as ProviderError;
    process.stderr.write(red(t`\nÖzet alınamadı (${err.kind ?? 'error'}): ${err.message}\n`));
    if (err.kind === 'auth') {
      process.stderr.write(tr('  Anahtar reddedildi. vt digest providers\n'));
    }
    if (err.kind === 'network') {
      process.stderr.write(tr('  Adrese ulaşılamadı. vt digest providers\n'));
    }
    return 70;
  }

  // Kept, so the board can show it too.
  //
  // A summary that only ever existed in the scrollback of the terminal that
  // asked for it is half a feature: the question it answers -- what phase is
  // this project in -- is asked by looking at the dashboard, not by running a
  // command. Written from here rather than from the daemon because the daemon
  // does not go to a network and is not going to; it reads this table on its
  // next scan the same way it reads everything else.
  try {
    const { Store } = await import('@vibetracker/daemon');
    const store = new Store();
    try {
      store.saveDigest({
        projectId: project.projectId,
        createdAt: Date.now(),
        provider: provider.provider,
        model: result.model ?? provider.model ?? '',
        output: result.output,
      });
    } finally {
      store.close();
    }
  } catch (e) {
    // The summary is in hand and printing it is the point; failing to file it
    // is worth a line, not a failure.
    process.stderr.write(t`(veritabanına yazılamadı: ${(e as Error).message})\n`);
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ projectId: project.projectId, ...result.output, model: result.model, attempts: result.attempts }, null, 2)}\n`,
    );
    return 0;
  }

  const o = result.output;
  const out: string[] = [''];
  out.push(bold(`  ${o.phaseLabelRaw || tr('faz bilinmiyor')}`) + dim(`  ${o.phaseKind} · ${o.phaseStatus}`));
  if (o.percentEstimate !== null) {
    out.push(`  ${tr('ilerleme')}   ~%${o.percentEstimate} · ${o.percentBasis} · ${o.confidence}`);
  }
  out.push('');
  out.push(`  ${o.summary}`);
  if (o.nextAction) out.push('', `  ${bold(tr('sonraki'))}   ${o.nextAction}`);
  if (o.blocker) out.push(`  ${bold(tr('engel'))}     ${red(o.blocker)}`);
  if (o.stallReason) out.push(`  ${bold(tr('durgunluk'))} ${o.stallReason}`);
  for (const c of o.conflicts) out.push(yellow(`  ${tr('çelişki')}   ${c}`));
  for (const r of o.riskFlags) out.push(dim(`  ${tr('risk')}      ${r}`));
  out.push('');
  out.push(dim(tr('  kanıt')));
  for (const e of o.evidence) out.push(dim(`    ${e.kind}: ${e.ref}`));
  out.push('');
  out.push(
    dim(
      t`  ${result.model ?? provider.provider} · ${result.reply.inputTokens ?? '?'}→${result.reply.outputTokens ?? '?'} token · ${result.attempts} istek`,
    ),
  );
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
