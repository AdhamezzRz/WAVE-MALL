'use strict';

// Builds release/the-wave-website.zip: the app without node_modules, ready for
// Hostinger's "upload archive" deploy (it runs npm install itself).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'release');
const zip = path.join(out, 'the-wave-website.zip');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(zip, { force: true });

const include = ['server.js', 'package.json', 'package-lock.json', 'README.md', '.gitlab-ci.yml', 'src', 'public', 'scripts', 'test'];
execFileSync('zip', ['-r', '-q', '-X', zip, ...include, '-x', '*.DS_Store', '-x', '__MACOSX/*'], { cwd: root, stdio: 'inherit' });
console.log('wrote', path.relative(process.cwd(), zip), `${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB`);
