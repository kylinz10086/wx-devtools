#!/usr/bin/env node
/**
 * wx-mcp —— 微信小程序开发插件（MCP stdio server，零依赖）
 *
 * 为什么零依赖：DSH 的插件是 stdio MCP，宿主机上装一份 @modelcontextprotocol/sdk
 * 会把插件和环境绑死；这里直接实现 MCP 的 JSON-RPC 帧，拷到任何有 node 的机器上都能跑。
 *
 * 干的事：把「微信开发者工具 CLI」(cli.bat) 和「HBuilderX CLI」(cli.exe) 包成 agent 能直接
 * 调用的工具，这样改完小程序代码可以自己打开、编译、预览、上传，而不是让用户点鼠标。
 *
 * 环境约定（都可用环境变量覆盖）：
 *   WX_CLI         微信开发者工具命令行  默认 F:\微信web开发者工具\cli.bat
 *   WX_PROJECT     默认小程序工程         默认 <repo>\miniprogram
 *   WX_UNI_DIST    默认 uni-app 编译产物  默认 <repo>\校递达app客户端\unpackage\dist\dev\mp-weixin
 *   WX_UNI_SRC     默认 uni-app 源码工程  默认 <repo>\校递达app客户端
 *   HBX_CLI        HBuilderX 命令行       默认 F:\HBuilderX.5.05.2026032417\HBuilderX\cli.exe
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REPO = process.env.WX_REPO || 'F:\\xiaodida'
const WX_CLI = process.env.WX_CLI || 'F:\\微信web开发者工具\\cli.bat'
const HBX_CLI = process.env.HBX_CLI || 'F:\\HBuilderX.5.05.2026032417\\HBuilderX\\cli.exe'
const DEFAULT_PROJECT = process.env.WX_PROJECT || path.join(REPO, 'miniprogram')
const UNI_DIST = process.env.WX_UNI_DIST || path.join(REPO, '校递达app客户端', 'unpackage', 'dist', 'dev', 'mp-weixin')
const UNI_SRC = process.env.WX_UNI_SRC || path.join(REPO, '校递达app客户端')
const LOG_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'cache', 'wx-mcp')
const MAX_TEXT = 12000

const log = (...a) => process.stderr.write(`[wx-mcp] ${a.join(' ')}\n`)

/* ------------------------------------------------------------------ */
/* 进程执行                                                            */
/* ------------------------------------------------------------------ */

