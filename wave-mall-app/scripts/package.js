'use strict';

// Builds the Hostinger "upload archive" deploy (it runs npm install itself), without node_modules:
//   release/the-wave-website.zip            everything, help videos included
//   release/the-wave-website-no-videos.zip  the same without the help videos (a smaller upload)
//   release/the-wave-help-videos.zip        just the help videos: unzip it in the app's folder
//                                           (it holds public/admin/help-media/...)
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'release');
fs.mkdirSync(out, { recursive: true });

const include = ['server.js', 'package.json', 'package-lock.json', 'README.md', '.gitlab-ci.yml', 'src', 'public', 'scripts', 'test'];
const media = 'public/admin/help-media';
const junk = ['-x', '*.DS_Store', '-x', '__MACOSX/*'];
const build = (name, files, extra = []) => {
  const zip = path.join(out, name);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', zip, ...files, ...junk, ...extra], { cwd: root, stdio: 'inherit' });
  console.log('wrote', path.relative(process.cwd(), zip), `${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB`);
};
build('the-wave-website.zip', include);
// the manifest stays in the smaller zip: lessons whose video is missing show "being prepared"
build('the-wave-website-no-videos.zip', include, ['-x', `${media}/en/*`, '-x', `${media}/ar/*`]);
if (fs.existsSync(path.join(root, media))) build('the-wave-help-videos.zip', [media]);
