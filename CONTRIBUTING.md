# Katkı

Türkçe kaynak dil, İngilizce çeviri. Issue ve PR ikisinde de açılabilir; kodun
içindeki yorumlar İngilizce.

---

## Lisans ve katkı hakları

Proje **Apache-2.0**. Katkı için ayrı bir sözleşme imzalaman gerekmiyor:
lisansın 5. maddesi zaten "aksini açıkça belirtmedikçe, gönderdiğin katkı bu
lisansın şartları altındadır" diyor. Bu, MIT'de olmayan bir madde ve burada
Apache'yi seçmenin sebeplerinden biri.

Bunun üstüne **DCO** (Developer Certificate of Origin) isteniyor, CLA değil.
Fark önemli: CLA, katkıcıdan telif haklarını devretmesini ya da geniş bir
lisans vermesini isteyen bir hukuki belgedir ve imzalatmak bir engeldir. DCO
ise commit'e eklenen tek satırlık bir beyandır — "bu kodu göndermeye hakkım
var" demektir.

```
git commit -s -m "codex: mcp araç çağrılarını kapat"
```

`-s` şu satırı ekler:

```
Signed-off-by: Adın Soyadın <eposta@example.com>
```

Metnin tamamı: <https://developercertificate.org/>

> **Bilerek kabul edilen sınır.** DCO ile katkıcılar telif haklarını sende
> toplamıyor. Yani proje ileride **yeniden lisanslanamaz** ve ikili lisans
> (açık çekirdek + ticari sürüm) yapılamaz — bunun için her katkıcının ayrı
> ayrı izni gerekir. Bu, CLA istememenin bedeli ve bilerek ödeniyor: bir
> gözlemci aracın katkı önündeki engeli, ileride ticarileştirme esnekliğinden
> daha pahalı.

---

## Kurulum

```bash
pnpm install          # tek bağımlılık ağacı; çalışma zamanı bağımlılığı yok
pnpm typecheck
pnpm test
node packages/cli/src/index.ts demo    # ajan kurulu olmayan makinede bile çalışır
```

Node **22.20+** gerekiyor: TypeScript kaynakları doğrudan çalıştırılıyor
(derleme adımı yok) ve `node:sqlite` bayraksız kullanılıyor.

Derleme adımı olmadığı için kod **"erasable syntax only"** olmak zorunda:
`enum`, `namespace`, parametre özelliği ve decorator yasak. `tsconfig` bunu
`erasableSyntaxOnly` ile zorluyor, yani unutursan typecheck kırılır.

---

## Neyin kod, neyin veri olduğu

Bu ayrım projenin belkemiği. Yanlış tarafa bir şey koymak, kabul edilmeyecek
tek yapısal hata.

| Dizin | İçerik | Neden veri |
|---|---|---|
| `packages/core/dialects/` | Ajanların dosya formatları | Format bize ait değil. Bir ajan sürümü alan adı değiştirdiğinde bu bir JSON yaması olmalı, kod yayını değil. |
| `packages/core/lexicons/` | Durum kelimeleri, doküman rolü ipuçları, soru göstergeleri | Ayrıştırma dilden bağımsız olmalı. Yeni bir dil desteklemek kod değiştirmeyi gerektirmemeli. |
| `packages/core/locales/` | Arayüz çevirileri | Bir çeviri düzeltmesi sürüm beklememeli. |

**Yeni bir dil eklemek** `lexicons/<kod>.json` + `locales/<kod>.json` demek,
TypeScript'e dokunmadan.

---

## Yeni bir ajan eklemek

`packages/engine/src/agents/` altına bir adaptör. Sözleşme `types.ts`'te ve
tek bir işi var: ajanın diske yazdığı ne varsa **`TranscriptFacts`** üretmek.

Durumu adaptör karar vermez. `deriveState` karar verir — bir kez, hepsi için.
Altı ajanın tek panoyu paylaşabilmesinin tek sebebi bu: her adaptör kendi
durumlarına karar verse "bekliyor" altı ayrı şey demeye başlar.

**Bir adaptörün yapamayacakları:**

- **Hiçbir şey yazmak.** Ne ajanın durum dizinine, ne projeye. Dosyalar
  salt-okunur açılır, SQLite `readOnly: true` ile — çalışan bir ajandan kilit
  alınmaz ve bozuk bir sayfa asla bizim suçumuz olamaz.
- **Serbest metin kopyalamak.** Başlık ve istem, sürece girdiği tek noktada
  `redactSnippet`'ten geçer. Mesaj gövdesi, araç girdisi ve araç çıktısı hiç
  okunmaz — sorgular okuyacakları kolonları adıyla sayar ve metin kolonları
  aralarında değildir.
- **Göremediğini iddia etmek.** `capabilities` dürüst cevaptır ve `vt doctor`
  onu basar. Canlı oturumu bitmiş olandan ayıramayan bir adaptör bunu söyler;
  pano da o satırı düşük güvenle, sebebini yazarak çizer.
- **Komut satırı okumak.** API anahtarı taşırlar. Süreç sondası `CommandLine`'ı
  bilerek hiç seçmez ve bu pazarlık konusu değildir.

Adaptörle birlikte gelmesi gerekenler: `packages/core/dialects/<ajan>.json`
(gözlenen sürüm `appliesTo` ile yazılı), ve `packages/engine/test/agents.test.ts`
içine gerçek şekillerden üretilmiş fixture'larla testler.

Formatı **gerçek dosyalardan** oku, tek bir oturumdan değil. Tek konuşma
yalnızca o an kullanılan araçları gösterir; ondan çıkarılan bir lehçe ikinci
dosyada kırılır.

---

## Yeni bir ilerleme sağlayıcısı

`ProgressProvider` (plan §F.2). Kişisel konvansiyonlar koda gömülmez,
sağlayıcı olur.

Buradaki tek kural: **saymadan önce dokümanın rolünü sınıflandır.** Gerçek
repolarda ölçülmüş iki tuzak var ve ikisi de golden-file testi olarak duruyor:

1. 100 işaretli / 0 işaretsiz bir "bugün ne yaptık" günlüğü. Naif sayaç
   "%100 bitti" der.
2. Rakip karşılaştırma tablosundaki ✅'ler. Rakibin özelliğini işaretliyor,
   senin ilerlemeni değil.

Bir sayı üretemiyorsan **üretme.** "—, bu bir changelog" faydalı bir cevaptır;
uydurulmuş bir %45 değildir.

---

## Test disiplini

`pnpm test` yeşil olmadan PR açma. Dört kapı özellikle önemli:

- **i18n kapsamı.** Kaynak metnin kendisi çeviri anahtarı. Yeni bir Türkçe
  metin `locales/en.json`'a girmeden derleme kırılır — `.ts` ve `.html`
  ikisi de taranır.
- **Kaynak hijyeni.** Görünmez kontrol karakteri yok, BOM yok, `.ps1`
  dosyaları saf ASCII (PowerShell 5.1 BOM'suz betiği sistem kod sayfası
  sanar ve Türkçe'yi bozar).
- **Golden-file ayrıştırıcı testleri.** Yukarıdaki iki tuzak.
- **Locale testleri** `tr-TR` altında koşar — noktalı/noktasız I tuzağı.

Ajan kurulu olmayan bir makinede test yazmak için `packages/fixtures`
sentetik ortam üreteci var; CI'nin tamamı onunla koşuyor.

---

## Ne kabul edilmez

Bunlar tercih değil, ürünün tanımı:

- **Ajanı sürmek.** VibeTracker gözlemler. Uzaktan izin onayı, komut gönderme,
  oturum başlatma — hepsi kapsam dışı ve kalıcı olarak öyle. Yazma yetkisi
  almak güven modelini bozar ve prompt injection'ı felakete çevirir.
- **Diski taramak.** Proje keşfi yalnızca ajanların zaten yazdığı `cwd`
  kayıtlarından ve senin elle gösterdiğin dizinlerden olur.
- **Uydurma sayı.** Bilinmeyen bir yüzde `—` olarak ve sebebiyle çizilir.
- **Sessiz bozulma.** Bir yetenek çalışmıyorsa panel bunu ve **sebebini**
  söyler: "hook kurmadın" ile "platform sınırı" farklı problemlerdir.

---

## Commit ve PR

- Commit mesajı ne yaptığını yazsın, hangi dosyaya dokunduğunu değil.
- `-s` ile imzala (DCO).
- Davranış değiştiren her PR bir test getirsin.
- Ölçüm yaptıysan sayıyı yaz. Bu depodaki yorumların çoğu bir ölçümü
  kaydediyor ("778 MB dosyanın kuyruğu 1–5 ms"), çünkü bir sonraki kişi o
  kararı ancak sayıyla yeniden değerlendirebilir.

---

## Güvenlik açıkları

Issue açma. `SECURITY.md`'deki kanalı kullan.
