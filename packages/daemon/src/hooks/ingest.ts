import {
  SessionState,
  type HookPayload,
  type SessionStateName,
  type SessionView,
} from '@vibetracker/shared';
import { redactSnippet } from '@vibetracker/core';

/**
 * Turning hook events into session state.
 *
 * This is the layer that makes `WAITING_PERMISSION` a fact instead of a guess.
 * The passive engine infers it from "a tool has been open too long with no new
 * child process"; `PermissionRequest` simply says so.
 *
 * Two design rules:
 *
 * 1. **Nothing from a payload is stored except names and enums.** `tool_input`
 *    and `tool_response` carry file contents, prompts and credentials — the
 *    measured reality is 5 private-key markers and 2 JWTs in the last megabyte
 *    of 25 transcripts. We read `tool_name` and drop the rest on the floor.
 * 2. **Hooks say when a wait *starts*; the transcript says when it ends.**
 *    There is no "permission granted" event. Rather than bind PostToolUse — the
 *    highest-volume event there is, carrying full tool output — the pending
 *    permission is cleared when the passive layer stops seeing that tool open.
 *    Exact where it matters, free everywhere else.
 */

/** How long a hook-derived state outranks inference before we stop trusting it. */
const HOOK_FRESH_MS = 30 * 60_000;

/**
 * Grace before the transcript is allowed to overrule a permission request.
 *
 * Hooks arrive *ahead* of the transcript — the agent POSTs immediately and
 * flushes JSONL on message completion — and our own tail read then lags by up
 * to a poll interval. Without this window the sequence is:
 * `PermissionRequest` arrives, the next scan sees no matching open tool yet,
 * and we clear a wait that had just started. The bug is invisible in tests
 * that feed both layers at once and obvious the moment it runs live.
 *
 * Two poll cycles plus flush lag.
 */
const PERMISSION_CORROBORATION_MS = 10_000;

export interface SessionHookState {
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  permissionMode?: string;
  lastEventAt: number;
  /** State asserted by hooks, if any. */
  state?: SessionStateName;
  subReason?: string;
  /** When that state began, per the hook clock. */
  since?: number;
  /** Tool we are blocked on approving, cleared by the transcript or a newer event. */
  pendingTool?: string;
  activeSubagents: Set<string>;
  compacting: boolean;
  lastError?: string;
  ended?: string;
  /** Human-facing reason strings, already free of payload text. */
  evidence: string[];
}

export interface IngestStats {
  parsed: number;
  unparsable: number;
  ignored: number;
  bySession: number;
  events: Map<string, number>;
  lastAt: number | null;
}

