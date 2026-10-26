/**
 * projects.js
 * -----------
 * Stores livery projects on disk:
 *
 *   Documents\Livery Forge\Projects\<id>\
 *       project.json            <- all settings and details of the livery
 *       layers\<texId>\<layerId>.png   <- every paint layer
 *       textures\<NAME>.PNG     <- flattened texture, ready for the SDK
 *       imports\...             <- copied paint kits / images
 *       screenshots\01.jpg ...  <- screenshots for flightsim.to / marketplace
 *       thumbnail.jpg
 *       build\                  <- SDK project + compiled package (not synced)
 *
 * All writes go through safeJoin() so the UI can never write outside the
 * project's own folder.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeJoin, isInside } = require('./safe-path');

const ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;

/** Folders that are never uploaded to the cloud (they can be rebuilt). */
const NO_SYNC_DIRS = ['build'];

function newId() {
  // Time-based prefix keeps folders sorted by creation date.
  return Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex');
}

function defaultDetails(author = '') {
  return {
    title: '',
    author,
    version: '1.0.0',
    manufacturer: '',
    shortDescription: '',
    description: '',
    readme: '',
    credits: '',
    license: 'Free for personal use. Do not re-upload.',
    changelog: 'v1.0.0 - First release.',
    atcId: '',
    icaoAirline: '',
    atcAirline: '',
    flightNumber: '',
    parkingTypes: 'RAMP',
    tags: [],
    company: '',          // modular liveries: liveries\<company>\<livery>
    requiredTags: '',     // modular liveries: optional [SELECTION] required_tags
    ownWork: false,
    thumbnail: '',
    screenshots: [],
  };
}

class ProjectStore {
  /** @param {string} root  ...\Documents\Livery Forge\Projects */
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  /** Validates an id and returns the project folder. Throws on bad ids. */
  dir(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid project id.');
    const d = path.join(this.root, id);
    if (!isInside(this.root, d)) throw new Error('Invalid project id.');
    return d;
  }

  exists(id) {
    try { return fs.existsSync(path.join(this.dir(id), 'project.json')); } catch { return false; }
  }

  /** Lists all projects (summary only), newest first. */
  list() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return out; }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue;
      try {
        const p = this.load(ent.name);
        out.push(summary(p));
      } catch { /* skip broken project */ }
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  /** Creates a new project for an aircraft. */
  create({ name, aircraft, author = '', id }) {
    if (!name || !String(name).trim()) throw new Error('Please enter a livery name.');
    if (!aircraft || !aircraft.folder) throw new Error('Please pick an aircraft first.');
    const pid = id || newId();
    const now = new Date().toISOString();
    const project = {
      id: pid,
      schema: 1,
      createdAt: now,
      updatedAt: now,
      name: String(name).trim().slice(0, 80),
      aircraft: {
        title: aircraft.title || aircraft.folder,
        folder: aircraft.folder,
        path: aircraft.path || '',
        source: aircraft.source || '',
        category: /rotorcraft/i.test(aircraft.path || '') ? 'Rotorcraft' : 'Airplanes',
        modular: !!aircraft.modular,
        encrypted: !!aircraft.encrypted,
        packageName: aircraft.packageName || '',
        manufacturer: aircraft.manufacturer || '',
        model: aircraft.model || '',
        textureNames: (aircraft.textures || []).map((t) => ({ name: t.name, type: t.type, folder: t.folder })),
        textureFolders: [...new Set((aircraft.textures || []).map((t) => t.folder))],
        fallbackFolders: aircraft.fallbackFolders || [],
      },
      textures: [],
      details: { ...defaultDetails(author), title: String(name).trim() },
      export: {},
      publish: { status: 'none' },
    };
    fs.mkdirSync(this.dir(pid), { recursive: true });
    this.save(project);
    return project;
  }

  load(id) {
    const file = path.join(this.dir(id), 'project.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Fill in fields that older versions may not have.
    p.details = { ...defaultDetails(), ...(p.details || {}) };
    p.textures = Array.isArray(p.textures) ? p.textures : [];
    p.export = p.export || {};
    p.publish = p.publish || { status: 'none' };
    return p;
  }

  /** Saves the whole project object. `touch` updates updatedAt. */
  save(project, { touch = true } = {}) {
    const d = this.dir(project.id);
    fs.mkdirSync(d, { recursive: true });
    if (touch) project.updatedAt = new Date().toISOString();
    const file = path.join(d, 'project.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
    fs.renameSync(tmp, file);
    return project;
  }

  /** Deletes the whole project folder. */
  remove(id) {
    const d = this.dir(id);
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  }

  /** Writes a file inside the project (relative path). */
  writeFile(id, rel, data) {
    const full = safeJoin(this.dir(id), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return full;
  }

  readFile(id, rel) {
    return fs.readFileSync(safeJoin(this.dir(id), rel));
  }

  deleteFile(id, rel) {
    const full = safeJoin(this.dir(id), rel);
    fs.rmSync(full, { recursive: true, force: true });
  }

  /** Absolute path of a file inside the project (checked). */
  filePath(id, rel) {
    return safeJoin(this.dir(id), rel);
  }

  /**
   * Lists all project files that should be synced to the cloud:
   * [{ rel: 'layers/abc/def.png', size, mtimeMs }]
   * Paths use forward slashes so they work as cloud storage keys.
   */
  listSyncFiles(id) {
    const root = this.dir(id);
    const out = [];
    const walk = (dir, relBase) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const rel = relBase ? relBase + '/' + ent.name : ent.name;
        if (ent.isDirectory()) {
          if (!relBase && NO_SYNC_DIRS.includes(ent.name)) continue;
          walk(path.join(dir, ent.name), rel);
        } else if (ent.isFile()) {
          if (ent.name.endsWith('.tmp')) continue;
          const st = fs.statSync(path.join(dir, ent.name));
          out.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };
    walk(root, '');
    return out;
  }

  /** Removes layer PNGs that no texture/layer refers to anymore. */
  cleanupLayers(project) {
    const root = this.dir(project.id);
    const layersDir = path.join(root, 'layers');
    const keep = new Set();
    for (const t of project.textures) for (const l of t.layers || []) keep.add(`${t.id}/${l.id}.png`);
    let texDirs = [];
    try { texDirs = fs.readdirSync(layersDir, { withFileTypes: true }); } catch { return; }
    for (const td of texDirs) {
      if (!td.isDirectory()) continue;
      const known = project.textures.some((t) => t.id === td.name);
      if (!known) { fs.rmSync(path.join(layersDir, td.name), { recursive: true, force: true }); continue; }
      for (const f of fs.readdirSync(path.join(layersDir, td.name))) {
        if (!keep.has(`${td.name}/${f}`)) fs.rmSync(path.join(layersDir, td.name, f), { force: true });
      }
    }
  }
}

/** Short version of a project for the Projects grid. */
function summary(p) {
  return {
    id: p.id,
    name: p.name,
    title: p.details && p.details.title,
    author: p.details && p.details.author,
    version: p.details && p.details.version,
    aircraftTitle: p.aircraft && p.aircraft.title,
    modular: !!(p.aircraft && p.aircraft.modular),
    textureCount: (p.textures || []).length,
    thumbnail: (p.details && p.details.thumbnail) || '',
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    exported: !!(p.export && p.export.zipPath),
    publishStatus: (p.publish && p.publish.status) || 'none',
  };
}

module.exports = { ProjectStore, defaultDetails, summary, newId, ID_RE, NO_SYNC_DIRS };
