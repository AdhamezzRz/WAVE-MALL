// The wall screen (/wall/<token> and /admin/wallboard/screen): a clock, the detail panels in turn,
// and fresh figures every 30 seconds from the JSON next to the page. No other script runs here.
(function () {
  'use strict';
  const body = document.body;
  if (!body.classList.contains('wall')) return;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const lang = body.dataset.lang === 'ar' ? 'ar' : 'en';
  const src = body.dataset.src;
  let every = Math.max(5, Number(body.dataset.rotate) || 15) * 1000;

  // the clock, in Cairo time
  const clock = $('[data-clock]');
  const fmt = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const tick = () => { if (clock) clock.textContent = fmt.format(new Date()); };
  tick();
  setInterval(tick, 1000);

  // the panels in turn
  let at = 0;
  let timer = null;
  const show = (i) => {
    const panels = $$('[data-panel]');
    const dots = $$('[data-dots] i');
    if (!panels.length) return;
    at = (i + panels.length) % panels.length;
    panels.forEach((p, k) => p.classList.toggle('is-on', k === at));
    dots.forEach((d, k) => d.classList.toggle('is-on', k === at));
  };
  const start = () => { clearInterval(timer); timer = setInterval(() => show(at + 1), every); };
  start();

  // fresh figures
  const live = $('[data-live]');
  const liveText = live ? live.lastChild.textContent : '';
  const fromHtml = (html) => { const tmp = document.createElement('div'); tmp.innerHTML = html; return tmp.firstElementChild; };
  async function refresh() {
    try {
      const res = await fetch(src, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      const tiles = $('[data-tiles]');
      if (tiles && d.tiles) {
        for (const [k, html] of Object.entries(d.tiles)) {
          const was = $(`[data-tile="${k}"]`, tiles);
          const fresh = fromHtml(html);
          if (was && fresh) was.replaceWith(fresh);
          else if (fresh) tiles.appendChild(fresh);
        }
      }
      const stage = $('[data-stage]');
      if (stage && Array.isArray(d.panels)) {
        const dots = $('[data-dots]', stage);
        const keys = d.panels.map((p) => p.key);
        $$('[data-panel]', stage).filter((el) => !keys.includes(el.dataset.panel)).forEach((el) => el.parentNode.removeChild(el));
        d.panels.forEach((p) => {
          let el = $(`[data-panel="${p.key}"]`, stage);
          if (!el) {
            el = fromHtml('<article class="wall-panel"><header><h2></h2><p></p></header><div class="wall-panel__b"></div></article>');
            el.dataset.panel = p.key;
            stage.insertBefore(el, dots);
          }
          $('h2', el).textContent = p.title;
          $('header p', el).textContent = p.sub || '';
          $('.wall-panel__b', el).innerHTML = p.html;
        });
        if (dots) dots.innerHTML = d.panels.map(() => '<i></i>').join('');
        show(Math.min(at, d.panels.length - 1));
      }
      const ticker = $('[data-ticker]');
      if (ticker && Array.isArray(d.ticker)) {
        ticker.textContent = '';
        d.ticker.forEach((x) => { const s = document.createElement('span'); s.textContent = x; ticker.appendChild(s); });
      }
      const up = $('[data-updated]');
      if (up && d.updated) up.textContent = d.updated;
      if (d.rotate && d.rotate * 1000 !== every) { every = d.rotate * 1000; start(); }
      if (live) { live.classList.remove('is-off'); live.lastChild.textContent = liveText; }
    } catch (err) {
      if (live) { live.classList.add('is-off'); live.lastChild.textContent = body.dataset.offline || 'Offline'; }
    }
  }
  setInterval(refresh, 30000);
  // a fresh page twice a day picks up any change to the screen itself
  setTimeout(() => location.reload(), 12 * 60 * 60 * 1000);

  // full screen on request (a click, or the TV remote's arrows to move between panels)
  const full = $('[data-fullscreen]');
  if (full) full.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    show(at + ((e.key === 'ArrowRight') === (lang === 'ar') ? -1 : 1));
    start();
  });
})();
