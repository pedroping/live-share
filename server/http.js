// HTTP side: the website, saved clip files, a health check, and the clips API.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PUBLIC_DIR, CLIPS_DIR, UPLOADS_DIR } = require('./config');
const { listClips, saveClip } = require('./clip-store');
const { renderClip } = require('./clip-renderer');
const { getClipRequest, completeClipRequest, failClipRequest } = require('./clip-requests');

const MAX_SEGMENTS = 40;
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 200 * 1024 * 1024, files: MAX_SEGMENTS } });

// The desktop app runs from file:// and calls the API cross-origin.
function allowCrossOrigin(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'X-Clip-Request, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// The broadcaster uploads the recorded segments for a clip request.
// Header X-Clip-Request: request id; form fields: videos[] (WebM segments,
// oldest first), startOffsetMs, segmentDurationsMs (JSON array).
async function uploadClip(req, res) {
  const files = req.files || [];
  const deleteUploads = () => files.forEach((f) => fs.rm(f.path, { force: true }, () => {}));
  const requestId = req.get('X-Clip-Request');
  const request = getClipRequest(requestId);

  if (!request) {
    deleteUploads();
    return res.status(404).json({ error: 'Pedido de clipe desconhecido ou expirado.' });
  }
  if (files.length === 0) {
    deleteUploads();
    failClipRequest(requestId, 'Nenhum vídeo recebido.');
    return res.status(400).json({ error: 'Nenhum vídeo recebido.' });
  }

  try {
    let durationsMs = [];
    try { durationsMs = JSON.parse(req.body.segmentDurationsMs || '[]'); } catch { /* use defaults */ }

    const id = crypto.randomBytes(8).toString('hex');
    const posterName = `${id}.jpg`;
    const videoName = await renderClip({
      files,
      durationsMs,
      startOffsetMs: Math.max(0, Number(req.body.startOffsetMs) || 0),
      duration: request.duration,
      outputBase: path.join(CLIPS_DIR, id),
      poster: path.join(CLIPS_DIR, posterName),
    });

    const clip = {
      url: `/media/${videoName}`,
      posterUrl: `/media/${posterName}`,
      code: request.roomCode,
      duration: request.duration,
      createdAt: new Date().toISOString(),
    };
    saveClip(clip);
    completeClipRequest(requestId, clip.url);
    res.json(clip);
  } catch (error) {
    console.error('Clip processing failed:', error);
    failClipRequest(requestId, 'Falha ao processar o clipe.');
    res.status(500).json({ error: 'Falha ao processar o clipe.' });
  } finally {
    deleteUploads();
  }
}

function createHttpApp() {
  const app = express();
  app.use(express.static(PUBLIC_DIR));
  app.use('/media', express.static(CLIPS_DIR, { maxAge: '7d' }));

  // Used by Render's health check and by pages to wake a sleeping server.
  app.get('/healthz', (req, res) => res.send('ok'));

  app.use('/api', allowCrossOrigin);
  app.get('/api/clips', (req, res) => {
    const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
    res.json({ clips: listClips(limit) });
  });
  app.post('/api/clips', upload.array('videos', MAX_SEGMENTS), uploadClip);

  return app;
}

module.exports = { createHttpApp };
