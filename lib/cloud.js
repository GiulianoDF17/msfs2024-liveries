/**
 * cloud.js
 * --------
 * Everything that talks to the Livery Forge cloud server (Supabase):
 *
 *   - Accounts: sign up (as user, creator or both), log in, log out,
 *     password reset with a code from the email, profile editing.
 *   - Project sync: your projects are uploaded to your private cloud folder,
 *     so if you reinstall Windows or the app and log in again, they come back.
 *   - Marketplace: browse, download & install liveries; creators publish
 *     their exported packages; ratings, favorites, follows, library.
 *
 * This runs in Electron's MAIN process only (never in the web page), and the
 * login session is stored encrypted on disk with Electron's safeStorage when
 * available.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createClient } = require('@supabase/supabase-js');
const { ID_RE, NO_SYNC_DIRS } = require('./projects');
const { slugify, isInside } = require('./safe-path');

const PROJECT_BUCKET = 'project-files';
const MARKET_BUCKET = 'marketplace';
const ROLES = ['user', 'creator', 'both'];
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

function sha1File(file) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** Turns Supabase errors into friendly sentences. */
function friendly(error) {
  if (!error) return 'Unknown error.';
  const msg = String(error.message || error.error_description || error);
  if (/invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first (check your inbox), then log in.';
  if (/user already registered/i.test(msg)) return 'An account with this email already exists. Try logging in.';
  if (/password should be at least/i.test(msg)) return 'Password is too short (at least 8 characters).';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(msg)) return 'Cannot reach the Livery Forge server. Check your internet connection.';
  if (/row-level security|violates row-level/i.test(msg)) return 'You are not allowed to do that with this account.';
  if (/Payload too large|exceeded the maximum allowed size/i.test(msg)) return 'The file is too large for the server (check the Supabase upload size limit).';
  if (/token has expired|otp/i.test(msg)) return 'The code is wrong or has expired. Request a new one.';
  return msg;
}

function check({ data, error }) {
  if (error) throw new Error(friendly(error));
  return data;
}

/** File-based storage for the Supabase login session. */
function fileStorage(file, cipher) {
  const readAll = () => {
    try {
      const raw = fs.readFileSync(file);
      const text = cipher ? cipher.decrypt(raw) : raw.toString('utf8');
      return JSON.parse(text);
    } catch { return {}; }
  };
  const writeAll = (obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(obj);
    fs.writeFileSync(file, cipher ? cipher.encrypt(text) : text);
  };
  return {
    getItem: (k) => { const v = readAll()[k]; return v === undefined ? null : v; },
    setItem: (k, v) => { const all = readAll(); all[k] = v; writeAll(all); },
    removeItem: (k) => { const all = readAll(); delete all[k]; writeAll(all); },
  };
}

/* ------------------------------------------------------------------ */
/* Cloud class                                                          */
/* ------------------------------------------------------------------ */

