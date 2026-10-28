/**
 * main.js
 * -------
 * Electron "main process": creates the window and answers every request
 * from the UI (the "renderer") through IPC handlers.
 *
 * Security rules used here:
 *  - The web page has NO Node.js access (contextIsolation + sandbox).
 *  - The page can only call the functions listed in preload.js.
 *  - Files are only written inside a project's own folder (safeJoin).
 *  - Files are only READ from paths the user picked in a dialog, or that the
 *    aircraft scanner found.
 *  - External links open in the normal system browser, https only.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeImage, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { Settings } = require('./lib/settings');
const msfsPaths = require('./lib/msfs-paths');
const scanner = require('./lib/scanner');
const packager = require('./lib/packager');
const publisher = require('./lib/publisher');
const { ProjectStore, summary } = require('./lib/projects');
const { Cloud, listLocalDownloads, friendly } = require('./lib/cloud');
const { importPsd } = require('./lib/psd');
const { isInside, safeFileName } = require('./lib/safe-path');

/* ------------------------------------------------------------------ */
/* Folders                                                              */
/* ------------------------------------------------------------------ */

// Lets tests / portable use point the app at another Documents folder.
const DOCS_ROOT = process.env.LIVERY_FORGE_HOME || path.join(app.getPath('documents'), 'Livery Forge');
const PROJECTS_ROOT = path.join(DOCS_ROOT, 'Projects');
const OUTPUT_ROOT = path.join(DOCS_ROOT, 'Output');
const DOWNLOADS_ROOT = path.join(DOCS_ROOT, 'Downloads');
if (process.env.LIVERY_FORGE_USERDATA) app.setPath('userData', process.env.LIVERY_FORGE_USERDATA);

let settings;
let store;
let cloud;
let mainWindow;
let aircraftCache = [];               // last scan result
const allowedReads = new Set();       // absolute paths the user picked / we scanned

// The custom protocol lfproj:// lets the page load images from project folders.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lfproj', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function allowRead(p) { if (p) allowedReads.add(path.resolve(p).toLowerCase()); }
function canRead(p) { return !!p && allowedReads.has(path.resolve(p).toLowerCase()); }

/** Sends an event to the window (if it still exists). */
function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** Wraps a handler so errors reach the UI as { error } instead of crashing. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    // Only accept calls from our own window.
    if (!mainWindow || event.sender !== mainWindow.webContents) return { error: 'Not allowed.' };
    try {
      const result = await fn(...args);
      return { ok: true, result };
    } catch (e) {
      console.error(`[${channel}]`, e);
      return { error: e && e.message ? e.message : String(e) };
    }
  });
}

/** Reads Supabase settings: Settings screen first, then config/supabase.json. */
function cloudConfig() {
  const s = settings.get();
  let fileCfg = {};
  for (const f of [path.join(__dirname, 'config', 'supabase.local.json'), path.join(__dirname, 'config', 'supabase.json')]) {
    try { fileCfg = JSON.parse(fs.readFileSync(f, 'utf8')); if (fileCfg.url) break; } catch { /* ignore */ }
  }
  return {
    url: s.supabaseUrl || process.env.LIVERY_FORGE_SUPABASE_URL || fileCfg.url || '',
    anonKey: s.supabaseAnonKey || process.env.LIVERY_FORGE_SUPABASE_KEY || fileCfg.anonKey || '',
  };
}

function makeCloud() {
  const cfg = cloudConfig();
  const cipher = safeStorage.isEncryptionAvailable()
    ? { encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) }
    : null;
  cloud = new Cloud({
    url: cfg.url,
    anonKey: cfg.anonKey,
    sessionFile: path.join(app.getPath('userData'), 'session.dat'),
    cipher,
    store,
    downloadsRoot: DOWNLOADS_ROOT,
  });
}

/** Id of the logged-in user, or '' when offline / logged out. */
async function currentUserId() {
  try { const u = cloud && cloud.isConfigured() ? await cloud.currentUser() : null; return u ? u.id : ''; } catch { return ''; }
}

