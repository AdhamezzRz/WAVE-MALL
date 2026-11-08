/* Import from Excel (routes/import.js): the drop zone that uploads a workbook, and the busy state
   of the Import button. The file is sent as it is (no form encoding); the page then moves to the
   preview the server prepared. */
(() => {
  'use strict';
  const csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';

  const box = document.querySelector('[data-imp-upload]');
  if (box) {
    const zone = box.querySelector('[data-imp-zone]');
    const input = box.querySelector('[data-imp-file]');
    const busy = box.querySelector('[data-imp-busy]');
    const err = box.querySelector('[data-imp-err]');
    const max = Number(box.dataset.max) || 10485760;
    const ar = document.documentElement.lang === 'ar';
    const say = (text) => {
      err.textContent = text;
      err.hidden = !text;
    };
    const send = async (file) => {
      if (!file) return;
      say('');
      if (!/\.(xlsx|csv|xls)$/i.test(file.name)) {
        say(ar ? 'اختر ملف إكسل (xlsx) أو ملف CSV.' : 'Choose an Excel workbook (.xlsx) or a CSV file.');
        return;
      }
      if (file.size > max) {
        say(ar ? 'الملف أكبر من ١٠ ميجابايت. قسّمه إلى ملفات أصغر.' : 'The file is larger than 10 MB. Split it into smaller files.');
        return;
      }
      zone.hidden = true;
      busy.hidden = false;
      busy.querySelector('[data-imp-name]').textContent = file.name;
      try {
        const res = await fetch(box.dataset.impUpload, {
          method: 'POST',
          headers: { 'x-csrf': csrf, 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream', accept: 'application/json' },
          body: file,
          credentials: 'same-origin',
        });
        const out = await res.json().catch(() => ({ ok: false }));
        if (out.ok && out.url) {
          location.assign(out.url);
          return;
        }
        say(out.error || (ar ? 'تعذر رفع الملف. حاول مرة أخرى.' : 'The file could not be uploaded. Try again.'));
      } catch {
        say(ar ? 'انقطع الاتصال. حاول مرة أخرى.' : 'The connection dropped. Try again.');
      }
      zone.hidden = false;
      busy.hidden = true;
      input.value = '';
    };
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => send(input.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
    }));
    zone.addEventListener('drop', (e) => send(e.dataTransfer && e.dataTransfer.files[0]));
  }

  // the Import button: once pressed, it says it is working and cannot be pressed twice
  document.querySelectorAll('[data-imp-commit]').forEach((btn) => {
    btn.form.addEventListener('submit', () => {
      btn.disabled = true;
      const label = btn.querySelector('span');
      if (label && btn.dataset.busy) label.textContent = btn.dataset.busy;
      btn.classList.add('is-busy');
    });
  });
})();
