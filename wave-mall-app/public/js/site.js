/* The Wave: motion, navigation and interactions. GSAP + Lenis, loaded before this file. */
(function () {
  'use strict';
  if (!window.gsap || !window.ScrollTrigger) return;

  const D = document;
  const W = window;
  const root = D.documentElement;
  const RM = W.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE = W.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const isRTL = () => root.dir === 'rtl';
  const $ = (sel, scope = D) => scope.querySelector(sel);
  const $$ = (sel, scope = D) => Array.from(scope.querySelectorAll(sel));

  gsap.registerPlugin(ScrollTrigger, SplitText, CustomEase);
  CustomEase.create('wave', 'M0,0 C0.2,0.6 0.3,1 1,1');
  gsap.defaults({ ease: 'wave', duration: 1.1 });

  /* ---------- smooth scroll ---------- */
  let lenis = null;
  if (!RM && W.Lenis) {
    lenis = new Lenis({ lerp: 0.085, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  const scrollTo = (target, opts = {}) => {
    if (lenis) return lenis.scrollTo(target, { offset: 0, duration: 1.4, ...opts });
    if (typeof target === 'number') W.scrollTo({ top: target, behavior: opts.immediate ? 'auto' : 'smooth' });
    else if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth' });
  };
  const lockScroll = (on) => {
    if (lenis) on ? lenis.stop() : lenis.start();
    root.classList.toggle('is-locked', on);
    D.body.style.overflow = on ? 'hidden' : '';
  };

  /* ---------- cursor ---------- */
  const cursor = $('[data-cursor]');
  if (cursor && FINE && !RM) {
    const dotX = gsap.quickTo(cursor, 'x', { duration: 0.12, ease: 'power3' });
    const dotY = gsap.quickTo(cursor, 'y', { duration: 0.12, ease: 'power3' });
    const label = $('.cursor__label', cursor);
    W.addEventListener('mousemove', (e) => {
      root.classList.add('has-cursor');
      dotX(e.clientX);
      dotY(e.clientY);
      const t = e.target.closest && e.target.closest('[data-cursor]:not(.cursor)');
      const i = e.target.closest && e.target.closest('a, button, [data-swatch], .swatch');
      cursor.classList.toggle('is-label', !!t);
      cursor.classList.toggle('is-hover', !!i && !t);
      if (t) label.textContent = t.dataset.cursor;
    });
    D.addEventListener('mouseleave', () => root.classList.remove('has-cursor'));
    D.addEventListener('mousedown', () => cursor.classList.add('is-down'));
    D.addEventListener('mouseup', () => cursor.classList.remove('is-down'));
  }

  /* ---------- header & menu ---------- */
  const header = $('[data-header]');
  const menu = $('[data-menu]');
  const menuBtn = $('[data-menu-toggle]');
  let menuOpen = false;
  let menuTl = null;

  function buildMenuTl() {
    const links = $$('.menu__nav a', menu);
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'wave' } });
    tl.fromTo($('.menu__bg', menu), { scaleY: 0 }, { scaleY: 1, duration: 0.9 }, 0)
      .to($$('.menu__label', menu), { y: 0, duration: 1, stagger: 0.07 }, 0.25)
      .to($$('.menu__no', menu), { y: 0, duration: 1, stagger: 0.07 }, 0.3)
      .to($('.menu__aside', menu), { opacity: 1, duration: 0.8 }, 0.6)
      .to($('.menu__pattern', menu), { opacity: 0.5, duration: 1.2 }, 0.5);
    links.forEach(() => {});
    return tl;
  }
  function setMenu(open) {
    if (!menu || open === menuOpen) return;
    menuOpen = open;
    menuTl = menuTl || buildMenuTl();
    menuBtn.setAttribute('aria-expanded', String(open));
    const lbl = $('.menu-btn__label', menuBtn);
    if (lbl) lbl.textContent = open ? lbl.dataset.close : lbl.dataset.open;
    header.classList.toggle('is-menu', open);
    header.classList.remove('is-hidden');
    lockScroll(open);
    if (open) {
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      RM ? menuTl.progress(1) : menuTl.timeScale(1).play();
    } else {
      menu.setAttribute('aria-hidden', 'true');
      const done = () => menu.classList.remove('is-open');
      if (RM) { menuTl.progress(0); done(); } else menuTl.timeScale(1.6).reverse().eventCallback('onReverseComplete', done);
    }
  }
  if (menuBtn) menuBtn.addEventListener('click', () => setMenu(!menuOpen));
  D.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) setMenu(false); });

  if (header) {
    let last = 0;
    ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate(self) {
        const y = self.scroll();
        header.classList.toggle('is-solid', y > 40 && !menuOpen);
        if (!menuOpen) header.classList.toggle('is-hidden', y > 360 && y > last && self.direction === 1);
        last = y;
      },
    });
  }

  /* ---------- helpers ---------- */
  function split(el, opts, onSplit) {
    return SplitText.create(el, { type: 'lines', mask: 'lines', linesClass: 'split-line', autoSplit: true, ...opts, onSplit });
  }

  function marqueeSkew() {
    const m = $('[data-marquee]');
    if (!m || RM) return;
    const skew = gsap.quickTo(m, 'skewX', { duration: 0.6, ease: 'power3' });
    ScrollTrigger.create({ onUpdate: (self) => skew(gsap.utils.clamp(-6, 6, self.getVelocity() / -260)) });
  }

  /* ---------- page modules (each returns nothing; all tweens live in a gsap.context) ---------- */
  const modules = {
    themes(scope) {
      $$('[data-theme]', scope).forEach((el) => {
        ScrollTrigger.create({
          trigger: el,
          start: 'top 55%',
          end: 'bottom 55%',
          onToggle: (self) => { if (self.isActive) root.dataset.theme = el.dataset.theme; },
        });
      });
    },

    reveals(scope) {
      $$('[data-reveal="kicker"] > span', scope).forEach((el) => {
        gsap.to(el, { y: 0, duration: 1, scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
      });
      $$('[data-reveal="fade"]', scope).forEach((el) => {
        gsap.fromTo(el, { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: 1.2, scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
      });
      $$('[data-reveal="lines"]', scope).forEach((el) => {
        split(el, {}, (self) => {
          gsap.set(el, { visibility: 'visible' });
          return gsap.from(self.lines, { yPercent: 110, duration: 1.3, stagger: 0.09, scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
        });
      });
      $$('[data-reveal="mask"]', scope).forEach((el) => {
        const img = $('img', el);
        const tl = gsap.timeline({ scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
        tl.to(el, { clipPath: 'inset(0% 0 0 0)', duration: 1.5 }, 0);
        if (img) tl.fromTo(img, { scale: 1.3 }, { scale: 1, duration: 1.8 }, 0);
      });
      $$('[data-parallax]', scope).forEach((el) => {
        const s = parseFloat(el.dataset.parallax) || 0.2;
        gsap.fromTo(el, { yPercent: -s * 40 }, { yPercent: s * 40, ease: 'none', scrollTrigger: { trigger: el.parentElement, start: 'top bottom', end: 'bottom top', scrub: true } });
      });
      $$('[data-counter]', scope).forEach((el) => {
        const txt = el.textContent;
        const m = txt.match(/\d+/);
        if (!m) return;
        const target = Number(m[0]);
        const o = { n: 0 };
        gsap.to(o, { n: target, duration: 1.8, snap: 'n', ease: 'power2.out', onUpdate: () => { el.textContent = txt.replace(m[0], String(o.n)); }, scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
      });
    },

    hero(scope) {
      const hero = $('.hero', scope);
      if (!hero) return;
      const media = $('[data-hero-media]', hero);
      const inner = $('.hero__inner', hero);
      const edge = $('.hero__edge path', hero);
      gsap.to(media, { yPercent: 18, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to(inner, { yPercent: 12, opacity: 0.2, ease: 'none', scrollTrigger: { trigger: hero, start: '30% top', end: 'bottom top', scrub: true } });
      if (edge) gsap.to(edge, { attr: { d: edge.dataset.flat }, ease: 'none', scrollTrigger: { trigger: hero, start: '40% top', end: 'bottom top', scrub: true } });
    },

    marquee() { marqueeSkew(); },

    manifesto(scope) {
      const el = $('[data-manifesto]', scope);
      if (!el) return;
      SplitText.create(el, {
        type: 'words',
        wordsClass: 'word',
        autoSplit: true,
        onSplit: (self) => gsap.fromTo(self.words, { opacity: 0.14 }, { opacity: 1, stagger: 0.04, ease: 'none', scrollTrigger: { trigger: el, start: 'top 78%', end: 'bottom 55%', scrub: 0.6 } }),
      });
    },

    pano(scope) {
      const sec = $('[data-pano]', scope);
      if (!sec) return;
      const vp = $('[data-pano-viewport]', sec);
      const track = $('[data-pano-track]', sec);
      const bar = $('[data-pano-progress]', sec);
      const imgs = $$('.pano__media img', sec);
      const mm = gsap.matchMedia();
      mm.add('(min-width: 900px)', () => {
        const dist = () => track.scrollWidth - vp.clientWidth;
        const st = {
          trigger: vp,
          pin: true,
          start: 'center center',
          end: () => '+=' + dist() * 1.05,
          scrub: 1,
          invalidateOnRefresh: true,
          anticipatePin: 1,
          onUpdate: (self) => bar && bar.style.setProperty('--p', self.progress.toFixed(4)),
        };
        gsap.to(track, { x: () => (isRTL() ? dist() : -dist()), ease: 'none', scrollTrigger: st });
        gsap.fromTo(imgs, { xPercent: -6 }, { xPercent: 6, ease: 'none', scrollTrigger: { ...st, pin: false, onUpdate: null } });
      });
      mm.add('(max-width: 899px)', () => {
        const onScroll = () => {
          const max = vp.scrollWidth - vp.clientWidth;
          bar && bar.style.setProperty('--p', max ? (Math.abs(vp.scrollLeft) / max).toFixed(4) : '0');
        };
        vp.addEventListener('scroll', onScroll, { passive: true });
        gsap.to(imgs, { scale: 1.02, duration: 0.1 });
        return () => vp.removeEventListener('scroll', onScroll);
      });
    },

    stack(scope) {
      const cards = $$('[data-stack-card]', scope);
      cards.forEach((card, i) => {
        const img = $('img', card);
        if (img) gsap.fromTo(img, { yPercent: -8 }, { yPercent: 8, ease: 'none', scrollTrigger: { trigger: card, start: 'top bottom', end: 'bottom top', scrub: true } });
        const next = cards[i + 1];
        if (next) {
          gsap.to(card, { scale: 0.94, filter: 'brightness(0.72)', ease: 'none', scrollTrigger: { trigger: next, start: 'top bottom', end: 'top top', scrub: true } });
        }
        gsap.from($$('.stack__body > *', card), { y: 40, opacity: 0, stagger: 0.08, duration: 1.2, scrollTrigger: { trigger: card, start: 'top 60%', once: true } });
      });
    },

    mark(scope) {
      const sec = $('[data-mark]', scope);
      if (!sec) return;
      const logo = $('[data-mark-logo]', sec);
      const svg = $('svg', logo);
      const fill = $('.logo-fill', svg);
      const draw = $('.l-draw', svg);
      const ways = [
        { bg: '#283833', fg: '#d1c9b3', accent: '#a2c5b9' },
        { bg: '#7c4d28', fg: '#d1c9b3', accent: '#a2c5b9' },
        { bg: '#a2c5b9', fg: '#7c4d28', accent: '#283833' },
        { bg: '#d1c9b3', fg: '#283833', accent: '#7c4d28' },
      ];
      let i = 0;
      const tl = gsap.timeline({ scrollTrigger: { trigger: sec, start: 'top 60%', once: true } });
      tl.to(draw, { strokeDashoffset: 0, duration: 2.2, ease: 'power2.inOut' })
        .to(fill, { opacity: 1, duration: 1.4 }, '-=0.9')
        .to(draw, { opacity: 0, duration: 0.8 }, '-=0.6');
      if (!RM) gsap.to($('.l-av', svg), { y: -5, duration: 2.4, repeat: -1, yoyo: true, ease: 'sine.inOut' });
      const cycle = () => {
        i = (i + 1) % ways.length;
        sec.dataset.colorway = String(i);
        gsap.to(sec, { '--mark-bg': ways[i].bg, '--mark-fg': ways[i].fg, '--mark-accent': ways[i].accent, duration: 0.9, ease: 'power2.inOut' });
        gsap.fromTo(svg, { scale: 0.96 }, { scale: 1, duration: 0.9 });
      };
      logo.addEventListener('click', cycle);
      const hint = $('[data-mark-cycle]', sec);
      if (hint) hint.addEventListener('click', cycle);
      if (FINE && !RM) {
        const rx = gsap.quickTo(svg, 'rotationY', { duration: 0.8, ease: 'power3' });
        const ry = gsap.quickTo(svg, 'rotationX', { duration: 0.8, ease: 'power3' });
        const mx = gsap.quickTo(svg, 'x', { duration: 0.8, ease: 'power3' });
        const my = gsap.quickTo(svg, 'y', { duration: 0.8, ease: 'power3' });
        sec.addEventListener('mousemove', (e) => {
          const r = sec.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5;
          const py = (e.clientY - r.top) / r.height - 0.5;
          rx(px * 14); ry(-py * 10); mx(px * 24); my(py * 18);
        });
        sec.addEventListener('mouseleave', () => { rx(0); ry(0); mx(0); my(0); });
      }
    },

    video(scope) {
      $$('[data-lazy-video]', scope).forEach((v) => {
        const io = new IntersectionObserver((entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) { if (v.readyState === 0) v.load(); v.play().catch(() => {}); }
            else v.pause();
          });
        }, { rootMargin: '200px' });
        io.observe(v);
      });
    },

    pins(scope) {
      const pins = $$('[data-pin]', scope);
      if (!pins.length) return;
      gsap.to(pins, { opacity: 1, duration: 0.01, delay: 0.5 });
      gsap.from(pins, { scale: 0, duration: 0.9, stagger: 0.09, ease: 'back.out(1.6)', delay: 0.5, transformOrigin: 'left center' });
      const frame = $('[data-map-frame]', scope);
      if (frame) gsap.fromTo(frame, { scale: 1.12 }, { scale: 1, duration: 2.4, ease: 'power2.out' });
    },

    timeline(scope) {
      const sec = $('[data-timeline]', scope);
      if (!sec) return;
      const fill = $('[data-tl-fill]', sec);
      const sun = $('[data-tl-sun]', sec);
      const body = $('.tl__body', sec);
      const st = { trigger: body, start: 'top 55%', end: 'bottom 55%', scrub: 0.5 };
      gsap.fromTo(fill, { scaleY: 0 }, { scaleY: 1, ease: 'none', scrollTrigger: st });
      gsap.fromTo(sun, { top: '0%' }, { top: '100%', ease: 'none', scrollTrigger: st });
      $$('[data-tl-step]', sec).forEach((step) => {
        gsap.from($$('time, h3, p', step), { y: 40, opacity: 0, stagger: 0.1, duration: 1.2, scrollTrigger: { trigger: step, start: 'top 70%', once: true } });
      });
    },

    palette(scope) {
      $$('[data-swatch]', scope).forEach((sw) => {
        sw.addEventListener('click', () => {
          const hex = sw.dataset.hex;
          if (navigator.clipboard) navigator.clipboard.writeText(hex).catch(() => {});
          sw.classList.add('is-copied');
          setTimeout(() => sw.classList.remove('is-copied'), 1400);
        });
      });
      const list = $('.swatches', scope);
      if (list) gsap.from($$('.swatch', list), { yPercent: 30, opacity: 0, stagger: 0.1, duration: 1.3, scrollTrigger: { trigger: list, start: 'top 80%', once: true } });
    },

    magnetic(scope) {
      if (!FINE || RM) return;
      $$('[data-magnetic]', scope).forEach((el) => {
        const x = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3' });
        const y = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3' });
        el.addEventListener('mousemove', (e) => {
          const r = el.getBoundingClientRect();
          x((e.clientX - (r.left + r.width / 2)) * 0.3);
          y((e.clientY - (r.top + r.height / 2)) * 0.3);
        });
        el.addEventListener('mouseleave', () => { gsap.to(el, { x: 0, y: 0, duration: 1, ease: 'elastic.out(1, 0.4)' }); });
      });
    },

    form(scope) {
      const form = $('[data-enquiry]', scope);
      if (!form) return;
      const status = $('[data-form-status]', form);
      const btn = $('button[type=submit]', form);
      const say = (msg, ok) => {
        status.hidden = false;
        status.textContent = msg;
        status.className = 'form-status ' + (ok ? 'form-status--ok' : 'form-status--err');
        status.focus && status.setAttribute('tabindex', '-1');
        status.focus();
      };
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        $$('[data-field]', form).forEach((f) => f.classList.remove('is-invalid'));
        if (!form.checkValidity()) {
          $$('input, select, textarea', form).forEach((i) => { if (!i.checkValidity()) i.closest('[data-field]') && i.closest('[data-field]').classList.add('is-invalid'); });
          say(form.dataset.fail, false);
          return;
        }
        const label = $('span', btn);
        const orig = label ? label.textContent : '';
        btn.disabled = true;
        if (label) label.textContent = form.dataset.sending;
        try {
          const res = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.ok) { say(form.dataset.ok, true); form.reset(); }
          else {
            (data.errors || []).forEach((n) => { const i = form.elements[n]; i && i.closest('[data-field]') && i.closest('[data-field]').classList.add('is-invalid'); });
            say(form.dataset.fail, false);
          }
        } catch (err) { say(form.dataset.fail, false); }
        btn.disabled = false;
        if (label) label.textContent = orig;
      });
    },
  };

  let pageCtx = null;
  function initPage(scope) {
    if (pageCtx) pageCtx.revert();
    pageCtx = gsap.context(() => {
      Object.values(modules).forEach((fn) => { try { fn(scope); } catch (err) { console.error(err); } });
    }, scope);
    ScrollTrigger.refresh();
  }

  /* ---------- intros ---------- */
  function heroIntro(scope) {
    const hero = $('.hero', scope);
    const tl = gsap.timeline({ defaults: { ease: 'wave' } });
    if (hero) {
      tl.fromTo($('.hero__img', hero), { scale: 1.25 }, { scale: 1.12, duration: 2.4, ease: 'power2.out' }, 0)
        .to($('[data-hero-pill]', hero), { opacity: 1, duration: 1 }, 0.3)
        .to($$('.hero__line > span, .hero__line > em', hero), { y: 0, duration: 1.4, stagger: 0.14 }, 0.35)
        .to($('[data-hero-foot]', hero), { opacity: 1, y: 0, duration: 1.2 }, 1)
        .to($('[data-hero-cue]', hero), { opacity: 1, duration: 1 }, 1.3);
    }
    const phero = $('.phero', scope);
    const pimg = phero && $('.phero__img', phero);
    if (pimg) tl.fromTo(pimg, { scale: 1.2 }, { scale: 1, duration: 2.6, ease: 'power2.out' }, 0);
    return tl;
  }

  /* ---------- loader ---------- */
  const loader = $('[data-loader]');
  const main = $('#main');

  function boot() {
    const seen = (() => { try { return sessionStorage.getItem('wave-seen'); } catch (e) { return true; } })();
    if (!loader || RM || seen) {
      if (loader) loader.remove();
      initPage(main);
      heroIntro(main);
      return;
    }
    try { sessionStorage.setItem('wave-seen', '1'); } catch (e) { /* private mode */ }
    lockScroll(true);
    const letters = $$('.logo-fill .l', loader);
    const draw = $('.l-draw', loader);
    const edge = $('.loader__edge path', loader);
    const tl = gsap.timeline({
      defaults: { ease: 'wave' },
      onComplete() { loader.remove(); lockScroll(false); },
    });
    tl.to($('.loader__bar i', loader), { scaleX: 1, duration: 2.6, ease: 'power1.inOut' }, 0)
      .to(draw, { strokeDashoffset: 0, duration: 1.6, ease: 'power2.inOut' }, 0.1)
      .fromTo(letters, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 1, stagger: 0.08 }, 0.9)
      .to(draw, { opacity: 0, duration: 0.6 }, 1.9)
      .to($('.loader__line', loader), { opacity: 1, duration: 0.8 }, 1.2)
      .add(() => { initPage(main); }, 2.4)
      .to(edge, { attr: { d: edge.dataset.curve }, duration: 0.6 }, 2.5)
      .to(loader, { yPercent: -115, duration: 1.3, ease: 'power3.inOut' }, 2.6)
      .add(() => { heroIntro(main); }, 2.9);
  }

  /* ---------- page transitions ---------- */
  const curtain = $('[data-curtain]');
  let navigating = false;

  function curtainIn() {
    const logo = $('.curtain__logo', curtain);
    const tl = gsap.timeline();
    tl.set(curtain, { y: 0, yPercent: 110 })
      .to(curtain, { yPercent: 0, duration: 0.9, ease: 'power3.inOut' })
      .fromTo(logo, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6 }, '-=0.3');
    return tl;
  }
  function curtainOut() {
    const logo = $('.curtain__logo', curtain);
    const tl = gsap.timeline();
    tl.to(logo, { opacity: 0, duration: 0.3 })
      .to(curtain, { yPercent: -115, duration: 0.95, ease: 'power3.inOut' }, 0.05)
      .set(curtain, { y: 0, yPercent: 110 });
    return tl;
  }

  // Hold the curtain until the new page's hero image is in, so it never opens on a blank hero.
  function heroImageReady(scope) {
    const img = $('.hero__img, .phero__img, .map__media img', scope);
    if (!img || img.complete) return Promise.resolve();
    return Promise.race([
      new Promise((res) => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); }),
      new Promise((res) => setTimeout(res, 1800)),
    ]);
  }

  function updateNav(pathname) {
    $$('.nav a, .menu__nav a').forEach((a) => {
      const href = a.getAttribute('href');
      href === pathname ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
  }

  async function navigate(href, push) {
    if (navigating) return;
    navigating = true;
    if (menuOpen) setMenu(false);
    const fetching = fetch(href, { headers: { 'X-Requested-With': 'wave' } }).then((r) => { if (!r.ok && r.status !== 404) throw new Error(r.status); return r.text(); });
    const inTl = curtainIn();
    let html;
    try {
      [html] = await Promise.all([fetching, new Promise((res) => inTl.eventCallback('onComplete', res))]);
    } catch (err) {
      location.href = href;
      return;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const next = doc.querySelector('#main');
    if (!next) { location.href = href; return; }
    if (pageCtx) { pageCtx.revert(); pageCtx = null; }
    main.innerHTML = next.innerHTML;
    main.dataset.page = next.dataset.page;
    D.title = doc.title;
    const desc = D.querySelector('meta[name=description]');
    const ndesc = doc.querySelector('meta[name=description]');
    if (desc && ndesc) desc.setAttribute('content', ndesc.getAttribute('content'));
    root.dataset.theme = doc.documentElement.dataset.theme || 'forest';
    if (push) history.pushState({ wave: true }, '', href);
    updateNav(new URL(href, location.href).pathname);
    scrollTo(0, { immediate: true });
    W.scrollTo(0, 0);
    header.classList.remove('is-hidden');
    await D.fonts.ready;
    await heroImageReady(main);
    initPage(main);
    const outTl = curtainOut();
    outTl.add(() => heroIntro(main), 0.25);
    outTl.eventCallback('onComplete', () => { navigating = false; });
  }

  // Static exports (no server) set data-static on <html>: plain navigation, no fetch-and-swap.
  const STATIC = root.hasAttribute('data-static');
  D.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    if (a.hasAttribute('data-full-nav') || a.target === '_blank' || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname) {
      if (url.hash) {
        e.preventDefault();
        const target = $(url.hash);
        if (menuOpen) setMenu(false);
        if (target) scrollTo(target, { offset: 0 });
      } else if (menuOpen) { e.preventDefault(); setMenu(false); }
      return;
    }
    if (url.pathname.startsWith('/api/')) return;
    const toAr = url.pathname === '/ar' || url.pathname.startsWith('/ar/');
    if (toAr !== (root.lang === 'ar')) return;
    if (RM || !curtain || STATIC) return;
    e.preventDefault();
    navigate(url.href, true);
  });
  W.addEventListener('popstate', () => { if (!RM && curtain && !STATIC) navigate(location.href, false); else location.reload(); });
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const topBtn = $('[data-top]');
  if (topBtn) topBtn.addEventListener('click', () => scrollTo(0, { duration: 1.8 }));

  /* ---------- go ---------- */
  D.fonts.ready.then(boot);
  W.addEventListener('load', () => ScrollTrigger.refresh());
})();
