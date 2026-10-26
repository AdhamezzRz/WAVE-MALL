'use strict';

// The document vault's file store. Files live outside the public folder, next to the database
// (DATA_DIR/files, or ADMIN_FILES), named by their SHA-256 so the same file is kept once.
// Only real PDFs, images and Office documents are accepted: the type is read from the file's
// first bytes, never trusted from its name.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 25 * 1024 * 1024;

const TYPES = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // Office files are zip archives; the name decides which one
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: true },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: true },
];
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

// What a buffer really is, or null.
function sniff(buf, name = '') {
  if (!buf || buf.length < 12) return null;
  const ext = String(name).toLowerCase().split('.').pop();
  for (const t of TYPES) {
    if (t.zip ? isZip(buf) && ext === t.ext : t.test(buf)) return t;
  }
  return null;
}

// A safe display name: no folders, no control characters, a sensible length.
function cleanName(name, ext) {
  let n = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  if (!n) n = `document.${ext}`;
  if (!n.toLowerCase().endsWith(`.${ext}`) && !(ext === 'jpg' && /\.jpe?g$/i.test(n))) n = `${n.replace(/\.[a-z0-9]{1,5}$/i, '')}.${ext}`;
  return n.slice(-160);
}

function store(env = process.env) {
  let dir = env.ADMIN_FILES;
  if (!dir) {
    if (env.ADMIN_DB === ':memory:') dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-files-'));
    else dir = path.join(env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'files');
  }
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    MAX_BYTES,
    // Saves a buffer and returns its facts, or { error } when it is not an accepted file.
    save(buf, name) {
      if (!buf || !buf.length) return { error: 'empty' };
      if (buf.length > MAX_BYTES) return { error: 'too_big' };
      const type = sniff(buf, name);
      if (!type) return { error: 'type' };
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const stored = `${sha256}.${type.ext}`;
      const file = path.join(dir, stored);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf, { mode: 0o600 });
      return { sha256, stored, mime: type.mime, size: buf.length, ext: type.ext, file_name: cleanName(name, type.ext) };
    },
    path: (stored) => {
      const p = path.join(dir, path.basename(String(stored)));
      return fs.existsSync(p) ? p : null;
    },
    // Removes a stored file once no document points to it any more.
    release(db, stored) {
      if (db.value('SELECT COUNT(*) FROM documents WHERE stored = ?', stored)) return;
      const p = path.join(dir, path.basename(String(stored)));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
  };
}

// A small but real PDF (A4, one page) for the sample data: a title and some lines in Helvetica.
function samplePdf(title, lines = []) {
  const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, '').replace(/([()\\])/g, '\\$1');
  const body = [
    'BT /F2 9 Tf 0.45 0.5 0.47 rg 56 790 Td (THE WAVE  |  NORTH 90, NEW CAIRO) Tj ET',
    '0.16 0.22 0.2 RG 1 w 56 774 m 539 774 l S',
    `BT /F2 20 Tf 0.12 0.16 0.15 rg 56 730 Td (${esc(title)}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 11 Tf 0.2 0.24 0.22 rg 56 ${696 - i * 20} Td (${esc(l)}) Tj ET`),
    'BT /F1 8 Tf 0.55 0.58 0.56 rg 56 60 Td (Sample document generated for the leasing office demo. Not a legal record.) Tj ET',
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { store, sniff, samplePdf, MAX_BYTES };
