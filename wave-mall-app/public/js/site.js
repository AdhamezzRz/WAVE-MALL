/* The Wave: motion and interaction. GSAP + ScrollTrigger + Lenis load before this file.
   Nothing fades. Things are revealed by masks, wipes and lines. */
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
  const EASE = 'power3.inOut';
  const OUT = 'power3.out';
  const NUM = new Intl.NumberFormat(root.lang === 'ar' ? 'ar-EG' : 'en-US');

  gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ ease: OUT, duration: 1.2 });

  /* ---------- the hourglass ---------- */
  // The building's footprint as one path, in 0..1 units of a frame with the given aspect.
  // s scales the plan around the centre; t opens it out to the frame's edges.
  const SHAPE = [
    ['M', 140, 40], ['L', 860, 40], ['Q', 960, 40, 960, 110], ['C', 960, 165, 862, 228, 862, 320], ['C', 862, 412, 960, 475, 960, 530],
    ['Q', 960, 600, 860, 600], ['L', 140, 600], ['Q', 40, 600, 40, 530], ['C', 40, 475, 138, 412, 138, 320], ['C', 138, 228, 40, 165, 40, 110], ['Q', 40, 40, 140, 40],
  ];
  function hourglass({ t = 0, s = 1, aspect = W.innerWidth / W.innerHeight, fit = 0.5, cy = 0.5, sx = 1, sy = 1 } = {}) {
    const portrait = aspect < 1;
    const w0 = (portrait ? 0.84 : fit) * s;
    const h0 = portrait ? w0 * aspect * 1.5625 : (w0 * aspect) / 1.5625;
    const map = (u, v) => (portrait ? [0.5 + (v / 640 - 0.5) * w0, cy + (u / 1000 - 0.5) * h0] : [0.5 + (u / 1000 - 0.5) * w0, cy + (v / 640 - 0.5) * h0]);
    const edge = (b) => (b < 0.4999 ? -0.03 : b > 0.5001 ? 1.03 : 0.5);
    const f = (n) => n.toFixed(4);
    let d = '';
    for (const [cmd, ...xy] of SHAPE) {
      d += cmd;
      for (let i = 0; i < xy.length; i += 2) {
        const [bx, by] = map(xy[i], xy[i + 1]);
        const ey = by < cy - 0.0001 ? -0.03 : by > cy + 0.0001 ? 1.03 : by;
        d += ` ${f((bx + (edge(bx) - bx) * t) * sx)} ${f((by + (ey - by) * t) * sy)}`;
      }
      d += ' ';
    }
    return d + 'Z';
  }

  /* ---------- smooth scroll ---------- */
  let lenis = null;
  if (!RM && W.Lenis) {
    lenis = new Lenis({ lerp: 0.075, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  const scrollTo = (target, opts = {}) => {
    if (lenis) return lenis.scrollTo(target, { duration: 1.6, ...opts });
    if (typeof target === 'number') W.scrollTo({ top: target, behavior: opts.immediate ? 'auto' : 'smooth' });
    else target.scrollIntoView({ behavior: 'smooth' });
  };
  const lock = (on) => { if (lenis) on ? lenis.stop() : lenis.start(); D.body.style.overflow = on ? 'hidden' : ''; };

  /* ---------- header, lift display, floor rail ---------- */
  const top = $('[data-top]');
  const lift = $('[data-lift]');
  const liftDir = $('[data-lift-dir]');
  const rail = $$('[data-rail] span');
  const FLOORS = rail.length ? rail.map((s) => s.dataset.floor) : ['R', '4', '3', '2', '1', 'G', 'B1', 'B2'];
  let floorIdx = -1;
  let menuOpen = false;

  function setFloor(i, dir) {
    if (i === floorIdx) return;
    floorIdx = i;
    rail.forEach((s, k) => s.classList.toggle('is-on', k === i));
    if (lift) {
      if (RM) lift.textContent = FLOORS[i];
      else gsap.timeline().to(lift, { yPercent: dir > 0 ? -110 : 110, duration: 0.18, ease: 'power2.in' }).add(() => { lift.textContent = FLOORS[i]; }).fromTo(lift, { yPercent: dir > 0 ? 110 : -110 }, { yPercent: 0, duration: 0.3, ease: OUT });
    }
    if (liftDir) liftDir.classList.toggle('is-up', dir < 0);
  }
  // White type while the header sits over the hero photograph (once it has opened).
  const railEl = $('[data-rail]');
  function paintTop(y) {
    if (!top) return;
    const hero = $('#main [data-hero]');
    const light = !!hero && !!hero._opened && !menuOpen && y < hero.offsetHeight - top.offsetHeight * 0.6;
    top.classList.toggle('is-light', light);
    top.classList.toggle('is-solid', y > 30 && !light && !menuOpen);
    if (railEl) railEl.classList.toggle('is-light', light);
  }
  let lastY = 0;
  ScrollTrigger.create({
    start: 0,
    end: 'max',
    onUpdate(self) {
      const y = self.scroll();
      const p = self.end > 0 ? y / self.end : 0;
      setFloor(Math.min(FLOORS.length - 1, Math.floor(p * FLOORS.length)), self.direction);
      if (top && !menuOpen) {
        paintTop(y);
        top.classList.toggle('is-away', y > 400 && y > lastY && self.direction === 1);
      }
      lastY = y;
    },
  });
  rail.forEach((s, k) => {
    s.style.pointerEvents = 'auto';
    s.style.cursor = 'pointer';
    s.addEventListener('click', () => scrollTo((ScrollTrigger.maxScroll(W) * (k + 0.5)) / FLOORS.length));
  });

  /* ---------- menu: the list beside a photograph of each place ---------- */
  const menu = $('[data-menu]');
  const menuBtn = $('[data-menu-toggle]');
  const menuMedia = menu && $('.menu__media', menu);
  const menuImgs = menu ? $$('[data-menu-img]', menu) : [];
  const menuItems = menu ? $$('[data-menu-item]', menu) : [];
  const HIDE = 'inset(100% 0% 0% 0%)';
  let menuImg = menuImgs.findIndex((i) => i.classList.contains('is-on'));
  function showMenuImg(k, instant) {
    const next = menuImgs[k];
    if (!next || k === menuImg) return;
    const prev = menuImgs[menuImg];
    menuImg = k;
    gsap.killTweensOf(menuImgs);
    menuImgs.forEach((i) => { if (i !== prev && i !== next) { i.classList.remove('is-on'); gsap.set(i, { clipPath: HIDE, zIndex: 0 }); } });
    const done = () => { if (prev) { prev.classList.remove('is-on'); gsap.set(prev, { clipPath: HIDE, zIndex: 0 }); } next.classList.add('is-on'); };
    if (instant) { gsap.set(next, { clipPath: 'inset(0% 0% 0% 0%)', scale: 1, zIndex: 2 }); done(); return; }
    if (prev) gsap.set(prev, { zIndex: 1 });
    gsap.set(next, { zIndex: 2 });
    gsap.fromTo(next, { clipPath: HIDE, scale: 1.1 }, { clipPath: 'inset(0% 0% 0% 0%)', scale: 1, duration: 1.1, ease: EASE, onComplete: done });
  }
  menuItems.forEach((a) => {
    const k = Number(a.dataset.menuItem);
    a.addEventListener('mouseenter', () => showMenuImg(k));
    a.addEventListener('focus', () => showMenuImg(k));
  });
  function setMenu(open) {
    if (!menu || open === menuOpen) return;
    menuOpen = open;
    menuBtn.setAttribute('aria-expanded', String(open));
    const lbl = $('span', menuBtn);
    lbl.textContent = open ? lbl.dataset.close : lbl.dataset.open;
    menu.setAttribute('aria-hidden', String(!open));
    top.classList.remove('is-away');
    top.classList.toggle('is-menu', open);
    if (!open) paintTop(W.scrollY);
    lock(open);
    const names = $$('.menu__name > span', menu);
    const small = $$('.menu__nav i, .menu__nav small, .menu__foot > div', menu);
    if (open) {
      menuImgs.forEach((i) => { if (i.dataset.src) { i.src = i.dataset.src; delete i.dataset.src; } });
      const here = menuItems.findIndex((a) => a.hasAttribute('aria-current'));
      showMenuImg(here < 0 ? 0 : here, true);
      menu.classList.add('is-open');
      gsap.timeline()
        .fromTo(menu, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1, ease: EASE })
        .fromTo(menuMedia, { clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.3, ease: EASE }, 0.2)
        .fromTo(menuImgs[menuImg] || [], { scale: 1.16 }, { scale: 1, duration: 2, ease: OUT }, 0.2)
        .fromTo(names, { yPercent: 108 }, { yPercent: 0, duration: 1.1, stagger: 0.05, ease: OUT }, 0.35)
        .fromTo(small, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.9, stagger: 0.03, ease: OUT }, 0.6);
    } else {
      gsap.timeline({ onComplete: () => menu.classList.remove('is-open') })
        .to(names, { yPercent: -108, duration: 0.45, stagger: 0.02, ease: 'power2.in' })
        .to(menu, { clipPath: 'inset(0% 0% 100% 0%)', duration: 0.8, ease: EASE }, 0.2);
    }
  }
  if (menuBtn) menuBtn.addEventListener('click', () => setMenu(!menuOpen));
  D.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) setMenu(false); });

  /* ---------- page modules ---------- */
  function drawPlan(svg, { delay = 0, duration = 1.6 } = {}) {
    const els = $$('.plan__outline, .plan__unit, .plan__line, .plan__tick, .plan__terrace', svg);
    els.forEach((el) => el.setAttribute('pathLength', '1'));
    return gsap.fromTo(els, { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration, delay, ease: 'power2.inOut', stagger: { amount: 0.8, from: 'center' } });
  }
  function countUp(el, to, duration = 1.6) {
    const o = { n: 0 };
    return gsap.to(o, { n: to, duration, ease: 'power2.out', onUpdate: () => { el.textContent = NUM.format(Math.round(o.n)); } });
  }

  const modules = {
    hero(scope) {
      const hero = $('[data-hero]', scope);
      if (!hero) return;
      const slides = $$('[data-hero-slide]', hero);
      const times = $$('[data-hero-times] li', hero);
      const bars = times.map((li) => $('u', li));
      const win = $('[data-hero-window]', hero);
      const winPath = win && $('path', win);
      const media = $('.hero__media', hero);
      const content = $('.hero__content', hero);
      const OFF = root.dir === 'rtl' ? 'inset(0% 100% 0% 0%)' : 'inset(0% 0% 0% 100%)';
      const HOLD = 6.5;
      let cur = 0;
      let timer = null;
      let running = false;
      hero._opened = RM;
      // the building's plan, cut out of the page, opens onto the photograph
      const setWin = (sc) => winPath && winPath.setAttribute('d', `M0 0H1V1H0Z ${hourglass({ s: sc, aspect: hero.offsetWidth / hero.offsetHeight, fit: 0.5 })}`);
      setWin(0.0001);

      function run() {
        if (timer) timer.kill();
        if (!running || !hero.isConnected || slides.length < 2) return;
        timer = gsap.fromTo(bars[cur], { scaleX: 0 }, { scaleX: 1, duration: HOLD, ease: 'none', onComplete: () => go((cur + 1) % slides.length) });
      }
      function go(k) {
        if (k === cur || !hero.isConnected) return;
        const prev = slides[cur];
        const next = slides[k];
        times[cur].classList.remove('is-on');
        times[k].classList.add('is-on');
        gsap.set(bars, { scaleX: 0 });
        slides.forEach((sl, i) => gsap.set(sl, { zIndex: i === k ? 2 : i === cur ? 1 : 0 }));
        gsap.fromTo(next, { clipPath: OFF }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.7, ease: EASE, onComplete() { prev.classList.remove('is-on'); gsap.set(prev, { clipPath: OFF }); next.classList.add('is-on'); } });
        gsap.fromTo($('img', next), { scale: 1.16 }, { scale: 1.04, duration: 2.6, ease: OUT });
        cur = k;
        run();
      }
      times.forEach((li, k) => li.addEventListener('click', () => go(k)));
      // pause the day while the hero is out of view
      ScrollTrigger.create({ trigger: hero, start: 'top bottom', end: 'bottom top', onToggle(self) { running = self.isActive && !!hero._started; if (running) run(); else if (timer) timer.kill(); } });
      gsap.to(media, { yPercent: 16, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to(content, { yPercent: -10, ease: 'none', scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true } });

      hero._intro = () => {
        hero._started = true;
        running = true;
        const o = { s: 0.0001 };
        gsap.timeline()
          .to(o, { s: 3.6, duration: 2.1, ease: 'power3.inOut', onUpdate: () => setWin(o.s), onComplete() { if (win) win.style.display = 'none'; hero._opened = true; paintTop(W.scrollY); } }, 0)
          .fromTo($('img', slides[0]), { scale: 1.22 }, { scale: 1.04, duration: 3, ease: OUT }, 0)
          .to($('[data-hero-kicker]', hero), { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.1, ease: EASE }, 1.2)
          .to($$('.title--hero span, .title--hero em', hero), { clipPath: 'inset(0 0 0% 0)', y: 0, duration: 1.5, stagger: 0.14, ease: OUT }, 1.3)
          .to($('.hero__foot', hero), { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.4, ease: EASE }, 1.7)
          .add(run, 2);
      };
    },

    lights(scope) {
      const sec = $('[data-lights]', scope);
      if (!sec) return;
      const slides = $$('[data-light]', sec);
      const texts = $$('[data-light-text]', sec);
      const bar = $('[data-lights-bar]', sec);
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: sec, start: 'top top', end: 'bottom bottom', scrub: 0.6,
          onUpdate: (self) => {
            const i = Math.min(slides.length - 1, Math.floor(self.progress * slides.length * 0.999));
            texts.forEach((t, k) => t.classList.toggle('is-on', k === i));
          },
        },
      });
      tl.to(bar, { scaleX: 1, ease: 'none', duration: slides.length }, 0);
      slides.forEach((sl, i) => {
        const img = $('img', sl);
        tl.fromTo(img, { scale: 1.12 }, { scale: 1, ease: 'none', duration: 1 }, Math.max(0, i - 0.6));
        if (i) tl.to(sl, { clipPath: 'inset(0% 0 0 0)', ease: 'power2.inOut', duration: 0.6 }, i - 0.6);
      });
    },

    reveals(scope) {
      $$('[data-rise]', scope).forEach((el) => {
        gsap.to(el, { clipPath: 'inset(0 0 0% 0)', y: 0, duration: 1.3, ease: OUT, scrollTrigger: { trigger: el, start: 'top 90%', once: true } });
      });
      $$('[data-wipe]', scope).forEach((el) => {
        const clipEl = $('.frame__clip', el);
        const img = $('img', el);
        gsap.timeline({ scrollTrigger: { trigger: el, start: 'top 88%', once: true } })
          .to(clipEl, { clipPath: 'inset(0% 0 0 0)', duration: 1.5, ease: EASE }, 0)
          .to(img, { scale: 1, duration: 2.2, ease: OUT }, 0);
        if (img && !el.closest('.card')) gsap.fromTo(img, { yPercent: -4 }, { yPercent: 4, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } });
      });
      $$('[data-count]', scope).forEach((el) => {
        if (el.closest('[data-floor-panel]')) return;
        ScrollTrigger.create({ trigger: el, start: 'top 90%', once: true, onEnter: () => countUp(el, Number(el.dataset.count)) });
      });
      $$('[data-draw] .plan', scope).forEach((svg) => {
        const els = $$('.plan__outline, .plan__unit, .plan__line, .plan__tick, .plan__terrace', svg);
        els.forEach((e) => e.setAttribute('pathLength', '1'));
        gsap.set(els, { strokeDasharray: 1, strokeDashoffset: 1 });
        ScrollTrigger.create({ trigger: svg, start: 'top 80%', once: true, onEnter: () => drawPlan(svg) });
      });
    },

    directory(scope) {
      const dir = $('[data-directory]', scope);
      if (!dir) return;
      const btns = $$('[data-floor-btn]', dir);
      const show = (id, animate = true) => {
        btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.floorBtn === id)));
        $$('[data-floor-panel]', dir).forEach((p) => {
          const on = p.dataset.floorPanel === id;
          p.hidden = !on;
          if (on && animate) {
            drawPlan($('.plan', p), { duration: 1.2 });
            $$('[data-count]', p).forEach((n) => countUp(n, Number(n.dataset.count), 1.1));
            gsap.fromTo($('.dir__facts', p), { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 1, ease: EASE });
          }
        });
      };
      btns.forEach((b, i) => {
        b.addEventListener('click', () => show(b.dataset.floorBtn));
        b.addEventListener('keydown', (e) => {
          const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
          if (!k) return;
          e.preventDefault();
          const n = btns[(i + k + btns.length) % btns.length];
          n.focus();
          show(n.dataset.floorBtn);
        });
      });
      const first = $('[aria-pressed="true"]', dir) || btns[0];
      const panel = $(`[data-floor-panel="${first.dataset.floorBtn}"] .plan`, dir);
      const els = $$('.plan__outline, .plan__unit, .plan__line, .plan__tick, .plan__terrace', panel);
      els.forEach((e) => e.setAttribute('pathLength', '1'));
      gsap.set(els, { strokeDasharray: 1, strokeDashoffset: 1 });
      ScrollTrigger.create({ trigger: dir, start: 'top 65%', once: true, onEnter: () => show(first.dataset.floorBtn) });
    },

    schedule(scope) {
      const sec = $('[data-schedule]', scope);
      if (!sec) return;
      const tabs = $$('[data-tab]', sec);
      tabs.forEach((tab) =>
        tab.addEventListener('click', () => {
          tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
          $$('[data-pane]', sec).forEach((p) => {
            p.hidden = p.dataset.pane !== tab.dataset.tab;
            if (!p.hidden) {
              drawPlan($('.plan', p), { duration: 1.2 });
              gsap.fromTo($('.schedule__table', p), { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 1.1, ease: EASE });
            }
          });
        }),
      );
      $$('[data-pane]', sec).forEach((pane) => {
        const rows = $$('[data-unit-row]', pane);
        const units = $$('.plan [data-unit]', pane);
        const light = (n) => {
          rows.forEach((r) => r.classList.toggle('is-on', r.dataset.unitRow === n));
          units.forEach((u) => u.classList.toggle('is-on', u.dataset.unit === n));
        };
        rows.forEach((r) => {
          ['mouseenter', 'focus'].forEach((ev) => r.addEventListener(ev, () => light(r.dataset.unitRow)));
          ['mouseleave', 'blur'].forEach((ev) => r.addEventListener(ev, () => light(null)));
        });
        units.forEach((u) => {
          u.addEventListener('mouseenter', () => light(u.dataset.unit));
          u.addEventListener('mouseleave', () => light(null));
          u.addEventListener('click', () => { const r = rows.find((x) => x.dataset.unitRow === u.dataset.unit); if (r) r.focus(); });
        });
      });
    },

    mark(scope) {
      $$('[data-mark]', scope).forEach((sec) => {
        const svg = $('.logo', sec);
        const draw = $('.l-draw', svg);
        gsap.timeline({ scrollTrigger: { trigger: sec, start: 'top 65%', once: true } })
          .to(draw, { strokeDashoffset: 0, duration: 2, ease: 'power2.inOut' })
          .to($('.logo__fill', svg), { clipPath: 'inset(0 0% 0 0)', duration: 1.6, ease: EASE }, 1.1)
          .to(draw, { strokeDashoffset: -1, duration: 1.2, ease: 'power2.in' }, 2.2);
      });
    },

    amap(scope) {
      $$('[data-amap]', scope).forEach((map) => {
        const stage = $('[data-amap-stage]', map);
        const svg = $('svg', map);
        const VW = svg.viewBox.baseVal.width;
        const pins = $$('.amap__pin', map);
        const items = $$('.amap__legend [data-place]', map);
        // marks keep their size on screen: --k is map units per pixel
        const fit = () => { const w = svg.getBoundingClientRect().width; if (w) map.style.setProperty('--k', (VW / w).toFixed(3)); };
        fit();
        if (W.ResizeObserver) new ResizeObserver(fit).observe(svg);
        // name tags sized to their text; flipped to the left near the east edge
        pins.forEach((p) => {
          const rect = $('.amap__tip rect', p);
          const text = $('.amap__tip text', p);
          const len = text.getComputedTextLength();
          rect.setAttribute('width', String(len + 20));
          if (p.hasAttribute('data-left')) { rect.setAttribute('x', String(-15 - len - 20)); text.setAttribute('x', String(-15 - len - 10)); }
        });
        // phones and tablets: the map scrolls sideways, opening on The Wave
        const panTo = (frac, smooth) => {
          const max = stage.scrollWidth - stage.clientWidth;
          if (max < 2) return;
          stage.scrollTo({ left: Math.max(0, Math.min(max, frac * stage.scrollWidth - stage.clientWidth / 2)), behavior: smooth ? 'smooth' : 'auto' });
        };
        panTo(Number(map.dataset.wx), false);
        const on = (id) => {
          pins.forEach((p) => p.classList.toggle('is-on', p.dataset.place === id));
          items.forEach((b) => b.classList.toggle('is-on', b.dataset.place === id));
          const pin = pins.find((p) => p.dataset.place === id);
          if (pin) pin.parentNode.appendChild(pin);
        };
        pins.forEach((p) => {
          p.addEventListener('pointerenter', () => on(p.dataset.place));
          p.addEventListener('click', () => on(p.dataset.place));
        });
        items.forEach((b) => {
          b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') on(b.dataset.place); });
          b.addEventListener('focus', () => on(b.dataset.place));
          b.addEventListener('click', () => {
            on(b.dataset.place);
            const pin = pins.find((p) => p.dataset.place === b.dataset.place);
            if (pin) panTo(Number(pin.dataset.x) / VW, true);
            const r = stage.getBoundingClientRect();
            if (r.top < 0 || r.bottom > W.innerHeight) scrollTo(stage, { offset: -(top ? top.offsetHeight : 0) - 16 });
          });
        });
        map.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') on(null); });
        ScrollTrigger.create({ trigger: stage, start: 'top 82%', once: true, onEnter: () => map.classList.add('is-in') });
      });
    },

    forms(scope) {
      $$('form[data-form]', scope).forEach((form) => {
        if (form._wired) return;
        form._wired = true;
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
          const lbl = $('span', btn);
          const orig = lbl.textContent;
          btn.disabled = true;
          lbl.textContent = form.dataset.sending;
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
          lbl.textContent = orig;
        });
      });
    },

    copy(scope) {
      $$('[data-copy]', scope).forEach((b) => {
        const orig = b.textContent;
        b.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); } catch (err) { /* ignore */ }
          b.textContent = b.dataset.copied;
          setTimeout(() => { b.textContent = orig; }, 1600);
        });
      });
    },
  };

  let ctx = null;
  const main = $('#main');
  function initPage(scope) {
    if (ctx) ctx.revert();
    ctx = gsap.context(() => Object.values(modules).forEach((fn) => { try { fn(scope); } catch (err) { console.error(err); } }), scope);
    ScrollTrigger.refresh();
  }
  function intro(scope) {
    const hero = $('[data-hero]', scope);
    if (hero && hero._intro) hero._intro();
  }

  /* footer: forms and the mark */
  const foot = $('.foot');
  if (foot) {
    modules.forms(foot);
    const mark = $('[data-foot-mark] .logo', foot);
    if (mark && !RM) gsap.to(mark, { clipPath: 'inset(0% 0 0 0)', duration: 1.8, ease: EASE, scrollTrigger: { trigger: mark, start: 'top 95%', once: true } });
    const topBtn = $('[data-top-btn]', foot);
    if (topBtn) topBtn.addEventListener('click', () => scrollTo(0, { duration: 2.2 }));
  }

  /* ---------- page changes: the hourglass closes over the page and opens on the next ---------- */
  const curtain = $('[data-curtain]');
  const curtainPath = curtain && $('path', curtain);
  let moving = false;
  function curtainTo(s0, s1, ease) {
    const o = { s: s0 };
    curtain.classList.add('is-on');
    return gsap.to(o, { s: s1, duration: 1, ease, onUpdate: () => curtainPath.setAttribute('d', hourglass({ s: o.s, fit: 0.5 })) });
  }
  async function navigate(href, push) {
    if (moving) return;
    moving = true;
    if (menuOpen) setMenu(false);
    const fetching = fetch(href).then((r) => { if (!r.ok && r.status !== 404) throw new Error(r.status); return r.text(); });
    await curtainTo(0.0001, 3.4, 'power3.in');
    let html;
    try { html = await fetching; } catch (err) { location.href = href; return; }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const next = doc.querySelector('#main');
    if (!next) { location.href = href; return; }
    if (ctx) { ctx.revert(); ctx = null; }
    main.innerHTML = next.innerHTML;
    D.title = doc.title;
    const d1 = $('meta[name=description]');
    const d2 = doc.querySelector('meta[name=description]');
    if (d1 && d2) d1.setAttribute('content', d2.getAttribute('content'));
    if (push) history.pushState({ wave: true }, '', href);
    const pathname = new URL(href, location.href).pathname;
    const home = root.lang === 'ar' ? '/ar/' : '/';
    $$('.top__nav a, .top__link, .menu__nav a').forEach((a) => {
      const h = a.getAttribute('href');
      if (a.hasAttribute('data-full-nav')) return;
      (h === home ? pathname === home : pathname.startsWith(h)) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    const other = doc.querySelectorAll('[data-full-nav]');
    $$('[data-full-nav]').forEach((a, i) => { if (other[i]) a.setAttribute('href', other[i].getAttribute('href')); });
    scrollTo(0, { immediate: true });
    W.scrollTo(0, 0);
    top.classList.remove('is-away', 'is-solid', 'is-light');
    const img = $('img', main);
    if (img && !img.complete) await Promise.race([new Promise((r) => img.addEventListener('load', r, { once: true })), new Promise((r) => setTimeout(r, 1400))]);
    initPage(main);
    paintTop(0);
    await curtainTo(3.4, 0.0001, 'power3.inOut');
    curtain.classList.remove('is-on');
    intro(main);
    moving = false;
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
    if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.xml')) return;
    const toAr = url.pathname === '/ar' || url.pathname.startsWith('/ar/');
    if (toAr !== (root.lang === 'ar') || RM || STATIC || !curtain) return;
    e.preventDefault();
    navigate(url.href + (url.hash || ''), true);
  });
  W.addEventListener('popstate', () => { if (!RM && !STATIC) navigate(location.href, false); else location.reload(); });
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  /* ---------- go ---------- */
  const pre = $('[data-pre]');
  function preload() {
    let seen = true;
    try { seen = !!sessionStorage.getItem('wave-pre'); sessionStorage.setItem('wave-pre', '1'); } catch (e) { /* private mode */ }
    if (!pre || RM || seen) { if (pre) pre.remove(); return Promise.resolve(); }
    lock(true);
    root.classList.add('is-pre');
    const bg = $('[data-pre-bg]', pre);
    const logo = $('[data-pre-logo]', pre);
    const lines = $$('.pre__lines path', pre);
    const fill = $('.pre__fill', pre);
    const rule = $('[data-pre-rule]', pre);
    const ruleBox = $('.pre__rule', pre);
    const place = $('[data-pre-place]', pre);
    const brand = $('.top__brand .logo');
    // wait for the first photographs (at most a few seconds)
    const imgs = $$('img', main).slice(0, 2).filter((i) => !i.complete);
    const ready = Promise.race([
      Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    return new Promise((resolve) => {
      const drawn = new Promise((r) => {
        gsap.timeline({ onComplete: r })
          .to(lines, { strokeDashoffset: 0, duration: 1.6, stagger: 0.1, ease: 'power2.inOut' }, 0)
          .to(rule, { scaleX: 0.72, duration: 2, ease: 'power2.inOut' }, 0.2)
          .to(place, { clipPath: 'inset(0 0 0% 0)', duration: 1, ease: OUT }, 0.6)
          .to(fill, { clipPath: 'inset(0% 0 0 0)', duration: 1.1, ease: EASE }, 1.4);
      });
      Promise.all([drawn, ready]).then(() => {
        const out = gsap.timeline({ onComplete() { pre.remove(); root.classList.remove('is-pre'); lock(false); } });
        out.to(rule, { scaleX: 1, duration: 0.5, ease: 'power2.out' }, 0)
          .to([place, ruleBox], { clipPath: 'inset(0% 0% 100% 0%)', duration: 0.6, ease: 'power3.in' }, 0.35);
        const a = logo.getBoundingClientRect();
        const b = brand && brand.getBoundingClientRect();
        if (b && b.width) out.to(logo, { x: b.left - a.left, y: b.top - a.top, scale: b.width / a.width, duration: 1.4, ease: 'power3.inOut' }, 0.7);
        out.to(bg, { clipPath: 'inset(0% 0% 100% 0%)', duration: 1.1, ease: EASE }, 0.8)
          .add(resolve, 1.0);
      });
    });
  }

  D.fonts.ready.then(async () => {
    initPage(main);
    paintTop(W.scrollY);
    if (RM) { if (pre) pre.remove(); return; }
    await preload();
    intro(main);
    if (location.hash) { const t = $(location.hash); if (t) setTimeout(() => scrollTo(t), 600); }
  });
  W.addEventListener('load', () => ScrollTrigger.refresh());
})();
