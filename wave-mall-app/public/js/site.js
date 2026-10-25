/* The Wave: quiet motion. GSAP + ScrollTrigger + Lenis, loaded before this file. */
(function () {
  'use strict';
  if (!window.gsap || !window.ScrollTrigger) return;

  const D = document;
  const W = window;
  const root = D.documentElement;
  const RM = W.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STATIC = root.hasAttribute('data-static');
  const $ = (s, scope = D) => scope.querySelector(s);
  const $$ = (s, scope = D) => Array.from(scope.querySelectorAll(s));
  const EASE = 'power2.out';

  gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ ease: EASE, duration: 1.6 });

  /* smooth scroll */
  let lenis = null;
  if (!RM && W.Lenis) {
    lenis = new Lenis({ lerp: 0.08, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  const scrollTo = (target, opts = {}) => {
    if (lenis) return lenis.scrollTo(target, { duration: 1.6, ...opts });
    if (typeof target === 'number') W.scrollTo({ top: target, behavior: opts.immediate ? 'auto' : 'smooth' });
    else target.scrollIntoView({ behavior: 'smooth' });
  };
  const lock = (on) => { if (lenis) on ? lenis.stop() : lenis.start(); D.body.style.overflow = on ? 'hidden' : ''; };

  /* header follows the scroll; menu overlay */
  const top = $('[data-top]');
  const menu = $('[data-menu]');
  const menuBtn = $('[data-menu-toggle]');
  const main = $('#main');
  let heroBottom = 0;
  let menuOpen = false;
  function measureHero() { const h = $('[data-hero]', main); heroBottom = h ? h.offsetTop + h.offsetHeight : 0; }
  ScrollTrigger.create({
    start: 0,
    end: 'max',
    onUpdate(self) {
      const y = self.scroll();
      if (top && !menuOpen) {
        top.classList.toggle('on-hero', y < heroBottom - 80);
        top.classList.toggle('is-tint', y > heroBottom - 40);
      }
    },
  });
  function setMenu(open) {
    if (!menu || open === menuOpen) return;
    menuOpen = open;
    menuBtn.setAttribute('aria-expanded', String(open));
    const lbl = $('span', menuBtn);
    lbl.textContent = open ? lbl.dataset.close : lbl.dataset.open;
    top.classList.toggle('is-menu', open);
    menu.setAttribute('aria-hidden', String(!open));
    lock(open);
    const spans = $$('.menu__nav a span', menu);
    const side = $('.menu__side', menu);
    if (open) {
      menu.classList.add('is-open');
      gsap.timeline()
        .to(menu, { opacity: 1, duration: 0.7, ease: 'power2.out' }, 0)
        .to(spans, { opacity: 1, y: 0, duration: 1.2, stagger: 0.06, ease: 'power3.out' }, 0.15)
        .to(side, { opacity: 1, duration: 1, ease: 'power2.out' }, 0.5);
    } else {
      gsap.timeline({ onComplete() { menu.classList.remove('is-open'); gsap.set(spans, { opacity: 0, y: 20 }); gsap.set(side, { opacity: 0 }); if (top) top.classList.toggle('on-hero', (lenis ? lenis.scroll : W.scrollY) < heroBottom - 80); } })
        .to([spans, side], { opacity: 0, duration: 0.35, ease: 'power2.in' }, 0)
        .to(menu, { opacity: 0, duration: 0.5, ease: 'power2.inOut' }, 0.1);
    }
  }
  if (menuBtn) menuBtn.addEventListener('click', () => setMenu(!menuOpen));
  D.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) setMenu(false); });

  /* the thread: one line stitched through the page, drawn as you read */
  const thread = $('[data-thread]');
  const threadPath = thread && $('path', thread);
  function buildThread() {
    if (!thread) return;
    const Wd = main.clientWidth;
    const H = main.scrollHeight;
    thread.setAttribute('viewBox', `0 0 ${Wd} ${H}`);
    const mr = main.getBoundingClientRect();
    const pts = [[Wd * 0.5, 0]];
    let side = root.dir === 'rtl' ? -1 : 1;
    const edge = () => (side > 0 ? Wd * 0.955 : Wd * 0.045);
    $$('[data-thread-anchor]', main).forEach((a) => {
      const r = a.getBoundingClientRect();
      const cx = r.left - mr.left + r.width / 2;
      const cy = r.top - mr.top + r.height / 2;
      const prev = pts[pts.length - 1];
      pts.push([edge(), (prev[1] + cy) / 2]);
      side = -side;
      pts.push([cx, cy]);
    });
    const last = pts[pts.length - 1];
    pts.push([edge(), (last[1] + H) / 2]);
    pts.push([Wd * 0.5, H]);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      const my = ((p[1] + q[1]) / 2).toFixed(1);
      d += ` C${p[0].toFixed(1)},${my} ${q[0].toFixed(1)},${my} ${q[0].toFixed(1)},${q[1].toFixed(1)}`;
    }
    threadPath.setAttribute('d', d);
    measureHero();
  }
  if (thread && !RM) {
    const draw = gsap.quickTo(threadPath, 'strokeDashoffset', { duration: 0.9, ease: 'power2.out' });
    ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate(self) {
        const seen = gsap.utils.clamp(0, 1, (self.scroll() + W.innerHeight * 0.92 - main.offsetTop) / main.scrollHeight);
        draw(1 - seen);
      },
    });
    new ResizeObserver(() => buildThread()).observe(main);
  }

  /* page modules */
  const modules = {
    reveals(scope) {
      $$('[data-r]', scope).forEach((el) => {
        const img = el.dataset.r === 'img' ? $('img', el) : null;
        const tl = gsap.timeline({ scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
        tl.fromTo(el, { opacity: 0, y: img ? 0 : 22 }, { opacity: 1, y: 0, duration: img ? 1.4 : 1.6 }, 0);
        if (img) tl.fromTo(img, { scale: 1.06 }, { scale: 1, duration: 2.6 }, 0);
      });
      $$('.frame img', scope).forEach((img) => {
        gsap.fromTo(img, { yPercent: -4 }, { yPercent: 4, ease: 'none', scrollTrigger: { trigger: img.closest('.frame'), start: 'top bottom', end: 'bottom top', scrub: 1.2 } });
      });
    },

    hero(scope) {
      const h = $('[data-hero]', scope);
      if (!h) return;
      gsap.fromTo($('.hero__media img', h), { scale: 1.1 }, { scale: 1.06, duration: 4, ease: 'power1.out' });
      gsap.to($('.hero__media', h), { yPercent: 14, ease: 'none', scrollTrigger: { trigger: h, start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to($('.hero__text', h), { opacity: 0, y: -24, ease: 'none', scrollTrigger: { trigger: h, start: '45% top', end: 'bottom top', scrub: true } });
    },

    mark(scope) {
      $$('[data-mark]', scope).forEach((sec) => {
        const svg = $('svg', sec);
        const fill = $('.logo__fill', svg);
        const draw = $('.l-draw', svg);
        const tl = gsap.timeline({ scrollTrigger: { trigger: sec, start: 'top 65%', once: true } });
        tl.to(draw, { strokeDashoffset: 0, duration: 2.4, ease: 'power2.inOut' })
          .to(fill, { opacity: 1, duration: 1.8 }, '-=1')
          .to(draw, { opacity: 0, duration: 1 }, '-=0.8');
        if (!RM) gsap.to($('.l-av', svg), { y: -3, duration: 4, repeat: -1, yoyo: true, ease: 'sine.inOut' });
        $('[data-mark-toggle]', sec).addEventListener('click', () => sec.classList.toggle('is-ink'));
      });
    },

    pins(scope) {
      const pins = $$('[data-pin]', scope);
      if (!pins.length) return;
      gsap.fromTo(pins, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 1.4, stagger: 0.14, delay: 0.6, scrollTrigger: { trigger: pins[0].closest('.map'), start: 'top 80%', once: true } });
    },

    forms(scope) {
      $$('form[data-form]', scope).forEach((form) => {
        const status = $('[data-form-status]', form);
        const btn = $('button[type=submit]', form);
        const say = (msg, ok) => {
          status.hidden = false;
          status.textContent = msg;
          status.className = 'status ' + (ok ? 'status--ok' : 'status--err');
          status.setAttribute('tabindex', '-1');
          status.focus({ preventScroll: true });
        };
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          $$('[data-field]', form).forEach((f) => f.classList.remove('is-invalid'));
          if (!form.checkValidity()) {
            $$('input, textarea, select', form).forEach((i) => { const f = i.closest('[data-field]'); if (!i.checkValidity() && f) f.classList.add('is-invalid'); });
            say(form.dataset.fail, false);
            return;
          }
          const label = $('span', btn);
          const orig = label.textContent;
          btn.disabled = true;
          label.textContent = form.dataset.sending;
          try {
            const res = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) { say(form.dataset.ok, true); form.reset(); }
            else {
              (data.errors || []).forEach((n) => { const i = form.elements[n]; const f = i && i.closest('[data-field]'); if (f) f.classList.add('is-invalid'); });
              say(form.dataset.fail, false);
            }
          } catch (err) { say(form.dataset.fail, false); }
          btn.disabled = false;
          label.textContent = orig;
        });
      });
    },

    copy(scope) {
      $$('[data-copy]', scope).forEach((b) => {
        const orig = b.textContent;
        b.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); } catch (err) { /* fall through */ }
          b.textContent = b.dataset.copied;
          setTimeout(() => { b.textContent = orig; }, 1600);
        });
      });
    },
  };

  let ctx = null;
  function initPage(scope) {
    if (ctx) ctx.revert();
    ctx = gsap.context(() => { Object.values(modules).forEach((fn) => { try { fn(scope); } catch (err) { console.error(err); } }); }, scope);
    buildThread();
    ScrollTrigger.refresh();
  }

  function heroIntro(scope) {
    const h = $('[data-hero]', scope);
    if (!h) return;
    const tl = gsap.timeline();
    tl.to($$('.h-hero span, .h-hero em', h), { opacity: 1, y: 0, duration: 2, stagger: 0.28 }, 0.1);
    const meta = $('[data-hero-meta]', h);
    if (meta) tl.to(meta, { opacity: 1, duration: 1.6 }, 0.9);
  }

  /* veil: first visit only */
  const veil = $('[data-veil]');
  function boot() {
    let seen = true;
    try { seen = !!sessionStorage.getItem('wave-seen'); sessionStorage.setItem('wave-seen', '1'); } catch (e) { /* private mode */ }
    if (top) top.classList.toggle('on-hero', !!$('[data-hero]', main));
    if (!veil || RM || seen) {
      if (veil) veil.remove();
      initPage(main);
      heroIntro(main);
      return;
    }
    lock(true);
    const path = $('path', veil);
    const L = path.getTotalLength();
    const tl = gsap.timeline({ onComplete() { veil.remove(); lock(false); } });
    tl.fromTo(path, { strokeDasharray: L, strokeDashoffset: L }, { strokeDashoffset: 0, duration: 1.3, ease: 'power2.inOut' }, 0.1)
      .to(path, { fillOpacity: 1, duration: 0.7 }, 1.1)
      .add(() => initPage(main), 1.5)
      .to(veil, { opacity: 0, duration: 0.9, ease: 'power2.inOut' }, 1.9)
      .add(() => heroIntro(main), 2.0);
  }

  /* page changes: a quiet fade */
  let moving = false;
  async function navigate(href, push) {
    if (moving) return;
    moving = true;
    if (menuOpen) setMenu(false);
    const fetching = fetch(href).then((r) => { if (!r.ok && r.status !== 404) throw new Error(r.status); return r.text(); });
    await gsap.to(main, { opacity: 0, y: -10, duration: 0.5, ease: 'power2.in' });
    let html;
    try { html = await fetching; } catch (err) { location.href = href; return; }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const next = doc.querySelector('#main');
    if (!next) { location.href = href; return; }
    if (ctx) { ctx.revert(); ctx = null; }
    main.innerHTML = next.innerHTML;
    main.dataset.page = next.dataset.page;
    D.title = doc.title;
    const d1 = D.querySelector('meta[name=description]');
    const d2 = doc.querySelector('meta[name=description]');
    if (d1 && d2) d1.setAttribute('content', d2.getAttribute('content'));
    if (push) history.pushState({ wave: true }, '', href);
    const pathname = new URL(href, location.href).pathname;
    $$('.top__nav a, .top__contact, .menu__nav a').forEach((a) => { const h = a.getAttribute('href'); const home = root.lang === 'ar' ? '/ar/' : '/'; const cur = h === home ? pathname === home : pathname.startsWith(h); cur ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
    const lang = D.querySelector('.top__lang');
    const lang2 = doc.querySelector('.top__lang');
    if (lang && lang2) lang.setAttribute('href', lang2.getAttribute('href'));
    scrollTo(0, { immediate: true });
    W.scrollTo(0, 0);
    const img = $('.hero__media img, .map img', main);
    if (img && !img.complete) await Promise.race([new Promise((r) => img.addEventListener('load', r, { once: true })), new Promise((r) => setTimeout(r, 1500))]);
    initPage(main);
    if (top) top.classList.toggle('on-hero', !!$('[data-hero]', main));
    gsap.fromTo(main, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 1, ease: EASE, onComplete: () => { moving = false; } });
    heroIntro(main);
  }

  D.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    if (a.hasAttribute('data-full-nav') || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname) {
      e.preventDefault();
      if (menuOpen) setMenu(false);
      const t = url.hash && $(url.hash);
      scrollTo(t || 0);
      return;
    }
    if (url.pathname.startsWith('/api/')) return;
    const toAr = url.pathname === '/ar' || url.pathname.startsWith('/ar/');
    if (toAr !== (root.lang === 'ar') || RM || STATIC) return;
    e.preventDefault();
    navigate(url.href, true);
  });
  W.addEventListener('popstate', () => { if (!RM && !STATIC) navigate(location.href, false); else location.reload(); });
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const topBtn = $('[data-top-btn]');
  if (topBtn) topBtn.addEventListener('click', () => scrollTo(0, { duration: 1.8 }));

  // Forms outside <main> (the footer newsletter) are wired once.
  const foot = $('.foot');
  if (foot) { modules.forms(foot); }

  D.fonts.ready.then(boot);
  W.addEventListener('load', () => { buildThread(); ScrollTrigger.refresh(); });
})();
