// The clip recorder is shared with the web broadcaster; copy it in so the
// desktop renderer and the website always run the same code.
const fs = require('fs');
const path = require('path');
const from = path.join(__dirname, '..', '..', 'public');
const to = path.join(__dirname, '..', 'renderer', 'shared');
fs.mkdirSync(to, { recursive: true });
for (const file of ['clip-buffer.js', 'clip-recorder.js', 'server-wake.js']) {
  fs.copyFileSync(path.join(from, file), path.join(to, file));
}
console.log('sync: copied shared scripts');
