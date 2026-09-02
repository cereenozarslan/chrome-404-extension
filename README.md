# 404 Bağlantı Denetleyici

Ziyaret edilen sayfadaki `<img>`, `<script>`, `<link>` ve `<a>` kaynaklarını otomatik tarayan,
kırık/geçersiz bağlantıları tespit eden, sağ tarafı kaplayan büyük bir panelle kullanıcıyı
uyaran ve taranan bağlantıları sayfanın kendisi üzerinde renklendiren bir Chrome (Manifest V3)
uzantısı.

## Nasıl çalışır

1. Sayfa tamamen yüklendiğinde (`load` event) `content_script.js` otomatik çalışır.
2. Sayfadaki `img[src]`, `script[src]`, `link[href]`, `a[href]` kaynakları toplanır.
   - `<a href>` bağlantıları **her domainden** kontrol edilir (ör. bir Google arama sonucu
     sayfasındaki, başka sitelere giden linkler de dahil) — bir link denetleyicisinin amacı bu
     olduğu için domain sınırlaması uygulanmaz.
   - `<img>`, `<script>`, `<link>` kaynakları ise yalnızca **ziyaret edilen sitenin kendi
     domaininden** (ve alt alan adlarından) olanlar taranır; reklam ağları, analytics/izleyici
     script'leri gibi üçüncü taraf kaynaklar gereksiz yere taranmaz.
   - Aynı sayfa ziyaretinde aynı URL birden fazla kez kontrol edilmez (bir `Set` ile basit bir
     önbellek tutulur).
3. Toplanan URL listesi `background.js`'e (service worker) gönderilir. Arka plan betiği, aynı
   anda en fazla 6 istek olacak şekilde her URL'e `HEAD` (desteklemeyen sunucularda `GET`'e
   düşerek) isteği atar ve HTTP durum kodunu okur.
