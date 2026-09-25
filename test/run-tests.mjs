// dsh-deep-purge — 离线集成测试（夹具已用真实 id 变体）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as plugin from '../src/index.js'

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log('  ' + (ok ? '[PASS]' : '[FAIL]') + ' ' + label + (detail ? '   ' + detail : ''))
}
const sha = (seed) => crypto.createHash('sha256').update(seed).digest('hex')

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-test-'))
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(home, 'attachments', 'v1', 'objects'), { recursive: true })
  fs.mkdirSync(path.join(home, 'cache', 'attachments', 'request-images'), { recursive: true })
  return home
}
function addSession(home, slug, id) {
  const dir = path.join(home, 'sessions', slug, 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('fake-' + id))
  return dir
}
function addAttachment(home, hex, bytes) {
  const shard = path.join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2))
  fs.mkdirSync(shard, { recursive: true })
  fs.writeFileSync(path.join(shard, hex), Buffer.alloc(bytes, 7))
}
function addRequestImage(home, hex, bytes) {
  const shard = path.join(home, 'cache', 'attachments', 'request-images', hex.slice(0, 2))
  fs.mkdirSync(shard, { recursive: true })
  fs.writeFileSync(path.join(shard, hex), Buffer.alloc(bytes, 9))
}
function eventsWith(ids) {
  return [
    { seq: 1, type: 'user/message', data: { message: { content: ids.map((id) => ({ type: 'image', attachment: { attachmentId: 'sha256:' + id, mediaType: 'image/png' } })) } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
  ]
}

const CLIENT_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const SURVIVOR_ID = 'bbbbbbbb-1111-2222-3333-444444444444'
const A = 'session-' + CLIENT_ID
const B = 'session-' + SURVIVOR_ID

function makeCtx({ agents = new Map(), persistenceOverrides = {}, routeSink }) {
  const tables = {
    session_projcache: { sessions: new Map([[A, { v: 1 }], [B, { v: 1 }]]) },
    workspace: {
      workspaces: new Map([['w1', { path: 'C:/somewhere', title: 't', sessionIds: [A, B], createdAt: 1, updatedAt: 1 }]]),
      global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [A] },
    },
  }
  const storageDomain = {
    get(name) {
      const unit = tables[name]
      if (!unit) return undefined
      return {
        table(tableName) {
          const map = unit[tableName]
          if (!map) return undefined
          return {
            get: (k) => map.get(k),
            put: async (k, v) => { map.set(k, v) },
            delete: async (k) => { map.delete(k) },
            entries: () => [...map.entries()],
          }
        },
        global: unit.global ? { get: () => unit.global, set: async (v) => { Object.assign(unit.global, v) } } : undefined,
      }
    },
  }
  const persistence = {
    async open(id) {
      const events = persistenceOverrides[id]
      if (events === 'throw') throw new Error('simulated unreadable log')
      if (events === undefined) { const e = new Error('not found'); e.name = 'SessionPersistenceNotFoundError'; throw e }
      return { header: { id, version: 4 }, async read() { return { events } }, async close() {} }
    },
  }
  const webServer = { register(route) { routeSink.push(route); return () => {} } }
  return {
    tables,
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'sessionPersistence') return persistence
      if (name === 'storageDomain') return storageDomain
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(fn) { return fn() },
    inject(_names, cb) { cb(this) },
  }
}

function post(route, payload) {
  return new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b ? JSON.parse(b) : null; resolve(this) } }
    route.handler(req, res)
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(payload))); req.emit('end') })
  })
}

const home = makeHome()
process.env.DSH_HOME = home
const SHARED = sha('shared-image')
const UNIQUE = sha('unique-image')
addSession(home, '--C-test--', CLIENT_ID)
addSession(home, '--C-test--', SURVIVOR_ID)
addAttachment(home, SHARED, 1000)
addAttachment(home, UNIQUE, 2000)
addRequestImage(home, sha('req-1'), 500)

