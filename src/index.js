// dsh-deep-purge — host half.
//
// Permanently deletes ONE session end-to-end. There is no undo:
//   1. refuse while an agent is actively running the session;
//   2. READ the session's attachment references first (the log is about to go);
//   3. remove the persisted log dir  <DSH_HOME>/sessions/<slug>/<id>/  for both
//      id spellings, then drop the now-empty <slug> dir;
//   4. drop the projection-cache rows (storageDomain 'session_projcache');
//   5. remove the workspace accounting (domain 'workspace': sessionIds arrays
//      and global.archivedSessionIds);
//   6. attachment sweep: every attachment this session referenced is deleted
//      UNLESS some other surviving session also references it (content-addressed
//      objects are shared; deleting a shared one would break the other session).
//      The other sessions are read through the runtime's own persistence read
//      handle, so multi-frame zstd logs are decoded correctly. If ANY other
//      session cannot be read, the attachment sweep is skipped entirely rather
//      than risking a shared object.
//   7. optional: clear the request-image cache (transcoded derivatives of the
//      images sent to the model). It is a pure cache and cannot be attributed
//      per object, so it is cleared wholesale when asked.
//
// Routes (registered only when the profile has a web surface):
//   GET  /__deep-purge/info    - DSH home, sessions root, attachment stats
//   POST /__deep-purge/delete  - { sessionId, confirm, attachments?, requestImages? }

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'deep-purge'
export const inject = []

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ATTACHMENT_ID_RE = /^(?:sha256:)?([0-9a-f]{64})$/i

class PurgeError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

function attachmentsRoot() {
  return path.join(dshHome(), 'attachments', 'v1')
}

function requestImageCacheRoot() {
  return path.join(dshHome(), 'cache', 'attachments', 'request-images')
}

function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else if (SESSION_ID_RE.test(sessionId)) variants.add('session-' + sessionId)
  return [...variants]
}

function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, entry.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* keep scanning */ }
    }
  }
  return found
}

function removeSessionDirs(sessionId) {
  const removed = []
  for (const dir of findSessionDirs(sessionId)) {
    fs.rmSync(dir, { recursive: true, force: true })
    removed.push(dir)
    try {
      const parent = path.dirname(dir)
      if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
    } catch { /* best effort */ }
  }
  return removed
}

/** Every surviving session id on disk, minus the one being purged. */
function otherSessionIds(sessionId) {
  const variants = new Set(sessionIdVariants(sessionId))
  const out = []
  let slugs = []
  try {
    slugs = fs.readdirSync(sessionsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return out
  }
  for (const slug of slugs) {
    let entries = []
    try {
      entries = fs.readdirSync(path.join(sessionsRoot(), slug.name), { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!SESSION_ID_RE.test(entry.name)) continue
      if (variants.has(entry.name)) continue
      out.push(entry.name)
    }
  }
  return out
}

/**
 * Deep-walk one event list collecting every attachmentId that looks like a
 * content hash. Deliberately over-collects: a false positive only keeps an
 * object alive, while a miss would delete something still referenced.
 */
function collectAttachmentIds(events) {
  const ids = new Set()
  const visit = (node, depth) => {
    if (depth > 40 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'attachmentId' && typeof value === 'string') {
        const match = ATTACHMENT_ID_RE.exec(value.trim())
        if (match) ids.add(match[1].toLowerCase())
        continue
      }
      visit(value, depth + 1)
    }
  }
  visit(events, 0)
  return ids
}

/**
 * Read one session's events through the runtime's persistence read handle.
 * @returns {{ ok: boolean, ids: Set<string>, reason?: string, eventCount?: number }}
 */
async function readSessionAttachmentIds(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.open !== 'function') {
    return { ok: false, ids: new Set(), reason: 'sessionPersistence service unavailable' }
  }
  let handle
  try {
    handle = await persistence.open(sessionId, 'read', {})
  } catch (error) {
    return { ok: false, ids: new Set(), reason: 'open failed: ' + (error && error.message ? error.message : String(error)) }
  }
  try {
    const { events } = await handle.read(0, undefined, {})
    const ids = collectAttachmentIds(events)
    return { ok: true, ids, eventCount: Array.isArray(events) ? events.length : 0 }
  } catch (error) {
    return { ok: false, ids: new Set(), reason: 'read failed: ' + (error && error.message ? error.message : String(error)) }
  } finally {
    try { await handle.close() } catch { /* best effort */ }
  }
}

/** Delete one content-addressed object, guarded so the path can never escape the store. */
function deleteAttachmentObject(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex)) return 0
  const objects = path.join(attachmentsRoot(), 'objects')
  const file = path.join(objects, hex.slice(0, 2), hex)
  const resolved = path.resolve(file)
  if (!resolved.startsWith(path.resolve(objects) + path.sep)) return 0
  try {
    const size = fs.statSync(resolved).size
    fs.rmSync(resolved, { force: true })
    try {
      const shard = path.dirname(resolved)
      if (fs.readdirSync(shard).length === 0) fs.rmdirSync(shard)
    } catch { /* best effort */ }
    return size
  } catch {
    return 0
  }
}

function directoryStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (current) => {
    let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try { bytes += fs.statSync(full).size; files += 1 } catch { /* raced away */ }
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/**
 * Reference-counted attachment sweep.
 * @param ctx - host context.
 * @param targetIds - attachment hashes referenced by the session being purged.
 * @param sessionId - the purged session (excluded from the survivor scan).
 */
async function sweepAttachments(ctx, targetIds, sessionId) {
  if (targetIds.size === 0) {
    return { deleted: 0, keptShared: 0, bytes: 0, scanned: 0, skipped: false, reason: null }
  }
  const survivors = otherSessionIds(sessionId)
  const referencedElsewhere = new Set()
  let scanned = 0
  const failures = []
  for (const id of survivors) {
    const result = await readSessionAttachmentIds(ctx, id)
    if (result.ok) {
      scanned += 1
      for (const value of result.ids) referencedElsewhere.add(value)
    } else {
      failures.push(id + ': ' + (result.reason || 'unknown'))
    }
  }
  if (failures.length > 0) {
    // Fail safe: an unreadable survivor might reference anything we would delete.
    return {
      deleted: 0,
      keptShared: 0,
      bytes: 0,
      scanned,
      skipped: true,
      reason: 'skipped: ' + failures.length + ' other session(s) could not be read (' + failures.slice(0, 3).join('; ') + ')',
      candidates: targetIds.size,
    }
  }
  let deleted = 0
  let bytes = 0
  let keptShared = 0
  for (const hex of targetIds) {
    if (referencedElsewhere.has(hex)) { keptShared += 1; continue }
    const size = deleteAttachmentObject(hex)
    if (size > 0) { deleted += 1; bytes += size }
  }
  return { deleted, keptShared, bytes, scanned, skipped: false, reason: null, candidates: targetIds.size }
}

function clearRequestImageCache() {
  const dir = requestImageCacheRoot()
  const stats = directoryStats(dir)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  return stats
}

async function stripStorageDomains(ctx, sessionId) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch { /* unit closed or table absent */ }
  }

  const ws = sd.get('workspace')
  if (ws && typeof ws.table === 'function') {
    try {
      const workspaces = ws.table('workspaces')
      for (const [wid, rec] of workspaces.entries()) {
        if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
          await workspaces.put(wid, { ...rec, sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)) })
          workspaceRemoved = true
        }
      }
    } catch { /* unit closed or table absent */ }
    try {
      const g = ws.global
      if (g && typeof g.get === 'function' && typeof g.set === 'function') {
        const state = g.get()
        if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
          await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
          workspaceRemoved = true
        }
      }
    } catch { /* no global slot */ }
  }

  return { projRemoved, workspaceRemoved }
}

function assertNotRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== undefined && agent.status !== 'idle') {
    throw new PurgeError('这个会话正在运行，请等它结束后再删除', 409)
  }
}

async function purgeSession(ctx, sessionId, options) {
  if (!SESSION_ID_RE.test(sessionId)) throw new PurgeError('invalid session id: ' + sessionId, 400)
  assertNotRunning(ctx, sessionId)

  // Read the attachment references BEFORE the log disappears.
  let targetAttachments = new Set()
  let attachmentRead = { ok: false, reason: 'attachments disabled' }
  if (options.attachments) {
    attachmentRead = await readSessionAttachmentIds(ctx, sessionId)
    if (attachmentRead.ok) targetAttachments = attachmentRead.ids
  }

  const dirs = removeSessionDirs(sessionId)
  const storage = await stripStorageDomains(ctx, sessionId)

  let attachments = { deleted: 0, keptShared: 0, bytes: 0, scanned: 0, skipped: true, reason: 'attachments disabled' }
  if (options.attachments) {
    if (attachmentRead.ok) {
      attachments = await sweepAttachments(ctx, targetAttachments, sessionId)
    } else {
      attachments = { deleted: 0, keptShared: 0, bytes: 0, scanned: 0, skipped: true, reason: 'session log unreadable: ' + (attachmentRead.reason || 'unknown') }
    }
  }

  let requestImages = null
  if (options.requestImages) requestImages = clearRequestImageCache()

  return {
    sessionId,
    dirsRemoved: dirs,
    logRemoved: dirs.length > 0,
    ...storage,
    attachments: {
      referenced: targetAttachments.size,
      ...attachments,
    },
    requestImages,
    remaining: findSessionDirs(sessionId),
  }
}

// --- http helpers -------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

export function apply(ctx) {
  function registerHttp(host, target) {
    target.effect(() => host.register({
      kind: 'exact',
      path: '/__deep-purge/info',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        let slugs = []
        try {
          slugs = fs.readdirSync(sessionsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        } catch { /* no sessions dir yet */ }
        return sendJson(res, 200, {
          ok: true,
          dshHome: dshHome(),
          sessionsRoot: sessionsRoot(),
          attachments: directoryStats(path.join(attachmentsRoot(), 'objects')),
          requestImageCache: directoryStats(requestImageCacheRoot()),
          slugs,
        })
      },
    }))

    target.effect(() => host.register({
      kind: 'exact',
      path: '/__deep-purge/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          return sendJson(res, 400, { error: 'bad json body' })
        }
        const sessionId = String(args.sessionId || '').trim()
        const confirm = String(args.confirm || '').trim()
        if (!sessionId) return sendJson(res, 400, { error: 'sessionId required' })
        if (confirm !== sessionId) return sendJson(res, 400, { error: 'confirm must equal sessionId' })
        try {
          const result = await purgeSession(ctx, sessionId, {
            attachments: args.attachments !== false,
            requestImages: args.requestImages === true,
          })
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          const status = error instanceof PurgeError && error.status ? error.status : 500
          return sendJson(res, status, { error: error.message })
        }
      },
    }))
  }

  const ws = ctx.get('webServer')
  if (ws !== undefined) registerHttp(ws, ctx)
  else ctx.inject(['webServer'], (sub) => registerHttp(sub.webServer, sub))
}
