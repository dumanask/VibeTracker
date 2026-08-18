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
      return tr('oturum kaydı yok — canlılık son yazma anına dayanıyor');
    case 'folders-only':
      return tr('yalnızca klasör listesi — oturum durumu okunmuyor');
    case 'never-used':
      return tr('kurulu ama henüz kullanılmamış');
    case 'schema-drift':
      return tr('şema değişmiş: oturum var ama mesajları okunamıyor');
    case 'log-only':
      return tr('oturum tablosu boş — çalıştırmalar log dosyasından okunuyor');
    case 'unreadable':
      return tr('veritabanı okunamadı');
  }
}
