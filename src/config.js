'use strict';
// Runtime configuration from environment variables (or a .env file next to app.js).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (KEY=value, optional quotes). Real env vars win.
(function loadDotEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const env = process.env;
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));

const config = {
  ROOT,
  DATA_DIR,
  PROJECTS_DIR: path.join(DATA_DIR, 'projects'),
  FONTS_DIR: path.join(DATA_DIR, 'fonts'),
  APP_PASSWORD: env.APP_PASSWORD || '',
  SECRET_KEY: env.SECRET_KEY || 'dev-secret-change-me',
  BASE_URL: (env.BASE_URL || '').replace(/\/$/, ''),
  PORT: parseInt(env.PORT || '3000', 10),
  HOST: env.HOST || '0.0.0.0',
  AGENT_MAX_STEPS: parseInt(env.AGENT_MAX_STEPS || '80', 10),
  // Rendering: lower threads/preset on small hosting plans.
  RENDER_PRESET: env.RENDER_PRESET || 'veryfast',
  RENDER_THREADS: env.RENDER_THREADS || '0',
  TELEGRAM_DISABLED: env.TELEGRAM_DISABLED === '1',
};

for (const d of [config.DATA_DIR, config.PROJECTS_DIR, config.FONTS_DIR]) fs.mkdirSync(d, { recursive: true });

module.exports = config;
