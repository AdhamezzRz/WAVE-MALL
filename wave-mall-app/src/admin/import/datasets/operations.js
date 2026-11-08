'use strict';

// Operations, advertising and the website: what a mall keeps in Excel before it goes live — the
// equipment register and its preventive plans, parking company accounts and monthly subscriptions,
// the safety & licences register, advertising spaces and advertisers, utility meters and their
// monthly readings, energy meters, patrol checkpoints, cleaning areas, the key register, and the
// website's store listings, events and promotions. Each dataset saves exactly what the module's own
// form saves, with the module's own checks (routes/maintenance.js, routes/parking.js and
// parking/core.js, routes/compliance.js, routes/media.js, revenue/utilities.js, routes/energy.js,
// routes/security.js, routes/website.js).

const crypto = require('node:crypto');
const i18n = require('../../i18n');
const MNT = require('../../routes/maintenance');
const MED = require('../../routes/media');
const NRG = require('../../routes/energy');
const SEC = require('../../routes/security');
const PRK = require('../../routes/parking');
const CMP = require('../../routes/compliance');
const WEB = require('../../routes/website');
const { MODE: PK_MODE } = require('../../parking/routes-companies');
const { plateKey, plateShow, cardKey } = require('../../parking/core');

const L = (en, ar) => ({ en, ar });
// a dictionary key → { en, ar }
const lab = (key) => ({ en: i18n.english(key), ar: typeof i18n.AR[key] === 'string' ? i18n.AR[key] : i18n.english(key) });
// { value: 'key' } or { value: ['key', …] } → enum options
const opts = (map) => Object.entries(map).map(([k, v]) => [k, lab(Array.isArray(v) ? v[0] : v)]);
const token = () => crypto.randomBytes(9).toString('base64url');

