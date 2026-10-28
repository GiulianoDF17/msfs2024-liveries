/**
 * preload.js
 * ----------
 * The ONLY bridge between the web page (UI) and the computer.
 * The page gets a `window.lf` object with a fixed list of functions; each one
 * sends a message to main.js with ipcRenderer.invoke. The page itself can
 * never touch files or Node.js directly.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Calls main.js and turns { error } replies into thrown errors. */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.error) throw new Error(r.error);
  return r ? r.result : undefined;
}

/** Subscribes to an event from main.js. Returns an "unsubscribe" function. */
function on(channel, cb) {
  const allowed = ['export:log', 'progress', 'cloud:sync'];
  if (!allowed.includes(channel)) throw new Error('Unknown event ' + channel);
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('lf', {
  on,
  app: {
    info: () => call('app:info'),
  },
  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
    detect: () => call('settings:detect'),
    checkSdk: (p) => call('settings:checkSdk', p),
  },
  dialog: {
    pickFolder: (title) => call('dialog:pickFolder', title),
    pickFiles: (opts) => call('dialog:pickFiles', opts),
    confirm: (opts) => call('dialog:confirm', opts),
  },
  aircraft: {
    scan: () => call('aircraft:scan'),
    textures: (id) => call('aircraft:textures', id),
    texturesForProject: (projectId) => call('aircraft:texturesForProject', projectId),
  },
  projects: {
    list: () => call('projects:list'),
    create: (o) => call('projects:create', o),
    load: (id) => call('projects:load', id),
    save: (p) => call('projects:save', p),
    remove: (id) => call('projects:delete', id),
    writeFile: (id, rel, bytes) => call('projects:writeFile', id, rel, bytes),
    deleteFile: (id, rel) => call('projects:deleteFile', id, rel),
    importFile: (id, src) => call('projects:importFile', id, src),
    clearImports: (id) => call('projects:clearImports', id),
    addScreenshots: (id, paths) => call('projects:addScreenshots', id, paths),
    removeScreenshot: (id, rel) => call('projects:removeScreenshot', id, rel),
    setThumbnail: (id, o) => call('projects:setThumbnail', id, o),
  },
  exporter: {
    preflight: (id) => call('export:preflight', id),
    run: (id, mode) => call('export:run', id, mode),
    removeFromCommunity: (id) => call('export:removeFromCommunity', id),
    status: (id) => call('export:status', id),
  },
  shell: {
    openFolder: (p) => call('shell:openFolder', p),
    showItem: (p) => call('shell:showItem', p),
    openProjectFolder: (id) => call('shell:openProjectFolder', id),
    openExternal: (url) => call('shell:openExternal', url),
    copy: (text) => call('clipboard:write', text),
  },
  publish: {
    validate: (id) => call('publish:validate', id),
    prepare: (id) => call('publish:prepare', id),
    description: (id) => call('publish:description', id),
    markSubmitted: (id, v) => call('publish:markSubmitted', id, v),
    queue: () => call('publish:queue'),
    prepareAll: () => call('publish:prepareAll'),
  },
  cloud: {
    status: () => call('cloud:status'),
    signUp: (f) => call('cloud:signUp', f),
    signIn: (f) => call('cloud:signIn', f),
    signOut: () => call('cloud:signOut'),
    sendReset: (email) => call('cloud:sendReset', email),
    resetWithCode: (f) => call('cloud:resetWithCode', f),
    usernameAvailable: (n) => call('cloud:usernameAvailable', n),
    updateProfile: (p) => call('cloud:updateProfile', p),
    uploadAvatar: (src) => call('cloud:uploadAvatar', src),
    syncAll: () => call('cloud:syncAll'),
    claimLocal: () => call('cloud:claimLocal'),
  },
  market: {
    list: (o) => call('market:list', o),
    get: (id) => call('market:get', id),
    creator: (idOrName) => call('market:creator', idOrName),
    favorite: (id) => call('market:favorite', id),
    follow: (id) => call('market:follow', id),
    review: (o) => call('market:review', o),
    hangar: () => call('market:hangar'),
    mine: () => call('market:mine'),
    setStatus: (o) => call('market:setStatus', o),
    remove: (id) => call('market:delete', id),
    publish: (projectId) => call('market:publish', projectId),
    download: (o) => call('market:download', o),
    localDownloads: () => call('market:localDownloads'),
    install: (id) => call('market:install', id),
    uninstall: (id) => call('market:uninstall', id),
    removeDownload: (id) => call('market:removeDownload', id),
  },
});
