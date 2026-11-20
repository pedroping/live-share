// The list of saved clips, kept as a JSON file next to the clip videos.
const fs = require('fs');
const { CLIP_INDEX_FILE } = require('./config');

function listClips(limit = 0) {
  let clips = [];
  try {
    clips = JSON.parse(fs.readFileSync(CLIP_INDEX_FILE, 'utf8'));
  } catch {
    // No clips yet (or unreadable file): start empty.
  }
  return limit > 0 ? clips.slice(0, limit) : clips;
}

// Newest first.
function saveClip(clip) {
  const clips = listClips();
  clips.unshift(clip);
  fs.writeFileSync(CLIP_INDEX_FILE, JSON.stringify(clips, null, 2));
}

module.exports = { listClips, saveClip };
