// Users & permissions (routes/people.js): the permission matrix and the access pages.
//   [data-ppl-set]      a group header button: set every module of that group to one level
//   [data-ppl-changes]  how many cells differ from what is saved (radios: data-orig="1" on the saved one;
//                       selects: data-orig holds the saved value)
//   [data-ppl-filter]   type to show only the modules whose name matches
//   [data-until]        "until …" countdowns for temporary access
(function () {
  'use strict';
  var forms = document.querySelectorAll('[data-ppl-form]');

  function changes(form) {
    var n = 0;
    var seen = {};
    form.querySelectorAll('input[type=radio][name^="m:"]').forEach(function (r) {
      if (seen[r.name]) return;
      seen[r.name] = true;
      var checked = form.querySelector('input[type=radio][name="' + CSS.escape(r.name) + '"]:checked');
      if (checked && checked.getAttribute('data-orig') !== '1') n++;
    });
    form.querySelectorAll('select.ppl-sel').forEach(function (s) {
      if ((s.value || '') !== (s.getAttribute('data-orig') || '')) n++;
    });
    form.querySelectorAll('tr').forEach(function (tr) {
      var changed = false;
      tr.querySelectorAll('input[type=radio]:checked').forEach(function (r) { if (r.getAttribute('data-orig') !== '1') changed = true; });
      tr.querySelectorAll('select.ppl-sel').forEach(function (s) { if ((s.value || '') !== (s.getAttribute('data-orig') || '')) changed = true; });
      tr.classList.toggle('is-changed', changed);
    });
    var out = document.querySelector('[data-ppl-changes]');
    if (out) {
      out.textContent = n === 0 ? '' : n === 1 ? out.getAttribute('data-one') : String(out.getAttribute('data-many')).replace('{n}', n);
      out.classList.toggle('is-on', n > 0);
    }
  }

  forms.forEach(function (form) {
    form.addEventListener('change', function () { changes(form); });
    form.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ppl-set]');
      if (!b) return;
      e.preventDefault();
      var level = b.getAttribute('data-ppl-set');
      var group = b.closest('tbody');
      if (!group) return;
      group.querySelectorAll('input[type=radio][value="' + level + '"]').forEach(function (r) {
        if (!r.disabled && r.closest('tr').style.display !== 'none') r.checked = true;
      });
      changes(form);
    });
    changes(form);
  });

  var find = document.querySelector('[data-ppl-filter]');
  if (find) {
    find.addEventListener('input', function () {
      var q = find.value.trim().toLowerCase();
      document.querySelectorAll('[data-ppl-row]').forEach(function (tr) {
        tr.style.display = !q || tr.getAttribute('data-ppl-row').indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }

  // temporary access: "2 d 5 h left"
  var ar = document.documentElement.lang === 'ar';
  function left(ms) {
    if (ms <= 0) return ar ? 'انتهى' : 'ended';
    var d = Math.floor(ms / 86400000);
    var h = Math.floor((ms % 86400000) / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    if (ar) return 'متبقٍ ' + (d ? d + ' ي ' : '') + (d || h ? h + ' س' : m + ' د');
    return (d ? d + ' d ' : '') + (d || h ? h + ' h' : m + ' min') + ' left';
  }
  function tick() {
    document.querySelectorAll('[data-until]').forEach(function (el) {
      var t = Date.parse(el.getAttribute('data-until'));
      if (!isNaN(t)) el.setAttribute('data-left', left(t - Date.now()));
    });
  }
  tick();
  setInterval(tick, 30000);
})();
