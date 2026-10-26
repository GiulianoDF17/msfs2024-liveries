/**
 * settings.js
 * -----------
 * Reads and writes settings.json inside Electron's "userData" folder
 * (on Windows: %APPDATA%\Livery Forge\settings.json).
 *
 * The folder is passed in so this file can also be used from tests
 * without starting Electron.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Every setting the app knows about, with its default value. */
const DEFAULTS = Object.freeze({
  communityPath: '',          // ...\Community
  officialPath: '',           // ...\Official\OneStore or ...\Official\Steam
  extraAircraftPaths: [],     // extra folders the user added
  sdkPath: '',                // MSFS 2024 SDK root folder
  edition: 'store',           // 'store' (Microsoft Store / Xbox) or 'steam'
  installMode: 'link',        // 'link' (junction) or 'copy'
  highQualityTextures: true,  // adds QUALITYHIGH to texture XML files
  defaultAuthor: '',
  // Cloud server (Supabase). Can also come from config/supabase.json.
  supabaseUrl: '',
  supabaseAnonKey: '',
  // Publishing queue pacing (flightsim.to users report ~3 uploads per hour).
  uploadsPerHour: 3,
  onboardingDone: false,
});

class Settings {
  /** @param {string} folder Folder where settings.json lives. */
  constructor(folder) {
    this.file = path.join(folder, 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Only copy known keys so a broken file can't inject strange values.
      for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] !== undefined && typeof raw[key] === typeof DEFAULTS[key]) {
          this.data[key] = raw[key];
        }
      }
    } catch {
      // No settings yet (first start) or unreadable file: keep defaults.
    }
    return this.data;
  }

  get() {
    return { ...this.data, extraAircraftPaths: [...this.data.extraAircraftPaths] };
  }

  /** Merge `patch` into the settings and save. Unknown keys are ignored. */
  update(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULTS)) continue;
      if (typeof value !== typeof DEFAULTS[key]) continue;
      if (Array.isArray(DEFAULTS[key])) {
        this.data[key] = value.filter((v) => typeof v === 'string');
      } else {
        this.data[key] = value;
      }
    }
    this.save();
    return this.get();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write to a temp file first then rename, so a crash can't corrupt it.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS };
