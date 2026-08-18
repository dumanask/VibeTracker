# VibeTracker

Çok ajanlı, çok projeli vibe coding için kontrol merkezi.

Aynı anda birçok projede çalışırken — farklı IDE pencereleri, farklı ajan CLI'ları — hangi
ajanın çalıştığını, hangisinin seni beklediğini ve hangi projenin ne durumda olduğunu tek
ekranda gösterir.

**Hiçbir projene dosya yazmaz. Hiçbir ajanla konuşmaz. Ağa çıkmaz.**

Apache-2.0 · Windows, macOS, Linux · npm paketi ya da masaüstü uygulaması

---

## Durum: açık kaynak · altı ajan · üç platform

Daemon, canlı panel, tek örnek kilidi, watchdog, saklama politikası, otomatik başlatma,
`vt doctor`, redaksiyon hattı, **hook tabanlı kesin durum tespiti** ve **faz/ilerleme
motoru** çalışıyor — yani ilk sorunun her iki yarısı da cevaplanıyor: *ajan ne yapıyor* ve
*proje hangi aşamada*.

M4 ile bunların hepsi **başka bir bilgisayara kurulabilir** hâle geldi: `vt init` ile
kurulum, TOML yapılandırma, beyaz listeli teşhis paketi, manifest'li kaldırma ve sıfır
bağımlılıklı bir npm paketi. Tarball temiz bir dizine kurulup çalıştırılarak doğrulandı.

Sonrasında geriye kalanlar da kapandı: **arayüz tamamen iki dilli** (kapsam testle
ölçülüyor), **D4–D6 drift dedektörleri**, **faz panosu** (commit geçmişinden çıkarılmış
zaman çizelgesi), **`dialects/` registry'si** ve ajanı hiç kurulu olmayan bir makinede
her şeyi çalıştıran **sentetik ortam üreteci** + CI matrisi.

Kullanımdan doğan üç şey daha var: **izlenecek projeleri seçebiliyorsun**, ekran
**projeye tek satır** düştü ve panel ekranın köşesinde **üstte kalan küçük bir pencere**
olarak durabiliyor.

Ve pano artık yalnızca Claude Code'a bakmıyor. **Codex, opencode, Kilo ve Cline** gerçek
oturumlarıyla, **Gemini ile altı editör çatalı** (VS Code/Copilot, Cursor, Antigravity,
Trae, Windsurf, VSCodium) klasör listeleriyle aynı panoda. Her adaptör aynı `TranscriptFacts`
yapısını üretiyor ve durumu tek bir durum makinesi karar veriyor — altı ajanın
kıyaslanabilir olmasının tek sebebi bu. Hangi adaptörün ne okuyabildiği ve nerede durduğu
`vt doctor`'da satır satır yazıyor; okuyamadığı yeri iddia etmiyor.

Panel iki hassasiyet seviyesini asla aynı göstermez: `◆` durumun hook olaylarından
**ölçüldüğü**, `◇` transcript ve süreç ağacından **çıkarıldığı** anlamına gelir. Aradaki fark
en çok ekranda `WAITING_PERMISSION` yazdığında önemli.

Üç çalışma biçimi var.

**Sürekli izleme — `vt daemon`:** arka planda çalışır, her 3 saniyede tarar, durumu SQLite'a
yazar ve `http://127.0.0.1:47823` adresinde canlı bir panel sunar (SSE ile anlık, sayfa
yenilemek gerekmez). Bekleme süreleri kalıcı olduğu için *"41 dakikadır izin bekliyor"*
sorusunu cevaplayabilir — tek seferlik bir taramanın asla bilemeyeceği şey budur.

```bash
pnpm vt -- daemon --open
```

**Tek seferlik — `vt status`:** daemon yok, veritabanı yok, kurulum yok. Anlık tablo veya
kendi kendine yeten HTML üretir.

```bash
pnpm vt              # veya: node packages/cli/src/index.ts status
```

**Teşhis — `vt doctor`:** bu makinede neyin çalıştığını, neyin bozuk olduğunu ve neyin
*henüz yazılmadığını* ayrı ayrı söyler. Bu üçünü karıştırmak insanı olmayan bir hatanın
peşine düşürür, o yüzden her satır sebebini taşır.

```bash
pnpm vt -- doctor            # --json ile makine okunur
pnpm vt -- hooks install     # kesin izin/tur tespiti (diff gösterir, onay ister)
pnpm vt -- autostart install # oturum açılışında daemon (Windows, yönetici gerekmez)
```

**Kurulum — `vt init`:** dört adım, üç soru, **sıfır disk taraması**. Projeler ajanın zaten
yazdığı oturum kayıtlarından okunur; dosya sistemi gezilmez.

```bash
vt init                 # --yes ile soru sormadan, güvenli varsayılanlarla
vt config check         # hangi ayar geçerli, hangisi varsayılana düştü
vt doctor --bundle      # paylaşılabilir teşhis paketi (yazmadan önce içeriği listeler)
vt uninstall            # her şeyi geri al ve ne yapıldığını manifest olarak yaz
```

**Geçmiş — `vt board`:** VibeTracker kurulmadan önce ne olduğunu commit başlıklarından
çıkarır. Sıfır token, sıfır ağ, tek süreç.

```
  VRTwin 22 commit
    faz 0      ▒▒▒··········································· 4 commit · açık
    slice 3    ··················▐▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ 5 commit · bitti denildikten sonra 3 commit
```

Son satır çıkarımın işe yaradığı yer: **slice 3 "tamamlandı" denmiş, sonra 3 commit daha
gelmiş.** Panonun tamamı taralı çizilir — geçmiş kabadır ve bugünle aynı görünmemelidir.

**Deneme — `vt demo`:** ajan hiç kurulu olmasa bile paneli dolu gösterir. Sentetik ortamı
CI'ın kullandığı üreteç kurar, yani gerçekliğin daha güzel bir versiyonuna kayamaz.

```bash
vt demo                 # geçici dizinde kurulur, çıkışta silinir
vt demo --all           # seyrek 600 MB transcript de üret
```

```
VibeTracker · 18.08.2026 00:06 · win32-x64 · windows-powershell (exact)
  50 kayıt → 5 canlı · 42 ölü · 3 PID-yeniden-kullanım
  3 proje · 3 oturum seni bekliyor · 3 IDE penceresi

SENİ BEKLEYENLER
  ⚠ Prime       prime-05·5472       STALLED          8dk 41sn
  ⏸ AgentWorld  agentworld-43·55408 WAITING_INPUT     9sa 8dk
```

### Seçenekler

| Seçenek | Etki |
|---|---|
| `--html <dosya>` | Kendi kendine yeten HTML anlık görüntü (harici istek yok) |
| `--json` | Makine okunur rapor |
| `--all` | Ölü ve yetim oturumları da göster |
| `--temp` | Geçici/scratch çalışma dizinlerini de göster |
| `--quick` | CPU örneklemesini atla (hızlı, ama "düşünüyor mu takıldı mı" ayrımı zayıflar) |
| `--tail <kb>` | Transcript kuyruk penceresi (varsayılan 256 KB) |
| `--signal-waiting` | Bekleyen oturum varsa çıkış kodu 10 (statusline/prompt için) |
| `--lang <tr\|en>` | Bu çalıştırma için dil (`VT_LANG` ve config'in üstünde) |
| `--bundle [dosya]` | `vt doctor` ile: paylaşılabilir teşhis paketi |

Çıkış kodları: `0` başarılı · `1` doctor'da en az bir kontrol başarısız · `2` kullanım
hatası · `3` daemon zaten çalışıyor / çalışmıyor · `4` port başkasında · `10` bekleyen var
(yalnızca `--signal-waiting` ile) · `70` beklenmedik hata.

---

## Tasarımı belirleyen üç ölçüm

**1. Naif canlılık sayımı yalan söylüyor.** Oturum kaydındaki 50 girdinin PID'lerini
kontrol etmek "16 canlı" der; gerçek 13'tü. Üç girdi artık başka süreçlere ait PID'lere
işaret ediyordu. VibeTracker ajanın kaydettiği süreç başlangıç zamanını da karşılaştırır ve
bu durumu ayrı bir `reused` verdikti olarak raporlar.

Bu karşılaştırma **toplu** yapılır, tek tek değil: başlangıç-zamanı formatının ajanın yama
sürümleri arasında değiştiği görüldü. Karşılaştırılabilir kayıtların *hiçbiri* eşleşmiyorsa
bu "her süreç geri dönüştürüldü" değil, "format varsayımımız yanlış" demektir — o durumda
oturumlar canlı sayılır ve koruma devre dışı olarak raporlanır. Aksi hâlde 13 çalışan ajan
varken sıfır gösterirdik, ki bu düzeltmeye çalıştığımız hatadan çok daha kötü.

**2. Transcript'ler asla tam okunmaz — ve değişmediyse hiç okunmaz.** Referans makinede en
büyük tek dosya 518 MB, toplam 1.73 GB. Yalnızca sondan sınırlı bir pencere okunur.

Açılış maliyeti hakkında dürüst olmak gerekiyor: aynı makinede 518 MB'lık dosyadan 256 KB
kuyruk okuma bir ölçümde soğukta 319 ms / sıcakta 307 ms verdi (fark yok — bu page-cache
ıskası değil, antivirüsün `CreateFile`'da tarama yapması), başka bir zamanda aynı iş 2 ms
sürdü. Tarayıcının kendi önbelleğinin durumuna bağlı, yani **ne zaman pahalıya patlayacağını
önceden bilemezsin.** Kalıcı tanıtıcı bu soruyu tamamen ortadan kaldırıyor.

Asıl kazanç zaten başka yerde: okuyucu artımlı. `fstat` dosyanın büyümediğini söylüyorsa
tek bayt okunmuyor. Gerçek çalışmada ölçülen oran **134 yoklamanın 102'sinde sıfır G/Ç**.
Büyümüşse yalnızca eklenen baytlar okunuyor, 256 KB'lık pencere baştan ayrıştırılmıyor —
bu ayrıca araç eşleşmesini *daha doğru* yapıyor: 40 yoklama önce görülen bir `tool_use`,
pencereden çıkmış olsa bile hatırlanıyor.

**3. Sıra kimde sorusunu CPU değil transcript cevaplar.** CPU *iş yapılıyor mu* söyler.
Asistan mesajını bitirdiyse ve ardından bir şey gelmediyse top insandadır — süreç boşta
timer yakıyor olsa bile. CPU ölçümü yalnızca bir tur *devam ederken* anlamlıdır: ajan
transcript'i mesaj tamamlanınca yazdığı için uzun düşünen bir tur dakikalarca hiçbir şey
yazmaz, ama CPU yakar. Sessizlik **artı** CPU yokluğu takılmadır.

Bunun ölçülebilir bir sonucu var. CPU örneklemek iki anlık görüntü arasında **beklemek**
demek, ve boştaki bir yoklamada bu maliyetin tamamı boşa gidiyor. Artık önce transcript'ler
okunuyor, sonra örnekleme yalnızca gerçekten uçuşta bir tur varsa yapılıyor. Ölçülen fark:
**boşta tarama 39 ms**, uçuşta tur varken 780–1050 ms (bunun 700 ms'i kasıtlı bekleme).

---

## Mimari

```
packages/
  shared/    Ortak sözlük: durum makinesi, canlılık, araç sınıfları, rapor tipleri
  core/      Saf mantık: durum türetme, eşikler, proje bayrakları, dikkat skoru,
             redaksiyon, JSON düzenleyici
             toml.ts   — elle yazılmış TOML 1.0 okuyucu (bağımlılık yok)
             config.ts — şema, varsayılanlar, doğrulama; asla throw etmez
             i18n.ts   — kaynak metnin anahtar olduğu çeviri; eksik çeviri
                         gerçek bir cümleye düşer, anahtar kimliğine değil
             i18n-scan.ts — kaynağı statik tarayıp istenen anahtarları çıkarır
                         (kapsam ölçülebilir olsun diye)
             phrase.ts — motorun kurduğu ama yazmadığı cümleler: {key, args}
             dialect.ts — bizim olmayan dosyaların şekilleri (sürüm aralıklı)
             progress/ — faz motoru: dilden bağımsız katlama, rol sınıflandırma,
                         çıkarıcılar, faz merdiveni, yüzde kapıları
             summary.ts — projeye tek satır: ne bekliyor, ne çalışıyor
                         (motorda bir kez hesaplanır; üç arayüz aynısını çizer)
             tracking.ts + tomledit.ts — izlenecek projeler; config yorumları korunur
             lexicons/ — durum/rol/faz kelimeleri (kod değil veri)
             locales/  — arayüz çevirileri (kod değil veri)
             dialects/ — ajan dosya biçimleri (kod değil veri)
  platform/  Platformdan bağımsız katman
             dirs.ts   — $CLAUDE_CONFIG_DIR / XDG / %APPDATA% keşfi (gömülü yol yok)
             config-file.ts — config.toml okuma/yazma + yorumlu başlangıç şablonu
             paths.ts  — NFC normalizasyon, tek katlama fonksiyonu, depolama sınıflandırma
             probe/    — süreç sondası: Windows (kalıcı PowerShell) · Linux (/proc) ·
                         macOS (ps) · degraded (kill 0); süreç ağacı + PID-reuse hükmü
             git.ts    — kök commit ile proje kimliği
             note.ts + note.ps1 — çerçevesiz, üstte kalan post-it penceresi
                         (saf ASCII script; gördüğü her kelime dışarıdan gelir)
             pin.ts    — tarayıcı yedeği: --app penceresi + SetWindowPos
  engine/    tail.ts   — artımlı, kalıcı tanıtıcılı transcript okuyucu
                         (tam okuma kod düzeyinde yasak)
             scan.ts   — dört fazlı tarama; context.ts — sondayı, tanıtıcıları ve
                         önbellekleri taramalar arası yaşatan bağlam
             progress/ — proje belgelerini tarayıp git ile uzlaştırma, drift
                         backfill.ts — commit başlıklarından tarihli faz çizelgesi
  daemon/    store.ts (node:sqlite + saklama politikası) · server.ts (node:http + SSE) ·
             security.ts · log.ts · main.ts (tek örnek, watchdog) ·
             board.ts (çıkarılmış geçmiş + gözlenmiş okumalar, dikişi belli) ·
             public/index.html (canlı panel)
  fixtures/  Sentetik ajan ortamı: PID geri dönüşümü, bozuk satır, bilinmeyen tip,
             NFD yol, seyrek 600 MB transcript. Test yardımcısı değil, ürünün parçası
  cli/       vt komutu: init · status · daemon · open · mini · doctor · config · hooks ·
             autostart · uninstall · board · projects · demo · lang
scripts/
  pack.mjs   Yayınlanabilir tarball: workspace adlarını göreli yola çevirir,
             beyaz listeyle kopyalar, çevrilmemiş paket adı kalırsa hata verir
```

**Yayın paketi bir derleme değil.** Geliştirmede derleme adımı yok — Node tipleri
söküp kaynağı doğrudan çalıştırıyor. npm'de workspace bağlantısı olmadığı için
`scripts/pack.mjs` yalnızca `@vibetracker/x` çağrılarını göreli yola çeviriyor ve
dizini düzleştiriyor. Yayınlanan dosyalar hâlâ okunabilir TypeScript: birisi
`node_modules/vibetracker/src/core/derive.ts` dosyasını açtığında bu depodaki
dosyayı, yorumlarıyla birlikte görüyor.

**Sıfır çalışma-zamanı bağımlılığı.** Veritabanı `node:sqlite`, sunucu `node:http` —
ikisi de Node'un içinde. Native modül yok, prebuild matrisi yok, `node-gyp` yok. Bu bir
kolaylık değil, dağıtım kararı: başkalarının kuracağı bir araç derleyici istememeli.

**Build adımı yok.** Node 22 TypeScript'i yerel çalıştırıyor. Kod "erasable syntax only"
kuralına uyar — `enum`, `namespace`, parametre özellikleri ve decorator kullanılmaz;
`tsconfig` bunu `erasableSyntaxOnly` ile zorlar.

### Panel güvenliği

Localhost bir güvenlik sınırı değildir. Saldırganın sayfası kendi alan adını `127.0.0.1`'e
çözerse tarayıcı bizim porta bağlanır ve soket *gerçekten* loopback'ten gelir — bu yüzden
yalnızca `remoteAddress` kontrolü hiçbir şey kanıtlamaz (DNS rebinding). Katmanlar:
loopback soket → `Host` beyaz listesi → `Origin` beyaz listesi → sabit-zamanlı token.
CORS başlığı hiç gönderilmez. Altı senaryonun tamamı test edildi.

### Faz motoru — sayı üretmeyi reddetmek de bir özellik

Proje kartında artık `Stage 5 · faz 0/4 █████······ %33` gibi bir satır var, altında
**nereden geldiği**: `6/20 madde · docs/33_stage5_uygulama_plani.md · dün`. Üç görsel durum
asla birbirine karışmaz — dolu çubuk sayılmış bir oran, taralı çubuk + `~` sıra konumundan
*çıkarılmış* bir tahmin, kesik boş kanal + `—` ise **sayı üretmeyi reddettiğimiz** durum,
yanında sebebiyle.

Bu reddetme, motorun en önemli parçası. Panelde bir sayı görürsen onu ölçüm sanarsın; bir
changelog'dan üretilmiş `%100` sana yanlış karar verdirir. `—, çünkü bu bir kayıt belgesi`
bilgidir.

**Tasarımı 182 gerçek plan belgesi belirledi, plan değil.** Ölçüm planın bir varsayımını
çürüttü: GFM onay kutuları (`- [x]`) bu külliyatta neredeyse yok — 182 dosyanın 9'unda,
toplam 81 madde. Asıl kelime dağarcığı **semboller**: 1424 ✅, 588 ⚠️, 424 ❌, 356 🔴,
231 🟡. Onay kutusu üzerine kurulmuş bir ayrıştırıcı bu külliyatı "hiç ilerleme bilgisi yok"
diye okurdu.

**Üç tuzak, üçü de ölçülmüş:**

1. **Rakip tablosu ilerleme değil.** Tablolardaki 992 ✅'in **800'ü durum sütunu dışında** —
   rakip karşılaştırmaları, dosya envanterleri, denetim bulguları. `pazar-ve-firsatlar.md`
   tek başına 272 tane taşıyor. Başlığı katlanmış hâlde `durum|status|state` olan sütun
   dışında **hiçbir hücre sayılmaz**; bu tek koşul, bir pazar analizini "neredeyse bitmiş
   proje" diye raporlamakla arasındaki fark.
2. **Hepsi işaretli belge bitmiş proje değil.** 10+ madde ve bitmemiş madde yoksa, bu bir
   "bugün ne yaptık" günlüğü — paydadan çıkar.
3. **Türkçe ekler faz uydurur.** Başlıklardaki 248 faz jetonunun 15'i `Faz 0'a`,
   `Aşama 1'in`, `Stage 2'nin` gibi çekimli *atıflar* — "Aşama 1'in sınırları" bir fazı
   bildirmez, hakkında konuşur. Bunlar merdivenin **başına** hayalet basamak ekler, yani en
   çok zarar veren yere.

Aynı ek sorunu rol sınıflandırmasında da vardı ve iki gerçek yanlış sınıflandırmaya mal
oldu: `envanteri ≠ envanter`, `arşivi ≠ arşiv`. Rol kelimeleri artık gövde eşleşmesiyle
aranıyor — kelime başında sabit, sonunda esnek, böylece `planlama` eşleşir ama `explanation`
eşleşmez.

**Kelimeler kod değil veri.** Durum işaretleri, tamamlama fiilleri, rol ipuçları ve faz
isimleri `packages/core/lexicons/*.json` içinde. Yeni bir dil bir JSON dosyasına PR demek,
ayrıştırıcıya değil.

**Ne kadar seçici?** 182 belgenin 6'sı yüzde bildiriyor. Geri kalanı bastırılıyor ve sebebi
söyleniyor. Bu az değil — doğru sayı.

### Merdiven tek bir belgeye ait; yüzde belgelerin toplamı

Yukarıdaki üç kural belge *içinde* doğruydu ama proje seviyesinde iki şey yanlıştı, ve
ikisi de ekranda görülebiliyordu.

**Merdivenler belgeler arasında birleştiriliyordu.** Bir depodaki her `Faz N` tek bir
diziye toplanınca birbiriyle ilgisiz özellik planları tek bir merdiven sanılıyor: 72
belgelik gerçek bir projede bu, yedi fazı da bitmiş bir su modülü planı ile yedisi de
başlamamış bir izleme planından `Faz 0 / 7` üretti — ne özellik için ne proje için doğru
olan bir cümle. İki belgenin "Faz 1" demesi, aynı plan olmadıkça aynı basamağı anlatmaz.

Merdiven artık **tek bir belgeden** gelir ve o belgenin üç şartı vardır: en az üç basamak,
en az biri bitmiş, en az biri bitmemiş. Hiçbiri işaretlenmemiş bir merdiven içindekiler
tablosudur; hepsi işaretlenmiş olan bitmiş bir iştir — ikisinde de projenin yeri başka bir
yerdedir. İptal edilmiş basamak ilerleme sayılmaz (bu, bir i18n planının tüm depoyu "yedide
bir bitmiş" göstermesine yol açmıştı). İki belge ayrı birer merdiven tanımlıyorsa **faz
söylenmez** ve sebebi yazılır: taraf tutmak, okuyucunun göremediği bir anlaşmazlıkta karar
vermektir.

**Yüzde tek bir dosyadan geliyordu** — "en son dokunulan sayılabilir plan kazanır". Bu,
72 belgelik projenin yüzdesini bir alt özelliğin 12 maddelik listesindeki 1 işarete
bağlıyordu, ve başka herhangi bir dosyayı açmak sayıyı değiştiriyordu. Artık sayılabilir
**bütün planların toplamı**: iş ilerleyince kımıldar, sadece okurken durur. Tek belgelik
tabana takılan küçük listeler toplama dahildir — o taban, dört maddelik bir listenin
**tek başına** proje adına konuşmasını engellemek için var, yirmisinin toplanmasını değil.

Ve payda ile pay artık aynı hesaptan gelir. Kısmi iş yarım sayıldığı hâlde provenance
satırı bitmiş madde *adedini* yazıyordu: ekranda `1/12 madde · %25`. Doğrulanamayan
aritmetiğe kimse inanmaz.

### Hook'lar — ölçüm ile tahmin arasındaki fark

Pasif katman "bir araç fazla uzun süredir açık ve yeni alt süreç yok" diye **çıkarım** yapar.
`PermissionRequest` hook'u bunu doğrudan **söyler**. `vt hooks install` 13 olay bağlar;
`PreToolUse`/`PostToolUse` varsayılan **kapalı** (her araç çağrısında tetiklenir ve
`PostToolUse` tüm araç çıktısını taşır — `--high-fidelity` ile açılır), `MessageDisplay` ise
hiç bağlanmaz (akış sırasında sürekli tetiklenir).

**Sözleşme tahmin edilmedi, kaynaktan okundu.** Olay adları ve yük alanları kurulu Claude
Code ikilisinden (v2.1.206) çıkarıldı, geçerli olay listesi `claude doctor`'a doğrulattırıldı
— uydurduğun bir olay adı sessizce yok sayılır, yani panel kurulu görünür ve hiçbir şey
görmez. Bu yolla öğrenilen üç şey:

- `PermissionRequest` yükünde **`tool_use_id` yok** (diğer araç olaylarında var), eşleştirme
  araç adıyla yapılmalı.
- Girdiye eklediğimiz `"_vt": true` işareti **kabul ediliyor** — bilinmeyen *olay adları*
  geçersiz sayılıyor ama bilinmeyen *alanlar* sayılmıyor.
- `settings.json` **yorum kabul etmiyor**: bir `//` gördüğünde ajan dosyanın tamamını
  reddediyor ("Invalid or malformed JSON"). Dosyanda yorum varsa hiçbir ayarın geçerli
  değil — `vt hooks` bunu ayrıca uyarıyor, çünkü aksi hâlde kurulum başarılı görünürdü.

**Ajanı ne kadar durduruyoruz?** HTTP hook bloklayıcıdır (`async` yalnızca command hook'ta
var), yani bu uç noktanın gecikmesi doğrudan kullanıcının işine yansır. Ölçüm — 200 istek:
**p50 0.67 ms · p95 1.33 ms · p99 2.46 ms**. Yol üzerinde ayrıştırma, veritabanı, dosya
veya `await` yok: token doğrula, sınırlı halkaya it, 204 dön. Tampon dolarsa **en eski olay
düşürülür ve sayılır** — olay düşürmek paneli bozar, ajanı bekletmek işi bozar.

512 KB üstü gövdeler atılıyor ama bağlantı **koparılmıyor**: ilk denemede `req.destroy()`
kullanmıştım, ölçümde ajan tarafında "fetch failed" olarak göründü. Hata veren bir hook,
sessizce olay düşüren bir hook'tan daha kötü — kullanıcı çalışmaya çalışıyor, bizim
teşhisimiz onun sorunu değil.

**Ayarlarına dokunma kuralları.** Düzenleme `JSON.parse`/`stringify` ile değil, kaydedilmiş
bayt konumlarında metin eklemesiyle yapılıyor; girintin, boş satırların ve senin hook'ların
aynen kalıyor. Yazmadan önce diff gösterilip onay isteniyor (TTY yoksa `--yes` şart), yedek
alınıyor, ve yazma atomik (`.vttmp` → rename) — yarım yazılmış bir `settings.json` bozuk bir
panel değil, bozuk bir ajan demektir.

### Otomatik başlatma (Windows)

`vt autostart install` bir Zamanlanmış Görev kurar. Üç şey varsayılmadı, ölçüldü:

- Üç oturum-açma tipinden **yalnızca `InteractiveToken` yönetici olmadan kaydedilebiliyor.**
  Penceresiz görevin klasik yolu olan `S4U` "Access is denied" ile reddediliyor.
- Dolayısıyla görev kullanıcının kendi oturumunda çalışıyor ve düz `node.exe` eylemi **her
  oturum açılışında bir konsol penceresi açıyor** (ölçüldü: pencere sayısı 0 → 1).
  `powershell -WindowStyle Hidden` → `Start-Process -WindowStyle Hidden` zinciri aynı
  daemon'ı **hiç pencere açmadan** başlatıyor (0 → 0). VBScript kullanılmıyor — Windows'tan
  kaldırılmakta olan bir teknolojiye ürün özelliği bağlanmaz.
- O başlatıcı daemon'ı doğurup çıktığı için görev "çalışıyor" durumunda kalmıyor ve
  `RestartOnFailure` hiç tetiklenmezdi. Bu yüzden **süpervizör tetikleyicinin kendisi**:
  5 dakikada bir tekrarlıyor, daemon zaten ayaktaysa tek örnek kilidi devreye giriyor ve
  koşu anında sonlanıyor. Bu, yalnızca zamanlayıcının fark ettiği hataları değil, daemon'ı
  öldüren *her şeyi* telafi ediyor — kendi watchdog'u dâhil.

❌ Windows Service kullanılmıyor: servisler session 0'da servis hesabıyla çalışır,
`%USERPROFILE%` yanlış yere çözülür ve araç tam da okuması gereken dizini bulamaz. Kurulmuş
görünür, temiz başlar, hiçbir şey gözlemlemez.

### Redaksiyon

Ajandan gelen serbest metin (hata mesajları, bildirim gövdeleri) veritabanına, günlüğe veya
panele girmeden önce redaksiyondan geçiyor: sağlayıcı anahtarları, JWT'ler, özel anahtar
blokları, bağlantı dizeleri, `KEY=değer` satırları ve yüksek entropili diziler
`«redacted:tip»` yer tutucusuna dönüşüyor.

Bu koruma planda M4'teydi; **bir test hata metninde saklanan API anahtarını yakaladığı için**
öne alındı — o anahtar rapora, panele ve kullanıcının bir issue'ya yapıştıracağı `--json`
çıktısına gidecekti.

İki dürüst sınır: yanlış negatif verir (şirket içi bir token formatını tanımaz — bu yüzden
tek savunma değil), ve yanlış pozitif verir (yüksek entropili bir dize masum olabilir). Git
SHA'ları ve UUID'ler bilinen istisna, çünkü onları redakte etmek her kanıt satırını okunmaz
yapardı.

### Saklama

7/24 çalışan bir daemon'ın disk tavanı olmalı, "veri küçük kalır" umudu değil. Geçişler
90 gün, görülmeyen oturumlar 90 gün sonra siliniyor; veritabanı **500 MB sert tavanını**
aşarsa agresif pencere programdan bağımsız hemen koşuyor. Bakım saatte bir ve açılışta
çalışır (açılışta, çünkü ilginç durum bir aydır kapalı kalmış bir daemon'dır).

### Platform durumu

| Platform | Süreç sondası | PID-reuse koruması |
|---|---|---|
| Windows | Kalıcı PowerShell host, tek `Get-Process` çağrısı | **exact** (FILETIME) |
| Linux | `/proc/<pid>/stat` — süreç açmadan, en ucuz | **exact** (jiffies) |
| macOS | Tek `ps -axo` çağrısı | **second** — aynı saniyede geri dönüşen PID kaçabilir |
| Diğer | `kill(pid, 0)` | yok |

Windows uygulaması gerçek veriyle doğrulandı. Linux ve macOS uygulamaları yazıldı ancak
henüz o platformlarda çalıştırılmadı; ayrıca ajanın Windows dışında süreç başlangıç zamanı
kaydedip kaydetmediği doğrulanamadı — kod bunu tespit eder ve yoksa korumanın zayıfladığını
raporlar.

### Otomatik başlatma: üç mekanizma, tek kural

| Platform | Mekanizma | Çöken daemon |
|---|---|---|
| Windows | Scheduled Task · `InteractiveToken` | 5 dk'da bir tetikleyici canlılık kontrolü |
| macOS | `~/Library/LaunchAgents/dev.vibetracker.daemon.plist` | `KeepAlive`, 30 sn |
| Linux | `~/.config/systemd/user/vibetracker.service` | `Restart=on-failure`, 30 sn |
| systemd yok | `~/.config/autostart/vibetracker.desktop` | geri getirmez, ve bunu söyler |

Üçünün ortak kuralı **yönetici hakkı istememek**. Root isteyen bir kullanıcı-başına
gözlemci ne olduğunu yanlış anlamıştır; LaunchDaemon yerine LaunchAgent, sistem birimi
yerine `--user` birimi olmasının sebebi bu. Ve bu, Linux'un diğer ikisinin veremediği bir
söz verebilmesinin de sebebi.

**`KeepAlive` düz `true` değil.** Öyle olsaydı daemon *her* çıkıştan sonra yeniden
başlardı — `vt daemon stop`'un temiz çıkışı dâhil. O zaman durdurmak, agent'ı da
kaldırmadan imkânsız olurdu. `SuccessfulExit: false` "yalnızca hata ile çıkarsa" demek,
ki watchdog'un `exit(1)`'i tam olarak odur ve bilinçli bir durdurma değildir.

**systemd birimi sözü çekirdeğe yaptırıyor.**

```ini
ProtectHome=read-only
ReadWritePaths=/home/ali/.local/share/vibetracker /home/ali/.config/vibetracker
```

"Hiçbir projene dosya yazmaz, ajan durum dizinine yazmaz" cümlesinin README'de bir iddia
olmaktan çıkıp **çekirdeğin reddettiği bir şeye** dönüştüğü tek platform burası. Daemon
`$HOME`'un tamamını okuyabiliyor ve tam olarak iki dizine yazabiliyor, ikisi de kendisinin.
Bir hata bunu ihlal edemez; kontrolü koddan sessizce kaldıran bir çatal da edemez. Yollar
kurulum anında daemon'ın kullandığı fonksiyonlardan hesaplanıyor, yani alışılmadık bir
`XDG_DATA_HOME` onu kendi veritabanını yazamaz hâlde bırakamıyor.

**`MemoryDenyWriteExecute` bilerek yok.** Bir systemd birimini sertleştirirken insanların
ilk eklediği satır, ve V8'in JIT'ini sessizce bozuyor: daemon başlar, tuhaf davranır,
hiçbir şey sebebini söylemez. Bir testle sabitlendi, çünkü bu dosyayı sertleştirmeye
gelecek bir sonraki kişi ona uzanacak.

**"Linger" yapılmıyor, raporlanıyor.** Onsuz `--user` birimi son oturum kapanınca duruyor.
Açmak genelde polkit doğrulaması istiyor, ve kullanıcının ayrıcalıklı olmasını istemediği
bir kurulum sırasında kimlik doğrulama penceresi açan araç, kaldırılan araçtır. Kurulum
durumu söylüyor ve komutu yazıyor.

---

## Gizlilik: kural değil, tek bir geçit

Gizlilik sözü ancak tek bir yerden geçiyorsa tutulur. "Şunu loglama" bir sözleşmedir ve
sözleşmeyi hatırlayan tutar; bir sonraki satırı ekleyen kişi hatırlamaz. Bu turda üç yer
sözleşmeye bırakılmıştı ve üçü de sızdırıyordu.

**Ajanın serbest metni artık motorun içinde redakte ediliyor.** `ai-title` ajanın tura
verdiği ad, `last-prompt` ise düpedüz senin yazdığın istem. İkisi de hiçbir yerde
redaksiyondan geçmiyordu ve panel `leadTitle`'ı ham basıyordu. Şimdi redaksiyon
`tail.ts`'te, metnin sürece girdiği tek noktada — çünkü bu string'i üç yüzey çiziyor,
dördüncüsü de çizecek, ve unutan yüzey bir anahtarı ekran paylaşımının üstündeki pencereye
koyan yüzey olur. Uzunluk da orada 140 karaktere iniyor: aynı string hem 400 piksellik bir
satıra hem bir veritabanı sütununa gidiyor.

**Günlük artık kendi kuralını uyguluyor.** `log.ts`'in başındaki yorum "istem, transcript
metni, dosya içeriği asla loglanmaz" diyordu ve dosya redakte edilmeden yazılıyordu. İki
yerde zaten kırılmıştı, ikisi de aynı hata: bir dosya sistemi hatasında `String(err)`, ve
hook'tan gelen ajan hata metni. İkisi de istem değil, ikisi de istem taşıyabiliyor. Şimdi
redaksiyon `log()`'un içinde, her satırın geçtiği tek noktada. Maliyeti çalıştırma başına
birkaç satırda bir regex; alternatifi, bir sonraki `log` çağrısına kadar geçerli bir
garanti.

Aynı gerekçeyle tarama hatası da saklanmadan önce redakte ediliyor: `#lastError` string'i
`/health` ile sunuluyor, `vt doctor` basıyor ve insanlar issue'ya yapıştırıyor.

**Ve token adres çubuğunda durmuyor.** Tarayıcıya kimlik bilgisi vermenin tek yolu bir
bağlantı, o yüzden `vt daemon` `?t=<token>` yazdırıyor; kaçınılmaz olan bu. Kaçınılabilir
olan onun orada *kalması*: sorgu dizesi pencere başlığı oluyor, geçmiş kaydı oluyor,
"son kapatılanlar" oluyor — ve fark edilme sebebi de bu: ekran görüntüsü alındığında ya da
ekran paylaşıldığında karede o duruyor. Sayfa token'ı sunucudan gömülü olarak zaten
aldığı için sorgu ilk isteğiyle işini bitirmiş oluyor; `history.replaceState` ile siliniyor.
`pushState` değil — geri tuşunun seni token taşıyan bir URL'e götürmesi bütün noktayı
ortadan kaldırırdı.

## Ne okunur, ne okunmaz

Okunanlar, tamamı salt-okunur:

- `$CLAUDE_CONFIG_DIR` (yoksa `~/.claude`) altında: `sessions/*.json`, `ide/*.lock`,
  `projects/*/*.jsonl` (yalnızca sınırlı pencereler)
- Proje dizinlerinde `git` komutları — hepsi `--no-optional-locks` ile, hiçbiri yazmaz
- `package.json` / `Cargo.toml` / `pyproject.toml` (yalnızca proje adı için)

Yazılanlar: kendi veri dizinimizdeki veritabanı ve `daemon.log` (prompt, kod ve transcript
metni **asla** loglanmaz), bir de `--html`/`--json` ile açıkça istediğin dosya.

Ajan durum dizininde **hiçbir şey silinmez veya değiştirilmez.** Oradaki transcript'ler
yeri doldurulamaz.

---

## Testler

```bash
pnpm test        # node --test, harici bağımlılık yok
pnpm typecheck
```

144 test, sekiz başlıkta. Beşi kendini çoktan amorti etti:

**Offset devamlılığı.** Büyüyen bir transcript rastgele parça sınırlarında okunuyor —
sınırlar bilerek hem UTF-8 dizilerinin hem JSON satırlarının ortasına düşürülüyor — ve sonuç,
bitmiş dosyanın tek geçişte okunmasıyla **birebir aynı** olmak zorunda. Yanında: yarım
satırın asla ayrıştırılmaması, sıkıştırma ile küçülen dosyanın yeniden yazım sayılması,
8 MB'ı aşan boşluğun okunmak yerine atlanıp **raporlanması**.

**Senin dosyan bozulmuyor.** JSON düzenleyici testleri yorumların, boş satırların, sekme
girintisinin, kaçış dizilerinin ve sarkan virgüllerin hepsini koruyor; bozuk bir dosya
**reddediliyor, asla üzerine yazılmıyor**. Kurulum/kaldırma turu sonunda dosya anlamca
başlangıç hâline dönüyor.

**Sır sızmıyor.** Bir test hook yükündeki sahte anahtarın sakladığımız duruma sızdığını
yakaladı — o yüzden redaksiyon hattı bu aşamada yazıldı. Test artık hem saklanan durumu hem
panele giden kanıt satırlarını kontrol ediyor.

**Ajan olmadan da kanıtlanıyor.** Sentetik ortam üreteci CI'da gerçek baytlar üretiyor:
PID geri dönüşümü için gerçekten süreç açıyor (kayıt dosyaları `<pid>.json` diye
adlandırıldığı için bir PID bir kayıt demek — sahte iki canlı oturum mümkün değil), ve
canlı girdilere süreçlerin **gerçek** başlangıç zamanını yazıyor. Uydurma değerlerle her
karşılaştırma ıskalıyordu ve toplu sezgi — doğru biçimde — "biçim değişmiş" deyip korumayı
kapatıyordu; kendi güvenlik ağını tetikleyen bir fixture, kurulma amacını hiç test etmez.

Seyrek 600 MB transcript diskte birkaç KB tutuyor (NTFS'te `fsutil sparse setflag`
olmadan gerçekten 600 MB yer kaplıyordu). Okuyucunun taramak yerine seek ettiğini
kanıtlıyor — taransaydı test dakikalarca sürerdi.

**Tuzaklar geri gelmiyor.** Faz motorunun altın-dosya testleri, gerçek belgelerin
sanitize edilmiş yeniden kurulumları: hepsi-işaretli günlük, rakip matrisi, ve ikisini
birden içeren gerçek bir plan (o plan sayılmalı, ama yalnızca kendi durum sütunundan).
Yanında çekimli faz atıfları, tek başlıkta iki faz, kendi lejantını tanımlayan belge ve
`İPTAL`/`IPTAL`/`ıptal`'in aynı şeye katlanması.

**Yapılandırma kilitlemiyor.** TOML ayrıştırıcısının testleri iki şeyi kanıtlıyor: sözdizimi
hatası daemon'ı durdurmuyor (varsayılana düşüp satır numarasını söylüyor), ve `[server]`
bölümünün ikinci kez yazılması **sessizce birleşmiyor** — hata veriyor. İkincisi, insanın
"ayarı değiştirdim ama hiçbir şey olmadı" diye saatler harcadığı sınıftan bir hata.
`[privacy]` altındaki bilinmeyen anahtar ölümcül, başka her yerde uyarı: `redcation` yazım
hatası kimseyi kapalı sandığı bir korumayla baş başa bırakmamalı.

**Şablon kendi ayrıştırıcısından geçiyor.** `vt init`'in yazdığı örnek config, yazılmadan
önce doğrulanıyor — kendi ayrıştırıcısının reddettiği bir başlangıç dosyası her yeni
kullanıcıda "bozuk kurulum" gibi görünürdü.

## Çeviri: kaynak metnin kendisi anahtar

`t('doctor.node.label')` + katalog tasarımı reddedildi. Çevrilmemiş bir satır
`doctor.node.label` diye görünür ve okunmaz olur; burada anahtar Türkçe cümlenin
kendisi olduğu için **eksik çeviri gerçek bir cümleye düşer**. Cümleyi düzenlemek
çeviriyi yapısal olarak geçersiz kılar — kimliğin metinden kayması mümkün değil.

Kapsam iddia değil, **test**: kaynak statik olarak taranır, istenen her anahtar
katalogda olmak zorundadır. Yeni bir metin çevrilmeden derleme kırılır ve çevrilecek
metni aynen basar.

```bash
VT_I18N_REPORT=eksik.json vt --lang en status   # çalıştırdığın komutun eksikleri
```

Motorun ürettiği cümleler `{key, args}` olarak dolaşır (`phrase.ts`). `6/20 madde ·
docs/33_plan.md · dün` bitmiş bir cümle olarak taşınsaydı her proje kendi katalog
anahtarını üretirdi ve hiçbir çevirmen listeyi bitiremezdi. Aynı yapı HTTP API'sinde de
duruyor: istemci parçaları ayrı ayrı biçimlendirebilir, dosya adını bağlantıya çevirebilir.

Yol boyunca iki gerçek tuzak çıktı. **Bayrakları çevirmek risk skorunu bozuyordu** —
`attentionScore` `f.startsWith('kirli-sel')` ile eşleşiyor, yani bayraklar hem metin hem
mantık anahtarı; artık kimlik olarak dolaşıp yalnızca gösterildikleri yerde çevriliyorlar.
Ve yardım metnini bir tabloya taşıyıp `tr(değişken)` çağırmak **statik tarayıcıdan
görünmez** oldu: kapsam testi geçti, `--lang en` altında her satır Türkçe basıldı.
Göremediğin bir aramanın bozuk olduğunu kimse fark etmez.

## Görünmez karakterler bir stil sorunu değil

`backfill.ts` içinde iki haritanın anahtarından birinde boşluğun yerine **ham bir NUL**
vardı. Ekranda iki satır aynıydı, ikinci geçişteki her arama ıskalıyordu, beslediği sayaç
sessizce sıfırda kalıyordu. Diff'te, incelemede, terminalde görünen hiçbir şey yoktu.

Artık bir test var: hiçbir kaynak dosya kontrol karakteri ya da BOM içeremez; gerektiğinde
kaçış dizisi (`'\u0000'`) yazılır. Aynı test, ANSI renk kodlarındaki üç ham ESC baytını da
ilk çalıştırmada yakaladı.

## Bir bakışta: projeye tek satır

Ayrıntılı kart *"tam olarak ne oluyor"* sorusunu cevaplıyor. Günde yirmi kez sorulan soru
o değil: **bir şey beni mi bekliyor?** Onun cevabı proje başına dört satır okumayı
gerektirmemeli.

```
  VibeTracker · 6 bekliyor · 8 canlı ajan · 4 proje

  ⏸ Saspera      4 bekliyor  —            ███·······   %34   1sa 48dk
  ⏸ AgentWorld   1 bekliyor  —            ██████····   %55    8dk 10sn
  ⏸ VRTwin       1 bekliyor  —            ███████···   %68    6g 21sa
  ▶ VibeTracker  —           1 çalışıyor  ··········     —

  ayrıntı: vt status --full
```

Sıralama tercih değil kural: **bekleyen, çalışanın üstündedir.** Bekleme, kullanıcının
zamanını harcayan durumdur. Panelde satıra tıklayınca eski kartın tamamı açılır.

**Bekleyen ve çalışan ayrı iki sütun, ikisi de her zaman yazılı.** Önce tek bir durum adı
yazılıp yanına `canlı/toplam` konuyordu; o çift ekranda `çalışan/toplam` diye okunuyordu —
istenen biçim buydu — ama anlamı "yaşayan/görülen"di. Üç oturumu kullanıcıyı bekleyen ve
biri hâlâ çalışan bir proje `3 bekliyor  5/5` diyordu ve geri kalan ikisinin nereye
gittiğini okuyucuya bırakıyordu. Bekliyor ve çalışıyor aynı anda doğru olan iki olgu,
birbirinin alternatifi değil. Sıfır boş bırakılmaz, `—` çizilir: boş bir sütunla bozuk bir
çizim ekranda aynı görünür.

Özet mantığı `core` içinde tek yerde duruyor ve bir test panelin JavaScript'ini Node
içinde çalıştırıp aynı verilerle iki tarafı karşılaştırıyor. Aynı proje için terminalin
ve panelin farklı sayı göstermesi, ikisinden birinin yanlış olmasından daha kötüdür:
ikisine de olan güveni bitirir.

### Konuşmayan bir PID yeterince konuşmuştur

Koruma bir vakayı kaçırıyordu ve kaçırdığı vaka, geri dönüşün en olası olduğu
vakaydı.

PID 8084 `c:\dev\VRTwin` içindeki bir Claude Code oturumuna aitti. Altı gün sonra
o numarayı `fontdrvhost.exe` almıştı — başka bir kullanıcı adına çalışan bir süreç,
ve bize başlangıç zamanını **söylemiyor**. Sonda boş bir dize döndürüyor, koruma
bunu "karşılaştıracak bir şey yok" diye okuyor ve `live` diyordu. Altı gündür kapalı
bir proje panelde `1 bekliyor` yazıyordu.

Okunamayan bir başlangıç zamanı eksik kanıt değildir. Ajan kullanıcı adına çalışır,
yani kendi süreci her zaman cevap verir; sessizlik, o PID'in artık başkasına ait
olduğunu söyler. Aynı toplu kural burada da geçerli: sessizlik ancak sonda **bazı**
başlangıç zamanlarını okuyabildiğinde kanıt sayılır, böylece bu yeteneğini tümden
kaybetmiş bir sonda her oturumu ölü ilan etmek yerine `live`'a düşer.

Ölçülen sonuç: 59 kayıt → 51 süreç yok, 7 eşleşti, **1 okunamıyor**. Tek bir satır
değişti ve o satır yanlış olandı.

## İzlenecek projeleri seçmek

Her şeyi izlemek doğru varsayılan, yanlış kalıcı durum. Bir ay ajan çalıştırmış bir
makinede deneme klonları, tek öğleden sonralık fikirler ve scratch dizinleri birikir;
hepsini gösteren bir pano kimsenin okumadığı bir panodur.

```bash
vt projects                 # ne var, hangisi izleniyor
vt projects add VRTwin      # izlemeye al
vt projects rm Prime        # izlemeden çıkar
vt projects all             # hepsine dön
```

Panelde de **izlenecekleri seç** düğmesi var — ikisi de aynı config dosyasını yazar, aynı
yorumları koruyarak, çünkü post-it penceresine bakarken bir projeyi gizlemek için
terminale gitmek zorunda kalmak o pencerenin varlık sebebini boşa çıkarır.

Tek mod, tek liste. `all` her şeyi gösterir; `selected` yalnızca listedekini. `all`
modundayken bir projeyi çıkarmak **"kalanları seç"** demektir — aynı karar tek bir
sözlükle ifade edilir. İkinci bir `hidden` listesi olsaydı, bir ad iki listeye birden
girdiği anda ikisi çelişirdi. Ve mod değişimi ekrana yazılır: "artık yalnızca seçtiklerin
gösterilecek" cümlesini bastırıp kullanıcıyı diğer projelerin nereye gittiğini merak
ederken bırakmak bir tuzak olurdu.

Seçim yalnızca listeyi değil **alarmı da** filtreler. İzlemediğin bir projedeki bekleyen
ajan "seni bekleyen" sayısını yükseltmez — yükseltseydi, seçim listede işe yarayıp
bildirimde yaramazdı, ki insanı asıl bölen kısım bildirimdir.

İzlenmeyen proje rapordan silinmiyor: `vt projects` seçecek bir şey bulabilsin diye orada
duruyor, ama plan belgeleri okunmuyor. Taramanın en pahalı işi odur; izlemediğin proje
neredeyse bedavaya gelir.

## Post-it: ekranın köşesinde duran pencere

Okumak için pencere değiştirmen gereken bir izleyici, okumayı bıraktığın izleyicidir.

```bash
vt mini                     # üstte kalan küçük pencere
vt mini shade               # tek satırlık şerit
vt mini badge               # 84x84 rozet: sadece sayı
vt mini unpin               # kapat
```

Şeritteki `+` izlenecek projeleri seçtiriyor; aynı işi terminalde `vt projects add`,
panelde "izlenecekleri seç" yapıyor ve üçü de aynı yapılandırma dosyasını yazıyor.
Şeritteki `♪` beklemeye geçişleri sesli söylüyor — varsayılan kapalı, bkz. aşağısı.

```bash
vt projects                 # ne var, hangisi izleniyor
vt projects add VRTwin      # ada göre
vt projects add c:/dev/Foo  # ajanın hiç açmadığı bir dizin
vt projects rm Prime
vt projects all             # seçimi bırak, hepsine dön
```

Üç boyut, Winamp'ın sözlüğüyle: **liste**, **şerit** (windowshade) ve **rozet**. Sağ tık
her yerde sırayla değiştirir, boşluk tuşu da aynı işi yapar, ve **rozete tıklamak listeyi
geri getirir**. Pencerenin tamamı sürüklenebilir — çerçeve yokken "tutulacak tek yeri"
aramak zorunda kalmak tasarım hatasıdır. Sağ alt köşedeki üç tırtık genişliği ayarlar;
yükseklik proje sayısını izler, çünkü son satırın altındaki boşluk "devamı var" demektir.

**Rozetten çıkış tek yönlü bir kapıydı.** Çıkış yolu çift tıklamaydı ve hiç çalışmıyordu:
sürükleme için basış `WM_NCLBUTTONDOWN` ile pencere yöneticisine devrediliyor, o da
`DefWindowProc` içinde modal bir döngü açıyor ve çift tıklamanın *ikinci* tıklamasını
yutuyor. Geriye sadece hiçbir yerde yazmayan sağ tık kalıyordu — yani rozet, fareyle
girilip fareyle çıkılamayan bir durumdu. Artık rozet elle sürükleniyor: basış kaydediliyor,
hareket varsa pencere taşınıyor, hareket yoksa bırakış bir tıklamadır ve liste geri gelir.
Rozetin köşelerindeki iki küçük ayraç da bunu söylüyor — "bu bir resim değil, katlanmış bir
pencere".

**Satırlar ölçülmüş tek bir ızgaraya çiziliyor.** Her hücre bir öncekinin genişliğine göre,
satır satır yerleştiriliyordu; bu ızgara değil. `3 bekliyor` ile `çalışıyor` farklı
genişlikte, dolayısıyla her satır sayılarını biraz başka yere koyuyor ve göz her satırda
sütunu yeniden arıyordu. Artık her boyama başında sütunların en geniş hücresi ölçülüyor ve
bütün satırlar aynı koordinatlara çiziliyor — her boyamada, çünkü kelimeler sayıya ve dile
göre değişir. Dikey hizalama da öyle: üç ayrı yazı tipi ancak her biri kendi ölçülen
yüksekliğine göre ortalanırsa aynı çizgiye oturur.

Ölçek de bir gramer: **dolu bloklar sayılmış bir sayıdır, içi boş bloklar tahmin, kesikli
boş kanal ise "kimse ölçmedi"** — ki bu "henüz hiçbir şey bitmedi"den farklı bir cümledir.
Üçünü aynı çizmek, panelin üzerindeki her sayı doğruyken panelin bir bakışta yalan
söylemesinin yoludur.

### Satırın kendisi: aksan çubuğu, iz, ve nabız

Satır artık dört şey söylüyor ve üçü kelimesiz.

**Sol kenardaki aksan çubuğu** satırın rengini taşıyor — masanın öbür ucundan görünen tek
şey o, ve pencereyi üste sabitlemenin değerinin çoğu orada. Bekleyen bir projede **nefes
alıyor**; izin kapısında bekleyen bir projede daha derin ve kırmızı. "Bekliyor" böylece
tek kelime okumadan anlaşılıyor.

**Ad ile sayıların arasındaki iz** son yirmi dört dakika: dakika başına bir nokta, o dakika
içinde bu projede meşgul olan en fazla oturum sayısı. Sayılar *şu an* ne olduğunu söylüyor;
bir projenin yoğun mu geçtiğini yoksa öylece durduğunu mu söyleyemiyorlar, ve bağırmayan
projeler hakkında bilmek isteyeceğin şeyin çoğu bu.

İzin tek gerçek iddiası boşluklarla ilgili. Daemon yeniden başlayınca geçmiş sıfırlanır;
o dakikaları sıfır çizmek, projenin hiç oturmadığı bir zemini uydurmak olurdu — gözün
anında okuduğu ve doğrulayamadığı bir yalan. Onun için **izlenmemiş dakikalar çizilmiyor**,
yerlerine ölçeklerin kullandığı kesikli kanal geçiyor. Eksen daima yirmi dört dakika:
elindeki geçmiş kadar kısalan bir zaman ekseni iki satırı karşılaştırılamaz hâle getirirdi.
Tek bir gözlenmiş dakika sıfır uzunlukta bir çizgidir ve hiç çizilmez — o yüzden oraya bir
çentik konuyor, çünkü "bir kez baktık" ile "hiç bakmadık" farklı cümleler.

Seri daemon'da tutuluyor, pencerede değil; `vt status` tek seferlik bir okuyucudur,
geçmişi yoktur, ve o alan onda **yok** — sıfırlarla doldurulmuş değil. Bellekte, diskte
değil: yarım saatlik bir şeyi kalıcı kılmak bir şema, bir saklama kuralı ve bir göç demek.

**Ölçekteki gezinen parıltı** tek süsleme, ve yalnızca *zaten yanmış* bloklarda geziyor:
bir çubuğu canlı gösterebilir, uzun gösteremez.

Nabız bedava değil, o yüzden koşulu var: **bekleyen ya da çalışan hiçbir şey yoksa pencere
hiç boyanmıyor.** Editörünün üstünde durup canlı görünmek için bir çekirdek yakan bir
pencere, duran bir pencereden kötüdür.

### Üstteki şerit: sistem yükü, genel yüzde değil

Şeritteki çubuk **canlı oturumların ne kadarının meşgul olduğunu** söylüyor — çalışan yeşil,
bekleyen amber, aynı çubukta iki uzunluk olarak. "Hepsi çalışıyor" ile "hepsi bloke" aynı
yüktür ve zıt durumlardır; tek sayı bunları ayıramaz, çubuk ayırmak zorunda.

Bilerek projelerin yüzdelerinin ortalaması **değil**. Planlar büyüyerek yazılır, dolayısıyla
o ortalama iş yapılırken düşer — proje başına yüzdelerden bir milestone boyunca sökülen
hatanın ta kendisi. Canlı oturum yoksa çubuk kesikli ve boş, sayı `—`: ölçmediğimiz bir
boşluğu sıfır diye çizmek gene aynı yalan olurdu.

Hesap motorda, saydığı sayıların yanında (`summarizeBoard`). Terminal, panel ve pencere
onu aynen basıyor.

### Satırı açmak: ajan ne yapıyor

Soldaki `>` işareti satırı açıyor: altında **o projenin en öncelikli oturumunun ne yaptığı**
yazıyor. Satırda genişliği olmayan tek bilgi bu, ve bir proje amber'a döndüğü anda insanın
istediği şey de tam bu.

O metin ajanın serbest yazısı — `ai-title` ajanın tura verdiği ad, `last-prompt` ise
düpedüz senin yazdığın. **Redaksiyon artık motorun içinde, metnin sürece girdiği tek
noktada** yapılıyor: üç yüzey bu metni çiziyor ve dördüncüsü de çizecek, ve unutan yüzey
bir API anahtarını ekran paylaşımının üstündeki pencereye koyan yüzey olur. Uzunluk da
orada sınırlanıyor (140 karakter), çünkü aynı string hem 400 piksellik bir satıra hem bir
veritabanı sütununa gidiyor.

**Proje seçimi pencerenin içinde.** Şeritteki `+` düğmesi listeyi seçim kipine
çeviriyor: her satır bir proje, işaretliyse izleniyor, tıklayınca değişiyor ve
**o anda kaydediliyor** — bu pencerede diyalog kutusuna yer yok, kaydedilmemiş
durum tutmaya da niyeti yok. Seçim bitince `+` yerine geçen ✓ listeye döndürüyor.

Aday listesi panelden değil daemon'dan geliyor, ve bu bir ayrıntı değil: pano
yalnızca *çalışan* projeleri taşır, oysa eklemek isteyeceğin proje genellikle az önce
kapattığındır.

**Liste nereden çıkıyor.** Oturum kaydı yetmiyor — bu makinede 59 kayıt vardı ve
yalnızca 6 projeye işaret ediyordu. Asıl envanter transcript dizininde: `projects/`
altında 30 klasör, 23'ü hâlâ bir yol bildiriyor, temp/kopya ayıklanınca 11 gerçek
proje. Klasör adı kullanılamıyor — mutlak yolun alfanümerik olmayan her karakteri
değişmiş, 200 karakteri aşınca kesilip hash eklenmiş, ve büyük-küçük harfi bile
stabil değil (`c--dev-VibeTracker` ile `C--dev-probros` yan yana duruyor). O yüzden
yol, transcript'in kendi `cwd` alanından okunuyor: klasör başına tek dosyanın ilk
32 KB'ı, `cwd` taşıyan ilk satırda duruluyor. En yeni transcript 518 MB; bu
fonksiyonun tüm amacı proje başına birkaç kilobayt harcamak. Ölçülen: 23 proje
12 ms, kimlik çözümüyle birlikte 11 proje 914 ms — daemon başına bir kez.

Hiç canlı görülmemiş projeler `last_seen_at = 0` ile en alta düşüyor; tohumlama
mevcut satırların tarihine dokunmuyor, yoksa her daemon yeniden başlatması aylardır
kapalı bir projeyi listenin başına taşırdı.

**Ajanın hiç açmadığı bir proje.** Transcript'i olmayan bir depo bu listeye
giremez — klasör adından yol geri üretilemiyor, ve üretmeye çalışmak yanlış yol
üretir. Onun için tek yol açıkça söylemek.

Seçicinin başında duran **`+ klasör seç`** satırı bunu yapıyor: sistemin kendi klasör
diyaloğunu açıyor, seçtiğin dizini `POST /api/v1/projects/path` ile daemon'a veriyor.
Terminalde aynı şey `vt projects add c:/dev/Foo`.

**Diyalog `FolderBrowserDialog` değil.** .NET Framework'ün o sınıfı Windows 2000'in ağacını
açıyor: adres çubuğu yok, arama yok, son kullanılanlar yok, ve **elindeki yolu yapıştıracak
bir yer yok** — insanların gerçekte yaptığı şey tam da bu. Bir stil şikâyeti değil yani;
diyalog işi yapamıyor. Diğer bütün uygulamaların gösterdiği pencere `IFileOpenDialog` +
`FOS_PICKFOLDERS`; Vista'dan beri var, .NET Framework hiç açığa çıkarmadı, .NET Core'un
`AutoUpgradeEnabled`'ı ise her Windows'ta hazır duran çalışma zamanı için çok geç geldi.
O yüzden arayüz elle bildiriliyor: seksen satır interop, **sıfır bağımlılık** — kabuk zaten
orada.

Elle yazılan bir COM arayüzünde yanlış yapmanın tek yolu sessiz: arayüz bir fonksiyon
işaretçisi dizisidir, çağırmadığın bir metodu atlamak onu kaldırmaz, **sonraki her metodu
bir yanlış yuvaya kaydırır**. Bu dosyayı hiçbir şey tip denetiminden geçirmediği için
vtable bir testle sabitlendi: `Show` sıfırıncı, `GetResult` on yedinci, toplam yirmi altı.

`FOS_FORCEFILESYSTEM` de bilerek: onsuz kabuk kütüphaneleri ve bulut konumlarını da
döndürüyor, ikisi de taramanın ziyaret edebileceği bir dizin değil.

**Yolu pencere çözmüyor, daemon çözüyor.** Kimlik bir `git rev-list` ve bir paket dosyası
okuması; bunu istemcide tekrarlamak, iki kopyası asla olmaması gereken kuralın ikinci
uygulaması olurdu. Pencere yalnızca hangi klasörü seçtiğini söylüyor, karşılığında proje
kimliğini ve adını alıyor, şeritte "eklendi" yazıyor. Uç nokta `tracking`'den ayrı duruyor
çünkü hata biçimleri ayrı: "böyle bir dizin yok" 404, "yapılandırma yazılamadı" 500 —
ikisini karıştırmak, kullanıcının yazım hatasını düzeltmesi ile hata bildirmesi arasındaki
farkı siler.

Yol `[projects."<id>"] path` olarak yazılıyor ve tarama onu her seferinde ziyaret ediyor;
proje panoda `kapalı` görünüyor ama fazı ve yüzdesi okunuyor. Yazma sırası da bilerek:
önce yol, sonra izleme listesi — tersi, projeyi bu makinede hiçbir şeyin dizine
çeviremeyeceği bir kimlikle izlemek olurdu.

**Ve pencere diyalog açıkken üstte kalmayı bırakıyor.** Sahiplik yetmiyor: bu pencerenin
sahiplediği bir diyalog sıradan z sırasında onun üstünde durur, ama `TopMost` demek
`WS_EX_TOPMOST` demek ve o sahipliği ezer. Seçici **notun arkasında** açılıyordu, not da
ona giden tıklamaları yutmaya devam ediyordu — bu test edilirken iki proje tam olarak böyle
sessizce izlemeden çıktı. `finally` ile geri alınıyor; editörünün altında kalan bir not,
tek işini yapmayı bırakmış bir nottur.

**Disk taranmıyor** — plan bunu açıkça yasaklıyor; buraya yalnızca senin gösterdiğin dizin
giriyor. Bilinen tek pürüz: bir projeyi izlemeyi bırakmak `[projects]` altındaki `path`
satırını silmiyor. Zararsız — proje panodan çıkıyor, kimlik önbellekte olduğu için git
yeniden yoklanmıyor — ama yapılandırma zaten insan elinin düzenlemesi için TOML;
temizlemek isteyen bir satır siliyor.

`tracked` bilgisini de daemon veriyor, istemci hesaplamıyor: cevap izleme *kipine*
bağlı ve yalnızca panoyu gören bir istemci "seçtiğim için izleniyor" ile "her şey
izlendiği için izleniyor"u ayırt edemez. Bunu yanlış tahmin eden bir seçici,
dokunduğun anda seçimini bozar.

**Ve pencere seçim listesini değil, değişikliği gönderiyor.** `POST /api/v1/tracking`
iki biçim alıyor: tüm listeyi bildiren `{mode, selected}` ve tek bir değişikliği
bildiren `{add, remove}`. Kısmi görüşü olan bir istemci — 340 pikselde sığdığı kadarını
listeleyen bir pencere, altmış satırda kesilen bir seçici — ikincisini kullanmak
zorunda: gördüğü kümeyi tüm gerçek diye göndermek, göstermediği her projeyi sessizce
izlemeden çıkarır. Daemon deltayı yapılandırmadaki güncel hâlin üstüne uyguluyor,
üstelik dosyayı yeniden okuyarak: `#tracking` zamanlayıcıyla tazelenen bir kopya ve
aynı saniyedeki iki tık aynı bayat kümeden başlayıp ikincisi birinciyi silerdi.

Ve **elle seçilmiş bir proje, hiçbir ajanı çalışmasa da listede kalıyor** — `kapalı`
yazarak. Seçmek bir eylem hâline geldiğinde liste süreç tablosunun değil senin olmalı;
eklediğin projenin sessizce kaybolması, seçimin işleyip işlemediğini merak ettirir.
`all` kipinde böyle bir şey yok, çünkü orada onurlandırılacak bir seçim de yok:
o kipte pano "ne çalışıyorsa o"dur ve öyle kalmalı, aksi hâlde açılmış her dizin
sonsuza kadar birikir.

**Neden tarayıcı penceresi değil.** İlk hâli Chromium'un `--app` kipiydi ve üstte
tutuluyordu, ama tepesinde tarayıcının kendi başlık çubuğu vardı. O çubuk kaldırılamıyor:
Chromium onu istemci alanının içine kendisi çiziyor. `WS_CAPTION` sökmek hiçbir şeyi
değiştirmedi, pencereyi çerçevesiz bir forma yeniden ebeveynlemek de siyah ekran verdi.
İkisi de denendi, ikisi de ölçüldü. 32 piksellik tarayıcı başlığı 84 piksellik bir rozetin
üstünde zaten saçma olurdu — yani "ikon boyutuna küçülme" isteği tek başına tarayıcıyı
eliyor.

Geriye kendi penceremiz kalıyor. WinForms zaten her Windows'ta var, dolayısıyla sahip
olmak **hiçbir bağımlılık eklemiyor**. Electron ve Tauri gerçek bir pencere verirdi ama
ikisi de sıfır bağımlılığı götürürdü; Tauri zaten kendi milestone'u.

**Pencerenin içinde mantık yok.** `/api/v1/overview`'i çiziyor, o kadar. Ekrandaki her
sayı — bir projenin ajanları ne yapıyor, ne kadar ilerlemiş, izleniyor mu — motorda
hesaplanıp aynen basılıyor. Kural değişince tek yerde değişiyor ve pencere düzenlenmeden
uyuyor. Bunu bir test koruyor: `note.ps1` içinde `WAITING_PERMISSION` gibi bir durum adı
geçerse test kırılıyor, çünkü o an pencere kendi kararını vermeye başlamış demektir.

Gördüğü **her kelime dışarıdan geliyor.** PowerShell 5.1 BOM'suz bir `.ps1`'i sistem
kod sayfasıyla okuyor, yani script'in içine yazılmış bir "çalışıyor" ekranda bozuk çıkıyor
— ilk çalıştırmada tam olarak bu oldu. BOM eklemek görünmez-karakter kuralını çiğnerdi,
o yüzden kural ters çevrildi: **script saf ASCII**, kelimeler çalışma anında JSON olarak
veriliyor. Bir test bunu da ölçüyor.

Aynı tuzağın ikinci hâli: `ToUpperInvariant()` Türkçe "bekliyor"u noktasız I'yla
"BEKLIYOR" yapıyordu. Başlık artık hiç büyütülmüyor.

**Başlatmak da düz değildi.** `spawn(..., { detached: true })` ile açılan PowerShell,
`vt mini` biter bitmez ilk satırını bile çalıştıramadan ölüyordu — konsolu bizimle
paylaştığı için. `detached` ile `windowsHide` Windows'ta çelişen şeyler istiyor. Çözüm
PowerShell'in kendi `Start-Process -PassThru`'su: gerçek ayrılma, ve geri dönen pid
sayesinde pencere sonradan kapatılabiliyor.

### Sesli haber: durum değil, geçiş

Pencere zaten "geçiş yapmadan bakabildiğin yüzey"; ses de ekrana hiç bakmadığın saniyeler
için aynı fikir. Şeritteki `♪` açıyor, seçim `note-window.json`'da kalıyor.

Söylenen cümle katalogdan geliyor, pencerede kurulmuyor: proje adının arkasına
`beklemeye geçti` ekleniyor — İngilizcede `is now waiting for you`. Ad iki dilde de aynı
yere düşüyor, düşmeyen bir dil de etrafından çevirebilir. Kurulu seslerden dilin kültürüne
uyanı seçiyor; yoksa sistemin varsayılanıyla okuyor — hangi seslerin kurulu olduğu
kullanıcının işi, bizim değil.

Gürültüye dönüşmesini engelleyen üç kural var, ve üçü de rahatsız edici olmanın üç ayrı
yolu:

- **Durum değil geçiş söyleniyor.** Bir saattir bloke olan proje sessiz; yalnızca bekleyen
  sayısı *arttığında* konuşuyor.
- **İlk yoklamada hiçbir şey söylenmiyor.** Karşılaştıracak bir şey yokken her şey bir
  geçiştir; bu kural olmadan pencere her açılışta bütün panoyu okurdu.
- **İkiden fazlası bir sayıya iniyor.** Arka arkaya beş proje adı dinlemek kimsenin
  istediği şey değil.

Varsayılanı kapalı, çünkü ilk çalıştırmada konuşmaya başlayan bir pencere kaldırılan bir
penceredir. Ses motoru yoksa, ses yoksa, aygıt kilitliyse — üçü de burada aynı anlama
geliyor: pencere pencere olmaya devam ediyor, düğme kendini kapatıyor.

### Türkçe konuşabilmesi: doğru motoru seçmek, sonra dürüst düşmek

İlk sürüm `System.Speech` (SAPI5) kullanıyordu — .NET Framework'ün parçası, sıfır
bağımlılık. Sorun şu ki **kullanıcının Türkçe kurmak için yapacağı şey, o motorun
göremediği bir ses üretiyor.** *Ayarlar → Saat ve dil → Konuşma* üzerinden kurulan sesler
`HKLM\...\Speech_OneCore\Voices\Tokens` altına yazılıyor; SAPI5 yalnızca
`...\Speech\Voices\Tokens`'ı okuyor. Bu makinede ölçüldü: **SAPI5 iki ses görüyor, WinRT
üç** — aynı ikisi artı bir. Aradaki o bir ses, farkın kozmetik olmadığının kanıtı.

O yüzden motor değişti. Artık önce `Windows.Media.SpeechSynthesis` deneniyor, SAPI5 yedek
kalıyor — hem WinRT projeksiyonunun bulunmadığı makineler için, hem de yalnızca eski
kayda yazan üçüncü parti sesler için. WinRT'ye PowerShell'in kendi tip projeksiyonuyla
gidiliyor (`[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media,
ContentType = WindowsRuntime]`), C# bloğundan değil: `Add-Type`'a Windows metadata'sını
tanıtmak gerekirdi, bu yolda derlenecek bir şey yok.

Ölçülen maliyet: motor kurulumu 229 ms (bir kez, tembel), cümle sentezi **25 ms**,
çalmaya başlama 103 ms. Sentez beklenerek yapılıyor, `ContinueWith` ile değil — 25 ms için
kendi runspace'inde çalışan bir devam bloğu, kazandığından fazlasını götürürdü.

**Ses hangisi olacak?** Önce Windows'un varsayılanı, eğer o zaten doğru dili konuşuyorsa:
varsayılan atayan kişinin bir sebebi vardı ve bir dilde birden fazla ses olabilir. Yoksa
o dili konuşan ilk ses.

**Hiçbiri o dili konuşmuyorsa cümle dil değiştiriyor, ses değiştirmiyor.** Bu turun asıl
kararı bu. Türkçe bilmeyen bir ses Türkçe okumayı reddetmiyor — İngilizce fonetikle
okuyor, ve çıkan şey yazıldığı aksanla okunmuş İngilizce cümleden kötü. O yüzden pencereye
iki dil birden veriliyor (`speakWaiting` ve `speakWaitingAlt`), ve kurulu ses hangisini
telaffuz edebiliyorsa o söyleniyor. Arayüz Türkçe kalıyor; yalnızca söylenen satır
kayıyor, ve yalnızca onu taşıyacak ses olmadığı için.

Kararı pencere veriyor, CLI değil: kurulu seslerin listesini yalnızca o taraf görüyor.

`♪` düğmesini açtığında şerit hangi sesin cevap verdiğini yazıyor — `Microsoft David - dil
eşleşmedi` gibi. Sesi açıp yanlış aksan duymak, kullanıcının bunu sorduğu tek an.
`vt doctor` da aynı şeyi kalıcı olarak raporluyor, iki kaydın sayılarıyla birlikte:

```
! Sesli haber   tr sesi yok — cümle en olarak Microsoft David ile okunuyor
                · winrt · WinRT 3 / SAPI5 2 ses
                → Ayarlar → Saat ve dil → Konuşma üzerinden tr sesi ekle.
```

O `WinRT 3 / SAPI5 2` bilerek orada: kurduğun sesin kullandığımız motora görünür,
.NET'in getirdiği motora görünmez olduğunu söyleyen tek sayı o.

**Ses indirmiyoruz.** Hangi seslerin kurulu olduğu Windows'ta verilen bir karar; bir izleme
aracının konuşma paketi indirmesi tam olarak yapmaması gereken şey. Yaptığımız şey hatanın
sessiz kalmamasını sağlamak — İngilizce bir sesin okuduğu Türkçe yeterince anlaşılır
olduğu için, eşleşen bir sesin mevcut olduğunu kullanıcı hiç fark etmeyebilir.

Bu, penceredeki tek "kendi kararı", ve bilerek öyle. Geçişi daemon da biliyor
(`store.apply` zaten durum değişimlerini üretiyor) ama olayı anlık bir yüke koymak, iki
istemcinin aynı şeyi iki kez söylemesi ya da hiç söylememesi demekti. Ses, sürekli açık
duran yüzeyin işi, ve o yüzey bu pencere.

Windows dışında `vt mini` tarayıcı penceresine düşüyor ve bunu satır satır söylüyor.

## Diğer ajanlar: bir okuyucu, altı ajan, tek durum makinesi

Claude Code'un yanına Codex, opencode, Kilo, Cline, Gemini ve editör çatalları
(VS Code/Copilot, Cursor, Antigravity, Trae, Windsurf, VSCodium) eklendi. Hepsi
`[agents] enabled` ile açılıp kapanıyor; varsayılan `all`, yani durum dizini olan her ajan
— Codex'i ve VibeTracker'ı aynı makineye kuran kişi bunu bir şeyi yapılandırmak için
yapmadı.

**Adaptörün tek işi `TranscriptFacts` üretmek.** Durumu `deriveState` karar veriyor,
bir kez, hepsi için. Bu, altı ajanın tek panoyu paylaşabilmesinin tek sebebi: her adaptör
kendi durumlarına karar verse "bekliyor" altı ayrı şey demeye başlar, sistem yükü şeridi
birbiriyle kıyaslanamayan sayıları toplar, ve durum makinesinin öğrendiği her kural (tur
sahipliği CPU'yu yenor; bir aracın süresi hangi araç olduğuna bağlı; bir geçişe inanmak
için 20 saniye) her ajan için yeniden, kötü biçimde öğrenilir.

Kimlik, workspace gruplama, izleme filtresi, sistem yükü ve faz motoru birleşmiş liste
üzerinde koşuyor. "Bu projede iki ajan var" hiçbir yerde özel bir durum değil — panoda
`codex + claude-code` diye görünüyor ve satırdaki rozet hangisinin hangisi olduğunu
söylüyor.

### Ne okunabildi, ve nerede durdu

| Ajan | Oturum | Canlılık | Tur durumu | Açık araç |
|---|---|---|---|---|
| Claude Code | kayıt defteri | **pid + başlangıç zamanı** | ✅ | ✅ |
| **Codex** | 231 rollout JSONL | son yazma (pid yok) | ✅ | ✅ |
| **opencode / Kilo** | SQLite (66 oturum) | son yazma (pid yok) | ✅ | ✅ |
| **Cline** | oturum tablosu + log | **pid** | ❌ | ❌ |
| Gemini | — | — | ❌ | ❌ |
| Editörler | — | — | ❌ | ❌ |

**Codex'te hiçbir yerde pid yok.** `session_meta`'da değil, dosyanın hiçbir yerinde değil
— en yeni rollout'un 400 satırı arandı. Cazip çözüm — çalışan bir `codex` süreci bulup
komut satırını okumak — reddedildi: komut satırları API anahtarı taşıyor, süreç sondası
`CommandLine`'ı bilerek hiç seçmiyor, ve tek iddiası "sırlarını tutmuyorum" olan bir araçta
canlılığı bir kimlik bilgisiyle satın almak kötü bir takas olurdu.

O yüzden bu iki ajan için "canlı", **beyan edilmiş bir pencere**: son 90 saniye içinde bir
şey yazdı. Bir dakika önce kapattığın oturum pencerenin sonuna kadar canlı görünmeye devam
eder. Güven bu yüzden 0.55'e kapılıyor — panelin "emin değil" eşiğinin altına, yani ekrana
ikinci bir kurala ihtiyaç duymadan taralı olarak çıkıyor — ve kanıt satırı sebebini
yazıyor: `canlılık:son yazmaya dayanıyor (pid yok, pencere 1dk 30sn)`. Pencerenin genişliği
`[thresholds] agent_recency_sec`, çünkü bir olgu değil, bir itiraf.

Okunabilen şey **tur sahipliği**, ve tam olarak okunuyor. Codex'te `task_started` turu
açıyor, `task_complete` kapatıyor; `turn_aborted` da kapatıyor, çünkü iş bittiğinde de
durduğunda da sonuç aynı: sen bir şey yapana kadar hiçbir şey olmayacak. Bitmemiş
`function_call` / `custom_tool_call` kayıtları `call_id` ile açık araç veriyor.

### Aynı disiplin, kopyalanmadan paylaşıldı

Codex'in en büyük rollout dosyası **778 MB**. Claude Code'un transcript'lerine uygulanan
offset disiplini (dosya başına kalıcı tanıtıcı, okumadan önce `fstat`, 8 MB'lık yetişme
sınırı, taşınan kısmi satır, asla satır sonundan öteye kod çözmemek) ikinci kez yazılmadı:
`TailReader` satır yorumlayıcısı bakımından parametreleştirildi. Paylaşılan şey ayrıştırma
değil — her ajanın kayıtları farklı — disiplinin kendisi. İkinci bir uygulaması, aynı
hataların ikinci bir takımı olurdu.

Ölçüldü: 778 MB dosyanın kuyruğu **1–5 ms**, RSS artışı yok.

### Gerçek veride bulunan üç tuzak

**opencode'un `session.time_updated`'ı yalan söylüyor.** 66 oturumun hepsi aynı değeri
taşıyor (`1787041061504`) — hepsine aynı anda dokunan bir göç. Buna dayanan bir pano bütün
geçmişi "şu an aktif" diye gösterirdi. Aktivite `max(message.time_created)`'dan alınıyor,
gerçekten hareket eden şeyden.

**`session.permission` bir istek değil, bir politika.** `[{"permission":"task","action":
"deny"}]` gibi bir JSON dizisi. "Onay bekliyor" diye okumak 66 oturumun 54'ünü kırmızı
yakardı. Ayrı bir `permission` tablosu var ve boş; dolduğunda bakılacak yer o.

**Codex `c:\GDEV\x` ve `C:\GDEV\x` yazıyor, Gemini yolları küçük harfe indiriyor.** Aynı
depo, farklı yazım. Git kök commit'i bunu zaten çözüyordu ama `path:` kimliği çözmüyordu:
`realpath` Windows'ta harf büyüklüğünü düzeltmiyor — ona ne verirsen onu döndürüyor — ve
çıktısını hash'lemek bir dizine iki kimlik veriyordu. Panoda `projectbsh` ve `ProjectBSH`
diye iki satır olarak görüldü. Artık katlanmış anahtar hash'leniyor; `pathKey` Linux'ta
katlamayı zaten reddediyor, çünkü orada iki yazım gerçekten iki dizin.

### Editörler oturum değil, klasör veriyor — ve bu bilerek

`workspaceStorage/<hash>/workspace.json` her açılmış pencere için bir `file://` URI'si
tutuyor. Bu makinede: Code 59, Antigravity 30, Trae 15, Cursor 10 — toplam **117 klasör.**
Bunları pano satırına çevirmek, gerçekten çalıştığın beş projeyi bir kez açtığın yüz
projenin altına gömerdi, ve o satırların her biri var olmayan bir oturum olurdu.

O yüzden seçiciye giriyorlar: "buralarda çalışmışsın, izlemek ister misin". Bir editörde
açık olan klasör gerçek ve faydalı bir olgu. Oturum başka bir iddia ve bunların hiçbiri
onu taşıyamıyor.

Konuşmalar gerçekten `state.vscdb`'de duruyor — Cursor `composer.composerData`,
`aiService.generations`, `workbench.panel.composerChatViewPane.<uuid>` tutuyor. Okunabilir
ve bilerek okunmuyor: anahtarlar belgesiz, çatal başına farklı, habersiz değişiyor, ve
hepsi konuşma metni blob'u — yani bu aracın kopyalamadığı şeyin ta kendisi. O yolla alınan
tur durumu, panodaki en kırılgan ve en az özel veri olurdu.

Seçicinin kapsamı buna bağlı: `vt projects` artık yalnızca Codex'te çalıştığın bir projeyi
de listeliyor. Elle koşulan bir komut olduğu için maliyeti karşılayabiliyor — Codex'in 231
rollout'u için ~200 ms, editörler için 117 `workspace.json` okuması. Poll döngüsü bunu asla
yapmıyor.

### Dürüst kalan boşluklar

**Cline'ın oturum tablosu bu makinede boş.** Şema okundu — `pid`, `started_at`, `ended_at`,
`status`, `cwd`, `workspace_root`, `parent_session_id` — ve okuyucu ona karşı yazıldı, ama
**canlı satırlarla hiç sınanmadı**. Yetenek matrisi `sessions` diyor; kolonlar pratikte
başka türlü doluysa ilk güvenilmeyecek yer burası. Doğrulanan şey yedeği:
`data/logs/cline.log` satır başına bir JSON nesnesi tutuyor ve içindeki pid süreç
sondasına veriliyor — süreci gitmiş bir çalıştırma gitmiş olarak raporlanıyor.

**Kilo kurulu ama hiç kullanılmamış.** Şeması opencode'un aynısı, aynı okuyucu ona da
bakıyor. Buradaki ayrım önemliydi: mesaj sayısına bakmak "hiç kullanılmamış" ile "şema
değişti"yi ayırt edemiyor, ve henüz aracı çalıştırmamış birinin önüne korkutucu bir uyarı
koymak susmaktan kötü. Ayrım artık oturum sayısı: oturum var ve mesaj yoksa sapma, ikisi de
yoksa yalnızca kullanılmamış.

**opencode'un `todo` tablosu okunmuyor.** Herhangi bir ajanın sunduğu en iyi ilerleme
kaynağı — makine doğrulamalı, `completed/in_progress/pending`. Yetenek olarak
*iddia edilmiyor*, çünkü onu tüketecek yer faz motorunun sağlayıcı kayıt defteri ve o
bağlanmadan önce raporlamak bir olgu değil bir vaat olurdu.

**Ajan adaptörü olmayan bir durum dizini bulunursa `vt doctor` onu adıyla listeliyor.**
Ajan listesi açık uçlu, ve birini sessizce yok saymak bir aracın kapsamı hakkında yalan
söylemeye başlama biçimidir.

---

## Masaüstü uygulaması

Tepsi simgesi, yerel bildirim ve bir daemon süpervizörü — bir tarayıcı sekmesinin
veremediği üç şey. Gösterdiği her sayıyı motor hesaplıyor ve açtığı pencere daemon'ın
kendi panosu; not penceresinin kuralı burada da geçerli: **motor karar verir, yüzey
çizer.** Bir URL'nin etrafına sarılmış kabuk olsaydı var olmasının sebebi olmazdı.

Kabuk Tauri 2, ve derlenmiş hâli **4,4 MB**. Windows kurulumu 23,5 MB.

### Node pakete giriyor — ama tek dosya olarak derlenmiş hâlde değil

Masaüstü sürümünün varlık sebebi, Node'u olmayan ve olmak zorunda kalmaması gereken
kişi. Yani çalışma zamanı paketle gelmek zorunda. Bunun standart yolu `node:sea` ile
tek dosyalık bir yürütülebilir üretmek, ve o yol bakıldıktan sonra bırakıldı.

SEA tek bir CommonJS dosyası istiyor, yani bir bundler. Bu depoda derleme adımı yok ve
bundler yok; masaüstü çıktısını üretmek için bir tane eklemek, **kullanıcının çalıştırdığı
şeyin testlerin hiç görmediği bir araç zinciri tarafından birleştirilmesi** demekti — yani
ürünün test edilenden farklı davranmasının ikinci bir yolu. Node zaten TypeScript'i
doğrudan çalıştırdığı için kaynakları taşımak hem daha basit hem test edilene daha yakın.

Boyut zaten değişmiyordu: `node.exe` 85,6 MB, kaynaklar 960 KB. Baskın olan çalışma
zamanı. NSIS onu 23,5 MB'a sıkıştırıyor.

Apache-2.0 altında kaynakların uygulamanın içinde okunabilir hâlde durması bir sızıntı
değil, bir özellik: paketin ne yaptığını merak eden `resources/runtime/` altına bakabilir.

**Tek bir dönüşüm var, ve sebebi şu:** Node, `node_modules` altındaki hiçbir dosyada tip
silmiyor — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, ve bu bilinçli bir politika,
hata değil. Yani paketler `@vibetracker/core`'un çözümleneceği yere konamıyor ve o ad
göreli bir yola çevrilmek zorunda. Test edilenle sevk edilen arasındaki fark bu kadar, ve
sınırları belli: 99 paketler-arası içe aktarımın hepsi alt yol içermeyen düz
`@vibetracker/<ad>`, ve ağaçtaki her dinamik `import()` ya `node:` ya göreli. Aşama
betiği bunu doğruluyor — çözümlenmemiş tek bir ad kalırsa derleme duruyor, çünkü o hata
ancak kullanıcının makinesinde, uygulamayı açtığı anda görünürdü.

### Simge kodla çiziliyor

`scripts/make-icon.mjs` bir PNG kodlayıcı (`node:zlib` ile kırk satır), bir ICO ve bir
ICNS konteyneri. Bağımlılığı olmadığı iddiasındaki bir depoya görüntü kütüphanesi
eklemekten ucuz, ve simgeyi **diff'lenebilir** yapıyor: işareti değiştirmek bir kod
incelemesi, kimsenin içini göremediği bir ikili dosya değil.

Çizdiği şey panonun kendisi: üç satır, biri bekliyor. Aracın cevapladığı soru "beni
bekleyen bir şey var mı", ve cevabı diğerleri sönükken yanan bir satır.

### İmzalanmamış, ve bu söyleniyor

Paketler kod imzalı değil. Windows SmartScreen uyarısı gösterecek, macOS Gatekeeper
doğrudan açtırmayacak. Sertifika gerektiriyor, sertifika bir kimlik ve ücretli bir program
gerektiriyor — ikisi de bakımcının kararı. Yayın notlarında yazıyor; gizlenecek bir şey
değil, eksik bir şey.

### Üç platformda derlemek

Tauri güvenilir biçimde çapraz derlemiyor: paket biçimi, simge konteyneri, webview
bağlaması ve imzalama hikâyesi platform başına ayrı. `.github/workflows/release.yml`
her birini kendi koşucusunda derliyor — Windows, macOS (Apple Silicon ve Intel), Linux.

Bu bir kolaylık değil: **macOS ve Linux çıktılarının var olmasının ve sınanmasının tek
yolu orası**, çünkü bu satırların yazıldığı makine Windows.

---

## Sırada ne var

`~/.claude/plans/` altındaki plan dokümanına göre: ~~M1 pasif daemon + canlı panel~~,
~~M2 hook'lar ve gerçek "izin bekliyor" tespiti~~, ~~M3 faz/ilerleme motoru~~,
~~M4 ürünleştirme~~, **M5 LLM özeti** (adaptörler kısmı yapıldı), M6 macOS/Linux,
M7 masaüstü kabuk.

M5'in adaptör yarısı kapandı: Codex, opencode/Kilo, Cline gerçek okuma; Gemini ve altı
editör çatalı klasör listesi. Kalan M5 işi LLM özet motoru, dikkat sıralaması ve
`vt open` pencere odaklama.

M3 ve M4'ten devreden ne varsa kapandı:

- **i18n tamam.** Arayüzün tamamı iki dilli; 680+ çeviri. Kapsam testle ölçülüyor,
  yeni bir metin çevrilmeden derleme kırılıyor. Bu tur kapı **panele de** genişletildi:
  `.html` taranmıyordu, yani "çevrilmemiş metin derlemeyi kırar" dört yüzeyin üçü için
  doğruydu — tam olarak bu testin engellemek için var olduğu türde bir yarım iddia. Bir
  de adaptör notları serbest metinden koda çevrildi: `tr(detect.note)` statik çıkarıcıya
  görünmez, yani İngilizce kullanıcıya Türkçe metin gider ve hiçbir şey kırılmazdı.
- **D1–D6 çalışıyor.** D4 (faz "bitti" ama ağaç kirli), D5 (sayı haftalardır sabit ama
  çalışma sürüyor) ve D6 (dal, hiçbir planda olmayan bir basamak adlandırıyor) eklendi.
  D5 geçmiş gerektirdiği için yalnızca daemon'da ateşlenir; tek seferlik `vt status`
  tahmin yürütmek yerine susar.
- **Geri doldurma ve faz panosu** hazır: `vt board`, ayrıca panelde kart başına
  açılan bir bölüm ve `/api/v1/board`.
- **`dialects/` registry'si** veri dosyasına çıkarıldı; sürüm aralığı eşleşmesi ve
  %5 bilinmeyen-satır eşiğiyle sapma raporu var.
- **Sentetik ortam üreteci + CI matrisi** yazıldı: üç OS × iki Node sürümü, `alpine`
  (musl), `tr_TR.UTF-8`, `inotify` kıtlığı, tarball denetimi, i18n kapsamı.
- **Proje seçimi, yalın liste ve post-it penceresi** eklendi; `vt daemon stop` ile
  daemon artık kurulduğu araçla durdurulabiliyor.
- **Yerel pencere** (`vt mini`): çerçevesiz, üstte kalan, üç boyutlu bir okuma paneli.
  Sıfır bağımlılık — WinForms zaten kurulu.

**Lisans seçildi: Apache-2.0.** MIT'de olmayan iki maddesi burada değerli. 5. madde,
gönderilen katkıyı ayrı bir sözleşme olmadan aynı lisansın altına alıyor. Ve açık patent
bağışı, başkalarının dosya formatlarını okuyan bir araç için gerçek bir koruma.

Katkı için **CLA değil DCO** — commit'e `-s` ile eklenen tek satırlık bir beyan.
Bunun bir bedeli var ve `CONTRIBUTING.md`'de açıkça yazılı: telif hakları bakımcıda
toplanmadığı için proje ileride yeniden lisanslanamaz ve ikili lisans yapılamaz. Bir
gözlemci aracın katkı önündeki engeli, ileride ticarileştirme esnekliğinden daha pahalı
görüldü.

`NOTICE` pakete giriyor, çünkü Apache-2.0 §4(d) onu yeniden dağıtanlardan istiyor — ve
hiç göndermediğimiz bir dosyayı taşıyamazlar. İçinde "resmî olmayan araç" beyanı ve
ürünün *yapmadığı* şeylerin listesi var; bunlar özellik değil garanti, ve onları kaldıran
bir çatalın bunu bilerek yapması gerekiyor.

`npm publish` engeli kalktı. CI'daki adım da tersine döndü: artık "yayın engellendi mi"
değil, "sevk edilen şey iddia ettiği lisansı gerçekten taşıyor mu" diye soruyor. Metadata'sı
Apache-2.0 diyen ve tarball'ında LICENSE olmayan bir paket, lisansı hiç olmayandan
kötüdür.

M2'de kalan tek doğrulanmamış halka: hook'lar **kendi makinemde gerçek bir Claude Code
oturumuyla** çalıştırılmadı. Yazdığımız ayarı ajanın kendisi kabul ediyor (`claude doctor`
temiz), alım hattı gerçek yük şekilleriyle uçtan uca test edildi — ama "ajan gerçekten POST
ediyor mu" adımı, hook'ları senin global ayarına kurmayı gerektiriyor ve o senin kararın.

---

Anthropic, OpenAI, Google, Microsoft veya Cursor ile ilişkili değildir.
