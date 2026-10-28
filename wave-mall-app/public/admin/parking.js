// Parking screens: the booth and the shops' validation page find a car by scanning a ticket's QR
// code with the camera (BarcodeDetector), tapping an NFC card (Web NFC, Chrome on Android), or by a
// USB/Bluetooth barcode or card reader, which types into the box like a keyboard and presses Enter.
// Live pages reload themselves while nobody is typing.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- live pages ----------
  const live = $('[data-autoreload]');
  if (live) {
    const every = Math.max(15, Number(live.dataset.autoreload) || 30) * 1000;
    setInterval(() => {
      const busy = document.activeElement && document.activeElement !== document.body && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement.tagName);
      if (document.visibilityState === 'visible' && !busy && !$('details[open]') && !$('[data-scan-video]:not([hidden])')) location.reload();
    }, every);
  }

  // ---------- the live floor plan ----------
  const floor = $('[data-floor]');
  if (floor) {
    const base = floor.dataset.floorBase;
    floor.addEventListener('click', (e) => {
      const g = e.target.closest('[data-bay]');
      if (g) location.href = `${base}&bay=${encodeURIComponent(g.dataset.bay)}`;
    });
    floor.addEventListener('keydown', (e) => {
      const g = e.target.closest('[data-bay]');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); location.href = `${base}&bay=${encodeURIComponent(g.dataset.bay)}`; }
    });
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch(floor.dataset.floor, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
        if (!r.ok) return;
        const d = await r.json();
        if (!d.ok) return;
        for (const [code, state, est, viol, tip] of d.bays) {
          const g = floor.querySelector(`[data-bay="${code}"]`);
          if (!g) continue;
          g.classList.remove('s-free', 's-taken', 's-held', 's-off');
          g.classList.add(`s-${state}`);
          g.classList.toggle('is-est', !!est);
          g.classList.toggle('has-violation', !!viol);
          g.setAttribute('aria-label', tip);
          const t = g.querySelector('title');
          if (t) t.textContent = tip;
          // a car appears or leaves
          const car = g.querySelector('.pkf-car');
          if (state === 'taken' && !car) {
            const box = g.querySelector('rect');
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            c.setAttribute('class', 'pkf-car');
            c.setAttribute('x', Number(box.getAttribute('x')) + 3);
            c.setAttribute('y', Number(box.getAttribute('y')) + 6);
            c.setAttribute('width', Number(box.getAttribute('width')) - 6);
            c.setAttribute('height', Number(box.getAttribute('height')) - 13);
            c.setAttribute('rx', 4);
            box.after(c);
          } else if (state !== 'taken' && car) car.remove();
        }
        for (const [k, v] of Object.entries(d.counts || {})) {
          const el = $(`[data-count="${k}"]`);
          if (el) el.textContent = Number(v).toLocaleString('en-US');
        }
      } catch { /* next time */ }
    };
    setInterval(refresh, 15000);
  }

  // ---------- counting a drawer by note ----------
  const dens = $('[data-dens]');
  if (dens) {
    const total = $('[data-den-total]');
    dens.addEventListener('input', () => {
      const sum = $$('[data-den]', dens).reduce((t, el) => t + Number(el.dataset.den) * (Number(el.value) || 0), 0);
      if (total) total.value = sum ? (Math.round(sum * 100) / 100).toString() : '';
    });
  }

  // what kind of thing was read: a ticket (URL or ABCD-2345), a card number, or a plate
  const kindOf = (v) => (/\/parking\/t\/|^[2-9A-HJ-NP-Z]{4}-?[2-9A-HJ-NP-Z]{4}$/i.test(v) ? 'qr' : /^[0-9A-F:\s-]{8,32}$/i.test(v) && /\d/.test(v) ? 'nfc' : 'plate');

  for (const form of $$('[data-scan]')) {
    const input = $('[data-scan-input]', form);
    const via = $('[data-scan-via]', form);
    const msg = $('[data-scan-msg]', form);
    const say = (t) => { if (!msg) return; msg.textContent = t || ''; msg.hidden = !t; };
    const T = {
      cam: form.dataset.msgCam || 'Point the camera at the ticket’s QR code.',
      nfc: form.dataset.msgNfc || 'Hold the card against the back of the phone.',
      err: form.dataset.msgErr || 'This device could not start the reader.',
    };
    const go = (value, how) => {
      input.value = value;
      if (via) via.value = how;
      form.requestSubmit ? form.requestSubmit() : form.submit();
    };
    form.addEventListener('submit', () => { if (via && via.value === 'code') via.value = kindOf(input.value.trim()) === 'qr' ? 'code' : kindOf(input.value.trim()); });

    // the camera
    const camBtn = $('[data-scan-camera]', form);
    const box = $('[data-scan-video]', form);
    let stream = null;
    let timer = null;
    const stop = () => {
      clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (box) box.hidden = true;
      say('');
    };
    if (camBtn && box && 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      camBtn.hidden = false;
      camBtn.addEventListener('click', async () => {
        try {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
          const video = $('video', box);
          video.srcObject = stream;
          box.hidden = false;
          await video.play();
          say(T.cam);
          timer = setInterval(async () => {
            try {
              const found = await detector.detect(video);
              if (found.length && found[0].rawValue) {
                const v = found[0].rawValue;
                stop();
                if (navigator.vibrate) navigator.vibrate(60);
                go(v, 'qr');
              }
            } catch { /* the next frame */ }
          }, 250);
        } catch {
          stop();
          say(T.err);
        }
      });
      const stopBtn = $('[data-scan-stop]', box);
      if (stopBtn) stopBtn.addEventListener('click', stop);
    }

    // NFC (Chrome on Android): the card's serial number
    const nfcBtn = $('[data-scan-nfc]', form);
    if (nfcBtn && 'NDEFReader' in window) {
      nfcBtn.hidden = false;
      nfcBtn.addEventListener('click', async () => {
        try {
          const reader = new window.NDEFReader();
          const ctl = new AbortController();
          await reader.scan({ signal: ctl.signal });
          say(T.nfc);
          reader.onreading = (e) => {
            ctl.abort();
            if (navigator.vibrate) navigator.vibrate(60);
            go(String(e.serialNumber || '').toUpperCase(), 'nfc');
          };
        } catch {
          say(T.err);
        }
      });
    }
  }

  // a card number field (subscriptions): read it from a tapped card
  if ('NDEFReader' in window) {
    for (const field of $$('[data-nfc-field]')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--ghost btn--xs pk-nfcread';
      b.textContent = 'NFC';
      field.after(b);
      b.addEventListener('click', async () => {
        try {
          const reader = new window.NDEFReader();
          const ctl = new AbortController();
          await reader.scan({ signal: ctl.signal });
          reader.onreading = (e) => { field.value = String(e.serialNumber || '').toUpperCase(); ctl.abort(); };
        } catch { /* not allowed */ }
      });
    }
  }
})();
