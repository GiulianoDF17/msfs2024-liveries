/**
 * scanner.js
 * ----------
 * 1. A tiny parser for MSFS .cfg files (INI-style: [SECTION] + key = value).
 * 2. A scanner that walks Community / Official / extra folders and finds
 *    aircraft (folders with aircraft.cfg) and their texture files.
 *
 * Folder layout we expect inside a package:
 *   <Package>\SimObjects\Airplanes\<AircraftFolder>\aircraft.cfg
 *   <Package>\SimObjects\Airplanes\<AircraftFolder>\texture...\*.PNG.KTX2|DDS|PNG
 *   Modular aircraft also have attachments\, presets\ or liveries\ folders.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* CFG parser                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parses cfg text into { SECTION: { key: value } }.
 * - Section and key names are kept as written, but lookups should use
 *   getCfg() which ignores upper/lower case.
 * - Comments start with ; or // and are removed (but not inside quotes).
 * - Surrounding quotes are removed from values.
 */
function parseCfg(text) {
  const out = {};
  let current = null;
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  for (let raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      current = sec[1].trim();
      if (!out[current]) out[current] = {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || current === null) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[current][key] = value;
  }
  return out;
}

/** Removes ; and // comments that are not inside double quotes. */
function stripComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === ';') return line.slice(0, i);
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

/** Case-insensitive lookup: getCfg(cfg, 'fltsim.0', 'title'). */
function getCfg(cfg, section, key) {
  if (!cfg) return undefined;
  const sKey = Object.keys(cfg).find((s) => s.toLowerCase() === String(section).toLowerCase());
  if (!sKey) return undefined;
  const kKey = Object.keys(cfg[sKey]).find((k) => k.toLowerCase() === String(key).toLowerCase());
  return kKey ? cfg[sKey][kKey] : undefined;
}

/** Lists all [FLTSIM.N] sections in order. */
function fltsimSections(cfg) {
  return Object.keys(cfg || {})
    .filter((s) => /^fltsim\.\d+$/i.test(s))
    .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
    .map((s) => cfg[s]);
}

/* ------------------------------------------------------------------ */
/* Texture helpers                                                     */
/* ------------------------------------------------------------------ */

const TEXTURE_EXTS = ['.png.ktx2', '.ktx2', '.png.dds', '.dds', '.png', '.jpg', '.jpeg', '.psd', '.tif', '.tiff'];
const EDITABLE_EXTS = ['.png', '.jpg', '.jpeg', '.psd'];

/**
 * Splits a texture file name into the "texture name" MSFS uses and the extension.
 *   "A320_FUSELAGE_ALBD.PNG.KTX2" -> { name: "A320_FUSELAGE_ALBD", ext: ".png.ktx2" }
 */
function splitTextureName(fileName) {
  const lower = fileName.toLowerCase();
  for (const ext of TEXTURE_EXTS) {
    if (lower.endsWith(ext)) {
      return { name: fileName.slice(0, fileName.length - ext.length), ext };
    }
  }
  return null;
}

/**
 * Guesses the texture type from its name.
 *   _ALBD / _ALBEDO / _DIFF -> albedo     _COMP -> comp
 *   _NORM / _NORMAL         -> normal     _DECAL -> decal
 *   _EMIS / _EMISSIVE       -> emissive
 */
function detectTextureType(name) {
  const n = String(name || '').toUpperCase();
  if (/_(ALBD|ALBEDO|DIFF|DIFFUSE|COL|COLOR|BASECOLOR)(\b|_|$)/.test(n)) return 'albedo';
  if (/_(COMP|ORM|METAL|ROUGH|MRAO)(\b|_|$)/.test(n)) return 'comp';
  if (/_(NORM|NORMAL|NRM)(\b|_|$)/.test(n)) return 'normal';
  if (/_(DECAL|DECALS)(\b|_|$)/.test(n)) return 'decal';
  if (/_(EMIS|EMISSIVE|EMIT)(\b|_|$)/.test(n)) return 'emissive';
  return 'albedo';
}

/** Returns true if the bytes look like a KTX2 file whose data we can't read. */
function looksEncrypted(filePath) {
  // Encrypted packages (marketplace payware) usually ship *.fsarchive files or
  // a layout with "encrypted" entries. We read the first bytes of a KTX2 to
  // check for the standard KTX2 magic; anything else is treated as protected.
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const ktx2Magic = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ddsMagic = Buffer.from('DDS ');
    if (buf.equals(ktx2Magic)) return false;
    if (buf.subarray(0, 4).equals(ddsMagic)) return false;
    if (buf[0] === 0x89 && buf[1] === 0x50) return false; // PNG
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Aircraft scanning                                                   */
/* ------------------------------------------------------------------ */

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Finds every SimObjects\Airplanes|Rotorcraft\<folder> under a root folder.
 * `root` can be a Community/Official folder (packages inside) or a single
 * package folder. Walks at most a few levels deep to stay fast.
 */
function findAircraftFolders(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 3) return;
    for (const ent of safeReaddir(dir)) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name.toLowerCase() === 'simobjects') {
        for (const cat of safeReaddir(full)) {
          if (!/^(airplanes|rotorcraft)$/i.test(cat.name)) continue;
          const catPath = path.join(full, cat.name);
          for (const ac of safeReaddir(catPath)) {
            const acPath = path.join(catPath, ac.name);
            if (isDir(acPath)) found.push({ packagePath: dir, aircraftPath: acPath, folder: ac.name });
          }
        }
      } else if (depth < 3) {
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return found;
}