export class HookIngest {
  #sessions = new Map<string, SessionHookState>();
  #stats: IngestStats = {
    parsed: 0,
    unparsable: 0,
    ignored: 0,
    bySession: 0,
    events: new Map(),
    lastAt: null,
  };

  get stats(): IngestStats {
    this.#stats.bySession = this.#sessions.size;
    return this.#stats;
  }

  /** Feed a batch drained from the ring. `now` is injected for tests. */
  apply(raws: string[], now = Date.now()): void {
    for (const raw of raws) {
      let p: HookPayload;
      try {
        p = JSON.parse(raw) as HookPayload;
      } catch {
        this.#stats.unparsable++;
        continue;
      }
      this.#stats.parsed++;
      const event = p.hook_event_name;
      const sid = p.session_id;
      if (!event || !sid) {
        this.#stats.ignored++;
        continue;
      }
      this.#stats.events.set(event, (this.#stats.events.get(event) ?? 0) + 1);
      this.#stats.lastAt = now;
      this.#handle(this.#for(sid, now), event, p, now);
    }
  }

  #for(sessionId: string, now: number): SessionHookState {
    let s = this.#sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        lastEventAt: now,
        activeSubagents: new Set(),
        compacting: false,
        evidence: [],
      };
      this.#sessions.set(sessionId, s);
    }
    s.lastEventAt = now;
    return s;
  }

  #set(s: SessionHookState, state: SessionStateName, subReason: string, why: string, now: number): void {
    if (s.state !== state) s.since = now;
    s.state = state;
    s.subReason = subReason;
    s.evidence = [why];
  }

  #handle(s: SessionHookState, event: string, p: HookPayload, now: number): void {
    if (p.cwd) s.cwd = p.cwd;
    if (p.transcript_path) s.transcriptPath = p.transcript_path;
    if (p.permission_mode) s.permissionMode = p.permission_mode;

    // Subagent events carry the *subagent's* identity; they must not be read as
    // the main session changing state.
    if (event === 'SubagentStart') {
      if (p.agent_id) s.activeSubagents.add(p.agent_id);
      return;
    }
    if (event === 'SubagentStop') {
      if (p.agent_id) s.activeSubagents.delete(p.agent_id);
      return;
    }
    if (p.agent_id && event !== 'SessionStart' && event !== 'SessionEnd') {
      // Any other event tagged with an agent_id belongs to a sidechain.
      return;
    }

    switch (event) {
      case 'PermissionRequest':
        s.pendingTool = safeField(p.tool_name, 'bilinmeyen araç');
        this.#set(
          s,
          SessionState.WaitingPermission,
          `tool:${s.pendingTool}`,
          `hook:izin istendi (${s.pendingTool})`,
          now,
        );
        return;

      case 'PermissionDenied':
        s.pendingTool = undefined;
        this.#set(s, SessionState.Busy, 'denied', `hook:izin reddedildi (${safeField(p.tool_name, '?')})`, now);
        return;

      case 'Notification': {
        const kind = safeField(p.notification_type, '');
        if (/permission/i.test(kind)) {
          this.#set(
            s,
            SessionState.WaitingPermission,
            'notification',
            'hook:izin bildirimi',
            now,
          );
        } else if (/idle/i.test(kind)) {
          this.#set(s, SessionState.WaitingInput, 'idle_prompt', 'hook:idle notification', now);
        }
        // Any other notification kind is informational; state is left alone.
        return;
      }

      case 'UserPromptSubmit':
        s.pendingTool = undefined;
        this.#set(s, SessionState.Busy, 'prompt', 'hook:istem gönderildi', now);
        return;

      case 'PreToolUse':
        // Only bound under --high-fidelity.
        s.pendingTool = undefined;
        const started = safeField(p.tool_name, '?');
        this.#set(s, SessionState.Busy, `tool:${started}`, `hook:tool started (${started})`, now);
        return;

      case 'PostToolUse':
        // Compared in the same form it was stored in, or a name that needed
        // redacting would never match the one waiting and the pending tool
        // would stay pending forever.
        if (p.tool_name && s.pendingTool === safeField(p.tool_name, '')) s.pendingTool = undefined;
        if (s.state === SessionState.WaitingPermission) {
          this.#set(s, SessionState.Busy, 'thinking', 'hook:tool finished, permission had been granted', now);
        }
        return;

      case 'PostToolUseFailure':
        s.lastError = p.error ? truncateReason(p.error) : safeField(p.tool_name, 'tool error');
        // Compared in the same form it was stored in, or a name that needed
        // redacting would never match the one waiting and the pending tool
        // would stay pending forever.
        if (p.tool_name && s.pendingTool === safeField(p.tool_name, '')) s.pendingTool = undefined;
        // A single tool failure is normal; the agent usually recovers. Only
        // record it, never flip the session into ERRORED on its own.
        return;

      case 'Stop':
        s.pendingTool = undefined;
        this.#set(s, SessionState.WaitingInput, 'turn_complete', 'hook:tur bitti', now);
        return;

      case 'StopFailure':
        s.pendingTool = undefined;
        s.lastError = p.error ? truncateReason(p.error) : 'turn failed';
        this.#set(s, SessionState.Errored, 'stop_failure', `hook:tur hatayla bitti`, now);
        return;

      case 'PreCompact':
        s.compacting = true;
        this.#set(s, SessionState.Busy, 'compacting', 'hook:compaction started', now);
        return;

      case 'PostCompact':
        s.compacting = false;
        if (s.subReason === 'compacting') {
          this.#set(s, SessionState.Busy, 'thinking', 'hook:compaction finished', now);
        }
        return;

      case 'SessionStart':
        s.ended = undefined;
        this.#set(s, SessionState.Starting, safeField(p.source, 'start'), 'hook:session started', now);
        return;

      case 'SessionEnd':
        s.ended = safeField(p.reason, 'end');
        this.#set(s, SessionState.Ended, s.ended, `hook:oturum bitti (${s.ended})`, now);
        return;

      default:
        this.#stats.ignored++;
        return;
    }
  }

  /**
   * Overlay hook knowledge onto a scanned session.
   *
   * Returns true when hook facts changed the view. Called after the passive
   * scan so the two layers can disagree visibly rather than silently.
   */
  overlay(view: SessionView, now = Date.now()): boolean {
    const s = this.#sessions.get(view.sessionId);
    if (!s) return false;

    view.hooked = true;
    if (s.activeSubagents.size > 0) view.subagents = s.activeSubagents.size;

    // A session whose process is gone is orphaned no matter what the last hook
    // said; liveness is measured, not reported.
    if (view.liveness !== 'live') return true;

    // Stale hook state means the daemon was down, or hooks were removed. Fall
    // back to inference rather than showing a state from an hour ago.
    if (now - s.lastEventAt > HOOK_FRESH_MS || !s.state) return true;

    // The transcript is the authority on when a permission wait ends: once the
    // tool is no longer open, approval happened and the turn moved on. But only
    // after the transcript has had time to catch up — see the constant.
    if (s.state === SessionState.WaitingPermission && s.pendingTool) {
      const settled = now - (s.since ?? s.lastEventAt) > PERMISSION_CORROBORATION_MS;
      if (settled && !view.openTools.includes(s.pendingTool)) {
        s.pendingTool = undefined;
        s.state = undefined;
        s.evidence = [];
        return true;
      }
    }

    view.state = s.state;
    view.confidence = 0.95;
    view.evidence = [...s.evidence, ...view.evidence];
    if (s.since) view.stateSince = s.since;
    if (s.lastError && s.state === SessionState.Errored) {
      view.evidence.push(`hook:${s.lastError}`);
    }
    return true;
  }

  /** Forget sessions we have not heard from in a long time. */
  prune(olderThanMs = 24 * 3600_000, now = Date.now()): number {
    let n = 0;
    for (const [id, s] of this.#sessions) {
      if (now - s.lastEventAt > olderThanMs) {
        this.#sessions.delete(id);
        n++;
      }
    }
    return n;
  }

  /** Test/diagnostic access. */
  get(sessionId: string): SessionHookState | undefined {
    return this.#sessions.get(sessionId);
  }
}

/**
 * Error text is agent output: it routinely contains the failing command, the
 * file it touched, and whatever the shell printed. A test caught this storing
 * an API key verbatim, which would then have travelled into the report, the
 * dashboard and any `--json` a user pasted into an issue. It goes through
 * redaction before it is kept anywhere.
 */
function truncateReason(text: string): string {
  return redactSnippet(text, 140);
}

/**
 * Any short field the agent handed us, made safe to keep.
 *
 * The rule for this product is that free text from an agent goes through
 * redaction at the single point where it enters, and error text was the only
 * field obeying it. But `tool_name` is a name the agent chose — an MCP tool is
 * named by whoever wrote the server — and `notification_type`, `source` and
 * `reason` are the same kind of thing. They are stored in `sub_reason`, drawn
 * on the board and written into evidence, so an odd one is a string from
 * somewhere else appearing on the dashboard unfiltered.
 *
 * Short, because these are identifiers rather than prose: a 48-character
 * "tool name" is already something other than a tool name.
 */
function safeField(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return redactSnippet(value, 48) || fallback;
}
