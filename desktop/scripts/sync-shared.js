// The desktop app reuses the website's broadcaster code. Copy it into the
// renderer so both always run the same version (renderer/shared is not
// committed; this runs before start, test and dist).
const fs = require('fs');
const path = require('path');

const SHARED_FILES = ['server-wake.js', 'clip-buffer.js', 'clip-recorder.js', 'broadcast-session.js'];
const from = path.join(__dirname, '..', '..', 'public', 'js');
const to = path.join(__dirname, '..', 'renderer', 'shared');

fs.mkdirSync(to, { recursive: true });
for (const file of SHARED_FILES) fs.copyFileSync(path.join(from, file), path.join(to, file));
console.log(`sync: copied ${SHARED_FILES.length} shared scripts from public/js`);
