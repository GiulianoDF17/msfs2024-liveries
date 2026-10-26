/**
 * Integration test for lib/cloud.js against a real Supabase server.
 * Skipped unless LF_TEST_SUPABASE_URL and LF_TEST_SUPABASE_KEY are set, e.g.
 * with a local server from `npx supabase start` + supabase/schema.sql applied.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Cloud, findPackageDir } = require('../lib/cloud');
const { ProjectStore } = require('../lib/projects');
const packager = require('../lib/packager');
const { tmpDir } = require('./helpers');

const URL_ = process.env.LF_TEST_SUPABASE_URL;
const KEY = process.env.LF_TEST_SUPABASE_KEY;
const skip = !URL_ || !KEY ? 'set LF_TEST_SUPABASE_URL / LF_TEST_SUPABASE_KEY to run' : false;

function machine() {
  // A "computer": its own Documents folder + session file.
  const root = tmpDir('lf-cloud-');
  const store = new ProjectStore(path.join(root, 'Projects'));
  const cloud = new Cloud({ url: URL_, anonKey: KEY, sessionFile: path.join(root, 'session.json'), store, downloadsRoot: path.join(root, 'Downloads') });
  return { root, store, cloud };
}

const rnd = Math.random().toString(36).slice(2, 8);

test('accounts, sync, marketplace end to end', { skip }, async () => {
  // ---- Creator signs up on computer A
  const A = machine();
  assert.strictEqual(await A.cloud.usernameAvailable(`maker_${rnd}`), true);
  const su = await A.cloud.signUp({ email: `maker_${rnd}@example.com`, password: 'password123', username: `maker_${rnd}`, displayName: 'Maker', role: 'creator' });
  assert.strictEqual(su.needsConfirmation, false);
  assert.strictEqual(su.user.profile.role, 'creator');
  assert.strictEqual(su.user.profile.username, `maker_${rnd}`);
  assert.strictEqual(await A.cloud.usernameAvailable(`maker_${rnd}`), false);
  await assert.rejects(A.cloud.signUp({ email: `x_${rnd}@example.com`, password: 'password123', username: `maker_${rnd}`, role: 'user' }), /taken/);

  // ---- Creates a project with a layer and syncs it
  const p = A.store.create({ name: 'Cloud Livery', aircraft: { folder: 'Asobo_C172', title: 'Cessna 172' }, author: 'Maker' });
  p.textures.push({ id: 'tex1', name: 'C172_FUSELAGE_ALBD', type: 'albedo', width: 1, height: 1, layers: [{ id: 'l1', name: 'Base' }] });
  A.store.writeFile(p.id, 'layers/tex1/l1.png', Buffer.from('layer-bytes'));
  A.store.writeFile(p.id, 'textures/C172_FUSELAGE_ALBD.PNG', Buffer.from('flat-bytes'));
  A.store.writeFile(p.id, 'build/huge.bin', Buffer.alloc(1000)); // never synced
  A.store.save(p);
  const push = await A.cloud.pushProject(p.id);
  assert.strictEqual(push.uploaded, 3); // project.json, layer, texture
  const push2 = await A.cloud.pushProject(p.id);
  assert.strictEqual(push2.uploaded, 0); // nothing changed
  const list = await A.cloud.listCloudProjects();
  assert.strictEqual(list.length, 1);

  // ---- Same user on a fresh computer B (app reinstalled): projects come back
  const B = machine();
  assert.strictEqual(await B.cloud.currentUser(), null);
  await B.cloud.signIn({ email: `maker_${rnd}@example.com`, password: 'password123' });
  const rep = await B.cloud.syncAll();
  assert.strictEqual(rep.pulled, 1, JSON.stringify(rep));
  const back = B.store.load(p.id);
  assert.strictEqual(back.name, 'Cloud Livery');
  assert.strictEqual(B.store.readFile(p.id, 'layers/tex1/l1.png').toString(), 'layer-bytes');
  assert.ok(!fs.existsSync(path.join(B.store.dir(p.id), 'build')));

  // Edit on B, sync, comes back to A
  back.details.atcId = 'N-CLOUD';
  B.store.deleteFile(p.id, 'textures/C172_FUSELAGE_ALBD.PNG');
  await new Promise((r) => setTimeout(r, 1100));
  B.store.save(back);
  const repB = await B.cloud.syncAll();
  assert.strictEqual(repB.pushed, 1);
  const repA = await A.cloud.syncAll();
  assert.strictEqual(repA.pulled, 1);
  assert.strictEqual(A.store.load(p.id).details.atcId, 'N-CLOUD');
  assert.ok(!fs.existsSync(path.join(A.store.dir(p.id), 'textures', 'C172_FUSELAGE_ALBD.PNG')));

  // ---- Wrong password
  const C = machine();
  await assert.rejects(C.cloud.signIn({ email: `maker_${rnd}@example.com`, password: 'nope-nope' }), /Wrong email or password/);

  // ---- Creator publishes to the marketplace
  const pkgDir = path.join(A.root, 'pkg', 'maker-c172-cloud-livery');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(pkgDir, 'layout.json'), '{}');
  const zip = await packager.zipFolder(pkgDir, path.join(A.root, 'Output', 'maker-c172-cloud-livery_v1.0.0.zip'), 'maker-c172-cloud-livery');
  const shot = path.join(A.root, 'shot.jpg');
  fs.writeFileSync(shot, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const proj = A.store.load(p.id);
  proj.details.description = 'A nice livery for testing.';
  proj.details.tags = ['test'];
  const listing = await A.cloud.publishListing(proj, { zipPath: zip.path, pkg: 'maker-c172-cloud-livery', thumbnailPath: shot, screenshotPaths: [shot] });
  assert.strictEqual(listing.title, 'Cloud Livery');
  assert.strictEqual(listing.downloads, 0);
  assert.match(listing.thumbnail_url, /storage\/v1\/object\/public\/marketplace\//);

  // Creator can't fake downloads
  const c = A.cloud.client;
  await c.from('listings').update({ downloads: 9999, title: 'Cloud Livery v2' }).eq('id', listing.id);
  const after = (await A.cloud.getListing(listing.id)).listing;
  assert.strictEqual(after.downloads, 0);
  assert.strictEqual(after.title, 'Cloud Livery v2');

  // Creator can't review own listing
  await assert.rejects(A.cloud.submitReview(listing.id, 5, 'mine!'));

  // ---- A plain user signs up, can't publish, but can download, rate, favorite, follow
  const U = machine();
  await U.cloud.signUp({ email: `flyer_${rnd}@example.com`, password: 'password123', username: `flyer_${rnd}`, role: 'user' });
  await assert.rejects(U.cloud.publishListing(proj, { zipPath: zip.path, pkg: 'x-y-z', screenshotPaths: [] }), /Only creator accounts/);
  const browse = await U.cloud.listListings({ search: 'Cloud Livery' });
  assert.ok(browse.items.some((l) => l.id === listing.id));
  assert.strictEqual(browse.items.find((l) => l.id === listing.id).creator.username, `maker_${rnd}`);

  const dl = await U.cloud.downloadListing(listing.id);
  assert.ok(fs.existsSync(path.join(dl.packageDir, 'manifest.json')));
  assert.strictEqual(dl.pkg, 'maker-c172-cloud-livery');
  await U.cloud.downloadListing(listing.id); // second download doesn't count twice
  assert.strictEqual((await U.cloud.getListing(listing.id)).listing.downloads, 1);

  await U.cloud.submitReview(listing.id, 4, 'Great!');
  await U.cloud.submitReview(listing.id, 5, 'Even better after update');
  assert.strictEqual(await U.cloud.toggleFavorite(listing.id), true);
  assert.strictEqual(await U.cloud.toggleFollow(listing.creator_id), true);
  const detail = await U.cloud.getListing(listing.id);
  assert.strictEqual(Number(detail.listing.rating_avg), 5);
  assert.strictEqual(detail.listing.rating_count, 1);
  assert.strictEqual(detail.listing.favorites_count, 1);
  assert.strictEqual(detail.favorite, true);
  assert.strictEqual(detail.following, true);
  assert.ok(detail.inLibrary);

  const hangar = await U.cloud.myHangar();
  assert.strictEqual(hangar.favorites.length, 1);
  assert.strictEqual(hangar.library.length, 1);
  assert.strictEqual(hangar.feed.length, 1);

  const creator = await U.cloud.getCreator(`maker_${rnd}`);
  assert.strictEqual(Number(creator.stats.followers), 1);
  assert.strictEqual(Number(creator.stats.downloads), 1);
  assert.strictEqual(creator.listings.length, 1);

  // User can't see the creator's private projects
  const { data: spy } = await U.cloud.client.from('cloud_projects').select('*');
  assert.strictEqual(spy.length, 0);
  const { error: spyErr } = await U.cloud.client.storage.from('project-files').download(`${listing.creator_id}/${p.id}/project.json`);
  assert.ok(spyErr);

  // Upgrade to "both" then publishing would be allowed
  const prof = await U.cloud.updateProfile({ role: 'both', bio: 'I fly and paint' });
  assert.strictEqual(prof.role, 'both');

  // Hide + delete listing
  await A.cloud.setListingStatus(listing.id, 'hidden');
  assert.ok(!(await U.cloud.listListings({ search: 'Cloud Livery' })).items.some((l) => l.id === listing.id));
  await A.cloud.deleteListing(listing.id);
  assert.strictEqual((await A.cloud.myListings()).length, 0);

  // Delete cloud project
  assert.strictEqual(await A.cloud.deleteCloudProject(p.id), true);
  assert.strictEqual((await A.cloud.listCloudProjects()).length, 0);

  await A.cloud.signOut();
  assert.strictEqual(await A.cloud.currentUser(), null);
});

test('findPackageDir', () => {
  const r = tmpDir();
  fs.mkdirSync(path.join(r, 'a', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(r, 'a', 'pkg', 'manifest.json'), '{}');
  assert.strictEqual(findPackageDir(r), path.join(r, 'a', 'pkg'));
});