4. **Sağ tarafı kaplayan kayar panel** (Check My Links tarzı, kategorilere ayrılmış bir tasarımla):
   - **Uzantı ikonuna tıklandığında** (uzantının artık küçük bir popup'ı yoktur) panel **tarama
     bitmesini beklemeden hemen açılır** ve ilerleme çubuğuyla canlı olarak dolar; siz kapatana
     kadar ekranda kalır. Panel zaten açıksa tekrar tıklamak kapatır (aç-kapa anahtarı).
   - Sayfa yüklenirken otomatik taramada en az bir **geçersiz bağlantı** bulunursa panel
     kendiliğinden açılır (aksi halde arka planda sessizce tarar).
   - "Toplam kontrol edilen" ve "Son tarama" bilgileri artık **panelin kendi içinde**, üstteki
     ilerleme bölümünde gösterilir — ayrı bir kutucuk/pencere yoktur, her şey tek bir panelde
     toplanmıştır.
   - Panelin **sol üstünde macOS tarzı üç renkli düğme** bulunur, standart davranışlarla
     eşleşecek şekilde:
     - 🔴 Kırmızı → **Kapat** (panel tamamen kaybolur; bu sekmede siz uzantı ikonuna tekrar
       tıklayana kadar hiçbir şey otomatik görünmez/çalışmaz — bu tercih
       `chrome.storage.session`'da saklanır, `F5` ile sayfayı yenileseniz bile panel geri
       gelmez, yalnızca ikona tıklamak geri getirir)
     - 🟡 Sarı → **Küçült** (paneli sağ altta küçük bir çubuğa indirir; tekrar tıklayınca
       veya çubuğa tıklayınca normal boyuta döner)
     - 🟢 Yeşil → **Büyüt** (paneli genişletir; tekrar tıklayınca normale döner)
   - Panelin **sol kenarından** tutup sürükleyerek genişliğini daraltıp genişletebilir, **üst
     kenarından** tutup sürükleyerek de aşağı çekip yukarı uzatabilirsiniz (serbest boyutlandırma).
   - Panelin sağ üstünde bir **🌙/☀ koyu-açık mod anahtarı** bulunur.
   - Panelin üstünde tarama **ilerleme çubuğu** bulunur: Toplam kaynak sayısı, kuyrukta kalan
     istek sayısı ve tamamlanma yüzdesi taranırken canlı güncellenir; altında "Son tarama:
     SS:DD:ss" ve tamamlanma süresi gösterilir.
   - Altında dört renkli **kategori satırı** bulunur: 🟩 **Geçerli bağlantılar** (2xx), 🟢
     **Geçerli yönlendirmeler** (3xx, soluk yeşil), 🟧 **Uyarılar** (durum kodu okunamayan /
     ağ hatası veren istekler) ve 🟥 **Geçersiz bağlantılar** (4xx/5xx). Bir satıra tıklamak
     alttaki listeyi o kategoriyle filtreler; satırın sağındaki ⬇ ikonu yalnızca o kategoriyi
     `.txt` olarak indirir.
   - **Tümünü İndir** / **Tümünü Gör** / **Yenile** butonlarıyla sırasıyla tüm sonuçları dışa
     aktarabilir, listeyi genişletip daraltabilir veya sayfayı manuel olarak yeniden
     tarayabilirsiniz (Yenile önbelleği temizler, tüm kaynakları yeniden kontrol eder ve kısa
     süreliğine "Yenilendi ✓" gösterir).
   - Hatalı/uyarılı URL'ler listede **tıklanabilir** (yeni sekmede açılır) ve kategorisine göre
     renkli bir durum kodu rozetiyle gösterilir.
   - Altta **Nasıl Kullanılır** / **Hakkında** bağlantıları kısa bir yardım metnini panelin
     içinde açıp kapatır (harici bir bağlantıya gitmez).
5. **Sayfadaki bağlantı ve görsellerin kendisi de renklendirilir:** Taranan her `<a>` ve `<img>`
   öğesi, durum koduna göre doğrudan sayfa üzerinde işaretlenir — geçerli (2xx) yeşil, yönlendirme
   (3xx) soluk yeşil, uyarı (ağ hatası/okunamayan durum) sarı, geçersiz (4xx/5xx) kırmızı arka
   plan/anahat rengiyle vurgulanır (bir Google arama sonucu sayfasındaki dış bağlantılar dahil).
   Öğenin üzerine gelindiğinde `title` ipucunda durum kodu görünür.
6. Geçersiz (4xx/5xx) bağlantı bulunduğunda uzantı simgesinde kırmızı bir rozet (badge) sayı
   gösterir; yeni bir tarama başladığında eski rozet hemen temizlenir.
7. **Koyu mod**: panelin kendi anahtarı `chrome.storage.local` içindeki `lcTheme` değerini
   günceller; sayfa yenilendiğinde bu tercih hatırlanır. Panel bir **Shadow DOM** içine
   yerleştirilmiştir; bu sayede ziyaret edilen sitenin kendi CSS'i (özellikle `!important`
   kullanan agresif kurallar) koyu modun veya panelin görünümünü bozamaz — koyu mod her sitede
   güvenilir şekilde çalışır. (Sayfa üzerindeki bağlantı/görsel vurguları ise panelin dışında,
   doğrudan sayfanın kendi DOM'unda satır içi stillerle yapılır.)
8. **Bir 404 linkine tıklayıp yeni sekmede açtığınızda**: eğer açılan sayfanın kendisi
   gerçekten 404 (Bulunamadı) döndürüyorsa, sayfanın üst ortasında kırmızı bir "Bu sayfa 404
   (Bulunamadı) hatası döndürüyor" rozeti belirir (tarayıcının Navigation Timing API'sinden
   gelen gerçek HTTP durum koduna bakılarak). Rozet 6 saniye sonra kendiliğinden solar,
   üzerindeki ✕ ile hemen kapatılabilir.

## Dosyalar

- `manifest.json` — Manifest V3 tanımı ve izinler
- `icons/` — uzantı ikonu (kırmızı daire içinde kalın beyaz "404" yazısı), 16/48/128 boyutlarında
- `content_script.js` — kaynakları toplar/filtreler, sağ paneli ve sayfa üzerindeki
  renklendirmeyi yönetir
