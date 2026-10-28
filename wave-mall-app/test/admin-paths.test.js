'use strict';

// Where the office keeps its data: ~ means the hosting account's home, and a DATA_DIR that cannot
// be created (a placeholder username, say) falls back to the same folder name in the real home.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('paths: DATA_DIR with ~, and a fallback when the folder cannot be created', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-home-'));
  const saved = process.env.HOME;
  const warn = console.warn;
  const warnings = [];
  process.env.HOME = home;
  console.warn = (m) => warnings.push(m);
  try {
    delete require.cache[require.resolve('../src/admin/paths')];
    const { dataDir } = require('../src/admin/paths');
    assert.equal(dataDir({ DATA_DIR: '~/wave-data' }), path.join(home, 'wave-data'));
    assert.ok(fs.statSync(path.join(home, 'wave-data')).isDirectory());
    assert.equal(warnings.length, 0);

    // a path under a plain file can never be created: like /home/u123456789/wave-data on a host
    const blocker = path.join(home, 'not-a-folder');
    fs.writeFileSync(blocker, '');
    assert.equal(dataDir({ DATA_DIR: path.join(blocker, 'office-data') }), path.join(home, 'office-data'));
    assert.match(warnings[0], /cannot be used/);

    // the database and the files follow the same folder
    const { store } = require('../src/admin/files');
    assert.equal(store({ DATA_DIR: path.join(blocker, 'office-data') }).dir, path.join(home, 'office-data', 'files'));
  } finally {
    process.env.HOME = saved;
    console.warn = warn;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
