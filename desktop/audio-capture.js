// Per-app audio capture, run in the main process.
//
// Wraps native/appaudio.exe (Windows process loopback, see AppAudio.cs):
// keeps one capture running for the chosen mode and forwards its raw PCM
// (48 kHz, stereo, 16-bit) to the renderer.
//
// Modes:
//   { type: 'off' }
//   { type: 'except-discord' }   all PC audio except Discord's process tree
//   { type: 'system' }           all PC audio (except this app, which plays nothing)
//   { type: 'include', pid }     only that app's process tree
//   { type: 'exclude', pid }     everything except that app's process tree
//   { type: 'window', hwnd }     only the app that owns the shared window
const { execFile, spawn } = require('child_process');
const path = require('path');

const DISCORD_EXECUTABLES = ['discord.exe', 'discordptb.exe', 'discordcanary.exe', 'discorddevelopment.exe'];
const RECHECK_MS = 5000;  // Discord can be opened/closed/restarted mid-stream
const BYTES_PER_FRAME = 4; // 2 channels x 16-bit

class AudioCapture {
  /**
   * @param {string} helperPath  path to appaudio.exe
   * @param {(channel:string, payload:any) => void} sendToRenderer
   */
  constructor(helperPath, sendToRenderer) {
    this.helperPath = helperPath;
    this.send = sendToRenderer;
    this.mode = { type: 'off' };
    this.process = null;
    this.target = null;              // "include:1234" currently being captured
    this.partialFrame = Buffer.alloc(0);
    this.recheckTimer = setInterval(() => this.recheck(), RECHECK_MS);
  }

  // ------------------------------------------------------------ helper queries

  /** Runs `appaudio <command>` and parses its JSON output ([] on failure). */
  query(command) {
    return new Promise((resolve) => {
      execFile(this.helperPath, [command], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
      });
    });
  }

  /** Running Discord root processes (each covers all its child processes). */
  async findDiscord() {
    const processes = await this.query('processes');
    return processes.filter((p) => DISCORD_EXECUTABLES.includes(p.name.toLowerCase()));
  }

  /** Apps worth offering in the audio menu: one entry per program with a window. */
  async listApps() {
    const hidden = new Set(['explorer.exe', 'svchost.exe', 'textinputhost.exe', 'applicationframehost.exe', 'systemsettings.exe']);
    const seen = new Set();
    const processes = await this.query('processes');
    return processes
      .filter((p) => (p.hasWindow || DISCORD_EXECUTABLES.includes(p.name.toLowerCase())) && !hidden.has(p.name.toLowerCase()))
      .filter((p) => p.pid !== process.pid)
      .filter((p) => {
        const name = p.name.toLowerCase();
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------ mode

  async setMode(mode) {
    this.mode = mode || { type: 'off' };
    await this.apply();
  }

  // Turns the mode into a concrete "include/exclude <pid>" capture.
  async apply() {
    const mode = this.mode;
    switch (mode.type) {
      case 'except-discord': {
        const discord = await this.findDiscord();
        if (discord.length === 0) {
          this.capture('exclude', process.pid, 'Todo o áudio do sistema (Discord não está aberto)');
        } else {
          // Windows can exclude one process tree; the oldest Discord process
          // is the parent of its voice and notification processes.
          const root = discord.sort((a, b) => a.pid - b.pid)[0];
          this.capture('exclude', root.pid, `Todo o áudio do sistema, exceto ${root.name}`);
        }
        break;
      }
      case 'system':
        this.capture('exclude', process.pid, 'Todo o áudio do sistema');
        break;
      case 'include':
        this.capture('include', mode.pid, `Só o áudio de ${mode.name || 'pid ' + mode.pid}`);
        break;
      case 'exclude':
        this.capture('exclude', mode.pid, `Todo o áudio, exceto ${mode.name || 'pid ' + mode.pid}`);
        break;
      case 'window': {
        const windows = await this.query('windows');
        const owner = windows.find((w) => String(w.hwnd) === String(mode.hwnd));
        if (owner) this.capture('include', owner.rootPid, `Só o áudio de ${owner.name}`);
        else this.send('audio:status', { ok: false, text: 'Não encontrei o app dessa janela.' });
        break;
      }
      default:
        this.stop();
    }
  }

  // Follow Discord/window owners that change, and restart a crashed capture.
  recheck() {
    const { type } = this.mode;
    if (type === 'except-discord' || type === 'window') this.apply();
    else if (type !== 'off' && !this.process) this.apply();
  }

  // ------------------------------------------------------------ the helper process

  capture(direction, pid, description) {
    const target = `${direction}:${pid}`;
    if (this.process && this.target === target) return; // already capturing that
    this.stop();

    const child = spawn(this.helperPath, ['capture', direction, String(pid)], { windowsHide: true });
    this.process = child;
    this.target = target;

    child.stdout.on('data', (chunk) => this.forwardPcm(chunk));
    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text.startsWith('error')) this.send('audio:status', { ok: false, text });
    });
    child.on('exit', (code) => {
      if (this.process !== child) return;
      this.process = null;
      this.target = null;
      if (code) this.send('audio:status', { ok: false, text: `A captura de áudio parou (código ${code}). Windows 10 2004+ é necessário.` });
    });
    this.send('audio:status', { ok: true, text: description });
  }

  // Only whole frames are forwarded; a split frame waits for the next chunk.
  forwardPcm(chunk) {
    const data = this.partialFrame.length ? Buffer.concat([this.partialFrame, chunk]) : chunk;
    const usable = data.length - (data.length % BYTES_PER_FRAME);
    this.partialFrame = data.subarray(usable);
    if (usable > 0) this.send('audio:data', new Uint8Array(data.buffer, data.byteOffset, usable).slice());
  }

  stop() {
    if (this.process) {
      this.process.removeAllListeners();
      this.process.stdout.removeAllListeners();
      try { this.process.stdin.end(); } catch { /* already closed */ }
      this.process.kill();
    }
    this.process = null;
    this.target = null;
    this.partialFrame = Buffer.alloc(0);
  }

  dispose() {
    clearInterval(this.recheckTimer);
    this.stop();
  }
}

/** Where appaudio.exe lives in development and in the installed app. */
function helperPathFor(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'appaudio.exe')
    : path.join(__dirname, 'native', 'appaudio.exe');
}

module.exports = { AudioCapture, helperPathFor };