function quoteWin(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`
}

function run(exe, args, { timeoutMs = 180000, cwd } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(exe)) {
      resolve({ ok: false, code: -1, out: '', err: `找不到可执行文件：${exe}` })
      return
    }
    // cli.bat 必须走 cmd.exe；统一拼一条命令行，避免路径空格被拆开
    const cmd = [quoteWin(exe), ...args.map(quoteWin)].join(' ')
    let settled = false
    const child = spawn(cmd, {
      shell: true,
      cwd: cwd && existsSync(cwd) ? cwd : REPO,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, code: -2, out, err: `${err}\n超时（${timeoutMs}ms）：${exe} ${args.join(' ')}` })
    }, timeoutMs)
    child.stdout?.on('data', (b) => (out += b.toString('utf8')))
    child.stderr?.on('data', (b) => (err += b.toString('utf8')))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: -1, out, err: e.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out, err })
    })
  })
}

function clip(text) {
  const s = String(text ?? '')
  if (s.length <= MAX_TEXT) return s
  return `${s.slice(0, MAX_TEXT)}\n\n…（已截断，共 ${s.length} 字）`
}

function combine(r) {
  return clip([r.out.trim(), r.err.trim()].filter(Boolean).join('\n') || `（无输出，exit=${r.code}）`)
}

/** cli.bat 在部分命令下会把结果打成 JSON，混在日志里，这里把它抠出来 */
function extractJson(text) {
  const raw = String(text || '')
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!(line.startsWith('{') || line.startsWith('['))) continue
    try {
      return JSON.parse(line)
    } catch {}
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 项目体检                                                            */
/* ------------------------------------------------------------------ */

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function dirSize(dir) {
  let total = 0
  let files = 0
  const walk = (p) => {
    let entries = []
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const fp = path.join(p, e.name)
      if (e.isDirectory()) walk(fp)
      else {
        try {
          total += statSync(fp).size
          files++
        } catch {}
      }
    }
  }
  walk(dir)
  return { bytes: total, files }
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

/** 体检一个小程序工程（原生小程序或 uni-app 产物都适用） */
function auditProject(projectPath) {
  const p = projectPath || DEFAULT_PROJECT
  const lines = []
  if (!existsSync(p)) {
    return `✗ 工程不存在：${p}\n（用 wx 环境自检 看默认路径，或传 projectPath）`
  }
  lines.push(`工程：${p}`)

  const appJsonPath = path.join(p, 'app.json')
  const appJson = readJson(appJsonPath)
  if (!appJson) {
    lines.push('✗ 缺少 app.json —— 不是合法的小程序工程目录')
    return lines.join('\n')
  }

  const pages = Array.isArray(appJson.pages) ? appJson.pages : []
  lines.push(`页面数：${pages.length}`)

  const missing = []
  for (const page of pages) {
    for (const ext of ['.js', '.wxml']) {
      const f = path.join(p, page + ext)
      if (!existsSync(f)) missing.push(page + ext)
    }
    if (!existsSync(path.join(p, page + '.json'))) missing.push(`${page}.json`)
  }
  lines.push(missing.length ? `✗ 页面文件缺失（${missing.length}）：\n  ${missing.join('\n  ')}` : '✓ 页面文件齐全')

  const subs = Array.isArray(appJson.subPackages) ? appJson.subPackages : Array.isArray(appJson.subpackages) ? appJson.subpackages : []
  const subRoots = subs.map((s) => s.root)
  const mainBytes = (() => {
    let total = 0
    const walk = (dir) => {
      let entries = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const fp = path.join(dir, e.name)
        const rel = path.relative(p, fp).replace(/\\/g, '/')
        if (subRoots.some((r) => rel === r || rel.startsWith(r + '/'))) continue
        if (e.isDirectory()) walk(fp)
        else {
          try {
            total += statSync(fp).size
          } catch {}
        }
      }
    }
    walk(p)
    return total
  })()
  lines.push(`主包大小：${mb(mainBytes)}（微信上限 2 MB）${mainBytes > 2 * 1024 * 1024 ? ' ✗ 超限，需要分包' : ' ✓'}`)
  lines.push(`分包：${subs.length ? subs.map((s) => s.root).join(', ') : '无'}`)

  const tabBar = appJson.tabBar
  if (tabBar?.list?.length) {
    const bad = []
    for (const t of tabBar.list) {
      for (const key of ['iconPath', 'selectedIconPath']) {
        if (t[key] && !existsSync(path.join(p, t[key]))) bad.push(t[key])
      }
    }
    lines.push(`tabBar：${tabBar.list.length} 个${bad.length ? `，图标缺失：${bad.join(', ')}` : '，图标齐全'}`)
  }

  const cfg = readJson(path.join(p, 'project.config.json'))
  lines.push(`appid：${cfg?.appid || appJson.appid || '（未配置）'}`)

  const total = dirSize(p)
  lines.push(`整包：${mb(total.bytes)} / ${total.files} 个文件（总上限 20 MB）`)

  if (appJson.permission) {
    const scopes = Object.keys(appJson.permission)
    lines.push(`权限声明：${scopes.join(', ')}`)
  }
  lines.push('提醒：真机访问网络需要在微信后台配置合法域名；本地开发可在开发者工具里勾选「不校验合法域名」。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'wx_env',
    description:
      '微信小程序开发环境自检：开发者工具版本/登录状态、HBuilderX 是否可用、默认小程序工程与 uni-app 编译产物是否存在。开工前先跑这个。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wx_login',
    description: '打开微信开发者工具并触发扫码登录（预览/上传必须先登录）。返回当前登录态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wx_open_project',
    description:
      '用微信开发者工具打开一个小程序工程。默认打开 miniprogram/（原生小程序）；传 target="uni-dist" 可打开 uni-app 的编译产物。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' },
        target: { type: 'string', enum: ['miniprogram', 'uni-dist'], description: '默认 miniprogram' },
      },
    },
  },
  {
    name: 'wx_preview',
    description: '编译并生成预览二维码（PNG），返回图片路径。需要已登录；让用户在手机上扫码即可真机预览。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' },
        qrPath: { type: 'string', description: '二维码输出路径，省略则写到缓存目录' },
        compileType: { type: 'string', description: '编译方式，例如 business、plugin' },
      },
    },
  },
  {
    name: 'wx_upload',
    description: '上传体验版到微信后台。需要已登录且有该 appid 的上传权限。版本号形如 1.0.0。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' },
        version: { type: 'string', description: '版本号，例如 1.0.0' },
        desc: { type: 'string', description: '版本描述' },
      },
      required: ['version'],
    },
  },
  {
    name: 'wx_build_npm',
    description: '在工程里执行「构建 npm」（工程用了 npm 包时必需）。',
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' } },
    },
  },
  {
    name: 'wx_auto',
    description: '开启自动化端口（给 miniprogram-automator 之类的自动化脚本用），返回端口与 ws 地址。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' },
        port: { type: 'number', description: '自动化端口，默认 9420' },
      },
    },
  },
  {
    name: 'wx_audit',
    description:
      '小程序静态体检：页面文件是否齐全、主包体积/分包、tabBar 图标、appid、权限声明、包体总大小。交付前跑一遍。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' },
        target: { type: 'string', enum: ['miniprogram', 'uni-dist'], description: '默认 miniprogram' },
      },
    },
  },
  {
    name: 'wx_hbx_open',
    description: '启动 HBuilderX 并打开 uni-app 源码工程（改完 vue 源码后要重新编译成小程序时用）。',
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string', description: 'uni-app 源码目录，省略则用默认' } },
    },
  },
  {
    name: 'wx_compile_mp',
    description:
      '用 HBuilderX CLI 把 uni-app 源码编译成微信小程序产物（输出到 unpackage/dist）。HBuilderX 未运行时返回明确提示。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'uni-app 源码目录，省略则用默认' },
        mode: { type: 'string', enum: ['dev', 'build'], description: 'dev=开发版(默认) build=发行版' },
      },
    },
  },
  {
    name: 'wx_close_project',
    description: '关闭小程序工程窗口（不退出 IDE）。',
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string', description: '工程绝对路径，省略则用默认' } },
    },
  },
  {
    name: 'wx_quit',
    description: '退出微信开发者工具。',
    inputSchema: { type: 'object', properties: {} },
  },
]

function resolveProject(args = {}) {
  if (args.projectPath) return args.projectPath
  if (args.target === 'uni-dist') return UNI_DIST
  return DEFAULT_PROJECT
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

async function toolEnv() {
  const lines = []
  lines.push(`微信开发者工具 CLI：${WX_CLI} ${existsSync(WX_CLI) ? '✓' : '✗ 不存在'}`)
  lines.push(`HBuilderX CLI：${HBX_CLI} ${existsSync(HBX_CLI) ? '✓' : '✗ 不存在'}`)
  lines.push(`默认小程序工程：${DEFAULT_PROJECT} ${existsSync(DEFAULT_PROJECT) ? '✓' : '✗ 不存在'}`)
  lines.push(`uni-app 编译产物：${UNI_DIST} ${existsSync(UNI_DIST) ? '✓' : '✗ 不存在'}`)
  lines.push(`uni-app 源码工程：${UNI_SRC} ${existsSync(UNI_SRC) ? '✓' : '✗ 不存在'}`)

  const ver = await run(WX_CLI, ['--version'], { timeoutMs: 60000 })
  const verText = (ver.out + ver.err).trim()
  if (verText) lines.push(`\n版本信息：\n${clip(verText).slice(0, 800)}`)

  const login = await run(WX_CLI, ['islogin', '--lang', 'zh'], { timeoutMs: 90000 })
  const parsed = extractJson(login.out + login.err)
  if (parsed && typeof parsed.login === 'boolean') {
    lines.push(`\n登录状态：${parsed.login ? '✓ 已登录' : '✗ 未登录（预览/上传会失败，需要扫码）'}`)
  } else {
    lines.push(`\n登录状态：无法解析\n${clip(combine(login)).slice(0, 800)}`)
  }
  return lines.join('\n')
}

async function toolLogin() {
  const r = await run(WX_CLI, ['login', '--lang', 'zh'], { timeoutMs: 120000 })
  const parsed = extractJson(r.out + r.err)
  const tail = clip(combine(r))
  if (parsed && typeof parsed.login === 'boolean') {
    return `${parsed.login ? '✓ 已登录' : '✗ 仍未登录：请在开发者工具窗口里用微信扫码'}\n\n${tail.slice(0, 1200)}`
  }
  return tail
}

async function toolOpen(args) {
  const project = resolveProject(args)
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  const r = await run(WX_CLI, ['open', '--project', project, '--lang', 'zh'], { timeoutMs: 180000 })
  return `打开工程：${project}\n${combine(r)}`
}

async function toolPreview(args) {
  const project = resolveProject(args)
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  const qr = args.qrPath || path.join(LOG_DIR, `preview-${Date.now()}.png`)
  const list = ['preview', '--project', project, '--qr-output', qr, '--qr-format', 'image', '--lang', 'zh']
  if (args.compileType) list.push('--compile-type', String(args.compileType))
  const r = await run(WX_CLI, list, { timeoutMs: 300000 })
  const ok = existsSync(qr)
  return [
    ok ? `✓ 预览二维码：${qr}` : '✗ 未生成二维码',
    ok ? '让用户用微信扫这个文件里的码即可真机预览。' : '常见原因：未登录 / 工程编译报错 / 未开通上传权限。',
    '',
    combine(r),
  ].join('\n')
}

async function toolUpload(args) {
  const project = resolveProject(args)
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  const r = await run(
    WX_CLI,
    ['upload', '--project', project, '-v', String(args.version), '-d', String(args.desc || 'auto upload'), '--lang', 'zh'],
    { timeoutMs: 420000 },
  )
  return `上传 ${args.version}：${project}\n${combine(r)}`
}

async function toolBuildNpm(args) {
  const project = resolveProject(args)
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  const r = await run(WX_CLI, ['build-npm', '--project', project, '--lang', 'zh'], { timeoutMs: 300000 })
  return combine(r)
}

async function toolAuto(args) {
  const project = resolveProject(args)
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  const port = Number(args.port || 9420)
  const r = await run(WX_CLI, ['auto', '--project', project, '--auto-port', String(port), '--lang', 'zh'], { timeoutMs: 180000 })
  return `自动化端口 ${port}\n${combine(r)}`
}

async function toolAudit(args) {
  return auditProject(resolveProject(args))
}

async function toolHbxOpen(args) {
  const project = args.projectPath || UNI_SRC
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  const open = await run(HBX_CLI, ['open'], { timeoutMs: 120000 })
  const po = await run(HBX_CLI, ['project', 'open', '--path', project], { timeoutMs: 120000 })
  return `HBuilderX 启动：${combine(open)}\n打开工程：${combine(po)}`
}

async function toolCompile(args) {
  const project = args.projectPath || UNI_SRC
  if (!existsSync(project)) return `✗ 工程不存在：${project}`
  const mode = args.mode === 'build' ? 'build' : 'dev'
  const probe = await run(HBX_CLI, ['project', 'list'], { timeoutMs: 30000 })
  if (/未检测到已打开的HBuilderX/.test(probe.out + probe.err)) {
    return [
      '✗ HBuilderX 没有在运行，CLI 无法编译。',
      '处理办法（二选一）：',
      '  1. 先调 wx_hbx_open 启动 HBuilderX，再重试本工具；',
      '  2. 直接在 HBuilderX 里 运行 → 运行到小程序模拟器 → 微信开发者工具。',
      `源码：${project}`,
      `产物目录：${UNI_DIST}`,
    ].join('\n')
  }
  // HBuilderX CLI 的 publish 子命令按平台编译；具体参数以 cli.exe --help 为准
  const r = await run(HBX_CLI, ['publish', '--platform', 'mp-weixin', '--project', project], { timeoutMs: 600000 })
  const text = combine(r)
  const ok = existsSync(path.join(UNI_DIST, 'app.json'))
  return [
    ok ? `✓ 产物已存在：${UNI_DIST}` : '? 产物目录未检出 app.json，可能编译失败',
    `模式：${mode}`,
    '',
    text,
  ].join('\n')
}

async function toolClose(args) {
  const project = resolveProject(args)
  const r = await run(WX_CLI, ['close', '--project', project, '--lang', 'zh'], { timeoutMs: 60000 })
  return combine(r)
}

async function toolQuit() {
  const r = await run(WX_CLI, ['quit', '--lang', 'zh'], { timeoutMs: 60000 })
  return combine(r)
}

const HANDLERS = {
  wx_env: toolEnv,
  wx_login: toolLogin,
  wx_open_project: toolOpen,
  wx_preview: toolPreview,
  wx_upload: toolUpload,
  wx_build_npm: toolBuildNpm,
  wx_auto: toolAuto,
  wx_audit: toolAudit,
  wx_hbx_open: toolHbxOpen,
  wx_compile_mp: toolCompile,
  wx_close_project: toolClose,
  wx_quit: toolQuit,
}

/* ------------------------------------------------------------------ */
/* MCP 协议层（JSON-RPC 2.0 / newline-delimited over stdio）            */
/* ------------------------------------------------------------------ */

const PROTOCOL_VERSION = '2024-11-05'

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg || {}
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'wx-devtools', version: '0.1.0' },
      instructions:
        '微信小程序开发工具集：wx_env 先自检，wx_open_project 打开工程，wx_preview 出二维码，wx_upload 上传体验版，wx_audit 静态体检。预览/上传需要开发者工具已登录。',
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'resources/list' || method === 'prompts/list') {
    reply(id, { resources: [], prompts: [] })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const fn = HANDLERS[name]
    if (!fn) {
      replyError(id, -32602, `未知工具：${name}`)
      return
    }
    try {
      const text = await fn(params.arguments || {})
      reply(id, { content: [{ type: 'text', text: clip(text) }], isError: false })
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: `工具执行异常：${e?.message || e}` }], isError: true })
    }
    return
  }
  if (isNotification) return
  replyError(id, -32601, `不支持的方法：${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      log('无法解析的帧：', line.slice(0, 200))
      continue
    }
    handle(msg).catch((e) => {
      log('处理失败：', e?.message || e)
      if (msg && msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, String(e?.message || e))
    })
  }
})
process.stdin.on('end', () => process.exit(0))
log('wx-devtools 已就绪')
