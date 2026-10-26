/**
 * msfs-paths.js
 * -------------
 * Finds where Microsoft Flight Simulator 2024 and its SDK are installed.
 *
 * How it works:
 *  - MSFS 2024 writes the location of its packages into a file called
 *    UserCfg.opt, on a line like:   InstalledPackagesPath "D:\MSFS2024"
 *  - Microsoft Store / Xbox edition keeps UserCfg.opt in
 *      %LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\
 *  - Steam edition keeps it in
 *      %APPDATA%\Microsoft Flight Simulator 2024\
 *  - Community folder = <InstalledPackagesPath>\Community
 *  - Official folder  = <InstalledPackagesPath>\Official\OneStore (Store)
 *                       <InstalledPackagesPath>\Official\Steam    (Steam)
 *  - The SDK is found through the MSFS2024_SDK environment variable or the
 *    default folder C:\MSFS 2024 SDK.
 *
 * Every function accepts an optional `env` object so tests can fake
 * environment variables and folders.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STORE_PACKAGE = 'Microsoft.Limitless_8wekyb3d8bbwe';

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/** Reads the InstalledPackagesPath value out of a UserCfg.opt text. */
function parseUserCfg(text) {
  const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

/** Returns the possible UserCfg.opt locations, Store first, then Steam. */
function userCfgCandidates(env = process.env) {
  const list = [];
  if (env.LOCALAPPDATA) {
    list.push({
      edition: 'store',
      file: path.join(env.LOCALAPPDATA, 'Packages', STORE_PACKAGE, 'LocalCache', 'UserCfg.opt'),
    });
  }
  if (env.APPDATA) {
    list.push({
      edition: 'steam',
      file: path.join(env.APPDATA, 'Microsoft Flight Simulator 2024', 'UserCfg.opt'),
    });
  }
  return list;
}

/** Path to fspackagetool.exe inside an SDK root folder. */
function packageToolPath(sdkRoot) {
  return path.join(sdkRoot || '', 'Tools', 'bin', 'fspackagetool.exe');
}

/** True when the SDK folder really contains fspackagetool.exe. */
function isValidSdk(sdkRoot) {
  return !!sdkRoot && exists(packageToolPath(sdkRoot));
}

/** Looks for the SDK in the usual places. Returns '' if not found. */
function detectSdk(env = process.env) {
  const candidates = [
    env.MSFS2024_SDK,
    'C:\\MSFS 2024 SDK',
    env.ProgramFiles && path.join(env.ProgramFiles, 'MSFS 2024 SDK'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (isValidSdk(c)) return c;
  }
  return '';
}

/**
 * Detects the MSFS 2024 install.
 * Returns { found, edition, packagesPath, communityPath, officialPath, sdkPath, userCfg, notes[] }
 */
function detectInstall(env = process.env) {
  const result = {
    found: false,
    edition: 'store',
    packagesPath: '',
    communityPath: '',
    officialPath: '',
    sdkPath: detectSdk(env),
    userCfg: '',
    notes: [],
  };

  for (const cand of userCfgCandidates(env)) {
    if (!exists(cand.file)) continue;
    let text = '';
    try { text = fs.readFileSync(cand.file, 'utf8'); } catch { continue; }
    const pkgPath = parseUserCfg(text);
    if (!pkgPath) {
      result.notes.push(`Found ${cand.file} but it has no InstalledPackagesPath line.`);
      continue;
    }
    result.found = true;
    result.edition = cand.edition;
    result.userCfg = cand.file;
    result.packagesPath = pkgPath;
    result.communityPath = path.join(pkgPath, 'Community');
    // Prefer the folder that matches the edition, but fall back to the other.
    const officialStore = path.join(pkgPath, 'Official', 'OneStore');
    const officialSteam = path.join(pkgPath, 'Official', 'Steam');
    if (cand.edition === 'steam') {
      result.officialPath = exists(officialSteam) ? officialSteam : (exists(officialStore) ? officialStore : officialSteam);
    } else {
      result.officialPath = exists(officialStore) ? officialStore : (exists(officialSteam) ? officialSteam : officialStore);
    }
    if (!exists(result.communityPath)) result.notes.push('Community folder does not exist yet. It will be created when needed.');
    break;
  }

  if (!result.found) result.notes.push('Could not find UserCfg.opt for MSFS 2024. Set the folders manually.');
  if (!result.sdkPath) result.notes.push('MSFS 2024 SDK not found. Install it and set the SDK folder in Settings.');
  return result;
}

module.exports = {
  parseUserCfg,
  userCfgCandidates,
  packageToolPath,
  isValidSdk,
  detectSdk,
  detectInstall,
  STORE_PACKAGE,
};
