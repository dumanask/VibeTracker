# Gizlilik

Tek sayfa, sade dil. Kural şu: **VibeTracker gözlemler, sürmez.**

## Neyi okur

| Ne | Nereden | Neden |
|---|---|---|
| Oturum kayıtları | `<ajanDizini>/sessions/*.json` | Hangi ajan gerçekten çalışıyor |
| Transcript **kuyruğu** | `<ajanDizini>/projects/<slug>/<sid>.jsonl` son 256 KB | Son aktivite, açık araç, başlık |
| IDE kilitleri | `<ajanDizini>/ide/*.lock` | Hangi pencere hangi projeye ait |
| Süreç tablosu | işletim sistemi | pid, ppid, başlangıç zamanı, CPU |
| git olguları | `git --no-optional-locks …` | dal, kirli sayısı, kök commit |
| Plan belgeleri | projendeki `docs/`, `plans/`, `*.md` | faz ve ilerleme |

`<ajanDizini>` = `$CLAUDE_CONFIG_DIR`, yoksa `~/.claude`.

## Neyi **asla** okumaz

- `.credentials.json` — bu dosya hiç açılmaz.
- Kaynak kodun. Plan belgeleri dışında hiçbir proje dosyası okunmaz.
- Süreçlerin **komut satırı**. Komut satırları API anahtarı taşır; pid, ppid ve
  başlangıç zamanı sorulan soruyu zaten cevaplıyor.

## Neyi **asla** yazmaz

- Projelerinin klasörlerine hiçbir şey. Tek bir dosya bile.
- Ajanın durum dizinine hiçbir şey. Orada hiçbir şey silinmez, değiştirilmez.
- Tek istisna: **senin onayınla** `<ajanDizini>/settings.json` içindeki hook
  girdileri. Önce diff gösterilir, sonra sorulur, yedek alınır, ve her girdi
  `"_vt": true` taşır ki kaldırırken seninkiler bozulmasın.

## Neyi saklar

Kendi veritabanında (`%LOCALAPPDATA%\VibeTracker` / `~/.local/share/vibetracker`):

- Oturum ve proje meta verisi, durum geçmişi, sayaçlar.
- Transcript metni için **yalnızca işaretçi**: dosya yolu, offset, uzunluk.
  Metnin kendisi kopyalanmaz — gerektiğinde dosyadan okunur.
- En fazla 280 karakterlik alıntılar ve 4 KB'lık olay yükleri; **yazılmadan
  önce redaksiyondan geçerler**.

Saklanmaz: transcript metni, araç çıktıları, dosya içerikleri, prompt'lar.

## Redaksiyon

Veritabanına yazılan ve süreçten çıkan her metin bir dedektör tablosundan geçer:
sağlayıcı anahtarları (`sk-ant-`, `sk-proj-`, `ghp_`, `AKIA…`, `AIza…`, `xoxb-`),
JWT, private key blokları, bağlantı dizeleri, `.env` satırları, `Bearer`/`Basic`
başlıkları ve ≥32 karakterlik yüksek entropili diziler. Çıktı
`«redacted:anthropic_key»` gibi **tip etiketli** yer tutucudur.

**Dürüst sınır:** redaksiyon yanlış negatif verir. Şirket içi özel bir token
formatı yakalanmaz. Bu yüzden tek savunma değildir — asıl savunma, dışarı hiçbir
şey göndermemektir. Kendi desenini `[privacy].custom_patterns` ile ekleyebilirsin.

## Ağ

Varsayılan kurulumda VibeTracker **ağa hiç çıkmaz**. Panel `127.0.0.1` üzerinde
dinler; `Host`/`Origin` beyaz listesi ve token zorunludur, CORS başlığı hiç
gönderilmez.

İki şey bunu değiştirebilir, ikisi de kapalı gelir ve ikisi de senin açık
kararınla açılır:

- `[server].bind` loopback dışına alınırsa panel yerel ağa açılır.
- `[digest].provider` `off` dışına alınırsa plan belgelerinin **özeti** seçtiğin
  sağlayıcıya gider. Gönderilmeden önce tam yük sana gösterilir; ham plan dosyası
  hiçbir zaman gönderilmez.

## Telemetri

Yok. `[privacy].telemetry` varsayılan `false` ve açılsa bile toplanan şey
sürüm, işletim sistemi, adaptör sayısı, hata sınıfı ve anonim bir kurulum
kimliğinden ibarettir. Asla: yol, proje adı, prompt, kod, dosya adı.

## Teşhis paketi

`vt doctor --bundle` bir GitHub issue'ya eklenebilecek dosya üretir. **Beyaz
listeyle** toplar — dizin taraması yapmaz. Yollar `<proj-1>` gibi takma adlara
dönüşür; yalnızca *şekli* korunur (derinlik, ASCII dışı karakter var mı, bulut
klasöründe mi). Dosya yazılmadan **önce** içindekiler ekrana listelenir ve onayın
istenir.

## Kaldırma

`vt uninstall` dokunulmuş olabilecek her yeri tek tek kontrol eder ve ne
yaptığını manifest olarak yazar. Ajan durum dizinine dokunulmaz.
