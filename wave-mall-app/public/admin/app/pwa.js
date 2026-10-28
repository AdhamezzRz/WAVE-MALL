/* The Wave · installable app (leasing office and tenant portal).
   Registers the service worker, offers updates ("New version available"), and shows a quiet
   "Install the app" prompt on phones: the browser's own on Android, instructions on iPhone.
   Self-contained (its own styles) so any page that includes ui.pwaHead() gets it. */
(() => {
  'use strict';
  const me = document.currentScript;
  const SW = me && me.dataset.sw;
  const SCOPE = me && me.dataset.scope;
  const KEY = `wave-install-${(SCOPE || '/').replace(/\W/g, '') || 'root'}`;
  const AR = (document.documentElement.lang || '').startsWith('ar');
  const T = {
    update: ['A new version is ready.', 'يتوفر إصدار جديد.'],
    refresh: ['Refresh', 'تحديث'],
    title: ['Install the app', 'ثبّت التطبيق'],
    lead: [SCOPE === '/portal/' ? 'Your store, invoices and requests, one tap away.' : 'The leasing office on your home screen: faster, full screen, one tap away.', SCOPE === '/portal/' ? 'متجرك وفواتيرك وطلباتك بلمسة واحدة.' : 'مكتب التأجير على شاشتك الرئيسية: أسرع، بملء الشاشة، وبلمسة واحدة.'],
    install: ['Install', 'تثبيت'],
    later: ['Not now', 'ليس الآن'],
    ios: ['Tap {share} Share, then “Add to Home Screen”.', 'اضغط {share} مشاركة، ثم «إضافة إلى الشاشة الرئيسية».'],
  };
  const t = (k) => T[k][AR ? 1 : 0];
  const store = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } },
  };
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const phone = () => window.matchMedia('(max-width: 860px)').matches;
  if (standalone()) document.documentElement.classList.add('is-app');

  let css = false;
  function styles() {
    if (css) return;
    css = true;
    const s = document.createElement('style');
    s.textContent = `
.pwa-card{position:fixed;z-index:80;inset-inline:12px;bottom:calc(var(--tabbar-h,0px) + 12px + env(safe-area-inset-bottom));display:flex;gap:14px;align-items:center;padding:14px 16px;border-radius:16px;background:#283833;color:#fbfaf6;box-shadow:0 24px 50px -18px rgb(0 0 0/.55);font:500 14px/1.45 Montserrat,Almarai,system-ui,sans-serif;animation:pwa-in .45s cubic-bezier(.2,.8,.2,1)}
.pwa-card img{width:44px;height:44px;border-radius:11px;flex:none}
.pwa-card div{flex:1;min-width:0}.pwa-card b{display:block;font-weight:700;font-size:14.5px}.pwa-card small{display:block;opacity:.8;font-size:12.5px}
.pwa-card button{border:0;border-radius:999px;padding:10px 16px;font:700 13px/1 inherit;font-family:inherit;cursor:pointer;min-height:40px}
.pwa-card .pwa-go{background:#d1c9b3;color:#283833}.pwa-card .pwa-x{background:transparent;color:#d1c9b3;padding:10px 8px}
.pwa-card svg{display:inline-block;width:16px;height:16px;vertical-align:-3px;stroke:currentColor;fill:none;stroke-width:1.8}
@keyframes pwa-in{from{opacity:0;transform:translateY(16px)}}
@media (min-width:861px){.pwa-card{inset-inline:auto 24px;max-width:420px}}`;
    document.head.appendChild(s);
  }
  const SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg>';
  function card(html, actions) {
    styles();
    document.querySelectorAll('.pwa-card').forEach((c) => c.remove());
    const c = document.createElement('div');
    c.className = 'pwa-card';
    c.setAttribute('role', 'dialog');
    c.innerHTML = `<img src="/admin/app/icon-192.png" alt=""><div>${html}</div>${actions}`;
    document.body.appendChild(c);
    return c;
  }

  // ---------- service worker and updates ----------
  if (SW && 'serviceWorker' in navigator && window.isSecureContext) {
    // Reload only when the person asked for the new version. The first install also changes the
    // controller (clients.claim), and reloading then would throw away what they were typing.
    let wanted = false;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!wanted || refreshing) return;
      refreshing = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(SW, { scope: SCOPE, updateViaCache: 'none' }).then((reg) => {
        const offer = (w) => {
          if (!w || !navigator.serviceWorker.controller) return; // first install: nothing to replace
          const c = card(`<b>${t('update')}</b>`, `<button type="button" class="pwa-go">${t('refresh')}</button>`);
          c.querySelector('.pwa-go').addEventListener('click', () => { wanted = true; w.postMessage('skip-waiting'); });
        };
        if (reg.waiting) offer(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
        });
        // look for a new version when the app comes back to the foreground
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      }).catch(() => {});
    });
  }

  // ---------- install prompt (phones, not installed, not dismissed, second visit or later) ----------
  if (standalone()) return;
  const seen = Number(store.get() || 0);
  if (seen < 0) return; // dismissed or installed
  store.set(String(seen + 1));
  const ready = () => phone() && seen >= 1 && !document.querySelector('[data-cmdk]:not([hidden])');
  const dismiss = (c) => { store.set('-1'); c.remove(); };
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (!ready()) return;
    setTimeout(() => {
      const c = card(`<b>${t('title')}</b><small>${t('lead')}</small>`, `<button type="button" class="pwa-x">${t('later')}</button><button type="button" class="pwa-go">${t('install')}</button>`);
      c.querySelector('.pwa-x').addEventListener('click', () => dismiss(c));
      c.querySelector('.pwa-go').addEventListener('click', async () => {
        c.remove();
        deferred.prompt();
        const r = await deferred.userChoice.catch(() => ({}));
        if (r && r.outcome === 'accepted') store.set('-1');
        deferred = null;
      });
    }, 2500);
  });
  window.addEventListener('appinstalled', () => store.set('-1'));
  // iPhone and iPad Safari have no install event: show the two steps once in a while
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
  if (ios && ready() && seen % 4 === 1) {
    setTimeout(() => {
      const c = card(`<b>${t('title')}</b><small>${t('ios').replace('{share}', SHARE)}</small>`, `<button type="button" class="pwa-x" aria-label="${t('later')}">${t('later')}</button>`);
      c.querySelector('.pwa-x').addEventListener('click', () => dismiss(c));
    }, 3000);
  }
})();
