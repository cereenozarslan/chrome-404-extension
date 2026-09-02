(function () {
  const PANEL_ID = '__lc_panel';
  const PAGEERROR_ID = '__lc_pageerror';
  const STYLE_ID = '__lc_style';
  const THEME_KEY = 'lcTheme';

  let checkedCache = new Set(); // aynı sayfa ziyaretinde aynı URL'yi tekrar kontrol etmemek için
  let isScanning = false;
  let currentTheme = 'light';
  let lastResults = null; // en son tarama sonucu (ikon tıklamasıyla yeniden taramadan göstermek için)
  let lastStats = null;
  let lastElapsedSec = '0';
  let lastScanTime = null; // en son taramanın tamamlandığı Date — panel içindeki "Son tarama" satırı için
  let scanStartTime = null;
  let shadowRoot = null;
  let dismissed = false; // kırmızı çarpıyla kapatıldı mı — kapalıyken hiçbir kutu görünmez
  let listFilter = 'problems'; // 'problems' | 'all' | 'valid' | 'redirect' | 'warning' | 'invalid'
  let helpOpen = null; // null | 'usage' | 'about'
  const urlStatusMap = new Map(); // url -> status (sayfa ziyareti boyunca birikir, vurgulama için kullanılır)

  // ---------- Shadow DOM kökü ----------
  // Panelin kendi stilleri, ziyaret edilen sitenin CSS'inden (ör. agresif !important
  // kuralları) etkilenmesin diye tamamen izole bir shadow DOM içine yerleştiriliyor.
  // Bu, koyu/açık mod gibi görsel özelliklerin her sitede güvenilir çalışmasını sağlar.
  function getRoot() {
    if (shadowRoot) return shadowRoot;
    const host = document.createElement('div');
    host.id = '__lc_host';
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({ mode: 'open' });
    return shadowRoot;
  }

  // ---------- Yardımcılar ----------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Tema (açık/koyu mod) ----------
  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    const root = getRoot();
    const panel = root.getElementById(PANEL_ID);
    if (panel) panel.classList.toggle('__lc_dark', currentTheme === 'dark');
    const themeBtn = panel && panel.querySelector('.__lc_theme_btn');
    if (themeBtn) themeBtn.textContent = currentTheme === 'dark' ? '☀' : '🌙';
  }

  function loadTheme(callback) {
    chrome.storage.local.get(THEME_KEY, (data) => {
      currentTheme = data[THEME_KEY] === 'dark' ? 'dark' : 'light';
      if (callback) callback();
    });
  }

  function toggleTheme() {
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ [THEME_KEY]: next });
    applyTheme(next);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_KEY]) {
      applyTheme(changes[THEME_KEY].newValue);
    }
  });

  // ---------- Aynı site kontrolü (reklam/üçüncü taraf domainlerini hariç tut) ----------
  function isSameSite(hostname) {
    const pageHost = location.hostname.replace(/^www\./, '');
    const resHost = hostname.replace(/^www\./, '');
    return (
      resHost === pageHost ||
      resHost.endsWith('.' + pageHost) ||
      pageHost.endsWith('.' + resHost)
    );
  }

  // ---------- Kaynak toplama ----------
  // allowCrossSite: <a> bağlantıları (Google arama sonuçları gibi başka domainlere giden
  // linkler dahil) her zaman kontrol edilir; img/script/link gibi sayfanın kendi kaynakları
  // ise yalnızca aynı sitedense kontrol edilir (reklam/analytics ağlarını taramaya dahil etmemek için).
  function isCheckableUrl(url, allowCrossSite) {
    try {
      const parsed = new URL(url, document.baseURI);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      // sadece sayfa içi çapa (#) olan linkleri atla
      if (parsed.hash && parsed.href.split('#')[0] === location.href.split('#')[0]) return false;
      if (!allowCrossSite && !isSameSite(parsed.hostname)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function collectResourceUrls() {
    const urls = new Set();
    const urlElements = new Map(); // url -> bu URL'i kullanan DOM elemanları (sayfa üzerinde vurgulamak için)
    const targets = [
      ['img[src]', 'src', false],
      ['script[src]', 'src', false],
      ['link[href]', 'href', false],
      ['a[href]', 'href', true]
    ];

    targets.forEach(([selector, prop, allowCrossSite]) => {
      document.querySelectorAll(selector).forEach((el) => {
        const value = el[prop];
        if (!value || !isCheckableUrl(value, allowCrossSite)) return;
        if (!urlElements.has(value)) urlElements.set(value, []);
        urlElements.get(value).push(el);
        if (checkedCache.has(value)) return;
        checkedCache.add(value);
        urls.add(value);
      });
    });

    return { urls: Array.from(urls), urlElements };
  }

  // ---------- Durum kodu -> kategori ----------
  function categoryForStatus(status) {
    if (typeof status !== 'number') return 'warning'; // ağ hatası / CORS / zaman aşımı
    if (status >= 200 && status < 300) return 'valid';
    if (status >= 300 && status < 400) return 'redirect';
    if (status >= 400) return 'invalid';
    return 'warning';
  }

  // Sayfa üzerindeki elemanları vurgularken kullanılan renkler — kalıcı yönlendirmeler (redirect)
  // isteğe göre "soluk yeşil" ile, geçerli sonuçlardan ayırt edilebilir şekilde işaretlenir.
  const HIGHLIGHT_COLORS = {
    valid: { bg: 'rgba(24,128,56,0.35)', outline: '#188038' },
    redirect: { bg: 'rgba(156,204,101,0.45)', outline: '#9ccc65' },
    warning: { bg: 'rgba(244,163,0,0.35)', outline: '#f4a300' },
    invalid: { bg: 'rgba(217,48,37,0.35)', outline: '#d93025' }
  };

  function computeStats(results) {
    const stats = { valid: 0, redirect: 0, warning: 0, invalid: 0, byCode: {} };
    results.forEach((r) => {
      const key = typeof r.status === 'number' ? String(r.status) : 'Ağ hatası';
      stats.byCode[key] = (stats.byCode[key] || 0) + 1;
      stats[categoryForStatus(r.status)]++;
    });
    return stats;
  }

  // Bir kategori rozetinin üzerine gelince hangi kodun kaç kez geçtiğini
  // (ör. "403: 98, 404: 2") gösteren araç ipucu metnini üretir.
  function categoryBreakdownTitle(stats, category) {
    return Object.keys(stats.byCode)
      .filter((key) => {
        if (key === 'Ağ hatası') return category === 'warning';
        const n = Number(key);
        return !Number.isNaN(n) && categoryForStatus(n) === category;
      })
      .sort((a, b) => stats.byCode[b] - stats.byCode[a])
      .map((key) => `${key}: ${stats.byCode[key]}`)
      .join(', ');
  }

  // ---------- Sayfa üzerindeki elemanları yeşil/kırmızı/soluk yeşil ile işaretleme ----------
  function highlightElement(el, category, status) {
    if (el.tagName !== 'A' && el.tagName !== 'IMG') return; // script/link görünmez, işaretlemenin anlamı yok
    const colors = HIGHLIGHT_COLORS[category];
    if (!colors) return;

    if (el.dataset.lcOrigTitle === undefined) {
      el.dataset.lcOrigTitle = el.getAttribute('title') || '';
    }
    const label = typeof status === 'number' ? String(status) : 'Ağ hatası';
    const orig = el.dataset.lcOrigTitle;
    el.setAttribute('title', orig ? `[${label}] ${orig}` : `Durum: ${label}`);
    el.setAttribute('data-lc-status', label);

    if (el.tagName === 'A') {
      el.style.setProperty('background-color', colors.bg, 'important');
      el.style.setProperty('border-radius', '3px', 'important');
      el.style.setProperty('box-decoration-break', 'clone', 'important');
      el.style.setProperty('-webkit-box-decoration-break', 'clone', 'important');
    } else {
      el.style.setProperty('outline', `3px solid ${colors.outline}`, 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
    }
  }

  function applyHighlights(urlElements, statusMap) {
    urlElements.forEach((elements, url) => {
      if (!statusMap.has(url)) return; // bu URL için henüz sonuç yok
      const status = statusMap.get(url);
      const category = categoryForStatus(status);
      elements.forEach((el) => highlightElement(el, category, status));
    });
  }

  // ---------- Stiller ----------
  function injectStyles() {
    const root = getRoot();
    if (root.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(400px, 94vw);
        min-width: 280px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        background: #ffffff;
        color: #202124;
        box-shadow: -10px 0 28px rgba(0,0,0,0.18);
        border-left: 1px solid rgba(0,0,0,0.08);
        transform: translateX(100%);
        transition: transform 0.32s ease;
      }
      #${PANEL_ID}.__lc_open { transform: translateX(0); }
      #${PANEL_ID}.__lc_maximized { width: min(920px, 96vw); }
      #${PANEL_ID}.__lc_minimized {
        top: auto !important;
        bottom: 16px;
        right: 16px;
        width: 260px !important;
        height: 50px;
        border-radius: 14px;
        border-left: none;
        overflow: hidden;
      }
      #${PANEL_ID}.__lc_minimized .__lc_body { display: none; }
      #${PANEL_ID}.__lc_minimized .__lc_header { cursor: pointer; border-bottom: none; }
      #${PANEL_ID}.__lc_minimized .__lc_resize_left,
      #${PANEL_ID}.__lc_minimized .__lc_resize_top { display: none; }
      #${PANEL_ID}.__lc_dark {
        background: #1b1c27;
        color: #e7e7f2;
        border-left-color: rgba(255,255,255,0.08);
      }
      #${PANEL_ID} .__lc_resize_left {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 6px;
        cursor: ew-resize;
        z-index: 3;
      }
      #${PANEL_ID} .__lc_resize_left:hover { background: rgba(26,86,219,0.35); }
      #${PANEL_ID} .__lc_resize_top {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 6px;
        cursor: ns-resize;
        z-index: 3;
      }
      #${PANEL_ID} .__lc_resize_top:hover { background: rgba(26,86,219,0.35); }
      #${PANEL_ID} .__lc_header {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(0,0,0,0.08);
        flex-shrink: 0;
      }
      #${PANEL_ID}.__lc_dark .__lc_header { border-bottom-color: rgba(255,255,255,0.08); }
      #${PANEL_ID} .__lc_traffic {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-right: 2px;
      }
      #${PANEL_ID} .__lc_dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        padding: 0;
        font-size: 8px;
        line-height: 1;
        color: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.85;
      }
      #${PANEL_ID} .__lc_dot:hover { opacity: 1; }
      #${PANEL_ID} .__lc_dot_close { background: #ff5f57; }
      #${PANEL_ID} .__lc_dot_min { background: #febc2e; }
      #${PANEL_ID} .__lc_dot_max { background: #28c840; }
      #${PANEL_ID} .__lc_header_icon {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: #d93025;
        color: #fff;
        font-weight: 800;
        font-size: 9px;
        letter-spacing: 0.2px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-shadow: 0 2px 6px rgba(217,48,37,0.4);
      }
      #${PANEL_ID} .__lc_header_title {
        font-weight: 600;
        font-size: 14px;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .__lc_header_actions { display: flex; gap: 4px; }
      #${PANEL_ID} .__lc_icon_btn {
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: inherit;
        opacity: 0.75;
        flex-shrink: 0;
      }
      #${PANEL_ID} .__lc_icon_btn:hover { opacity: 1; background: rgba(0,0,0,0.06); }
      #${PANEL_ID}.__lc_dark .__lc_icon_btn:hover { background: rgba(255,255,255,0.1); }
      #${PANEL_ID} .__lc_body {
        flex: 1;
        overflow-y: auto;
        padding: 14px 16px 16px;
      }
      #${PANEL_ID} .__lc_progress { margin-bottom: 14px; }
      #${PANEL_ID} .__lc_progress_top {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 12px;
        margin-bottom: 6px;
      }
      #${PANEL_ID} .__lc_progress_percent { color: #1a56db; font-weight: 700; }
      #${PANEL_ID}.__lc_dark .__lc_progress_percent { color: #6fa1ff; }
      #${PANEL_ID} .__lc_progress_track {
        height: 8px;
        border-radius: 999px;
        background: rgba(0,0,0,0.08);
        overflow: hidden;
      }
      #${PANEL_ID}.__lc_dark .__lc_progress_track { background: rgba(255,255,255,0.12); }
      #${PANEL_ID} .__lc_progress_fill {
        height: 100%;
        width: 0%;
        background: #1a56db;
        border-radius: 999px;
        transition: width 0.25s ease;
      }
      #${PANEL_ID} .__lc_progress_bottom {
        margin-top: 6px;
        font-size: 11.5px;
        opacity: 0.7;
      }
      #${PANEL_ID} .__lc_catrows {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #${PANEL_ID} .__lc_catrow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 10px;
        color: #fff;
        font-size: 12.5px;
        font-weight: 700;
        cursor: pointer;
        user-select: none;
      }
      #${PANEL_ID} .__lc_catrow.__lc_active { box-shadow: inset 0 0 0 2px rgba(255,255,255,0.85); }
      #${PANEL_ID} .__lc_catrow_valid { background: #188038; }
      #${PANEL_ID} .__lc_catrow_redirect { background: #8bc34a; }
      #${PANEL_ID} .__lc_catrow_warning { background: #f4a300; }
      #${PANEL_ID} .__lc_catrow_invalid { background: #d93025; }
      #${PANEL_ID} .__lc_catrow_actions { display: flex; gap: 6px; flex-shrink: 0; }
      #${PANEL_ID} .__lc_catrow_btn {
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 6px;
        background: rgba(255,255,255,0.25);
        color: #fff;
        cursor: pointer;
        font-size: 11px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${PANEL_ID} .__lc_catrow_btn:hover { background: rgba(255,255,255,0.4); }
      #${PANEL_ID} .__lc_actions_row {
        display: flex;
        gap: 8px;
        margin: 14px 0 4px;
      }
      #${PANEL_ID} .__lc_action_btn {
        flex: 1;
        padding: 8px 6px;
        border-radius: 999px;
        border: 1px solid rgba(0,0,0,0.14);
        background: #fff;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        color: inherit;
      }
      #${PANEL_ID}.__lc_dark .__lc_action_btn {
        background: transparent;
        border-color: rgba(255,255,255,0.2);
      }
      #${PANEL_ID} .__lc_action_btn:hover { background: rgba(26,86,219,0.08); }
      #${PANEL_ID}.__lc_dark .__lc_action_btn:hover { background: rgba(111,161,255,0.14); }
      #${PANEL_ID} .__lc_action_btn.__lc_primary { background: #1a56db; color: #fff; border-color: #1a56db; }
      #${PANEL_ID} .__lc_action_btn.__lc_primary:hover { background: #164bc4; }
      #${PANEL_ID} .__lc_action_btn:disabled { opacity: 0.6; cursor: default; }
      #${PANEL_ID} .__lc_list {
        list-style: none;
        margin: 14px 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #${PANEL_ID} .__lc_empty {
        font-size: 12px;
        opacity: 0.6;
        padding: 6px 2px;
      }
      #${PANEL_ID} .__lc_item {
        border-radius: 10px;
        padding: 10px 12px;
        border: 1px solid;
      }
      #${PANEL_ID} .__lc_item_valid { background: rgba(24,128,56,0.06); border-color: rgba(24,128,56,0.22); }
      #${PANEL_ID} .__lc_item_redirect { background: rgba(139,195,74,0.12); border-color: rgba(139,195,74,0.32); }
      #${PANEL_ID} .__lc_item_warning { background: rgba(244,163,0,0.10); border-color: rgba(244,163,0,0.3); }
      #${PANEL_ID} .__lc_item_invalid { background: rgba(217,48,37,0.06); border-color: rgba(217,48,37,0.18); }
      #${PANEL_ID}.__lc_dark .__lc_item_valid { background: rgba(24,128,56,0.18); border-color: rgba(24,128,56,0.36); }
      #${PANEL_ID}.__lc_dark .__lc_item_redirect { background: rgba(139,195,74,0.2); border-color: rgba(139,195,74,0.4); }
      #${PANEL_ID}.__lc_dark .__lc_item_warning { background: rgba(244,163,0,0.2); border-color: rgba(244,163,0,0.4); }
      #${PANEL_ID}.__lc_dark .__lc_item_invalid { background: rgba(217,48,37,0.18); border-color: rgba(217,48,37,0.34); }
      #${PANEL_ID} .__lc_item .__lc_code {
        display: inline-block;
        font-size: 10.5px;
        font-weight: 700;
        color: #fff;
        border-radius: 6px;
        padding: 1px 6px;
        margin-right: 6px;
        vertical-align: middle;
      }
      #${PANEL_ID} .__lc_code_valid { background: #188038; }
      #${PANEL_ID} .__lc_code_redirect { background: #8bc34a; }
      #${PANEL_ID} .__lc_code_warning { background: #f4a300; }
      #${PANEL_ID} .__lc_code_invalid { background: #d93025; }
      #${PANEL_ID} .__lc_item a {
        color: #444;
        font-size: 12.5px;
        word-break: break-all;
        text-decoration: none;
      }
      #${PANEL_ID}.__lc_dark .__lc_item a { color: #dcdce8; }
      #${PANEL_ID} .__lc_item a:hover { text-decoration: underline; }
      #${PANEL_ID} .__lc_help_box {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(26,86,219,0.06);
        font-size: 12px;
        line-height: 1.5;
      }
      #${PANEL_ID}.__lc_dark .__lc_help_box { background: rgba(111,161,255,0.14); }
      #${PANEL_ID} .__lc_footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 6px;
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid rgba(0,0,0,0.08);
        font-size: 11px;
      }
      #${PANEL_ID}.__lc_dark .__lc_footer { border-top-color: rgba(255,255,255,0.08); }
      #${PANEL_ID} .__lc_footer_link { color: #1a56db; text-decoration: none; cursor: pointer; }
      #${PANEL_ID}.__lc_dark .__lc_footer_link { color: #6fa1ff; }
      #${PANEL_ID} .__lc_footer_link:hover { text-decoration: underline; }
      #${PANEL_ID} .__lc_footer_sep { opacity: 0.4; }

      #${PAGEERROR_ID} {
        position: fixed;
        top: 16px;
        left: 50%;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
        border-radius: 12px;
        background: #d93025;
        color: #fff;
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 8px 24px rgba(0,0,0,0.28);
        opacity: 0;
        transform: translate(-50%, -12px);
        transition: opacity 0.3s ease, transform 0.3s ease;
      }
      #${PAGEERROR_ID}.__lc_show { opacity: 1; transform: translate(-50%, 0); }
      #${PAGEERROR_ID} .__lc_pageerror_icon {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: rgba(255,255,255,0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        font-weight: 800;
        flex-shrink: 0;
      }
      #${PAGEERROR_ID} .__lc_pageerror_close {
        border: none;
        background: transparent;
        color: #fff;
        cursor: pointer;
        font-size: 13px;
        opacity: 0.85;
        padding: 0 2px;
        flex-shrink: 0;
      }
      #${PAGEERROR_ID} .__lc_pageerror_close:hover { opacity: 1; }
    `;
    root.appendChild(style);
  }

  // ---------- Sayfanın kendisi 404 mü? ----------
  // Tıklanan bir 404 linki yeni sekmede açıldığında, o sayfada hatanın nerede olduğu
  // hemen anlaşılsın diye üstte bir uyarı rozeti gösterilir.
  function showPageErrorBadge() {
    injectStyles();
    const root = getRoot();
    if (root.getElementById(PAGEERROR_ID)) return;

    const badge = document.createElement('div');
    badge.id = PAGEERROR_ID;
    badge.innerHTML = `
      <span class="__lc_pageerror_icon">404</span>
      <span>Bu sayfa 404 (Bulunamadı) hatası döndürüyor</span>
      <button type="button" class="__lc_pageerror_close" title="Kapat">✕</button>
    `;
    root.appendChild(badge);
    requestAnimationFrame(() => badge.classList.add('__lc_show'));

    const fadeTimer = setTimeout(hide, 6000);
    function hide() {
      badge.classList.remove('__lc_show');
      setTimeout(() => badge.remove(), 400);
    }
    badge.querySelector('.__lc_pageerror_close').addEventListener('click', () => {
      clearTimeout(fadeTimer);
      hide();
    });
  }

  function checkOwnPageStatus() {
    try {
      const [nav] = performance.getEntriesByType('navigation');
      if (nav && typeof nav.responseStatus === 'number' && nav.responseStatus === 404) {
        showPageErrorBadge();
      }
    } catch (e) {
      // Navigation Timing Level 2 desteklenmiyor olabilir — sessizce yok say
    }
  }

  // ---------- Sürükleyerek yeniden boyutlandırma ----------
  function enableDrag(handle, mode) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = getRoot().getElementById(PANEL_ID);
      if (!panel || panel.classList.contains('__lc_minimized')) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      const startWidth = rect.width;
      const startTop = rect.top;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = mode === 'width' ? 'ew-resize' : 'ns-resize';
      document.body.style.userSelect = 'none';

      function onMove(ev) {
        if (mode === 'width') {
          const delta = startX - ev.clientX; // sola çekmek genişletir
          let newWidth = startWidth + delta;
          newWidth = Math.max(280, Math.min(newWidth, window.innerWidth - 20));
          panel.classList.remove('__lc_maximized');
          panel.style.width = newWidth + 'px';
        } else {
          const delta = ev.clientY - startY; // aşağı çekmek küçültür
          let newTop = startTop + delta;
          newTop = Math.max(0, Math.min(newTop, window.innerHeight - 200));
          panel.style.top = newTop + 'px';
        }
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ---------- Sağ panel ----------
  function ensurePanel() {
    injectStyles();
    const root = getRoot();
    let panel = root.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="__lc_resize_left" title="Genişliği ayarla"></div>
      <div class="__lc_resize_top" title="Yüksekliği ayarla"></div>
      <div class="__lc_header">
        <div class="__lc_traffic">
          <button type="button" class="__lc_dot __lc_dot_close" title="Kapat">×</button>
          <button type="button" class="__lc_dot __lc_dot_min" title="Küçült (alta al)">–</button>
          <button type="button" class="__lc_dot __lc_dot_max" title="Büyüt">+</button>
        </div>
        <div class="__lc_header_icon">404</div>
        <div class="__lc_header_title">404 Bağlantı Denetleyici</div>
        <div class="__lc_header_actions">
          <button type="button" class="__lc_icon_btn __lc_theme_btn" title="Koyu/açık mod">🌙</button>
        </div>
      </div>
      <div class="__lc_body">
        <div class="__lc_progress">
          <div class="__lc_progress_top">
            <span class="__lc_progress_total">Toplam: -</span>
            <span class="__lc_progress_queued">Kuyrukta: -</span>
            <span class="__lc_progress_percent">-</span>
          </div>
          <div class="__lc_progress_track"><div class="__lc_progress_fill"></div></div>
          <div class="__lc_progress_bottom">Henüz taranmadı</div>
        </div>

        <div class="__lc_catrows">
          <div class="__lc_catrow __lc_catrow_valid" data-cat="valid">
            <span class="__lc_catrow_label">Geçerli bağlantılar: <b class="__lc_catrow_count">0</b></span>
            <div class="__lc_catrow_actions">
              <button type="button" class="__lc_catrow_btn __lc_dl_btn" data-cat="valid" title="Bu kategoriyi indir">⬇</button>
            </div>
          </div>
          <div class="__lc_catrow __lc_catrow_redirect" data-cat="redirect">
            <span class="__lc_catrow_label">Geçerli yönlendirmeler: <b class="__lc_catrow_count">0</b></span>
            <div class="__lc_catrow_actions">
              <button type="button" class="__lc_catrow_btn __lc_dl_btn" data-cat="redirect" title="Bu kategoriyi indir">⬇</button>
            </div>
          </div>
          <div class="__lc_catrow __lc_catrow_warning" data-cat="warning">
            <span class="__lc_catrow_label">Uyarılar: <b class="__lc_catrow_count">0</b></span>
            <div class="__lc_catrow_actions">
              <button type="button" class="__lc_catrow_btn __lc_dl_btn" data-cat="warning" title="Bu kategoriyi indir">⬇</button>
            </div>
          </div>
          <div class="__lc_catrow __lc_catrow_invalid" data-cat="invalid">
            <span class="__lc_catrow_label">Geçersiz bağlantılar: <b class="__lc_catrow_count">0</b></span>
            <div class="__lc_catrow_actions">
              <button type="button" class="__lc_catrow_btn __lc_dl_btn" data-cat="invalid" title="Bu kategoriyi indir">⬇</button>
            </div>
          </div>
        </div>

        <div class="__lc_actions_row">
          <button type="button" class="__lc_action_btn __lc_exportall_btn">Tümünü İndir</button>
          <button type="button" class="__lc_action_btn __lc_viewall_btn">Tümünü Gör</button>
          <button type="button" class="__lc_action_btn __lc_primary __lc_refresh_panel_btn">Yenile</button>
        </div>

        <ul class="__lc_list"></ul>

        <div class="__lc_help_box" style="display:none;"></div>

        <div class="__lc_footer">
          <a class="__lc_footer_link" data-help="usage">Nasıl Kullanılır</a>
          <span class="__lc_footer_sep">|</span>
          <a class="__lc_footer_link" data-help="about">Hakkında</a>
        </div>
      </div>
    `;
    root.appendChild(panel);

    panel.querySelector('.__lc_dot_close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeEverything();
    });
    panel.querySelector('.__lc_dot_min').addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelState(panel.classList.contains('__lc_minimized') ? 'normal' : 'minimized');
    });
    panel.querySelector('.__lc_dot_max').addEventListener('click', (e) => {
      e.stopPropagation();
      setPanelState(panel.classList.contains('__lc_maximized') ? 'normal' : 'maximized');
    });
    panel.querySelector('.__lc_header').addEventListener('click', () => {
      if (panel.classList.contains('__lc_minimized')) setPanelState('normal');
    });
    panel.querySelector('.__lc_theme_btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTheme();
    });

    panel.querySelectorAll('.__lc_catrow').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.__lc_dl_btn')) return; // indirme butonuna tıklamak filtreyi değiştirmesin
        const cat = row.dataset.cat;
        listFilter = listFilter === cat ? 'problems' : cat;
        panel.querySelectorAll('.__lc_catrow').forEach((r) => r.classList.toggle('__lc_active', r.dataset.cat === listFilter));
        renderList();
      });
    });
    panel.querySelectorAll('.__lc_dl_btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportResults(btn.dataset.cat);
      });
    });
    panel.querySelector('.__lc_exportall_btn').addEventListener('click', () => exportResults('all'));
    panel.querySelector('.__lc_viewall_btn').addEventListener('click', () => {
      listFilter = listFilter === 'all' ? 'problems' : 'all';
      panel.querySelectorAll('.__lc_catrow').forEach((r) => r.classList.remove('__lc_active'));
      renderList();
    });
    panel.querySelector('.__lc_refresh_panel_btn').addEventListener('click', () => performScan(true, true));
    panel.querySelectorAll('.__lc_footer_link').forEach((link) => {
      link.addEventListener('click', () => toggleHelp(link.dataset.help));
    });

    enableDrag(panel.querySelector('.__lc_resize_left'), 'width');
    enableDrag(panel.querySelector('.__lc_resize_top'), 'top');

    applyTheme(currentTheme);
    return panel;
  }

  function setPanelState(state) {
    const panel = getRoot().getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.remove('__lc_minimized', '__lc_maximized');
    panel.style.width = '';
    panel.style.top = '';
    if (state === 'minimized') panel.classList.add('__lc_minimized');
    if (state === 'maximized') panel.classList.add('__lc_maximized');
  }

  function openPanel() {
    const panel = getRoot().getElementById(PANEL_ID);
    if (panel) requestAnimationFrame(() => panel.classList.add('__lc_open'));
  }

  function updateProgress(completed, total) {
    const panel = ensurePanel();
    const percent = total > 0 ? Math.round((completed / total) * 100) : 100;
    panel.querySelector('.__lc_progress_total').textContent = `Toplam: ${total}`;
    panel.querySelector('.__lc_progress_queued').textContent = `Kuyrukta: ${Math.max(total - completed, 0)}`;
    panel.querySelector('.__lc_progress_percent').textContent = `${percent}%`;
    panel.querySelector('.__lc_progress_fill').style.width = percent + '%';
    panel.querySelector('.__lc_progress_bottom').textContent =
      completed >= total && total > 0 ? 'Tamamlanıyor...' : 'Taranıyor...';
  }

  function renderPanel(results, stats, elapsedSec) {
    const panel = ensurePanel();

    panel.querySelector('.__lc_progress_total').textContent = `Toplam: ${results.length}`;
    panel.querySelector('.__lc_progress_queued').textContent = 'Kuyrukta: 0';
    panel.querySelector('.__lc_progress_percent').textContent = '100%';
    panel.querySelector('.__lc_progress_fill').style.width = '100%';
    const scanTimeStr = lastScanTime ? formatTime(lastScanTime) : '-';
    panel.querySelector('.__lc_progress_bottom').textContent = results.length
      ? `Son tarama: ${scanTimeStr} · ${elapsedSec} sn'de tamamlandı`
      : `Son tarama: ${scanTimeStr} · taranacak kaynak bulunamadı`;

    ['valid', 'redirect', 'warning', 'invalid'].forEach((cat) => {
      const row = panel.querySelector(`.__lc_catrow_${cat}`);
      row.querySelector('.__lc_catrow_count').textContent = stats[cat];
      row.title = categoryBreakdownTitle(stats, cat);
    });

    renderList(results);
  }

  function renderList(results) {
    results = results || lastResults || [];
    const panel = getRoot().getElementById(PANEL_ID);
    if (!panel) return;
    const list = panel.querySelector('.__lc_list');
    const viewAllBtn = panel.querySelector('.__lc_viewall_btn');

    let filtered;
    if (listFilter === 'all') {
      filtered = results;
    } else if (listFilter === 'problems') {
      filtered = results.filter((r) => {
        const c = categoryForStatus(r.status);
        return c === 'warning' || c === 'invalid';
      });
    } else {
      filtered = results.filter((r) => categoryForStatus(r.status) === listFilter);
    }

    if (filtered.length === 0) {
      list.innerHTML = `<li class="__lc_empty">Bu görünümde gösterilecek bağlantı yok.</li>`;
    } else {
      list.innerHTML = filtered
        .map((item) => {
          const cat = categoryForStatus(item.status);
          const label = typeof item.status === 'number' ? String(item.status) : 'Hata';
          return `
          <li class="__lc_item __lc_item_${cat}">
            <span class="__lc_code __lc_code_${cat}">${label}</span>
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a>
          </li>`;
        })
        .join('');
    }

    if (viewAllBtn) {
      viewAllBtn.textContent = listFilter === 'all' ? 'Listeyi Daralt' : 'Tümünü Gör';
    }
  }

  function exportResults(catOrAll) {
    const results = lastResults || [];
    const filtered = catOrAll === 'all' ? results : results.filter((r) => categoryForStatus(r.status) === catOrAll);
    if (filtered.length === 0) return;
    const lines = filtered.map((r) => `${typeof r.status === 'number' ? r.status : 'HATA'}\t${r.url}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `link-kontrol-${catOrAll}-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const HELP_TEXTS = {
    usage:
      'Sayfa yüklendiğinde bağlantılar otomatik olarak taranır. Renkli satırlara tıklayarak o kategorideki bağlantıları listeleyebilir, ⬇ simgesiyle yalnızca o kategoriyi dışa aktarabilirsiniz. Sayfadaki bağlantı ve görseller de tarama sonucuna göre yeşil (geçerli), soluk yeşil (yönlendirme), sarı (uyarı) veya kırmızı (geçersiz) renkte işaretlenir.',
    about:
      '404 Bağlantı Denetleyici, ziyaret ettiğiniz sayfalardaki kırık bağlantıları, yönlendirmeleri ve uyarıları otomatik tespit eden bir tarayıcı uzantısıdır.'
  };

  function toggleHelp(kind) {
    const panel = getRoot().getElementById(PANEL_ID);
    if (!panel) return;
    const box = panel.querySelector('.__lc_help_box');
    if (helpOpen === kind) {
      helpOpen = null;
      box.style.display = 'none';
      box.textContent = '';
    } else {
      helpOpen = kind;
      box.textContent = HELP_TEXTS[kind] || '';
      box.style.display = 'block';
    }
  }

  function formatTime(date) {
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ---------- Tarama akışı ----------
  // isManual: kullanıcı panelin "Yenile" butonuna bastı (önbellek temizlenir, buton kısaca
  // "Yenilendi ✓" gösterir)
  // forceOpen: panel tarama bitmesini beklemeden hemen açılır ve sonuç ne olursa olsun açık kalır
  // (ikon tıklaması / manuel yenileme için)
  function performScan(isManual, forceOpen) {
    if (isScanning) return;
    isScanning = true;

    const panel = ensurePanel();
    const wasOpenBefore = panel.classList.contains('__lc_open');
    // "Basar basmaz panel açılsın" — tarama bitmesini beklemeden, ilerleme çubuğuyla birlikte hemen açılır.
    if (forceOpen) {
      setPanelState('normal');
      openPanel();
    }

    const refreshBtn = panel.querySelector('.__lc_refresh_panel_btn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Taranıyor...';
    }

    if (isManual) {
      checkedCache.clear(); // manuel yenilemede sitenin tüm kaynakları yeniden kontrol edilsin
    }

    const { urls, urlElements } = collectResourceUrls();
    const panelWasOpen = forceOpen || wasOpenBefore;

    scanStartTime = Date.now();
    updateProgress(0, urls.length);

    const finish = (results) => {
      isScanning = false;
      results.forEach((r) => urlStatusMap.set(r.url, r.status));
      applyHighlights(urlElements, urlStatusMap);
      const stats = computeStats(results);
      lastResults = results;
      lastStats = stats;
      lastElapsedSec = ((Date.now() - scanStartTime) / 1000).toFixed(1);
      lastScanTime = new Date();
      renderPanel(results, stats, lastElapsedSec);
      // Otomatik taramada panel yalnızca geçersiz bağlantı bulunduğunda kendiliğinden açılır;
      // ikon tıklaması / manuel yenileme zaten yukarıda hemen açtı.
      if (stats.invalid > 0 || panelWasOpen) {
        openPanel();
      }
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = isManual ? 'Yenilendi ✓' : 'Yenile';
        if (isManual) setTimeout(() => { refreshBtn.textContent = 'Yenile'; }, 1500);
      }
    };

    if (urls.length === 0) {
      finish([]);
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'CHECK_LINKS', urls, pageUrl: location.href, pageTitle: document.title },
      (response) => {
        if (chrome.runtime.lastError) {
          isScanning = false;
          if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Yenile';
          }
          return;
        }
        finish((response && response.results) || []);
      }
    );
  }

  // Kırmızı çarpı: panel tamamen kaybolur ve siz tekrar ikona tıklayana kadar hiçbir şey
  // görünmez / otomatik işlem yapılmaz. Bu tercih arka plana (chrome.storage.session)
  // kaydedilir; böylece F5 ile sayfa yenilense bile panel geri gelmez — yalnızca ikona
  // tekrar tıklandığında geri gelir.
  function closeEverything() {
    dismissed = true;
    const root = getRoot();
    const panel = root.getElementById(PANEL_ID);
    if (panel) panel.classList.remove('__lc_open');
    chrome.runtime.sendMessage({ type: 'SET_DISMISSED', value: true }, () => {
      if (chrome.runtime.lastError) {
        // arka planla konuşulamadı — yine de bu sayfa ziyaretinde panel kapalı kalır
      }
    });
  }

  // ---------- Uzantı ikonuna tıklanınca paneli aç/kapat ----------
  function togglePanelFromIcon() {
    const panel = ensurePanel();
    if (panel.classList.contains('__lc_open')) {
      closeEverything();
      return;
    }

    dismissed = false;

    if (lastResults === null) {
      performScan(false, true);
    } else {
      renderPanel(lastResults, lastStats, lastElapsedSec);
      setPanelState('normal');
      openPanel();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'TOGGLE_PANEL') {
      togglePanelFromIcon();
    }
    if (message && message.type === 'SCAN_PROGRESS') {
      updateProgress(message.completed, message.total);
    }
  });

  function init() {
    checkOwnPageStatus();

    chrome.runtime.sendMessage({ type: 'CHECK_DISMISSED' }, (response) => {
      dismissed = !!(!chrome.runtime.lastError && response && response.dismissed);
      if (dismissed) return; // bu sekme daha önce kapatılmış — ikona tıklanana kadar sessiz kal

      loadTheme(() => {
        if (document.readyState === 'complete') {
          performScan(false);
        } else {
          window.addEventListener('load', () => performScan(false), { once: true });
        }
      });
    });
  }

  init();
})();
