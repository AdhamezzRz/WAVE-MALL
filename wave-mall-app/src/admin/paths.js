'use strict';

// Where the leasing office keeps its data (the database and the uploaded files).
// DATA_DIR may start with ~ (the hosting account's home folder), so nobody has to know their
// username: DATA_DIR=~/wave-data. If the folder cannot be created (a placeholder username, a home
// folder that is not ours), the same folder name in this account's real home is used instead, and
// the log says so. Without DATA_DIR the data stays in ./data next to the app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chosen = new Map();

function expand(dir) {
  const home = os.homedir();
  return String(dir).trim().replace(/^~(?=$|[\\/])/, home).replace(/^\$HOME(?=$|[\\/])/, home).replace(/^\$\{HOME\}(?=$|[\\/])/, home);
}

function dataDir(env = process.env) {
  const given = env.DATA_DIR;
  if (!given) {
    const dir = path.join(__dirname, '..', '..', 'data');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (chosen.has(given)) return chosen.get(given);
  const dir = expand(given);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    chosen.set(given, dir);
    return dir;
  } catch (err) {
    const fallback = path.join(os.homedir(), path.basename(dir) || 'wave-data');
    if (path.resolve(fallback) === path.resolve(dir)) throw err;
    try {
      fs.mkdirSync(fallback, { recursive: true });
      fs.accessSync(fallback, fs.constants.W_OK);
    } catch {
      throw err;
    }
    console.warn(`[admin] DATA_DIR ${given} cannot be used (${err.code || err.message}); using ${fallback} instead. Set DATA_DIR=~/${path.basename(fallback)} to silence this.`);
    chosen.set(given, fallback);
    return fallback;
  }
}

module.exports = { dataDir, expand };
