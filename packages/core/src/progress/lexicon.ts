import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fold } from './fold.ts';

/**
 * Language data, kept as data.
 *
 * Every word this parser reasons about — status markers, completion verbs,
 * document-role hints, phase nouns — lives in `lexicons/*.json` rather than in
 * code. Two reasons, both practical:
 *
 * 1. A new language is a pull request against a JSON file, not against a
 *    parser. The reference user writes plans in Turkish; the next user will
 *    not.
 * 2. Vocabulary drifts faster than code ships. `dialects/` and `lexicons/` are
 *    versioned separately from the program for exactly this reason.
 *
 * This is the one place `core` touches the filesystem, and it is deliberate:
 * the alternative is embedding the data in a `.ts` file, which would make the
 * "update without a release" property a lie.
 */

export interface Lexicon {
  lang: string;
  version: number;
  status: Record<StatusKind, string[]>;
  roles: Record<string, string[]>;
  phaseWords: string[];
  completionVerbs: string[];
  /**
   * Stems of the same verbs, for prose rather than table cells.
   * A commit subject says "Stage 1 kapanış" and "Faz 2 tamamlama"; the exact
   * conjugated forms in `completionVerbs` match neither. Stems plus the
   * agglutination tolerance in `hasStem` match both.
   */
  completionStems: string[];
  question: string[];
  statusLineKeys: string[];
  selfDeclaredRoles: Record<string, string[]>;
}

export type StatusKind = 'done' | 'partial' | 'todo' | 'blocked' | 'dropped';

/** Pre-folded for matching, so folding happens once at load rather than per line. */
export interface FoldedLexicon {
  lang: string;
  status: Array<{ kind: StatusKind; term: string }>;
  roles: Array<{ role: string; term: string }>;
  phaseWords: string[];
  completionVerbs: string[];
  completionStems: string[];
  statusLineKeys: string[];
  selfDeclaredRoles: Array<{ role: string; term: string }>;
}

const LEXICON_DIR = join(import.meta.dirname, '..', '..', 'lexicons');

let cache: Map<string, FoldedLexicon> | null = null;

function loadAll(): Map<string, FoldedLexicon> {
  if (cache) return cache;
  cache = new Map();
  let files: string[] = [];
  try {
    files = readdirSync(LEXICON_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    // Missing lexicons must degrade, not crash: the rest of the tool works.
    return cache;
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(LEXICON_DIR, f), 'utf8')) as Lexicon;
      cache.set(raw.lang, foldLexicon(raw));
    } catch {
      /* a malformed lexicon disables that language, nothing else */
    }
  }
  return cache;
}

function foldLexicon(l: Lexicon): FoldedLexicon {
  const status: FoldedLexicon['status'] = [];
  for (const [kind, terms] of Object.entries(l.status ?? {})) {
    for (const t of terms) status.push({ kind: kind as StatusKind, term: fold(t) });
  }
  const roles: FoldedLexicon['roles'] = [];
  for (const [role, terms] of Object.entries(l.roles ?? {})) {
    for (const t of terms) roles.push({ role, term: fold(t) });
  }
  const selfDeclaredRoles: FoldedLexicon['selfDeclaredRoles'] = [];
  for (const [role, terms] of Object.entries(l.selfDeclaredRoles ?? {})) {
    for (const t of terms) selfDeclaredRoles.push({ role, term: fold(t) });
  }
  // Longest first: "kismen tamam" must win over "tamam".
  status.sort((a, b) => b.term.length - a.term.length);
  roles.sort((a, b) => b.term.length - a.term.length);
  return {
    lang: l.lang,
    status,
    roles,
    phaseWords: (l.phaseWords ?? []).map(fold),
    completionVerbs: (l.completionVerbs ?? []).map(fold),
    completionStems: (l.completionStems ?? []).map(fold),
    statusLineKeys: (l.statusLineKeys ?? []).map(fold),
    selfDeclaredRoles,
  };
}

/**
 * All loaded lexicons, merged.
 *
 * Deliberately not "detect the language, then use that one". Real plan
 * documents in this corpus mix languages freely — Turkish prose with `Stage 5`
 * headings, English status words in Turkish tables. Guessing one language per
 * document would misread exactly the mixed files that are hardest to read
 * anyway. Terms are unambiguous enough across tr/en that merging costs
 * nothing.
 */
export function lexicon(): FoldedLexicon {
  const all = [...loadAll().values()];
  if (all.length === 1) return all[0]!;
  const merged: FoldedLexicon = {
    lang: all.map((l) => l.lang).join('+') || 'none',
    status: all.flatMap((l) => l.status),
    roles: all.flatMap((l) => l.roles),
    phaseWords: [...new Set(all.flatMap((l) => l.phaseWords))],
    completionVerbs: [...new Set(all.flatMap((l) => l.completionVerbs))],
    completionStems: [...new Set(all.flatMap((l) => l.completionStems))],
    statusLineKeys: [...new Set(all.flatMap((l) => l.statusLineKeys))],
    selfDeclaredRoles: all.flatMap((l) => l.selfDeclaredRoles),
  };
  merged.status.sort((a, b) => b.term.length - a.term.length);
  merged.roles.sort((a, b) => b.term.length - a.term.length);
  return merged;
}

/** For tests that need to assert against one language in isolation. */
export function lexiconFor(lang: string): FoldedLexicon | undefined {
  return loadAll().get(lang);
}

export function availableLanguages(): string[] {
  return [...loadAll().keys()];
}