class Cloud {
  /**
   * @param {object} o
   * @param {string} o.url            Supabase project URL
   * @param {string} o.anonKey        Supabase anon/publishable key
   * @param {string} o.sessionFile    where the login session is stored
   * @param {object} [o.cipher]       { encrypt(str)->Buffer, decrypt(Buffer)->str }
   * @param {import('./projects').ProjectStore} o.store
   * @param {string} o.downloadsRoot  ...\Livery Forge\Downloads
   */
  constructor({ url, anonKey, sessionFile, cipher, store, downloadsRoot }) {
    this.url = (url || '').replace(/\/+$/, '');
    this.anonKey = anonKey || '';
    this.store = store;
    this.downloadsRoot = downloadsRoot;
    this.sessionFile = sessionFile;
    this.hashCache = new Map(); // abs path -> { size, mtimeMs, sha1 }
    this.client = null;
    this.profile = null;
    if (this.isConfigured()) {
      this.client = createClient(this.url, this.anonKey, {
        auth: {
          storage: fileStorage(sessionFile, cipher),
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
    }
  }

  isConfigured() {
    return /^https?:\/\//.test(this.url) && this.anonKey.length > 20;
  }

  requireClient() {
    if (!this.client) throw new Error('The cloud server is not set up yet. See README > "Set up the cloud server".');
    return this.client;
  }

  /* ---------------- Accounts ---------------- */

  async getSession() {
    if (!this.client) return null;
    const { data } = await this.client.auth.getSession();
    return data.session || null;
  }

  async currentUser() {
    const session = await this.getSession();
    if (!session) return null;
    const user = session.user;
    if (!this.profile || this.profile.id !== user.id) await this.loadProfile(user.id);
    return { id: user.id, email: user.email, profile: this.profile };
  }

  async loadProfile(id) {
    const c = this.requireClient();
    const { data, error } = await c.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(friendly(error));
    this.profile = data || null;
    return this.profile;
  }

  async usernameAvailable(name) {
    const c = this.requireClient();
    const n = String(name || '').toLowerCase();
    if (!USERNAME_RE.test(n)) return false;
    return check(await c.rpc('username_available', { name: n }));
  }

  /**
   * Sign up. role = 'user' | 'creator' | 'both'.
   * Returns { needsConfirmation, user }.
   */
  async signUp({ email, password, username, displayName, role }) {
    const c = this.requireClient();
    const uname = String(username || '').toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) throw new Error('Please enter a valid email address.');
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
    if (!USERNAME_RE.test(uname)) throw new Error('Username: 3-24 characters, only a-z, 0-9 and _.');
    if (!ROLES.includes(role)) throw new Error('Pick how you want to use Livery Forge.');
    if (!(await this.usernameAvailable(uname))) throw new Error('That username is already taken.');
    const data = check(await c.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { username: uname, display_name: (displayName || uname).slice(0, 60), role } },
    }));
    if (!data.session) return { needsConfirmation: true, user: null };
    return { needsConfirmation: false, user: await this.currentUser() };
  }

  async signIn({ email, password }) {
    const c = this.requireClient();
    check(await c.auth.signInWithPassword({ email: String(email || '').trim(), password: password || '' }));
    return this.currentUser();
  }

  async signOut() {
    if (!this.client) return;
    try { await this.client.auth.signOut(); } catch { /* offline: local session is removed anyway */ }
    this.profile = null;
  }

  /** Step 1 of password reset: email the user a code. */
  async sendPasswordReset(email) {
    const c = this.requireClient();
    check(await c.auth.resetPasswordForEmail(String(email || '').trim()));
    return true;
  }

  /** Step 2: verify the code from the email and set a new password. */
  async resetPasswordWithCode({ email, code, newPassword }) {
    const c = this.requireClient();
    if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    check(await c.auth.verifyOtp({ email: String(email || '').trim(), token: String(code || '').trim(), type: 'recovery' }));
    check(await c.auth.updateUser({ password: newPassword }));
    return this.currentUser();
  }

  async updateProfile(patch) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Please log in.');
    const allowed = {};
    for (const k of ['display_name', 'role', 'bio', 'website', 'accent_color', 'home_airport', 'favorite_aircraft', 'username', 'avatar_url']) {
      if (patch[k] !== undefined) allowed[k] = typeof patch[k] === 'string' ? patch[k].trim() : patch[k];
    }
    if (allowed.role && !ROLES.includes(allowed.role)) throw new Error('Invalid role.');
    if (allowed.username) {
      allowed.username = allowed.username.toLowerCase();
      if (!USERNAME_RE.test(allowed.username)) throw new Error('Username: 3-24 characters, only a-z, 0-9 and _.');
      if (allowed.username !== me.profile.username && !(await this.usernameAvailable(allowed.username))) throw new Error('That username is already taken.');
    }
    allowed.updated_at = new Date().toISOString();
    const data = check(await c.from('profiles').update(allowed).eq('id', me.id).select().single());
    this.profile = data;
    return data;
  }

  /** Uploads an avatar image (JPEG buffer). */
  async uploadAvatar(jpegBuffer) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Please log in.');
    const key = `${me.id}/avatar.jpg`;
    check(await c.storage.from(MARKET_BUCKET).upload(key, jpegBuffer, { contentType: 'image/jpeg', upsert: true }));
    const url = this.publicUrl(key) + `?v=${Date.now()}`;
    return this.updateProfile({ avatar_url: url });
  }

  /* ---------------- Project sync ---------------- */

  /** sha1 with a cache, so unchanged files aren't hashed again. */
  hashFile(abs, size, mtimeMs) {
    const c = this.hashCache.get(abs);
    if (c && c.size === size && c.mtimeMs === mtimeMs) return c.sha1;
    const sha1 = sha1File(abs);
    this.hashCache.set(abs, { size, mtimeMs, sha1 });
    return sha1;
  }

  localManifest(projectId) {
    const dir = this.store.dir(projectId);
    const files = {};
    let total = 0;
    for (const f of this.store.listSyncFiles(projectId)) {
      files[f.rel] = { sha1: this.hashFile(path.join(dir, ...f.rel.split('/')), f.size, f.mtimeMs), size: f.size };
      total += f.size;
    }
    return { files, total };
  }

  async listCloudProjects() {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) return [];
    return check(await c.from('cloud_projects').select('id,name,aircraft,updated_at,total_bytes,data').eq('user_id', me.id).order('updated_at', { ascending: false }));
  }

  /**
   * Uploads one project to the cloud (only changed files).
   * `onProgress(done, total)` is optional.
   */
  async pushProject(projectId, onProgress = () => {}) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Please log in to sync.');
    const project = this.store.load(projectId);
    if (project.ownerId && project.ownerId !== me.id) throw new Error('This project belongs to another account.');
    if (!project.ownerId) { project.ownerId = me.id; this.store.save(project, { touch: false }); }

    const { data: row } = await c.from('cloud_projects').select('files').eq('user_id', me.id).eq('id', projectId).maybeSingle();
    const remote = (row && row.files) || {};
    const local = this.localManifest(projectId);
    const dir = this.store.dir(projectId);
    const toUpload = Object.keys(local.files).filter((rel) => !remote[rel] || remote[rel].sha1 !== local.files[rel].sha1);
    const toDelete = Object.keys(remote).filter((rel) => !local.files[rel]);

    let done = 0;
    onProgress(done, toUpload.length);
    for (const rel of toUpload) {
      const buf = fs.readFileSync(path.join(dir, ...rel.split('/')));
      const key = `${me.id}/${projectId}/${rel}`;
      check(await c.storage.from(PROJECT_BUCKET).upload(key, buf, { upsert: true, contentType: contentTypeFor(rel) }));
      onProgress(++done, toUpload.length);
    }
    if (toDelete.length) {
      await c.storage.from(PROJECT_BUCKET).remove(toDelete.map((rel) => `${me.id}/${projectId}/${rel}`));
    }
    check(await c.from('cloud_projects').upsert({
      user_id: me.id,
      id: projectId,
      name: project.name,
      aircraft: (project.aircraft && project.aircraft.title) || '',
      data: project,
      files: local.files,
      total_bytes: local.total,
      updated_at: project.updatedAt || new Date().toISOString(),
    }));
    return { uploaded: toUpload.length, deleted: toDelete.length };
  }

  /** Downloads one project from the cloud into the local Projects folder. */
  async pullProject(row, onProgress = () => {}) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!ID_RE.test(row.id)) return { skipped: true };
    const full = check(await c.from('cloud_projects').select('*').eq('user_id', me.id).eq('id', row.id).single());
    const remote = full.files || {};
    const dir = this.store.dir(row.id);
    fs.mkdirSync(dir, { recursive: true });
    const local = this.store.exists(row.id) ? this.localManifest(row.id).files : {};
    const rels = Object.keys(remote).filter((rel) => rel !== 'project.json' && (!local[rel] || local[rel].sha1 !== remote[rel].sha1));
    let done = 0;
    onProgress(done, rels.length);
    for (const rel of rels) {
      const target = path.join(dir, ...rel.split('/'));
      if (!isInside(dir, target) || NO_SYNC_DIRS.includes(rel.split('/')[0])) continue;
      const { data, error } = await c.storage.from(PROJECT_BUCKET).download(`${me.id}/${row.id}/${rel}`);
      if (error) throw new Error(`Could not download ${rel}: ${friendly(error)}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await data.arrayBuffer()));
      onProgress(++done, rels.length);
    }
    // Remove local synced files that were deleted in the cloud.
    for (const rel of Object.keys(local)) {
      if (!remote[rel] && rel !== 'project.json') fs.rmSync(path.join(dir, ...rel.split('/')), { force: true });
    }
    // project.json last, so a half-finished download never looks complete.
    const project = { ...full.data, id: row.id, ownerId: me.id };
    // The export info points at files on the other computer; clear it.
    project.export = {};
    if (project.publish && project.publish.status === 'ready') project.publish.status = 'none';
    this.store.save(project, { touch: false });
    return { downloaded: rels.length };
  }

  /**
   * Two-way sync of all projects (newest copy wins).
   * Returns a short report.
   */
  async syncAll(onStatus = () => {}) {
    const me = await this.currentUser();
    if (!me) return { skipped: true };
    const cloud = await this.listCloudProjects();
    const cloudById = new Map(cloud.map((r) => [r.id, r]));
    const report = { pulled: 0, pushed: 0, errors: [] };

    for (const row of cloud) {
      try {
        let localUpdated = '';
        if (this.store.exists(row.id)) {
          const lp = this.store.load(row.id);
          if (lp.ownerId && lp.ownerId !== me.id) continue;
          localUpdated = lp.updatedAt || '';
        }
        if (!localUpdated || Date.parse(row.updated_at) > Date.parse(localUpdated) + 1000) {
          onStatus(`Downloading "${row.name}"...`);
          await this.pullProject(row);
          report.pulled++;
        }
      } catch (e) { report.errors.push(`${row.name}: ${e.message}`); }
    }
    for (const summary of this.store.list()) {
      try {
        const lp = this.store.load(summary.id);
        if (lp.ownerId && lp.ownerId !== me.id) continue;
        const row = cloudById.get(summary.id);
        if (!row || Date.parse(lp.updatedAt) > Date.parse(row.updated_at) + 1000) {
          onStatus(`Uploading "${summary.name}"...`);
          await this.pushProject(summary.id);
          report.pushed++;
        }
      } catch (e) { report.errors.push(`${summary.name}: ${e.message}`); }
    }
    return report;
  }

  /** Deletes a project from the cloud (files + row). */
  async deleteCloudProject(projectId) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) return false;
    const { data: row } = await c.from('cloud_projects').select('files').eq('user_id', me.id).eq('id', projectId).maybeSingle();
    if (!row) return false;
    const keys = Object.keys(row.files || {}).map((rel) => `${me.id}/${projectId}/${rel}`);
    for (let i = 0; i < keys.length; i += 100) {
      await c.storage.from(PROJECT_BUCKET).remove(keys.slice(i, i + 100));
    }
    check(await c.from('cloud_projects').delete().eq('user_id', me.id).eq('id', projectId));
    return true;
  }

  /* ---------------- Marketplace ---------------- */

  publicUrl(key) {
    if (!key) return '';
    return `${this.url}/storage/v1/object/public/${MARKET_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  decorate(listing) {
    if (!listing) return listing;
    return {
      ...listing,
      thumbnail_url: this.publicUrl(listing.thumbnail_path),
      screenshot_urls: (listing.screenshots || []).map((s) => this.publicUrl(s)),
      file_url: this.publicUrl(listing.file_path),
    };
  }

  /**
   * Browse listings.
   * opts: { search, sort: 'new'|'popular'|'top', aircraft, creatorId, page, pageSize, ids }
   */
  async listListings(opts = {}) {
    const c = this.requireClient();
    const pageSize = Math.min(Math.max(opts.pageSize || 24, 1), 60);
    const page = Math.max(opts.page || 0, 0);
    let q = c.from('listings')
      .select('*, creator:profiles!listings_creator_id_fkey(id,username,display_name,avatar_url,accent_color,role)', { count: 'exact' })
      .eq('status', 'published');
    if (opts.search) {
      const s = String(opts.search).replace(/[%,()]/g, ' ').trim();
      if (s) q = q.or(`title.ilike.%${s}%,aircraft.ilike.%${s}%,short_description.ilike.%${s}%,registration.ilike.%${s}%`);
    }
    if (opts.aircraft) q = q.ilike('aircraft', `%${String(opts.aircraft).replace(/[%,()]/g, ' ')}%`);
    if (opts.creatorId) q = q.eq('creator_id', opts.creatorId);
    if (Array.isArray(opts.ids)) q = q.in('id', opts.ids.length ? opts.ids : ['00000000-0000-0000-0000-000000000000']);
    if (opts.sort === 'popular') q = q.order('downloads', { ascending: false });
    else if (opts.sort === 'top') q = q.order('rating_avg', { ascending: false }).order('rating_count', { ascending: false });
    else q = q.order('created_at', { ascending: false });
    q = q.range(page * pageSize, page * pageSize + pageSize - 1);
    const { data, error, count } = await q;
    if (error) throw new Error(friendly(error));
    return { items: data.map((l) => this.decorate(l)), total: count || 0, page, pageSize };
  }

  /** One listing with reviews, creator and whether I favorited/downloaded it. */
  async getListing(id) {
    const c = this.requireClient();
    const listing = check(await c.from('listings')
      .select('*, creator:profiles!listings_creator_id_fkey(id,username,display_name,avatar_url,accent_color,role,bio)')
      .eq('id', id).single());
    const reviews = check(await c.from('reviews')
      .select('rating,comment,created_at,user_id, author:profiles!reviews_user_id_fkey(username,display_name,avatar_url,accent_color)')
      .eq('listing_id', id).order('created_at', { ascending: false }).limit(50));
    const me = await this.currentUser();
    let favorite = false;
    let inLibrary = null;
    let following = false;
    if (me) {
      const f = await c.from('favorites').select('listing_id').eq('user_id', me.id).eq('listing_id', id).maybeSingle();
      favorite = !!f.data;
      const l = await c.from('library').select('version,downloaded_at').eq('user_id', me.id).eq('listing_id', id).maybeSingle();
      inLibrary = l.data || null;
      const fo = await c.from('follows').select('creator_id').eq('follower_id', me.id).eq('creator_id', listing.creator_id).maybeSingle();
      following = !!fo.data;
    }
    return { listing: this.decorate(listing), reviews, favorite, inLibrary, following, isMine: !!me && me.id === listing.creator_id };
  }

  /** Creator profile page data. */
  async getCreator(idOrUsername) {
    const c = this.requireClient();
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrUsername);
    const profile = check(await c.from('profiles').select('*').eq(isUuid ? 'id' : 'username', idOrUsername).single());
    const stats = check(await c.from('creator_stats').select('*').eq('id', profile.id).maybeSingle()) || {};
    const listings = await this.listListings({ creatorId: profile.id, pageSize: 60 });
    const me = await this.currentUser();
    let following = false;
    if (me && me.id !== profile.id) {
      const fo = await c.from('follows').select('creator_id').eq('follower_id', me.id).eq('creator_id', profile.id).maybeSingle();
      following = !!fo.data;
    }
    return { profile, stats, listings: listings.items, following, isMe: !!me && me.id === profile.id };
  }

  async toggleFavorite(listingId) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Log in to save favorites.');
    const { data } = await c.from('favorites').select('listing_id').eq('user_id', me.id).eq('listing_id', listingId).maybeSingle();
    if (data) {
      check(await c.from('favorites').delete().eq('user_id', me.id).eq('listing_id', listingId));
      return false;
    }
    check(await c.from('favorites').insert({ user_id: me.id, listing_id: listingId }));
    return true;
  }

  async toggleFollow(creatorId) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Log in to follow creators.');
    if (me.id === creatorId) throw new Error('You cannot follow yourself.');
    const { data } = await c.from('follows').select('creator_id').eq('follower_id', me.id).eq('creator_id', creatorId).maybeSingle();
    if (data) {
      check(await c.from('follows').delete().eq('follower_id', me.id).eq('creator_id', creatorId));
      return false;
    }
    check(await c.from('follows').insert({ follower_id: me.id, creator_id: creatorId }));
    return true;
  }

  async submitReview(listingId, rating, comment) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Log in to rate liveries.');
    const r = Math.round(Number(rating));
    if (!(r >= 1 && r <= 5)) throw new Error('Pick 1 to 5 stars.');
    check(await c.from('reviews').upsert({ listing_id: listingId, user_id: me.id, rating: r, comment: String(comment || '').slice(0, 2000), updated_at: new Date().toISOString() }));
    return true;
  }

  /** My favorites + library + following feed. */
  async myHangar() {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) return { favorites: [], library: [], feed: [] };
    const favIds = check(await c.from('favorites').select('listing_id').eq('user_id', me.id)).map((r) => r.listing_id);
    const lib = check(await c.from('library').select('listing_id,version,downloaded_at').eq('user_id', me.id).order('downloaded_at', { ascending: false }));
    const follows = check(await c.from('follows').select('creator_id').eq('follower_id', me.id)).map((r) => r.creator_id);
    const favorites = (await this.listListings({ ids: favIds, pageSize: 60 })).items;
    const libListings = (await this.listListings({ ids: lib.map((l) => l.listing_id), pageSize: 60 })).items;
    const library = lib.map((l) => {
      const listing = libListings.find((x) => x.id === l.listing_id);
      return listing ? { ...listing, downloadedVersion: l.version, downloaded_at: l.downloaded_at, updateAvailable: listing.version !== l.version } : null;
    }).filter(Boolean);
    let feed = [];
    if (follows.length) {
      const { data } = await c.from('listings')
        .select('*, creator:profiles!listings_creator_id_fkey(id,username,display_name,avatar_url,accent_color,role)')
        .in('creator_id', follows).eq('status', 'published').order('created_at', { ascending: false }).limit(24);
      feed = (data || []).map((l) => this.decorate(l));
    }
    return { favorites, library, feed };
  }

  /** Listings I published (including hidden ones) for the creator dashboard. */
  async myListings() {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) return [];
    const data = check(await c.from('listings').select('*').eq('creator_id', me.id).order('created_at', { ascending: false }));
    return data.map((l) => this.decorate(l));
  }

  /**
   * Publishes (or updates) a project's exported zip on the marketplace.
   * files: { zipPath, thumbnailPath?, screenshotPaths[] } (absolute, checked by caller)
   */
  async publishListing(project, files, onProgress = () => {}) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Please log in.');
    if (!me.profile || !['creator', 'both'].includes(me.profile.role)) {
      throw new Error('Only creator accounts can publish. Switch your account to "Creator" or "Both" in your profile.');
    }
    const d = project.details;
    const pkg = slugify(files.pkg, 120) || slugify(project.name);
    const base = `${me.id}/${pkg}`;
    const version = d.version || '1.0.0';
    const steps = 1 + (files.thumbnailPath ? 1 : 0) + files.screenshotPaths.length;
    let done = 0;
    onProgress(done, steps, 'Uploading package...');

    const zipKey = `${base}/${path.basename(files.zipPath)}`;
    check(await c.storage.from(MARKET_BUCKET).upload(zipKey, fs.readFileSync(files.zipPath), { contentType: 'application/zip', upsert: true }));
    onProgress(++done, steps, 'Uploading images...');

    let thumbKey = '';
    if (files.thumbnailPath) {
      thumbKey = `${base}/thumbnail.jpg`;
      check(await c.storage.from(MARKET_BUCKET).upload(thumbKey, fs.readFileSync(files.thumbnailPath), { contentType: 'image/jpeg', upsert: true }));
      onProgress(++done, steps, 'Uploading images...');
    }
    const shotKeys = [];
    for (let i = 0; i < files.screenshotPaths.length; i++) {
      const key = `${base}/screenshot-${String(i + 1).padStart(2, '0')}.jpg`;
      check(await c.storage.from(MARKET_BUCKET).upload(key, fs.readFileSync(files.screenshotPaths[i]), { contentType: 'image/jpeg', upsert: true }));
      shotKeys.push(key);
      onProgress(++done, steps, 'Uploading images...');
    }
    if (!thumbKey && shotKeys[0]) thumbKey = shotKeys[0];

    const row = {
      creator_id: me.id,
      project_id: project.id,
      package_name: pkg,
      title: (d.title || project.name).slice(0, 120),
      aircraft: project.aircraft.title || '',
      aircraft_folder: project.aircraft.folder || '',
      short_description: (d.shortDescription || '').slice(0, 300),
      description: d.description || '',
      changelog: d.changelog || '',
      license: d.license || '',
      registration: d.atcId || '',
      version,
      tags: (d.tags || []).slice(0, 20),
      modular: !!project.aircraft.modular,
      file_path: zipKey,
      file_size: fs.statSync(files.zipPath).size,
      thumbnail_path: thumbKey,
      screenshots: shotKeys,
      status: 'published',
    };
    const saved = check(await c.from('listings').upsert(row, { onConflict: 'creator_id,package_name' }).select().single());
    return this.decorate(saved);
  }

  async setListingStatus(id, status) {
    const c = this.requireClient();
    if (!['published', 'hidden'].includes(status)) throw new Error('Invalid status.');
    return this.decorate(check(await c.from('listings').update({ status }).eq('id', id).select().single()));
  }

  async deleteListing(id) {
    const c = this.requireClient();
    const me = await this.currentUser();
    const l = check(await c.from('listings').select('*').eq('id', id).eq('creator_id', me.id).single());
    const keys = [l.file_path, l.thumbnail_path, ...(l.screenshots || [])].filter((k) => k && k.startsWith(me.id + '/'));
    if (keys.length) await c.storage.from(MARKET_BUCKET).remove([...new Set(keys)]);
    check(await c.from('listings').delete().eq('id', id));
    return true;
  }

  /**
   * Downloads a listing's zip and unpacks it to
   *   Documents\Livery Forge\Downloads\<listing id>\
   * Returns { folder, packageDir, pkg }.
   */
  async downloadListing(id, onProgress = () => {}) {
    const c = this.requireClient();
    const me = await this.currentUser();
    if (!me) throw new Error('Log in to download from the marketplace.');
    const listing = this.decorate(check(await c.from('listings').select('*').eq('id', id).single()));
    // Count the download (once per user) and add it to my library.
    check(await c.rpc('record_download', { p_listing: id }));

    const folder = path.join(this.downloadsRoot, id);
    const zipFile = path.join(this.downloadsRoot, `${id}.zip`);
    fs.mkdirSync(this.downloadsRoot, { recursive: true });
    const res = await fetch(listing.file_url);
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || listing.file_size || 0;
    let received = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => { received += chunk.length; onProgress(received, total); });
    await pipeline(body, fs.createWriteStream(zipFile));

    fs.rmSync(folder, { recursive: true, force: true });
    await extractZipSafe(zipFile, folder);
    fs.rmSync(zipFile, { force: true });

    // Find the package folder (the one with manifest.json).
    const packageDir = findPackageDir(folder);
    if (!packageDir) throw new Error('The downloaded zip does not contain an MSFS package (no manifest.json).');
    const meta = { id, title: listing.title, version: listing.version, pkg: path.basename(packageDir), packageDir, downloadedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(folder, 'liveryforge-download.json'), JSON.stringify(meta, null, 2));
    return meta;
  }
}

