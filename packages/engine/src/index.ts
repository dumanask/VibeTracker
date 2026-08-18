export { scan, DEFAULT_SCAN, type ScanOptions } from './scan.ts';
export { ScanContext } from './context.ts';
export {
  TailReader,
  readTranscriptFacts,
  type TailOptions,
  type TailStats,
} from './tail.ts';
export {
  readRegistry,
  readIdeLocks,
  indexTranscripts,
  readKnownProjects,
  type KnownProject,
} from './readers.ts';
export {
  discoverProjects,
  identifyDirectory,
  type DiscoveredProject,
  type DiscoverOptions,
} from './discover.ts';
export {
  readPackageName,
} from './readers.ts';
export {
  readProjectProgress,
  type ProgressReport,
  type ProgressSource,
  type PhaseView,
  type Drift,
  type DriftCode,
  type ProgressOptions,
  type PriorReading,
} from './progress/scan.ts';
export {
  backfillPhases,
  toSpans,
  type BackfillResult,
  type PhasePoint,
  type PhaseSpan,
} from './progress/backfill.ts';
export {
  allAdapters,
  enabledAdapters,
  closeAdapters,
  noteText,
  pathFromFileUri,
  applyCodexLines,
  DEFAULT_RECENCY_MS,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentProjectHint,
  type DetectResult,
  type ObservedSession,
  type AdapterNote,
} from './agents/index.ts';
export { type LineApplier, type TailTarget } from './tail.ts';