console.log('=== 场景 1：A 引用 shared+unique，B 也引用 shared ===')
{
  const routes = []
  const ctx = makeCtx({ persistenceOverrides: { [A]: eventsWith([SHARED, UNIQUE]), [B]: eventsWith([SHARED]) }, routeSink: routes })
  plugin.apply(ctx)
  const res = await post(routes.find((r) => r.path === '/__deep-purge/delete'), { sessionId: A, confirm: A, requestImages: true })
  const body = res.body
  check('HTTP 200', res.status === 200)
  check('日志目录已删', body.dirsRemoved.length === 1 && !fs.existsSync(home + '/sessions/--C-test--/' + A))
  check('无残留', body.remaining.length === 0)
  check('投影缓存已清（A 的行没了）', body.projRemoved === true && ctx.tables.session_projcache.sessions.has(A) === false)
  check('B 的投影缓存仍在', ctx.tables.session_projcache.sessions.has(B) === true)
  check('工作区记账已清', body.workspaceRemoved === true)
  check('sessionIds 里已移除 A', !ctx.tables.workspace.workspaces.get('w1').sessionIds.includes(A))
  check('sessionIds 里保留 B', ctx.tables.workspace.workspaces.get('w1').sessionIds.includes(B))
  check('归档列表里已移除 A', !ctx.tables.workspace.global.archivedSessionIds.includes(A))
  check('引用附件数=2', body.attachments.referenced === 2)
  check('共享附件保留数=1', body.attachments.keptShared === 1)
  check('共享附件文件仍在', fs.existsSync(home + '/attachments/v1/objects/' + SHARED.slice(0, 2) + '/' + SHARED))
  check('独占附件已删', !fs.existsSync(home + '/attachments/v1/objects/' + UNIQUE.slice(0, 2) + '/' + UNIQUE))
  check('释放字节=2000', body.attachments.bytes === 2000, String(body.attachments.bytes))
  check('请求图片缓存已清空', !fs.existsSync(home + '/cache/attachments/request-images/' + sha('req-1').slice(0, 2)))
}

console.log('')
console.log('=== 场景 2：fail-safe —— 幸存会话读不出来时整体跳过附件回收 ===')
{
  const C = 'cccccccc-1111-2222-3333-444444444444'
  addSession(home, '--C-test2--', C)
  const unique2 = sha('unique-2')
  addAttachment(home, unique2, 3000)
  const routes = []
  const ctx = makeCtx({ persistenceOverrides: { ['session-' + C]: eventsWith([unique2]), [B]: 'throw' }, routeSink: routes })
  plugin.apply(ctx)
  const res = await post(routes.find((r) => r.path === '/__deep-purge/delete'), { sessionId: 'session-' + C, confirm: 'session-' + C })
  check('HTTP 200', res.status === 200)
  check('附件回收被跳过', res.body.attachments.skipped === true, res.body.attachments.reason)
  check('独占附件因跳过而保留', fs.existsSync(home + '/attachments/v1/objects/' + unique2.slice(0, 2) + '/' + unique2))
  check('日志目录仍被删', res.body.dirsRemoved.length === 1)
}

console.log('')
console.log('=== 场景 3：运行中的会话必须被拒 ===')
{
  const routes = []
  const agents = new Map([[B, { status: 'working' }]])
  const ctx = makeCtx({ agents, persistenceOverrides: { [B]: eventsWith([SHARED]) }, routeSink: routes })
  plugin.apply(ctx)
  const res = await post(routes.find((r) => r.path === '/__deep-purge/delete'), { sessionId: B, confirm: B })
  check('HTTP 409', res.status === 409, res.body && res.body.error)
  check('目录未被动', fs.existsSync(home + '/sessions/--C-test--/' + B))
}

console.log('')
console.log('=== 场景 4：confirm 不匹配必须被拒 ===')
{
  const routes = []
  const ctx = makeCtx({ persistenceOverrides: {}, routeSink: routes })
  plugin.apply(ctx)
  const res = await post(routes.find((r) => r.path === '/__deep-purge/delete'), { sessionId: B, confirm: 'nope' })
  check('HTTP 400', res.status === 400, res.body && res.body.error)
  check('目录未被动', fs.existsSync(home + '/sessions/--C-test--/' + B))
}

console.log('')
console.log('=== 场景 5：裸 uuid（无 session- 前缀）也要能删 ===')
{
  const routes = []
  const ctx = makeCtx({ persistenceOverrides: { [B]: eventsWith([]) }, routeSink: routes })
  plugin.apply(ctx)
  const res = await post(routes.find((r) => r.path === '/__deep-purge/delete'), { sessionId: SURVIVOR_ID, confirm: SURVIVOR_ID })
  check('HTTP 200', res.status === 200)
  check('按裸 uuid 也删掉了目录', !fs.existsSync(home + '/sessions/--C-test--/' + B))
  check('裸 uuid 也清了投影缓存', ctx.tables.session_projcache.sessions.has(B) === false)
}

console.log('')
const failed = results.filter((r) => !r.ok)
console.log('结果: ' + (results.length - failed.length) + ' / ' + results.length + ' 通过')
if (failed.length) console.log('失败项: ' + failed.map((f) => f.label).join(', '))
try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