/** Unzips with zip-slip protection (extract-zip already blocks ../ paths). */
async function extractZipSafe(zipFile, folder) {
  const extract = require('extract-zip');
  fs.mkdirSync(folder, { recursive: true });
  await extract(zipFile, {
    dir: path.resolve(folder),
    onEntry: (entry) => {
      const target = path.resolve(folder, entry.fileName);
      if (!isInside(folder, target)) throw new Error('Unsafe file path inside zip.');
    },
  });
}

/** Finds the first folder (max 2 deep) that contains manifest.json. */
function findPackageDir(root) {
  if (fs.existsSync(path.join(root, 'manifest.json'))) return root;
  for (const a of fs.readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    const p = path.join(root, a.name);
    if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
    for (const b of fs.readdirSync(p, { withFileTypes: true })) {
      if (b.isDirectory() && fs.existsSync(path.join(p, b.name, 'manifest.json'))) return path.join(p, b.name);
    }
  }
  return null;
}

/** Lists liveries downloaded on this computer. */
function listLocalDownloads(downloadsRoot) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(downloadsRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(downloadsRoot, e.name, 'liveryforge-download.json'), 'utf8'));
      if (meta.packageDir && isInside(downloadsRoot, meta.packageDir)) out.push(meta);
    } catch { /* not ours */ }
  }
  return out;
}

function contentTypeFor(rel) {
  const r = rel.toLowerCase();
  if (r.endsWith('.png')) return 'image/png';
  if (r.endsWith('.jpg') || r.endsWith('.jpeg')) return 'image/jpeg';
  if (r.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

module.exports = { Cloud, friendly, fileStorage, findPackageDir, listLocalDownloads, extractZipSafe, ROLES, USERNAME_RE };