module.exports = function operationsDatasets(imports, h) {
  const { M } = h;
  const now = () => M.now();
  const today = () => M.today();

  // ---------- references shared by several datasets ----------
  const unitChoices = (db) => db.all("SELECT id, code FROM units WHERE status != 'retired' ORDER BY sort, code").map((u) => ({ id: u.id, name: u.code }));
  const brandChoices = (db) => db.all('SELECT id, name FROM brands ORDER BY name').map((b) => ({ id: b.id, name: b.name }));
  const userChoices = (db) => db.all('SELECT id, name, email FROM users WHERE active = 1 ORDER BY name').map((u) => ({ id: u.id, name: u.name, alt: [u.email] }));
  const unitsRef = { list: unitChoices, dataset: 'units', what: L('Units', 'الوحدات') };
  const brandsRef = { list: brandChoices, dataset: 'brands', what: L('Brands', 'العلامات التجارية') };
  const usersRef = { list: userChoices, what: L('Office accounts', 'حسابات المكتب') };
  const notes = (max = 2000) => ({ key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max, multiline: true, width: 30 });
  // a value the file gives that is not what the record already holds (a warning only for real changes)
  const changed = (ctx, row, k) => ctx.provided.has(k) && (!ctx.current || String(ctx.current[k] ?? '') !== String(row[k] ?? ''));
  const active = (help) => ({ key: 'active', label: L('In use', 'قيد الاستخدام'), type: 'bool', width: 12, help: help || L('Yes or no. Empty means yes for a new record.', 'نعم أو لا. الفارغ يعني «نعم» للسجل الجديد.') });

  // ============================ maintenance: equipment and assets ============================
  const contractChoices = (db) => db.all('SELECT id, ref, counterparty FROM contracts ORDER BY ref').map((c) => ({ id: c.id, name: `${c.ref} · ${c.counterparty}`, alt: [c.ref] }));
  imports.register({
    key: 'maintenance-assets',
    module: '/admin/maintenance',
    pages: ['/admin/maintenance/assets'],
    area: 'operations',
    order: 10,
    icon: 'wrench',
    table: 'assets',
    depends: ['units'],
    title: L('Equipment and assets', 'المعدات والأصول'),
    summary: L('Chillers, lifts, generators, pumps… with their place, make, warranty and service contract.', 'المبردات والمصاعد والمولدات والمضخات… بمكانها وطرازها وضمانها وعقد صيانتها.'),
    notes: L('One row per piece of equipment. Its code finds it again: a code already in the system updates it.', 'صف لكل معدة. الكود يحددها: الكود الموجود في النظام يحدّث المعدة نفسها.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Asset code', 'كود الأصل'), type: 'code', required: true, max: 30, width: 14, example: 'AHU-03', aliases: ['asset', 'asset no', 'tag', 'رقم الاصل', 'الاصل'], help: L('Unique, e.g. AHU-03.', 'فريد، مثل الكود الموضح في المثال.') },
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', required: true, max: 160, width: 30, example: 'Air handling unit, food court', aliases: ['asset name', 'description', 'اسم الاصل', 'الوصف'] },
      { key: 'category', label: L('Category', 'الفئة'), type: 'enum', enum: opts(MNT.CATEGORIES), width: 18, example: 'hvac', help: L('Empty means Electrical.', 'الفارغ يعني «كهرباء».') },
      { key: 'criticality', label: L('Criticality', 'الأهمية'), type: 'enum', enum: opts(MNT.CRIT), width: 12, example: 'high', help: L('Empty means Medium.', 'الفارغ يعني «متوسطة».') },
      { key: 'unit', label: L('Unit', 'الوحدة'), type: 'ref', width: 12, ref: unitsRef, help: L('The unit it serves; empty for a common area.', 'الوحدة التي تخدمها؛ اتركه فارغًا للمناطق المشتركة.') },
      { key: 'location', label: L('Exact place', 'المكان بالتحديد'), type: 'text', max: 160, width: 24, example: 'Roof, plant room 2' },
      { key: 'make', label: L('Make', 'الشركة المصنعة'), type: 'text', max: 80, width: 14, example: 'Carrier' },
      { key: 'model', label: L('Model', 'الطراز'), type: 'text', max: 80, width: 14 },
      { key: 'serial', label: L('Serial number', 'الرقم التسلسلي'), type: 'text', max: 80, width: 18 },
      { key: 'install_date', label: L('Installed', 'تاريخ التركيب'), type: 'date', width: 14, example: '2024-05-01' },
      { key: 'warranty_until', label: L('Warranty until', 'الضمان حتى'), type: 'date', width: 14 },
      { key: 'contract', label: L('Service contract', 'عقد الصيانة'), type: 'ref', width: 26, ref: { list: contractChoices, dataset: 'contracts', what: L('Contracts', 'العقود') }, help: L('Empty: maintained in-house.', 'الفارغ: صيانة داخلية.') },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: opts(MNT.A_STATUS), width: 14, help: L('Empty means In service.', 'الفارغ يعني «في الخدمة».') },
      notes(),
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM assets WHERE code = ? COLLATE NOCASE AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|This code is already used by another asset.');
      if (row.install_date && row.warranty_until && row.warranty_until < row.install_date && (changed(ctx, row, 'install_date') || changed(ctx, row, 'warranty_until'))) ctx.warn('warranty_until', 'imp3|The warranty ends before the installation date.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const v = {
        code: row.code, name: row.name, category: row.category || 'electrical', criticality: row.criticality || 'medium', unit_id: row.unit || null, location: row.location || null,
        make: row.make || null, model: row.model || null, serial: row.serial || null, install_date: row.install_date || null, warranty_until: row.warranty_until || null,
        contract_id: row.contract || null, status: row.status || 'in_service', notes: row.notes || null,
      };
      if (!ctx.id) {
        const id = Number(db.run(`INSERT INTO assets (code, name, category, criticality, unit_id, location, make, model, serial, install_date, warranty_until, contract_id, status, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, v.code, v.name, v.category, v.criticality, v.unit_id, v.location, v.make, v.model, v.serial, v.install_date, v.warranty_until, v.contract_id, v.status, v.notes, now(), now()).lastInsertRowid);
        ctx.log('Added an asset', 'asset', id, v.code);
        return id;
      }
      db.run('UPDATE assets SET code = ?, name = ?, category = ?, criticality = ?, unit_id = ?, location = ?, make = ?, model = ?, serial = ?, install_date = ?, warranty_until = ?, contract_id = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?',
        v.code, v.name, v.category, v.criticality, v.unit_id, v.location, v.make, v.model, v.serial, v.install_date, v.warranty_until, v.contract_id, v.status, v.notes, now(), ctx.id);
      ctx.log('Edited an asset', 'asset', ctx.id, v.code);
      return ctx.id;
    },
    export: (db) => db.all('SELECT a.*, u.code unit_code, c.ref c_ref, c.counterparty FROM assets a LEFT JOIN units u ON u.id = a.unit_id LEFT JOIN contracts c ON c.id = a.contract_id ORDER BY a.code').map((a) => ({
      $id: a.id, code: a.code, name: a.name, category: a.category, criticality: a.criticality, unit: a.unit_code, location: a.location, make: a.make, model: a.model, serial: a.serial,
      install_date: a.install_date, warranty_until: a.warranty_until, contract: a.contract_id ? `${a.c_ref} · ${a.counterparty}` : null, status: a.status, notes: a.notes,
    })),
    uses: (db, id, o) => imports.usesOf('assets', id, { ...o, entity: 'asset' }),
    link: (id) => `/admin/maintenance/assets/${id}`,
    label: (v) => (v.code ? `${v.code}${v.name ? ` · ${v.name}` : ''}` : v.name || ''),
    examples: [
      { code: 'AHU-03', name: L('Air handling unit, food court', 'وحدة مناولة الهواء، منطقة المطاعم'), category: 'hvac', criticality: 'high', location: L('Roof, plant room 2', 'السطح، غرفة المعدات ٢'), make: 'Carrier', model: '39HQ', serial: 'CR-221904', install_date: '2024-05-01', warranty_until: '2027-04-30', status: 'in_service' },
      { code: 'LIFT-02', name: L('Passenger lift, north core', 'مصعد ركاب، القلب الشمالي'), category: 'lifts', criticality: 'high', make: 'Schindler', install_date: '2024-02-15', status: 'in_service' },
    ],
  });

  // ============================ maintenance: preventive plans ============================
  const assetChoices = (db) => db.all('SELECT id, code, name FROM assets ORDER BY code').map((a) => ({ id: a.id, name: a.code, alt: [a.name] }));
  imports.register({
    key: 'ppm-plans',
    module: '/admin/maintenance',
    pages: ['/admin/maintenance/ppm'],
    area: 'operations',
    order: 11,
    icon: 'cal',
    table: 'ppm_plans',
    depends: ['maintenance-assets'],
    title: L('Preventive maintenance plans', 'خطط الصيانة الوقائية'),
    summary: L('What is serviced, how often and when next: work orders are raised a week before each date.', 'ما يُصان وكل كم ومتى المرة القادمة: تُنشأ أوامر العمل قبل كل موعد بأسبوع.'),
    notes: L('A plan is found again by its name and asset (or its name alone when it has no asset). The checklist is one step per line, or steps separated by “;”.', 'تُعرف الخطة باسمها والأصل (أو باسمها وحده إن لم يكن لها أصل). قائمة الفحص خطوة في كل سطر، أو خطوات تفصلها «;».'),
    allowed: (req) => h.can(req, 'manager'),
    keys: [['title', 'asset'], 'title'],
    columns: [
      { key: 'title', label: L('What is done', 'ما يتم'), type: 'text', required: true, max: 160, width: 34, example: 'Quarterly service of the chillers', aliases: ['plan', 'task', 'المهمه', 'الخطه'] },
      { key: 'asset', label: L('Asset', 'الأصل'), type: 'ref', width: 14, ref: { list: assetChoices, dataset: 'maintenance-assets', what: L('Equipment and assets', 'المعدات والأصول') }, help: L('The asset code; empty for a plan on no particular asset.', 'كود الأصل؛ اتركه فارغًا لخطة لا تخص أصلًا بعينه.') },
      { key: 'category', label: L('Category', 'الفئة'), type: 'enum', enum: opts(MNT.CATEGORIES), width: 18, help: L('Empty: the asset’s category.', 'الفارغ: فئة الأصل.') },
      { key: 'every_n', label: L('Every', 'كل'), type: 'int', required: true, min: 1, maxValue: 365, width: 9, example: 3 },
      { key: 'every_unit', label: L('Unit of time', 'وحدة الزمن'), type: 'enum', required: true, enum: [['day', L('days', 'أيام')], ['week', L('weeks', 'أسابيع')], ['month', L('months', 'أشهر')]], width: 13, example: 'month' },
      { key: 'next_due', label: L('Next due', 'الموعد القادم'), type: 'date', required: true, width: 14, example: '2026-12-01' },
      { key: 'last_done', label: L('Last done', 'آخر تنفيذ'), type: 'date', width: 14 },
      { key: 'priority', label: L('Priority', 'الأولوية'), type: 'enum', enum: opts(MNT.PRIORITY), width: 18, help: L('Empty means P4 · Planned.', 'الفارغ يعني «P4 · مخطط».') },
      { key: 'assignee', label: L('Assign to', 'إسناد إلى'), type: 'ref', width: 20, ref: usersRef, help: L('An office account, or leave empty and give a contractor.', 'حساب في المكتب، أو اتركه فارغًا واكتب المقاول.') },
      { key: 'contractor', label: L('Or a contractor', 'أو مقاول'), type: 'text', max: 160, width: 20 },
      { key: 'checklist', label: L('Checklist', 'قائمة الفحص'), type: 'text', max: 4000, multiline: true, width: 36, transform: (v) => ({ value: String(v).split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean).join('\n') }), help: L('One step per line (Alt+Enter in Excel), or steps separated by “;”.', 'خطوة في كل سطر داخل الخلية، أو خطوات تفصلها «;».') },
      active(L('Yes or no. Empty means yes for a new plan; “no” pauses it.', 'نعم أو لا. الفارغ يعني «نعم» للخطة الجديدة؛ «لا» توقفها مؤقتًا.')),
    ],
    find(db, v, key) {
      const parts = [].concat(key);
      const hits = parts.includes('asset')
        ? db.all('SELECT id FROM ppm_plans WHERE lower(trim(title)) = lower(trim(?)) AND asset_id = ?', v.title, v.asset)
        : db.all('SELECT id FROM ppm_plans WHERE lower(trim(title)) = lower(trim(?)) AND asset_id IS NULL', v.title);
      if (hits.length > 1) return { error: 'imp3|More than one plan has this name; rename one of them in the system first.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (row.last_done && row.last_done > today()) ctx.error('last_done', 'imp3|The last time it was done cannot be in the future.');
      if (row.next_due && row.last_done && row.next_due < row.last_done) ctx.error('next_due', 'imp3|The next date is before the last time it was done.');
      if (row.assignee && row.contractor && (changed(ctx, row, 'assignee') || changed(ctx, row, 'contractor'))) ctx.warn('contractor', 'imp3|Both a person and a contractor: the person is shown first.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const asset = row.asset ? db.get('SELECT * FROM assets WHERE id = ?', row.asset) : null;
      const p = {
        title: row.title, asset_id: asset ? asset.id : null, category: row.category || (asset ? asset.category : 'hvac'), priority: Number(row.priority) || 4,
        every_n: row.every_n, every_unit: row.every_unit, checklist: row.checklist || null, next_due: row.next_due, last_done: row.last_done || null,
        assignee_id: row.assignee || null, contractor: row.contractor || null, active: row.active === false ? 0 : 1,
      };
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO ppm_plans (title, asset_id, category, priority, every_n, every_unit, checklist, next_due, last_done, assignee_id, contractor, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          p.title, p.asset_id, p.category, p.priority, p.every_n, p.every_unit, p.checklist, p.next_due, p.last_done, p.assignee_id, p.contractor, p.active, now(), now()).lastInsertRowid);
        ctx.log('Added a preventive plan', 'ppm_plan', id, p.title);
        return id;
      }
      db.run('UPDATE ppm_plans SET title = ?, asset_id = ?, category = ?, priority = ?, every_n = ?, every_unit = ?, checklist = ?, next_due = ?, last_done = ?, assignee_id = ?, contractor = ?, active = ?, updated_at = ? WHERE id = ?',
        p.title, p.asset_id, p.category, p.priority, p.every_n, p.every_unit, p.checklist, p.next_due, p.last_done, p.assignee_id, p.contractor, p.active, now(), ctx.id);
      ctx.log('Edited a preventive plan', 'ppm_plan', ctx.id, p.title);
      return ctx.id;
    },
    export: (db) => db.all('SELECT p.*, a.code asset_code, u.name assignee FROM ppm_plans p LEFT JOIN assets a ON a.id = p.asset_id LEFT JOIN users u ON u.id = p.assignee_id ORDER BY p.next_due, p.title').map((p) => ({
      $id: p.id, title: p.title, asset: p.asset_code, category: p.category, every_n: p.every_n, every_unit: p.every_unit, next_due: p.next_due, last_done: p.last_done,
      priority: String(p.priority), assignee: p.assignee, contractor: p.contractor, checklist: p.checklist, active: !!p.active,
    })),
    uses: (db, id, o) => imports.usesOf('ppm_plans', id, o),
    link: (id) => `/admin/maintenance/ppm/${id}`,
    label: (v, names) => `${v.title || ''}${names.asset ? ` · ${names.asset}` : ''}`,
    examples: [
      { title: L('Quarterly service of the chillers', 'الصيانة الربع سنوية للمبردات'), asset: 'AHU-03', every_n: 3, every_unit: 'month', next_due: '2026-12-01', priority: '4', contractor: 'Cool Air Co.', checklist: L('Check refrigerant pressure\nClean condenser coils\nTest alarms', 'فحص ضغط وسيط التبريد\nتنظيف ملفات المكثف\nاختبار الإنذارات'), active: true },
      { title: L('Monthly generator run test', 'اختبار تشغيل شهري للمولد'), every_n: 1, every_unit: 'month', next_due: '2026-11-20', priority: '3', active: true },
    ],
  });

  // ============================ parking: company accounts ============================
  const PK_STATUS = { active: 'prk|Active', suspended: 'prk|Suspended', closed: 'prk|Closed' };
  imports.register({
    key: 'parking-companies',
    module: '/admin/parking',
    pages: ['/admin/parking/companies'],
    area: 'operations',
    order: 30,
    icon: 'car',
    table: 'pk_accounts',
    title: L('Parking company accounts', 'حسابات الشركات في الجراج'),
    summary: L('Offices, hotels and clinics nearby with many cars on one monthly invoice.', 'المكاتب والفنادق والعيادات المجاورة التي لها سيارات كثيرة على فاتورة شهرية واحدة.'),
    notes: L('Add the plates with Parking subscriptions (Company column). The first invoice goes out on the “Next invoice” date: give it when the current month is already paid.', 'تُضاف اللوحات من اشتراكات الجراج (عمود «الشركة»). تصدر أول فاتورة في تاريخ «الفاتورة القادمة»: حدده إن كان الشهر الحالي مدفوعًا بالفعل.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['ref', 'name'],
    columns: [
      { key: 'ref', label: L('Account no.', 'رقم الحساب'), type: 'code', max: 20, width: 13, keepOnUpdate: true, example: 'PC-0007', help: L('Leave empty for new accounts: the office gives the next number.', 'اتركه فارغًا للحسابات الجديدة: يعطي النظام الرقم التالي.') },
      { key: 'name', label: L('Company', 'الشركة'), type: 'text', required: true, max: 120, width: 26, example: 'Nile Clinics', aliases: ['company name', 'account', 'اسم الشركه'] },
      { key: 'tenant', label: L('A tenant of the mall', 'مستأجر في المول'), type: 'ref', width: 22, ref: brandsRef, help: L('Optional: when the company is one of the mall’s tenants.', 'اختياري: إن كانت الشركة من مستأجري المول.') },
      { key: 'contact_name', label: L('Contact', 'المسؤول'), type: 'text', max: 80, width: 18 },
      { key: 'phone', label: L('Mobile', 'الموبايل'), type: 'phone', width: 15 },
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', width: 24 },
      { key: 'tax_id', label: L('Tax ID', 'الرقم الضريبي'), type: 'text', max: 40, width: 14 },
      { key: 'address', label: L('Address', 'العنوان'), type: 'text', max: 200, width: 26 },
      { key: 'mode', label: L('Billing', 'طريقة المحاسبة'), type: 'enum', enum: opts(PK_MODE), width: 26, example: 'fixed', help: L('Empty: a monthly price per plate.', 'الفارغ: سعر شهري لكل لوحة.') },
      { key: 'price', label: L('Monthly price per plate', 'السعر الشهري لكل لوحة'), type: 'money', width: 16, example: 600 },
      { key: 'discount', label: L('Discount (%)', 'الخصم (%)'), type: 'percent', width: 12, help: L('For “what they park”.', 'لطريقة «ما يركنونه فعلًا».') },
      { key: 'cap', label: L('Most a month', 'الحد الأقصى شهريًا'), type: 'money', width: 14, help: L('For “what they park”. Empty: no cap.', 'لطريقة «ما يركنونه فعلًا». الفارغ: بلا حد.') },
      { key: 'terms_days', label: L('Days to pay', 'أيام السداد'), type: 'int', min: 0, maxValue: 90, width: 11, help: L('Empty means 15.', 'الفارغ يعني ١٥.') },
      { key: 'next_bill_on', label: L('Next invoice', 'الفاتورة القادمة'), type: 'date', width: 14, help: L('Empty for a new account: today (a monthly price) or the 1st of next month (what they park).', 'الفارغ لحساب جديد: اليوم (سعر شهري) أو أول الشهر القادم (ما يركنونه فعلًا).') },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: opts(PK_STATUS), width: 12, help: L('Empty means Active.', 'الفارغ يعني «نشط».') },
      notes(1000),
    ],
    find(db, v, key) {
      if (key === 'ref') { const r = db.get('SELECT id FROM pk_accounts WHERE ref = ? COLLATE NOCASE', v.ref); return r ? r.id : null; }
      const hits = db.all('SELECT id FROM pk_accounts WHERE lower(trim(name)) = lower(trim(?))', v.name);
      if (hits.length > 1) return { error: 'imp3|More than one company account has this name; use its account number.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (!ctx.id && row.ref && ctx.db.get('SELECT id FROM pk_accounts WHERE ref = ? COLLATE NOCASE', row.ref)) ctx.error('ref', 'imp3|This number is already used.');
      if (row.mode === 'usage' && row.price && (changed(ctx, row, 'price') || changed(ctx, row, 'mode'))) ctx.warn('price', 'imp3|The monthly price is only used for a monthly price per plate.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const mode = row.mode || 'fixed';
      const v = {
        name: row.name, brand_id: row.tenant || null, contact_name: row.contact_name || null, phone: row.phone || null, email: row.email || null, tax_id: row.tax_id || null, address: row.address || null,
        mode, price: Math.max(0, row.price || 0), discount: Math.min(100, Math.max(0, row.discount || 0)), cap: row.cap || null, terms_days: row.terms_days ?? 15, notes: row.notes || null,
      };
      if (!ctx.id) {
        const next = row.next_bill_on || (mode === 'usage' ? M.addMonths(`${today().slice(0, 7)}-01`, 1) : today());
        const ref = row.ref || db.nextRef('pk_accounts', 'PC', 4, true);
        const id = Number(db.run(`INSERT INTO pk_accounts (ref, name, brand_id, contact_name, phone, email, tax_id, address, mode, price, discount, cap, terms_days, notes, next_bill_on, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ref, v.name, v.brand_id, v.contact_name, v.phone, v.email, v.tax_id, v.address, v.mode, v.price, v.discount, v.cap, v.terms_days, v.notes, next, row.status || 'active', now(), now()).lastInsertRowid);
        ctx.log('Opened a company parking account', 'pk_account', id, v.name);
        return id;
      }
      db.run('UPDATE pk_accounts SET name = ?, brand_id = ?, contact_name = ?, phone = ?, email = ?, tax_id = ?, address = ?, mode = ?, price = ?, discount = ?, cap = ?, terms_days = ?, notes = ?, next_bill_on = COALESCE(?, next_bill_on), status = ?, updated_at = ? WHERE id = ?',
        v.name, v.brand_id, v.contact_name, v.phone, v.email, v.tax_id, v.address, v.mode, v.price, v.discount, v.cap, v.terms_days, v.notes, row.next_bill_on || null, row.status || 'active', now(), ctx.id);
      ctx.log('Changed a company parking account', 'pk_account', ctx.id, v.name);
      return ctx.id;
    },
    export: (db) => db.all('SELECT a.*, b.name brand_name FROM pk_accounts a LEFT JOIN brands b ON b.id = a.brand_id ORDER BY a.ref').map((a) => ({
      $id: a.id, ref: a.ref, name: a.name, tenant: a.brand_name, contact_name: a.contact_name, phone: a.phone, email: a.email, tax_id: a.tax_id, address: a.address, mode: a.mode,
      price: a.price, discount: a.discount, cap: a.cap, terms_days: a.terms_days, next_bill_on: a.next_bill_on, status: a.status, notes: a.notes,
    })),
    uses: (db, id, o) => {
      const out = imports.usesOf('pk_accounts', id, o);
      // plates on the account are linked by account_id (no foreign key)
      const n = db.value("SELECT COUNT(*) FROM pk_permits WHERE account_id = ?", id);
      if (n) out.push({ n, what: L('parking subscriptions', 'اشتراكات جراج') });
      const inv = db.value("SELECT COUNT(*) FROM invoices WHERE source = 'parking-account' AND source_id = ?", id);
      if (inv) out.push({ n: inv, what: L('invoices', 'فواتير') });
      return out;
    },
    link: (id) => `/admin/parking/companies/${id}`,
    label: (v) => (v.ref ? `${v.ref} · ${v.name || ''}` : v.name || ''),
    examples: [
      { name: 'Nile Clinics', contact_name: 'Dr. Hany Fawzy', phone: '01001234567', email: 'admin@nileclinics.com', mode: 'fixed', price: 600, terms_days: 15, next_bill_on: '2026-12-01', status: 'active' },
      { name: 'Cairo Business Hotel', mode: 'usage', discount: 20, cap: 25000, terms_days: 30, status: 'active' },
    ],
  });

  // ============================ parking: monthly subscriptions ============================
  const planChoices = (db) => db.all('SELECT id, code, name, name_ar FROM pk_plans ORDER BY code').map((p) => ({ id: p.id, name: p.code, alt: [p.name, p.name_ar].filter(Boolean) }));
  const companyChoices = (db) => db.all('SELECT id, ref, name FROM pk_accounts ORDER BY ref').map((a) => ({ id: a.id, name: a.ref, alt: [a.name] }));
  const employeeChoices = (db) => db.all("SELECT id, code, name, name_ar FROM employees ORDER BY status = 'active' DESC, code").map((e) => ({ id: e.id, name: `${e.code} · ${e.name}`, alt: [e.code, e.name, e.name_ar].filter(Boolean) }));
  const platesOf = (text) => [...new Set(String(text || '').split(/[,،;\n]+/).map((x) => x.trim()).filter(Boolean))];
  // a plate as the parking module stores it: letters then digits; at least one digit
  const plateOk = (p) => { const k = plateKey(p); return k.length >= 2 && /\d/.test(k) && /^[A-Zء-ي]{0,4}\d{1,7}$/.test(k); };
  const PERMIT_STATUS = Object.fromEntries(Object.entries(PRK.P_STATUS).filter(([k]) => k !== 'pending'));
  imports.register({
    key: 'parking-subscriptions',
    module: '/admin/parking',
    pages: ['/admin/parking/subscriptions'],
    area: 'operations',
    order: 31,
    icon: 'car',
    table: 'pk_permits',
    depends: ['parking-companies', 'brands', 'employees'],
    title: L('Parking subscriptions', 'اشتراكات الجراج'),
    summary: L('Monthly parking on a plate or an NFC card: tenants’ staff, mall staff, VIPs, individuals and company plates.', 'الركن الشهري بلوحة أو ببطاقة لا تلامسية: موظفو المستأجرين وموظفو المول وكبار الزوار والأفراد ولوحات الشركات.'),
    notes: L('Plates: up to six per row, separated by commas, e.g. “ق ص ر 1234, س ع د 777”. A plate already on another subscription is refused. A subscription that started before today is invoiced from the next period on, unless you give “Next invoice”.', 'اللوحات: حتى ست في الصف تفصلها فواصل، مثل «ق ص ر 1234، س ع د 777». اللوحة المسجلة على اشتراك آخر تُرفض. الاشتراك الذي بدأ قبل اليوم يُفوتر من الفترة التالية، إلا إن حددت «الفاتورة القادمة».'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['ref'],
    columns: [
      { key: 'ref', label: L('Subscription no.', 'رقم الاشتراك'), type: 'code', max: 20, width: 14, keepOnUpdate: true, example: 'PS-0042', help: L('Leave empty for new subscriptions.', 'اتركه فارغًا للاشتراكات الجديدة.') },
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', required: true, max: 120, width: 22, example: 'Ahmed Samir', aliases: ['driver', 'holder name', 'اسم السائق', 'صاحب الاشتراك'], help: L('The driver, or the company.', 'السائق أو الشركة.') },
      { key: 'holder', label: L('For', 'لمن'), type: 'enum', enum: opts(PRK.HOLDER), width: 16, example: 'individual', help: L('Empty means Individual.', 'الفارغ يعني «فرد».') },
      { key: 'tenant', label: L('Tenant', 'المستأجر'), type: 'ref', width: 20, ref: brandsRef, help: L('Required for tenants’ staff.', 'مطلوب لموظفي المستأجرين.') },
      { key: 'employee', label: L('Employee', 'الموظف'), type: 'ref', width: 22, ref: { list: employeeChoices, dataset: 'employees', what: L('Employees', 'الموظفين') }, help: L('For mall staff: their employee code.', 'لموظفي المول: كود الموظف.') },
      { key: 'company', label: L('Company account', 'حساب الشركة'), type: 'ref', width: 14, ref: { list: companyChoices, dataset: 'parking-companies', what: L('Parking company accounts', 'حسابات الشركات في الجراج') }, help: L('The plate belongs to a company account: it is billed on the company’s invoice (no price here).', 'اللوحة تابعة لحساب شركة: تُفوتر على فاتورة الشركة (بلا سعر هنا).') },
      { key: 'plan', label: L('Plan', 'الباقة'), type: 'ref', width: 14, ref: { list: planChoices, what: L('Parking plans', 'باقات الجراج') }, help: L('Optional: its price and months fill the empty columns.', 'اختياري: سعرها وعدد أشهرها يُستخدمان للأعمدة الفارغة.') },
      { key: 'plates', label: L('Plates', 'اللوحات'), type: 'text', max: 200, width: 26, example: 'ق ص ر 1234', aliases: ['plate', 'plate no', 'car plate', 'رقم اللوحه', 'اللوحه'], transform: (v) => {
        const list = platesOf(v);
        if (list.length > 6) return { error: 'imp3|Six plates at most.' };
        const bad = list.find((p) => !plateOk(p));
        if (bad) return { error: 'imp3|“{plate}” is not a car plate (letters then up to 7 digits).', params: { plate: bad } };
        return { value: list.map(plateShow).join(', ') };
      } },
      { key: 'card_uid', label: L('NFC card number', 'رقم البطاقة'), type: 'text', max: 40, width: 20, transform: (v) => (cardKey(v) ? { value: cardKey(v) } : { error: 'imp3|That is not a card number.' }) },
      { key: 'cars', label: L('Cars inside at once', 'سيارات بالداخل في نفس الوقت'), type: 'int', min: 1, maxValue: 10, width: 12, help: L('Empty: the plan’s, or 1.', 'الفارغ: عدد الباقة أو ١.') },
      { key: 'price', label: L('Price per period', 'السعر لكل فترة'), type: 'money', width: 14, example: 900, help: L('Including VAT. Empty: the plan’s price.', 'شامل الضريبة. الفارغ: سعر الباقة.') },
      { key: 'months', label: L('Months per period', 'أشهر الفترة'), type: 'int', min: 1, maxValue: 12, width: 11, help: L('Empty: the plan’s, or 1.', 'الفارغ: أشهر الباقة أو ١.') },
      { key: 'starts_on', label: L('Starts', 'يبدأ'), type: 'date', required: true, width: 13, example: '2026-11-01' },
      { key: 'ends_on', label: L('Ends', 'ينتهي'), type: 'date', width: 13, help: L('Empty: until cancelled.', 'الفارغ: حتى الإلغاء.') },
      { key: 'auto_renew', label: L('Renews by itself', 'يتجدد تلقائيًا'), type: 'bool', width: 12, help: L('Empty means yes.', 'الفارغ يعني «نعم».') },
      { key: 'next_bill_on', label: L('Next invoice', 'الفاتورة القادمة'), type: 'date', width: 14, help: L('Empty for a new subscription: the start date, or the next period on or after today when it started earlier.', 'الفارغ لاشتراك جديد: تاريخ البدء، أو أول فترة تبدأ اليوم أو بعده إن كان قد بدأ قبل ذلك.') },
      { key: 'phone', label: L('Mobile', 'الموبايل'), type: 'phone', width: 15 },
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', width: 22 },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: opts(PERMIT_STATUS), width: 12, help: L('Empty means Active.', 'الفارغ يعني «نشط».') },
      notes(1000),
    ],
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (!ctx.id && row.ref && db.get('SELECT id FROM pk_permits WHERE ref = ? COLLATE NOCASE', row.ref)) ctx.error('ref', 'imp3|This number is already used.');
      if (!row.plates && !row.card_uid) ctx.error('plates', 'imp3|Give a plate or a card number.');
      const holder = row.company ? 'individual' : row.holder || 'individual';
      if (holder === 'tenant' && !row.tenant) ctx.error('tenant', 'imp3|Choose the tenant for tenants’ staff.');
      if (row.company && row.holder && row.holder !== 'individual' && changed(ctx, row, 'holder')) ctx.warn('holder', 'imp3|A company plate is billed to the company; “For” is not used.');
      if (row.company && row.price && changed(ctx, row, 'price')) ctx.warn('price', 'imp3|A company plate has no price of its own: the company account sets it.');
      if (row.ends_on && row.starts_on && row.ends_on < row.starts_on) ctx.error('ends_on', 'imp3|The end is before the start.');
      for (const p of platesOf(row.plates)) {
        const k = plateKey(p);
        const other = db.get("SELECT ref FROM pk_permits WHERE plate_keys LIKE ? AND status IN ('active','suspended','pending') AND id != ?", `%,${k},%`, ctx.id || 0);
        if (other) { ctx.error('plates', 'imp3|The plate {plate} is already on subscription {ref}.', { plate: plateShow(p), ref: other.ref }); break; }
      }
      const card = cardKey(row.card_uid);
      if (card && db.get("SELECT id FROM pk_permits WHERE card_uid = ? AND status IN ('active','suspended') AND id != ?", card, ctx.id || 0)) ctx.error('card_uid', 'imp3|That card is already used by another subscription.');
      if (!ctx.id && !row.next_bill_on && row.starts_on && row.starts_on < today() && !row.company && (row.price || (row.plan && ctx.db.value('SELECT price FROM pk_plans WHERE id = ?', row.plan)))) {
        ctx.warn('next_bill_on', 'imp3|It started before today: invoices start with the next period. Earlier periods are taken as paid.');
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const P = h.parking;
      const plan = row.plan ? db.get('SELECT * FROM pk_plans WHERE id = ?', row.plan) : null;
      const company = row.company ? db.get('SELECT * FROM pk_accounts WHERE id = ?', row.company) : null;
      const months = row.months || (plan ? plan.months : 1);
      const v = {
        plan_id: plan ? plan.id : null, holder: company ? 'individual' : row.holder || 'individual', brand_id: row.tenant || null, employee_id: row.employee || null,
        name: row.name, phone: row.phone || null, email: row.email || null, plates: row.plates || '', card_uid: row.card_uid || '', zone_id: plan ? plan.zone_id : null,
        cars: row.cars || (plan ? plan.cars : 1), price: company ? 0 : row.price ?? (plan ? plan.price : 0), months, starts_on: row.starts_on, ends_on: row.ends_on || null,
        auto_renew: row.auto_renew !== false, notes: row.notes || null,
      };
      const saved = P.savePermit(v, { id: ctx.id || null, user: ctx.user });
      // the first invoice: the given date, or the next period on or after today for one that started earlier
      let next = row.next_bill_on || null;
      if (!ctx.id && !next && saved.price > 0 && saved.starts_on < today()) {
        next = saved.starts_on;
        for (let k = 0; k < 600 && next < today(); k++) next = M.addMonths(next, saved.months);
      }
      if (company) db.run("UPDATE pk_permits SET account_id = ?, source = 'company', next_bill_on = NULL WHERE id = ?", company.id, saved.id);
      else {
        if (ctx.id) db.run("UPDATE pk_permits SET account_id = NULL, source = CASE WHEN source = 'company' THEN 'office' ELSE source END WHERE id = ?", saved.id);
        if (next && saved.price > 0) db.run('UPDATE pk_permits SET next_bill_on = ? WHERE id = ?', next, saved.id);
        else if (!ctx.id && saved.price > 0 && !saved.next_bill_on) db.run('UPDATE pk_permits SET next_bill_on = starts_on WHERE id = ?', saved.id);
      }
      const want = row.status || 'active';
      if (want !== saved.status) P.setPermitStatus(saved, want, want === 'active' ? null : 'manual');
      if (ctx.id) ctx.log('Updated a parking subscription', 'pk_permit', saved.id, saved.ref);
      else ctx.log('Created a parking subscription', 'pk_permit', saved.id, `${saved.ref} · ${saved.name}`);
      return saved.id;
    },
    export: (db) => db.all(`SELECT p.*, b.name brand_name, e.code e_code, e.name e_name, a.ref a_ref, pl.code plan_code FROM pk_permits p LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN employees e ON e.id = p.employee_id LEFT JOIN pk_accounts a ON a.id = p.account_id LEFT JOIN pk_plans pl ON pl.id = p.plan_id WHERE p.status != 'pending' ORDER BY p.ref`).map((p) => ({
      $id: p.id, ref: p.ref, name: p.name, holder: p.holder, tenant: p.brand_name, employee: p.employee_id ? `${p.e_code} · ${p.e_name}` : null, company: p.a_ref, plan: p.plan_code,
      plates: p.plates, card_uid: p.card_uid, cars: p.cars, price: p.price, months: p.months, starts_on: p.starts_on, ends_on: p.ends_on, auto_renew: !!p.auto_renew,
      next_bill_on: p.next_bill_on, phone: p.phone, email: p.email, status: p.status, notes: p.notes,
    })),
    uses: (db, id, o) => {
      const out = imports.usesOf('pk_permits', id, o);
      const inv = db.value("SELECT COUNT(*) FROM invoices WHERE source = 'parking-permit' AND source_id = ?", id);
      if (inv) out.push({ n: inv, what: L('invoices', 'فواتير') });
      return out;
    },
    link: (id) => `/admin/parking/subscriptions/${id}`,
    label: (v) => (v.ref ? `${v.ref} · ${v.name || ''}` : `${v.name || ''}${v.plates ? ` · ${v.plates}` : ''}`),
    examples: [
      { name: 'Ahmed Samir', holder: 'individual', plates: 'ق ص ر 1234', price: 900, months: 1, starts_on: '2026-11-01', auto_renew: true, phone: '01001234567', status: 'active' },
      { name: 'Mona Adel', holder: 'tenant', tenant: 'Maison Lune', plates: 'س ع د 777', price: 600, months: 1, starts_on: '2026-10-01', status: 'active' },
      { name: 'Dr. Hany Fawzy', company: 'PC-0007', plates: 'م ن ى 4521', starts_on: '2026-11-01', status: 'active' },
    ],
  });

  // ============================ safety & licences ============================
  imports.register({
    key: 'safety-register',
    module: '/admin/compliance',
    pages: ['/admin/compliance'],
    area: 'operations',
    order: 40,
    icon: 'shield',
    table: 'cmp_items',
    title: L('Safety & licences register', 'سجل السلامة والتراخيص'),
    summary: L('Civil defence, fire systems, lifts, generators, pest control, licences and insurance: next due dates and reminders.', 'الدفاع المدني وأنظمة الحريق والمصاعد والمولدات ومكافحة الحشرات والتراخيص والتأمين: المواعيد القادمة والتذكيرات.'),
    notes: L('Empty “Next due” is worked out from “Last done” and “How often”. Certificates are uploaded on each item’s page. Tenants’ insurance details (policy and expiry) come with the Brands import.', 'يُحسب «الموعد القادم» الفارغ من «آخر تنفيذ» و«التكرار». تُرفع الشهادات من صفحة كل بند. بيانات تأمين المستأجرين (الوثيقة والانتهاء) تأتي مع استيراد العلامات التجارية.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['ref', 'title'],
    columns: [
      { key: 'ref', label: L('Reference', 'الرقم المرجعي'), type: 'code', max: 20, width: 11, keepOnUpdate: true, example: 'SL-014', help: L('Leave empty for new items.', 'اتركه فارغًا للبنود الجديدة.') },
      { key: 'title', label: L('What', 'البند'), type: 'text', required: true, max: 160, width: 32, example: 'Civil defence certificate', aliases: ['item', 'certificate', 'licence', 'البند', 'الشهاده', 'الترخيص'] },
      { key: 'category', label: L('Kind', 'النوع'), type: 'enum', enum: opts(CMP.CATS), width: 20, example: 'civil_defence', help: L('Empty means Other.', 'الفارغ يعني «أخرى».') },
      { key: 'provider', label: L('Done or issued by', 'جهة التنفيذ أو الإصدار'), type: 'text', max: 160, width: 24, example: 'Civil Defence, New Cairo' },
      { key: 'number', label: L('Certificate, licence or policy no.', 'رقم الشهادة أو الترخيص أو الوثيقة'), type: 'text', max: 80, width: 22 },
      { key: 'freq', label: L('How often', 'التكرار'), type: 'enum', enum: opts(CMP.FREQ), width: 16, example: 'yearly', help: L('Empty means Every year.', 'الفارغ يعني «كل سنة».') },
      { key: 'last_done', label: L('Last done', 'آخر تنفيذ'), type: 'date', width: 13, example: '2026-03-10' },
      { key: 'next_due', label: L('Next due', 'الموعد القادم'), type: 'date', width: 13 },
      { key: 'owner', label: L('Responsible', 'المسؤول'), type: 'ref', width: 20, ref: usersRef, help: L('An office account: they get the reminders.', 'حساب في المكتب: تصله التذكيرات.') },
      { key: 'remind_days', label: L('Remind days before', 'التذكير قبل (أيام)'), type: 'int', min: 1, maxValue: 180, width: 12, help: L('Empty means 30.', 'الفارغ يعني ٣٠.') },
      active(L('Still required: yes or no. Empty means yes.', 'ما زال مطلوبًا: نعم أو لا. الفارغ يعني «نعم».')),
      notes(),
    ],
    find(db, v, key) {
      if (key === 'ref') { const r = db.get('SELECT id FROM cmp_items WHERE ref = ? COLLATE NOCASE', v.ref); return r ? r.id : null; }
      const hits = db.all('SELECT id FROM cmp_items WHERE lower(trim(title)) = lower(trim(?))', v.title);
      if (hits.length > 1) return { error: 'imp3|More than one item has this name; use its reference.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (!ctx.id && row.ref && ctx.db.get('SELECT id FROM cmp_items WHERE ref = ? COLLATE NOCASE', row.ref)) ctx.error('ref', 'imp3|This number is already used.');
      if (row.last_done && row.last_done > today()) ctx.error('last_done', 'imp3|The last time it was done cannot be in the future.');
      if (!row.next_due && row.last_done) row.next_due = h.compliance.after(row.freq || 'yearly', row.last_done);
      if (row.next_due && row.last_done && row.next_due < row.last_done) ctx.error('next_due', 'imp3|The next date is before the last time it was done.');
      if (row.next_due && row.next_due < today() && row.active !== false && (!ctx.current || changed(ctx, row, 'next_due') || changed(ctx, row, 'last_done'))) ctx.warn('next_due', 'imp3|Already overdue: it shows in red and the reminders go out.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const v = {
        category: row.category || 'other', title: row.title, provider: row.provider || null, number: row.number || null, freq: row.freq || 'yearly', last_done: row.last_done || null,
        next_due: row.next_due || null, owner_id: row.owner || null, remind_days: row.remind_days || 30, notes: row.notes || null, active: row.active === false ? 0 : 1,
      };
      if (!ctx.id) {
        const id = Number(db.run(`INSERT INTO cmp_items (ref, category, title, provider, number, freq, last_done, next_due, owner_id, remind_days, notes, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.ref || db.nextRef('cmp_items', 'SL', 3, false), v.category, v.title, v.provider, v.number, v.freq, v.last_done, v.next_due, v.owner_id, v.remind_days, v.notes, v.active, now(), now()).lastInsertRowid);
        ctx.log('Added a safety or licence item', 'cmp_item', id, v.title);
        return id;
      }
      db.run('UPDATE cmp_items SET category = ?, title = ?, provider = ?, number = ?, freq = ?, last_done = ?, next_due = ?, owner_id = ?, remind_days = ?, notes = ?, active = ?, alerted = CASE WHEN next_due IS ? THEN alerted ELSE NULL END, updated_at = ? WHERE id = ?',
        v.category, v.title, v.provider, v.number, v.freq, v.last_done, v.next_due, v.owner_id, v.remind_days, v.notes, v.active, v.next_due, now(), ctx.id);
      ctx.log('Changed a safety or licence item', 'cmp_item', ctx.id, v.title);
      return ctx.id;
    },
    export: (db) => db.all('SELECT i.*, u.name owner_name FROM cmp_items i LEFT JOIN users u ON u.id = i.owner_id ORDER BY i.ref').map((i) => ({
      $id: i.id, ref: i.ref, title: i.title, category: i.category, provider: i.provider, number: i.number, freq: i.freq, last_done: i.last_done, next_due: i.next_due,
      owner: i.owner_name, remind_days: i.remind_days, active: !!i.active, notes: i.notes,
    })),
    uses: (db, id, o) => imports.usesOf('cmp_items', id, { ...o, entity: 'cmp_item' }),
    link: (id) => `/admin/compliance/items/${id}`,
    label: (v) => (v.ref ? `${v.ref} · ${v.title || ''}` : v.title || ''),
    examples: [
      { title: L('Civil defence certificate', 'شهادة الدفاع المدني'), category: 'civil_defence', provider: L('Civil Defence, New Cairo', 'الدفاع المدني، القاهرة الجديدة'), number: 'CD-2026-1182', freq: 'yearly', last_done: '2026-03-10', remind_days: 45, active: true },
      { title: L('Lift certificates', 'شهادات المصاعد'), category: 'lifts', provider: 'Schindler', freq: 'half', last_done: '2026-06-01', active: true },
    ],
  });

  // ============================ advertising: spaces ============================
  imports.register({
    key: 'media-spaces',
    module: '/admin/media',
    pages: ['/admin/media/inventory'],
    area: 'revenue',
    order: 80,
    icon: 'dash',
    table: 'media_items',
    depends: ['units'],
    title: L('Advertising spaces', 'المساحات الإعلانية'),
    summary: L('Screens, banners, atrium zones, lift wraps, stands and car spots with their size and rate card.', 'الشاشات واللافتات ومناطق الأتريوم وتغليف المصاعد والأجنحة وأماكن السيارات بمقاساتها وأسعارها.'),
    notes: L('A code already in the system updates that space. Seasons and volume discounts stay on the Rate card page.', 'الكود الموجود في النظام يحدّث المساحة نفسها. المواسم وخصومات الكمية تبقى في صفحة الأسعار.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Code', 'الكود'), type: 'code', required: true, max: 20, width: 12, example: 'SCR-01' },
      { key: 'name', label: L('Name (English)', 'الاسم (بالإنجليزية)'), type: 'text', required: true, max: 120, width: 26, example: 'Main atrium screen' },
      { key: 'name_ar', label: L('Name (Arabic)', 'الاسم (بالعربية)'), type: 'text', max: 120, width: 24, example: 'شاشة الأتريوم الرئيسية' },
      { key: 'type', label: L('Type', 'النوع'), type: 'enum', enum: opts(MED.TYPES), width: 22, example: 'screen', help: L('Empty means Digital screen.', 'الفارغ يعني «شاشة رقمية».') },
      { key: 'level', label: L('Level', 'المستوى'), type: 'enum', enum: opts(MED.LEVELS), width: 16, example: 'ground' },
      { key: 'location', label: L('Where (English)', 'المكان (بالإنجليزية)'), type: 'text', max: 160, width: 24 },
      { key: 'location_ar', label: L('Where (Arabic)', 'المكان (بالعربية)'), type: 'text', max: 160, width: 24 },
      { key: 'unit', label: L('Next to unit', 'بجوار الوحدة'), type: 'ref', width: 12, ref: unitsRef },
      { key: 'plan_pos', label: L('Position on the plan', 'الموقع على المخطط'), type: 'text', max: 80, width: 16 },
      { key: 'width_m', label: L('Width (m)', 'العرض (م)'), type: 'number', min: 0, maxValue: 1000, width: 10 },
      { key: 'height_m', label: L('Height (m)', 'الارتفاع (م)'), type: 'number', min: 0, maxValue: 1000, width: 10 },
      { key: 'area_m2', label: L('Floor area (m²)', 'المساحة (م²)'), type: 'number', min: 0, maxValue: 100000, width: 11 },
      { key: 'slots', label: L('Advertisers in the loop', 'عدد المعلنين في الدورة'), type: 'int', min: 1, maxValue: 30, width: 12, help: L('1 for a space sold whole. Empty means 1.', '١ للمساحة التي تُباع كاملة. الفارغ يعني ١.') },
      { key: 'slot_seconds', label: L('Seconds per slot', 'ثوانٍ لكل إعلان'), type: 'int', min: 1, maxValue: 600, width: 11 },
      { key: 'exposure_pct', label: L('Visitors passing (%)', 'الزوار المارّون (%)'), type: 'percent', width: 12 },
      { key: 'specs', label: L('Specification', 'المواصفات'), type: 'text', max: 1000, multiline: true, width: 28 },
      { key: 'rate_day', label: L('Per day', 'لليوم'), type: 'money', width: 11, example: 2500 },
      { key: 'rate_week', label: L('Per week', 'للأسبوع'), type: 'money', width: 11 },
      { key: 'rate_month', label: L('Per month', 'للشهر'), type: 'money', width: 11 },
      { key: 'min_days', label: L('Minimum days', 'أقل عدد أيام'), type: 'int', min: 1, maxValue: 365, width: 11, help: L('Empty means 1.', 'الفارغ يعني ١.') },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: opts(MED.ITEM_STATUS), width: 16, help: L('Empty means On sale.', 'الفارغ يعني «معروضة للبيع».') },
      notes(1000),
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM media_items WHERE code = ? COLLATE NOCASE AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|This code is already used by another space.');
      if (!row.rate_day && !row.rate_week && !row.rate_month && (!ctx.current || ['rate_day', 'rate_week', 'rate_month'].some((k) => changed(ctx, row, k)))) ctx.warn('rate_day', 'imp3|No rate yet: it cannot be priced in a proposal.');
      if (ctx.id && h.media && h.media.slotClash) {
        const slots = row.slots || 1;
        const cur = ctx.current ? ctx.current.slots || 1 : slots;
        if (slots < cur) {
          const bad = h.media.slotClash(ctx.id, slots);
          if (bad) ctx.error('slots', 'imp3|{n} slots are already sold on {date}. Move those campaigns first.', { n: bad.used, date: bad.date });
        }
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const slots = row.slots || 1;
      const secs = row.slot_seconds || (slots > 1 ? 10 : null);
      const v = {
        code: row.code, name: row.name, name_ar: row.name_ar || null, type: row.type || 'screen', level: row.level || null, location: row.location || null, location_ar: row.location_ar || null,
        unit_id: row.unit || null, plan_pos: row.plan_pos || null, width_m: row.width_m ?? null, height_m: row.height_m ?? null, area_m2: row.area_m2 ?? null, specs: row.specs || null,
        slots, slot_seconds: secs, loop_seconds: secs ? secs * slots : null, rate_day: row.rate_day ?? null, rate_week: row.rate_week ?? null, rate_month: row.rate_month ?? null,
        min_days: row.min_days || 1, exposure_pct: row.exposure_pct ?? null, status: row.status || 'active', notes: row.notes || null,
      };
      const cols = Object.keys(v);
      if (!ctx.id) {
        const id = Number(db.run(`INSERT INTO media_items (${cols.join(', ')}, sort, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`, ...cols.map((k) => v[k]), (db.value('SELECT MAX(sort) FROM media_items') || 0) + 1, now(), now()).lastInsertRowid);
        ctx.log('Added an advertising space', 'media_item', id, v.code);
        return id;
      }
      db.run(`UPDATE media_items SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((k) => v[k]), now(), ctx.id);
      ctx.log('Edited an advertising space', 'media_item', ctx.id, v.code);
      return ctx.id;
    },
    export: (db) => db.all('SELECT i.*, u.code unit_code FROM media_items i LEFT JOIN units u ON u.id = i.unit_id ORDER BY i.sort, i.code').map((i) => ({
      $id: i.id, code: i.code, name: i.name, name_ar: i.name_ar, type: i.type, level: i.level, location: i.location, location_ar: i.location_ar, unit: i.unit_code, plan_pos: i.plan_pos,
      width_m: i.width_m, height_m: i.height_m, area_m2: i.area_m2, slots: i.slots, slot_seconds: i.slot_seconds, exposure_pct: i.exposure_pct, specs: i.specs,
      rate_day: i.rate_day, rate_week: i.rate_week, rate_month: i.rate_month, min_days: i.min_days, status: i.status, notes: i.notes,
    })),
    uses: (db, id, o) => imports.usesOf('media_items', id, { ...o, entity: 'media_item' }),
    link: (id) => `/admin/media/inventory/${id}`,
    label: (v) => (v.code ? `${v.code}${v.name ? ` · ${v.name}` : ''}` : v.name || ''),
    examples: [
      { code: 'SCR-01', name: 'Main atrium screen', name_ar: 'شاشة الأتريوم الرئيسية', type: 'screen', level: 'ground', slots: 6, slot_seconds: 15, exposure_pct: 70, rate_day: 2500, rate_week: 15000, rate_month: 55000, min_days: 3, status: 'active' },
      { code: 'LW-02', name: 'North lift wrap', name_ar: 'تغليف المصعد الشمالي', type: 'wrap', level: 'ground', width_m: 2.4, height_m: 3.2, rate_month: 40000, min_days: 30, status: 'active' },
    ],
  });

  // ============================ advertising: advertisers ============================
  imports.register({
    key: 'advertisers',
    module: '/admin/media',
    pages: ['/admin/media/clients'],
    area: 'revenue',
    order: 81,
    icon: 'brand',
    table: 'media_clients',
    title: L('Advertisers', 'المعلنون'),
    summary: L('Agencies and companies that buy advertising (tenants advertise under their own brand).', 'الوكالات والشركات التي تشتري الإعلانات (المستأجرون يعلنون باسم علامتهم).'),
    allowed: (req) => h.can(req, 'agent'),
    keys: ['name'],
    columns: [
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', required: true, max: 120, width: 26, example: 'Nile Telecom', aliases: ['advertiser', 'company', 'agency', 'المعلن', 'الشركه', 'الوكاله'] },
      { key: 'kind', label: L('Type', 'النوع'), type: 'enum', enum: opts(MED.CLIENT_KINDS), width: 14, example: 'company', help: L('Empty means Advertiser.', 'الفارغ يعني «معلن».') },
      { key: 'contact_name', label: L('Contact person', 'المسؤول'), type: 'text', max: 120, width: 20 },
      { key: 'phone', label: L('Phone', 'الهاتف'), type: 'phone', width: 15 },
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', width: 24 },
      { key: 'tax_id', label: L('Tax number', 'الرقم الضريبي'), type: 'text', max: 40, width: 14 },
      { key: 'address', label: L('Address', 'العنوان'), type: 'text', max: 240, width: 28 },
      notes(1000),
    ],
    find(db, v) {
      const hits = db.all('SELECT id FROM media_clients WHERE lower(trim(name)) = lower(trim(?))', v.name);
      if (hits.length > 1) return { error: 'imp3|More than one advertiser has this name; rename one of them in the system first.' };
      return hits.length ? hits[0].id : null;
    },
    apply(row, ctx) {
      const { db } = ctx;
      const k = { name: row.name, kind: row.kind || 'company', contact_name: row.contact_name || null, phone: row.phone || null, email: row.email || null, tax_id: row.tax_id || null, address: row.address || null, notes: row.notes || null };
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO media_clients (name, kind, contact_name, phone, email, tax_id, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', k.name, k.kind, k.contact_name, k.phone, k.email, k.tax_id, k.address, k.notes, now(), now()).lastInsertRowid);
        ctx.log('Added an advertiser', 'media_client', id, k.name);
        return id;
      }
      db.run('UPDATE media_clients SET name = ?, kind = ?, contact_name = ?, phone = ?, email = ?, tax_id = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?', k.name, k.kind, k.contact_name, k.phone, k.email, k.tax_id, k.address, k.notes, now(), ctx.id);
      ctx.log('Edited an advertiser', 'media_client', ctx.id, k.name);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM media_clients ORDER BY name').map((k) => ({ $id: k.id, name: k.name, kind: k.kind, contact_name: k.contact_name, phone: k.phone, email: k.email, tax_id: k.tax_id, address: k.address, notes: k.notes })),
    uses: (db, id, o) => imports.usesOf('media_clients', id, o),
    link: (id) => `/admin/media/clients/${id}`,
    label: (v) => v.name || '',
    examples: [
      { name: 'Nile Telecom', kind: 'company', contact_name: 'Rania Fouad', phone: '01001112233', email: 'rania@niletelecom.com.eg' },
      { name: 'Blue Moon Media', kind: 'agency', contact_name: 'Karim Adel', email: 'karim@bluemoon.media' },
    ],
  });

  // ============================ utilities: meters ============================
  const U = () => h.revenue && h.revenue.utilities;
  const UTIL_LABEL = { electricity: 'utl|Electricity', chilled: 'utl|Chilled water', water: 'utl|Water', gas: 'utl|Gas' };
  const meterCode = (v) => {
    const code = String(v).toUpperCase().trim().replace(/\s+/g, '-');
    return code ? { value: code } : { error: 'imp3|Enter the meter code.' };
  };
  imports.register({
    key: 'utility-meters',
    module: '/admin/utilities',
    pages: ['/admin/utilities/meters'],
    area: 'operations',
    order: 50,
    icon: 'gauge',
    table: 'utl_meters',
    depends: ['units'],
    title: L('Utility meters', 'عدادات المرافق'),
    summary: L('Electricity, chilled water, water and gas meters on tenant units and common areas.', 'عدادات الكهرباء والمياه المبردة والمياه والغاز على وحدات المستأجرين والمناطق المشتركة.'),
    notes: L('A meter on a unit is billed to its tenant; a meter without a unit is a common area (its cost goes to the service charge). “Opening reading” is used once, for a new meter: it is saved for last month.', 'العداد على وحدة يُفوتر لمستأجرها؛ والعداد بلا وحدة لمنطقة مشتركة (تكلفته تذهب لرسوم الخدمات). «القراءة الافتتاحية» تُستخدم مرة واحدة لعداد جديد وتُحفظ للشهر الماضي.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Meter code', 'كود العداد'), type: 'text', required: true, max: 30, width: 14, example: 'E-G08', transform: meterCode, aliases: ['meter', 'meter no', 'meter number', 'رقم العداد', 'العداد'] },
      { key: 'utility', label: L('Utility', 'المرفق'), type: 'enum', required: true, enum: opts(UTIL_LABEL), width: 16, example: 'electricity', keepOnUpdate: false },
      { key: 'unit', label: L('Unit', 'الوحدة'), type: 'ref', width: 12, ref: unitsRef, help: L('Empty for a common area.', 'اتركه فارغًا للمنطقة المشتركة.') },
      { key: 'area', label: L('Common area served', 'المنطقة المشتركة المخدومة'), type: 'text', max: 120, width: 22 },
      { key: 'serial', label: L('Serial number', 'الرقم التسلسلي'), type: 'text', max: 60, width: 16 },
      { key: 'multiplier', label: L('Multiplier', 'المضاعف'), type: 'number', min: 0.001, maxValue: 100000, width: 10, help: L('Empty means 1.', 'الفارغ يعني ١.') },
      { key: 'digits', label: L('Dial digits', 'عدد خانات العداد'), type: 'int', min: 3, maxValue: 9, width: 10, help: L('Empty means 6. A reading never has more digits.', 'الفارغ يعني ٦. لا تزيد القراءة عن عدد الخانات.') },
      active(),
      { key: 'opening', label: L('Opening reading', 'القراءة الافتتاحية'), type: 'number', min: 0, width: 13, help: L('New meters only: the reading at the end of last month.', 'للعدادات الجديدة فقط: القراءة في نهاية الشهر الماضي.') },
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM utl_meters WHERE code = ? AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|A meter with this code already exists.');
      if (row.unit && row.area && changed(ctx, row, 'area')) ctx.warn('area', 'imp3|A meter on a unit serves that unit; the common area is not used.');
      if (ctx.id && ctx.provided.has('opening')) ctx.warn('opening', 'imp3|The opening reading is only used for a new meter. Use Meter readings for the months.');
      if (!ctx.id && row.opening !== undefined && row.opening !== null && row.opening >= 10 ** (row.digits || 6)) ctx.error('opening', 'imp3|The reading has more digits than the meter.');
      if (ctx.current && row.utility !== ctx.current.utility && ctx.db.value('SELECT COUNT(*) FROM utl_readings WHERE meter_id = ?', ctx.id)) ctx.error('utility', 'imp3|This meter has readings: its utility cannot change.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const f = { code: row.code, utility: row.utility, unit_id: row.unit || null, area: row.area || null, serial: row.serial || null, multiplier: row.multiplier > 0 ? row.multiplier : 1, digits: row.digits || 6, active: row.active === false ? 0 : 1 };
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO utl_meters (code, utility, unit_id, area, serial, multiplier, digits, active, installed_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', f.code, f.utility, f.unit_id, f.area, f.serial, f.multiplier, f.digits, f.active, today(), now()).lastInsertRowid);
        if (row.opening !== undefined && row.opening !== null && U()) {
          const ym = today().slice(0, 7);
          const last = M.addMonths(`${ym}-01`, -1).slice(0, 7);
          U().saveReading(U().meterOf(id), last, row.opening, { user: ctx.user, note: 'Opening reading' });
        }
        ctx.log('Added meter', 'utilities', id, f.code);
        return id;
      }
      db.run('UPDATE utl_meters SET code = ?, utility = ?, unit_id = ?, area = ?, serial = ?, multiplier = ?, digits = ?, active = ? WHERE id = ?', f.code, f.utility, f.unit_id, f.area, f.serial, f.multiplier, f.digits, f.active, ctx.id);
      ctx.log('Updated meter', 'utilities', ctx.id, f.code);
      return ctx.id;
    },
    export: (db) => db.all('SELECT m.*, u.code unit_code FROM utl_meters m LEFT JOIN units u ON u.id = m.unit_id ORDER BY m.utility, m.code').map((m) => ({
      $id: m.id, code: m.code, utility: m.utility, unit: m.unit_code, area: m.area, serial: m.serial, multiplier: m.multiplier, digits: m.digits, active: !!m.active,
    })),
    // a meter and its opening reading are one record for undo
    snapshot: (db, id) => db.get('SELECT * FROM utl_meters WHERE id = ?', id),
    remove: (db, id) => { db.run('DELETE FROM utl_readings WHERE meter_id = ?', id); db.run('DELETE FROM utl_meters WHERE id = ?', id); },
    uses: (db, id, o) => {
      const out = imports.usesOf('utl_meters', id, { ...o, ignore: ['utl_readings'] });
      const n = db.value("SELECT COUNT(*) FROM utl_readings WHERE meter_id = ? AND COALESCE(note, '') != 'Opening reading'", id);
      if (n) out.push({ n, what: L('meter readings', 'قراءات عدادات') });
      return out;
    },
    link: (id) => `/admin/utilities/meters/${id}`,
    label: (v) => v.code || '',
    examples: [
      { code: 'E-G08', utility: 'electricity', unit: 'G08', serial: 'EL-552201', multiplier: 1, digits: 6, active: true, opening: 12450 },
      { code: 'CW-COMMON-1', utility: 'chilled', area: L('Food court', 'منطقة المطاعم'), multiplier: 1, digits: 7, active: true },
    ],
  });

  // ============================ utilities: monthly readings ============================
  const meterChoices = (db) => db.all('SELECT id, code FROM utl_meters ORDER BY code').map((m) => ({ id: m.id, name: m.code }));
  const recomputeAfter = (db, meterId, period) => {
    const u = U();
    if (!u) return;
    const next = db.get('SELECT period FROM utl_readings WHERE meter_id = ? AND period > ? ORDER BY period LIMIT 1', meterId, period);
    if (next && !db.get('SELECT id FROM utl_bills WHERE meter_id = ? AND period = ?', meterId, next.period)) u.compute(u.meterOf(meterId), next.period);
  };
  imports.register({
    key: 'utility-readings',
    module: '/admin/utilities',
    pages: ['/admin/utilities/readings'],
    area: 'operations',
    order: 51,
    icon: 'gauge',
    table: 'utl_readings',
    depends: ['utility-meters'],
    title: L('Meter readings', 'قراءات العدادات'),
    summary: L('The monthly reading of each meter: consumption, checks and billing follow from it.', 'القراءة الشهرية لكل عداد: الاستهلاك والمراجعة والفوترة تُبنى عليها.'),
    notes: L('One row per meter and month; the same meter and month again updates the reading. Unusual readings (lower than last month, a rollover, unusual use) wait for a manager to accept them. A billed month is locked.', 'صف لكل عداد وشهر؛ تكرار العداد والشهر يحدّث القراءة. القراءات غير المعتادة (أقل من الشهر الماضي، أو تجاوز العداد، أو استهلاك غير معتاد) تنتظر موافقة مدير. الشهر الذي صدرت فواتيره مقفل.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: [['meter', 'period']],
    columns: [
      { key: 'meter', label: L('Meter code', 'كود العداد'), type: 'ref', required: true, width: 14, ref: { list: meterChoices, dataset: 'utility-meters', what: L('Utility meters', 'عدادات المرافق') }, example: 'E-G08' },
      { key: 'period', label: L('Month', 'الشهر'), type: 'month', required: true, width: 12, example: '2026-10', help: L('The month the reading closes, e.g. 10/2026.', 'الشهر الذي تغلقه القراءة، مثل 10/2026.') },
      { key: 'reading', label: L('Reading', 'القراءة'), type: 'number', required: true, min: 0, width: 13, example: 13180 },
      { key: 'read_on', label: L('Read on', 'تاريخ القراءة'), type: 'date', width: 13 },
      { key: 'note', label: L('Note', 'ملاحظة'), type: 'text', max: 300, width: 24 },
    ],
    find(db, v) {
      const r = db.get('SELECT id FROM utl_readings WHERE meter_id = ? AND period = ?', v.meter, v.period);
      return r ? r.id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (row.period && row.period > today().slice(0, 7)) ctx.error('period', 'imp3|Readings cannot be entered for a future month.');
      const m = row.meter ? db.get('SELECT * FROM utl_meters WHERE id = ?', row.meter) : null;
      if (m && row.reading !== null && row.reading !== undefined && row.reading >= 10 ** m.digits) ctx.error('reading', 'imp3|The reading has more digits than the meter.');
      if (m && row.period && db.get('SELECT id FROM utl_bills WHERE meter_id = ? AND period = ?', m.id, row.period) && (!ctx.current || Number(ctx.current.reading) !== Number(row.reading))) ctx.error('reading', 'imp3|This month is billed, so its reading is locked.');
      if (m && !m.active && !ctx.id) ctx.warn('meter', 'imp3|This meter is not in use.');
      if (row.read_on && row.read_on > today()) ctx.error('read_on', 'imp3|The reading date cannot be in the future.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const u = U();
      const m = u.meterOf(row.meter);
      const old = db.get('SELECT * FROM utl_readings WHERE meter_id = ? AND period = ?', m.id, row.period);
      const r = u.saveReading(m, row.period, row.reading, { user: ctx.user, readOn: row.read_on || null, note: row.note || null });
      // the same reading with a different date or note: saveReading keeps it as it is
      if (old && Number(old.reading) === Number(row.reading)) db.run('UPDATE utl_readings SET read_on = COALESCE(?, read_on), note = ? WHERE id = ?', row.read_on || null, row.note || null, r.id);
      ctx.log('Recorded meter readings', 'utilities', null, `${row.period} · ${m.code}`);
      return r.id;
    },
    export: (db) => db.all('SELECT r.*, m.code FROM utl_readings r JOIN utl_meters m ON m.id = r.meter_id ORDER BY r.period DESC, m.code').map((r) => ({
      $id: r.id, meter: r.code, period: r.period, reading: r.reading, read_on: r.read_on, note: r.note,
    })),
    // undo puts the reading back (or removes it) and works out the next month again
    restore: (db, snap) => {
      db.run('UPDATE utl_readings SET reading = ?, read_on = ?, consumption = ?, flag = ?, accepted = ?, note = ?, user_id = ? WHERE id = ?', snap.reading, snap.read_on, snap.consumption, snap.flag, snap.accepted, snap.note, snap.user_id, snap.id);
      recomputeAfter(db, snap.meter_id, snap.period);
    },
    remove: (db, id) => {
      const r = db.get('SELECT * FROM utl_readings WHERE id = ?', id);
      if (!r) return;
      db.run('DELETE FROM utl_readings WHERE id = ?', id);
      recomputeAfter(db, r.meter_id, r.period);
    },
    uses: (db, id) => {
      const r = db.get('SELECT * FROM utl_readings WHERE id = ?', id);
      const n = r ? db.value('SELECT COUNT(*) FROM utl_bills WHERE meter_id = ? AND period = ?', r.meter_id, r.period) : 0;
      return n ? [{ n, what: L('utility invoices', 'فواتير مرافق') }] : [];
    },
    link: (id) => `/admin/utilities/readings`,
    label: (v, names) => `${names.meter || ''}${v.period ? ` · ${v.period}` : ''}`,
    examples: [
      { meter: 'E-G08', period: '2026-10', reading: 13180, read_on: '2026-10-31' },
      { meter: 'E-G08', period: '2026-11', reading: 13902, read_on: '2026-11-30', note: L('Read with the tenant', 'قُرئت بحضور المستأجر') },
    ],
  });

  // ============================ energy meters (the building's sub-meters) ============================
  imports.register({
    key: 'energy-meters',
    module: '/admin/energy',
    pages: ['/admin/energy/meters'],
    area: 'operations',
    order: 55,
    icon: 'plug',
    table: 'nrg_meters',
    title: L('Energy meters', 'عدادات الطاقة'),
    summary: L('The building’s own sub-meters (cooling, lighting, lifts, car park…) read by the building system or a CSV.', 'العدادات الفرعية للمبنى (التبريد والإضاءة والمصاعد والجراج…) التي يقرؤها نظام المبنى أو ملف CSV.'),
    notes: L('The code is the one the building system sends with each reading. Readings themselves come from Energy → Import.', 'الكود هو ما يرسله نظام المبنى مع كل قراءة. القراءات نفسها تأتي من الطاقة ← الاستيراد.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Meter code', 'كود العداد'), type: 'text', required: true, max: 30, width: 16, example: 'MDB-HVAC-1', transform: (v) => {
        const code = String(v).toUpperCase().trim().replace(/\s+/g, '-');
        return /^[A-Z0-9][A-Z0-9._-]*$/.test(code) ? { value: code } : { error: 'imp3|A meter code has letters, digits and dashes only.' };
      } },
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', required: true, max: 120, width: 28, example: 'Chillers, main board' },
      { key: 'utility', label: L('Utility', 'المرفق'), type: 'enum', enum: opts(NRG.UTILITIES), width: 14, keepOnUpdate: true, help: L('Empty means Electricity. It cannot change later.', 'الفارغ يعني «كهرباء». لا يمكن تغييره لاحقًا.') },
      { key: 'system', label: L('System', 'النظام'), type: 'enum', enum: opts(NRG.SYSTEMS), width: 22, example: 'hvac', help: L('Empty means Other.', 'الفارغ يعني «أخرى».') },
      active(),
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM nrg_meters WHERE code = ? AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|A meter with this code already exists.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO nrg_meters (code, name, utility, system, active, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', row.code, row.name, row.utility || 'electricity', row.system || 'other', row.active === false ? 0 : 1, (db.value('SELECT MAX(sort) FROM nrg_meters') || 0) + 1, now()).lastInsertRowid);
        ctx.log('Added an energy meter', 'nrg_meter', id, row.code);
        return id;
      }
      db.run('UPDATE nrg_meters SET code = ?, name = ?, system = ?, active = ? WHERE id = ?', row.code, row.name, row.system || 'other', row.active === false ? 0 : 1, ctx.id);
      ctx.log('Changed an energy meter', 'nrg_meter', ctx.id, row.code);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM nrg_meters ORDER BY sort, code').map((m) => ({ $id: m.id, code: m.code, name: m.name, utility: m.utility, system: m.system, active: !!m.active })),
    uses: (db, id, o) => imports.usesOf('nrg_meters', id, o),
    link: () => '/admin/energy/meters',
    label: (v) => (v.code ? `${v.code}${v.name ? ` · ${v.name}` : ''}` : ''),
    examples: [
      { code: 'MDB-HVAC-1', name: L('Chillers, main board', 'المبردات، اللوحة الرئيسية'), utility: 'electricity', system: 'hvac', active: true },
      { code: 'MDB-LIGHT-1', name: L('Mall lighting', 'إضاءة المول'), utility: 'electricity', system: 'lighting', active: true },
    ],
  });

  // ============================ security: patrol checkpoints, cleaning areas, keys ============================
  imports.register({
    key: 'patrol-checkpoints',
    module: '/admin/security',
    pages: ['/admin/security/patrols'],
    area: 'operations',
    order: 60,
    icon: 'shield',
    table: 'sec_checkpoints',
    title: L('Patrol checkpoints', 'نقاط التفتيش'),
    summary: L('The places guards scan on their rounds. Each new checkpoint gets its own QR sticker.', 'الأماكن التي يمسحها الحراس في جولاتهم. لكل نقطة جديدة ملصق رمز استجابة خاص بها.'),
    notes: L('Print the QR stickers from Patrols after the import. Routes (which checkpoints, how often) are set on the Patrols page.', 'اطبع ملصقات الرموز من صفحة الجولات بعد الاستيراد. المسارات (أي النقاط وكل كم) تُضبط من صفحة الجولات.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Code', 'الكود'), type: 'code', required: true, max: 20, width: 12, example: 'CP-07' },
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', required: true, max: 120, width: 26, example: 'Loading bay gate' },
      { key: 'place', label: L('Floor or zone', 'الدور أو المنطقة'), type: 'text', max: 120, width: 20, example: 'B1' },
      active(),
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM sec_checkpoints WHERE code = ? COLLATE NOCASE AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|This code is already used.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO sec_checkpoints (code, name, place, token, active, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', row.code, row.name, row.place || null, token(), row.active === false ? 0 : 1, db.value('SELECT COALESCE(MAX(sort), 0) + 1 FROM sec_checkpoints'), now()).lastInsertRowid);
        ctx.log('Added a patrol checkpoint', 'sec_checkpoint', id, `${row.code} · ${row.name}`);
        return id;
      }
      db.run('UPDATE sec_checkpoints SET code = ?, name = ?, place = ?, active = ? WHERE id = ?', row.code, row.name, row.place || null, row.active === false ? 0 : 1, ctx.id);
      ctx.log('Changed a patrol checkpoint', 'sec_checkpoint', ctx.id, `${row.code} · ${row.name}`);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM sec_checkpoints ORDER BY sort, code').map((c) => ({ $id: c.id, code: c.code, name: c.name, place: c.place, active: !!c.active })),
    uses: (db, id, o) => {
      const out = imports.usesOf('sec_checkpoints', id, o);
      // routes list their checkpoints as ids inside a text column
      const n = db.all('SELECT checkpoints FROM sec_routes').filter((r) => String(r.checkpoints || '').split(/[^0-9]+/).map(Number).includes(id)).length;
      if (n) out.push({ n, what: L('patrol routes', 'مسارات جولات') });
      return out;
    },
    link: () => '/admin/security/patrols',
    label: (v) => (v.code ? `${v.code}${v.name ? ` · ${v.name}` : ''}` : ''),
    examples: [
      { code: 'CP-07', name: L('Loading bay gate', 'بوابة منطقة التحميل'), place: 'B1', active: true },
      { code: 'CP-08', name: L('Roof plant room', 'غرفة معدات السطح'), place: L('Roof', 'السطح'), active: true },
    ],
  });

  const toEnd = (v) => (v === '23:59' ? '24:00' : v);
  imports.register({
    key: 'cleaning-areas',
    module: '/admin/security',
    pages: ['/admin/security/cleaning'],
    area: 'operations',
    order: 61,
    icon: 'check',
    table: 'sec_clean_areas',
    title: L('Cleaning areas', 'مناطق النظافة'),
    summary: L('Toilets, food court, entrances… with how often they are cleaned. Each new area gets its own QR sticker.', 'دورات المياه ومنطقة المطاعم والمداخل… وكل كم تُنظف. لكل منطقة جديدة ملصق رمز استجابة خاص بها.'),
    notes: L('“To” 23:59 means until closing (midnight).', '«إلى» 23:59 تعني حتى الإغلاق (منتصف الليل).'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Code', 'الكود'), type: 'code', required: true, max: 20, width: 12, example: 'WC-G1' },
      { key: 'name', label: L('Area', 'المنطقة'), type: 'text', required: true, max: 120, width: 26, example: 'Ground floor toilets, north' },
      { key: 'kind', label: L('Kind', 'النوع'), type: 'enum', enum: opts(SEC.AREA_KINDS), width: 18, help: L('Empty means Other.', 'الفارغ يعني «أخرى».') },
      { key: 'place', label: L('Floor or zone', 'الدور أو المنطقة'), type: 'text', max: 120, width: 18 },
      { key: 'every_min', label: L('Clean every (minutes)', 'التنظيف كل (دقيقة)'), type: 'int', min: 10, maxValue: 1440, width: 13, example: 60, help: L('Empty means 60.', 'الفارغ يعني ٦٠.') },
      { key: 'start_hm', label: L('From', 'من'), type: 'time', width: 9, example: '10:00', help: L('Empty means 10:00.', 'الفارغ يعني 10:00.') },
      { key: 'end_hm', label: L('To', 'إلى'), type: 'time', width: 9, example: '23:59', help: L('Empty means until closing.', 'الفارغ يعني حتى الإغلاق.') },
      active(),
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM sec_clean_areas WHERE code = ? COLLATE NOCASE AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|This code is already used.');
      if (row.start_hm && row.end_hm && toEnd(row.end_hm) <= row.start_hm) ctx.error('end_hm', 'imp3|The end is before the start.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const v = { name: row.name, kind: row.kind || 'other', place: row.place || null, every: row.every_min || 60, start: row.start_hm || '10:00', end: toEnd(row.end_hm || '24:00'), active: row.active === false ? 0 : 1 };
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO sec_clean_areas (code, name, place, kind, every_min, start_hm, end_hm, token, active, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.code, v.name, v.place, v.kind, v.every, v.start, v.end, token(), v.active, db.value('SELECT COALESCE(MAX(sort), 0) + 1 FROM sec_clean_areas'), now()).lastInsertRowid);
        ctx.log('Added a cleaning area', 'sec_clean_area', id, `${row.code} · ${v.name}`);
        return id;
      }
      db.run('UPDATE sec_clean_areas SET code = ?, name = ?, kind = ?, place = ?, every_min = ?, start_hm = ?, end_hm = ?, active = ? WHERE id = ?', row.code, v.name, v.kind, v.place, v.every, v.start, v.end, v.active, ctx.id);
      ctx.log('Changed a cleaning area', 'sec_clean_area', ctx.id, v.name);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM sec_clean_areas ORDER BY sort, code').map((a) => ({
      $id: a.id, code: a.code, name: a.name, kind: a.kind, place: a.place, every_min: a.every_min, start_hm: a.start_hm, end_hm: a.end_hm === '24:00' ? '23:59' : a.end_hm, active: !!a.active,
    })),
    uses: (db, id, o) => imports.usesOf('sec_clean_areas', id, o),
    link: (id) => `/admin/security/cleaning/areas/${id}`,
    label: (v) => (v.code ? `${v.code}${v.name ? ` · ${v.name}` : ''}` : ''),
    examples: [
      { code: 'WC-G1', name: L('Ground floor toilets, north', 'دورات مياه الدور الأرضي، الشمال'), kind: 'toilets', place: 'G', every_min: 45, start_hm: '10:00', end_hm: '23:59', active: true },
      { code: 'FC-1', name: L('Food court seating', 'جلسات منطقة المطاعم'), kind: 'food_court', place: '1', every_min: 30, start_hm: '12:00', end_hm: '23:59', active: true },
    ],
  });

  imports.register({
    key: 'keys-register',
    module: '/admin/security',
    pages: ['/admin/security/keys'],
    area: 'operations',
    order: 62,
    icon: 'shield',
    table: 'sec_keys',
    title: L('Key register', 'سجل المفاتيح'),
    summary: L('Every key, master key and access card in the cabinet: what it opens and how many copies.', 'كل مفتاح ومفتاح رئيسي وبطاقة دخول في الخزانة: ماذا يفتح وكم نسخة.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['code'],
    columns: [
      { key: 'code', label: L('Code', 'الكود'), type: 'code', required: true, max: 20, width: 12, example: 'K-114' },
      { key: 'kind', label: L('Kind', 'النوع'), type: 'enum', enum: opts(SEC.K_KINDS), width: 14, help: L('Empty means Key.', 'الفارغ يعني «مفتاح».') },
      { key: 'opens', label: L('Opens', 'يفتح'), type: 'text', required: true, max: 160, width: 28, example: 'Electrical room B1' },
      { key: 'place', label: L('Floor or zone', 'الدور أو المنطقة'), type: 'text', max: 120, width: 16 },
      { key: 'copies', label: L('Copies', 'النسخ'), type: 'int', min: 1, maxValue: 50, width: 9, help: L('Empty means 1.', 'الفارغ يعني ١.') },
      { key: 'kept_at', label: L('Kept at', 'مكان الحفظ'), type: 'text', max: 120, width: 18, example: 'Security office cabinet' },
      active(),
    ],
    rowCheck(row, ctx) {
      if (ctx.db.get('SELECT id FROM sec_keys WHERE code = ? COLLATE NOCASE AND id != ?', row.code, ctx.id || 0)) ctx.error('code', 'imp3|This code is already used.');
      if (ctx.id) {
        const out = ctx.db.value('SELECT COUNT(*) FROM sec_key_loans WHERE key_id = ? AND returned_at IS NULL', ctx.id);
        if ((row.copies || 1) < out) ctx.error('copies', 'imp3|{n} copies are out right now: fewer copies is not possible until they come back.', { n: out });
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const v = { kind: row.kind || 'key', opens: row.opens, place: row.place || null, copies: row.copies || 1, kept_at: row.kept_at || null, active: row.active === false ? 0 : 1 };
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO sec_keys (code, kind, opens, place, copies, kept_at, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.code, v.kind, v.opens, v.place, v.copies, v.kept_at, v.active, now()).lastInsertRowid);
        ctx.log('Registered a key', 'sec_key', id, `${row.code} · ${v.opens}`);
        return id;
      }
      db.run('UPDATE sec_keys SET code = ?, kind = ?, opens = ?, place = ?, copies = ?, kept_at = ?, active = ? WHERE id = ?', row.code, v.kind, v.opens, v.place, v.copies, v.kept_at, v.active, ctx.id);
      ctx.log('Changed a key', 'sec_key', ctx.id, `${row.code} · ${v.opens}`);
      return ctx.id;
    },
    export: (db) => db.all('SELECT * FROM sec_keys ORDER BY code').map((k) => ({ $id: k.id, code: k.code, kind: k.kind, opens: k.opens, place: k.place, copies: k.copies, kept_at: k.kept_at, active: !!k.active })),
    uses: (db, id, o) => imports.usesOf('sec_keys', id, o),
    link: (id) => `/admin/security/keys/${id}`,
    label: (v) => (v.code ? `${v.code}${v.opens ? ` · ${v.opens}` : ''}` : ''),
    examples: [
      { code: 'K-114', kind: 'key', opens: L('Electrical room B1', 'غرفة الكهرباء B1'), place: 'B1', copies: 2, kept_at: L('Security office cabinet', 'خزانة مكتب الأمن'), active: true },
      { code: 'MK-01', kind: 'master', opens: L('All service corridors', 'كل ممرات الخدمة'), copies: 1, kept_at: L('Mall manager', 'مدير المول'), active: true },
    ],
  });

  // ============================ website: store listings, events, promotions ============================
  const slugOk = (v) => { const s = WEB.slugify(v); return s ? { value: s } : { error: 'imp3|A web address has letters, digits and dashes.' }; };
  const urlOk = (v) => { const u = WEB.cleanUrl(v); return u === null ? { error: 'imp3|Enter a full website address (https://…).' } : { value: u || null }; };
  const uniqueSlug = (db, table, base, id = 0) => {
    const root = base || `${table === 'web_stores' ? 'store' : 'event'}-${Date.now().toString(36)}`;
    let slug = root;
    for (let i = 2; db.get(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`, slug, id); i++) slug = `${root}-${i}`;
    return slug;
  };
  const leased = (db, brandId) => !!db.value("SELECT COUNT(*) FROM leases WHERE brand_id = ? AND status IN ('active','draft')", brandId);
  const CATS = () => Object.keys(M.CATEGORIES).map((k) => [k, { en: i18n.run('en', () => M.CATEGORIES[k]), ar: i18n.run('ar', () => M.CATEGORIES[k]) }]);
  imports.register({
    key: 'website-stores',
    module: '/admin/website',
    pages: ['/admin/website'],
    area: 'other',
    order: 30,
    icon: 'globe',
    table: 'web_stores',
    depends: ['brands'],
    title: L('Website store listings', 'صفحات المحلات على الموقع'),
    summary: L('Each tenant’s page on the website: names, short lines and descriptions in both languages, hours and links.', 'صفحة كل مستأجر على الموقع: الأسماء والسطر القصير والوصف باللغتين ومواعيد العمل والروابط.'),
    notes: L('Only tenants with a lease can be listed. Logos and covers are added on the listing’s page, and publishing stays there too.', 'لا تُدرج إلا العلامات التي لها عقد. يُضاف الشعار والغلاف من صفحة المحل، والنشر يتم من هناك أيضًا.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: ['brand'],
    columns: [
      { key: 'brand', label: L('Tenant (brand)', 'المستأجر (العلامة)'), type: 'ref', required: true, width: 22, ref: brandsRef, example: 'Maison Lune' },
      { key: 'name', label: L('Name (English)', 'الاسم (بالإنجليزية)'), type: 'text', max: 120, width: 22, help: L('Empty: the brand’s name.', 'الفارغ: اسم العلامة.') },
      { key: 'name_ar', label: L('Name (Arabic)', 'الاسم (بالعربية)'), type: 'text', max: 120, width: 22 },
      { key: 'tagline', label: L('Short line (English)', 'سطر قصير (بالإنجليزية)'), type: 'text', max: 160, width: 30 },
      { key: 'tagline_ar', label: L('Short line (Arabic)', 'سطر قصير (بالعربية)'), type: 'text', max: 160, width: 30 },
      { key: 'description', label: L('Description (English)', 'الوصف (بالإنجليزية)'), type: 'text', max: 3000, multiline: true, width: 40 },
      { key: 'description_ar', label: L('Description (Arabic)', 'الوصف (بالعربية)'), type: 'text', max: 3000, multiline: true, width: 40 },
      { key: 'category', label: L('Category', 'الفئة'), type: 'enum', enum: CATS, width: 22, help: L('Empty: the brand’s category.', 'الفارغ: فئة العلامة.') },
      { key: 'slug', label: L('Web address', 'عنوان الصفحة'), type: 'text', max: 80, width: 20, transform: slugOk, help: L('…/stores/this-part/. Empty: made from the name.', 'الجزء الأخير من رابط صفحة المحل. الفارغ: يُصنع من الاسم.') },
      { key: 'hours', label: L('Opening hours', 'مواعيد العمل'), type: 'text', max: 80, width: 16, help: L('Empty: the tenant file’s.', 'الفارغ: من ملف المستأجر.') },
      { key: 'phone', label: L('Phone', 'الهاتف'), type: 'text', max: 40, width: 16 },
      { key: 'instagram', label: L('Instagram', 'إنستجرام'), type: 'text', max: 60, width: 16, transform: (v) => { const x = WEB.cleanHandle(v); return x === null ? { error: 'imp3|Enter the Instagram handle, like @thewavemall.' } : { value: x || null }; } },
      { key: 'website', label: L('Website', 'الموقع الإلكتروني'), type: 'text', max: 200, width: 24, transform: urlOk },
      { key: 'opening_soon', label: L('Opening soon', 'يفتتح قريبًا'), type: 'bool', width: 12 },
      { key: 'featured', label: L('Featured', 'مميز'), type: 'bool', width: 10 },
    ],
    find(db, v) {
      const r = db.get('SELECT id FROM web_stores WHERE brand_id = ?', v.brand);
      return r ? r.id : null;
    },
    rowCheck(row, ctx) {
      if (!ctx.id && row.brand && !leased(ctx.db, row.brand)) ctx.error('brand', 'imp3|Only tenants with a lease can be listed.');
      if (row.slug && ctx.db.get('SELECT id FROM web_stores WHERE slug = ? AND id != ?', row.slug, ctx.id || 0)) ctx.error('slug', 'imp3|Another store already uses that web address.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      let id = ctx.id;
      if (!id) {
        id = h.website.createStore(row.brand, { user: ctx.user });
        if (!id) throw new Error('imp3|Only tenants with a lease can be listed.');
      }
      const s = db.get('SELECT * FROM web_stores WHERE id = ?', id);
      const name = row.name || s.name;
      const slug = row.slug || s.slug || uniqueSlug(db, 'web_stores', WEB.slugify(name));
      db.run(`UPDATE web_stores SET name = ?, name_ar = ?, tagline = ?, tagline_ar = ?, description = ?, description_ar = ?, category = ?, slug = ?, hours = ?, phone = ?,
        instagram = ?, website = ?, opening_soon = ?, featured = ?, updated_at = ? WHERE id = ?`,
      name, row.name_ar || null, row.tagline || null, row.tagline_ar || null, row.description || null, row.description_ar || null, row.category || s.category, slug,
      row.hours || null, row.phone || null, row.instagram || null, row.website || null, row.opening_soon === undefined || row.opening_soon === null ? s.opening_soon : row.opening_soon ? 1 : 0,
      row.featured ? 1 : 0, now(), id);
      ctx.log('Updated a website listing', 'web_store', id, name);
      return id;
    },
    export: (db) => db.all('SELECT s.*, b.name brand_name FROM web_stores s JOIN brands b ON b.id = s.brand_id ORDER BY s.name').map((s) => ({
      $id: s.id, brand: s.brand_name, name: s.name, name_ar: s.name_ar, tagline: s.tagline, tagline_ar: s.tagline_ar, description: s.description, description_ar: s.description_ar,
      category: s.category, slug: s.slug, hours: s.hours, phone: s.phone, instagram: s.instagram, website: s.website, opening_soon: !!s.opening_soon, featured: !!s.featured,
    })),
    uses: (db, id, o) => imports.usesOf('web_stores', id, o),
    link: (id) => `/admin/website/stores/${id}`,
    label: (v, names) => names.brand || v.name || '',
    examples: [
      { brand: 'Maison Lune', name_ar: 'ميزون لون', tagline: 'Parisian ready-to-wear, made for Cairo evenings', tagline_ar: 'أزياء باريسية جاهزة لأمسيات القاهرة', hours: '10:00–24:00', instagram: '@maisonlune', website: 'https://maisonlune.com', featured: true },
    ],
  });

  imports.register({
    key: 'website-events',
    module: '/admin/website',
    pages: ['/admin/website'],
    area: 'other',
    order: 31,
    icon: 'cal',
    table: 'web_events',
    title: L('Website events', 'فعاليات الموقع'),
    summary: L('What’s on at the mall: concerts, markets, launches, with dates, place and booking link.', 'ما يحدث في المول: حفلات وأسواق وإطلاقات بمواعيدها ومكانها ورابط الحجز.'),
    notes: L('An event is found again by its web address, or by its title and first day. Covers and publishing stay on the event’s page.', 'تُعرف الفعالية بعنوان صفحتها، أو بعنوانها وأول يوم لها. الغلاف والنشر من صفحة الفعالية.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: ['slug', ['title', 'starts_on']],
    columns: [
      { key: 'title', label: L('Title (English)', 'العنوان (بالإنجليزية)'), type: 'text', required: true, max: 160, width: 28, example: 'Winter night market' },
      { key: 'title_ar', label: L('Title (Arabic)', 'العنوان (بالعربية)'), type: 'text', max: 160, width: 28, example: 'سوق ليالي الشتاء' },
      { key: 'starts_on', label: L('First day', 'أول يوم'), type: 'date', required: true, width: 13, example: '2026-12-18' },
      { key: 'ends_on', label: L('Last day', 'آخر يوم'), type: 'date', width: 13 },
      { key: 'time_from', label: L('From', 'من'), type: 'time', width: 9 },
      { key: 'time_to', label: L('Until', 'حتى'), type: 'time', width: 9 },
      { key: 'location', label: L('Place (English)', 'المكان (بالإنجليزية)'), type: 'text', max: 120, width: 20 },
      { key: 'location_ar', label: L('Place (Arabic)', 'المكان (بالعربية)'), type: 'text', max: 120, width: 20 },
      { key: 'summary', label: L('Short line (English)', 'سطر قصير (بالإنجليزية)'), type: 'text', max: 240, width: 30 },
      { key: 'summary_ar', label: L('Short line (Arabic)', 'سطر قصير (بالعربية)'), type: 'text', max: 240, width: 30 },
      { key: 'description', label: L('Description (English)', 'الوصف (بالإنجليزية)'), type: 'text', max: 4000, multiline: true, width: 40 },
      { key: 'description_ar', label: L('Description (Arabic)', 'الوصف (بالعربية)'), type: 'text', max: 4000, multiline: true, width: 40 },
      { key: 'rsvp_url', label: L('Booking link', 'رابط الحجز'), type: 'text', max: 300, width: 24, transform: urlOk },
      { key: 'slug', label: L('Web address', 'عنوان الصفحة'), type: 'text', max: 80, width: 20, transform: slugOk, help: L('Empty: made from the title.', 'الفارغ: يُصنع من العنوان.') },
      { key: 'featured', label: L('Featured', 'مميز'), type: 'bool', width: 10 },
    ],
    find(db, v, key) {
      if (key === 'slug') { const r = db.get('SELECT id FROM web_events WHERE slug = ?', v.slug); return r ? r.id : null; }
      const hits = db.all('SELECT id FROM web_events WHERE lower(trim(title)) = lower(trim(?)) AND starts_on = ?', v.title, v.starts_on);
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (row.ends_on && row.starts_on && row.ends_on < row.starts_on) ctx.error('ends_on', 'imp3|The last day cannot be before the first.');
      if (row.slug && ctx.db.get('SELECT id FROM web_events WHERE slug = ? AND id != ?', row.slug, ctx.id || 0)) ctx.error('slug', 'imp3|Another event already uses that web address.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      let id = ctx.id;
      if (!id) {
        id = Number(db.run('INSERT INTO web_events (slug, title, starts_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', row.slug || uniqueSlug(db, 'web_events', WEB.slugify(row.title)), row.title, row.starts_on, now(), now()).lastInsertRowid);
        ctx.log('Created a website event', 'web_event', id, row.title);
      } else ctx.log('Updated a website event', 'web_event', id, row.title);
      const slug = row.slug || db.value('SELECT slug FROM web_events WHERE id = ?', id);
      db.run(`UPDATE web_events SET title = ?, title_ar = ?, summary = ?, summary_ar = ?, description = ?, description_ar = ?, starts_on = ?, ends_on = ?, time_from = ?, time_to = ?,
        location = ?, location_ar = ?, rsvp_url = ?, slug = ?, featured = ?, updated_at = ? WHERE id = ?`,
      row.title, row.title_ar || null, row.summary || null, row.summary_ar || null, row.description || null, row.description_ar || null, row.starts_on, row.ends_on || null,
      row.time_from || null, row.time_to || null, row.location || null, row.location_ar || null, row.rsvp_url || null, slug, row.featured ? 1 : 0, now(), id);
      return id;
    },
    export: (db) => db.all('SELECT * FROM web_events ORDER BY starts_on DESC').map((e) => ({
      $id: e.id, title: e.title, title_ar: e.title_ar, starts_on: e.starts_on, ends_on: e.ends_on, time_from: e.time_from, time_to: e.time_to, location: e.location, location_ar: e.location_ar,
      summary: e.summary, summary_ar: e.summary_ar, description: e.description, description_ar: e.description_ar, rsvp_url: e.rsvp_url, slug: e.slug, featured: !!e.featured,
    })),
    uses: (db, id, o) => imports.usesOf('web_events', id, o),
    link: (id) => `/admin/website/events/${id}`,
    label: (v) => v.title || '',
    examples: [
      { title: 'Winter night market', title_ar: 'سوق ليالي الشتاء', starts_on: '2026-12-18', ends_on: '2026-12-20', time_from: '17:00', time_to: '23:00', location: 'The open court', location_ar: 'الساحة المفتوحة', featured: true },
    ],
  });

  imports.register({
    key: 'website-promotions',
    module: '/admin/website',
    pages: ['/admin/website'],
    area: 'other',
    order: 32,
    icon: 'percent',
    table: 'web_promos',
    depends: ['brands'],
    title: L('Website promotions', 'عروض الموقع'),
    summary: L('Offers shown on the directory and on each store’s page while they run.', 'العروض التي تظهر في الدليل وفي صفحة كل محل أثناء سريانها.'),
    notes: L('A promotion is found again by its title and first day. Images and publishing stay on its page.', 'يُعرف العرض بعنوانه وأول يوم له. الصور والنشر من صفحته.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: [['title', 'starts_on']],
    columns: [
      { key: 'title', label: L('Title (English)', 'العنوان (بالإنجليزية)'), type: 'text', required: true, max: 160, width: 28, example: 'White Friday: 30% off' },
      { key: 'title_ar', label: L('Title (Arabic)', 'العنوان (بالعربية)'), type: 'text', max: 160, width: 28 },
      { key: 'brand', label: L('Store', 'المحل'), type: 'ref', width: 22, ref: brandsRef, help: L('Empty: a mall-wide promotion.', 'الفارغ: عرض على مستوى المول.') },
      { key: 'starts_on', label: L('From', 'من'), type: 'date', required: true, width: 13, example: '2026-11-26' },
      { key: 'ends_on', label: L('Until', 'حتى'), type: 'date', required: true, width: 13, example: '2026-11-30' },
      { key: 'details', label: L('Details (English)', 'التفاصيل (بالإنجليزية)'), type: 'text', max: 1000, multiline: true, width: 36 },
      { key: 'details_ar', label: L('Details (Arabic)', 'التفاصيل (بالعربية)'), type: 'text', max: 1000, multiline: true, width: 36 },
      { key: 'link', label: L('Link', 'الرابط'), type: 'text', max: 300, width: 24, transform: urlOk },
    ],
    find(db, v) {
      const hits = db.all('SELECT id FROM web_promos WHERE lower(trim(title)) = lower(trim(?)) AND starts_on = ?', v.title, v.starts_on);
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      if (row.ends_on && row.starts_on && row.ends_on < row.starts_on) ctx.error('ends_on', 'imp3|The end is before the start.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      if (!ctx.id) {
        const id = Number(db.run('INSERT INTO web_promos (brand_id, title, title_ar, details, details_ar, starts_on, ends_on, link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          row.brand || null, row.title, row.title_ar || null, row.details || null, row.details_ar || null, row.starts_on, row.ends_on, row.link || null, now(), now()).lastInsertRowid);
        ctx.log('Created a website promotion', 'web_promo', id, row.title);
        return id;
      }
      db.run('UPDATE web_promos SET title = ?, title_ar = ?, details = ?, details_ar = ?, brand_id = ?, starts_on = ?, ends_on = ?, link = ?, updated_at = ? WHERE id = ?',
        row.title, row.title_ar || null, row.details || null, row.details_ar || null, row.brand || null, row.starts_on, row.ends_on, row.link || null, now(), ctx.id);
      ctx.log('Updated a website promotion', 'web_promo', ctx.id, row.title);
      return ctx.id;
    },
    export: (db) => db.all('SELECT p.*, b.name brand_name FROM web_promos p LEFT JOIN brands b ON b.id = p.brand_id ORDER BY p.starts_on DESC').map((p) => ({
      $id: p.id, title: p.title, title_ar: p.title_ar, brand: p.brand_name, starts_on: p.starts_on, ends_on: p.ends_on, details: p.details, details_ar: p.details_ar, link: p.link,
    })),
    uses: (db, id, o) => imports.usesOf('web_promos', id, o),
    link: (id) => `/admin/website/promos/${id}`,
    label: (v) => v.title || '',
    examples: [
      { title: 'White Friday: 30% off', title_ar: 'الجمعة البيضاء: خصم ٣٠٪', brand: 'Maison Lune', starts_on: '2026-11-26', ends_on: '2026-11-30', details: 'On the autumn collection.', details_ar: 'على مجموعة الخريف.' },
    ],
  });
};
