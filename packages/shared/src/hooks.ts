/**
 * The hook contract.
 *
 * Every name and field here was read out of the installed Claude Code binary
 * (v2.1.206) rather than assumed, and the event list was confirmed against
 * `claude doctor`, which prints the valid set when it rejects an unknown one.
 * That matters: an event name we invent is silently ignored, so the dashboard
 * would look installed and see nothing.
 *
 * When this drifts — and it will, the shapes are undocumented — the failure is
 * meant to be loud: `vt doctor` compares what we bound against what the agent
 * accepts.
 */

/** Every event this Claude Code version recognizes, in its own order. */
export const KNOWN_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'MessageDisplay',
] as const;

export type HookEvent = (typeof KNOWN_HOOK_EVENTS)[number];

/**
 * What we bind by default.
 *
 * `PermissionRequest` is the whole reason hooks exist for this tool: it is the
 * only way to know an agent is blocked on approval rather than merely slow.
 *
 * Two omissions are deliberate:
 *
 * - `PreToolUse`/`PostToolUse` fire on every single tool call and `PostToolUse`
 *   carries the full tool response, which can be megabytes. The tool timeline
 *   is already readable from the transcript, so the volume buys nothing.
 *   `--high-fidelity` turns them on for people who want exact tool boundaries.
 * - `MessageDisplay` fires continuously during streaming. Binding it would put
 *   an HTTP round trip in the middle of the agent's render loop.
 */
export const DEFAULT_HOOK_EVENTS: readonly HookEvent[] = [
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
];

export const HIGH_FIDELITY_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse'];

/**
 * Fields shared by every hook payload, built by the agent's own base builder.
 * Everything else is event-specific and read defensively.
 */
export interface HookBase {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  hook_event_name?: string;
}

export interface HookPayload extends HookBase {
  tool_name?: string;
  tool_use_id?: string;
  reason?: string;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  message?: string;
  title?: string;
  notification_type?: string;
  source?: string;
  trigger?: string;
  stop_hook_active?: boolean;
  /** Deliberately never read: tool_input and tool_response carry user secrets. */
}

/** The path hooks POST to. Versioned so an upgrade never orphans them. */
export const HOOK_PATH = '/h/v1';
export const HOOK_TOKEN_HEADER = 'X-VT-Token';

/** Marks entries as ours, so uninstall can never remove someone else's hook. */
export const VT_MARKER = '_vt';

export interface HookHealth {
  /** Events we have actually received at least once. */
  seen: string[];
  received: number;
  dropped: number;
  /** Events we asked for but have never seen fire. */
  silent: string[];
  lastAt: number | null;
}
