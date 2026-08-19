/**
 * Wording for adapter notes.
 *
 * Separate from the adapters because the adapters must not hold sentences: the
 * translation catalogue is keyed on source text and extracted statically, so a
 * string that only exists inside a data structure is a string no translator will
 * ever see. Here every one of them is a literal `tr()` call, which is exactly
 * what the extractor looks for and what `vt lang` counts.
 */
import { tr } from '@vibetracker/core';
import type { AdapterNote } from './types.ts';

export function noteText(note: AdapterNote): string {
  switch (note) {
    case 'no-registry':
      return tr('no session registry — liveness rests on the last write');
    case 'folders-only':
      return tr('folder list only — session state is not read');
    case 'never-used':
      return tr('installed, never used yet');
    case 'schema-drift':
      return tr('schema moved: sessions exist but their messages cannot be read');
    case 'log-only':
      return tr('session table empty — runs are read from the log file');
    case 'unreadable':
      return tr('database could not be read');
  }
}