/** A project is visible if it has no owner or belongs to the current user. */
async function assertMine(project) {
  const uid = await currentUserId();
  if (project.ownerId && project.ownerId !== uid) throw new Error('This project belongs to another account. Log in with that account.');
}

async function loadMine(id) {
  const p = store.load(id);
  await assertMine(p);
  return p;
}

/* -------- auto sync: push a project a few seconds after it changes ---- */
const syncTimers = new Map();
function scheduleSync(projectId) {
  if (!cloud || !cloud.isConfigured()) return;
  clearTimeout(syncTimers.get(projectId));
  syncTimers.set(projectId, setTimeout(async () => {
    syncTimers.delete(projectId);
    try {
      if (!(await currentUserId())) return;
      emit('cloud:sync', { state: 'syncing', projectId });
      await cloud.pushProject(projectId);
      emit('cloud:sync', { state: 'synced', projectId, at: new Date().toISOString() });
    } catch (e) {
      emit('cloud:sync', { state: 'error', projectId, message: e.message });
    }
  }, 4000));
}

/* -------- images (nativeImage) ---------------------------------------- */

/** Converts any PNG/JPG to JPEG, max `maxWidth` wide and under `maxBytes`. */
function toJpeg(input, { maxWidth = 1920, maxBytes = 5 * 1024 * 1024 } = {}) {
  let img = Buffer.isBuffer(input) ? nativeImage.createFromBuffer(input) : nativeImage.createFromPath(input);
  if (img.isEmpty()) throw new Error('This image could not be read. Use PNG or JPG.');
  const size = img.getSize();
  if (size.width > maxWidth) img = img.resize({ width: maxWidth, quality: 'best' });
  let q = 90;
  let out = img.toJPEG(q);
  while (out.length > maxBytes && q > 40) { q -= 10; out = img.toJPEG(q); }
  while (out.length > maxBytes) {
    const s = img.getSize();
    img = img.resize({ width: Math.round(s.width * 0.8), quality: 'best' });
    out = img.toJPEG(70);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Window                                                               */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1117',
    title: 'Livery Forge',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Never open new Electron windows; open https links in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  // F12 opens developer tools (handy for beginners to see errors).
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                         */
/* ------------------------------------------------------------------ */

function registerHandlers() {
  /* ---------- app & settings ---------- */
  handle('app:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    docsRoot: DOCS_ROOT,
    projectsRoot: PROJECTS_ROOT,
    outputRoot: OUTPUT_ROOT,
    rule: publisher.RULE_TEXT,
  }));

  handle('settings:get', async () => {
    const s = settings.get();
    return { ...s, sdkValid: msfsPaths.isValidSdk(s.sdkPath), cloudConfigured: cloud.isConfigured() };
  });

  handle('settings:set', async (patch) => {
    const before = cloudConfig();
    const s = settings.update(patch || {});
    const after = cloudConfig();
    if (before.url !== after.url || before.anonKey !== after.anonKey) makeCloud();
    return { ...s, sdkValid: msfsPaths.isValidSdk(s.sdkPath), cloudConfigured: cloud.isConfigured() };
  });

  handle('settings:detect', async () => {
    const d = msfsPaths.detectInstall();
    const patch = {};
    if (d.communityPath) patch.communityPath = d.communityPath;
    if (d.officialPath) patch.officialPath = d.officialPath;
    if (d.sdkPath) patch.sdkPath = d.sdkPath;
    if (d.found) patch.edition = d.edition;
    const s = settings.update(patch);
    return { detected: d, settings: { ...s, sdkValid: msfsPaths.isValidSdk(s.sdkPath), cloudConfigured: cloud.isConfigured() } };
  });

  handle('settings:checkSdk', async (p) => msfsPaths.isValidSdk(p));

  /* ---------- dialogs ---------- */
  handle('dialog:pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: title || 'Choose a folder', properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
  });

  handle('dialog:pickFiles', async ({ title, kind, multi } = {}) => {
    const filters = {
      image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
      paintkit: [{ name: 'Paint kits & images', extensions: ['psd', 'png', 'jpg', 'jpeg'] }],
      screenshot: [{ name: 'Screenshots', extensions: ['png', 'jpg', 'jpeg'] }],
    }[kind] || [{ name: 'All files', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Choose a file',
      filters,
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (r.canceled) return [];
    r.filePaths.forEach(allowRead);
    return r.filePaths;
  });

  handle('dialog:confirm', async ({ title, message, detail, okLabel = 'OK', danger = false }) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: danger ? 'warning' : 'question',
      buttons: [okLabel, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: title || 'Livery Forge',
      message: message || '',
      detail: detail || '',
    });
    return r.response === 0;
  });

  /* ---------- aircraft ---------- */
  handle('aircraft:scan', async () => {
    const s = settings.get();
    const roots = [
      { path: s.communityPath, source: 'Community' },
      { path: s.officialPath, source: 'Official' },
      ...s.extraAircraftPaths.map((p) => ({ path: p, source: 'Extra' })),
    ].filter((r) => r.path);
    aircraftCache = scanner.scanAircraft(roots);
    return { aircraft: aircraftCache, roots: roots.map((r) => ({ ...r, exists: fs.existsSync(r.path) })) };
  });

  handle('aircraft:textures', async (aircraftId) => {
    const ac = aircraftCache.find((a) => a.id === aircraftId);
    if (!ac) throw new Error('Aircraft not found. Scan again.');
    const tex = scanner.listTextures(ac.path);
    tex.forEach((t) => { if (t.editable) allowRead(t.path); });
    // Detect encrypted textures (not readable KTX2/DDS).
    const ktx = tex.find((t) => /ktx2|dds/.test(t.ext));
    const encrypted = ac.encrypted || (ktx ? scanner.looksEncrypted(ktx.path) : false);
    return { textures: tex, encrypted };
  });

  // Texture list of a project's base aircraft (works after an app restart).
  handle('aircraft:texturesForProject', async (projectId) => {
    const p = await loadMine(projectId);
    const acPath = p.aircraft && p.aircraft.path;
    if (!acPath || !fs.existsSync(acPath)) return { textures: [], missing: true };
    const tex = scanner.listTextures(acPath);
    tex.forEach((t) => { if (t.editable) allowRead(t.path); });
    return { textures: tex, missing: false };
  });

  /* ---------- projects ---------- */
  handle('projects:list', async () => {
    const uid = await currentUserId();
    return store.list().filter((p) => {
      try { const full = store.load(p.id); return !full.ownerId || full.ownerId === uid; } catch { return false; }
    });
  });

  handle('projects:create', async ({ name, aircraftId }) => {
    const ac = aircraftCache.find((a) => a.id === aircraftId);
    if (!ac) throw new Error('Aircraft not found. Scan again.');
    const textures = scanner.listTextures(ac.path);
    const fallbackFolders = ac.modular ? scanner.modularFallbackFolders(ac.path).map((f) => path.relative(ac.path, f)) : [];
    const s = settings.get();
    const uid = await currentUserId();
    let author = s.defaultAuthor;
    if (!author && cloud.profile) author = cloud.profile.display_name || cloud.profile.username;
    const p = store.create({ name, aircraft: { ...ac, textures, fallbackFolders }, author });
    if (uid) { p.ownerId = uid; store.save(p); }
    scheduleSync(p.id);
    return p;
  });

  handle('projects:load', async (id) => loadMine(id));

  handle('projects:save', async (project) => {
    if (!project || !project.id) throw new Error('Invalid project.');
    const existing = await loadMine(project.id);
    // These fields are owned by the main process; the UI can't change them.
    project.ownerId = existing.ownerId;
    project.export = existing.export;
    project.publish = existing.publish;
    project.createdAt = existing.createdAt;
    const saved = store.save(project);
    store.cleanupLayers(saved);
    scheduleSync(saved.id);
    return saved;
  });

  handle('projects:delete', async (id) => {
    await loadMine(id);
    const p = store.load(id);
    try {
      const pkg = packager.layout(p).pkg;
      if (packager.communityStatus(pkg, settings.get().communityPath)) packager.removeFromCommunity(pkg, settings.get().communityPath);
    } catch { /* ignore */ }
    store.remove(id);
    let cloudDeleted = false;
    try { if (await currentUserId()) cloudDeleted = await cloud.deleteCloudProject(id); } catch { /* offline */ }
    return { cloudDeleted };
  });

  // Only these locations inside a project may be written by the UI.
  const WRITABLE = /^(layers\/[a-z0-9-]+\/[a-z0-9-]+\.png|textures\/[A-Za-z0-9_.-]+\.PNG|preview\.png)$/;
  handle('projects:writeFile', async (id, rel, bytes) => {
    if (!WRITABLE.test(rel)) throw new Error('Blocked file path: ' + rel);
    await loadMine(id);
    store.writeFile(id, rel, Buffer.from(bytes));
    return true;
  });

  handle('projects:deleteFile', async (id, rel) => {
    if (!WRITABLE.test(rel)) throw new Error('Blocked file path.');
    await loadMine(id);
    store.deleteFile(id, rel);
    return true;
  });

  /**
   * Imports an image or PSD into the project.
   * Returns { kind: 'image', rel, width?, height? } or { kind: 'psd', width, height, layers: [{ rel, ... }] }
   */
  handle('projects:importFile', async (id, sourcePath) => {
    await loadMine(id);
    if (!canRead(sourcePath)) throw new Error('Pick the file again with the file dialog.');
    const ext = path.extname(sourcePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.psd'].includes(ext)) {
      throw new Error('Only PNG, JPG and PSD files can be opened. Compiled KTX2/DDS textures cannot be edited - use the paint kit from the aircraft developer.');
    }
    const stamp = Date.now().toString(36);
    const fileName = path.basename(sourcePath);
    const base = safeFileName(fileName.slice(0, fileName.length - ext.length)).replace(/\s+/g, '_');
    if (ext === '.psd') {
      emit('progress', { label: 'Reading PSD paint kit...', value: 0 });
      const buf = fs.readFileSync(sourcePath);
      const psd = importPsd(buf, (i, n) => emit('progress', { label: `Importing layer ${i + 1} of ${n}...`, value: (i + 1) / n }));
      const layers = psd.layers.map((l, i) => {
        const rel = `imports/${stamp}-${base}/${String(i).padStart(3, '0')}.png`;
        store.writeFile(id, rel, l.png);
        return { rel, name: l.name, left: l.left, top: l.top, width: l.width, height: l.height, visible: l.visible, opacity: l.opacity, blend: l.blend };
      });
      emit('progress', null);
      return { kind: 'psd', width: psd.width, height: psd.height, layers };
    }
    const rel = `imports/${stamp}-${base}${ext}`;
    fs.mkdirSync(path.dirname(store.filePath(id, rel)), { recursive: true });
    fs.copyFileSync(sourcePath, store.filePath(id, rel));
    return { kind: 'image', rel };
  });

  // Imported paint kits are copied into the layers once saved; this frees the space.
  handle('projects:clearImports', async (id) => {
    await loadMine(id);
    fs.rmSync(path.join(store.dir(id), 'imports'), { recursive: true, force: true });
    return true;
  });

  handle('projects:addScreenshots', async (id, paths) => {
    const p = await loadMine(id);
    const added = [];
    for (const src of paths || []) {
      if (!canRead(src)) continue;
      if (p.details.screenshots.length >= publisher.LIMITS.maxImages) break;
      const jpg = toJpeg(src, { maxWidth: 1920, maxBytes: 4.9 * 1024 * 1024 });
      const rel = `screenshots/${Date.now().toString(36)}-${added.length}.jpg`;
      store.writeFile(id, rel, jpg);
      p.details.screenshots.push(rel);
      added.push(rel);
    }
    store.save(p);
    scheduleSync(id);
    return p;
  });

  handle('projects:removeScreenshot', async (id, rel) => {
    const p = await loadMine(id);
    if (!p.details.screenshots.includes(rel)) throw new Error('Unknown screenshot.');
    p.details.screenshots = p.details.screenshots.filter((s) => s !== rel);
    store.deleteFile(id, rel);
    store.save(p);
    scheduleSync(id);
    return p;
  });

  /** Thumbnail from a picked file, or from PNG bytes (current texture preview). */
  handle('projects:setThumbnail', async (id, { path: src, bytes }) => {
    const p = await loadMine(id);
    let input;
    if (bytes) input = Buffer.from(bytes);
    else if (canRead(src)) input = src;
    else throw new Error('Pick the image again.');
    const jpg = toJpeg(input, { maxWidth: 800, maxBytes: 1024 * 1024 });
    store.writeFile(id, 'thumbnail.jpg', jpg);
    p.details.thumbnail = 'thumbnail.jpg';
    store.save(p);
    scheduleSync(id);
    return p;
  });

  /* ---------- export ---------- */
  handle('export:preflight', async (id) => {
    const p = await loadMine(id);
    const r = packager.preflight(p, store.dir(id));
    const s = settings.get();
    if (!msfsPaths.isValidSdk(s.sdkPath)) r.warnings.unshift('MSFS 2024 SDK not set - only "Source project only" export is possible. Set it in Settings.');
    return { ...r, layout: packager.layout(p) };
  });

  handle('export:run', async (id, mode) => {
    const p = await loadMine(id);
    const dir = store.dir(id);
    const s = settings.get();
    const log = (level, text) => emit('export:log', { level, text, time: Date.now() });

    const pre = packager.preflight(p, dir);
    pre.warnings.forEach((w) => log('warn', w));
    if (pre.errors.length) {
      pre.errors.forEach((e) => log('error', e));
      throw new Error('Fix the problems shown in the log first.');
    }

    log('info', 'Writing SDK project...');
    const w = packager.writeSdkProject(p, dir, { highQuality: s.highQualityTextures });
    log('info', `Package name: ${w.pkg} (${w.mode === 'modular' ? 'modular - experimental' : 'classic livery'})`);
    log('info', `${w.written.length} files written to ${w.buildDir}`);

    if (mode === 'source') {
      const z = await packager.zipSourceProject(p, dir, OUTPUT_ROOT);
      log('ok', `Source project zipped: ${z.zipPath}`);
      log('warn', 'Remember: MSFS 2024 cannot load a source project. It must be compiled with the SDK first.');
      const fresh = store.load(id);
      fresh.export = { ...fresh.export, pkg: z.pkg, sourceZipPath: z.zipPath, sourceOnly: !fresh.export.zipPath, lastExportAt: new Date().toISOString() };
      store.save(fresh, { touch: false });
      return { zipPath: z.zipPath, pkg: z.pkg, mode };
    }

    if (!msfsPaths.isValidSdk(s.sdkPath)) {
      log('error', 'MSFS 2024 SDK not found. Install the SDK and set its folder in Settings (it must contain Tools\\bin\\fspackagetool.exe). Or use "Source project only".');
      throw new Error('SDK not found.');
    }
    log('info', 'Compiling with the MSFS 2024 SDK (this can take a few minutes for 4K textures)...');
    const c = await packager.compile({ sdkPath: s.sdkPath, projectXmlPath: w.projectXml, steam: s.edition === 'steam', onLog: log });
    if (!c.ok) {
      log('error', `The SDK package tool failed (exit code ${c.code}). Read the red lines above.`);
      log('hint', 'Common causes: texture size not a power of two, MSFS 2024 still running and locking files, or the SDK version is too old.');
      throw new Error('Compile failed.');
    }
    log('ok', 'Compile finished.');
    const fin = await packager.finishPackage(p, dir, OUTPUT_ROOT);
    log('ok', `Package ready: ${fin.packageDir}`);
    log('ok', `Zip ready: ${fin.zipPath} (${(fin.zipSize / 1024 / 1024).toFixed(1)} MB)`);

    const fresh = store.load(id);
    fresh.export = { pkg: fin.pkg, packageDir: fin.packageDir, zipPath: fin.zipPath, zipSize: fin.zipSize, lastExportAt: new Date().toISOString(), sourceOnly: false };
    if (mode === 'test') {
      const inst = packager.installToCommunity(fin.packageDir, s.communityPath, s.installMode);
      fresh.export.installedPath = inst.target;
      fresh.export.installMode = inst.mode;
      log('ok', inst.mode === 'link'
        ? `Linked into Community: ${inst.target}. Re-exports update the sim automatically (restart the flight to see changes).`
        : `Copied into Community: ${inst.target}.`);
    }
    store.save(fresh, { touch: false });
    return { ...fresh.export, mode };
  });

  handle('export:removeFromCommunity', async (id) => {
    const p = await loadMine(id);
    const pkg = packager.layout(p).pkg;
    const r = packager.removeFromCommunity(pkg, settings.get().communityPath);
    p.export.installedPath = '';
    store.save(p, { touch: false });
    return r;
  });

  handle('export:status', async (id) => {
    const p = await loadMine(id);
    const pkg = packager.layout(p).pkg;
    return {
      pkg,
      community: packager.communityStatus(pkg, settings.get().communityPath),
      zipExists: !!(p.export.zipPath && fs.existsSync(p.export.zipPath)),
      export: p.export,
    };
  });

  /* ---------- shell ---------- */
  const OPENABLE_ROOTS = () => [DOCS_ROOT, settings.get().communityPath].filter(Boolean);
  handle('shell:openFolder', async (target) => {
    const t = target === 'output' ? OUTPUT_ROOT : target === 'projects' ? PROJECTS_ROOT : target;
    if (!OPENABLE_ROOTS().some((r) => isInside(r, t))) throw new Error('Not allowed.');
    fs.mkdirSync(t, { recursive: true });
    const err = await shell.openPath(t);
    if (err) throw new Error(err);
    return true;
  });
  handle('shell:showItem', async (target) => {
    if (!OPENABLE_ROOTS().some((r) => isInside(r, target))) throw new Error('Not allowed.');
    shell.showItemInFolder(target);
    return true;
  });
  handle('shell:openProjectFolder', async (id) => {
    await loadMine(id);
    await shell.openPath(store.dir(id));
    return true;
  });
  handle('shell:openExternal', async (url) => {
    if (!/^https:\/\/[^\s]+$/i.test(String(url))) throw new Error('Only https links can be opened.');
    await shell.openExternal(url);
    return true;
  });
  handle('clipboard:write', async (text) => { clipboard.writeText(String(text || '')); return true; });

  /* ---------- publish (flightsim.to) ---------- */
  const publishLogFile = () => path.join(app.getPath('userData'), 'publish-log.json');
  const readPublishLog = () => { try { return JSON.parse(fs.readFileSync(publishLogFile(), 'utf8')); } catch { return { submissions: [] }; } };

  handle('publish:validate', async (id) => {
    const p = await loadMine(id);
    return publisher.validate(p, store.dir(id));
  });

  handle('publish:prepare', async (id) => {
    const p = await loadMine(id);
    const r = publisher.prepareBundle(p, store.dir(id), OUTPUT_ROOT);
    const fresh = store.load(id);
    fresh.publish = { ...fresh.publish, status: fresh.publish.status === 'submitted' ? 'submitted' : 'ready', bundlePath: r.bundleDir, preparedAt: new Date().toISOString() };
    store.save(fresh, { touch: false });
    return { ...r, description: publisher.buildDescription(p) };
  });

  handle('publish:description', async (id) => publisher.buildDescription(await loadMine(id)));

  handle('publish:markSubmitted', async (id, submitted = true) => {
    const p = await loadMine(id);
    p.publish = { ...p.publish, status: submitted ? 'submitted' : 'ready', submittedAt: submitted ? new Date().toISOString() : '' };
    store.save(p, { touch: false });
    if (submitted) {
      const log = readPublishLog();
      log.submissions = [...log.submissions, new Date().toISOString()].slice(-50);
      fs.writeFileSync(publishLogFile(), JSON.stringify(log, null, 2));
    }
    return p.publish;
  });

  handle('publish:queue', async () => {
    const uid = await currentUserId();
    const items = [];
    for (const s of store.list()) {
      const p = store.load(s.id);
      if (p.ownerId && p.ownerId !== uid) continue;
      const v = publisher.validate(p, store.dir(p.id));
      items.push({
        ...summary(p),
        exported: !!(p.export.zipPath && fs.existsSync(p.export.zipPath)),
        status: p.publish.status || 'none',
        bundlePath: p.publish.bundlePath || '',
        valid: v.ok,
        errors: v.errors,
      });
    }
    const log = readPublishLog();
    const perHour = settings.get().uploadsPerHour || 3;
    return { items, nextAllowedAt: publisher.nextAllowedAt(log.submissions, perHour), perHour, recent: log.submissions };
  });

  handle('publish:prepareAll', async () => {
    const results = [];
    const uid = await currentUserId();
    for (const s of store.list()) {
      const p = store.load(s.id);
      if (p.ownerId && p.ownerId !== uid) continue;
      if (!p.export.zipPath || p.publish.status === 'submitted') continue;
      try {
        const r = publisher.prepareBundle(p, store.dir(p.id), OUTPUT_ROOT);
        p.publish = { ...p.publish, status: 'ready', bundlePath: r.bundleDir, preparedAt: new Date().toISOString() };
        store.save(p, { touch: false });
        results.push({ id: p.id, name: p.name, ok: true });
      } catch (e) {
        results.push({ id: p.id, name: p.name, ok: false, error: e.message });
      }
    }
    return results;
  });

  /* ---------- cloud: accounts ---------- */
  handle('cloud:status', async () => {
    if (!cloud.isConfigured()) return { configured: false, user: null };
    let user = null;
    let offline = false;
    try { user = await cloud.currentUser(); } catch (e) {
      // Session exists but the server can't be reached: stay logged in offline.
      const session = await cloud.getSession().catch(() => null);
      if (session) { user = { id: session.user.id, email: session.user.email, profile: cloud.profile }; offline = true; }
    }
    return { configured: true, user, offline };
  });
  handle('cloud:signUp', async (form) => cloud.signUp(form));
  handle('cloud:signIn', async (form) => cloud.signIn(form));
  handle('cloud:signOut', async () => { await cloud.signOut(); return true; });
  handle('cloud:sendReset', async (email) => cloud.sendPasswordReset(email));
  handle('cloud:resetWithCode', async (form) => cloud.resetPasswordWithCode(form));
  handle('cloud:usernameAvailable', async (name) => cloud.usernameAvailable(name));
  handle('cloud:updateProfile', async (patch) => cloud.updateProfile(patch));
  handle('cloud:uploadAvatar', async (src) => {
    if (!canRead(src)) throw new Error('Pick the image again.');
    let img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('Could not read the image.');
    const s = img.getSize();
    const side = Math.min(s.width, s.height);
    img = img.crop({ x: Math.floor((s.width - side) / 2), y: Math.floor((s.height - side) / 2), width: side, height: side }).resize({ width: 256, height: 256, quality: 'best' });
    return cloud.uploadAvatar(img.toJPEG(88));
  });
  handle('cloud:syncAll', async () => {
    emit('cloud:sync', { state: 'syncing' });
    try {
      const r = await cloud.syncAll((msg) => emit('cloud:sync', { state: 'syncing', message: msg }));
      emit('cloud:sync', { state: r.errors && r.errors.length ? 'error' : 'synced', at: new Date().toISOString(), message: (r.errors || []).join('\n') });
      return r;
    } catch (e) {
      emit('cloud:sync', { state: 'error', message: e.message });
      throw e;
    }
  });
  handle('cloud:claimLocal', async () => {
    // Give unowned (offline-made) projects to the current account.
    const uid = await currentUserId();
    if (!uid) throw new Error('Please log in.');
    let n = 0;
    for (const s of store.list()) {
      const p = store.load(s.id);
      if (!p.ownerId) { p.ownerId = uid; store.save(p, { touch: false }); n++; }
    }
    return n;
  });

  /* ---------- cloud: marketplace ---------- */
  handle('market:list', async (opts) => cloud.listListings(opts || {}));
  handle('market:get', async (id) => cloud.getListing(id));
  handle('market:creator', async (idOrName) => cloud.getCreator(idOrName));
  handle('market:favorite', async (id) => cloud.toggleFavorite(id));
  handle('market:follow', async (creatorId) => cloud.toggleFollow(creatorId));
  handle('market:review', async ({ id, rating, comment }) => cloud.submitReview(id, rating, comment));
  handle('market:hangar', async () => cloud.myHangar());
  handle('market:mine', async () => cloud.myListings());
  handle('market:setStatus', async ({ id, status }) => cloud.setListingStatus(id, status));
  handle('market:delete', async (id) => cloud.deleteListing(id));

  handle('market:publish', async (projectId) => {
    const p = await loadMine(projectId);
    if (!p.export.zipPath || !fs.existsSync(p.export.zipPath)) throw new Error('Export the package first (step 4).');
    if (!p.details.ownWork) throw new Error('Tick "This is my own work or I have written permission" on the Details screen.');
    if (!p.details.title || !p.details.description) throw new Error('Add a title and description on the Details screen first.');
    const shots = p.details.screenshots.map((s) => store.filePath(projectId, s)).filter((f) => fs.existsSync(f));
    const thumb = p.details.thumbnail ? store.filePath(projectId, p.details.thumbnail) : '';
    const listing = await cloud.publishListing(p, {
      zipPath: p.export.zipPath,
      pkg: p.export.pkg || packager.layout(p).pkg,
      thumbnailPath: thumb && fs.existsSync(thumb) ? thumb : '',
      screenshotPaths: shots.slice(0, 12),
    }, (done, total, label) => emit('progress', { label, value: total ? done / total : 0 }));
    emit('progress', null);
    const fresh = store.load(projectId);
    fresh.publish = { ...fresh.publish, marketplaceId: listing.id, marketplaceAt: new Date().toISOString() };
    store.save(fresh, { touch: false });
    return listing;
  });

  handle('market:download', async ({ id, install }) => {
    const meta = await cloud.downloadListing(id, (got, total) => emit('progress', { label: 'Downloading livery...', value: total ? got / total : 0 }));
    emit('progress', null);
    if (install) {
      const s = settings.get();
      packager.installToCommunity(meta.packageDir, s.communityPath, s.installMode);
    }
    return { ...meta, community: packager.communityStatus(meta.pkg, settings.get().communityPath) };
  });

  handle('market:localDownloads', async () => listLocalDownloads(DOWNLOADS_ROOT).map((d) => ({
    ...d, community: packager.communityStatus(d.pkg, settings.get().communityPath),
  })));

  handle('market:install', async (listingId) => {
    const d = listLocalDownloads(DOWNLOADS_ROOT).find((x) => x.id === listingId);
    if (!d) throw new Error('Download it first.');
    const s = settings.get();
    return packager.installToCommunity(d.packageDir, s.communityPath, s.installMode);
  });

  handle('market:uninstall', async (listingId) => {
    const d = listLocalDownloads(DOWNLOADS_ROOT).find((x) => x.id === listingId);
    if (!d) throw new Error('Not downloaded.');
    return packager.removeFromCommunity(d.pkg, settings.get().communityPath);
  });

  handle('market:removeDownload', async (listingId) => {
    const d = listLocalDownloads(DOWNLOADS_ROOT).find((x) => x.id === listingId);
    if (!d) return false;
    try { packager.removeFromCommunity(d.pkg, settings.get().communityPath); } catch { /* not ours */ }
    fs.rmSync(path.join(DOWNLOADS_ROOT, listingId), { recursive: true, force: true });
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Start                                                                */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  store = new ProjectStore(PROJECTS_ROOT);
  makeCloud();

  // First start: try to find MSFS 2024 automatically.
  const s = settings.get();
  if (!s.communityPath && !s.officialPath) {
    const d = msfsPaths.detectInstall();
    const patch = {};
    if (d.communityPath) patch.communityPath = d.communityPath;
    if (d.officialPath) patch.officialPath = d.officialPath;
    if (d.sdkPath) patch.sdkPath = d.sdkPath;
    if (d.found) patch.edition = d.edition;
    settings.update(patch);
  }

  // lfproj://project/<id>/<relative path>  -> file inside that project only.
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json' };
  protocol.handle('lfproj', async (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== 'project') return new Response('Not found', { status: 404 });
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const id = parts.shift();
      const file = store.filePath(id, parts.join('/'));
      if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      // The page is loaded from file://, so allow it to fetch() these images.
      return new Response(res.body, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });

  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Make sure nobody can attach a webview or open unexpected windows.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

module.exports = { friendly };