/** Lists texture folders of an aircraft (texture, texture.XYZ, liveries\..\texture, common\texture). */
function findTextureFolders(aircraftPath) {
  const out = [];
  for (const ent of safeReaddir(aircraftPath)) {
    if (!ent.isDirectory()) continue;
    if (/^texture(\..+)?$/i.test(ent.name)) out.push(path.join(aircraftPath, ent.name));
    if (/^common$/i.test(ent.name)) {
      const t = path.join(aircraftPath, ent.name, 'texture');
      if (isDir(t)) out.push(t);
    }
  }
  // Modular aircraft: liveries\<company>\<livery>\texture...
  const liv = path.join(aircraftPath, 'liveries');
  for (const company of safeReaddir(liv)) {
    if (!company.isDirectory()) continue;
    for (const livery of safeReaddir(path.join(liv, company.name))) {
      if (!livery.isDirectory()) continue;
      const lp = path.join(liv, company.name, livery.name);
      for (const t of safeReaddir(lp)) {
        if (t.isDirectory() && /^texture/i.test(t.name)) out.push(path.join(lp, t.name));
      }
    }
  }
  return out;
}

/** Lists the textures inside an aircraft, de-duplicated by texture name. */
function listTextures(aircraftPath) {
  const byKey = new Map();
  for (const folder of findTextureFolders(aircraftPath)) {
    for (const ent of safeReaddir(folder)) {
      if (!ent.isFile()) continue;
      const parts = splitTextureName(ent.name);
      if (!parts) continue;
      const full = path.join(folder, ent.name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      const editable = EDITABLE_EXTS.includes(parts.ext);
      const item = {
        name: parts.name,
        fileName: ent.name,
        ext: parts.ext,
        type: detectTextureType(parts.name),
        size,
        path: full,
        folder: path.relative(aircraftPath, folder),
        editable,
        reason: editable ? '' : 'Compiled texture (KTX2/DDS) cannot be opened. Use the developer paint kit (PSD/PNG) instead.',
      };
      const key = parts.name.toUpperCase() + '|' + item.folder.toUpperCase();
      if (!byKey.has(key)) byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.folder.localeCompare(b.folder));
}

/** Reads one aircraft folder and returns its description. */
function describeAircraft(entry, source) {
  const { aircraftPath, folder, packagePath } = entry;
  const cfgFile = ['aircraft.cfg', 'sim.cfg'].map((f) => path.join(aircraftPath, f)).find((f) => fs.existsSync(f));
  let cfg = {};
  if (cfgFile) {
    try { cfg = parseCfg(fs.readFileSync(cfgFile, 'utf8')); } catch { cfg = {}; }
  }
  const fltsims = fltsimSections(cfg);
  const baseContainer = getCfg(cfg, 'VARIATION', 'base_container');
  const names = safeReaddir(aircraftPath).map((e) => e.name.toLowerCase());
  const modular = names.includes('attachments') || names.includes('presets') || names.includes('liveries');
  const encrypted = names.some((n) => n.endsWith('.fsarchive')) ||
    safeReaddir(packagePath).some((e) => e.name.toLowerCase().endsWith('.fsarchive'));
  const title = (fltsims[0] && (fltsims[0].title || fltsims[0].ui_variation)) ||
    getCfg(cfg, 'GENERAL', 'title') || folder;
  return {
    id: Buffer.from(aircraftPath).toString('base64url'),
    title: String(title),
    folder,
    path: aircraftPath,
    packageName: path.basename(packagePath),
    source,
    modular,
    encrypted,
    isLivery: !!baseContainer,
    baseContainer: baseContainer || '',
    manufacturer: getCfg(cfg, 'GENERAL', 'icao_manufacturer') || (fltsims[0] && fltsims[0].ui_manufacturer) || '',
    model: getCfg(cfg, 'GENERAL', 'icao_model') || (fltsims[0] && fltsims[0].ui_type) || '',
    variations: fltsims.length,
    hasCfg: !!cfgFile,
  };
}

/**
 * Scans a list of roots: [{ path, source }] -> aircraft[]
 * Duplicate aircraft folders (same path) are removed.
 */
function scanAircraft(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root || !root.path || !isDir(root.path)) continue;
    for (const entry of findAircraftFolders(root.path)) {
      const key = path.resolve(entry.aircraftPath).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const ac = describeAircraft(entry, root.source);
        if (!ac.hasCfg && !ac.modular) continue; // not an aircraft
        out.push(ac);
      } catch { /* skip broken folders */ }
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Finds a default livery folder of a modular aircraft (for texture.cfg fallbacks). */
function modularFallbackFolders(aircraftPath) {
  const out = [];
  const common = path.join(aircraftPath, 'common', 'texture');
  if (isDir(common)) out.push(common);
  const liv = path.join(aircraftPath, 'liveries');
  for (const company of safeReaddir(liv)) {
    if (!company.isDirectory()) continue;
    for (const livery of safeReaddir(path.join(liv, company.name))) {
      const tex = path.join(liv, company.name, livery.name, 'texture');
      if (isDir(tex)) { out.push(tex); return out; }
    }
  }
  return out;
}

module.exports = {
  parseCfg,
  getCfg,
  fltsimSections,
  stripComment,
  splitTextureName,
  detectTextureType,
  looksEncrypted,
  findAircraftFolders,
  findTextureFolders,
  listTextures,
  describeAircraft,
  scanAircraft,
  modularFallbackFolders,
  EDITABLE_EXTS,
};
