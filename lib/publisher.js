/**
 * publisher.js
 * ------------
 * Helps the user publish on flightsim.to.
 *
 * IMPORTANT: flightsim.to has no public upload API. Livery Forge never logs
 * in for the user, never scrapes the site and never stores their password.
 * We only prepare a tidy "upload bundle" folder plus a checklist, and the
 * user uploads it themselves in their normal web browser.
 *
 * Bundle layout (in Documents\Livery Forge\Output\):
 *   <package>_flightsimto\
 *       <package>_v1.0.0.zip
 *       01.jpg, 02.jpg ...          (screenshots, numbered)
 *       upload-info.json            (all fields, machine-readable)
 *       UPLOAD-CHECKLIST.txt        (step-by-step, ready-to-paste text)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeVersion, layout } = require('./packager');

const LIMITS = Object.freeze({
  maxZipBytes: 2.5 * 1024 * 1024 * 1024, // 2.5 GB
  maxImageBytes: 5 * 1024 * 1024,        // 5 MB per screenshot
  minImages: 1,
  maxImages: 18,
  minDescriptionChars: 50,
});

const RULE_TEXT = 'flightsim.to rule: only upload your own work, or work you have written permission to share.';

/** Very small check that a text is (mostly) English. */
function looksEnglish(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  const letters = s.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const latin = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  if (latin / letters.length < 0.85) return false;
  const words = s.toLowerCase().match(/[a-z']+/g) || [];
  const common = new Set(['the', 'and', 'a', 'an', 'of', 'for', 'with', 'this', 'is', 'in', 'to', 'livery', 'aircraft', 'on', 'by', 'it', 'from', 'my', 'your', 'are', 'as', 'paint', 'repaint', 'textures', 'includes', 'based']);
  // Frequent words of other languages that use the Latin alphabet.
  const foreign = new Set(['le', 'la', 'les', 'une', 'des', 'est', 'et', 'pour', 'avec', 'der', 'die', 'das', 'und', 'ist', 'mit', 'ein', 'eine', 'für', 'el', 'los', 'las', 'y', 'con', 'para', 'una', 'del', 'il', 'di', 'che', 'per', 'het', 'een', 'voor', 'og', 'och', 'em', 'um', 'uma', 'com', 'não']);
  const hits = words.filter((w) => common.has(w)).length;
  const foreignHits = words.filter((w) => foreign.has(w)).length;
  if (foreignHits > hits) return false;
  return words.length < 8 ? hits >= 1 : hits / words.length >= 0.05;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

/**
 * Validates a project for flightsim.to. Returns { ok, errors[], warnings[] }.
 * `projectDir` is needed to check screenshot files.
 */
function validate(project, projectDir) {
  const errors = [];
  const warnings = [];
  const d = project.details || {};

  if (!d.title || !d.title.trim()) errors.push('Title is missing.');
  if (!d.author || !d.author.trim()) errors.push('Author is missing.');
  if (!d.description || d.description.trim().length < LIMITS.minDescriptionChars) {
    errors.push(`Write a description of at least ${LIMITS.minDescriptionChars} characters.`);
  } else if (!looksEnglish(d.description)) {
    errors.push('The description must be in English (flightsim.to requires English).');
  }
  if (!d.ownWork) errors.push('Tick "This is my own work or I have written permission".');

  const zip = project.export && project.export.zipPath;
  if (!zip) {
    errors.push('Export the package first (step 4).');
  } else {
    const size = fileSize(zip);
    if (size < 0) errors.push('The exported zip was not found. Export again.');
    else if (size > LIMITS.maxZipBytes) errors.push('The zip is larger than 2.5 GB.');
    else if (size === 0) errors.push('The exported zip is empty. Export again.');
  }
  if (project.export && project.export.sourceOnly) {
    errors.push('Only a source project was exported. flightsim.to needs a compiled package - export with the SDK.');
  }

  const shots = Array.isArray(d.screenshots) ? d.screenshots : [];
  if (shots.length < LIMITS.minImages) errors.push('Add at least 1 screenshot.');
  if (shots.length > LIMITS.maxImages) errors.push(`Too many screenshots (max ${LIMITS.maxImages}).`);
  for (const s of shots) {
    const size = fileSize(path.join(projectDir, s));
    if (size < 0) errors.push(`Screenshot ${s} is missing.`);
    else if (size > LIMITS.maxImageBytes) errors.push(`Screenshot ${s} is larger than 5 MB.`);
  }

  if (!d.tags || d.tags.length === 0) warnings.push('Adding a few tags helps people find your livery.');
  if (!d.changelog) warnings.push('A changelog is recommended.');
  if (project.aircraft && project.aircraft.modular) warnings.push('Modular aircraft support is experimental - make sure you tested it in the sim.');

  return { ok: errors.length === 0, errors, warnings };
}

/** Builds the ready-to-paste description for flightsim.to. */
function buildDescription(project) {
  const d = project.details;
  const parts = [];
  parts.push(d.description.trim());
  const facts = [];
  facts.push(`Aircraft: ${project.aircraft.title}`);
  if (d.atcId) facts.push(`Registration: ${d.atcId}`);
  if (d.atcAirline) facts.push(`Airline: ${d.atcAirline}${d.icaoAirline ? ` (${d.icaoAirline})` : ''}`);
  facts.push(`Version: ${normalizeVersion(d.version)}`);
  facts.push('Simulator: Microsoft Flight Simulator 2024');
  parts.push(facts.join('\n'));
  parts.push([
    'Installation:',
    '1. Download and unzip.',
    '2. Drag the folder inside into your MSFS 2024 Community folder.',
    '3. Start the sim and select the livery.',
  ].join('\n'));
  if (d.credits) parts.push(`Credits:\n${d.credits.trim()}`);
  if (d.license) parts.push(`License:\n${d.license.trim()}`);
  return parts.join('\n\n');
}

/** Everything flightsim.to asks for, as plain data. */
function uploadInfo(project) {
  const d = project.details;
  return {
    title: d.title,
    version: normalizeVersion(d.version),
    simulator: 'Microsoft Flight Simulator 2024',
    category: `Liveries > ${project.aircraft.title}`,
    aircraft: project.aircraft.title,
    author: d.author,
    tags: d.tags || [],
    shortDescription: d.shortDescription || '',
    description: buildDescription(project),
    changelog: d.changelog || '',
    registration: d.atcId || '',
    license: d.license || '',
    rule: RULE_TEXT,
    generatedAt: new Date().toISOString(),
  };
}

function checklistText(info, zipName, imageNames) {
  return [
    'FLIGHTSIM.TO UPLOAD CHECKLIST',
    '=============================',
    '',
    RULE_TEXT,
    '',
    '[ ] 1. Log in at https://flightsim.to in your browser.',
    '[ ] 2. Open https://flightsim.to/upload',
    `[ ] 3. Title:      ${info.title}`,
    `[ ] 4. Version:    ${info.version}`,
    `[ ] 5. Simulator:  ${info.simulator}`,
    `[ ] 6. Category:   ${info.category}`,
    `[ ] 7. Tags:       ${info.tags.join(', ') || '(none)'}`,
    `[ ] 8. Upload the file: ${zipName}`,
    `[ ] 9. Upload the images in order: ${imageNames.join(', ')}`,
    '[ ] 10. Paste the description below.',
    '[ ] 11. Paste the changelog below.',
    '[ ] 12. Submit, then press "Mark as submitted" in Livery Forge.',
    '',
    '----- DESCRIPTION (copy everything between the lines) -----',
    info.description,
    '----- END DESCRIPTION -----',
    '',
    '----- CHANGELOG -----',
    info.changelog,
    '----- END CHANGELOG -----',
    '',
  ].join('\r\n');
}

/**
 * Creates the upload bundle. Throws if validation fails.
 * Returns { bundleDir, files[] }.
 */
function prepareBundle(project, projectDir, outputRoot) {
  const v = validate(project, projectDir);
  if (!v.ok) {
    const err = new Error('Fix these first:\n- ' + v.errors.join('\n- '));
    err.validation = v;
    throw err;
  }
  const { pkg } = layout(project);
  const bundleDir = path.join(outputRoot, `${pkg}_flightsimto`);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  const zipName = path.basename(project.export.zipPath);
  fs.copyFileSync(project.export.zipPath, path.join(bundleDir, zipName));

  const imageNames = [];
  project.details.screenshots.forEach((s, i) => {
    const ext = path.extname(s).toLowerCase() || '.jpg';
    const name = String(i + 1).padStart(2, '0') + ext;
    fs.copyFileSync(path.join(projectDir, s), path.join(bundleDir, name));
    imageNames.push(name);
  });

  const info = { ...uploadInfo(project), file: zipName, images: imageNames };
  fs.writeFileSync(path.join(bundleDir, 'upload-info.json'), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(bundleDir, 'UPLOAD-CHECKLIST.txt'), checklistText(info, zipName, imageNames));
  return { bundleDir, files: [zipName, ...imageNames, 'upload-info.json', 'UPLOAD-CHECKLIST.txt'], warnings: v.warnings };
}

/**
 * Pacing for batch publishing: given the times (ISO strings or ms) of past
 * submissions, returns the earliest time the next upload is allowed.
 * Default 3 uploads per rolling hour.
 */
function nextAllowedAt(submittedTimes, perHour = 3, now = Date.now()) {
  const hour = 60 * 60 * 1000;
  const recent = submittedTimes
    .map((t) => (typeof t === 'number' ? t : Date.parse(t)))
    .filter((t) => Number.isFinite(t) && now - t < hour)
    .sort((a, b) => a - b);
  if (recent.length < perHour) return now;
  // The oldest of the last `perHour` uploads must fall out of the window.
  return recent[recent.length - perHour] + hour;
}

module.exports = { validate, buildDescription, uploadInfo, prepareBundle, nextAllowedAt, looksEnglish, checklistText, LIMITS, RULE_TEXT };
