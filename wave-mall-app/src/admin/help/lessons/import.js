'use strict';

// Import from Excel: the import centre and its templates, importing contracts from a workbook of
// your own (column matching, the check, problems, valid rows only), and updating records from the
// "with current data" workbook, then undoing an import from the history.

const ExcelJS = require('exceljs');

// a contracts workbook the way a mall keeps it: a title row, its own column titles (in the
// lesson's language), one row with a unit that does not exist
async function contractsBook({ h, lang }) {
  const t = h.M.today();
  const y = Number(t.slice(0, 4));
  const ar = lang === 'ar';
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(ar ? 'عقود 2026' : 'Contracts 2026', { views: [{ rightToLeft: ar }] });
  ws.addRow([ar ? 'ذا ويف — عقود المستأجرين عند بدء التشغيل' : 'The Wave — tenant contracts at go-live']);
  ws.addRow(ar
    ? ['رقم العقد', 'المستأجر', 'المحل', 'الحالة', 'تاريخ البداية', 'المدة (بالسنوات)', 'الإيجار للمتر شهريًا', 'الزيادة السنوية (%)', 'الخدمات للمتر شهريًا', 'إصدار الفواتير', 'مبلغ التأمين', 'ملاحظاتنا']
    : ['Contract No', 'Tenant', 'Shop', 'Status', 'Start date', 'Term (years)', 'Rent per m² a month', 'Yearly increase (%)', 'Service per m² a month', 'Invoiced', 'Security deposit', 'Our remarks']);
  const date = (yy, m, d) => new Date(Date.UTC(yy, m - 1, d));
  ws.addRow(['C-2024-101', 'Ember Grill', 'G03', ar ? 'ساري' : 'Active', date(y - 2, 1, 1), 5, 1400, 10, 140, ar ? 'ربع سنوي مقدمًا' : 'Quarterly in advance', 300000, ar ? 'تجديد تلقائي' : 'Auto renewal']);
  ws.addRow(['C-2025-102', 'Habibi Gelato', 'G06, G07', ar ? 'ساري' : 'Active', date(y - 1, 6, 1), 6, '1,350', '8%', 120, ar ? 'شهريًا مقدَّمًا' : 'Monthly in advance', '400,000', '']);
  ws.addRow(['C-2018-007', 'Atelier Nour', 'S03', ar ? 'منتهٍ' : 'Ended', '01/02/2018', 5, 900, 7, 100, '', 0, '']);
  ws.addRow(['C-2024-103', 'Cotton Trail', 'Z99', ar ? 'مسودة' : 'Draft', `01/01/${y + 1}`, 2, 1000, 5, '', '', 0, '']);
  ws.getColumn(5).numFmt = 'dd/mm/yyyy';
  return { name: ar ? 'عقود-المستأجرين.xlsx' : 'tenant-contracts.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

// the brands workbook "with current data", with two brands changed in Excel
async function brandsBook({ h, lang }) {
  const d = h.imports.get('brands');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await h.imports.template(d, { lang, withData: true }));
  const ws = wb.worksheets[0];
  const col = (key) => {
    const label = d.columns.find((c) => c.key === key).label[lang];
    let at = 0;
    ws.getRow(1).eachCell((c, n) => { if (String(c.text || '').replace(/\s*\*$/, '').trim() === label) at = n; });
    return at;
  };
  const name = col('name');
  const site = col('website');
  const changes = { 'Maison Lune': 'https://maisonlune.com', 'Kahwa House': 'https://kahwahouse.com' };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = changes[String(row.getCell(name).text || '').trim()];
    if (v) row.getCell(site).value = v;
  });
  return { name: lang === 'ar' ? 'العلامات-التجارية.xlsx' : 'brands.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

// both lessons import, then undo: start each recording from the sample data as it was
const reset = ({ db, h }) => {
  db.run('DELETE FROM imp_batches');
  db.run("DELETE FROM settings WHERE key LIKE 'imp_map:%'");
  for (const ref of ['C-2024-101', 'C-2025-102', 'C-2018-007', 'C-2024-103']) {
    const s = db.get('SELECT id FROM leases WHERE ref = ?', ref);
    if (s) h.imports.get('leases').remove(db, s.id);
  }
};

module.exports = [
  {
    id: 'import-start',
    area: 'office',
    module: '/admin/import',
    also: ['/admin/import/history'],
    order: 70,
    roles: ['admin', 'management', 'all'],
    title: { en: 'Bringing your Excel data into the office', ar: 'نقل بياناتك من إكسل إلى المكتب' },
    summary: {
      en: 'Find the import centre, the order to import in, and the template for each kind of record: in English, in Arabic or with your current data.',
      ar: 'تعرّف على مركز الاستيراد، والترتيب الصحيح للاستيراد، والقالب الخاص بكل نوع من السجلات: بالعربية أو بالإنجليزية أو مع بياناتك الحالية.',
    },
    prepare: reset,
    steps: [
      { go: '/admin/import', say: { en: 'Import from Excel, under Office, brings what you keep in spreadsheets into the office: contracts, brands, employees and more.', ar: '«الاستيراد من إكسل»، ضمن «المكتب»، ينقل ما تحتفظ به في جداول البيانات إلى المكتب: العقود والعلامات التجارية والموظفين وغيرها.' } },
      { point: '.imp-hero__how', say: { en: 'Four steps: download a template, upload your file, check every row, then import. Every import can be undone.', ar: 'أربع خطوات: نزّل القالب، وارفع ملفك، وراجع كل صف، ثم استورد، ويمكن التراجع عن أي استيراد.' } },
      { point: '.imp-order', say: { en: 'Import in this order: each step can refer to the ones before it, like leases to their brands and units.', ar: 'استورد بهذا الترتيب، فكل خطوة تشير إلى ما قبلها، مثل العقود التي تشير إلى علاماتها التجارية ووحداتها.' } },
      { point: '.imp-item:has(a[href="/admin/import/units"])', say: { en: 'Each card shows how many records are already in the system and when they were last imported.', ar: 'تعرض كل بطاقة عدد السجلات الموجودة في النظام الآن، وموعد آخر استيراد لها.' } },
      { click: '.imp-item h3 a[href="/admin/import/leases"]', nav: true, say: { en: 'Open the one you need. Here, leases.', ar: 'افتح النوع الذي تحتاجه، وهنا عقود الإيجار.' } },
      { point: '.imp-tpl-col', say: { en: 'Download the template in English or in Arabic, or With current data to edit what is already here and import it back.', ar: 'نزّل القالب بالعربية أو بالإنجليزية، أو «مع البيانات الحالية» لتعدّل ما هو موجود وتعيد استيراده.' } },
      { say: { en: 'In the template, lists such as units and brands are dropdowns, each column title has a note, and there is an example sheet and a read-me sheet.', ar: 'في القالب، القوائم مثل الوحدات والعلامات التجارية قوائم منسدلة، وعلى عنوان كل عمود ملاحظة توضيحية، وفيه ورقة مثال وورقة تعليمات.' } },
      { point: 'table.imp-dict', say: { en: 'The columns are listed here too: which are required, which one finds an existing record, and the values allowed.', ar: 'والأعمدة مذكورة هنا أيضًا: المطلوب منها، والعمود الذي يجد السجل الموجود، والقيم المسموحة.' } },
      { point: '.imp-drop__zone', say: { en: 'When your file is ready, drop it here. Nothing is saved until you have checked every row.', ar: 'وعندما يجهز ملفك، أسقطه هنا، ولا يُحفظ أي شيء قبل أن تراجع كل الصفوف.' } },
    ],
  },
  {
    id: 'import-contracts',
    area: 'office',
    module: '/admin/import',
    also: ['/admin/leases', '/admin/brands', '/admin/hr', '/admin/units'],
    order: 71,
    roles: ['admin', 'management'],
    title: { en: 'Importing your contracts from Excel', ar: 'استيراد عقودك من إكسل' },
    summary: {
      en: 'Upload your own contracts sheet, match its columns, check every row, see the problems, and import the good rows.',
      ar: 'ارفع جدول عقودك كما هو، وطابق أعمدته، وراجع كل صف، واطّلع على المشكلات، ثم استورد الصفوف السليمة.',
    },
    prepare: reset,
    steps: [
      { go: '/admin/leases', say: { en: 'Every list that can be filled from Excel has an Import from Excel button.', ar: 'كل قائمة يمكن تعبئتها من إكسل فيها زر «استيراد من إكسل».' } },
      { click: 'a[href="/admin/import/leases"]', nav: true, say: { en: 'On Leases, choose it.', ar: 'في «العقود»، اضغط عليه.' } },
      { upload: ['.imp-drop__zone', contractsBook], nav: true, say: { en: 'Drop your workbook here. This is the mall\'s own contracts sheet, with its own column titles.', ar: 'أسقط ملفك هنا. هذا جدول العقود الخاص بالمول، بعناوين أعمدته كما هي.' } },
      { point: 'table.imp-map', say: { en: 'The office reads your column titles and matches each one to a field. Green is sure; blue is likely.', ar: 'يقرأ المكتب عناوين أعمدتك ويطابق كل عنوان بحقل؛ الأخضر مؤكد، والأزرق مرجّح.' } },
      { point: 'table.imp-map tr:has(select[name=col_2])', say: { en: 'Shop was matched to Units: that is right, so leave it.', ar: '«المحل» طوبق مع «الوحدات»، وهذا صحيح، فاتركه.' } },
      { select: ['select[name=col_11]', ''], say: { en: 'Our remarks is not needed: choose Don\'t import.', ar: 'و«ملاحظاتنا» لا نحتاجها، فاختر «لا تستورد».' } },
      { click: 'form[action$="/map"] button.btn--primary', nav: true, say: { en: 'The choices are remembered for next time. Check the rows.', ar: 'تُحفظ اختياراتك للمرة القادمة. اضغط «راجع الصفوف».' } },
      { point: '.imp-sum', say: { en: 'Before anything is saved: three new contracts, and one row with a problem.', ar: 'قبل حفظ أي شيء: ثلاثة عقود جديدة، وصف واحد به مشكلة.' } },
      { point: 'table.imp-rows tr:has(.imp-msgs--err)', say: { en: 'Each problem says the row, the column and why: unit Z99 is not in the system.', ar: 'كل مشكلة تذكر الصف والعمود والسبب: هنا وحدة غير موجودة في النظام.' } },
      { point: '.imp-side-actions a[href*="errors.xlsx"]', say: { en: 'Download the problems marked in your own workbook, fix them in Excel and upload again.', ar: 'نزّل المشكلات معلَّمة في ملفك نفسه، وأصلحها في إكسل ثم ارفعه من جديد.' } },
      { select: ['select[name=mode]', 'valid'], say: { en: 'Or import the good rows now and skip the rest.', ar: 'أو استورد الصفوف السليمة الآن وتجاوز الباقي.' } },
      { click: 'button[data-imp-commit]', nav: true, say: { en: 'Import. Everything is saved in one go.', ar: 'اضغط «استيراد»، ويُحفظ كل شيء دفعة واحدة.' } },
      { point: '.imp-done', say: { en: 'Done: the new contracts are listed with links, and the import can be undone for fourteen days.', ar: 'تم: العقود الجديدة معروضة بروابطها، ويمكن التراجع عن الاستيراد خلال أربعة عشر يومًا.' } },
    ],
  },
  {
    id: 'import-update-undo',
    area: 'office',
    module: '/admin/import/history',
    also: ['/admin/import', '/admin/brands'],
    order: 72,
    roles: ['admin', 'management'],
    title: { en: 'Updating records from Excel, and undoing an import', ar: 'تحديث السجلات من إكسل والتراجع عن استيراد' },
    summary: {
      en: 'Edit your current data in Excel and import it back to update records, see exactly what changes, then undo an import from the history.',
      ar: 'عدّل بياناتك الحالية في إكسل وأعد استيرادها لتحديث السجلات، واطّلع على ما سيتغير بالضبط، ثم تراجع عن استيراد من السجل.',
    },
    prepare: reset,
    steps: [
      { go: '/admin/import/brands', say: { en: 'To change many records at once, start from your current data.', ar: 'لتعديل سجلات كثيرة دفعة واحدة، ابدأ من بياناتك الحالية.' } },
      { point: '.imp-tpl-col a[href*="/export/data.xlsx"]', say: { en: 'With current data downloads every brand in the template. Change what you need in Excel.', ar: '«مع البيانات الحالية» ينزّل كل العلامات التجارية في القالب، فعدّل ما تحتاجه في إكسل.' } },
      { upload: ['.imp-drop__zone', brandsBook], nav: true, say: { en: 'Then upload it. Here, two brands have a new website.', ar: 'ثم ارفعه. هنا تغيّر الموقع الإلكتروني لعلامتين.' } },
      { point: '.imp-sum', say: { en: 'Rows that match a brand already here are updates; the rest are unchanged and left alone.', ar: 'الصفوف المطابقة لعلامة موجودة تُعد تحديثًا، والباقي دون تغيير ويبقى كما هو.' } },
      { point: 'table.imp-rows tr:has(.imp-diffs)', say: { en: 'Each update shows what the field was and what it becomes.', ar: 'يعرض كل تحديث قيمة الحقل قبل التعديل وبعده.' } },
      { click: 'button[data-imp-commit]', nav: true, say: { en: 'Import the changes.', ar: 'استورد التعديلات.' } },
      { go: '/admin/import/history', say: { en: 'All imports keeps every batch: what, which file, who and when.', ar: 'وصفحة «كل عمليات الاستيراد» تحتفظ بكل دفعة: ماذا، ومن أي ملف، ومن قام بها ومتى.' } },
      { click: 'tr[data-href^="/admin/import/b/"]', nav: true, say: { en: 'Open one to see what it added and changed.', ar: 'افتح إحداها لترى ما أضافته وما غيّرته.' } },
      { point: 'form[action$="/undo"]', say: { en: 'Undo puts updated records back as they were and removes new ones, unless something already uses them.', ar: '«تراجع عن هذا الاستيراد» يعيد السجلات المحدَّثة كما كانت ويحذف الجديدة، ما لم يكن هناك ما يستخدمها.' } },
      { click: 'form[action$="/undo"] button', say: { en: 'Confirm, and the import is undone.', ar: 'أكّد، فيتم التراجع عن الاستيراد.' } },
      { point: '.imp-done', say: { en: 'The record of the import stays, marked as undone.', ar: 'ويبقى سجل الاستيراد، معلَّمًا بأنه تم التراجع عنه.' } },
    ],
  },
];
