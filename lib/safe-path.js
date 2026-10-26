/**
 * safe-path.js
 * ------------
 * Small helpers that stop the app from reading or writing files outside the
 * folders it is supposed to touch ("path traversal" protection).
 *
 * Example of what we block: a project asking to save "../../Windows/evil.dll".
 */
'use strict';

const path = require('path');

/**
 * Returns true when `child` is the same as, or inside, `parent`.
 * Both paths are resolved first, so tricks like "a/../../b" are caught.
 */
function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Joins `relative` onto `root` and throws if the result escapes `root`.
 * Use this for every file path that came from the renderer (the UI).
 */
function safeJoin(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('Invalid file path.');
  }
  if (relative.includes('\0')) throw new Error('Invalid file path.');
  const full = path.resolve(root, relative);
  if (!isInside(root, full) || full === path.resolve(root)) {
    throw new Error('Blocked: path is outside the project folder.');
  }
  return full;
}

/**
 * Turns any text into a safe, lowercase "slug" that only contains a-z, 0-9
 * and dashes. Used for package names and folder names.
 *   "Delta Air Lines A320!" -> "delta-air-lines-a320"
 */
function slugify(text, maxLen = 48) {
  const s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return s;
}

/** Makes a Windows-safe file/folder name (keeps case and spaces). */
function safeFileName(text, fallback = 'untitled') {
  const s = String(text || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 80);
  return s || fallback;
}

module.exports = { isInside, safeJoin, slugify, safeFileName };
