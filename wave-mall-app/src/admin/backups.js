'use strict';

// Automatic backups of the leasing office database.
//
// Every day (after the hour set in Settings, Cairo time) and whenever an administrator presses
// "Back up now", a consistent copy of the whole database is taken (node:sqlite: VACUUM INTO; sql.js:
// an export), checked (it must open and pass SQLite's quick check), compressed (.db.gz) and kept in
// DATA_DIR/backups (or BACKUP_DIR) for the number of days set in Settings. Then, when configured, a
// copy goes off the server:
//   - by email, as an attachment, to the addresses in Settings (SMTP_* as for all office email),
//     when it is under the size limit. Sent directly over SMTP, not through the outbox, so the
//     database never stores copies of itself.
//   - to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO…) with a signed
//     PUT (AWS Signature Version 4, node:crypto; no SDK): BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET,
//     BACKUP_S3_KEY, BACKUP_S3_SECRET, BACKUP_S3_REGION (and optionally BACKUP_S3_PREFIX).
// Each run is recorded in backup_runs (shown on the Settings page). Secrets only ever come from the
// environment.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const SCHEMA = `
  CREATE TABLE backup_runs (
    id INTEGER PRIMARY KEY, trigger TEXT NOT NULL DEFAULT 'daily', status TEXT NOT NULL DEFAULT 'running',
    file TEXT, bytes INTEGER, raw_bytes INTEGER, sha256 TEXT, tables INTEGER,
    email_status TEXT, email_detail TEXT, s3_status TEXT, s3_detail TEXT, removed INTEGER NOT NULL DEFAULT 0,
    error TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, cairo_date TEXT,
    started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE INDEX backup_runs_date ON backup_runs(cairo_date, trigger, status);
`;
const DEFAULTS = { backup_auto: '1', backup_hour: '3', backup_keep_days: '14', backup_email_to: '', backup_email_max_mb: '15' };
// backups/the-wave-2026-11-04-031500-daily.db.gz
const NAME_RE = /^the-wave-(\d{4}-\d{2}-\d{2})-(\d{6})-(daily|manual)\.db\.gz$/;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ---------- AWS Signature Version 4 ----------
// RFC 3986 encoding of each path segment, as S3 expects (slashes kept between segments).
const encodeKey = (p) => p.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// sigv4({ method, url, headers, payloadHash, region, service, accessKey, secretKey, date })
// → the headers to send, with x-amz-date, x-amz-content-sha256 and Authorization added. Every
// header passed in is signed (plus host). date: a Date (defaults to now).
function sigv4({ method, url, headers = {}, payloadHash, region, service = 's3', accessKey, secretKey, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])), host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, u.pathname || '/', query, names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  const out = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
  return { headers: out, signature, canonical, stringToSign: toSign };
}

function s3Config(env) {
  const bucket = String(env.BACKUP_S3_BUCKET || '').trim();
  const accessKey = String(env.BACKUP_S3_KEY || '').trim();
  const secretKey = String(env.BACKUP_S3_SECRET || '').trim();
  const region = String(env.BACKUP_S3_REGION || '').trim() || 'us-east-1';
  let endpoint = String(env.BACKUP_S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (!endpoint && env.BACKUP_S3_REGION) endpoint = `https://s3.${region}.amazonaws.com`;
  if (endpoint && !/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
  const prefix = String(env.BACKUP_S3_PREFIX ?? 'the-wave/').replace(/^\/+/, '');
  const ok = !!(bucket && accessKey && secretKey && endpoint);
  return { ok, bucket, accessKey, secretKey, region, endpoint, prefix };
}

// PUT a file into the bucket (path-style: endpoint/bucket/key, or {bucket} in the endpoint for
// virtual-hosted style). Resolves { ok, status, url, detail }.
async function s3Put(cfg, key, body, { fetchImpl = globalThis.fetch, contentType = 'application/gzip', date } = {}) {
  const url = cfg.endpoint.includes('{bucket}') ? `${cfg.endpoint.replace('{bucket}', cfg.bucket)}/${encodeKey(key)}` : `${cfg.endpoint}/${encodeKey(cfg.bucket)}/${encodeKey(key)}`;
  const signed = sigv4({ method: 'PUT', url, headers: { 'content-type': contentType }, payloadHash: sha256(body), region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey, date });
  const { host, ...send } = signed.headers; // fetch sets Host from the URL (the same value)
  void host;
  const res = await fetchImpl(url, { method: 'PUT', headers: send, body, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (res.ok) return { ok: true, status: res.status, url };
  const text = await res.text().catch(() => '');
  const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
  const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1];
  return { ok: false, status: res.status, url, detail: `HTTP ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`.slice(0, 300) };
}

// Cairo wall-clock parts of an instant
const CAIRO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function cairo(d = new Date()) {
  const p = Object.fromEntries(CAIRO.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), stamp: `${p.hour}${p.minute}${p.second}` };
}

// Can the copy be opened, and is it sound? node:sqlite runs SQLite's quick check; without it
// (sql.js on older Node) the file header and size are checked.
function verify(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('The copy is not a SQLite database');
  let Native = null;
  try {
    Native = require('node:sqlite').DatabaseSync;
  } catch {
    return { tables: null };
  }
  const db = new Native(file, { readOnly: true });
  try {
    const qc = db.prepare('PRAGMA quick_check').get();
    const v = qc && Object.values(qc)[0];
    if (v !== 'ok') throw new Error(`The copy failed SQLite's check: ${v}`);
    return { tables: db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get().n };
  } finally {
    db.close();
  }
}

function create({ db, env = process.env, log = console }) {
  db.ensure('backups-1', SCHEMA);
  const S = (k) => {
    const v = db.setting(k);
    return v === undefined || v === null ? DEFAULTS[k] : v;
  };
  const api = {
    fetch: (...a) => globalThis.fetch(...a),
    // email: replaced in tests; by default a nodemailer transport on the SMTP_* settings
    transport: null,
    busy: false,
  };

  api.dir = () => {
    if (env.BACKUP_DIR) return path.resolve(String(env.BACKUP_DIR).replace(/^~(?=$|[\\/])/, os.homedir()));
    if (db.file && db.file !== ':memory:') return path.join(path.dirname(db.file), 'backups');
    return path.join(os.tmpdir(), 'the-wave-backups');
  };
  api.settings = () => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, S(k)]));
  api.s3 = () => s3Config(env);
  api.smtp = () => !!env.SMTP_HOST;
  api.emails = () => String(S('backup_email_to') || '').split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)).slice(0, 5);

  // the local backups, newest first
  api.list = () => {
    let names = [];
    try {
      names = fs.readdirSync(api.dir());
    } catch {
      return [];
    }
    return names.filter((n) => NAME_RE.test(n)).map((name) => {
      const [, date, time, trigger] = name.match(NAME_RE);
      let st = null;
      try {
        st = fs.statSync(path.join(api.dir(), name));
      } catch {
        return null;
      }
      return { name, date, time: `${time.slice(0, 2)}:${time.slice(2, 4)}`, trigger, bytes: st.size, mtime: st.mtime.toISOString() };
    }).filter(Boolean).sort((a, b) => (a.name < b.name ? 1 : -1));
  };
  // a local backup by name (only names this module writes; never a path)
  api.file = (name) => (NAME_RE.test(String(name)) && fs.existsSync(path.join(api.dir(), name)) ? path.join(api.dir(), name) : null);

  function mailer() {
    if (api.transport) return api.transport;
    if (!api.smtp()) return null;
    const nodemailer = require('nodemailer');
    const port = Number(env.SMTP_PORT) || 465;
    api.transport = nodemailer.createTransport({
      host: env.SMTP_HOST, port, secure: port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      tls: env.SMTP_INSECURE === '1' ? { rejectUnauthorized: false } : undefined,
    });
    return api.transport;
  }

  // Delete local backups older than the number of days kept (the newest is always kept).
  api.rotate = (today = cairo().date) => {
    const keep = Math.max(1, Math.min(365, Number(S('backup_keep_days')) || 14));
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - keep * 86400000).toISOString().slice(0, 10);
    const list = api.list();
    let removed = 0;
    list.forEach((b, i) => {
      if (i === 0 || b.date >= cutoff) return;
      try {
        fs.rmSync(path.join(api.dir(), b.name), { force: true });
        removed++;
      } catch (err) {
        log.warn(`[admin] could not remove old backup ${b.name}: ${err.message}`);
      }
    });
    return removed;
  };

  // Take a backup now. trigger: 'daily' or 'manual'. Never throws: the run row says what happened.
  api.run = async ({ trigger = 'manual', user = null, now = new Date() } = {}) => {
    if (api.busy) return { busy: true };
    api.busy = true;
    const c = cairo(now);
    const id = Number(db.run('INSERT INTO backup_runs (trigger, user_id, cairo_date, started_at) VALUES (?, ?, ?, ?)', trigger === 'daily' ? 'daily' : 'manual', user ? user.id : null, c.date, now.toISOString()).lastInsertRowid);
    const done = (fields) => {
      const keys = Object.keys(fields);
      db.run(`UPDATE backup_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, finished_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), new Date().toISOString(), id);
      return db.get('SELECT * FROM backup_runs WHERE id = ?', id);
    };
    const dir = api.dir();
    const name = `the-wave-${c.date}-${c.stamp}-${trigger === 'daily' ? 'daily' : 'manual'}.db.gz`;
    const raw = path.join(dir, `.${name}.${process.pid}.tmp.db`);
    const gz = path.join(dir, `.${name}.${process.pid}.tmp.gz`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(raw, { force: true });
      db.backup(raw); // a consistent snapshot (VACUUM INTO / export)
      const { tables } = verify(raw);
      const rawBytes = fs.statSync(raw).size;
      await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 9 }), fs.createWriteStream(gz));
      fs.rmSync(raw, { force: true });
      const data = fs.readFileSync(gz);
      fs.renameSync(gz, path.join(dir, name));
      const row = { status: 'ok', file: name, bytes: data.length, raw_bytes: rawBytes, sha256: sha256(data), tables };

      // off-site: email
      const to = api.emails();
      const maxMb = Math.max(1, Number(S('backup_email_max_mb')) || 15);
      if (to.length) {
        const t = mailer();
        if (!t) Object.assign(row, { email_status: 'skipped', email_detail: 'SMTP is not configured' });
        else if (data.length > maxMb * 1048576) Object.assign(row, { email_status: 'skipped', email_detail: `The backup (${(data.length / 1048576).toFixed(1)} MB) is over the ${maxMb} MB email limit` });
        else {
          try {
            await t.sendMail({
              from: env.MAIL_FROM || env.SMTP_USER || 'leasing@thewavemall.com',
              to: to.join(', '),
              subject: `The Wave leasing office backup ${c.date}`,
              text: `The leasing office database as of ${c.date} ${c.stamp.slice(0, 2)}:${c.stamp.slice(2, 4)} (Cairo time) is attached: ${name}, ${(data.length / 1048576).toFixed(2)} MB, SHA-256 ${row.sha256}.\n\nIt holds every record of the office, including salaries: keep it somewhere private. To restore, unzip it and follow the steps under Settings → Backups.\n\nنسخة احتياطية من قاعدة بيانات مكتب التأجير مرفقة. احفظها في مكان آمن؛ فهي تحتوي على كل السجلات بما فيها الرواتب.`,
              attachments: [{ filename: name, content: data, contentType: 'application/gzip' }],
            });
            Object.assign(row, { email_status: 'sent', email_detail: to.join(', ') });
          } catch (err) {
            Object.assign(row, { email_status: 'failed', email_detail: String(err.message || err).slice(0, 300) });
          }
        }
      }
      // off-site: S3-compatible storage
      const cfg = s3Config(env);
      if (cfg.ok) {
        try {
          const r = await s3Put(cfg, `${cfg.prefix}${name}`, data, { fetchImpl: api.fetch });
          Object.assign(row, r.ok ? { s3_status: 'sent', s3_detail: `${cfg.bucket}/${cfg.prefix}${name}` } : { s3_status: 'failed', s3_detail: r.detail });
        } catch (err) {
          Object.assign(row, { s3_status: 'failed', s3_detail: String((err && err.cause && err.cause.message) || err.message || err).slice(0, 300) });
        }
      }
      row.removed = api.rotate(c.date);
      if (row.email_status === 'failed' || row.s3_status === 'failed') row.status = 'partial';
      return done(row);
    } catch (err) {
      for (const f of [raw, gz]) fs.rmSync(f, { force: true });
      log.error('[admin] backup failed:', err.message);
      return done({ status: 'failed', error: String(err.message || err).slice(0, 300) });
    } finally {
      api.busy = false;
    }
  };

  // The daily job: once a day, after the chosen hour (Cairo time), unless switched off.
  api.due = (now = new Date()) => {
    if (S('backup_auto') === '0') return false;
    const c = cairo(now);
    if (c.hour < Math.max(0, Math.min(23, Number(S('backup_hour')) || 0))) return false;
    return !db.get("SELECT 1 FROM backup_runs WHERE trigger = 'daily' AND cairo_date = ? AND status IN ('ok','partial','running')", c.date);
  };
  api.tick = async (now = new Date()) => (api.due(now) ? api.run({ trigger: 'daily', now }) : null);
  api.last = () => db.get("SELECT r.*, u.name user_name FROM backup_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.status != 'running' ORDER BY r.id DESC LIMIT 1");
  api.lastGood = () => db.get("SELECT * FROM backup_runs WHERE status IN ('ok','partial') ORDER BY id DESC LIMIT 1");
  api.runs = (n = 10) => db.all('SELECT r.*, u.name user_name FROM backup_runs r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?', n);
  return api;
}

module.exports = { create, sigv4, s3Put, s3Config, encodeKey, cairo, verify, NAME_RE, DEFAULTS };
