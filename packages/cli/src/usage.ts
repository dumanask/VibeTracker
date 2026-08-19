/**
 * The help text, as rows rather than as one block.
 *
 * The first version was a single tagged template, which made the entire help
 * one catalog key. That works right up until a command is added: the key
 * changes, every language loses its whole help text at once, and the coverage
 * test correctly reports the lot as untranslated. Invalidating one row when
 * one row changes is the behaviour worth having.
 *
 * Two rules follow from how translation is checked:
 *
 * 1. **Every description is a literal inside `tr(...)`.** The second version
 *    kept the strings in a table and called `tr(desc)` in the formatter. The
 *    static key scanner sees only literals, so it found nothing, the coverage
 *    test passed, and every row printed in Turkish under `--lang en`. A
 *    lookup the scanner cannot see is a lookup nobody will notice is broken.
 * 2. **Every table is a function.** Module bodies run before the language is
 *    resolved; a constant would capture the source language and no amount of
 *    correct catalog data would change what prints.
 *
 * The left column is never translated — `vt doctor --bundle` is the same in
 * every language — and the alignment is computed rather than typed.
 */
import { t, tr } from '@vibetracker/core';

type Row = [invocation: string, description: string];

const commands = (): Row[] => [
  ['vt init', tr('İlk kurulum — diskin taranmaz, sorular sorulur')],
  [`vt status [${tr('seçenekler')}]`, tr('Tüm ajan oturumlarının anlık durumu (tek seferlik)')],
  ['vt daemon [--open]', tr('Sürekli izleme + canlı web paneli')],
  ['vt daemon stop', tr("Çalışan daemon'ı düzgünce durdur")],
  ['vt open', tr("Çalışan daemon'ın panelini tarayıcıda aç")],
  ['vt mini', tr('Post-it penceresi — küçük, üstte kalan panel')],
  ['vt doctor [--json]', tr('Bu makinede neyin çalışıp neyin çalışmadığı')],
  [`vt doctor --bundle [${tr('dosya')}]`, tr('Paylaşılabilir teşhis paketi (beyaz listeli)')],
  [`vt config <${tr('alt-komut')}>`, tr('Yapılandırmayı göster/doğrula (show|path|check)')],
  [`vt hooks <${tr('alt-komut')}>`, tr('Kesin izin/tur tespiti (install|uninstall|status)')],
  [`vt autostart <${tr('alt-komut')}>`, tr("Oturum açılışında daemon'ı başlat (install|uninstall|status)")],
  ['vt uninstall [--keep-data]', tr('Her şeyi geri al ve ne yapıldığını yaz')],
  // A distinct key from the `proje` stat label: the same Turkish word is a
  // singular metavariable here and a plural count there, and one catalog
  // entry cannot be both.
  [`vt board [${tr('proje-adı')}]`, tr('Faz panosu — commit geçmişinden çıkarılmış zaman çizelgesi')],
  [`vt projects [${tr('alt-komut')}]`, tr('İzlenecek projeleri seç (list|add|rm|all)')],
  [`vt digest [${tr('proje-adı')}]`, tr('LLM özeti — faz adı, engel, sonraki adım (varsayılan kapalı)')],
  ['vt digest providers', tr('Hangi LLM kullanılıyor, hangileri seçilebilir')],
  ['vt digest key <anahtar>', tr("API anahtarını 0600 bir dosyaya yaz (config'e asla yazılmaz)")],
  ['vt demo [--all]', tr('Sentetik ortamda panel — gerçek veriye dokunmaz')],
  ['vt lang [missing]', tr('Dil durumu; çevrilmemiş metinleri listele')],
  ['vt --help', tr('Bu yardım')],
];

const miniOptions = (): Row[] => [
  ['vt mini full|shade|badge', tr('Üç boyuttan biriyle aç')],
  ['vt mini unpin', tr('Açık pencereyi kapat')],
  ['--browser', tr('Tarayıcı penceresini kullan (yerel pencere yerine)')],
  ['--size <gxy>', tr('Tarayıcı penceresi boyutu, örn. 360x260')],
  ['--at <x,y>', tr('Ekrandaki konum')],
  ['--no-pin', tr('Aç ama üstte tutma')],
];

