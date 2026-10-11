/* 3D location scene — built from real OpenStreetMap offsets around the pin (30.0194714, 31.4319505).
   1 unit = 10 m. x = east, z = south. Road alignments and the building massing are schematic. */
(function () {
  'use strict';
  const U = 100; // units per km
  const C = { health: 0x3ecf9e, school: 0xe08a6c, retail: 0xd9a441, living: 0x8f9bea, transit: 0x7ff0c5, pin: 0xffd27a };
  const CSS = { health: '#3ecf9e', school: '#e08a6c', retail: '#d9a441', living: '#8f9bea', transit: '#7ff0c5', pin: '#ffd27a' };

  // [key, cat, dx km (east), dy km (north), EN, AR, important, noteEN, noteAR]
  const RAW = [
    ['afh', 'health', 0.25, -0.22, 'Air Force Specialized Hospital', 'مستشفى القوات الجوية التخصصي', 1, 'Military hospital on South Teseen. Patient access may be restricted; confirm before building a visitor story.', 'مستشفى عسكري على التسعين الجنوبي. قد يكون الدخول مقيّدًا، يُراجع قبل بناء أي رسالة موجهة للزوار.'],
    ['salam', 'health', -0.37, -1.31, 'Al Salam International Hospital', 'مستشفى السلام الدولي', 1, 'Private hospital, about 1.4 km away.', 'مستشفى خاص على بُعد 1.4 كم تقريبًا.'],
    ['tabarak', 'health', -1.33, -0.52, 'Tabarak Hospital', 'مستشفى تبارك', 0, 'Private hospital, about 1.4 km away.', 'مستشفى خاص على بُعد 1.4 كم تقريبًا.'],
    ['deutsche', 'school', 0.12, -0.85, 'Private Deutsche Schule', 'المدرسة الألمانية الخاصة', 1, 'International school, about 0.9 km away.', 'مدرسة دولية على بُعد 0.9 كم.'],
    ['balzac', 'school', -0.84, 0.36, 'Lycée Balzac', 'ليسيه بلزاك', 0, 'French-curriculum school, about 0.9 km away.', 'مدرسة بمنهج فرنسي على بُعد 0.9 كم.'],
    ['mes', 'school', -0.80, 0.53, 'Modern English School', 'مدرسة مودرن إنجلش', 1, 'International school, about 1 km away.', 'مدرسة دولية على بُعد 1 كم.'],
    ['german', 'school', -0.85, 0.73, 'German School', 'المدرسة الألمانية', 0, 'International school, about 1.1 km away.', 'مدرسة دولية على بُعد 1.1 كم.'],
    ['hayah', 'school', -0.24, 1.29, 'Hayah International Academy', 'أكاديمية حياة الدولية', 0, 'International school, about 1.3 km away.', 'مدرسة دولية على بُعد 1.3 كم.'],
    ['british', 'school', -0.83, -1.49, 'British School', 'المدرسة البريطانية', 0, 'International school, about 1.7 km away.', 'مدرسة دولية على بُعد 1.7 كم.'],
    ['akhn', 'school', -1.6, -1.49, 'Akhnaton Language School', 'مدارس إخناتون للغات', 0, 'Language school, about 2.2 km away.', 'مدرسة لغات على بُعد 2.2 كم.'],
    ['kid', 'school', -0.65, -0.69, 'Kidtopia Nursery', 'حضانة كيدتوبيا', 0, 'Nursery, about 0.95 km away.', 'حضانة على بُعد 0.95 كم.'],
    ['hearts', 'school', -0.83, -0.48, 'Little Hearts Nursery', 'حضانة ليتل هارتس', 0, 'Nursery, about 0.95 km away.', 'حضانة على بُعد 0.95 كم.'],
    ['cfc', 'retail', -2.34, 0.96, 'Cairo Festival City Mall', 'كايرو فستيفال سيتي مول', 1, '160,000 m² GLA · IKEA, Carrefour, 20-screen cinema · 22M visits a year (operator figure).', '160,000 م² مساحة تأجيرية · إيكيا وكارفور وسينما 20 شاشة · 22 مليون زيارة سنويًا (رقم المشغّل).'],
    ['dk', 'retail', -1.88, -0.24, 'Downtown Katameya', 'داون تاون القطامية', 1, 'Outdoor street · about 34,000 m² retail · home, jewellery and luxury fashion.', 'شارع مفتوح · نحو 34,000 م² تجزئة · أثاث ومجوهرات وأزياء فاخرة.'],
    ['gout', 'retail', -1.38, -0.60, 'G.OUT Mall', 'جي أوت مول', 1, 'Small neighbourhood mall; GLA and tenants not found.', 'مول صغير بالحي؛ لم نجد مساحته أو مستأجريه.'],
    ['lake', 'living', 0.91, 0.45, 'Lakeview compound', 'كمبوند ليك فيو', 1, 'Villa and apartment compound, about 1 km away. Identity and size unconfirmed.', 'كمبوند فيلات وشقق على بُعد 1 كم. الاسم والحجم غير مؤكدين.'],
    ['dusit', 'living', 2.17, 0.73, 'Dusit Thani LakeView', 'دوسيت تاني ليك فيو', 1, 'Hotel on South Teseen, about 2.3 km away.', 'فندق على التسعين الجنوبي، على بُعد 2.3 كم.'],
    ['mono', 'transit', 0.19, -0.35, 'Monorail · Air Force Hospital stn', 'المونوريل · محطة مستشفى القوات الجوية', 1, 'East Nile Monorail, public since 6 May 2026. About 400 m from the pin. Early ridership is low.', 'مونوريل شرق النيل، يعمل للجمهور منذ 6 مايو 2026. على بُعد 400 م. الإقبال حاليًا محدود.']
  ];
  const POIS = RAW.map(r => ({ k: r[0], cat: r[1], x: r[2] * U, z: -r[3] * U, dx: r[2], dy: r[3], en: r[4], ar: r[5], imp: !!r[6], nen: r[7], nar: r[8], d: Math.hypot(r[2], r[3]) }));
  const GLA = { cfc: 160000, dk: 34000 };

  const S = { pois: POIS, lang: 'en', ready: false, labels: 'none', cats: { health: 1, school: 1, retail: 1, living: 1, transit: 1 } };
  let renderer, scene, camera, clock, canvas, pinsEl;
  const groups = {}; const pins = {};
  let cam = { p: new THREE.Vector3(150, 70, 210), t: new THREE.Vector3(0, 6, 0), orbit: 0.05 };
  let camTarget = { p: new THREE.Vector3(150, 70, 210), t: new THREE.Vector3(0, 6, 0), orbit: 0.05 };
  let ang = 0, mouse = { x: 0, y: 0 }, traffic = [], rings = [], roofLine, roofBase, radar, train, trainCurve, arcs = {}, dust, beam, pulses = [];
  let radarOn = false, focusPoint = null;

  const presets = {
    cover: { p: [95, 46, 150], t: [-34, 10, 0], orbit: 0.05 },
    film: { p: [90, 40, 130], t: [0, 8, 0], orbit: 0.05 },
    pin: { p: [70, 36, 95], t: [0, 8, 0], orbit: 0.09 },
    iso: { p: [330, 250, 360], t: [-20, 0, 0], orbit: 0.025 },
    explore: { p: [250, 195, 280], t: [-25, 0, 5], orbit: 0.012 },
    top: { p: [0, 700, 2], t: [0, 0, 0], orbit: 0 },
    close: { p: [55, 22, 75], t: [0, 10, 0], orbit: 0.1 },
    west: { p: [-60, 150, 190], t: [-190, 0, -20], orbit: 0.01 },
    mono: { p: [-30, 55, 150], t: [19, 6, 35], orbit: 0.02 },
    far: { p: [520, 420, 560], t: [-60, 0, 0], orbit: 0.03 },
    low: { p: [200, 30, 60], t: [0, 8, 0], orbit: 0.05 }
  };
  S.presets = presets;

  function toV(a) { return new THREE.Vector3(a[0], a[1], a[2]); }
  S.setPreset = function (name, opts) {
    const p = presets[name] || presets.iso; camTarget.p.copy(toV(p.p)); camTarget.t.copy(toV(p.t)); camTarget.orbit = p.orbit || 0;
    if (opts && opts.snap) { cam.p.copy(camTarget.p); cam.t.copy(camTarget.t); }
    focusPoint = null; ang = 0;
  };
  S.focusCat = function (cat) {
    const pts = POIS.filter(p => p.cat === cat); if (!pts.length) return;
    let cx = 0, cz = 0; pts.forEach(p => { cx += p.x; cz += p.z; }); cx /= pts.length; cz /= pts.length;
    let r = 60; pts.forEach(p => { r = Math.max(r, Math.hypot(p.x - cx, p.z - cz)); });
    camTarget.t.set(cx * .6, 0, cz * .6); camTarget.p.set(cx * .6 + r * .9, r * 1.25 + 60, cz * .6 + r * 1.35 + 40); camTarget.orbit = 0.01;
  };
  S.focusPOI = function (k) {
    const p = POIS.find(q => q.k === k); if (!p) return;
    camTarget.t.set(p.x * .7, 0, p.z * .7); camTarget.p.set(p.x * .7 + 60, 70, p.z * .7 + 90); camTarget.orbit = 0.02;
  };
  S.setDim = function (v) { if (canvas) canvas.style.opacity = v; };
  S.setBlur = function (v) { if (canvas) canvas.style.filter = v ? 'blur(' + v + 'px)' : 'none'; };
  S.nudge = function (dx, dy) { ang += dx * 0.004; camTarget.p.y = Math.max(25, Math.min(900, camTarget.p.y + dy * 1.4)); };
  S.zoom = function (f) { const rel = camTarget.p.clone().sub(camTarget.t).multiplyScalar(f); const l = rel.length(); if (l < 40 || l > 1100) return; camTarget.p.copy(camTarget.t).add(rel); };
  S.setLayers = function (list) { Object.keys(S.cats).forEach(c => { S.cats[c] = list.indexOf(c) >= 0 ? 1 : 0; if (groups[c]) groups[c].visible = !!S.cats[c]; }); refreshPins(); };
  S.setLabels = function (m) { S.labels = m; refreshPins(); };
  S.setRadar = function (v) { radarOn = v; };
  S.setLang = function (l) { S.lang = l; Object.keys(pins).forEach(k => { const p = pins[k]; p.w = 0; p.el.querySelector('b').textContent = p.poi[l] || p.poi.en; if (p.poi.d) p.el.querySelector('em').textContent = p.poi.d.toFixed(2) + (l === 'ar' ? ' كم' : ' km'); }); };
  S.highlight = function (k) { Object.keys(pins).forEach(q => pins[q].el.classList.toggle('hot', q === k)); };
  S.onPin = function () { };
  S.onPinOver = function () { };

  function circle(r, seg) { const pts = []; for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); } return new THREE.BufferGeometry().setFromPoints(pts); }

  function init(c, pinsContainer) {
    canvas = c; pinsEl = pinsContainer;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x070908, 1);
    scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x070908, 0.0011);
    camera = new THREE.PerspectiveCamera(46, 1, 1, 6000);
    clock = new THREE.Clock();

    scene.add(new THREE.AmbientLight(0x88b8a4, 1.15));
    const sun = new THREE.DirectionalLight(0xffd9a0, 1.15); sun.position.set(-300, 260, 180); scene.add(sun);
    const rim = new THREE.DirectionalLight(0x3ecf9e, 0.55); rim.position.set(260, 120, -220); scene.add(rim);

    // ground + grid + glow
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshBasicMaterial({ color: 0x0a0f0d })); ground.rotation.x = -Math.PI / 2; scene.add(ground);
    const grid = new THREE.GridHelper(3600, 180, 0x1d2d26, 0x121c17); grid.position.y = 0.06; grid.material.transparent = true; grid.material.opacity = 0.55; scene.add(grid);
    const gc = document.createElement('canvas'); gc.width = gc.height = 256; const g = gc.getContext('2d'); const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0, 'rgba(0,160,120,.55)'); gr.addColorStop(.45, 'rgba(0,130,97,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(760, 760), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.12; scene.add(glow);

    // roads (schematic alignments)
    const roads = [
      { pts: [[-520, -23], [520, -23]], w: 4.2, c: 0x26362f, name: 'north' },
      { pts: [[-520, 20], [520, 20]], w: 3, c: 0x161d1a },
      { pts: [[-520, 35], [520, 35]], w: 5, c: 0x26362f, name: 'south' },
      { pts: [[16, -520], [16, 520]], w: 5, c: 0x26362f, name: 'ave' },
      { pts: [[-70, -520], [-70, 520]], w: 2.6, c: 0x141a17 }, { pts: [[-160, -520], [-160, 520]], w: 2.6, c: 0x141a17 },
      { pts: [[110, -520], [110, 520]], w: 2.6, c: 0x141a17 }, { pts: [[240, -520], [240, 520]], w: 2.6, c: 0x141a17 },
      { pts: [[-520, -110], [520, -110]], w: 2.6, c: 0x141a17 }, { pts: [[-520, 120], [520, 120]], w: 2.6, c: 0x141a17 }
    ];
    roads.forEach(r => {
      const [a, b] = r.pts; const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, r.w), new THREE.MeshBasicMaterial({ color: r.c })); m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      m.position.set((a[0] + b[0]) / 2, 0.1, (a[1] + b[1]) / 2); scene.add(m);
      if (r.name) {
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], .2, a[1]), new THREE.Vector3(b[0], .2, b[1])]), new THREE.LineDashedMaterial({ color: 0x3a5a4d, dashSize: 3, gapSize: 3 })); l.computeLineDistances(); scene.add(l);
        for (let i = 0; i < 26; i++) traffic.push({ a, b, t: Math.random(), s: (0.012 + Math.random() * .03) * (Math.random() < .5 ? 1 : -1), off: (Math.random() < .5 ? -1 : 1) * r.w * .25 });
      }
    });
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(traffic.length * 3), 3));
    S._traffic = new THREE.Points(tg, new THREE.PointsMaterial({ color: 0xffc766, size: 2.4, transparent: true, opacity: .95, depthWrite: false, blending: THREE.AdditiveBlending })); scene.add(S._traffic);

    // the building (approximate H massing from the satellite shot)
    const sh = new THREE.Shape(); [[-9.25, -8.25], [-3.25, -8.25], [-3.25, -2.25], [3.25, -2.25], [3.25, -8.25], [9.25, -8.25], [9.25, 8.25], [3.25, 8.25], [3.25, 2.25], [-3.25, 2.25], [-3.25, 8.25], [-9.25, 8.25]].forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
    const bg = new THREE.ExtrudeGeometry(sh, { depth: 3.4, bevelEnabled: false });
    const bm = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x1f3a31, emissive: 0x0a8f68, emissiveIntensity: .95, metalness: .5, roughness: .3 })); bm.rotation.x = -Math.PI / 2; scene.add(bm);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(bg), new THREE.LineBasicMaterial({ color: 0x9ff7d8 })); edges.rotation.x = -Math.PI / 2; scene.add(edges);
    // floor bands
    for (let i = 1; i < 4; i++) { const f = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.ExtrudeGeometry(sh, { depth: .02 })), new THREE.LineBasicMaterial({ color: 0x1f7a5c, transparent: true, opacity: .55 })); f.rotation.x = -Math.PI / 2; f.position.y = i * .85; scene.add(f); }
    // roof wave line (the "Wave")
    const rp = []; for (let i = 0; i <= 120; i++) rp.push(new THREE.Vector3(0, 0, 0));
    roofLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rp), new THREE.LineBasicMaterial({ color: 0xd9a441 })); scene.add(roofLine);
    // base glow (additive billboard)
    const sprT = new THREE.CanvasTexture(gc); const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprT, color: 0xffd27a, transparent: true, opacity: .55, blending: THREE.AdditiveBlending, depthWrite: false })); spr.scale.set(70, 70, 1); spr.position.set(0, 4, 0); scene.add(spr);
    // beacon
    beam = new THREE.Mesh(new THREE.CylinderGeometry(.35, .35, 160, 12, 1, true), new THREE.MeshBasicMaterial({ color: C.pin, transparent: true, opacity: .32, blending: THREE.AdditiveBlending, depthWrite: false })); beam.position.y = 80; scene.add(beam);
    for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.RingGeometry(1, 1.3, 64), new THREE.MeshBasicMaterial({ color: C.pin, transparent: true, opacity: .6, side: THREE.DoubleSide, depthWrite: false })); r.rotation.x = -Math.PI / 2; r.position.y = .3; scene.add(r); pulses.push({ m: r, o: i / 3 }); }

    // distance rings + radar
    [100, 200, 300].forEach((r, i) => { const l = new THREE.LineLoop(circle(r, 160), new THREE.LineBasicMaterial({ color: 0x3ecf9e, transparent: true, opacity: .32 - i * .06 })); l.position.y = .25; scene.add(l); rings.push(l); });
    radar = new THREE.Mesh(new THREE.RingGeometry(2, 300, 64, 1, 0, 0.55), new THREE.MeshBasicMaterial({ color: 0x3ecf9e, transparent: true, opacity: .0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })); radar.rotation.x = -Math.PI / 2; radar.position.y = .35; scene.add(radar);

    // monorail guideway + train
    const mp = [[-520, 39], [-117, 36], [19, 35], [153, 16], [520, -14]].map(a => new THREE.Vector3(a[0], 6, a[1]));
    trainCurve = new THREE.CatmullRomCurve3(mp, false, 'catmullrom', .3);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(trainCurve, 220, .42, 8, false), new THREE.MeshStandardMaterial({ color: 0xb8fff0, emissive: 0x3ecf9e, emissiveIntensity: .8, metalness: .2, roughness: .4 }));
    const mg = new THREE.Group(); mg.add(tube);
    for (let i = 0; i <= 26; i++) { const pt = trainCurve.getPoint(i / 26); const py = new THREE.Mesh(new THREE.CylinderGeometry(.25, .35, 6, 6), new THREE.MeshBasicMaterial({ color: 0x1d3a30 })); py.position.set(pt.x, 3, pt.z); mg.add(py); }
    groups.transit = mg; scene.add(mg);
    train = new THREE.Group(); for (let i = 0; i < 4; i++) { const car = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.5, 1.7), new THREE.MeshBasicMaterial({ color: 0xffffff })); car.position.x = -i * 5.6; train.add(car); } scene.add(train);
    const st = new THREE.Mesh(new THREE.BoxGeometry(14, .5, 3.4), new THREE.MeshBasicMaterial({ color: 0x7ff0c5 })); st.position.set(19, 5.4, 35); mg.add(st);

    // POI markers
    ['health', 'school', 'retail', 'living'].forEach(c => { groups[c] = new THREE.Group(); scene.add(groups[c]); });
    POIS.forEach(p => {
      if (p.cat === 'transit') return;
      const g2 = groups[p.cat]; const gla = GLA[p.k];
      if (gla) { const s = Math.sqrt(gla) / 24; const b = new THREE.Mesh(new THREE.BoxGeometry(s, 2.2, s), new THREE.MeshStandardMaterial({ color: 0x3a2f14, emissive: C.retail, emissiveIntensity: .35, metalness: .3, roughness: .5 })); b.position.set(p.x, 1.1, p.z); g2.add(b); const e = new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry), new THREE.LineBasicMaterial({ color: C.retail })); e.position.copy(b.position); g2.add(e); }
      else { const h = p.cat === 'health' ? 5 : p.cat === 'school' ? 3 : 4; const m = new THREE.Mesh(new THREE.BoxGeometry(3.2, h, 3.2), new THREE.MeshStandardMaterial({ color: 0x1a1f1d, emissive: C[p.cat], emissiveIntensity: .45, metalness: .3, roughness: .5 })); m.position.set(p.x, h / 2, p.z); g2.add(m); const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: C[p.cat] })); e.position.copy(m.position); g2.add(e); }
      const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, 0, p.z), new THREE.Vector3(p.x, 22, p.z)]), new THREE.LineBasicMaterial({ color: C[p.cat], transparent: true, opacity: .55 })); g2.add(pole);
      // arc to pin
      const mid = new THREE.Vector3(p.x / 2, 26 + p.d * 14, p.z / 2); const cv = new THREE.QuadraticBezierCurve3(new THREE.Vector3(p.x, 22, p.z), mid, new THREE.Vector3(0, 12, 0));
      const ag = new THREE.BufferGeometry().setFromPoints(cv.getPoints(48)); const al = new THREE.Line(ag, new THREE.LineBasicMaterial({ color: C[p.cat], transparent: true, opacity: .5 })); al.userData.prog = 0; g2.add(al); (arcs[p.cat] = arcs[p.cat] || []).push(al);
    });

    // dust
    const dg = new THREE.BufferGeometry(); const dp = new Float32Array(900 * 3); for (let i = 0; i < 900; i++) { dp[i * 3] = (Math.random() - .5) * 1400; dp[i * 3 + 1] = Math.random() * 180 + 4; dp[i * 3 + 2] = (Math.random() - .5) * 1400; }
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3)); dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x9fe8cf, size: 1.5, transparent: true, opacity: .45, depthWrite: false })); scene.add(dust);

    // HTML pins
    const mk = (key, poi, cls) => { const el = document.createElement('div'); el.className = 'pin ' + (cls || ''); el.style.setProperty('--c', CSS[poi.cat]); el.innerHTML = '<i></i><b></b><em></em>'; el.querySelector('b').textContent = poi.en; el.querySelector('em').textContent = poi.d ? poi.d.toFixed(2) + ' km' : '';
      el.addEventListener('click', () => S.onPin(poi)); el.addEventListener('mouseenter', e => S.onPinOver(poi, e, true)); el.addEventListener('mouseleave', e => S.onPinOver(poi, e, false)); pinsEl.appendChild(el); pins[key] = { el, poi, world: new THREE.Vector3(poi.x, (poi.cat === 'retail' && GLA[poi.k]) ? 6 : 24, poi.z) }; };
    POIS.forEach(p => mk(p.k, p));
    const main = { k: 'pin', cat: 'pin', x: 0, z: 0, en: 'THE PIN', ar: 'موقع المشروع', d: 0, nen: '', nar: '' }; mk('pin', main, 'pinmain'); pins.pin.world.set(0, 20, 0);
    pins.pin.el.querySelector('em').textContent = '';
    window.addEventListener('resize', resize); resize();
    window.addEventListener('pointermove', e => { mouse.x = e.clientX / innerWidth - .5; mouse.y = e.clientY / innerHeight - .5; }, { passive: true });
    S.setPreset('cover', { snap: true }); S.ready = true; loop();
  }

  function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w / h < 1 ? 62 : 46; camera.updateProjectionMatrix(); }

  function refreshPins() {
    Object.keys(pins).forEach(k => {
      const p = pins[k]; let on = false;
      if (k === 'pin') on = S.labels !== 'none';
      else if (!S.cats[p.poi.cat]) on = false;
      else if (S.labels === 'all') on = true; else if (S.labels === 'imp') on = p.poi.imp; else on = false;
      p.vis = on;
    });
  }
  S.refreshPins = refreshPins;

  const v3 = new THREE.Vector3();
  function loop() {
    requestAnimationFrame(loop); if (document.hidden) return;
    const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
    // camera easing
    const k = 1 - Math.pow(.0009, dt);
    cam.p.lerp(camTarget.p, k * .6); cam.t.lerp(camTarget.t, k * .6); cam.orbit += (camTarget.orbit - cam.orbit) * k;
    ang += cam.orbit * dt;
    const rel = cam.p.clone().sub(cam.t); const ca = Math.cos(ang), sa = Math.sin(ang);
    const px = cam.t.x + rel.x * ca - rel.z * sa, pz = cam.t.z + rel.x * sa + rel.z * ca;
    camera.position.set(px + mouse.x * 16, cam.p.y + mouse.y * -10, pz + mouse.y * 6); camera.lookAt(cam.t);
    // traffic
    const pos = S._traffic.geometry.attributes.position;
    traffic.forEach((c, i) => { c.t += c.s * dt; if (c.t > 1) c.t -= 1; if (c.t < 0) c.t += 1; const dx = c.b[0] - c.a[0], dz = c.b[1] - c.a[1], l = Math.hypot(dx, dz) || 1; pos.setXYZ(i, c.a[0] + dx * c.t - dz / l * c.off, .6, c.a[1] + dz * c.t + dx / l * c.off); }); pos.needsUpdate = true;
    // roof wave
    const rp = roofLine.geometry.attributes.position; for (let i = 0; i <= 120; i++) { const u = i / 120, x = -9.25 + u * 18.5; rp.setXYZ(i, x, 3.9 + Math.sin(u * 14 + t * 2.4) * .45, -8.25 + Math.sin(u * 3.1 + t * .6) * 0 + (u < .5 ? 0 : 0)); } rp.needsUpdate = true;
    // pulses + beam
    pulses.forEach(p => { const u = (t * .35 + p.o) % 1; p.m.scale.setScalar(2 + u * 60); p.m.material.opacity = .6 * (1 - u); });
    beam.material.opacity = .26 + Math.sin(t * 2) * .06;
    // radar
    radar.material.opacity += ((radarOn ? .22 : 0) - radar.material.opacity) * .06; radar.rotation.z = -t * 1.1;
    // train
    const tu = (t * .035) % 1; const tp = trainCurve.getPoint(tu), tt = trainCurve.getTangent(tu); train.position.set(tp.x, tp.y + 1.2, tp.z); train.rotation.y = Math.atan2(-tt.z, tt.x);
    // arcs draw-in
    Object.keys(arcs).forEach(c => arcs[c].forEach(a => { const want = (S.cats[c] && S.arcs) ? 1 : 0; a.userData.prog += (want - a.userData.prog) * .04; a.geometry.setDrawRange(0, Math.max(0, Math.floor(a.userData.prog * 49))); }));
    dust.rotation.y = t * .004;
    renderer.render(scene, camera);
    // pins (greedy label collision avoidance)
    const w = innerWidth, h = innerHeight; const placed = [];
    const keys = Object.keys(pins).sort((a, b) => score(b) - score(a));
    keys.forEach(k => {
      const p = pins[k]; v3.copy(p.world).project(camera); let vis = p.vis && v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1;
      const x = (v3.x * .5 + .5) * w, y = (-v3.y * .5 + .5) * h;
      if (vis) { if (!p.w) { p.w = p.el.offsetWidth || 120; p.h = p.el.offsetHeight || 50; } const r = [x - p.w / 2, y - p.h, x + p.w / 2, y];
        const keep = k === 'pin' || p.el.classList.contains('hot'); let hit = false; for (let i = 0; i < placed.length; i++) { const o = placed[i]; if (r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]) { hit = true; break; } }
        if (hit && !keep) vis = false; else placed.push(r); }
      p.el.classList.toggle('on', !!vis); if (vis) p.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-100%)';
    });
  }
  function score(k) { const p = pins[k]; if (k === 'pin') return 1000; if (p.el.classList.contains('hot')) return 900; return (p.poi.imp ? 100 : 0) - p.poi.d; }
  S.arcs = false;
  S.init = init;
  window.Scene3D = S;
})();
