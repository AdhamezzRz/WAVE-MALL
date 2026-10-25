'use strict';

// The area map: a drawing of the First Sector from OpenStreetMap (public/img/area-map.svg,
// built by scripts/build-map.py) with street names, numbered places and The Wave on top.
// Everything sits in one SVG so it scales together; marks keep their size on screen via --k.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DATA = require('./map-data.json');

const BASE = path.join(__dirname, '..', 'public', 'img', 'area-map.svg');
const BASE_V = crypto.createHash('sha1').update(fs.readFileSync(BASE)).digest('hex').slice(0, 8);

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const T = {
  en: {
    label: 'Map of the First Sector, New Cairo, showing The Wave between North 90 and South 90 streets and the malls and landmarks around it.',
    kinds: { mall: 'Malls & shopping', landmark: 'Landmarks', transit: 'Getting here' },
    km: 'km',
    drag: 'Drag to explore',
    credit: 'Map data © OpenStreetMap contributors',
    here: 'The Wave',
  },
  ar: {
    label: 'خريطة القطاع الأول بالقاهرة الجديدة تُظهر ذا ويف بين شارعي التسعين الشمالي والجنوبي والمولات والمعالم حوله.',
    kinds: { mall: 'المولات والتسوق', landmark: 'معالم', transit: 'الوصول' },
    km: 'كم',
    drag: 'اسحب للاستكشاف',
    credit: 'بيانات الخريطة © مساهمو OpenStreetMap',
    here: 'ذا ويف',
  },
};
const KINDS = ['mall', 'landmark', 'transit'];
// The five malls on the Banks Road block sit a few metres apart: their numbers stand off on short
// leaders (screen px) so each stays readable; the dot marks the true position.
const LEAD = { 'Monaliza Mall': [0, 28], 'Silver Star Mall': [0, -28], 'Town Center Mall': [0, -56], 'Katameya Plaza': [0, 28], 'Hanimex Mall': [0, -28] };

function areaMap(lang, { list = true } = {}) {
  const t = T[lang];
  const fmt = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const n = (i) => (lang === 'ar' ? (i + 1).toLocaleString('ar-EG') : String(i + 1));
  const { w, h, wave } = DATA;

  const streets = DATA.streets
    .map((s) => `<g transform="translate(${s.x} ${s.y}) rotate(${s.rot})"><text class="amap__street amap__street--${s.weight}" text-anchor="middle" dy=".35em">${esc(s[lang])}</text></g>`)
    .join('');
  const pins = DATA.places
    .map((p, i) => {
      const [dx, dy] = LEAD[p.en] || [0, 0];
      const lead = dx || dy ? `<circle class="amap__dot" r="2.6"/><line class="amap__lead" x2="${dx}" y2="${dy}"/>` : '';
      const left = p.x > w * 0.72 ? ' data-left' : '';
      return `<g transform="translate(${p.x} ${p.y})" class="amap__pin amap__pin--${p.kind}" data-place="${i}" data-x="${p.x}"${left}><g class="amap__mark" style="--d:${(0.25 + i * 0.06).toFixed(2)}s">${lead}<g transform="translate(${dx} ${dy})"><g class="amap__head"><circle r="10"/><text dy=".36em" text-anchor="middle">${n(i)}</text></g><g class="amap__tip"><rect x="15" y="-13" width="10" height="26" rx="2"/><text x="25" dy=".36em">${esc(p[lang])}</text></g></g></g></g>`;
    })
    .join('');
  const here = `<g transform="translate(${wave.x} ${wave.y})" class="amap__here"><g class="amap__mark"><circle class="amap__ring" r="34"/><circle class="amap__ring amap__ring--2" r="34"/><circle r="9"/><g class="amap__flag"><rect x="18" y="-15" width="${lang === 'ar' ? 66 : 92}" height="30" rx="2"/><text x="${lang === 'ar' ? 51 : 64}" dy=".36em" text-anchor="middle">${esc(t.here)}</text></g></g></g>`;

  const groups = KINDS.map((kind) => {
    const items = DATA.places
      .map((p, i) => [p, i])
      .filter(([p]) => p.kind === kind)
      .map(([p, i]) => `<li><button type="button" class="amap__item--${p.kind}" data-place="${i}"><b>${n(i)}</b><span>${esc(p[lang])}</span><i>${fmt.format(p.km)} ${t.km}</i></button></li>`)
      .join('');
    return `<div class="amap__group"><p class="label">${esc(t.kinds[kind])}</p><ol>${items}</ol></div>`;
  }).join('');

  return `
<figure class="amap" data-amap data-wx="${(wave.x / w).toFixed(4)}" style="--ar:${w} / ${h}">
  <div class="amap__stage" data-amap-stage>
    <svg class="amap__svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t.label)}">
      <image href="/img/area-map.svg?v=${BASE_V}" width="${w}" height="${h}" preserveAspectRatio="none"/>
      <g class="amap__streets">${streets}</g>
      <g class="amap__pins">${pins}</g>
      ${here}
    </svg>
  </div>
  <p class="label amap__drag" aria-hidden="true">${esc(t.drag)}</p>
  ${list ? `<figcaption class="amap__legend">${groups}</figcaption>` : ''}
  <p class="amap__credit">${esc(t.credit)}</p>
</figure>`;
}

module.exports = { areaMap };
