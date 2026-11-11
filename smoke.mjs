#!/usr/bin/env node
// wx-mcp 冒烟测试：走一遍 initialize → tools/list → 指定工具调用
// 用法：node smoke.mjs            （只跑 tools/list 和一个轻量工具）
//       node smoke.mjs wx_audit   （额外调用指定工具）
import { spawn } from 'node:child_process'

const SERVER = new URL('./server.mjs', import.meta.url).pathname.replace(/^\//, '')
const extra = process.argv[2]

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let nextId = 1

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const r = pending.get(msg.id)
    if (r) {
      pending.delete(msg.id)
      r(msg)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`))

function call(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 300000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
console.log('serverInfo:', JSON.stringify(init.result.serverInfo))
console.log('protocolVersion:', init.result.protocolVersion)

const list = await call('tools/list', {})
console.log('tools:', list.result.tools.map((t) => t.name).join(', '))
console.log('tool count:', list.result.tools.length)

const targets = extra ? [extra] : ['wx_audit']
for (const name of targets) {
  console.log(`\n=== ${name} ===`)
  const res = await call('tools/call', { name, arguments: {} })
  const text = (res.result?.content || []).map((c) => c.text).join('\n')
  console.log(text)
}

child.stdin.end()
child.kill()
process.exit(0)
