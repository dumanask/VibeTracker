/**
 * Test-only helpers for the adapter tests.
 *
 * Separate from the tests so the coverage scanner does not treat a fixture as a
 * source of translatable strings, and so the adapters themselves stay free of
 * exports that only a test wants.
 */
import type { TranscriptFacts } from '@vibetracker/shared';

export interface TailTargetLike {
  facts: TranscriptFacts;
  openTools: Map<string, string>;
}

export function emptyFacts(path: string, mtimeMs: number): TranscriptFacts {
  return {
    path,
    size: 0,
    mtimeMs,
    openTools: [],
    unknownTypes: [],
    linesParsed: 0,
    parseFailures: 0,
  };
}
