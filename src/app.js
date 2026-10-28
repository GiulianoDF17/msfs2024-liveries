/**
 * app.js - all screens of Livery Forge
 * ====================================
 * The page talks to the computer ONLY through `window.lf` (see preload.js).
 *
 * Screens:
 *   auth      log in / create account (user, creator or both) / reset password
 *   projects  0. saved livery projects
 *   aircraft  1. pick an installed aircraft
 *   paint     2. built-in texture editor (editor.js)
 *   details   3. title, author, registration, screenshots...
 *   export    4. build the package, link it into Community
 *   publish   5. Livery Forge Marketplace + flightsim.to upload helper
 *   market    Marketplace: browse, download, rate, follow creators
 *   hangar    your library, favorites, followed creators, downloads on this PC
 *   studio    creator dashboard
 *   profile   your account
 *   settings  6. folders, SDK, cloud server
 *
 * All text from users (marketplace etc.) is inserted with textContent, never
 * as HTML, so nobody can inject code into the app.
 */
(function () {
  'use strict';

  const lf = window.lf;

  /* ================================================================ */
  /* State                                                             */
  /* ================================================================ */

  const S = {
    info: null,
    settings: null,
    cloud: { configured: false, user: null, offline: false },
    sync: { state: 'idle', message: '' },
    screen: 'projects',
    project: null,             // the open project (full object)
    aircraft: [],
    aircraftRoots: [],
    aircraftSearch: '',
    selectedAircraft: null,
    selectedTextures: null,
    editor: null,
    texId: null,               // texture open in the editor
    aircraftTextures: null,    // textures of the project's aircraft (for suggestions)
    exportLog: [],
    exportBusy: false,
    market: { view: 'browse', search: '', sort: 'new', items: [], total: 0, page: 0, detail: null, creator: null, shot: 0 },
    hangarTab: 'library',
  };

  /* ================================================================ */
  /* Small helpers                                                     */
  /* ================================================================ */

  /** Creates an element: h('div', { class: 'x', onclick }, 'text', child) */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const screenEl = (name) => document.getElementById('screen-' + name);

  function toast(msg, kind = 'info', ms = 4200) {
    const t = h('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'error' ? ms * 2 : ms);
  }

  /** Runs an async action and shows errors as a toast. */
  async function attempt(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(e.message || String(e), 'error');
      return undefined;
    }
  }

  /**
   * Shows a dialog. onOk may return false (or a Promise of false) to keep it open.
   */
  function modal({ title, body, okLabel = 'OK', cancelLabel = 'Cancel', onOk, onCancel, wide = false, danger = false, hideCancel = false }) {
    const back = $('#modal');
    back.textContent = '';
    const close = () => { back.classList.remove('open'); back.textContent = ''; document.removeEventListener('keydown', onKey, true); };
    const okBtn = h('button', { class: `btn ${danger ? 'danger' : 'primary'}` }, okLabel);
    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      try {
        const r = onOk ? await onOk() : true;
        if (r !== false) close();
      } catch (e) { toast(e.message, 'error'); }
      okBtn.disabled = false;
    });
    const cancel = () => { close(); if (onCancel) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.isComposing) { e.preventDefault(); okBtn.click(); }
    };
    document.addEventListener('keydown', onKey, true);
    const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, hideCancel ? null : h('button', { class: 'btn ghost', onclick: cancel }, cancelLabel), okBtn));
    back.append(box);
    back.classList.add('open');
    const first = box.querySelector('input:not([type=checkbox]):not([type=color]), textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
    return { close };
  }

  function confirmBox(title, message, okLabel = 'Delete', danger = true) {
    return new Promise((resolve) => {
      modal({ title, body: h('p', {}, message), okLabel, danger, onOk: () => resolve(true), onCancel: () => resolve(false) });
    });
  }

  function setProgress(p) {
    const el = $('#progress');
    if (!p) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    $('.progress-label', el).textContent = p.label || 'Working...';
    $('.progress-bar div', el).style.width = Math.round((p.value || 0) * 100) + '%';
  }

  const fmtBytes = (b) => {
    if (!b && b !== 0) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  };
  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago';
    return new Date(t).toLocaleDateString();
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const projUrl = (id, rel, stamp) => `lfproj://project/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(stamp || Date.now())}`;
  const cssUrl = (u) => `url("${String(u).replace(/"/g, '%22')}")`;
  const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const stars = (avg) => { const n = Math.round(Number(avg) || 0); return '★'.repeat(n) + '☆'.repeat(5 - n); };
  const roleLabel = (r) => ({ user: 'Pilot', creator: 'Creator', both: 'Pilot & Creator' }[r] || 'Pilot');
  const isCreator = () => !!(S.cloud.user && S.cloud.user.profile && ['creator', 'both'].includes(S.cloud.user.profile.role));

  function detectType(name) {
    const n = String(name || '').toUpperCase();
    if (/_(COMP|ORM|METAL|ROUGH)(\b|_|$)/.test(n)) return 'comp';
    if (/_(NORM|NORMAL|NRM)(\b|_|$)/.test(n)) return 'normal';
    if (/_(DECAL|DECALS)(\b|_|$)/.test(n)) return 'decal';
    if (/_(EMIS|EMISSIVE)(\b|_|$)/.test(n)) return 'emissive';
    return 'albedo';
  }
  const TYPE_LABEL = { albedo: 'Albedo (color)', decal: 'Decal', comp: 'COMP (metal/rough/AO)', normal: 'Normal map', emissive: 'Emissive' };

  function avatar(profile, size = '') {
    const p = profile || {};
    const letter = (p.display_name || p.username || '?').trim().charAt(0).toUpperCase();
    const a = h('div', { class: `avatar ${size}`, style: `background-color:${/^#[0-9a-f]{6}$/i.test(p.accent_color || '') ? p.accent_color : '#3b82f6'}` });
    if (p.avatar_url && /^https?:\/\//.test(p.avatar_url)) a.style.backgroundImage = cssUrl(p.avatar_url);
    else a.textContent = letter;
    return a;
  }

  function emptyState(icon, title, text, ...actions) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon), h('h3', {}, title), h('p', {}, text), h('div', { class: 'row gap', style: 'justify-content:center' }, actions));
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function pageHead(title, subtitle, ...actions) {
    return h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null), h('div', { class: 'row gap' }, actions));
  }

  /* ================================================================ */
  /* Start-up & authentication                                         */
  /* ================================================================ */

  async function init() {
    S.info = await lf.app.info();
    S.settings = await lf.settings.get();
    S.cloud = await lf.cloud.status().catch(() => ({ configured: false, user: null }));

    lf.on('progress', setProgress);
    lf.on('export:log', (entry) => addLog(entry.level, entry.text));
    lf.on('cloud:sync', (s) => {
      S.sync = s;
      renderAccount();
      if (s.state === 'synced' && S.screen === 'projects' && !s.projectId) renderProjects();
      if (s.state === 'error' && s.message) toast('Cloud sync: ' + s.message, 'warn');
    });

    let offline = false;
    try { offline = localStorage.getItem('lf.offline') === '1'; } catch { /* ignore */ }
    if (S.cloud.user || offline) startApp();
    else showAuth();
  }

  function showAuth(mode = 'login') {
    $('#app').classList.add('hidden');
    const root = $('#auth');
    root.classList.remove('hidden');
    root.textContent = '';
    const art = h('div', { class: 'auth-art' },
      h('div', { class: 'runway' }), h('div', { class: 'plane' }, '✈'),
      h('h1', {}, 'Livery Forge'),
      h('p', {}, 'From "pick an aircraft" to "published livery" in one place. Paint textures, package them for MSFS 2024, test in the sim and share them with the community.'),
      h('div', { class: 'features' }, h('span', { class: 'badge blue' }, '🎨 Built-in painter'), h('span', { class: 'badge blue' }, '📦 One-click packages'), h('span', { class: 'badge blue' }, '☁ Cloud sync'), h('span', { class: 'badge blue' }, '🛒 Marketplace')));
    const formSide = h('div', { class: 'auth-form' });
    const box = h('div', { class: 'auth-box' });
    formSide.append(box);
    root.append(art, formSide);

    if (!S.cloud.configured) { renderServerSetup(box); return; }

    const tabs = h('div', { class: 'tabs' },
      h('button', { class: mode === 'login' ? 'active' : '', onclick: () => showAuth('login') }, 'Log in'),
      h('button', { class: mode === 'signup' ? 'active' : '', onclick: () => showAuth('signup') }, 'Create account'));
    box.append(h('h2', {}, mode === 'signup' ? 'Join the hangar ✈' : mode === 'reset' ? 'Reset your password' : 'Welcome back, captain'), tabs);
    if (mode === 'signup') renderSignup(box);
    else if (mode === 'reset') renderReset(box);
    else renderLogin(box);
    box.append(h('div', { class: 'row', style: 'justify-content:center;margin-top:18px' },
      h('button', { class: 'btn ghost small', onclick: goOffline }, 'Continue without an account (offline)')));
  }

  function goOffline() {
    try { localStorage.setItem('lf.offline', '1'); } catch { /* ignore */ }
    startApp();
    toast('Offline mode: projects stay on this PC only. Log in from the bottom-left to sync and use the marketplace.', 'info', 7000);
  }

  function renderServerSetup(box) {
    const url = h('input', { type: 'url', placeholder: 'https://xxxxxxxx.supabase.co', value: S.settings.supabaseUrl || '' });
    const key = h('input', { type: 'text', placeholder: 'eyJhbGciOi... (anon public key)', value: S.settings.supabaseAnonKey || '' });
    box.append(
      h('h2', {}, 'Connect the cloud server'),
      h('p', { class: 'muted' }, 'Accounts, cloud sync and the marketplace run on your own free Supabase project. The README explains how to create one in about 5 minutes. Paste the Project URL and the anon public key here:'),
      h('div', { class: 'form-grid' }, field('Supabase Project URL', url), field('Supabase anon (public) key', key),
        h('button', { class: 'btn primary big', onclick: async () => {
          const r = await attempt(() => lf.settings.set({ supabaseUrl: url.value.trim(), supabaseAnonKey: key.value.trim() }));
          if (!r) return;
          S.settings = r;
          S.cloud = await lf.cloud.status();
          if (!S.cloud.configured) toast('That URL or key does not look right.', 'error');
          else showAuth('signup');
        } }, 'Connect')),
      h('div', { class: 'notice info', style: 'margin-top:14px' }, h('div', {}, 'You can also skip this and use Livery Forge offline. Painting, exporting and flightsim.to publishing work without an account.')),
      h('div', { class: 'row', style: 'justify-content:center;margin-top:18px' }, h('button', { class: 'btn ghost', onclick: goOffline }, 'Continue offline')));
  }

  function renderLogin(box) {
    const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
    const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn primary big', type: 'submit' }, 'Log in');
    const form = h('form', { class: 'form-grid', onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; btn.textContent = 'Logging in...';
      const user = await attempt(() => lf.cloud.signIn({ email: email.value, password: pw.value }));
      btn.disabled = false; btn.textContent = 'Log in';
      if (!user) return;
      S.cloud = { configured: true, user, offline: false };
      try { localStorage.removeItem('lf.offline'); } catch { /* ignore */ }
      startApp();
      toast(`Welcome back, ${user.profile ? user.profile.display_name || user.profile.username : ''}!`, 'ok');
    } }, field('Email', email), field('Password', pw), btn,
    h('button', { type: 'button', class: 'btn ghost small', onclick: () => showAuth('reset') }, 'Forgot your password?'));
    box.append(form);
  }

  function passwordScore(pw) {
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  }

  function renderSignup(box) {
    let role = 'both';
    const display = h('input', { type: 'text', placeholder: 'e.g. Captain Sarah', maxlength: '60' });
    const uname = h('input', { type: 'text', placeholder: 'e.g. sarah_paints', maxlength: '24', spellcheck: 'false' });
    const unameHint = h('div', { class: 'hint' }, '3-24 characters: a-z, 0-9 and _');
    const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
    const pw = h('input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
    const pw2 = h('input', { type: 'password', placeholder: 'Type it again', autocomplete: 'new-password' });
    const meter = h('div', { class: 'pw-meter' }, h('div'));
    const agree = h('input', { type: 'checkbox' });
    pw.addEventListener('input', () => {
      const s = passwordScore(pw.value);
      const bar = meter.firstChild;
      bar.style.width = (s * 20) + '%';
      bar.style.background = s <= 2 ? 'var(--error)' : s === 3 ? 'var(--warn)' : 'var(--ok)';
    });
    display.addEventListener('input', () => {
      if (!uname.dataset.touched) uname.value = display.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
      checkName();
    });
    const checkName = debounce(async () => {
      const v = uname.value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,24}$/.test(v)) { unameHint.textContent = '3-24 characters: a-z, 0-9 and _'; unameHint.style.color = ''; return; }
      const ok = await lf.cloud.usernameAvailable(v).catch(() => null);
      if (ok === null) return;
      unameHint.textContent = ok ? `✓ @${v} is available` : `✗ @${v} is taken`;
      unameHint.style.color = ok ? 'var(--ok)' : 'var(--error)';
    }, 350);
    uname.addEventListener('input', () => { uname.dataset.touched = '1'; uname.value = uname.value.toLowerCase(); checkName(); });

    const roles = [
      { id: 'user', ico: '🛩', title: 'Pilot', text: 'Download & fly liveries from the marketplace' },
      { id: 'creator', ico: '🎨', title: 'Creator', text: 'Paint liveries and publish them' },
      { id: 'both', ico: '⭐', title: 'Both', text: 'Fly, paint, share - the full hangar' },
    ];
    const roleCards = h('div', { class: 'role-cards' });
    const drawRoles = () => {
      roleCards.textContent = '';
      for (const r of roles) {
        roleCards.append(h('div', { class: 'role-card' + (role === r.id ? ' active' : ''), onclick: () => { role = r.id; drawRoles(); } },
          h('div', { class: 'ico' }, r.ico), h('b', {}, r.title), h('small', {}, r.text)));
      }
    };
    drawRoles();

    const btn = h('button', { class: 'btn primary big', type: 'submit' }, 'Create my account');
    const form = h('form', { class: 'form-grid', onsubmit: async (e) => {
      e.preventDefault();
      if (pw.value !== pw2.value) { toast('The two passwords are not the same.', 'error'); return; }
      if (!agree.checked) { toast('Please accept the community rules.', 'error'); return; }
      btn.disabled = true; btn.textContent = 'Creating account...';
      const r = await attempt(() => lf.cloud.signUp({ email: email.value, password: pw.value, username: uname.value, displayName: display.value || uname.value, role }));
      btn.disabled = false; btn.textContent = 'Create my account';
      if (!r) return;
      if (r.needsConfirmation) {
        box.textContent = '';
        box.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, '📬'), h('h3', {}, 'Check your email'),
          h('p', {}, `We sent a confirmation link to ${email.value}. Click it, then come back and log in.`),
          h('button', { class: 'btn primary', onclick: () => showAuth('login') }, 'Go to log in')));
        return;
      }
      S.cloud = { configured: true, user: r.user, offline: false };
      try { localStorage.removeItem('lf.offline'); } catch { /* ignore */ }
      startApp();
      toast(`Welcome aboard, ${display.value || uname.value}! ✈`, 'ok', 6000);
    } },
    h('div', { class: 'field' }, h('span', {}, 'How will you use Livery Forge?'), roleCards, h('div', { class: 'hint' }, 'You can change this any time in your profile.')),
    h('div', { class: 'form-grid cols-2' }, field('Display name', display), h('label', { class: 'field' }, h('span', {}, 'Username'), uname, unameHint)),
    field('Email', email),
    h('div', { class: 'form-grid cols-2' }, h('label', { class: 'field' }, h('span', {}, 'Password'), pw, meter), field('Repeat password', pw2)),
    h('label', { class: 'check small' }, agree, 'I will only publish my own work or work I have written permission to share.'),
    btn);
    box.append(form);
  }

  function renderReset(box) {
    const email = h('input', { type: 'email', placeholder: 'you@example.com' });
    const code = h('input', { type: 'text', placeholder: '6-digit code from the email', maxlength: '10' });
    const pw = h('input', { type: 'password', placeholder: 'New password (8+ characters)' });
    const step2 = h('div', { class: 'form-grid hidden' }, field('Code from the email', code), field('New password', pw),
      h('button', { class: 'btn primary', onclick: async () => {
        const user = await attempt(() => lf.cloud.resetWithCode({ email: email.value, code: code.value, newPassword: pw.value }));
        if (!user) return;
        S.cloud = { configured: true, user, offline: false };
        startApp();
        toast('Password changed. You are logged in.', 'ok');
      } }, 'Set new password'));
    box.append(h('div', { class: 'form-grid' },
      h('p', { class: 'muted' }, 'Enter your email. We will send you a code to set a new password.'),
      field('Email', email),
      h('button', { class: 'btn', onclick: async () => {
        const ok = await attempt(() => lf.cloud.sendReset(email.value), 'Email sent. Check your inbox.');
        if (ok) step2.classList.remove('hidden');
      } }, 'Send code'),
      step2,
      h('button', { class: 'btn ghost small', onclick: () => showAuth('login') }, '← Back to log in')));
  }

  /* ================================================================ */
  /* App shell                                                         */
  /* ================================================================ */

  let started = false;
  function startApp() {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    if (!started) {
      started = true;
      document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.screen)));
      setInterval(() => { if (S.editor && S.editor.dirty && S.screen === 'paint') saveTexture(true); }, 120000);
      window.addEventListener('beforeunload', () => { /* autosave happens on navigation */ });
    }
    renderAccount();
    S.project = null;
    S.editor && S.editor.clear();
    S.texId = null;
    navigate('projects');
    if (S.cloud.user) runSync(false);
  }

  async function runSync(showToast = true) {
    if (!S.cloud.user) return;
    const r = await attempt(() => lf.cloud.syncAll());
    if (r && showToast) toast(`Sync done: ${r.pulled} downloaded, ${r.pushed} uploaded.`, 'ok');
    if (S.screen === 'projects') renderProjects();
  }

  function renderAccount() {
    const box = $('#account');
    box.textContent = '';
    const u = S.cloud.user;
    if (!u) {
      box.append(h('div', { class: 'account-card', onclick: () => showAuth(S.cloud.configured ? 'login' : 'login') },
        h('div', { class: 'avatar' }, '?'),
        h('div', {}, h('div', { class: 'account-name' }, 'Offline mode'), h('div', { class: 'muted small' }, 'Log in to sync & share'))));
      return;
    }
    const p = u.profile || {};
    const s = S.sync;
    const dot = s.state === 'syncing' ? 'busy' : s.state === 'error' ? 'error' : s.state === 'synced' ? 'ok' : '';
    const txt = s.state === 'syncing' ? (s.message || 'Syncing...') : s.state === 'error' ? 'Sync problem' : s.state === 'synced' ? `Synced ${timeAgo(s.at)}` : (S.cloud.offline ? 'Offline' : 'Cloud ready');
    box.append(h('div', { class: 'account-card', title: 'Your profile', onclick: () => navigate('profile') },
      avatar(p),
      h('div', { style: 'min-width:0' }, h('div', { class: 'account-name' }, p.display_name || p.username || u.email), h('div', { class: 'muted small' }, `@${p.username || ''} · ${roleLabel(p.role)}`))),
    h('div', { class: 'sync', title: s.message || '' }, h('span', { class: `dot ${dot}` }), txt));
    // Creator studio only for creators.
    const studioBtn = $('#nav button[data-screen="studio"]');
    if (studioBtn) studioBtn.classList.toggle('hidden', !isCreator());
  }

  function updateNav() {
    document.querySelectorAll('#nav button').forEach((b) => {
      b.classList.toggle('active', b.dataset.screen === S.screen);
      if (b.hasAttribute('data-needs-project')) b.disabled = !S.project;
      if (b.hasAttribute('data-creator')) b.classList.toggle('hidden', !isCreator());
    });
    const cp = $('#currentProject');
    cp.textContent = '';
    if (S.project) {
      cp.append(h('div', { class: 'label' }, 'Current livery'), h('div', { class: 'name', title: S.project.name }, S.project.name), h('div', { class: 'muted small' }, S.project.aircraft.title));
    } else {
      cp.append(h('div', { class: 'label' }, 'No livery open'), h('div', { class: 'muted small' }, 'Open or create one in Projects.'));
    }
  }

  async function navigate(screen) {
    if (S.screen === 'paint' && screen !== 'paint') await saveTexture(true);
    if (['paint', 'details', 'export'].includes(screen) && !S.project) { toast('Open or create a livery project first.', 'warn'); screen = 'projects'; }
    S.screen = screen;
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + screen));
    updateNav();
    const renderers = { projects: renderProjects, aircraft: renderAircraft, paint: renderPaint, details: renderDetails, export: renderExport, publish: renderPublish, market: renderMarket, hangar: renderHangar, studio: renderStudio, profile: renderProfile, settings: renderSettings };
    try { await (renderers[screen] || (() => {}))(); } catch (e) { console.error(e); toast(e.message, 'error'); }
  }

  async function openProject(id, screen = 'paint') {
    const p = await attempt(() => lf.projects.load(id));
    if (!p) return;
    if (S.editor) S.editor.clear();
    S.project = p;
    S.texId = null;
    S.aircraftTextures = null;
    S.exportLog = [];
    navigate(screen);
  }

  /** Saves the open project (details etc.). */
  async function saveProject() {
    if (!S.project) return;
    const saved = await attempt(() => lf.projects.save(S.project));
    if (saved) S.project = saved;
  }

  /* ================================================================ */
  /* 0. Projects                                                       */
  /* ================================================================ */

  async function renderProjects() {
    const el = screenEl('projects');
    const list = await lf.projects.list().catch(() => []);
    el.textContent = '';
    el.append(pageHead('Your liveries', S.cloud.user ? 'Saved on this PC and in your cloud hangar.' : 'Saved on this PC (offline mode).',
      S.cloud.user ? h('button', { class: 'btn', onclick: () => runSync(true) }, '⟳ Sync now') : null,
      h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.openFolder('projects')) }, '📁 Open folder'),
      h('button', { class: 'btn primary', onclick: () => navigate('aircraft') }, '＋ New livery')));

    if (!list.length) {
      el.append(emptyState('🛫', 'No liveries yet', 'Start by picking the aircraft you want to paint. Livery Forge scans your Community and Official folders.',
        h('button', { class: 'btn primary', onclick: () => navigate('aircraft') }, 'Pick an aircraft'),
        h('button', { class: 'btn', onclick: () => navigate('settings') }, 'Check settings')));
      return;
    }
    const grid = h('div', { class: 'grid auto' });
    grid.append(h('div', { class: 'card project-card new-card', onclick: () => navigate('aircraft') }, '＋ New livery'));
    for (const p of list) {
      const thumb = h('div', { class: 'thumb' });
      thumb.style.backgroundImage = [p.thumbnail ? cssUrl(projUrl(p.id, p.thumbnail, p.updatedAt)) : null, cssUrl(projUrl(p.id, 'preview.png', p.updatedAt))].filter(Boolean).join(', ');
      const badges = h('div', { class: 'badges' },
        p.modular ? h('span', { class: 'badge warn' }, 'Modular') : null,
        p.exported ? h('span', { class: 'badge ok' }, 'Exported') : null,
        p.publishStatus === 'submitted' ? h('span', { class: 'badge blue' }, 'Submitted') : p.publishStatus === 'ready' ? h('span', { class: 'badge blue' }, 'Upload ready') : null);
      grid.append(h('div', { class: 'card project-card', onclick: () => openProject(p.id) },
        thumb,
        h('div', { class: 'info' },
          h('div', { class: 'title' }, p.title || p.name),
          h('div', { class: 'meta' }, p.aircraftTitle),
          h('div', { class: 'meta' }, `${p.textureCount} texture${p.textureCount === 1 ? '' : 's'} · v${p.version || '1.0.0'} · ${timeAgo(p.updatedAt)}`),
          badges,
          h('div', { class: 'actions' },
            h('button', { class: 'btn small primary', onclick: (e) => { e.stopPropagation(); openProject(p.id); } }, 'Open'),
            h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); openProject(p.id, 'details'); } }, 'Details'),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn small danger', onclick: async (e) => {
              e.stopPropagation();
              const ok = await confirmBox('Delete livery?', `"${p.name}" and all its layers will be deleted from this PC${S.cloud.user ? ' and from your cloud hangar' : ''}. This cannot be undone.`);
              if (!ok) return;
              await attempt(() => lf.projects.remove(p.id), 'Livery deleted.');
              if (S.project && S.project.id === p.id) { S.project = null; S.editor && S.editor.clear(); updateNav(); }
              renderProjects();
            } }, 'Delete')))));
    }
    el.append(grid);
  }

  /* ================================================================ */
  /* 1. Aircraft                                                       */
  /* ================================================================ */

  async function renderAircraft(rescan = false) {
    const el = screenEl('aircraft');
    if (!S.aircraft.length || rescan) {
      el.textContent = '';
      el.append(pageHead('Pick an aircraft', 'Scanning your MSFS 2024 folders...'));
      const r = await attempt(() => lf.aircraft.scan());
      if (r) { S.aircraft = r.aircraft; S.aircraftRoots = r.roots; }
    }
    el.textContent = '';
    const search = h('input', { type: 'search', placeholder: 'Search aircraft, folder or package...', value: S.aircraftSearch });
    el.append(pageHead('1. Pick an aircraft', 'Livery Forge scans Community, Official and any extra folders from Settings.',
      h('button', { class: 'btn', onclick: () => renderAircraft(true) }, '⟳ Rescan'),
      h('button', { class: 'btn', onclick: async () => {
        const p = await lf.dialog.pickFolder('Add a folder with aircraft');
        if (!p) return;
        S.settings = await lf.settings.set({ extraAircraftPaths: [...S.settings.extraAircraftPaths, p] });
        renderAircraft(true);
      } }, '＋ Add folder')));

    if (!S.aircraftRoots.length || !S.aircraftRoots.some((r) => r.exists)) {
      el.append(emptyState('🔎', 'MSFS 2024 folders not found', 'Livery Forge could not find your Community or Official folder. Press Auto-detect in Settings or choose the folders yourself.',
        h('button', { class: 'btn primary', onclick: () => navigate('settings') }, 'Open Settings')));
      return;
    }
    if (!S.aircraft.length) {
      el.append(emptyState('🛩', 'No aircraft found', 'No folders with aircraft.cfg were found. Make sure the paths in Settings point to your Community and Official folders, or add an aircraft folder.',
        h('button', { class: 'btn primary', onclick: () => navigate('settings') }, 'Open Settings')));
      return;
    }

    const listEl = h('div', { class: 'list' });
    const detail = h('div', { class: 'card' });
    const split = h('div', { class: 'split' }, h('div', { class: 'panel' }, h('div', { style: 'padding:10px' }, search), listEl), detail);
    el.append(split);

    const drawList = () => {
      listEl.textContent = '';
      const q = S.aircraftSearch.toLowerCase();
      const items = S.aircraft.filter((a) => !q || `${a.title} ${a.folder} ${a.packageName}`.toLowerCase().includes(q));
      if (!items.length) listEl.append(h('p', { class: 'muted pad' }, 'Nothing matches your search.'));
      for (const a of items) {
        listEl.append(h('div', { class: 'list-item' + (S.selectedAircraft && S.selectedAircraft.id === a.id ? ' active' : ''), onclick: () => select(a) },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, `${a.folder} · ${a.source}`)),
          h('div', { class: 'badges' },
            a.modular ? h('span', { class: 'badge warn' }, 'Modular') : null,
            a.encrypted ? h('span', { class: 'badge error' }, 'Encrypted') : null,
            a.isLivery ? h('span', { class: 'badge' }, 'Livery') : null)));
      }
    };
    search.addEventListener('input', () => { S.aircraftSearch = search.value; drawList(); });

    const select = async (a) => {
      S.selectedAircraft = a;
      S.selectedTextures = null;
      drawList();
      drawDetail();
      const r = await attempt(() => lf.aircraft.textures(a.id));
      if (r && S.selectedAircraft === a) { S.selectedTextures = r; drawDetail(); }
    };

    const drawDetail = () => {
      detail.textContent = '';
      const a = S.selectedAircraft;
      if (!a) {
        detail.append(emptyState('👈', 'Select an aircraft', 'Pick the aircraft you want to paint from the list.'));
        return;
      }
      const tex = S.selectedTextures;
      detail.append(h('h2', {}, a.title),
        h('div', { class: 'badges', style: 'margin-bottom:10px' },
          h('span', { class: 'badge blue' }, a.source),
          a.modular ? h('span', { class: 'badge warn' }, 'Modular (experimental)') : h('span', { class: 'badge' }, 'Classic'),
          (a.encrypted || (tex && tex.encrypted)) ? h('span', { class: 'badge error' }, 'Encrypted') : null,
          a.isLivery ? h('span', { class: 'badge' }, 'Is a livery') : null),
        h('table', { class: 'data' }, h('tbody', {},
          h('tr', {}, h('td', { class: 'muted' }, 'Folder'), h('td', { class: 'mono' }, a.folder)),
          h('tr', {}, h('td', { class: 'muted' }, 'Package'), h('td', { class: 'mono' }, a.packageName)),
          a.manufacturer ? h('tr', {}, h('td', { class: 'muted' }, 'Manufacturer'), h('td', {}, a.manufacturer)) : null,
          h('tr', {}, h('td', { class: 'muted' }, 'Variations'), h('td', {}, String(a.variations))))));
      if (a.isLivery) detail.append(h('div', { class: 'notice warn', style: 'margin-top:10px' }, h('div', {}, `This folder is itself a livery (base_container = ${a.baseContainer}). Usually you want to pick the base aircraft instead.`)));
      if (a.encrypted || (tex && tex.encrypted)) detail.append(h('div', { class: 'notice error', style: 'margin-top:10px' }, h('div', {}, 'This aircraft is encrypted (payware). Its textures cannot be extracted. Download the developer\'s paint kit (PSD/PNG) and load it in the Paint step, then map it to the right texture name.')));
      if (a.modular) detail.append(h('div', { class: 'notice warn', style: 'margin-top:10px' }, h('div', {}, 'Modular MSFS 2024 aircraft use a different livery structure (liveries\\<company>\\<livery>\\livery.cfg). Support is EXPERIMENTAL - always test in the sim.')));

      detail.append(h('div', { class: 'section-title' }, 'Textures'));
      if (!tex) detail.append(h('p', { class: 'muted' }, 'Loading textures...'));
      else if (!tex.textures.length) detail.append(h('p', { class: 'muted' }, 'No texture files found. You can still use a paint kit.'));
      else {
        const editable = tex.textures.filter((t) => t.editable).length;
        detail.append(h('p', { class: 'muted small' }, `${tex.textures.length} textures, ${editable} can be opened directly. Compiled KTX2/DDS files cannot be opened - use the developer paint kit for those.`),
          h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Size'), h('th', {}, 'Editable'))),
            h('tbody', {}, tex.textures.map((t) => h('tr', { title: t.reason || t.path },
              h('td', { class: 'mono' }, t.name), h('td', {}, TYPE_LABEL[t.type] || t.type), h('td', {}, fmtBytes(t.size)),
              h('td', {}, t.editable ? h('span', { class: 'badge ok' }, 'Yes') : h('span', { class: 'badge' }, t.ext.replace(/^\./, '').toUpperCase()))))))));
      }
      const name = h('input', { type: 'text', placeholder: 'e.g. Red Baron N123LF', maxlength: '80' });
      detail.append(h('div', { class: 'section-title' }, 'Create livery'),
        h('div', { class: 'input-row' }, name, h('button', { class: 'btn primary', onclick: async () => {
          if (!name.value.trim()) { name.classList.add('invalid'); toast('Enter a livery name first.', 'warn'); return; }
          const p = await attempt(() => lf.projects.create({ name: name.value.trim(), aircraftId: a.id }));
          if (!p) return;
          toast('Livery project created. Now add your first texture.', 'ok');
          if (S.editor) S.editor.clear();
          S.project = p; S.texId = null; S.aircraftTextures = tex ? tex.textures : null; S.exportLog = [];
          navigate('paint');
        } }, 'Create project →')));
      setTimeout(() => name.focus(), 50);
    };
    drawList();
    drawDetail();
  }

  /* ================================================================ */
  /* 2. Paint                                                          */
  /* ================================================================ */

  function ensureEditor(container) {
    if (!S.editor) {
      S.editorRoot = h('div', { class: 'editor' });
      S.editor = new window.LFEditor(S.editorRoot, {
        toast,
        modal,
        onDirty: () => {},
        onSaveShortcut: () => saveTexture(false),
        onImportImage: importImageLayer,
      });
    }
    container.append(S.editorRoot);
    S.editor.requestRender();
  }

  async function aircraftTextureList() {
    if (S.aircraftTextures) return S.aircraftTextures;
    const r = await lf.aircraft.texturesForProject(S.project.id).catch(() => null);
    S.aircraftTextures = r ? r.textures : [];
    return S.aircraftTextures;
  }

  function currentTexture() {
    return S.project && S.project.textures.find((t) => t.id === S.texId);
  }

  async function renderPaint() {
    const el = screenEl('paint');
    el.classList.add('full');
    el.textContent = '';
    const layout = h('div', { class: 'paint-layout' });
    const texPanel = h('div', { class: 'tex-panel' });
    layout.append(texPanel);
    el.append(layout);
    ensureEditor(layout);
    drawTexPanel(texPanel);
    // Open a texture automatically.
    if (!S.texId && S.project.textures.length) await openTexture(S.project.textures[0].id);
    else if (!S.project.textures.length) { S.editor.clear(); }
    S.editor.requestRender();
  }

  function drawTexPanel(panel = $('.tex-panel')) {
    if (!panel) return;
    panel.textContent = '';
    const list = h('div', { class: 'tex-list' });
    if (!S.project.textures.length) {
      list.append(h('div', { class: 'muted small pad' }, 'No textures yet. Add one below to start painting.'));
    }
    for (const t of S.project.textures) {
      list.append(h('div', { class: 'tex-item' + (t.id === S.texId ? ' active' : ''), onclick: () => openTexture(t.id) },
        h('div', { class: 'name' }, t.name),
        h('div', { class: 'sub' }, h('span', {}, TYPE_LABEL[t.type] || t.type), h('span', {}, `${t.width}×${t.height}`), t.include === false ? h('span', { class: 'badge' }, 'excluded') : null)));
    }
    const cur = currentTexture();
    const actions = h('div', { class: 'tex-actions' },
      h('button', { class: 'btn primary', onclick: addTextureDialog }, '＋ Add texture'),
      cur ? h('button', { class: 'btn', onclick: () => saveTexture(false) }, '💾 Save (Ctrl+S)') : null,
      cur ? h('button', { class: 'btn', onclick: textureSettingsDialog }, '⚙ Texture settings') : null,
      cur ? h('button', { class: 'btn', title: 'Use the current texture as the livery thumbnail', onclick: async () => {
        const bytes = await S.editor.previewPng(800);
        const p = await attempt(() => lf.projects.setThumbnail(S.project.id, { bytes }), 'Thumbnail updated.');
        if (p) S.project = p;
      } }, '🖼 Use as thumbnail') : null,
      h('button', { class: 'btn ghost', onclick: () => navigate('details') }, 'Next: Details →'));
    panel.append(h('div', { class: 'panel-title' }, `Textures (${S.project.textures.length})`), list, actions);
  }

  async function loadBitmap(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('missing');
    return createImageBitmap(await res.blob());
  }

  async function openTexture(id) {
    if (S.texId === id && S.editor.hasDoc()) return;
    await saveTexture(true);
    const t = S.project.textures.find((x) => x.id === id);
    if (!t) return;
    S.texId = id;
    drawTexPanel();
    setProgress({ label: `Opening ${t.name}...`, value: 0.2 });
    try {
      const bitmaps = [];
      for (let i = 0; i < t.layers.length; i++) {
        const l = t.layers[i];
        try { bitmaps.push(await loadBitmap(projUrl(S.project.id, `layers/${t.id}/${l.id}.png`, t.updatedAt))); } catch { bitmaps.push(null); }
        setProgress({ label: `Opening ${t.name}...`, value: 0.2 + 0.8 * (i + 1) / t.layers.length });
      }
      if (!t.layers.length) {
        // A texture without layers (should not happen): start blank.
        S.editor.newBlank(t.width || 2048, t.height || 2048, '');
      } else {
        S.editor.openSaved(t.width, t.height, t.layers, bitmaps);
        if (bitmaps.some((b) => !b)) toast('Some layer files were missing and start empty.', 'warn');
      }
    } finally { setProgress(null); }
  }

  /** Saves the texture in the editor: layer PNGs, flattened PNG, preview. */
  let saving = null;
  async function saveTexture(silent) {
    if (saving) return saving;
    const ed = S.editor;
    const t = currentTexture();
    if (!ed || !ed.hasDoc() || !t || !S.project) return;
    if (!ed.dirty && silent) return;
    saving = (async () => {
      try {
        if (!silent) setProgress({ label: 'Saving texture...', value: 0.1 });
        const files = await ed.exportForSave(false);
        const pid = S.project.id;
        let i = 0;
        for (const f of files) {
          if (f.kind === 'layer') await lf.projects.writeFile(pid, `layers/${t.id}/${f.id}.png`, f.bytes);
          else if (f.kind === 'flat') await lf.projects.writeFile(pid, `textures/${t.name}.PNG`, f.bytes);
          else if (f.kind === 'preview') await lf.projects.writeFile(pid, 'preview.png', f.bytes);
          i++;
          if (!silent) setProgress({ label: 'Saving texture...', value: i / files.length });
        }
        t.layers = ed.layerMeta();
        t.width = ed.doc.width; t.height = ed.doc.height;
        t.updatedAt = new Date().toISOString();
        ed.markSaved();
        const saved = await lf.projects.save(S.project);
        S.project = saved;
        await lf.projects.clearImports(pid).catch(() => {});
        if (!silent) toast('Saved.', 'ok', 1500);
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
      } finally {
        setProgress(null);
        saving = null;
      }
    })();
    return saving;
  }

  /** Dialog: add a texture from aircraft file / paint kit / blank canvas. */
  async function addTextureDialog() {
    await saveTexture(true);
    const acTex = await aircraftTextureList();
    let source = 'kit';
    let chosenAircraftTex = null;
    let kitPath = '';
    const names = [...new Set([...(S.project.aircraft.textureNames || []).map((t) => t.name), ...acTex.map((t) => t.name)])].sort();
    const dl = h('datalist', { id: 'texNames' }, names.map((n) => h('option', { value: n })));
    const nameInput = h('input', { type: 'text', list: 'texNames', placeholder: 'e.g. FUSELAGE_ALBD', spellcheck: 'false' });
    const typeSel = h('select', {}, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
    const nameHint = h('div', { class: 'hint' }, 'Must match the aircraft\'s texture name exactly, or it will not replace anything.');
    nameInput.addEventListener('input', () => {
      nameInput.value = nameInput.value.replace(/[^A-Za-z0-9_.-]/g, '');
      typeSel.value = detectType(nameInput.value);
      const known = names.some((n) => n.toUpperCase() === nameInput.value.toUpperCase());
      nameHint.textContent = !nameInput.value ? 'Must match the aircraft\'s texture name exactly.' : known ? '✓ Matches a texture of this aircraft.' : (names.length ? '⚠ Not a texture name of this aircraft. Double-check the spelling.' : 'Texture names of this aircraft are unknown (encrypted?). Use the name from the paint kit documentation.');
      nameHint.style.color = !nameInput.value ? '' : known ? 'var(--ok)' : 'var(--warn)';
    });
    const sizeSel = h('select', {}, [1024, 2048, 4096, 8192].map((s) => h('option', { value: s, selected: s === 4096 ? true : null }, `${s} × ${s}${s === 8192 ? ' (needs lots of RAM)' : ''}`)));
    const bgSel = h('select', {}, h('option', { value: 'auto' }, 'Default for texture type'), h('option', { value: '#ffffff' }, 'White'), h('option', { value: '' }, 'Transparent'));

    const pane = h('div', {});
    const cards = h('div', { class: 'choice-cards' });
    const choices = [
      { id: 'aircraft', ico: '🛩', title: 'Aircraft texture', text: 'A PNG/JPG/PSD inside the aircraft folder' },
      { id: 'kit', ico: '🎨', title: 'Paint kit file', text: 'Developer PSD (layers kept), PNG or JPG' },
      { id: 'blank', ico: '⬜', title: 'Blank canvas', text: 'Start from an empty texture' },
    ];
    const drawCards = () => {
      cards.textContent = '';
      for (const c of choices) cards.append(h('div', { class: 'choice' + (source === c.id ? ' active' : ''), onclick: () => { source = c.id; drawCards(); drawPane(); } }, h('div', { class: 'ico' }, c.ico), h('b', {}, c.title), h('small', {}, c.text)));
    };
    const kitLabel = h('div', { class: 'muted small' }, 'No file chosen.');
    const drawPane = () => {
      pane.textContent = '';
      if (source === 'aircraft') {
        const usable = acTex.filter((t) => t.editable);
        pane.append(h('div', { class: 'notice info' }, h('div', {}, 'Compiled textures (KTX2 / DDS) cannot be opened - they are converted for the GPU and MSFS 2024 encrypts many of them. If your texture is not in the list, download the paint kit from the aircraft developer and choose "Paint kit file".')));
        if (!usable.length) pane.append(h('p', { class: 'muted', style: 'margin-top:10px' }, 'This aircraft has no PNG/JPG/PSD textures that can be opened.'));
        else {
          const sel = h('select', { size: '8', style: 'margin-top:10px' }, usable.map((t) => h('option', { value: t.path }, `${t.name}  (${t.folder}, ${fmtBytes(t.size)})`)));
          sel.addEventListener('change', () => {
            chosenAircraftTex = usable.find((t) => t.path === sel.value);
            if (chosenAircraftTex) { nameInput.value = chosenAircraftTex.name; nameInput.dispatchEvent(new Event('input')); }
          });
          pane.append(sel);
        }
      } else if (source === 'kit') {
        pane.append(h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: async () => {
          const files = await lf.dialog.pickFiles({ title: 'Choose a paint kit', kind: 'paintkit' });
          if (!files.length) return;
          kitPath = files[0];
          kitLabel.textContent = kitPath;
          if (!nameInput.value) {
            const base = kitPath.split(/[\\/]/).pop().replace(/\.(psd|png|jpe?g)$/i, '').replace(/\.PNG$/i, '');
            const match = names.find((n) => n.toUpperCase() === base.toUpperCase());
            if (match) { nameInput.value = match; nameInput.dispatchEvent(new Event('input')); }
          }
        } }, 'Choose file...'), kitLabel),
        h('p', { class: 'muted small', style: 'margin-top:8px' }, 'PSD layers, names, visibility, opacity and blend modes are kept. Layer masks, adjustment layers and effects are not supported - flatten those in Photoshop/GIMP first.'));
      } else {
        pane.append(h('div', { class: 'form-grid cols-2' }, field('Size', sizeSel), field('Background', bgSel)));
      }
    };
    drawCards(); drawPane();

    modal({
      title: 'Add a texture',
      wide: true,
      okLabel: 'Add texture',
      body: h('div', { class: 'form-grid' }, cards, pane, dl,
        h('div', { class: 'section-title' }, 'Target texture'),
        h('div', { class: 'form-grid cols-2' }, h('label', { class: 'field' }, h('span', {}, 'Texture name (file name without .PNG)'), nameInput, nameHint), field('Texture type', typeSel, 'Auto-detected from the name (_ALBD, _COMP, _NORM, _DECAL, _EMIS).'))),
      onOk: async () => {
        const name = nameInput.value.trim();
        if (!name) { toast('Enter the target texture name.', 'warn'); nameInput.classList.add('invalid'); return false; }
        if (S.project.textures.some((t) => t.name.toUpperCase() === name.toUpperCase())) { toast('This livery already has a texture with that name.', 'warn'); return false; }
        if (source === 'aircraft' && !chosenAircraftTex) { toast('Choose a texture from the list.', 'warn'); return false; }
        if (source === 'kit' && !kitPath) { toast('Choose a paint kit file.', 'warn'); return false; }
        await createTexture({ source, name, type: typeSel.value, path: source === 'aircraft' ? chosenAircraftTex.path : kitPath, size: Number(sizeSel.value), bg: bgSel.value });
        return true;
      },
    });
  }

  async function createTexture({ source, name, type, path, size, bg }) {
    const ed = S.editor;
    const pid = S.project.id;
    try {
      if (source === 'blank') {
        const fill = bg === 'auto' ? (type === 'normal' ? '#8080ff' : type === 'comp' ? '#ff8000' : type === 'albedo' ? '#ffffff' : '') : bg;
        ed.newBlank(size, size, fill);
      } else {
        setProgress({ label: 'Importing...', value: 0.1 });
        const r = await lf.projects.importFile(pid, path);
        if (r.kind === 'psd') {
          const layers = [];
          for (let i = 0; i < r.layers.length; i++) {
            const l = r.layers[i];
            setProgress({ label: `Loading layer ${i + 1} of ${r.layers.length}...`, value: (i + 1) / r.layers.length });
            layers.push({ ...l, bitmap: await loadBitmap(projUrl(pid, l.rel)) });
          }
          ed.newFromLayers(r.width, r.height, layers);
        } else {
          const bmp = await loadBitmap(projUrl(pid, r.rel));
          ed.newFromImage(bmp, 'Base');
        }
        setProgress(null);
      }
      const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
      if (!isPow2(ed.doc.width) || !isPow2(ed.doc.height)) toast(`This image is ${ed.doc.width}×${ed.doc.height}. MSFS textures should be a power of two (1024, 2048, 4096...). The SDK may refuse it.`, 'warn', 9000);
      const tex = { id: newId(), name, type, width: ed.doc.width, height: ed.doc.height, layers: ed.layerMeta(), include: true, updatedAt: new Date().toISOString() };
      S.project.textures.push(tex);
      S.texId = tex.id;
      ed.dirty = true;
      await saveTexture(false);
      drawTexPanel();
    } catch (e) {
      setProgress(null);
      toast(e.message, 'error');
    }
  }

  async function importImageLayer() {
    if (!S.editor || !S.editor.hasDoc()) { toast('Open a texture first.', 'warn'); return; }
    const files = await lf.dialog.pickFiles({ title: 'Import image as a new layer', kind: 'image' });
    if (!files.length) return;
    const r = await attempt(() => lf.projects.importFile(S.project.id, files[0]));
    if (!r) return;
    try {
      const bmp = await loadBitmap(projUrl(S.project.id, r.rel));
      S.editor.addImageLayer(bmp, files[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, ''));
    } catch (e) { toast('Could not load the image: ' + e.message, 'error'); }
  }

  function textureSettingsDialog() {
    const t = currentTexture();
    if (!t) return;
    const nameInput = h('input', { type: 'text', value: t.name, list: 'texNames2', spellcheck: 'false' });
    const names = (S.project.aircraft.textureNames || []).map((x) => x.name);
    const dl = h('datalist', { id: 'texNames2' }, names.map((n) => h('option', { value: n })));
    const typeSel = h('select', {}, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v, selected: v === t.type ? true : null }, l)));
    const include = h('input', { type: 'checkbox', checked: t.include !== false ? true : null });
    modal({
      title: `Texture settings - ${t.name}`,
      body: h('div', { class: 'form-grid' }, dl,
        field('Target texture name', nameInput, 'Must exactly match the base aircraft texture (without .PNG).'),
        field('Type', typeSel),
        h('label', { class: 'check' }, include, 'Include this texture in the export'),
        h('div', { class: 'section-title' }, 'Danger zone'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox('Delete texture?', `Delete ${t.name} and all its layers from this livery?`))) return;
          S.project.textures = S.project.textures.filter((x) => x.id !== t.id);
          await lf.projects.deleteFile(S.project.id, `textures/${t.name}.PNG`).catch(() => {});
          S.texId = null;
          S.editor.clear();
          await saveProject();
          renderPaint();
        } }, 'Delete this texture')),
      okLabel: 'Save',
      onOk: async () => {
        const newName = nameInput.value.trim().replace(/[^A-Za-z0-9_.-]/g, '');
        if (!newName) { toast('Name cannot be empty.', 'warn'); return false; }
        if (newName !== t.name && S.project.textures.some((x) => x.id !== t.id && x.name.toUpperCase() === newName.toUpperCase())) { toast('Another texture already uses that name.', 'warn'); return false; }
        if (newName !== t.name) {
          await lf.projects.deleteFile(S.project.id, `textures/${t.name}.PNG`).catch(() => {});
          t.name = newName;
          S.editor.dirty = true; // rewrite the flattened PNG with the new name
        }
        t.type = typeSel.value;
        t.include = include.checked;
        await saveTexture(true);
        await saveProject();
        drawTexPanel();
        return true;
      },
    });
  }

  /* ================================================================ */
  /* 3. Details                                                        */
  /* ================================================================ */

  function renderDetails() {
    const el = screenEl('details');
    el.textContent = '';
    const p = S.project;
    const d = p.details;
    const save = debounce(() => saveProject(), 600);

    const bind = (key, input, transform = (v) => v) => {
      input.value = d[key] == null ? '' : d[key];
      input.addEventListener('input', () => { d[key] = transform(input.value); save(); });
      return input;
    };
    const text = (key, ph = '', max = 200) => bind(key, h('input', { type: 'text', placeholder: ph, maxlength: String(max) }));
    const area = (key, ph = '', rows = 4) => bind(key, h('textarea', { placeholder: ph, rows: String(rows) }));

    // Tags editor
    const tagsBox = h('div', { class: 'tags-input' });
    const drawTags = () => {
      tagsBox.textContent = '';
      for (const t of d.tags) tagsBox.append(h('span', { class: 'tag' }, t, h('button', { title: 'Remove', onclick: () => { d.tags = d.tags.filter((x) => x !== t); drawTags(); save(); } }, '×')));
      const inp = h('input', { type: 'text', placeholder: d.tags.length ? '' : 'Type a tag and press Enter' });
      inp.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) {
          e.preventDefault();
          const v = inp.value.trim().toLowerCase().slice(0, 30);
          if (!d.tags.includes(v) && d.tags.length < 20) d.tags.push(v);
          drawTags(); save();
          tagsBox.querySelector('input').focus();
        } else if (e.key === 'Backspace' && !inp.value && d.tags.length) { d.tags.pop(); drawTags(); save(); tagsBox.querySelector('input').focus(); }
      });
      tagsBox.append(inp);
    };
    drawTags();

    // Thumbnail + screenshots
    const thumb = h('div', { class: 'shot', style: 'max-width:320px' });
    if (d.thumbnail) thumb.style.backgroundImage = cssUrl(projUrl(p.id, d.thumbnail, p.updatedAt));
    else thumb.append(h('div', { class: 'muted small pad' }, 'No thumbnail yet'));
    const shots = h('div', { class: 'shots' });
    d.screenshots.forEach((s, i) => {
      shots.append(h('div', { class: 'shot', style: `background-image:${cssUrl(projUrl(p.id, s, p.updatedAt))}` },
        h('span', { class: 'num' }, String(i + 1).padStart(2, '0')),
        h('button', { title: 'Remove', onclick: async () => { const r = await attempt(() => lf.projects.removeScreenshot(p.id, s)); if (r) { S.project = r; renderDetails(); } } }, '×')));
    });

    const ownWork = h('input', { type: 'checkbox', checked: d.ownWork ? true : null, onchange: (e) => { d.ownWork = e.target.checked; save(); } });
    const englishHint = h('div', { class: 'hint' }, 'flightsim.to requires an English description.');

    el.append(pageHead('3. Livery details', 'Everything you fill in here goes into aircraft.cfg / livery.cfg, the README and the upload pages. Changes save automatically.',
      h('button', { class: 'btn primary', onclick: () => navigate('export') }, 'Next: Export →')));

    el.append(h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Basics'),
      h('div', { class: 'form-grid cols-3' },
        field('Livery title', text('title', 'e.g. Red Baron Air N123LF', 120)),
        field('Author', text('author', 'Your name or handle', 60)),
        field('Version', text('version', '1.0.0', 20)),
        field('Manufacturer (optional)', text('manufacturer', 'e.g. Cessna', 60)),
        h('div', { class: 'span-2' }, field('Short description', text('shortDescription', 'One line shown in the aircraft selection', 300)))),
      h('div', { class: 'section-title' }, 'Description & docs'),
      h('div', { class: 'form-grid cols-2' },
        h('div', { class: 'span-2' }, h('label', { class: 'field' }, h('span', {}, 'Full description (English)'), area('description', 'Describe your livery: the real aircraft, what is special, which textures are included...', 6), englishHint)),
        field('README notes', area('readme', 'Anything users should know (installation tips, known issues...)')),
        field('Credits', area('credits', 'Paint kit by ..., logos by ... (with permission)')),
        field('License', area('license', 'Free for personal use. Do not re-upload.', 3)),
        field('Changelog', area('changelog', 'v1.0.0 - First release.', 3))),
      h('div', { class: 'section-title' }, 'In-sim identity (ATC)'),
      h('div', { class: 'form-grid cols-3' },
        field('Registration (atc_id)', text('atcId', 'e.g. N123LF', 12), 'Shown on the aircraft and used by ATC.'),
        field('ICAO airline code', text('icaoAirline', 'e.g. DAL', 4)),
        field('ATC airline name', text('atcAirline', 'e.g. Delta', 40), 'The callsign ATC speaks.'),
        field('Flight number', text('flightNumber', 'e.g. 1234', 8)),
        field('Parking types', text('parkingTypes', 'RAMP, GATE, CARGO, MIL_COMBAT...', 60), 'Comma separated. RAMP for GA, GATE for airliners.')),
      p.aircraft.modular ? h('div', {},
        h('div', { class: 'section-title' }, 'Modular aircraft (experimental)'),
        h('div', { class: 'form-grid cols-2' },
          field('Company / studio folder', text('company', 'Defaults to the author name', 40), 'Used for liveries\\<company>\\<livery>\\'),
          field('Required tags (optional)', text('requiredTags', 'e.g. node_default', 120), 'Written as [SELECTION] required_tags in livery.cfg. See the aircraft\'s attachment.cfg.'))) : null,
      h('div', { class: 'section-title' }, 'Tags'),
      tagsBox,
      h('div', { class: 'section-title' }, 'Thumbnail'),
      h('div', { class: 'row gap', style: 'align-items:flex-start' }, thumb,
        h('div', { class: 'form-grid' },
          h('button', { class: 'btn', onclick: async () => {
            const f = await lf.dialog.pickFiles({ title: 'Choose a thumbnail image', kind: 'image' });
            if (!f.length) return;
            const r = await attempt(() => lf.projects.setThumbnail(p.id, { path: f[0] }), 'Thumbnail updated.');
            if (r) { S.project = r; renderDetails(); }
          } }, 'Choose image...'),
          h('p', { class: 'muted small' }, 'Tip: in the Paint step you can use the current texture as thumbnail, but an in-sim screenshot looks much better.'))),
      h('div', { class: 'section-title' }, `Screenshots (${d.screenshots.length}/18)`),
      h('p', { class: 'muted small' }, 'Converted automatically to JPEG, max 1920 px wide and under 5 MB. The first one is the main image on flightsim.to and the marketplace.'),
      shots.childElementCount ? shots : h('p', { class: 'muted' }, 'No screenshots yet. Take some in the sim (Windows key + Shift + S or the in-game photo mode).'),
      h('div', { class: 'row gap', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: async () => {
        const f = await lf.dialog.pickFiles({ title: 'Add screenshots', kind: 'screenshot', multi: true });
        if (!f.length) return;
        setProgress({ label: 'Converting screenshots...', value: 0.5 });
        const r = await attempt(() => lf.projects.addScreenshots(p.id, f));
        setProgress(null);
        if (r) { S.project = r; renderDetails(); }
      } }, '＋ Add screenshots')),
      h('div', { class: 'section-title' }, 'Permission'),
      h('label', { class: 'check' }, ownWork, h('b', {}, 'This is my own work or I have written permission.')),
      h('p', { class: 'muted small', style: 'margin-top:6px' }, 'Paint kits usually allow free liveries. Logos of real airlines may be trademarks - only share what you are allowed to share.')));
  }

  /* ================================================================ */
  /* 4. Export & test                                                  */
  /* ================================================================ */

  function addLog(level, text) {
    S.exportLog.push({ level, text });
    if (S.exportLog.length > 2000) S.exportLog.shift();
    const log = $('#exportLog');
    if (log) {
      log.append(h('div', { class: 'l-' + level }, text));
      log.scrollTop = log.scrollHeight;
    }
  }

  async function renderExport() {
    const el = screenEl('export');
    el.textContent = '';
    const p = S.project;
    await saveTexture(true);
    const [pre, status] = await Promise.all([lf.exporter.preflight(p.id).catch((e) => ({ errors: [e.message], warnings: [], layout: {} })), lf.exporter.status(p.id).catch(() => ({}))]);
    const s = S.settings;

    el.append(pageHead('4. Export & test', 'Build an MSFS 2024 package with the official SDK, zip it, and link it into your Community folder.',
      h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.openFolder('output')) }, '📁 Open output folder'),
      status.zipExists ? h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.showItem(status.export.zipPath)) }, '🗜 Reveal zip') : null));

    // checks
    const checks = h('div', { class: 'card' });
    checks.append(h('div', { class: 'row gap' },
      h('div', { style: 'flex:1;min-width:260px' }, h('div', { class: 'muted small' }, 'Package name'), h('div', { class: 'mono', style: 'font-size:15px' }, (pre.layout && pre.layout.pkg) || '-')),
      h('div', {}, h('div', { class: 'muted small' }, 'Livery type'), pre.layout && pre.layout.mode === 'modular' ? h('span', { class: 'badge warn' }, 'Modular (experimental)') : h('span', { class: 'badge' }, 'Classic (base_container)')),
      h('div', {}, h('div', { class: 'muted small' }, 'MSFS 2024 SDK'), s.sdkValid ? h('span', { class: 'badge ok' }, '✓ Found') : h('span', { class: 'badge error' }, '✗ Not set')),
      h('div', {}, h('div', { class: 'muted small' }, 'In Community'), status.community ? h('span', { class: 'badge ok' }, status.community === 'link' ? '✓ Linked' : status.community === 'copy' ? '✓ Copied' : 'Other folder') : h('span', { class: 'badge' }, 'No'))));
    if (pre.errors.length) checks.append(h('div', { class: 'notice error', style: 'margin-top:12px' }, h('div', {}, h('b', {}, 'Fix before exporting:'), h('ul', {}, pre.errors.map((e) => h('li', {}, e))))));
    if (pre.warnings.length) checks.append(h('div', { class: 'notice warn', style: 'margin-top:12px' }, h('div', {}, h('b', {}, 'Heads up:'), h('ul', {}, pre.warnings.map((e) => h('li', {}, e))))));
    if (!pre.errors.length && !pre.warnings.length) checks.append(h('div', { class: 'notice ok', style: 'margin-top:12px' }, h('div', {}, '✓ Everything looks good. Only the textures you painted are included - the rest comes from the base aircraft.')));
    el.append(checks);

    const run = async (mode) => {
      if (S.exportBusy) return;
      S.exportBusy = true;
      S.exportLog = [];
      const log = $('#exportLog'); if (log) log.textContent = '';
      el.querySelectorAll('.action-card .btn').forEach((b) => { b.disabled = true; });
      addLog('info', `=== ${mode === 'test' ? 'Export & test in sim' : mode === 'source' ? 'Source project only' : 'Export package'} - ${new Date().toLocaleTimeString()} ===`);
      try {
        await lf.exporter.run(p.id, mode);
        if (mode === 'test') toast('Installed in Community! Start (or restart) MSFS 2024 and pick your livery.', 'ok', 8000);
        else if (mode === 'source') toast('Source project zipped.', 'ok');
        else toast('Package exported!', 'ok');
        S.project = await lf.projects.load(p.id);
      } catch (e) {
        addLog('error', e.message);
        toast(e.message, 'error');
      }
      S.exportBusy = false;
      const keep = S.exportLog.slice();
      await renderExport();
      S.exportLog = keep;
      const l2 = $('#exportLog');
      if (l2) { l2.textContent = ''; keep.forEach((x) => l2.append(h('div', { class: 'l-' + x.level }, x.text))); l2.scrollTop = l2.scrollHeight; }
    };

    const blocked = pre.errors.length > 0;
    el.append(h('div', { class: 'export-actions', style: 'margin-top:14px' },
      h('div', { class: 'card action-card' }, h('h3', {}, '📦 Export package'), h('p', { class: 'muted' }, 'Compiles textures to KTX2 with fspackagetool, fills manifest.json, adds README.txt and creates a drag-and-drop zip in Documents\\Livery Forge\\Output.'),
        h('button', { class: 'btn primary', disabled: blocked || !s.sdkValid ? true : null, onclick: () => run('package') }, 'Export package')),
      h('div', { class: 'card action-card' }, h('h3', {}, '🛫 Export & test in sim'), h('p', { class: 'muted' }, `Same as export, then ${s.installMode === 'copy' ? 'copies' : 'links (junction)'} the package into your Community folder. With a link, re-exports update the sim instantly.`),
        h('button', { class: 'btn ok', disabled: blocked || !s.sdkValid || !s.communityPath ? true : null, onclick: () => run('test') }, 'Export & test in sim'),
        status.community ? h('button', { class: 'btn danger small', onclick: async () => { await attempt(() => lf.exporter.removeFromCommunity(p.id), 'Removed from Community.'); renderExport(); } }, 'Remove from Community') : null),
      h('div', { class: 'card action-card' }, h('h3', {}, '🧾 Source project only'), h('p', { class: 'muted' }, 'For people without the SDK. Creates the SDK project (PNG + XML + cfg) as a zip. It must still be compiled with the SDK before MSFS 2024 can load it.'),
        h('button', { class: 'btn', disabled: blocked ? true : null, onclick: () => run('source') }, 'Export source project'))));

    if (!s.sdkValid) el.append(h('div', { class: 'notice warn', style: 'margin-top:14px' }, h('div', {}, 'The MSFS 2024 SDK is needed to make a package the sim can load (Microsoft does not allow apps to include it). Install it from the sim\'s Developer Mode (Help > SDK Installer) and choose the folder in Settings.'), h('button', { class: 'btn small', onclick: () => navigate('settings') }, 'Settings')));

    if (status.zipExists) {
      el.append(h('div', { class: 'card', style: 'margin-top:14px' }, h('div', { class: 'row gap' },
        h('div', { style: 'flex:1' }, h('b', {}, 'Last export'), h('div', { class: 'muted small mono' }, status.export.zipPath), h('div', { class: 'muted small' }, `${fmtBytes(status.export.zipSize)} · ${timeAgo(status.export.lastExportAt)}`)),
        h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.showItem(status.export.zipPath)) }, 'Reveal zip'),
        h('button', { class: 'btn primary', onclick: () => navigate('publish') }, 'Next: Publish →'))));
    }

    const log = h('div', { class: 'log', id: 'exportLog' });
    for (const x of S.exportLog) log.append(h('div', { class: 'l-' + x.level }, x.text));
    if (!S.exportLog.length) log.append(h('div', { class: 'l-info' }, 'The build log will appear here.'));
    el.append(h('div', { class: 'section-title' }, 'Build log'), log);
  }

  /* ================================================================ */
  /* 5. Publish                                                        */
  /* ================================================================ */

  async function renderPublish() {
    const el = screenEl('publish');
    el.textContent = '';
    el.append(pageHead('5. Publish', 'Share your livery on the Livery Forge Marketplace and get it ready for flightsim.to.'));
    const p = S.project;

    // --- Livery Forge Marketplace ---
    const mk = h('div', { class: 'card' }, h('h2', {}, '🛒 Livery Forge Marketplace'));
    if (!S.cloud.user) {
      mk.append(h('p', { class: 'muted' }, 'Log in with a Creator account to publish here. Other pilots can then download and install your livery with one click.'),
        h('button', { class: 'btn', onclick: () => showAuth('login') }, 'Log in'));
    } else if (!isCreator()) {
      mk.append(h('p', { class: 'muted' }, 'Your account is a Pilot account. Switch to "Creator" or "Both" in your profile to publish.'),
        h('button', { class: 'btn', onclick: () => navigate('profile') }, 'Open profile'));
    } else if (!p) {
      mk.append(h('p', { class: 'muted' }, 'Open a project to publish it.'));
    } else {
      const exported = p.export && p.export.zipPath;
      mk.append(h('p', { class: 'muted' }, exported ? `Publishes "${p.details.title || p.name}" v${p.details.version} with its zip, thumbnail and screenshots. Publishing again updates the same listing.` : 'Export the package first (step 4).'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn primary', disabled: exported ? null : true, onclick: async () => {
            const listing = await attempt(() => lf.market.publish(p.id), 'Published on the marketplace! 🎉');
            if (listing) { S.project = await lf.projects.load(p.id); S.market.view = 'detail'; await openListing(listing.id); }
          } }, p.publish && p.publish.marketplaceId ? 'Update marketplace listing' : 'Publish to marketplace'),
          p.publish && p.publish.marketplaceId ? h('button', { class: 'btn', onclick: () => openListing(p.publish.marketplaceId) }, 'View listing') : null));
    }
    el.append(mk);

    // --- flightsim.to ---
    const fs = h('div', { class: 'card' }, h('h2', {}, '🌐 flightsim.to'),
      h('div', { class: 'notice warn' }, h('div', {}, h('b', {}, 'Rule: '), S.info.rule)),
      h('p', { class: 'muted', style: 'margin-top:10px' }, 'flightsim.to has no public upload API, so Livery Forge prepares a tidy upload folder and a checklist, and you upload it yourself in your browser. Livery Forge never asks for or stores your flightsim.to password.'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn', onclick: () => lf.shell.openExternal('https://flightsim.to/login') }, 'Log in to flightsim.to ↗'),
        h('button', { class: 'btn', onclick: () => lf.shell.openExternal('https://flightsim.to/upload') }, 'Open flightsim.to/upload ↗')));
    if (p) {
      const v = await lf.publish.validate(p.id).catch((e) => ({ ok: false, errors: [e.message], warnings: [] }));
      const list = h('ul', { class: 'checklist', style: 'margin-top:12px' });
      const item = (ok, text) => list.append(h('li', {}, h('span', {}, ok ? '✅' : '❌'), text));
      const d = p.details;
      item(!!d.title, 'Title');
      item(!!d.author, 'Author');
      item(!v.errors.some((e) => /description/i.test(e)), 'English description (50+ characters)');
      item(!!d.ownWork, 'Own work / permission confirmed');
      item(!v.errors.some((e) => /zip|Export|source/i.test(e)), 'Exported zip (under 2.5 GB)');
      item(!v.errors.some((e) => /screenshot/i.test(e)), `1 to 18 screenshots under 5 MB (you have ${d.screenshots.length})`);
      fs.append(h('h3', { style: 'margin-top:16px' }, `Current livery: ${d.title || p.name}`), list);
      if (v.errors.length) fs.append(h('div', { class: 'notice error', style: 'margin-top:10px' }, h('div', {}, h('ul', {}, v.errors.map((e) => h('li', {}, e))))));
      if (v.warnings.length) fs.append(h('div', { class: 'notice warn', style: 'margin-top:10px' }, h('div', {}, h('ul', {}, v.warnings.map((e) => h('li', {}, e))))));
      fs.append(h('div', { class: 'row gap', style: 'margin-top:12px' },
        h('button', { class: 'btn primary', disabled: v.ok ? null : true, onclick: async () => {
          const r = await attempt(() => lf.publish.prepare(p.id), 'Upload folder ready!');
          if (r) { S.project = await lf.projects.load(p.id); renderPublish(); }
        } }, 'Prepare upload'),
        p.publish.bundlePath ? h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.openFolder(p.publish.bundlePath)) }, '📁 Open upload folder') : null,
        h('button', { class: 'btn', onclick: async () => { const t = await attempt(() => lf.publish.description(p.id)); if (t) { await lf.shell.copy(t); toast('Description copied to the clipboard.', 'ok'); } } }, '📋 Copy description'),
        p.publish.status === 'submitted'
          ? h('button', { class: 'btn', onclick: async () => { await attempt(() => lf.publish.markSubmitted(p.id, false)); S.project = await lf.projects.load(p.id); renderPublish(); } }, '↺ Mark as not submitted')
          : h('button', { class: 'btn ok', disabled: p.publish.status === 'ready' ? null : true, onclick: async () => { await attempt(() => lf.publish.markSubmitted(p.id, true), 'Marked as submitted.'); S.project = await lf.projects.load(p.id); renderPublish(); } }, '✓ Mark as submitted')));
    } else {
      fs.append(h('p', { class: 'muted', style: 'margin-top:10px' }, 'Open a project to prepare a single upload, or use the batch queue below.'));
    }
    el.append(fs);

    // --- batch queue ---
    const q = await lf.publish.queue().catch(() => ({ items: [], nextAllowedAt: Date.now(), perHour: 3 }));
    const wait = Math.max(0, q.nextAllowedAt - Date.now());
    const pace = wait > 0
      ? h('span', { class: 'badge warn' }, `Next upload allowed in ${Math.ceil(wait / 60000)} min (${new Date(q.nextAllowedAt).toLocaleTimeString()})`)
      : h('span', { class: 'badge ok' }, 'You can upload now');
    const queue = h('div', { class: 'card' }, h('div', { class: 'row gap' }, h('h2', { style: 'flex:1;margin:0' }, '📚 Batch queue'), pace,
      h('button', { class: 'btn', onclick: async () => {
        const r = await attempt(() => lf.publish.prepareAll());
        if (!r) return;
        const ok = r.filter((x) => x.ok).length;
        toast(`${ok} of ${r.length} prepared.${r.some((x) => !x.ok) ? '\n' + r.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error.split('\n')[1] || x.error}`).join('\n') : ''}`, ok === r.length ? 'ok' : 'warn', 9000);
        renderPublish();
      } }, 'Prepare all exported')),
    h('p', { class: 'muted small' }, `flightsim.to users report a limit of about ${q.perHour} uploads per hour. Livery Forge paces you so you don't get blocked.`));
    if (!q.items.length) queue.append(h('p', { class: 'muted' }, 'No projects yet.'));
    for (const it of q.items) {
      const th = h('div', { class: 'queue-thumb' });
      th.style.backgroundImage = [it.thumbnail ? cssUrl(projUrl(it.id, it.thumbnail, it.updatedAt)) : null, cssUrl(projUrl(it.id, 'preview.png', it.updatedAt))].filter(Boolean).join(', ');
      const st = it.status === 'submitted' ? h('span', { class: 'badge blue' }, 'Submitted') : it.status === 'ready' ? h('span', { class: 'badge ok' }, 'Ready') : !it.exported ? h('span', { class: 'badge' }, 'Not exported') : it.valid ? h('span', { class: 'badge' }, 'Not prepared') : h('span', { class: 'badge error', title: it.errors.join('\n') }, `${it.errors.length} issue(s)`);
      queue.append(h('div', { class: 'queue-item' }, th,
        h('div', {}, h('div', { style: 'font-weight:600' }, it.title || it.name), h('div', { class: 'muted small' }, `${it.aircraftTitle} · v${it.version}`)),
        h('div', { class: 'row gap' }, st,
          it.bundlePath ? h('button', { class: 'btn small', onclick: () => attempt(() => lf.shell.openFolder(it.bundlePath)) }, 'Folder') : null,
          it.status === 'ready' ? h('button', { class: 'btn small ok', disabled: wait > 0 ? true : null, title: wait > 0 ? 'Wait for the upload limit' : '', onclick: async () => { await attempt(() => lf.publish.markSubmitted(it.id, true), 'Marked as submitted.'); renderPublish(); } }, 'Mark submitted') : null,
          h('button', { class: 'btn small ghost', onclick: () => openProject(it.id, 'publish') }, 'Open'))));
    }
    el.append(queue);
  }

  /* ================================================================ */
  /* Marketplace                                                       */
  /* ================================================================ */

  function needCloud(el, what) {
    if (S.cloud.user) return false;
    el.append(emptyState('🔐', 'Log in to use the ' + what, S.cloud.configured ? 'The marketplace and your hangar need a free Livery Forge account.' : 'The cloud server is not connected yet. See the README (Set up the cloud server) or Settings > Cloud server.',
      h('button', { class: 'btn primary', onclick: () => showAuth(S.cloud.configured ? 'signup' : 'login') }, S.cloud.configured ? 'Log in / Sign up' : 'Connect server')));
    return true;
  }

  function listingCard(l, onClick) {
    const th = h('div', { class: 'thumb' }, l.thumbnail_url ? null : '✈');
    if (l.thumbnail_url) th.style.backgroundImage = cssUrl(l.thumbnail_url);
    const c = l.creator || {};
    return h('div', { class: 'card listing-card', onclick: onClick || (() => openListing(l.id)) }, th,
      h('div', { class: 'info' },
        h('div', { class: 'title' }, l.title),
        h('div', { class: 'muted small' }, l.aircraft),
        c.username ? h('div', { class: 'creator' }, avatar(c, 'sm'), `@${c.username}`) : null,
        h('div', { class: 'badges' }, l.modular ? h('span', { class: 'badge warn' }, 'Modular') : null, l.updateAvailable ? h('span', { class: 'badge gold' }, 'Update available') : null, (l.tags || []).slice(0, 3).map((t) => h('span', { class: 'badge' }, t))),
        h('div', { class: 'stats' }, h('span', { class: 'stars', title: `${l.rating_avg} / 5` }, stars(l.rating_avg)), h('span', {}, `(${l.rating_count})`), h('span', {}, `⬇ ${l.downloads}`), h('span', {}, `♥ ${l.favorites_count}`))));
  }

  async function renderMarket() {
    const el = screenEl('market');
    el.textContent = '';
    if (needCloud(el, 'marketplace')) return;
    const m = S.market;
    if (m.view === 'detail' && m.detail) return renderListingDetail(el);
    if (m.view === 'creator' && m.creator) return renderCreatorPage(el);

    el.append(h('div', { class: 'market-hero' }, h('h1', {}, 'Livery Forge Marketplace'), h('p', { class: 'muted' }, 'Liveries made by the community. Download and install into MSFS 2024 with one click.'),
      isCreator() ? h('button', { class: 'btn primary', style: 'margin-top:8px', onclick: () => navigate('publish') }, '＋ Publish your livery') : null));
    const search = h('input', { type: 'search', placeholder: 'Search title, aircraft, registration...', value: m.search });
    const sort = h('select', {}, h('option', { value: 'new' }, 'Newest'), h('option', { value: 'popular' }, 'Most downloaded'), h('option', { value: 'top' }, 'Top rated'));
    sort.value = m.sort;
    const grid = h('div', { class: 'grid auto' });
    const more = h('div', { class: 'row', style: 'justify-content:center;margin-top:16px' });
    el.append(h('div', { class: 'market-bar' }, search, sort), grid, more);

    const load = async (reset) => {
      if (reset) { m.page = 0; m.items = []; }
      const r = await attempt(() => lf.market.list({ search: m.search, sort: m.sort, page: m.page }));
      if (!r) return;
      m.items = reset ? r.items : [...m.items, ...r.items];
      m.total = r.total;
      grid.textContent = '';
      if (!m.items.length) grid.append(h('div', { style: 'grid-column:1/-1' }, emptyState('🛬', m.search ? 'Nothing found' : 'The marketplace is empty', m.search ? 'Try another search.' : 'Be the first creator to publish a livery!')));
      for (const l of m.items) grid.append(listingCard(l));
      more.textContent = '';
      if (m.items.length < m.total) more.append(h('button', { class: 'btn', onclick: () => { m.page++; load(false); } }, `Load more (${m.total - m.items.length} left)`));
    };
    search.addEventListener('input', debounce(() => { m.search = search.value; load(true); }, 350));
    sort.addEventListener('change', () => { m.sort = sort.value; load(true); });
    await load(true);
  }

  async function openListing(id) {
    const d = await attempt(() => lf.market.get(id));
    if (!d) return;
    S.market.detail = d;
    S.market.view = 'detail';
    S.market.shot = 0;
    if (S.screen !== 'market') navigate('market'); else renderMarket();
  }

  async function openCreator(idOrName) {
    const c = await attempt(() => lf.market.creator(idOrName));
    if (!c) return;
    S.market.creator = c;
    S.market.view = 'creator';
    if (S.screen !== 'market') navigate('market'); else renderMarket();
  }

  async function renderListingDetail(el) {
    const { listing: l, reviews, favorite, following, isMine } = S.market.detail;
    const local = (await lf.market.localDownloads().catch(() => [])).find((x) => x.id === l.id);
    const shots = l.screenshot_urls && l.screenshot_urls.length ? l.screenshot_urls : (l.thumbnail_url ? [l.thumbnail_url] : []);
    const main = h('div', { class: 'gallery-main' });
    const strip = h('div', { class: 'gallery-strip' });
    const showShot = (i) => {
      S.market.shot = i;
      if (shots[i]) main.style.backgroundImage = cssUrl(shots[i]);
      [...strip.children].forEach((c, j) => c.classList.toggle('active', j === i));
    };
    shots.forEach((s, i) => strip.append(h('div', { style: `background-image:${cssUrl(s)}`, onclick: () => showShot(i) })));
    showShot(S.market.shot || 0);

    const refresh = async () => { S.market.detail = await lf.market.get(l.id); renderMarket(); };
    const c = l.creator || {};

    const dlBtn = h('button', { class: 'btn primary big', onclick: async () => {
      if (!S.settings.communityPath) { toast('Set your Community folder in Settings first.', 'warn'); return; }
      const r = await attempt(() => lf.market.download({ id: l.id, install: true }));
      if (r) { toast(`Installed "${l.title}" in your Community folder. Start MSFS 2024 to fly it! ✈`, 'ok', 7000); refresh(); }
    } }, local ? (local.version !== l.version ? `⬇ Update to v${l.version}` : '⟳ Re-download & install') : '⬇ Download & install');

    let rating = 0;
    const starBox = h('div', { class: 'star-input' });
    const drawStars = () => { starBox.textContent = ''; for (let i = 1; i <= 5; i++) starBox.append(h('button', { class: i <= rating ? 'on' : '', onclick: () => { rating = i; drawStars(); } }, '★')); };
    drawStars();
    const comment = h('textarea', { rows: '3', placeholder: 'What do you think of this livery?' });

    el.append(h('button', { class: 'btn ghost', style: 'margin-bottom:12px', onclick: () => { S.market.view = 'browse'; renderMarket(); } }, '← Back to marketplace'),
      h('div', { class: 'detail-layout' },
        h('div', {}, main, strip,
          h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Description'), h('div', { class: 'description' }, l.description || l.short_description || 'No description.'),
            l.changelog ? h('div', {}, h('h3', { style: 'margin-top:14px' }, 'Changelog'), h('div', { class: 'description muted' }, l.changelog)) : null,
            l.license ? h('div', {}, h('h3', { style: 'margin-top:14px' }, 'License'), h('div', { class: 'description muted' }, l.license)) : null),
          h('div', { class: 'card' }, h('h3', {}, `Reviews (${l.rating_count})`),
            !isMine ? h('div', { class: 'form-grid', style: 'margin-bottom:10px' }, starBox, comment, h('div', {}, h('button', { class: 'btn', onclick: async () => {
              if (!rating) { toast('Click the stars to rate.', 'warn'); return; }
              if (await attempt(() => lf.market.review({ id: l.id, rating, comment: comment.value }), 'Thanks for your review!')) refresh();
            } }, 'Post review'))) : h('p', { class: 'muted small' }, 'You cannot review your own livery.'),
            reviews.length ? reviews.map((r) => h('div', { class: 'review' }, h('div', { class: 'row gap' }, avatar(r.author, 'sm'), h('b', {}, r.author ? r.author.display_name || r.author.username : 'Pilot'), h('span', { class: 'stars' }, stars(r.rating)), h('span', { class: 'muted small' }, timeAgo(r.created_at))), r.comment ? h('p', { style: 'margin:6px 0 0', class: 'description' }, r.comment) : null)) : h('p', { class: 'muted' }, 'No reviews yet.'))),
        h('div', {},
          h('div', { class: 'card' },
            h('h1', {}, l.title),
            h('div', { class: 'muted' }, l.aircraft),
            h('div', { class: 'badges', style: 'margin:10px 0' }, h('span', { class: 'badge blue' }, `v${l.version}`), l.registration ? h('span', { class: 'badge' }, l.registration) : null, l.modular ? h('span', { class: 'badge warn' }, 'Modular (experimental)') : null, h('span', { class: 'badge' }, fmtBytes(l.file_size)), (l.tags || []).map((t) => h('span', { class: 'badge' }, t))),
            h('div', { class: 'stat-row' }, h('div', { class: 'stat' }, h('b', { class: 'stars' }, Number(l.rating_avg).toFixed(1)), h('span', {}, `${l.rating_count} ratings`)), h('div', { class: 'stat' }, h('b', {}, String(l.downloads)), h('span', {}, 'downloads')), h('div', { class: 'stat' }, h('b', {}, String(l.favorites_count)), h('span', {}, 'favorites'))),
            h('div', { class: 'form-grid', style: 'margin-top:16px' },
              dlBtn,
              local ? h('div', { class: 'row gap' },
                local.community ? h('span', { class: 'badge ok' }, '✓ In Community') : h('span', { class: 'badge' }, 'Downloaded, not installed'),
                local.community ? h('button', { class: 'btn small', onclick: async () => { await attempt(() => lf.market.uninstall(l.id), 'Removed from Community.'); refresh(); } }, 'Uninstall') : h('button', { class: 'btn small', onclick: async () => { await attempt(() => lf.market.install(l.id), 'Installed.'); refresh(); } }, 'Install')) : null,
              h('button', { class: 'btn', onclick: async () => { await attempt(() => lf.market.favorite(l.id)); refresh(); } }, favorite ? '♥ In your favorites' : '♡ Add to favorites'),
              isMine ? h('button', { class: 'btn', onclick: () => navigate('studio') }, '⭐ Manage in Creator studio') : null),
            h('p', { class: 'muted small', style: 'margin-top:10px' }, `Published ${timeAgo(l.created_at)} · updated ${timeAgo(l.updated_at)}`)),
          h('div', { class: 'card' }, h('div', { class: 'row gap' }, avatar(c), h('div', { style: 'flex:1;min-width:0' }, h('b', {}, c.display_name || c.username), h('div', { class: 'muted small' }, `@${c.username} · ${roleLabel(c.role)}`))),
            c.bio ? h('p', { class: 'muted small', style: 'margin-top:8px' }, c.bio) : null,
            h('div', { class: 'row gap', style: 'margin-top:10px' }, h('button', { class: 'btn small', onclick: () => openCreator(c.id) }, 'View profile'),
              !isMine ? h('button', { class: 'btn small', onclick: async () => { await attempt(() => lf.market.follow(c.id)); refresh(); } }, following ? '✓ Following' : '＋ Follow') : null)))));
  }

  function renderCreatorPage(el) {
    const { profile: p, stats, listings, following, isMe } = S.market.creator;
    el.append(h('button', { class: 'btn ghost', style: 'margin-bottom:12px', onclick: () => { S.market.view = S.market.detail ? 'detail' : 'browse'; renderMarket(); } }, '← Back'),
      h('div', { class: 'profile-hero', style: `border-color:${p.accent_color}` }, avatar(p, 'lg'),
        h('div', { style: 'flex:1' }, h('h1', { style: 'margin:0' }, p.display_name || p.username), h('div', { class: 'muted' }, `@${p.username}`),
          h('div', { class: 'badges', style: 'margin-top:6px' }, h('span', { class: 'badge blue' }, roleLabel(p.role)), p.home_airport ? h('span', { class: 'badge' }, `🛬 ${p.home_airport}`) : null, p.favorite_aircraft ? h('span', { class: 'badge' }, `✈ ${p.favorite_aircraft}`) : null),
          p.bio ? h('p', { style: 'margin-top:8px' }, p.bio) : null,
          p.website && /^https:\/\//.test(p.website) ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); lf.shell.openExternal(p.website); } }, p.website) : null,
          h('div', { class: 'stat-row' }, h('div', { class: 'stat' }, h('b', {}, String(stats.listings || 0)), h('span', {}, 'liveries')), h('div', { class: 'stat' }, h('b', {}, String(stats.downloads || 0)), h('span', {}, 'downloads')), h('div', { class: 'stat' }, h('b', {}, String(stats.followers || 0)), h('span', {}, 'followers')))),
        !isMe ? h('button', { class: 'btn', onclick: async () => { await attempt(() => lf.market.follow(p.id)); openCreator(p.id); } }, following ? '✓ Following' : '＋ Follow') : h('button', { class: 'btn', onclick: () => navigate('profile') }, 'Edit profile')),
      h('h2', {}, 'Liveries'),
      listings.length ? h('div', { class: 'grid auto' }, listings.map((l) => listingCard(l))) : h('p', { class: 'muted' }, 'No published liveries yet.'));
  }

  /* ================================================================ */
  /* My hangar                                                         */
  /* ================================================================ */

  async function renderHangar() {
    const el = screenEl('hangar');
    el.textContent = '';
    el.append(pageHead('My hangar', 'Your downloaded liveries, favorites and the creators you follow. Log in on any PC and it is all still here.'));
    const tabs = [['library', '📥 Library'], ['favorites', '♥ Favorites'], ['feed', '📰 Following'], ['local', '💻 On this PC']];
    el.append(h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: S.hangarTab === id ? 'active' : '', onclick: () => { S.hangarTab = id; renderHangar(); } }, label))));
    const body = h('div', {});
    el.append(body);

    if (S.hangarTab === 'local') {
      const list = await lf.market.localDownloads().catch(() => []);
      if (!list.length) { body.append(emptyState('💻', 'Nothing downloaded on this PC', 'Liveries you download from the marketplace are stored in Documents\\Livery Forge\\Downloads.', h('button', { class: 'btn primary', onclick: () => navigate('market') }, 'Browse marketplace'))); return; }
      const card = h('div', { class: 'card' });
      for (const d of list) {
        card.append(h('div', { class: 'queue-item', style: 'grid-template-columns:1fr auto' },
          h('div', {}, h('b', {}, d.title), h('div', { class: 'muted small' }, `v${d.version} · ${d.pkg} · ${timeAgo(d.downloadedAt)}`)),
          h('div', { class: 'row gap' }, d.community ? h('span', { class: 'badge ok' }, 'In Community') : h('span', { class: 'badge' }, 'Not installed'),
            d.community ? h('button', { class: 'btn small', onclick: async () => { await attempt(() => lf.market.uninstall(d.id), 'Removed from Community.'); renderHangar(); } }, 'Uninstall')
              : h('button', { class: 'btn small ok', onclick: async () => { await attempt(() => lf.market.install(d.id), 'Installed.'); renderHangar(); } }, 'Install'),
            h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox('Delete download?', `Remove "${d.title}" from this PC (and from Community)?`)) { await attempt(() => lf.market.removeDownload(d.id), 'Deleted.'); renderHangar(); } } }, 'Delete'))));
      }
      body.append(card);
      return;
    }
    if (needCloud(body, 'hangar')) return;
    const data = await attempt(() => lf.market.hangar());
    if (!data) return;
    const grid = h('div', { class: 'grid auto' });
    const items = S.hangarTab === 'library' ? data.library : S.hangarTab === 'favorites' ? data.favorites : data.feed;
    if (!items.length) {
      const msg = { library: ['📥', 'Your library is empty', 'Every livery you download is remembered here - even after reinstalling the app.'], favorites: ['♥', 'No favorites yet', 'Tap the heart on a livery to save it for later.'], feed: ['📰', 'Not following anyone', 'Follow creators to see their newest liveries here.'] }[S.hangarTab];
      body.append(emptyState(msg[0], msg[1], msg[2], h('button', { class: 'btn primary', onclick: () => navigate('market') }, 'Browse marketplace')));
      return;
    }
    for (const l of items) grid.append(listingCard(l));
    body.append(grid);
  }

  /* ================================================================ */
  /* Creator studio                                                    */
  /* ================================================================ */

  async function renderStudio() {
    const el = screenEl('studio');
    el.textContent = '';
    el.append(pageHead('⭐ Creator studio', 'Your published liveries and how they are doing.', h('button', { class: 'btn primary', onclick: () => navigate('publish') }, '＋ Publish a livery')));
    if (needCloud(el, 'creator studio')) return;
    if (!isCreator()) { el.append(emptyState('🎨', 'Become a creator', 'Switch your account to Creator or Both to publish liveries.', h('button', { class: 'btn primary', onclick: () => navigate('profile') }, 'Open profile'))); return; }
    const mine = await attempt(() => lf.market.mine());
    if (!mine) return;
    const totalDl = mine.reduce((s, l) => s + l.downloads, 0);
    const rated = mine.filter((l) => l.rating_count > 0);
    const avg = rated.length ? rated.reduce((s, l) => s + Number(l.rating_avg) * l.rating_count, 0) / rated.reduce((s, l) => s + l.rating_count, 0) : 0;
    el.append(h('div', { class: 'grid cols-3', style: 'margin-bottom:14px' },
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Liveries'), h('h1', {}, String(mine.length))),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Total downloads'), h('h1', {}, String(totalDl))),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Average rating'), h('h1', { class: 'stars' }, rated.length ? avg.toFixed(2) + ' ★' : '-'))));
    if (!mine.length) { el.append(emptyState('🚀', 'Nothing published yet', 'Export a livery (step 4), then publish it from step 5.', h('button', { class: 'btn primary', onclick: () => navigate('projects') }, 'Go to projects'))); return; }
    const card = h('div', { class: 'card' });
    for (const l of mine) {
      const th = h('div', { class: 'queue-thumb' });
      if (l.thumbnail_url) th.style.backgroundImage = cssUrl(l.thumbnail_url);
      card.append(h('div', { class: 'queue-item' }, th,
        h('div', {}, h('b', {}, l.title), h('div', { class: 'muted small' }, `v${l.version} · ⬇ ${l.downloads} · ${stars(l.rating_avg)} (${l.rating_count}) · ♥ ${l.favorites_count} · ${fmtBytes(l.file_size)}`)),
        h('div', { class: 'row gap' },
          l.status === 'hidden' ? h('span', { class: 'badge warn' }, 'Hidden') : h('span', { class: 'badge ok' }, 'Live'),
          h('button', { class: 'btn small', onclick: () => openListing(l.id) }, 'View'),
          h('button', { class: 'btn small', onclick: async () => { await attempt(() => lf.market.setStatus({ id: l.id, status: l.status === 'hidden' ? 'published' : 'hidden' })); renderStudio(); } }, l.status === 'hidden' ? 'Show' : 'Hide'),
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox('Delete listing?', `Remove "${l.title}" from the marketplace? Downloads and reviews are lost.`)) { await attempt(() => lf.market.remove(l.id), 'Listing deleted.'); renderStudio(); } } }, 'Delete'))));
    }
    el.append(card);
  }

  /* ================================================================ */
  /* Profile                                                           */
  /* ================================================================ */

  async function renderProfile() {
    const el = screenEl('profile');
    el.textContent = '';
    if (!S.cloud.user) { needCloud(el, 'profile'); return; }
    const u = S.cloud.user;
    const p = { ...(u.profile || {}) };
    const input = (key, ph, max = 60) => { const i = h('input', { type: 'text', placeholder: ph, maxlength: String(max), value: p[key] || '' }); i.addEventListener('input', () => { p[key] = i.value; }); return i; };
    const bio = h('textarea', { rows: '3', maxlength: '600', placeholder: 'Tell pilots about yourself and your liveries' });
    bio.value = p.bio || '';
    bio.addEventListener('input', () => { p.bio = bio.value; });
    const color = h('input', { type: 'color', value: p.accent_color || '#3b82f6' });
    color.addEventListener('input', () => { p.accent_color = color.value; });
    const roleCards = h('div', { class: 'role-cards' });
    const drawRoles = () => {
      roleCards.textContent = '';
      for (const r of [{ id: 'user', ico: '🛩', t: 'Pilot', s: 'Download & fly' }, { id: 'creator', ico: '🎨', t: 'Creator', s: 'Paint & publish' }, { id: 'both', ico: '⭐', t: 'Both', s: 'Everything' }]) {
        roleCards.append(h('div', { class: 'role-card' + (p.role === r.id ? ' active' : ''), onclick: () => { p.role = r.id; drawRoles(); } }, h('div', { class: 'ico' }, r.ico), h('b', {}, r.t), h('small', {}, r.s)));
      }
    };
    drawRoles();

    el.append(pageHead('Your profile', u.email,
      h('button', { class: 'btn', onclick: () => openCreator(u.id) }, 'View public profile'),
      h('button', { class: 'btn', onclick: () => runSync(true) }, '⟳ Sync now'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Log out?', 'Your projects stay on this PC and in the cloud. Log in again any time to get them back.', 'Log out', false))) return;
        await saveTexture(true);
        await attempt(() => lf.cloud.signOut());
        S.cloud = await lf.cloud.status();
        S.project = null; S.editor && S.editor.clear(); S.texId = null;
        try { localStorage.removeItem('lf.offline'); } catch { /* ignore */ }
        showAuth('login');
      } }, 'Log out')));

    el.append(h('div', { class: 'card' },
      h('div', { class: 'row gap' }, avatar(p, 'lg'), h('div', { class: 'form-grid' },
        h('button', { class: 'btn', onclick: async () => {
          const f = await lf.dialog.pickFiles({ title: 'Choose a profile picture', kind: 'image' });
          if (!f.length) return;
          const prof = await attempt(() => lf.cloud.uploadAvatar(f[0]), 'Profile picture updated.');
          if (prof) { S.cloud.user.profile = prof; renderAccount(); renderProfile(); }
        } }, 'Change picture'),
        h('label', { class: 'field' }, h('span', {}, 'Accent color'), color))),
      h('div', { class: 'section-title' }, 'Account type'), roleCards,
      h('div', { class: 'section-title' }, 'About you'),
      h('div', { class: 'form-grid cols-2' },
        field('Display name', input('display_name', 'Your name')),
        field('Username', input('username', 'a-z, 0-9, _', 24), 'Changing it changes your profile link.'),
        h('div', { class: 'span-2' }, field('Bio', bio)),
        field('Website (https://...)', input('website', 'https://...', 200)),
        field('Home airport (ICAO)', input('home_airport', 'e.g. KSEA', 8)),
        field('Favorite aircraft', input('favorite_aircraft', 'e.g. A320neo', 80))),
      h('div', { class: 'row gap', style: 'margin-top:16px' }, h('button', { class: 'btn primary', onclick: async () => {
        const saved = await attempt(() => lf.cloud.updateProfile({ display_name: p.display_name, username: p.username, role: p.role, bio: p.bio, website: p.website, home_airport: (p.home_airport || '').toUpperCase(), favorite_aircraft: p.favorite_aircraft, accent_color: p.accent_color }), 'Profile saved.');
        if (saved) { S.cloud.user.profile = saved; renderAccount(); updateNav(); renderProfile(); }
      } }, 'Save profile'))));
  }

  /* ================================================================ */
  /* 6. Settings                                                       */
  /* ================================================================ */

  async function renderSettings() {
    const el = screenEl('settings');
    el.textContent = '';
    S.settings = await lf.settings.get();
    const s = S.settings;
    const set = async (patch, msg) => { const r = await attempt(() => lf.settings.set(patch), msg); if (r) { S.settings = r; renderSettings(); } };

    const pathRow = (label, key, title, hint, check) => {
      const input = h('input', { type: 'text', value: s[key] || '', placeholder: 'Not set', spellcheck: 'false' });
      input.addEventListener('change', () => set({ [key]: input.value.trim() }, 'Saved.'));
      return h('label', { class: 'field' }, h('span', {}, label, check),
        h('div', { class: 'input-row' }, input, h('button', { class: 'btn', onclick: async (e) => {
          e.preventDefault();
          const p = await lf.dialog.pickFolder(title);
          if (p) set({ [key]: p }, 'Saved.');
        } }, 'Browse...')), hint ? h('div', { class: 'hint' }, hint) : null);
    };
    const sdkBadge = s.sdkPath ? (s.sdkValid ? h('span', { class: 'badge ok', style: 'margin-left:8px' }, '✓ fspackagetool.exe found') : h('span', { class: 'badge error', style: 'margin-left:8px' }, '✗ fspackagetool.exe not found')) : null;

    el.append(pageHead('6. Settings', 'Where MSFS 2024 lives and how packages are built.',
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await attempt(() => lf.settings.detect());
        if (!r) return;
        S.settings = r.settings;
        S.aircraft = [];
        toast(r.detected.found ? `Found MSFS 2024 (${r.detected.edition === 'steam' ? 'Steam' : 'Microsoft Store'}).${r.detected.notes.length ? '\n' + r.detected.notes.join('\n') : ''}` : r.detected.notes.join('\n'), r.detected.found ? 'ok' : 'warn', 8000);
        renderSettings();
      } }, '🔎 Auto-detect')));

    el.append(h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Microsoft Flight Simulator 2024'),
      h('div', { class: 'form-grid' },
        pathRow('Community folder', 'communityPath', 'Choose your Community folder', 'Your test packages are linked here.'),
        pathRow('Official folder', 'officialPath', 'Choose the Official\\OneStore or Official\\Steam folder', 'Used to find the default aircraft.'),
        h('div', { class: 'field' }, h('span', {}, 'Extra aircraft folders'),
          s.extraAircraftPaths.length ? s.extraAircraftPaths.map((p) => h('div', { class: 'input-row' }, h('input', { type: 'text', value: p, readonly: true }), h('button', { class: 'btn danger', onclick: () => set({ extraAircraftPaths: s.extraAircraftPaths.filter((x) => x !== p) }) }, 'Remove'))) : h('div', { class: 'muted small' }, 'None.'),
          h('div', {}, h('button', { class: 'btn small', onclick: async () => { const p = await lf.dialog.pickFolder('Add aircraft folder'); if (p) set({ extraAircraftPaths: [...s.extraAircraftPaths, p] }); } }, '＋ Add folder'))),
        h('div', { class: 'field' }, h('span', {}, 'Edition'), h('div', { class: 'row gap' },
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'edition', checked: s.edition === 'store' ? true : null, onchange: () => set({ edition: 'store' }) }), 'Microsoft Store / Xbox app'),
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'edition', checked: s.edition === 'steam' ? true : null, onchange: () => set({ edition: 'steam' }) }), 'Steam (adds -forcesteam)'))))),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'MSFS 2024 SDK'),
      h('div', { class: 'form-grid' },
        pathRow('SDK folder', 'sdkPath', 'Choose the MSFS 2024 SDK folder', 'Usually C:\\MSFS 2024 SDK. Must contain Tools\\bin\\fspackagetool.exe.', sdkBadge),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.highQualityTextures ? true : null, onchange: (e) => set({ highQualityTextures: e.target.checked }) }), 'High-quality texture compression (QUALITYHIGH - sharper, slower to build)'),
        h('div', { class: 'field' }, h('span', {}, 'Community install mode'), h('div', { class: 'row gap' },
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', checked: s.installMode === 'link' ? true : null, onchange: () => set({ installMode: 'link' }) }), 'Link (junction - recommended, re-exports update instantly)'),
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', checked: s.installMode === 'copy' ? true : null, onchange: () => set({ installMode: 'copy' }) }), 'Copy'))),
        field('Default author name', (() => { const i = h('input', { type: 'text', value: s.defaultAuthor, placeholder: 'Used for new liveries' }); i.addEventListener('change', () => set({ defaultAuthor: i.value.trim() }, 'Saved.')); return i; })()),
        field('Uploads per hour (flightsim.to pacing)', (() => { const i = h('input', { type: 'number', min: '1', max: '20', value: s.uploadsPerHour }); i.addEventListener('change', () => set({ uploadsPerHour: Math.max(1, Math.min(20, Number(i.value) || 3)) }, 'Saved.')); return i; })()))),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Cloud server (accounts, sync, marketplace)'),
      h('p', { class: 'muted small' }, s.cloudConfigured ? '✓ Connected. Only change this if you move to another Supabase project.' : 'Not connected. Create a free Supabase project (see README) and paste its URL and anon key.'),
      (() => {
        const url = h('input', { type: 'url', value: s.supabaseUrl, placeholder: 'https://xxxx.supabase.co' });
        const key = h('input', { type: 'text', value: s.supabaseAnonKey, placeholder: 'anon public key' });
        return h('div', { class: 'form-grid cols-2' }, field('Supabase URL', url), field('Anon (public) key', key),
          h('div', {}, h('button', { class: 'btn', onclick: async () => {
            await set({ supabaseUrl: url.value.trim(), supabaseAnonKey: key.value.trim() }, 'Cloud settings saved.');
            S.cloud = await lf.cloud.status();
            renderAccount();
          } }, 'Save cloud settings')));
      })()),
    h('div', { class: 'card' },
      h('div', { class: 'section-title', style: 'margin-top:0' }, 'Folders'),
      h('p', { class: 'muted small mono' }, `Projects: ${S.info.projectsRoot}`),
      h('p', { class: 'muted small mono' }, `Output:   ${S.info.outputRoot}`),
      h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.openFolder('projects')) }, 'Open projects folder'), h('button', { class: 'btn', onclick: () => attempt(() => lf.shell.openFolder('output')) }, 'Open output folder')),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, `Livery Forge v${S.info.version}. Press F12 to open developer tools if something goes wrong.`)));
  }

  /* ================================================================ */
  init().catch((e) => {
    console.error(e);
    document.body.append(h('div', { class: 'notice error', style: 'margin:30px' }, 'Livery Forge failed to start: ' + e.message));
  });

  // Exposed for automated UI tests only.
  window.__lfTest = { S, navigate, openProject, saveTexture, createTexture };
})();