const options = (): Row[] => [
  [`--html <${tr('dosya')}>`, tr('Kendi kendine yeten HTML anlık görüntüsü yaz')],
  ['--json', tr('Raporu JSON olarak yazdır (makine okunur)')],
  ['--full', tr('Yalın liste yerine oturum oturum ayrıntı')],
  ['--every', tr('İzleme seçimini yok say, tüm projeleri göster')],
  ['--all', tr('Ölü/yetim oturumları da göster')],
  ['--temp', tr('Geçici/scratch çalışma dizinlerini de göster')],
  ['--quick', tr('CPU örneklemesini atla ("düşünüyor mu takıldı mı" ayrımı zayıflar)')],
  ['--tail <kb>', tr('Transcript kuyruk penceresi, KB (varsayılan 256)')],
  ['--signal-waiting', tr('Bekleyen oturum varsa çıkış kodu 10 döndür')],
  ['--lang <tr|en>', tr("Bu çalıştırma için dil (VT_LANG ve config'in üstünde)")],
  ['--dry-run', tr('vt digest: gönderilecek metni göster, gönderme')],
  ['--version, -V', tr('Sürüm, platform ve Node sürümü — hata bildirirken bunu ekle')],
];

const daemonOptions = (): Row[] => [
  ['--open', tr('Başlayınca paneli tarayıcıda aç')],
  ['--port <n>', tr('Dinlenecek port (varsayılan 47823)')],
  ['--interval <ms>', tr('Tarama aralığı (varsayılan 3000)')],
];

const hookOptions = (): Row[] => [
  ['--yes', tr("Diff'i göster ama onay sorma (betikler için)")],
  ['--high-fidelity', tr('PreToolUse/PostToolUse da bağla (yüksek hacim, varsayılan kapalı)')],
];

const initOptions = (): Row[] => [
  ['--yes', tr('Soru sorma, güvenli varsayılanları kabul et')],
  ['--force', tr('Var olan yapılandırmanın üstüne yeniden kur')],
];

const uninstallOptions = (): Row[] => [
  ['--keep-data', tr('Veritabanı, günlük ve yapılandırma kalsın (yalnızca sistemden ayrıl)')],
];

const exitCodes = (): Row[] => [
  ['0', tr('başarılı')],
  ['1', tr('doctor: en az bir kontrol başarısız')],
  ['2', tr('kullanım hatası')],
  ['3', tr('daemon zaten çalışıyor / çalışmıyor')],
  ['4', tr('port başkası tarafından kullanılıyor')],
  ['10', tr('bekleyen oturum var (yalnızca --signal-waiting ile)')],
  ['70', tr('beklenmedik hata')],
];

/**
 * Align on the widest invocation, so a longer command never breaks the layout.
 * The descriptions arrive already translated — see rule 1 above.
 */
function block(rows: Row[], indent = '  '): string {
  const width = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([left, desc]) => `${indent}${left.padEnd(width)}  ${desc}`).join('\n');
}

export function usage(): string {
  return [
    t`vt — VibeTracker`,
    '',
    block(commands()),
    '',
    tr('Seçenekler'),
    block(options()),
    '',
    tr('daemon seçenekleri'),
    block(daemonOptions()),
    '',
    tr('hooks seçenekleri'),
    block(hookOptions()),
    '',
    tr('init seçenekleri'),
    block(initOptions()),
    '',
    tr('uninstall seçenekleri'),
    block(uninstallOptions()),
    '',
    tr('mini seçenekleri'),
    block(miniOptions()),
    '',
    tr('Çıkış kodları'),
    block(exitCodes()),
    '',
    tr('VibeTracker hiçbir projene yazmaz, hiçbir ajanla konuşmaz ve ağa çıkmaz.'),
    '',
  ].join('\n');
}
