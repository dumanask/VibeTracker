export { deriveState, type DeriveInput, type DerivedState } from './derive.ts';
export { fmtAge, fmtPercent, sinceMs, truncate, FUTURE_TOLERANCE_MS } from './format.ts';
export {
  STALL_MS,
  STALL_MCP_MS,
  STALL_THINKING_MS,
  PASSIVE_MULTIPLIER,
  CPU_BUSY_PCT,
  CPU_IDLE_PCT,
  RECENT_WRITE_MS,
  LOCAL_TOOL_PERMISSION_MS,
  SPAWN_GRACE_MS,
  ALERT_REARM_MS,
  CONFIDENT,
  TREE_CACHE_MS,
  RETAIN_TRANSITIONS_MS,
  RETAIN_SESSIONS_MS,
  RETAIN_AGGRESSIVE_MS,
  DB_HARD_CAP_BYTES,
  MAINTENANCE_INTERVAL_MS,
  stallDeadline,
} from './thresholds.ts';
export {
  projectFlags,
  urgencyOf,
  attentionScore,
  labelWorkspaces,
  displayNameFor,
} from './project.ts';
export {
  redact,
  redactDetailed,
  redactSnippet,
  setCustomPatterns,
  entropy,
  type RedactResult,
} from './redact.ts';
export {
  parseWithPositions,
  hasComments,
  JsonParseError,
  member,
  child,
  applySplices,
  appendInto,
  removeElement,
  removeMember,
  detectIndent,
  indentOf,
  render,
  type JsonNode,
  type JsonMember,
  type Splice,
} from './jsonedit.ts';

// ── the one-line-per-project summary ────────────────────────────────────
export {
  summarizeAgents,
  summarizeBoard,
  compactRank,
  type AgentSummary,
  type AgentSummaryKind,
  type BoardLoad,
} from './summary.ts';

// ── which projects the user follows ─────────────────────────────────────
export {
  isTracked,
  matchProject,
  addTracked,
  removeTracked,
  trackAll,
  type TrackableProject,
  type MatchResult,
  type TrackingChange,
} from './tracking.ts';
export { setTomlValues, type TomlEditValue } from './tomledit.ts';

// ── progress / phase engine ─────────────────────────────────────────────
export { fold as foldText, foldWords, hasWord, hasStem } from './progress/fold.ts';
export {
  lexicon,
  lexiconFor,
  availableLanguages,
  type Lexicon,
  type FoldedLexicon,
  type StatusKind,
} from './progress/lexicon.ts';
export {
  defaultSymbols,
  learnLegend,
  statusOfWords,
  statusOfCell,
  isStruckOut,
  readPercentLiteral,
  readEffortWeight,
  ALL_SYMBOLS,
  type SymbolMap,
} from './progress/marks.ts';
export { classifyRole, isCountable, type DocRole, type RoleVerdict } from './progress/role.ts';
export { extractItems, type WorkItem, type ExtractResult } from './progress/extract.ts';
export {
  phaseTokens,
  readStatusLines,
  headingPhases,
  buildLadder,
  classifyPhaseKind,
  type PhaseRef,
  type PhaseKind,
  type Ladder,
  type StatusLine,
  type HeadingPhase,
} from './progress/phase.ts';
export {
  computePercent,
  coarsen,
  MIN_DENOMINATOR,
  type PercentResult,
  type PercentGateFailure,
} from './progress/percent.ts';
export { analyzeDocument, type DocumentReading } from './progress/document.ts';

// ── configuration ───────────────────────────────────────────────────────
export {
  parseToml,
  tomlValue,
  tomlKey,
  TomlError,
  type TomlTable,
  type TomlValue,
} from './toml.ts';
export {
  configuredRoots,
  defaultConfig,
  validateConfig,
  loadConfigText,
  formatIssues,
  CONFIG_VERSION,
  type Config,
  type ConfigIssue,
  type LoadedConfig,
  type ProjectConfig,
  type TrackingConfig,
  ENUMS,
} from './config.ts';

// ── i18n ────────────────────────────────────────────────────────────────
export {
  t,
  tr,
  setLang,
  getLang,
  catalogEntries,
  missingKeys,
  keyOf,
  resolveLang,
  SOURCE_LANG,
  type Lang,
} from './i18n.ts';
export { loadLang, localeDir, catalogFor, trInto } from './i18n-load.ts';
export { ph, say, isPhrase, agoPhrase, type Phrase } from './phrase.ts';
export { keysInSource, type FoundKey } from './i18n-scan.ts';

// ── dialects (shapes of files we do not own) ────────────────────────────
export {
  dialectFor,
  knownEntryTypes,
  assessDrift,
  satisfies,
  deadPaths,
  DIALECT_DRIFT_RATIO,
  DIALECT_DRIFT_MIN_LINES,
  type Dialect,
  type DriftVerdict,
  type EntryRole,
} from './dialect.ts';
