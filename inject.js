// inject.js — replaces %%PLACEHOLDER%% values in index.html
// Works on Windows (CRLF) and Linux (LF) — no sed needed
const fs = require('fs');

const file = 'index.html';
let html = fs.readFileSync(file, 'utf8');

const replacements = {
  '%%LAMBDA_API_URL%%':        process.env.LAMBDA_API_URL,
  '%%FIREBASE_API_KEY%%':      process.env.FIREBASE_API_KEY,
  '%%FIREBASE_AUTH_DOMAIN%%':  process.env.FIREBASE_AUTH_DOMAIN,
  '%%FIREBASE_DATABASE_URL%%': process.env.FIREBASE_DATABASE_URL,
  '%%FIREBASE_PROJECT_ID%%':   process.env.FIREBASE_PROJECT_ID,
};

let missing = false;
for (const [placeholder, value] of Object.entries(replacements)) {
  if (!value) {
    console.error(`ERROR: Missing env var for ${placeholder}`);
    missing = true;
    continue;
  }
  const count = (html.match(new RegExp(placeholder.replace(/[%%]/g, '%'), 'g')) || []).length;
  html = html.replaceAll(placeholder, value);
  console.log(`✓ Replaced ${placeholder} (${count} occurrence${count !== 1 ? 's' : ''})`);
}

if (missing) {
  process.exit(1);
}

fs.writeFileSync(file, html, 'utf8');
console.log('✓ index.html injected successfully');