const MAX_CONCURRENT = 6;
const FETCH_TIMEOUT_MS = 10000;

async function checkUrlStatus(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal
    });
    // Bazı sunucular HEAD isteğini desteklemez, GET ile tekrar dene
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
      });
    }
    return res.status;
  } catch (err) {
    return null; // ağ hatası / CORS engeli — 404 olarak sayılmaz
  } finally {
    clearTimeout(timeout);
  }
}

async function checkLinks(urls, tabId) {
  const results = [];
  let index = 0;
  let completed = 0;

  async function worker() {
    while (index < urls.length) {
      const current = urls[index++];
      const status = await checkUrlStatus(current);
      results.push({ url: current, status });
      completed++;
      // Panel içindeki ilerleme çubuğunun canlı güncellenmesi için her tamamlanan
      // istekte içerik betiğine ilerleme bildirimi gönderilir.
      if (tabId !== undefined) {
        chrome.tabs.sendMessage(
          tabId,
          { type: 'SCAN_PROGRESS', completed, total: urls.length },
          () => {
            if (chrome.runtime.lastError) {
              // sekme kapanmış veya içerik betiği yüklenmemiş olabilir — yok say
            }
          }
        );
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT, urls.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function updateBadge(tabId, brokenCount) {
  if (tabId === undefined || tabId < 0) return;
  if (brokenCount > 0) {
    chrome.action.setBadgeText({ tabId, text: String(brokenCount) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  } else {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
}

// Kırmızı çarpıyla kapatılan sekmeleri hatırlar (chrome.storage.session kullanılır ki
// service worker uykuya dalıp yeniden başlasa bile bilgi kaybolmasın; tarayıcı kapanınca
// otomatik temizlenir). Böylece F5 ile sayfa yenilense bile kutucuklar geri gelmez —
// yalnızca uzantı ikonuna tekrar tıklandığında geri gelir.
async function isTabDismissed(tabId) {
  const data = await chrome.storage.session.get('dismissedTabs');
  return (data.dismissedTabs || []).includes(tabId);
}

async function setTabDismissed(tabId, value) {
  const data = await chrome.storage.session.get('dismissedTabs');
  let list = data.dismissedTabs || [];
  if (value) {
    if (!list.includes(tabId)) list.push(tabId);
  } else {
    list = list.filter((id) => id !== tabId);
  }
  await chrome.storage.session.set({ dismissedTabs: list });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'CHECK_LINKS') {
    const tabId = sender.tab && sender.tab.id;
    // Yeni tarama başlarken önceki sayfadan kalma rozeti hemen temizle,
    // aksi halde tarama bitene kadar eski sayı ekranda asılı kalır.
    updateBadge(tabId, 0);
    checkLinks(message.urls, tabId).then((results) => {
      // Rozet artık yalnızca 404'ü değil, tüm geçersiz (4xx/5xx) bağlantıları sayar.
      const invalidCount = results.filter(
        (r) => typeof r.status === 'number' && r.status >= 400
      ).length;
      updateBadge(tabId, invalidCount);
      sendResponse({ results });
    });
    return true; // asenkron sendResponse için kanalı açık tut
  }

  if (message && message.type === 'CHECK_DISMISSED') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined) {
      sendResponse({ dismissed: false });
      return true;
    }
    isTabDismissed(tabId).then((dismissed) => sendResponse({ dismissed }));
    return true;
  }

  if (message && message.type === 'SET_DISMISSED') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined) {
      sendResponse({ ok: true });
      return true;
    }
    setTabDismissed(tabId, !!message.value).then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setTabDismissed(tabId, false);
});

// Uzantı ikonuna tıklanınca sayfadaki büyük paneli aç/kapat.
// default_popup tanımlı olmadığı için bu olay her tıklamada tetiklenir.
// İkon tıklaması "bir dahaki kullanım" sinyalidir — kapatılmış durumu burada sıfırlanır.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id === undefined) return;
  setTabDismissed(tab.id, false).then(() => {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }, () => {
      if (chrome.runtime.lastError) {
        // İçerik betiği bu sayfada çalışmıyor olabilir (örn. chrome:// sayfaları) — yok say
      }
    });
  });
});
