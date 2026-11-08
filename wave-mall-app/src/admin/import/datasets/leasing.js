'use strict';

// Leasing from Excel: tenant contacts (and their portal accounts), leads, leases (the contracts, with
// every term the lease form has) and service contracts. Each saves what the module's own form saves,
// with the same rules (routes/property.js, routes/sales.js, routes/deals.js, routes/records.js,
// routes/portal.js), so an imported record reads like one typed in.
//
// Leases at go-live: a lease imported as Active is activated the way the Activate button does it
// (its units become leased, its rent invoices are created from the rent schedule), except that rent
// periods starting before "Invoice rent from" (today when empty) are not invoiced: they belong to the
// old system, and what is still unpaid from them comes in through Opening balances. The deposit and
// key money already received are not billed again; a deposit received is kept as a paid deposit
// invoice so the end-of-lease settlement knows what is held. Past leases (Ended, Terminated) are kept
// as history: no invoices, and their units are not touched.

const i18n = require('../../i18n');
const TM = require('../../terms');
const records = require('../../routes/records');

const L = (en, ar) => ({ en, ar });
const lab = (key) => ({ en: i18n.english(key), ar: typeof i18n.AR[key] === 'string' ? i18n.AR[key] : i18n.english(key) });
const opts = (map) => Object.entries(map).map(([k, key]) => [k, lab(key)]);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const blank = (x) => x === null || x === undefined || x === '';
// the same value, the way the import compares them
function same(a, b) {
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify([].concat(a).map(String)) === JSON.stringify([].concat(b).map(String));
  if (!Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && String(a).trim() !== '' && String(b).trim() !== '') return Math.abs(Number(a) - Number(b)) < 1e-9;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

module.exports = function leasingDatasets(imports, h) {
  const { M } = h;
  const now = () => M.now();
  const today = () => M.today();
  const asReq = (ctx) => ({ user: ctx.user, ip: null });
  const brandChoices = (db) => db.all('SELECT id, name FROM brands ORDER BY name').map((b) => ({ id: b.id, name: b.name }));
  const unitChoices = (db) => db.all("SELECT id, code FROM units WHERE status != 'retired' ORDER BY sort, code").map((u) => ({ id: u.id, name: u.code }));
  const userChoices = (db) => db.all('SELECT id, email, name FROM users WHERE active = 1 ORDER BY name').map((u) => ({ id: u.id, name: u.email, alt: [u.name] }));
  const brandRef = { list: brandChoices, dataset: 'brands', what: L('Brands', 'العلامات التجارية') };
  // a reference the office gives itself (LS-2026-004): a new row may not invent one, or the next number collides
  const systemRef = (prefix) => new RegExp(`^${prefix}-\\d{4}(-\\d+)?$`, 'i');

  // ======================================================================== tenant contacts
  imports.register({
    key: 'tenant-contacts',
    module: '/admin/brands',
    pages: ['/admin/tenants'],
    area: 'property',
    order: 30,
    depends: ['brands'],
    icon: 'people',
    table: 'contacts',
    title: L('Tenant contacts', 'جهات اتصال المستأجرين'),
    summary: L('The people at each brand: managers, accounts, store staff — and who gets a tenant-portal account.', 'الأشخاص لدى كل علامة: المديرون والحسابات وفريق المحل، ومن يحصل على حساب في بوابة المستأجرين.'),
    notes: L('One row per person. A row with the same brand and email (or the same brand and name) updates that person. “Portal account: Yes” opens a tenant-portal account without a password and sends no email; send the invitation later from the Tenant portal page.', 'صف لكل شخص. الصف الذي يحمل العلامة والبريد نفسيهما (أو العلامة والاسم) يحدّث بيانات الشخص نفسه. «حساب في البوابة: نعم» يفتح حسابًا في بوابة المستأجرين بلا كلمة مرور ولا يرسل أي رسالة؛ أرسل الدعوة لاحقًا من صفحة بوابة المستأجرين.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: [['brand', 'email'], ['brand', 'name']],
    columns: [
      { key: 'brand', label: L('Brand', 'العلامة التجارية'), type: 'ref', required: true, width: 24, ref: brandRef, example: 'Maison Lune', aliases: ['tenant', 'company', 'المستأجر', 'الشركة'], help: L('Pick from the list. Import Brands first.', 'اختر من القائمة. استورد العلامات التجارية أولًا.') },
      { key: 'name', label: L('Name', 'الاسم'), type: 'text', required: true, max: 120, width: 22, example: 'Laila Hamdy', aliases: ['contact', 'contact name', 'full name', 'اسم المسؤول', 'جهة الاتصال'] },
      { key: 'title', label: L('Job title', 'المسمى الوظيفي'), type: 'text', max: 120, width: 20, example: 'Expansion manager', aliases: ['position', 'role', 'الوظيفة'] },
      { key: 'email', label: L('Email', 'البريد الإلكتروني'), type: 'email', width: 26, example: 'laila@maisonlune.com' },
      { key: 'phone', label: L('Mobile', 'الموبايل'), type: 'phone', width: 16, example: '01001234567', aliases: ['phone', 'mobile number', 'الهاتف', 'رقم الموبايل'] },
      { key: 'whatsapp', label: L('WhatsApp number', 'رقم الواتساب'), aliases: ['whatsapp no', 'واتساب'], type: 'phone', width: 16, help: L('Only when different from the mobile.', 'فقط إن كان مختلفًا عن رقم الموبايل.') },
      { key: 'primary', label: L('Main contact', 'جهة الاتصال الرئيسية'), type: 'bool', width: 14, example: 'yes', help: L('Yes makes this person the brand’s main contact (one per brand). A brand’s first contact is the main one.', '«نعم» تجعله جهة الاتصال الرئيسية للعلامة (واحدة لكل علامة). أول جهة اتصال للعلامة هي الرئيسية.') },
      { key: 'portal', label: L('Portal account', 'حساب في البوابة'), type: 'bool', width: 14, example: 'no', help: L('Yes opens a tenant-portal account for this email (no email is sent). Needs an email.', '«نعم» تفتح حسابًا في بوابة المستأجرين لهذا البريد (دون إرسال رسالة). يحتاج إلى بريد إلكتروني.') },
    ],
    find(db, v, key) {
      const k = [].concat(key);
      if (k.includes('email')) {
        const hit = db.get('SELECT id FROM contacts WHERE brand_id = ? AND lower(email) = lower(?) ORDER BY id LIMIT 1', v.brand, v.email);
        if (hit) return hit.id;
        // the same person (by name) whose email is new to us
        if (v.name) { const byName = db.get('SELECT id FROM contacts WHERE brand_id = ? AND lower(trim(name)) = lower(trim(?)) AND (email IS NULL OR email = \'\') ORDER BY id LIMIT 1', v.brand, v.name); if (byName) return byName.id; }
        return null;
      }
      const hits = db.all('SELECT id FROM contacts WHERE brand_id = ? AND lower(trim(name)) = lower(trim(?))', v.brand, v.name);
      if (hits.length > 1) return { error: 'imp1|This brand has more than one contact with this name; add their email to tell them apart.' };
      return hits.length ? hits[0].id : null;
    },
    rowCheck(row, ctx) {
      const { db } = ctx;
      const portalUser = row.email ? db.get('SELECT * FROM portal_users WHERE email = ? COLLATE NOCASE', row.email) : null;
      if (row.portal === true) {
        if (!row.email) ctx.error('portal', 'imp1|A portal account needs the person’s email.');
        else if (portalUser && portalUser.brand_id !== row.brand) ctx.error('email', 'imp1|This email already has a portal account with another brand.');
      } else if (row.portal === false && portalUser && portalUser.brand_id === row.brand && ctx.current && ctx.current.portal) {
        ctx.warn('portal', 'imp1|Portal accounts are closed on the Tenant portal page; this one stays open.');
      }
      if (row.email && !ctx.id) {
        const other = db.get('SELECT c.id, b.name FROM contacts c JOIN brands b ON b.id = c.brand_id WHERE lower(c.email) = lower(?) AND c.brand_id != ?', row.email, row.brand);
        if (other) ctx.warn('email', 'imp1|This email is also a contact of {brand}.', { brand: other.name });
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const brand = db.get('SELECT id, name FROM brands WHERE id = ?', row.brand);
      let id = ctx.id;
      const hasAny = db.value('SELECT COUNT(*) FROM contacts WHERE brand_id = ?', brand.id);
      const primary = row.primary === true || (!id && !hasAny) ? 1 : 0;
      if (primary) db.run('UPDATE contacts SET primary_contact = 0 WHERE brand_id = ?', brand.id);
      if (!id) {
        id = Number(db.run('INSERT INTO contacts (brand_id, name, title, email, phone, whatsapp, primary_contact, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          brand.id, row.name, row.title || null, row.email || null, row.phone || null, row.whatsapp || null, primary, now()).lastInsertRowid);
        ctx.log('Added a contact', 'brand', brand.id, `${row.name} · ${brand.name}`);
      } else {
        const old = db.get('SELECT * FROM contacts WHERE id = ?', id);
        db.run('UPDATE contacts SET brand_id = ?, name = ?, title = ?, email = ?, phone = ?, whatsapp = ?, primary_contact = ? WHERE id = ?',
          brand.id, row.name, row.title || null, row.email || null, row.phone || null, row.whatsapp || null, primary || (row.primary === false ? 0 : old.primary_contact), id);
        ctx.log('Updated a contact', 'brand', brand.id, `${row.name} · ${brand.name}`);
      }
      if (row.portal === true && row.email && !db.get('SELECT id FROM portal_users WHERE email = ? COLLATE NOCASE', row.email)) {
        db.run('INSERT INTO portal_users (brand_id, name, email, phone, lang, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', brand.id, row.name, row.email, row.phone || null, ctx.lang === 'ar' ? 'ar' : 'en', ctx.user ? ctx.user.id : null, now());
        ctx.log('Opened a tenant portal account', 'brand', brand.id, `${row.name} · ${row.email}`);
      }
      return id;
    },
    export: (db) => db.all(`SELECT c.*, b.name brand_name, p.id portal_id FROM contacts c JOIN brands b ON b.id = c.brand_id
      LEFT JOIN portal_users p ON lower(p.email) = lower(c.email) AND p.brand_id = c.brand_id ORDER BY b.name, c.primary_contact DESC, c.name`).map((c) => ({
      $id: c.id, brand: c.brand_name, name: c.name, title: c.title, email: c.email, phone: c.phone, whatsapp: c.whatsapp, primary: !!c.primary_contact, portal: !!c.portal_id,
    })),
    count: (db) => db.value('SELECT COUNT(*) FROM contacts WHERE brand_id IS NOT NULL'),
    // a contact and the portal account the import opened for them are one record for undo
    snapshot: (db, id) => {
      const c = db.get('SELECT * FROM contacts WHERE id = ?', id);
      return c ? { contact: c, portal: c.email ? db.get('SELECT * FROM portal_users WHERE email = ? COLLATE NOCASE', c.email) : null, primaries: db.all('SELECT id, primary_contact FROM contacts WHERE brand_id = ?', c.brand_id) } : null;
    },
    restore: (db, snap) => {
      const c = snap.contact;
      const cols = Object.keys(c).filter((k) => k !== 'id');
      const nowRow = db.get('SELECT * FROM contacts WHERE id = ?', c.id);
      if (!snap.portal && nowRow && nowRow.email) db.run('DELETE FROM portal_users WHERE email = ? COLLATE NOCASE AND password_hash IS NULL AND last_login_at IS NULL', nowRow.email);
      db.run(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => c[k]), c.id);
      for (const p of snap.primaries || []) db.run('UPDATE contacts SET primary_contact = ? WHERE id = ?', p.primary_contact, p.id);
    },
    remove: (db, id) => {
      const c = db.get('SELECT * FROM contacts WHERE id = ?', id);
      if (!c) return;
      if (c.email) db.run('DELETE FROM portal_users WHERE email = ? COLLATE NOCASE AND brand_id = ? AND password_hash IS NULL AND last_login_at IS NULL', c.email, c.brand_id);
      db.run('UPDATE leads SET contact_id = NULL WHERE contact_id = ?', id);
      db.run('DELETE FROM contacts WHERE id = ?', id);
      // the brand keeps a main contact
      if (c.primary_contact) { const next = db.get('SELECT id FROM contacts WHERE brand_id = ? ORDER BY id LIMIT 1', c.brand_id); if (next) db.run('UPDATE contacts SET primary_contact = 1 WHERE id = ?', next.id); }
    },
    uses: (db, id, o) => {
      const out = imports.usesOf('contacts', id, o);
      const c = db.get('SELECT email, brand_id FROM contacts WHERE id = ?', id);
      if (c && c.email && db.value('SELECT COUNT(*) FROM portal_users WHERE email = ? COLLATE NOCASE AND (password_hash IS NOT NULL OR last_login_at IS NOT NULL)', c.email)) out.push({ n: 1, what: L('portal account in use', 'حساب مستخدَم في البوابة') });
      return out;
    },
    link: (id) => { const b = h.db.value('SELECT brand_id FROM contacts WHERE id = ?', id); return b ? `/admin/brands/${b}` : '/admin/brands'; },
    label: (v, names) => `${v.name || ''}${names.brand ? ` · ${names.brand}` : ''}`,
    examples: [
      { brand: 'Maison Lune', name: 'Laila Hamdy', title: 'Expansion manager', email: 'laila@maisonlune.com', phone: '01001234567', primary: true, portal: true },
      { brand: 'Maison Lune', name: 'Karim Adel', title: 'Accounts', email: 'accounts@maisonlune.com', phone: '01112345678', primary: false, portal: false },
      { brand: 'Kahwa House', name: 'Omar Fathy', title: 'Store manager', phone: '01223344556', primary: true },
    ],
  });

  // ======================================================================== leads
  const LOST = () => M.LOST_REASONS.map((r) => [r, lab(r)]);
  imports.register({
    key: 'leads',
    module: '/admin/leads',
    pages: ['/admin/leads'],
    area: 'sales',
    order: 10,
    depends: ['brands', 'units'],
    icon: 'leads',
    table: 'leads',
    title: L('Leads', 'الفرص'),
    summary: L('The sales pipeline: brands you are talking to, what they need, the stage and who follows it.', 'مسار المبيعات: العلامات التي تتفاوض معها، وما تحتاجه، والمرحلة، ومن يتابعها.'),
    notes: L('A row with a lead number (LD-…) updates that lead; rows without one become new leads. A new lead whose brand is not in the system creates the brand, as the New lead form does. The contact columns add a contact to new leads only.', 'الصف الذي يحمل رقم فرصة من النظام يحدّث تلك الفرصة؛ والصفوف بلا رقم تصبح فرصًا جديدة. الفرصة الجديدة لعلامة غير مسجلة تنشئ العلامة، كما يفعل نموذج «فرصة جديدة». أعمدة جهة الاتصال تضيف جهة اتصال للفرص الجديدة فقط.'),
    allowed: (req) => h.can(req, 'agent'),
    keys: ['ref'],
    columns: [
      { key: 'ref', label: L('Lead number', 'رقم الفرصة'), type: 'code', max: 30, width: 15, keepOnUpdate: true, aliases: ['lead no', 'lead ref', 'رقم الفرصه'], help: L('Leave empty for new leads. A number already in the system updates that lead.', 'اتركه فارغًا للفرص الجديدة. الرقم الموجود في النظام يحدّث الفرصة نفسها.') },
      { key: 'title', label: L('Lead (brand or company)', 'الفرصة (العلامة أو الشركة)'), type: 'text', required: true, max: 160, width: 26, example: 'Nile Bloom', aliases: ['lead', 'name', 'company', 'brand name', 'اسم الفرصه', 'الشركة'] },
      { key: 'brand', label: L('Brand in the system', 'العلامة في النظام'), type: 'ref', width: 22, ref: brandRef, help: L('Optional: an existing brand. Empty: the brand with the lead’s name, or a new one.', 'اختياري: علامة موجودة. الفارغ: العلامة التي تحمل اسم الفرصة، أو علامة جديدة.') },
      { key: 'category', label: L('Category', 'الفئة'), type: 'enum', enum: () => Object.keys(M.CATEGORIES).map((k) => [k, { en: i18n.run('en', () => M.CATEGORIES[k]), ar: i18n.run('ar', () => M.CATEGORIES[k]) }]), width: 22, example: 'fnb' },
      { key: 'source', label: L('Source', 'المصدر'), type: 'enum', enum: () => Object.keys(M.SOURCES).map((k) => [k, { en: i18n.run('en', () => M.SOURCES[k]), ar: i18n.run('ar', () => M.SOURCES[k]) }]), width: 16, example: 'referral', help: L('Empty means Direct outreach.', 'الفارغ يعني «تواصل مباشر».') },
      { key: 'stage', label: L('Stage', 'المرحلة'), type: 'enum', enum: () => M.STAGES.map((s) => [s.id, lab(s.en)]), width: 16, example: 'contacted', help: L('Empty means New.', 'الفارغ يعني «جديدة».') },
      { key: 'lost_reason', label: L('Why lost', 'سبب الخسارة'), type: 'enum', enum: LOST, width: 18, help: L('Only for lost leads.', 'للفرص الخاسرة فقط.') },
      { key: 'area_min', label: L('Area from (m²)', 'المساحة من (م²)'), type: 'number', min: 0, maxValue: 100000, width: 14, example: 80 },
      { key: 'area_max', label: L('Area to (m²)', 'المساحة إلى (م²)'), type: 'number', min: 0, maxValue: 100000, width: 14, example: 120 },
      { key: 'budget_m2', label: L('Budget per m² a month', 'الميزانية للمتر شهريًا'), type: 'money', width: 16, example: 1400 },
      { key: 'zone', label: L('Preferred level', 'المستوى المفضل'), type: 'enum', enum: () => ['plaza', 'street', 'upper'].map((k) => [k, { en: i18n.run('en', () => M.ZONES[k]), ar: i18n.run('ar', () => M.ZONES[k]) }]), width: 16 },
      { key: 'unit', label: L('Unit of interest', 'الوحدة المطلوبة'), type: 'ref', width: 14, ref: { list: unitChoices, dataset: 'units', what: L('Units', 'الوحدات') } },
      { key: 'owner', label: L('Owner (email)', 'المسؤول (البريد)'), type: 'ref', width: 24, ref: { list: userChoices, what: L('Office accounts', 'حسابات المكتب') }, help: L('Who follows the lead: their office email or name.', 'من يتابع الفرصة: بريده في المكتب أو اسمه.') },
      { key: 'next_step', label: L('Next step', 'الخطوة التالية'), type: 'text', max: 200, width: 26, example: 'Send the floor plans' },
      { key: 'next_step_at', label: L('Next step on', 'موعد الخطوة التالية'), type: 'date', width: 15 },
      { key: 'message', label: L('Notes', 'ملاحظات'), type: 'text', max: 4000, multiline: true, width: 30, aliases: ['message', 'comments'] },
      { key: 'contact_name', label: L('Contact name', 'اسم جهة الاتصال'), type: 'text', max: 120, width: 20, keepOnUpdate: true },
      { key: 'contact_title', label: L('Contact’s job title', 'المسمى الوظيفي لجهة الاتصال'), type: 'text', max: 120, width: 18, keepOnUpdate: true },
      { key: 'contact_email', label: L('Contact email', 'بريد جهة الاتصال'), type: 'email', width: 24, keepOnUpdate: true },
      { key: 'contact_phone', label: L('Contact phone', 'هاتف جهة الاتصال'), type: 'phone', width: 16, keepOnUpdate: true },
    ],
    rowCheck(row, ctx) {
      const { db } = ctx;
      if (!ctx.id && row.ref && systemRef('LD').test(row.ref)) ctx.error('ref', 'imp1|{ref} looks like a number the office gives, but no lead has it. Leave it empty for a new lead.', { ref: row.ref });
      if (row.area_min && row.area_max && row.area_max < row.area_min) ctx.error('area_max', 'imp1|The largest area is smaller than the smallest.');
      if (row.stage === 'lost' && !row.lost_reason) ctx.error('lost_reason', 'imp1|Say why the lead was lost.');
      if (row.lost_reason && row.stage !== 'lost' && ctx.provided.has('lost_reason')) ctx.warn('lost_reason', 'imp1|A reason is only kept for lost leads.');
      if ((row.contact_title || row.contact_email || row.contact_phone) && !row.contact_name && !ctx.id) ctx.error('contact_name', 'imp|Give the contact’s name with their details.');
      if (!ctx.id) {
        const dup = db.get(`SELECT ref FROM leads WHERE lower(trim(title)) = lower(trim(?)) AND stage NOT IN ('won','lost')`, row.title);
        if (dup) ctx.warn('title', 'imp1|{ref} is already an open lead for this name.', { ref: dup.ref });
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const t = now();
      const l = {
        title: row.title, brand_id: row.brand || null, category: row.category || 'other', source: row.source || 'direct',
        area_min: row.area_min ?? null, area_max: row.area_max ?? null, budget_m2: row.budget_m2 ?? null, zone: row.zone || null, unit_id: row.unit || null,
        owner_id: row.owner || null, next_step: row.next_step || null, next_step_at: row.next_step_at || null, message: row.message || null,
      };
      const stageId = row.stage || 'new';
      if (!ctx.id) {
        if (!l.brand_id) {
          const existing = db.get('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', l.title);
          l.brand_id = existing ? existing.id : Number(db.run('INSERT INTO brands (name, category, created_at) VALUES (?, ?, ?)', l.title, l.category, t).lastInsertRowid);
        }
        let contactId = null;
        if (row.contact_name) contactId = Number(db.run('INSERT INTO contacts (brand_id, name, title, email, phone, primary_contact, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)', l.brand_id, row.contact_name, row.contact_title || null, row.contact_email || null, row.contact_phone || null, t).lastInsertRowid);
        if (contactId) db.run('UPDATE contacts SET primary_contact = 0 WHERE brand_id = ? AND id != ?', l.brand_id, contactId);
        l.value_est = M.estimateValue(db, l);
        const id = Number(db.run(
          `INSERT INTO leads (ref, brand_id, contact_id, title, category, source, stage, probability, area_min, area_max, budget_m2, zone, unit_id, value_est, owner_id, next_step, next_step_at, message, created_at, updated_at, stage_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.ref || db.nextRef('leads', 'LD'), l.brand_id, contactId, l.title, l.category, l.source, l.area_min, l.area_max, l.budget_m2, l.zone, l.unit_id, l.value_est, l.owner_id, l.next_step, l.next_step_at, l.message, t, t, t,
        ).lastInsertRowid);
        ctx.log('Created a lead', 'lead', id, l.title);
        if (stageId !== 'new') h.changeStage(asReq(ctx), db.get('SELECT * FROM leads WHERE id = ?', id), stageId, { reason: row.lost_reason || null });
        return id;
      }
      const old = db.get('SELECT * FROM leads WHERE id = ?', ctx.id);
      if (!l.brand_id) l.brand_id = old.brand_id;
      l.value_est = M.estimateValue(db, l);
      db.run(`UPDATE leads SET title = ?, brand_id = ?, category = ?, source = ?, area_min = ?, area_max = ?, budget_m2 = ?, zone = ?, unit_id = ?, value_est = ?, owner_id = ?, next_step = ?, next_step_at = ?, message = ?, updated_at = ? WHERE id = ?`,
        l.title, l.brand_id, l.category, l.source, l.area_min, l.area_max, l.budget_m2, l.zone, l.unit_id, l.value_est, l.owner_id, l.next_step, l.next_step_at, l.message, t, old.id);
      if (l.owner_id && l.owner_id !== old.owner_id && (!ctx.user || l.owner_id !== ctx.user.id)) {
        db.run("INSERT INTO activities (lead_id, brand_id, user_id, type, subject, due_at, created_at) VALUES (?, ?, ?, 'task', ?, ?, ?)", old.id, old.brand_id, l.owner_id, `New lead assigned to you: ${l.title}`, today(), t);
      }
      ctx.log('Updated a lead', 'lead', old.id, l.title);
      if (stageId !== old.stage) h.changeStage(asReq(ctx), db.get('SELECT * FROM leads WHERE id = ?', old.id), stageId, { reason: row.lost_reason || null });
      else if (stageId === 'lost' && row.lost_reason && row.lost_reason !== old.lost_reason) db.run('UPDATE leads SET lost_reason = ? WHERE id = ?', row.lost_reason, old.id);
      return old.id;
    },
    export: (db) => db.all(`SELECT l.*, b.name brand_name, u.code unit_code, o.email owner_email, c.name c_name, c.title c_title, c.email c_email, c.phone c_phone FROM leads l
      LEFT JOIN brands b ON b.id = l.brand_id LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN users o ON o.id = l.owner_id LEFT JOIN contacts c ON c.id = l.contact_id ORDER BY l.id`).map((l) => ({
      $id: l.id, ref: l.ref, title: l.title, brand: l.brand_name, category: l.category, source: l.source, stage: l.stage, lost_reason: l.stage === 'lost' ? l.lost_reason : null,
      area_min: l.area_min, area_max: l.area_max, budget_m2: l.budget_m2, zone: l.zone, unit: l.unit_code, owner: l.owner_email, next_step: l.next_step, next_step_at: l.next_step_at,
      message: l.message, contact_name: l.c_name, contact_title: l.c_title, contact_email: l.c_email, contact_phone: l.c_phone,
    })),
    snapshot: (db, id) => {
      const l = db.get('SELECT * FROM leads WHERE id = ?', id);
      return l ? { lead: l, activities: db.all('SELECT id FROM activities WHERE lead_id = ?', id).map((a) => a.id) } : null;
    },
    restore: (db, snap) => {
      const cols = Object.keys(snap.lead).filter((k) => k !== 'id');
      db.run(`UPDATE leads SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => snap.lead[k]), snap.lead.id);
      const keep = new Set(snap.activities);
      for (const a of db.all('SELECT id FROM activities WHERE lead_id = ?', snap.lead.id)) if (!keep.has(a.id)) db.run('DELETE FROM activities WHERE id = ?', a.id);
    },
    remove: (db, id) => {
      const l = db.get('SELECT * FROM leads WHERE id = ?', id);
      if (!l) return;
      db.run('DELETE FROM activities WHERE lead_id = ?', id);
      db.run('DELETE FROM leads WHERE id = ?', id);
      if (l.contact_id && !imports.usesOf('contacts', l.contact_id).length) db.run('DELETE FROM contacts WHERE id = ?', l.contact_id);
      // the brand the lead created goes too, when nothing else knows it
      if (l.brand_id && db.value('SELECT created_at >= ? FROM brands WHERE id = ?', l.created_at, l.brand_id) && !imports.usesOf('brands', l.brand_id, { entity: 'brand' }).length && !db.value('SELECT COUNT(*) FROM contacts WHERE brand_id = ?', l.brand_id)) db.run('DELETE FROM brands WHERE id = ?', l.brand_id);
    },
    uses: (db, id, o) => {
      const out = imports.usesOf('leads', id, { ...o, ignore: ['activities'], entity: 'lead' });
      const own = db.get('SELECT created_at FROM leads WHERE id = ?', id);
      const acts = own ? db.value("SELECT COUNT(*) FROM activities WHERE lead_id = ? AND NOT (type = 'note' AND subject LIKE 'Moved to %' AND created_at <= ?)", id, own.created_at.slice(0, 16) + ':59.999Z') : 0;
      if (acts) out.push({ n: acts, what: L('activities', 'أنشطة') });
      return out;
    },
    link: (id) => `/admin/leads/${id}`,
    label: (v) => (v.ref ? `${v.ref} · ${v.title || ''}` : v.title || ''),
    examples: [
      { title: 'Nile Bloom', category: 'fashion', source: 'referral', stage: 'contacted', area_min: 80, area_max: 120, budget_m2: 1400, zone: 'plaza', next_step: 'Send the floor plans', next_step_at: '2026-12-01', contact_name: 'Sara Nabil', contact_title: 'Owner', contact_email: 'sara@nilebloom.com', contact_phone: '01001234567' },
      { title: 'Habibi Gelato', category: 'fnb', source: 'walk_in', stage: 'viewing', area_min: 30, area_max: 45, zone: 'street', unit: 'G05' },
    ],
  });

  // ======================================================================== leases
  const FREQ = { monthly: 'Monthly in advance', quarterly: 'Quarterly in advance', annual: 'Yearly in advance' };
  const leaseStatus = () => opts({ draft: 'lease|Draft', active: 'lease|Active', ended: 'lease|Ended', terminated: 'lease|Terminated' });
  const TERMS = ['rent_m2', 'terrace_rent_m2', 'escalation_pct', 'esc_from_1', 'esc_pct_1', 'esc_from_2', 'esc_pct_2', 'esc_from_3', 'esc_pct_3', 'service_mode', 'service_m2', 'service_pct',
    'vat_pct', 'vat_included', 'revenue_share', 'revenue_pct', 'min_guarantee', 'take_higher', 'rent_free_months', 'payment_freq', 'deposit', 'key_money', 'brand', 'units', 'start_date', 'term_years'];
  const endOf = (start, years) => M.addDays(M.addMonths(start, years * 12), -1);
  const stepsOf = (row) => TM.steps([1, 2, 3].map((n) => ({ from: row[`esc_from_${n}`], pct: row[`esc_pct_${n}`] })).filter((x) => x.from && x.pct !== null && x.pct !== undefined && x.from <= (row.term_years || 30)));
  // the units of a row: codes → units, with what is wrong
  function unitsOf(db, codes) {
    const found = [];
    const missing = [];
    for (const code of [].concat(codes || [])) {
      const u = db.get('SELECT * FROM units WHERE code = ? COLLATE NOCASE', String(code).trim());
      if (u) { if (!found.some((x) => x.id === u.id)) found.push(u); } else missing.push(code);
    }
    return { found, missing };
  }
  // leases (other than this one) on these units whose dates cross [from, to]
  const clashes = (db, unitIds, from, to, exceptId, statuses) => (unitIds.length ? db.all(`SELECT DISTINCT s.ref, s.status, u.code FROM lease_units x JOIN leases s ON s.id = x.lease_id JOIN units u ON u.id = x.unit_id
    WHERE x.unit_id IN (${unitIds.map(() => '?').join(',')}) AND s.id != ? AND s.status IN (${statuses.map(() => '?').join(',')}) AND s.start_date <= ? AND s.end_date >= ?`, ...unitIds, exceptId || 0, ...statuses, to, from) : []);

  // a deposit received before the office went live: a paid deposit invoice (for the settlement),
  // with entries in the books that cancel out (the deposit is in the opening trial balance)
  function depositHistory(db, lease, amount, date, ctx) {
    const inv = h.billing.createInvoice({ lease_id: lease.id, kind: 'deposit', due_date: date, other: amount, note: 'Security deposit (received before go-live)' }, { user: ctx.user, emit: false });
    const pid = Number(db.run(`INSERT INTO payments (ref, invoice_id, brand_id, amount, date, method, reference, note, user_id, demo, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?)`,
      db.nextRef('payments', 'RC', 5, true), inv.id, inv.brand_id, inv.total, date, 'Received before go-live', ctx.user ? ctx.user.id : null, now()).lastInsertRowid);
    db.run("UPDATE invoices SET paid = total, status = 'paid', paid_at = ? WHERE id = ?", date, inv.id);
    if (h.ledger) {
      const party = { party_type: 'brand', party_id: inv.brand_id };
      h.ledger.postOnce(`inv:${inv.id}`, () => ({ date: today(), memo: `Opening · deposit ${inv.ref}`, kind: 'opening', lines: [{ account: 'ar', debit: inv.total, ...party }, { account: 'opening_equity', credit: inv.total }] }));
      h.ledger.postOnce(`pay:${pid}`, () => ({ date: today(), memo: `Opening · deposit received ${inv.ref}`, kind: 'opening', lines: [{ account: 'opening_equity', debit: inv.total }, { account: 'ar', credit: inv.total, ...party }] }));
    }
  }
  // Activate: the units become leased and the rent is invoiced from `from` (as the Activate button, deals.js)
  function activate(db, s, ctx, { from = today(), depositReceived = null, keyReceived = null } = {}) {
    const units = M.leaseUnits(db, s.id);
    db.run("UPDATE leases SET status = 'active', signed_at = COALESCE(signed_at, ?) WHERE id = ?", today(), s.id);
    for (const u of units) db.run("UPDATE units SET status = 'leased', hold_until = NULL, hold_lead_id = NULL, updated_at = ? WHERE id = ?", now(), u.id);
    const lease = db.get('SELECT * FROM leases WHERE id = ?', s.id);
    let n = 0;
    for (const p of M.invoicePlan(lease, units)) {
      if (p.period_start < from) continue;
      if (p.rent + p.service > 0) { h.billing.createInvoice({ lease_id: s.id, kind: 'rent', period_start: p.period_start, period_end: p.period_end, due_date: p.due_date, rent: p.rent, service: p.service }, { user: ctx.user }); n++; }
    }
    const due = lease.signed_at || today();
    const dep = r2(lease.deposit);
    const depIn = r2(depositReceived === null || depositReceived === undefined ? dep : Math.min(dep, depositReceived));
    if (depIn > 0) depositHistory(db, lease, depIn, due, ctx);
    if (dep - depIn > 0) h.billing.createInvoice({ lease_id: s.id, kind: 'deposit', due_date: from > due ? from : due, other: r2(dep - depIn), note: 'Security deposit' }, { user: ctx.user });
    const key = r2(lease.key_money);
    const keyIn = r2(keyReceived === null || keyReceived === undefined ? key : Math.min(key, keyReceived));
    if (key - keyIn > 0) h.billing.createInvoice({ lease_id: s.id, kind: 'key', due_date: from > due ? from : due, other: r2(key - keyIn), note: 'Key money' }, { user: ctx.user });
    if (lease.lead_id) {
      const l = db.get('SELECT * FROM leads WHERE id = ?', lease.lead_id);
      if (l && l.stage !== 'won') h.changeStage(asReq(ctx), l, 'won');
    }
    return n;
  }

  imports.register({
    key: 'leases',
    module: '/admin/leases',
    pages: ['/admin/leases'],
    area: 'property',
    order: 40,
    depends: ['units', 'brands'],
    icon: 'lease',
    table: 'leases',
    title: L('Leases (contracts)', 'عقود الإيجار'),
    summary: L('Every tenant contract with all its terms: units, dates, rent and increases, service charge, VAT, revenue share, deposit.', 'كل عقود المستأجرين بكل شروطها: الوحدات والتواريخ والإيجار والزيادات ورسوم الخدمات والضريبة ونسبة المبيعات والتأمين.'),
    notes: L('Status Active makes the units leased and creates the rent invoices from “Invoice rent from” (today when empty): earlier periods belong to your old system — bring what is still unpaid from them as Opening balances. Deposit and key money already received are not billed again (empty means all received). Ended and Terminated leases are kept as history, with no invoices. A lease already in the system only takes a new status (Draft → Active, Active → Ended or Terminated), its signing date and notes; its terms change through an amendment on the lease page.', 'الحالة «ساري» تجعل الوحدات مؤجرة وتنشئ فواتير الإيجار ابتداءً من «إصدار الفواتير من» (اليوم إن تُرك فارغًا): الفترات السابقة تخص نظامك القديم، وما لم يُسدد منها يُستورد ضمن الأرصدة الافتتاحية. التأمين ومقابل الخلو المستلمان لا يُفوتران مرة أخرى (الفارغ يعني أنهما استُلما كاملين). العقود المنتهية والمفسوخة تُحفظ كسجل، بلا فواتير. العقد الموجود في النظام يقبل فقط حالة جديدة (مسودة ← ساري، ساري ← منتهٍ أو مفسوخ) وتاريخ التوقيع والملاحظات؛ أما شروطه فتتغير بملحق من صفحة العقد.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['ref'],
    columns: [
      { key: 'ref', label: L('Contract number', 'رقم العقد'), type: 'code', max: 30, width: 15, keepOnUpdate: true, example: 'C-2023-014', aliases: ['lease no', 'lease ref', 'contract no', 'contract', 'رقم العقد', 'العقد'], help: L('Your contract number, or empty for the office to number it (LS-…). A number already in the system updates that lease.', 'رقم عقدك، أو اتركه فارغًا ليرقّمه النظام. الرقم الموجود في النظام يحدّث العقد نفسه.') },
      { key: 'brand', label: L('Tenant (brand)', 'المستأجر (العلامة)'), type: 'ref', required: true, width: 22, ref: brandRef, example: 'Maison Lune', aliases: ['tenant', 'brand', 'المستاجر'] },
      { key: 'units', label: L('Units', 'الوحدات'), type: 'list', required: true, width: 16, example: 'G01, G02', transform: (v) => ({ value: [...new Set([].concat(v).map((x) => String(x).trim().toUpperCase()).filter(Boolean))].sort() }), aliases: ['unit', 'unit codes', 'shops', 'الوحده', 'المحلات'], help: L('Unit codes separated by commas: G01, G02.', 'رموز الوحدات مفصولة بفواصل: G01, G02.') },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: leaseStatus, width: 13, example: 'active', help: L('Draft, Active, Ended or Terminated. Empty means Draft.', 'مسودة أو ساري أو منتهٍ أو مفسوخ. الفارغ يعني مسودة.') },
      { key: 'start_date', label: L('Start date', 'تاريخ البداية'), type: 'date', required: true, width: 14, example: '2024-01-01' },
      { key: 'term_years', label: L('Term (years)', 'المدة (بالسنوات)'), type: 'int', required: true, min: 1, maxValue: 30, width: 12, example: 5 },
      { key: 'end_date', label: L('End date', 'تاريخ النهاية'), type: 'date', width: 14, help: L('Empty: the start plus the term. For an Ended or Terminated lease, its last day.', 'الفارغ: البداية مضافًا إليها المدة. للعقد المنتهي أو المفسوخ: آخر يوم فيه.') },
      { key: 'rent_m2', label: L('Rent per m² a month', 'الإيجار للمتر شهريًا'), type: 'money', width: 16, example: 1500, help: L('Empty for a revenue share only.', 'اتركه فارغًا لعقد بنسبة من المبيعات فقط.') },
      { key: 'terrace_rent_m2', label: L('Terrace per m² a month', 'التراس للمتر شهريًا'), type: 'money', width: 16 },
      { key: 'escalation_pct', label: L('Yearly increase (%)', 'الزيادة السنوية (%)'), type: 'percent', width: 14, example: 10, help: L('From the second year.', 'ابتداءً من السنة الثانية.') },
      ...[1, 2, 3].flatMap((n) => [
        { key: `esc_from_${n}`, label: L(`Increase changes from year (${n})`, `تتغير الزيادة من السنة (${n})`), type: 'int', min: 2, maxValue: 30, width: 14, help: L('Optional: a different increase from this contract year on.', 'اختياري: زيادة مختلفة ابتداءً من سنة العقد هذه.') },
        { key: `esc_pct_${n}`, label: L(`Increase becomes (%) (${n})`, `تصبح الزيادة (%) (${n})`), type: 'percent', width: 14 },
      ]),
      { key: 'service_mode', label: L('Service charge is', 'رسوم الخدمات'), type: 'enum', enum: () => [['m2', lab('An amount per m²')], ['pct', lab('A percentage of the rent')]], width: 18, help: L('Empty: an amount per m².', 'الفارغ: مبلغ لكل م².') },
      { key: 'service_m2', label: L('Service per m² a month', 'الخدمات للمتر شهريًا'), type: 'money', width: 16, example: 140 },
      { key: 'service_pct', label: L('Service (% of the rent)', 'الخدمات (% من الإيجار)'), type: 'percent', width: 15 },
      { key: 'vat_pct', label: L('VAT (%)', 'ضريبة القيمة المضافة (%)'), type: 'percent', width: 12, help: L('Empty: the rate in Settings.', 'الفارغ: النسبة المحددة في الإعدادات.') },
      { key: 'vat_included', label: L('Amounts include VAT', 'المبالغ شاملة الضريبة'), type: 'bool', width: 14 },
      { key: 'revenue_share', label: L('Revenue share', 'نسبة من المبيعات'), type: 'bool', width: 13 },
      { key: 'revenue_pct', label: L('Share of sales (%)', 'النسبة من المبيعات (%)'), type: 'percent', maxValue: 50, width: 14 },
      { key: 'min_guarantee', label: L('Minimum guarantee a month', 'الحد الأدنى المضمون شهريًا'), type: 'money', width: 16 },
      { key: 'take_higher', label: L('Whichever is higher', 'الأعلى منهما'), type: 'bool', width: 13, help: L('Yes (or empty): the higher of the guarantee and the share. No: the guarantee plus the share.', 'نعم (أو فارغ): الأعلى بين الحد الأدنى والنسبة. لا: الحد الأدنى مضافًا إليه النسبة.') },
      { key: 'rent_free_months', label: L('Rent-free months', 'أشهر الإعفاء من الإيجار'), type: 'int', min: 0, maxValue: 60, width: 13 },
      { key: 'payment_freq', label: L('Invoiced', 'إصدار الفواتير'), type: 'enum', enum: () => opts(FREQ), width: 18, example: 'quarterly', help: L('Empty: quarterly in advance.', 'الفارغ: ربع سنوي مقدمًا.') },
      { key: 'deposit', label: L('Security deposit', 'مبلغ التأمين'), type: 'money', width: 14, example: 120000 },
      { key: 'key_money', label: L('Key money', 'مقابل الخلو'), type: 'money', width: 13 },
      { key: 'signed_at', label: L('Signed on', 'تاريخ التوقيع'), type: 'date', width: 14 },
      { key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max: 3000, multiline: true, width: 30 },
      { key: 'bill_from', label: L('Invoice rent from', 'إصدار الفواتير من'), type: 'date', width: 15, keepOnUpdate: true, help: L('For Active leases: rent periods starting before this date are not invoiced. Empty: today.', 'للعقود السارية: فترات الإيجار التي تبدأ قبل هذا التاريخ لا تُفوتر. الفارغ: اليوم.') },
      { key: 'deposit_received', label: L('Deposit already received', 'التأمين المستلم'), type: 'money', width: 15, keepOnUpdate: true, help: L('For Active leases. Empty: all of it. Less than the deposit: the rest is billed now.', 'للعقود السارية. الفارغ: كامل المبلغ. إن كان أقل من التأمين يُفوتر الباقي الآن.') },
      { key: 'key_money_received', label: L('Key money already received', 'الخلو المستلم'), type: 'money', width: 15, keepOnUpdate: true, help: L('For Active leases. Empty: all of it. Less: the rest is billed now.', 'للعقود السارية. الفارغ: كامل المبلغ. إن كان أقل يُفوتر الباقي الآن.') },
    ],
    rowCheck(row, ctx) {
      const { db } = ctx;
      const cur = ctx.current;
      const status = row.status || 'draft';
      // ---------- a lease already in the system: only its status, signing date and notes
      if (cur) {
        const changed = TERMS.filter((k) => ctx.provided.has(k) && !same(k === 'brand' ? db.value('SELECT name FROM brands WHERE id = ?', row.brand) : row[k], cur[k]));
        for (const k of changed) ctx.error(k, 'imp1|The terms of a lease already in the system change through an amendment on the lease page, not an import.');
        if (status !== cur.status) {
          const ok = (cur.status === 'draft' && status === 'active') || (cur.status === 'active' && ['ended', 'terminated'].includes(status));
          if (!ok) ctx.error('status', 'imp1|A lease can go from Draft to Active, or from Active to Ended or Terminated.');
          if (ok && status === 'active') {
            const units = M.leaseUnits(db, ctx.id);
            const busy = units.filter((u) => u.status === 'leased');
            if (busy.length) ctx.error('units', 'imp1|{codes} already leased.', { codes: busy.map((u) => u.code).join(', ') });
          }
          if (ok && status !== 'active') {
            if (!row.end_date || same(row.end_date, cur.end_date)) ctx.error('end_date', 'imp1|Give the lease’s last day.');
            else if (row.end_date < cur.start_date || row.end_date > cur.end_date) ctx.error('end_date', 'imp1|The last day must be between the start and the end of the lease.');
          }
        } else if (ctx.provided.has('end_date') && !same(row.end_date, cur.end_date)) ctx.error('end_date', 'imp1|The terms of a lease already in the system change through an amendment on the lease page, not an import.');
        return;
      }
      // ---------- a new lease
      if (row.ref && systemRef('LS').test(row.ref)) ctx.error('ref', 'imp1|{ref} looks like a number the office gives, but no lease has it. Leave it empty, or use your own contract number.', { ref: row.ref });
      const { found, missing } = unitsOf(db, row.units);
      if (missing.length) ctx.error('units', 'imp1|Unit {codes} is not in the system. Import Units first, or check the code.', { codes: missing.join(', ') });
      const retired = found.filter((u) => u.status === 'retired');
      if (retired.length) ctx.error('units', 'imp1|{codes} was merged or split and cannot be leased.', { codes: retired.map((u) => u.code).join(', ') });
      row.$units = found.map((u) => u.id);
      if (!found.length && !missing.length) ctx.error('units', 'imp1|Give at least one unit.');
      const years = row.term_years || 0;
      const computed = row.start_date && years ? endOf(row.start_date, years) : null;
      if (computed && row.end_date) {
        if (['draft', 'active'].includes(status) && row.end_date !== computed) ctx.error('end_date', 'imp1|A {n}-year lease from this start ends on {date}. Leases run whole years: fix the term or the end date.', { n: years, date: h.ui.date(computed) });
        if (['ended', 'terminated'].includes(status) && (row.end_date < row.start_date || row.end_date > computed)) ctx.error('end_date', 'imp1|The last day must be between the start and the end of the lease.');
      }
      if (status === 'active' && computed && computed < today()) ctx.error('status', 'imp1|This lease ended on {date}; import it as Ended.', { date: h.ui.date(computed) });
      const share = !!row.revenue_share;
      if (share && !(row.revenue_pct > 0 && row.revenue_pct <= 50)) ctx.error('revenue_pct', 'imp1|Give the share of sales (more than 0%, up to 50%).');
      if (!share && !(row.rent_m2 > 0)) ctx.error('rent_m2', 'imp1|Give the rent per m², or mark the lease as a revenue share.');
      if (!share && (row.revenue_pct || row.min_guarantee)) ctx.warn('revenue_share', 'imp1|The share and the guarantee are only used when Revenue share is Yes.');
      if (row.service_mode === 'pct' && !(row.service_pct > 0)) ctx.warn('service_pct', 'imp1|Service charge is a percentage, but no percentage is given.');
      for (const n of [1, 2, 3]) {
        const f = row[`esc_from_${n}`];
        const p = row[`esc_pct_${n}`];
        if ((f && (p === null || p === undefined)) || (!f && p !== null && p !== undefined)) ctx.error(f ? `esc_pct_${n}` : `esc_from_${n}`, 'imp1|A stepped increase needs both the year and the percentage.');
        else if (f && f > years) ctx.error(`esc_from_${n}`, 'imp1|Year {n} is after the end of the lease.', { n: f });
      }
      if (row.deposit_received > (row.deposit || 0)) ctx.error('deposit_received', 'imp1|More than the deposit itself.');
      if (row.key_money_received > (row.key_money || 0)) ctx.error('key_money_received', 'imp1|More than the key money itself.');
      if (status !== 'active') for (const k of ['bill_from', 'deposit_received', 'key_money_received']) if (ctx.provided.has(k)) ctx.warn(k, 'imp1|Only used for Active leases.');
      // the units: no other lease on them at the same time
      if (found.length && row.start_date && computed) {
        const to = row.end_date && ['ended', 'terminated'].includes(status) ? row.end_date : computed;
        const hit = clashes(db, row.$units, row.start_date, to, 0, ['active', 'ended', 'terminated']);
        if (hit.length && status !== 'draft') ctx.error('units', 'imp1|{code} is in lease {ref} at the same time.', { code: hit[0].code, ref: hit[0].ref });
        else if (hit.length) ctx.warn('units', 'imp1|{code} is in lease {ref} at the same time.', { code: hit[0].code, ref: hit[0].ref });
        if (status === 'active') {
          const busy = found.filter((u) => u.status === 'leased' && !hit.length);
          if (busy.length) ctx.error('units', 'imp1|{codes} already leased.', { codes: busy.map((u) => u.code).join(', ') });
          const blocked = found.filter((u) => u.status === 'blocked');
          if (blocked.length) ctx.warn('units', 'imp1|{codes} is blocked; the lease makes it leased.', { codes: blocked.map((u) => u.code).join(', ') });
        }
      }
    },
    apply(row, ctx) {
      const { db } = ctx;
      const status = row.status || 'draft';
      if (ctx.id) {
        const s = db.get('SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = ?', ctx.id);
        db.run('UPDATE leases SET signed_at = ?, notes = ? WHERE id = ?', row.signed_at || s.signed_at, row.notes ?? null, s.id);
        if (status === 'active' && s.status === 'draft') {
          activate(db, s, ctx, { from: row.bill_from || today(), depositReceived: row.deposit_received ?? null, keyReceived: row.key_money_received ?? null });
          ctx.log('Activated a lease', 'lease', s.id, `${s.ref} · ${s.brand_name}`);
        } else if (['ended', 'terminated'].includes(status) && s.status === 'active') {
          h.endLease(s, { how: status, date: row.end_date, user: ctx.user });
          ctx.log(`Lease ${status}`, 'lease', s.id, `${s.ref} · ${s.brand_name}`);
        }
        return s.id;
      }
      const brand = db.get('SELECT * FROM brands WHERE id = ?', row.brand);
      const ids = row.$units || unitsOf(db, row.units).found.map((u) => u.id);
      const years = row.term_years;
      const computed = endOf(row.start_date, years);
      const end = ['ended', 'terminated'].includes(status) && row.end_date ? row.end_date : computed;
      // the same unit twice in one file, or a unit leased by a row above
      const hit = clashes(db, ids, row.start_date, end, 0, ['active', 'ended', 'terminated']);
      if (hit.length && status !== 'draft') throw new Error(i18n.run(ctx.lang, () => i18n.t('imp1|{code} is in lease {ref} at the same time.', { code: hit[0].code, ref: hit[0].ref })));
      const share = !!row.revenue_share;
      const steps = stepsOf(row);
      const mode = row.service_mode === 'pct' ? 'pct' : 'm2';
      const id = Number(db.run(
        `INSERT INTO leases (ref, brand_id, status, start_date, end_date, term_years, rent_m2, terrace_rent_m2, service_m2, escalation_pct, rent_free_months, payment_freq, deposit, key_money, signed_at, notes, created_by, created_at,
           escalation_steps, service_mode, service_pct, vat_pct, vat_included, revenue_share, revenue_pct, min_guarantee, take_higher)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.ref || db.nextRef('leases', 'LS', 3, true), brand.id, row.start_date, end, years, row.rent_m2 || 0, row.terrace_rent_m2 || 0, mode === 'm2' ? row.service_m2 || 0 : 0,
        row.escalation_pct || 0, row.rent_free_months || 0, FREQ[row.payment_freq] ? row.payment_freq : 'quarterly', row.deposit || 0, row.key_money || 0, row.signed_at || null, row.notes || null,
        ctx.user ? ctx.user.id : null, now(), steps.length ? JSON.stringify(steps) : null, mode, mode === 'pct' ? Math.min(100, row.service_pct || 0) : 0,
        row.vat_pct ?? null, row.vat_included ? 1 : 0, share ? 1 : 0, share ? row.revenue_pct : 0, share && row.min_guarantee > 0 ? row.min_guarantee : null, row.take_higher === false && share ? 0 : 1,
      ).lastInsertRowid);
      for (const u of ids) db.run('INSERT INTO lease_units (lease_id, unit_id) VALUES (?, ?)', id, u);
      if (share) {
        db.run(`INSERT INTO turnover_terms (lease_id, pct, breakpoint_type, breakpoint, frequency, due_day, annual_recon, audit_rights, updated_at) VALUES (?, ?, ?, 0, 'monthly', 10, 1, 1, ?)
          ON CONFLICT(lease_id) DO UPDATE SET pct = excluded.pct, breakpoint_type = excluded.breakpoint_type, updated_at = excluded.updated_at`, id, row.revenue_pct, row.take_higher === false ? 'none' : 'natural', now());
      }
      const s = db.get('SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id WHERE s.id = ?', id);
      ctx.log('Drafted a lease', 'lease', id, brand.name);
      if (status === 'active') {
        activate(db, s, ctx, { from: row.bill_from || today(), depositReceived: row.deposit_received ?? null, keyReceived: row.key_money_received ?? null });
        ctx.log('Activated a lease', 'lease', id, `${s.ref} · ${brand.name}`);
      } else if (status !== 'draft') {
        db.run('UPDATE leases SET status = ? WHERE id = ?', status, id);
        ctx.log('Imported a past lease', 'lease', id, `${s.ref} · ${brand.name}`);
      }
      return id;
    },
    export: (db) => db.all('SELECT s.*, b.name brand_name FROM leases s JOIN brands b ON b.id = s.brand_id ORDER BY s.start_date, s.id').map((s) => {
      const st = TM.steps(s.escalation_steps);
      const share = !!s.revenue_share;
      return {
        $id: s.id, ref: s.ref, brand: s.brand_name, units: db.all('SELECT u.code FROM lease_units x JOIN units u ON u.id = x.unit_id WHERE x.lease_id = ? ORDER BY u.code', s.id).map((u) => u.code),
        status: s.status, start_date: s.start_date, term_years: s.term_years, end_date: s.end_date, rent_m2: s.rent_m2, terrace_rent_m2: s.terrace_rent_m2, escalation_pct: s.escalation_pct,
        ...Object.fromEntries([1, 2, 3].flatMap((n) => [[`esc_from_${n}`, st[n - 1] ? st[n - 1].from : null], [`esc_pct_${n}`, st[n - 1] ? st[n - 1].pct : null]])),
        service_mode: s.service_mode || 'm2', service_m2: s.service_m2, service_pct: s.service_mode === 'pct' ? s.service_pct : null, vat_pct: s.vat_pct, vat_included: !!s.vat_included,
        revenue_share: share, revenue_pct: share ? s.revenue_pct : null, min_guarantee: share ? s.min_guarantee : null, take_higher: share ? !!s.take_higher : null,
        rent_free_months: s.rent_free_months, payment_freq: s.payment_freq, deposit: s.deposit, key_money: s.key_money, signed_at: s.signed_at, notes: s.notes,
        bill_from: null, deposit_received: null, key_money_received: null,
      };
    }),
    // a lease is its units, its terms for turnover rent and the invoices the import made
    snapshot: (db, id) => {
      const s = db.get('SELECT * FROM leases WHERE id = ?', id);
      if (!s) return null;
      const units = M.leaseUnits(db, id).map((u) => ({ id: u.id, status: u.status, hold_until: u.hold_until, hold_lead_id: u.hold_lead_id }));
      return { lease: s, units, invoices: db.all('SELECT id, status FROM invoices WHERE lease_id = ?', id) };
    },
    restore: (db, snap) => {
      const keep = new Set(snap.invoices.map((i) => i.id));
      for (const inv of db.all('SELECT * FROM invoices WHERE lease_id = ?', snap.lease.id)) {
        if (keep.has(inv.id)) {
          const was = snap.invoices.find((i) => i.id === inv.id);
          if (was.status !== 'void' && inv.status === 'void') { db.run('UPDATE invoices SET status = ? WHERE id = ?', was.status, inv.id); if (h.ledger && h.ledger.postInvoice) h.ledger.postInvoice(db.get('SELECT * FROM invoices WHERE id = ?', inv.id)); }
          continue;
        }
        dropInvoice(db, inv);
      }
      const cols = Object.keys(snap.lease).filter((k) => k !== 'id');
      db.run(`UPDATE leases SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...cols.map((k) => snap.lease[k]), snap.lease.id);
      for (const u of snap.units) db.run('UPDATE units SET status = ?, hold_until = ?, hold_lead_id = ? WHERE id = ?', u.status, u.hold_until, u.hold_lead_id, u.id);
    },
    remove: (db, id) => {
      const units = M.leaseUnits(db, id);
      for (const inv of db.all('SELECT * FROM invoices WHERE lease_id = ?', id)) dropInvoice(db, inv);
      db.run('DELETE FROM turnover_terms WHERE lease_id = ?', id);
      db.run('DELETE FROM lease_units WHERE lease_id = ?', id);
      db.run('DELETE FROM leases WHERE id = ?', id);
      for (const u of units) {
        if (u.status !== 'leased') continue;
        const other = db.get("SELECT s.id FROM lease_units x JOIN leases s ON s.id = x.lease_id WHERE x.unit_id = ? AND s.status = 'active'", u.id);
        if (!other) db.run("UPDATE units SET status = 'available', updated_at = ? WHERE id = ?", now(), u.id);
      }
    },
    uses: (db, id, o) => {
      const out = imports.usesOf('leases', id, { ...o, ignore: ['invoices', 'lease_units', 'turnover_terms'], entity: 'lease' });
      const paid = db.value("SELECT COUNT(*) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.lease_id = ? AND COALESCE(p.note, '') != 'Received before go-live'", id);
      if (paid) out.push({ n: paid, what: L('payments', 'مدفوعات') });
      for (const inv of db.all('SELECT id FROM invoices WHERE lease_id = ?', id)) for (const u of imports.usesOf('invoices', inv.id, { ignore: ['payments'], entity: 'invoice' })) out.push(u);
      return out;
    },
    link: (id) => `/admin/leases/${id}`,
    label: (v, names) => `${v.ref || ''}${v.ref && names.brand ? ' · ' : ''}${names.brand || ''}`,
    examples: [
      { ref: 'C-2023-014', brand: 'Maison Lune', units: ['G01', 'G02'], status: 'active', start_date: '2024-01-01', term_years: 5, rent_m2: 1500, escalation_pct: 10, service_m2: 140, payment_freq: 'quarterly', deposit: 360000, signed_at: '2023-11-20', bill_from: '2026-12-01' },
      { ref: 'C-2025-031', brand: 'Kahwa House', units: ['G04'], status: 'active', start_date: '2025-06-01', term_years: 6, rent_m2: 1350, escalation_pct: 8, esc_from_1: 4, esc_pct_1: 10, service_mode: 'pct', service_pct: 10, revenue_share: true, revenue_pct: 8, min_guarantee: 300000, take_higher: true, payment_freq: 'monthly', deposit: 900000, deposit_received: 600000 },
      { ref: 'C-2019-007', brand: 'Atelier Nour', units: ['G08'], status: 'ended', start_date: '2019-02-01', term_years: 5, rent_m2: 900, escalation_pct: 7, end_date: '2024-01-31' },
    ],
  });
  // an invoice the import created goes, with its entries in the books
  function dropInvoice(db, inv) {
    for (const p of db.all('SELECT id FROM payments WHERE invoice_id = ?', inv.id)) {
      if (h.ledger) try { h.ledger.unpost(`pay:${p.id}`, { memo: 'Excel import undone' }); } catch { /* nothing posted */ }
      db.run('DELETE FROM payments WHERE id = ?', p.id);
    }
    if (h.ledger) try { h.ledger.unpost(`inv:${inv.id}`, { memo: `Invoice ${inv.ref}: Excel import undone` }); } catch { /* nothing posted */ }
    db.run('UPDATE cheques SET invoice_id = NULL WHERE invoice_id = ?', inv.id);
    db.run('DELETE FROM invoices WHERE id = ?', inv.id);
  }

  // ======================================================================== service contracts
  imports.register({
    key: 'service-contracts',
    module: '/admin/contracts',
    pages: ['/admin/contracts'],
    area: 'records',
    order: 10,
    icon: 'contract',
    table: 'contracts',
    title: L('Service contracts', 'عقود الخدمات'),
    summary: L('The mall’s own contracts with suppliers: security, cleaning, lifts, insurance… with dates, notice and value.', 'عقود المول مع الموردين: الأمن والنظافة والمصاعد والتأمين… بالتواريخ ومدة الإخطار والقيمة.'),
    notes: L('A row with a contract number already in the system updates that contract; rows without one become new contracts. Renewal and notice reminders follow the dates you give.', 'الصف الذي يحمل رقم عقد موجودًا في النظام يحدّث ذلك العقد؛ والصفوف بلا رقم تصبح عقودًا جديدة. تذكيرات التجديد والإخطار تتبع التواريخ المدخلة.'),
    allowed: (req) => h.can(req, 'manager'),
    keys: ['ref'],
    columns: [
      { key: 'ref', label: L('Contract number', 'رقم العقد'), type: 'code', max: 30, width: 15, keepOnUpdate: true, aliases: ['contract no', 'رقم العقد'], help: L('Your number, or empty for the office to number it (SC-…).', 'رقمك، أو اتركه فارغًا ليرقّمه النظام.') },
      { key: 'title', label: L('Contract', 'العقد'), type: 'text', required: true, max: 160, width: 28, example: 'Security guarding 2026', aliases: ['title', 'service', 'description', 'الخدمة'] },
      { key: 'counterparty', label: L('Supplier', 'المورد'), type: 'text', required: true, max: 160, width: 24, example: 'Falcon Security', aliases: ['vendor', 'counterparty', 'company', 'الشركة', 'الطرف الآخر'] },
      { key: 'kind', label: L('Type', 'النوع'), type: 'enum', enum: () => opts(records.KINDS), width: 20, example: 'security', help: L('Empty means Other.', 'الفارغ يعني «أخرى».') },
      { key: 'status', label: L('Status', 'الحالة'), type: 'enum', enum: () => opts(records.STATUS), width: 13, example: 'active', help: L('Empty means Active.', 'الفارغ يعني «ساري».') },
      { key: 'start_date', label: L('Start date', 'تاريخ البداية'), type: 'date', required: true, width: 14, example: '2026-01-01' },
      { key: 'end_date', label: L('End date', 'تاريخ النهاية'), type: 'date', width: 14, example: '2026-12-31', help: L('Empty: open-ended.', 'الفارغ: مفتوح المدة.') },
      { key: 'notice_days', label: L('Notice (days)', 'مدة الإخطار (أيام)'), type: 'int', min: 0, maxValue: 730, width: 12, example: 60, help: L('Empty: 60 days.', 'الفارغ: ٦٠ يومًا.') },
      { key: 'auto_renew', label: L('Renews by itself', 'يتجدد تلقائيًا'), type: 'bool', width: 13 },
      { key: 'value', label: L('Value', 'القيمة'), type: 'money', width: 14, example: 85000 },
      { key: 'billing', label: L('Value is', 'دورية القيمة'), type: 'enum', enum: () => opts(records.BILLING), width: 14, example: 'monthly', help: L('How often the value above is paid. Empty: monthly.', 'دورية سداد القيمة. الفارغ: شهريًا.') },
      { key: 'owner', label: L('Managed by (email)', 'المسؤول (البريد)'), type: 'ref', width: 24, ref: { list: userChoices, what: L('Office accounts', 'حسابات المكتب') } },
      { key: 'contact_name', label: L('Their contact', 'جهة الاتصال لديهم'), type: 'text', max: 120, width: 20 },
      { key: 'contact_phone', label: L('Contact phone', 'هاتف جهة الاتصال'), type: 'phone', width: 16 },
      { key: 'contact_email', label: L('Contact email', 'بريد جهة الاتصال'), type: 'email', width: 24 },
      { key: 'notes', label: L('Notes', 'ملاحظات'), type: 'text', max: 2000, multiline: true, width: 30 },
    ],
    rowCheck(row, ctx) {
      if (!ctx.id && row.ref && systemRef('SC').test(row.ref)) ctx.error('ref', 'imp1|{ref} looks like a number the office gives, but no contract has it. Leave it empty, or use your own number.', { ref: row.ref });
      if (row.end_date && row.start_date && row.end_date < row.start_date) ctx.error('end_date', 'imp1|The end is before the start.');
    },
    apply(row, ctx) {
      const { db } = ctx;
      const c = {
        title: row.title, counterparty: row.counterparty, kind: row.kind || 'other', status: row.status || 'active', start_date: row.start_date, end_date: row.end_date || null,
        notice_days: row.notice_days ?? 60, auto_renew: row.auto_renew ? 1 : 0, value: row.value || 0, billing: row.billing || 'monthly', owner_id: row.owner || null,
        contact_name: row.contact_name || null, contact_phone: row.contact_phone || null, contact_email: row.contact_email || null, notes: row.notes || null,
      };
      if (!ctx.id) {
        const ref = row.ref || db.nextRef('contracts', 'SC', 3, true);
        const id = Number(db.run(`INSERT INTO contracts (ref, title, counterparty, kind, status, start_date, end_date, notice_days, auto_renew, value, billing, owner_id, contact_name, contact_phone, contact_email, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ref, c.title, c.counterparty, c.kind, c.status, c.start_date, c.end_date, c.notice_days, c.auto_renew, c.value, c.billing, c.owner_id,
        c.contact_name, c.contact_phone, c.contact_email, c.notes, now(), now()).lastInsertRowid);
        ctx.log('Created a contract', 'contract', id, `${ref} · ${c.counterparty}`);
        return id;
      }
      const old = db.get('SELECT ref FROM contracts WHERE id = ?', ctx.id);
      db.run('UPDATE contracts SET title = ?, counterparty = ?, kind = ?, status = ?, start_date = ?, end_date = ?, notice_days = ?, auto_renew = ?, value = ?, billing = ?, owner_id = ?, contact_name = ?, contact_phone = ?, contact_email = ?, notes = ?, updated_at = ? WHERE id = ?',
        c.title, c.counterparty, c.kind, c.status, c.start_date, c.end_date, c.notice_days, c.auto_renew, c.value, c.billing, c.owner_id, c.contact_name, c.contact_phone, c.contact_email, c.notes, now(), ctx.id);
      ctx.log('Edited a contract', 'contract', ctx.id, `${old.ref} · ${c.counterparty}`);
      return ctx.id;
    },
    export: (db) => db.all('SELECT c.*, u.email owner_email FROM contracts c LEFT JOIN users u ON u.id = c.owner_id ORDER BY c.id').map((c) => ({
      $id: c.id, ref: c.ref, title: c.title, counterparty: c.counterparty, kind: c.kind, status: c.status, start_date: c.start_date, end_date: c.end_date, notice_days: c.notice_days,
      auto_renew: !!c.auto_renew, value: c.value, billing: c.billing, owner: c.owner_email, contact_name: c.contact_name, contact_phone: c.contact_phone, contact_email: c.contact_email, notes: c.notes,
    })),
    uses: (db, id, o) => imports.usesOf('contracts', id, { ...o, entity: 'contract' }),
    link: (id) => `/admin/contracts/${id}`,
    label: (v) => `${v.ref ? `${v.ref} · ` : ''}${v.counterparty || v.title || ''}`,
    examples: [
      { title: 'Security guarding 2026', counterparty: 'Falcon Security', kind: 'security', status: 'active', start_date: '2026-01-01', end_date: '2026-12-31', notice_days: 60, auto_renew: false, value: 185000, billing: 'monthly', contact_name: 'Hesham Fouad', contact_phone: '01001234567' },
      { title: 'Lifts and escalators maintenance', counterparty: 'Schindler Egypt', kind: 'elevators', status: 'active', start_date: '2025-07-01', end_date: '2027-06-30', notice_days: 90, auto_renew: true, value: 240000, billing: 'quarterly' },
    ],
  });
};
