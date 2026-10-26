'use strict';

// Arabic for text the system stores in English: the sample office (demo.js), website enquiries
// and housekeeping (index.js record() and sweep()). Shown with tx() at display time.

const { plural } = require('./_util');

module.exports = {
  // ---------- team titles ----------
  'Head of leasing': 'رئيس قسم التأجير',
  'Senior leasing executive': 'أخصائي تأجير أول',
  'Leasing executive': 'أخصائي تأجير',

  // ---------- contact job titles ----------
  'Expansion director': 'مدير التوسع',
  Founder: 'المؤسس',
  'Retail manager': 'مدير التجزئة',
  'Operations director': 'مدير العمليات',
  'Creative director': 'المدير الإبداعي',
  'Managing partner': 'الشريك المدير',
  'Development manager': 'مدير التطوير',
  'Brand owner': 'مالك العلامة التجارية',
  'Regional manager': 'المدير الإقليمي',
  'Brand manager': 'مدير العلامة التجارية',
  'Co-founder': 'شريك مؤسس',
  'Franchise director': 'مدير الامتياز التجاري',
  CEO: 'الرئيس التنفيذي',
  'Expansion lead': 'مسؤول التوسع',
  Partner: 'شريك',
  'Store manager': 'مدير الفرع',
  'Development director': 'مدير التطوير العقاري',
  Buyer: 'مسؤول المشتريات',

  // ---------- brands ----------
  Egyptian: 'مصرية',

  // ---------- next steps and activities ----------
  'First call': 'المكالمة الأولى',
  'Send the brochure and floor plans': 'إرسال الكتيّب ومخططات الأدوار',
  'Site viewing': 'معاينة الموقع',
  'Site viewing, {code}': 'معاينة الموقع للوحدة {code}',
  'Follow up on the proposal': 'متابعة العرض المقدَّم',
  'Agree final terms': 'الاتفاق على الشروط النهائية',
  'Lease signature': 'توقيع العقد',
  'Reply to the website enquiry': 'الرد على استفسار الموقع الإلكتروني',
  'Replied to the website enquiry': 'تم الرد على استفسار الموقع الإلكتروني',
  'Intro call with {name}': 'مكالمة تعارف مع {name}',
  'Sent brochure, plans and unit schedule': 'أُرسل الكتيّب ومخططات الأدوار وجدول الوحدات',
  'Terms meeting at the leasing suite': 'اجتماع لمناقشة الشروط في مكتب التأجير',
  'Walked the plaza and the terraces. Liked the frontage onto the court.':
    'تجوّلنا في الساحة والتراسات، وأعجبتهم الواجهة المطلّة على الساحة المفتوحة.',
  'We are looking for {min}–{max} m² in New Cairo and love the terraces at The Wave.':
    'نبحث عن مساحة من {min} إلى {max} م² في القاهرة الجديدة، وتعجبنا التراسات في ذا ويف.',

  // ---------- offers and billing ----------
  'Signage per The Wave design guidelines. Trading hours 10:00–24:00.':
    'اللافتات وفق إرشادات التصميم الخاصة بذا ويف. ساعات العمل من 10:00 إلى 24:00.',
  'Security deposit': 'مبلغ التأمين',
  transfer: 'تحويل بنكي',

  // ---------- activity log ----------
  'Loaded sample data': 'تحميل البيانات التجريبية',
  '{leads} leads, {leases} leases': ({ leads, leases }) =>
    `${plural(leads, 'فرصة واحدة', 'فرصتان', '{n} فرص', '{n} فرصة')}، ${plural(leases, 'عقد واحد', 'عقدان', '{n} عقود', '{n} عقدًا')}`,
  'Website enquiry': 'استفسار من الموقع الإلكتروني',
  'Hold expired': 'انتهى الحجز المؤقت',
  'Offer expired': 'انتهت صلاحية العرض',
};