- `background.js` — service worker; fetch/HEAD kontrollerini yapar, ilerleme durumunu panele
  bildirir, badge günceller, ikon tıklamasını sayfadaki panele yönlendirir

Not: Uzantının ayrı bir popup ekranı yoktur — uzantı ikonuna tıklamak doğrudan sayfa üzerindeki
büyük paneli açar/kapatır.

## İzinler ve neden gerekliler

- `storage` — tema (koyu/açık mod) tercihini saklamak için.
- `host_permissions: ["<all_urls>"]` — iki nedenle gerekli:
  1. Content script'in **her sayfada otomatik** çalışabilmesi için.
  2. Arka plandaki `fetch` isteklerinin, **domain sınırı olmadan** (bağlantılar başka sitelere
     gidebildiği için) gerçek HTTP durum kodunu okuyabilmesi için — bu izin olmadan tarayıcı
     CORS nedeniyle çoğu çapraz-domain isteğin durumunu tamamen gizlerdi.

  `activeTab` veya `tabs` gibi ek izinler istenmedi.

## Sınırlamalar

- "Aynı site" tespiti basit bir sezgisel yönteme dayanır (ana domain + alt alan adları); çok
  nadir uç durumlarda (örn. ülkeye özel bileşik uzantılar) yanlış sınıflandırma olabilir.
- Bazı siteler `HEAD` isteklerini engelleyebilir ya da bot trafiğini limitleyip yanlış pozitif
  (örn. 403/429) verebilir; bu durumlar 404 olarak sayılmaz.
- Ağ hatası durumunda durum kodu okunamaz; bu URL'ler "bulunamadı" listesine dahil edilmez.
- `chrome://`, uzantı mağazası gibi Chrome'un iç sayfalarında içerik betiği çalışamadığından
  ikon tıklaması bu sayfalarda görünür bir etki yapmaz (Chrome kısıtlaması).

## Chrome'da yükleme ve test etme

1. Chrome'da adres çubuğuna `chrome://extensions` yazıp Enter'a basın.
2. Sağ üstteki **"Geliştirici modu" (Developer mode)** anahtarını açın.
3. Sol üstte beliren **"Paketlenmemiş öğe yükle" (Load unpacked)** butonuna tıklayın.
4. Açılan pencerede bu proje klasörünü (bu dosyanın bulunduğu klasör) seçin.
5. Uzantı listede kırmızı "404" ikonuyla görünecek; herhangi bir web sayfasını açın veya
   yenileyin (`F5`).
6. Sayfada geçersiz bir kaynak varsa sağ tarafı kaplayan panel otomatik açılır. Uzantı ikonuna
   tıklayarak paneli istediğiniz zaman **hemen** açıp kapatabilirsiniz (tarama bitmesini
   beklemeden ilerleme çubuğuyla birlikte açılır); panelin sol üstündeki kırmızı/sarı/yeşil
   düğmelerle kapatabilir, küçültebilir veya büyütebilirsiniz. Panelin sol kenarından
   genişliği, üst kenarından yüksekliği elle sürükleyerek de ayarlayabilirsiniz.
7. Panelin üstünde "Toplam", "Kuyrukta", "%" ve "Son tarama" bilgilerini, altında renkli
   kategori satırlarını görürsünüz; **Yenile** butonuna tıklayarak manuel yeniden tarama
   yapabilirsiniz.
8. Bozuk bir kaynağı kasıtlı test etmek isterseniz, konsoldan (F12 → Console) şu kodu
   çalıştırıp ardından panelin **Yenile** butonuna tıklayabilirsiniz:
   ```js
   const img = document.createElement('img');
   img.src = location.origin + '/bu-dosya-kesinlikle-yok-404.png';
   document.body.appendChild(img);
   ```
9. Kod değişikliği yaptıktan sonra `chrome://extensions` sayfasındaki yenile (↻) simgesine
   tıklayıp test ettiğiniz sekmeyi yeniden yüklemeyi unutmayın.
