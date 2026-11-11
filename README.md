# wx-devtools · 微信小程序开发插件（MCP）

把 **微信开发者工具 CLI** 和 **HBuilderX CLI** 包成一组 agent 可直接调用的工具，
让 AI 能自己打开工程、编译、出预览二维码、上传体验版、做静态体检 —— 而不是每次都让人去点鼠标。

- **零依赖**：手写 MCP 的 JSON-RPC 帧，不需要 `@modelcontextprotocol/sdk`，拷到任何装了 Node 18+ 的机器上都能跑
- **零侵入**：不改小程序工程、不改微信开发者工具，只是调它们自带的命令行
- **可移植**：所有路径都能用环境变量覆盖

```
agent ──MCP(stdio)──▶ wx-devtools ──cmd──▶ cli.bat (微信开发者工具)
                                └──cmd──▶ cli.exe (HBuilderX)
```

---

## 为什么会有这个

做小程序时最烦的不是写代码，是**验证**：打开 IDE、点编译、扫码、看日志、改、再来一遍。
这些动作微信开发者工具其实都提供了 CLI，但没人把它们串成 agent 能用的接口。
这个插件就是那层薄薄的胶水。

它原本是给 [校递达](https://github.com/kylinz10086/xiaodida) 这个校园跑腿项目写的，
后来发现通用性不错，就单独抽出来了。

---

## 安装

### 1. 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | 运行 server.mjs |
| 微信开发者工具 | 需要开启「设置 → 安全设置 → **服务端口**」 |
| HBuilderX（可选） | 只有编译 uni-app 工程才需要 |

### 2. 注册到 DSH

编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，追加：

```yaml
- insert:
    - id: mcp-wx-devtools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: wx-devtools
        transport: stdio
        command: '<node.exe 绝对路径>'
        args:
          - '<本仓库>/server.mjs'
        toolCallTimeoutMs: 600000
```

改完重启 DSH 生效。

### 3. 其它 MCP 客户端

只要是标准 stdio MCP，配置方式都一样：

```json
{
  "mcpServers": {
    "wx-devtools": {
      "command": "node",
      "args": ["/path/to/server.mjs"],
      "env": {
        "WX_CLI": "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
        "HBX_CLI": "/Applications/HBuilderX.app/Contents/MacOS/cli"
      }
    }
  }
}
```

---

## 环境变量

都有默认值（默认按 Windows + 常见安装位置），换机器改这些就行：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WX_CLI` | `F:\微信web开发者工具\cli.bat` | 微信开发者工具 CLI |
| `HBX_CLI` | `F:\HBuilderX.5.05.2026032417\HBuilderX\cli.exe` | HBuilderX CLI |
| `WX_REPO` | `F:\xiaodida` | 项目根目录 |
| `WX_PROJECT` | `<WX_REPO>\miniprogram` | 默认小程序工程 |
| `WX_UNI_SRC` | `<WX_REPO>\apps\user` | 默认 uni-app 源码工程 |
| `WX_UNI_DIST` | `<WX_UNI_SRC>\unpackage\dist\dev\mp-weixin` | uni-app 编译产物 |

---

## 工具一览（12 个）

| 工具 | 作用 | 需要登录 |
| --- | --- | --- |
| `wx_env` | 环境自检：工具版本、登录状态、工程路径 | — |
| `wx_login` | 触发扫码登录 | — |
| `wx_open_project` | 用开发者工具打开工程 | — |
| `wx_preview` | 编译并生成预览二维码 PNG | ✅ |
| `wx_upload` | 上传体验版到微信后台 | ✅ |
| `wx_build_npm` | 构建 npm | — |
| `wx_auto` | 开启自动化调试端口 | — |
| `wx_audit` | 静态体检：页面完整性、主包体积、分包、tabBar 图标、appid | — |
| `wx_hbx_open` | 启动 HBuilderX 并打开 uni-app 工程 | — |
| `wx_compile_mp` | 用 HBuilderX CLI 编译到 mp-weixin | — |
| `wx_close_project` | 关闭工程窗口 | — |
| `wx_quit` | 退出开发者工具 | — |

### 典型用法

```text
1. wx_env                        # 先自检，看 login 是不是 true
2. wx_open_project()             # 打开工程（默认 miniprogram/）
3. wx_audit()                    # 静态体检，页面缺失/体积超限会直接报
4. wx_preview()                  # 出二维码 PNG，人扫码就能真机看
5. wx_upload({version:"1.0.0"})  # 传体验版
```

---

## 自测

```bash
node smoke.mjs          # initialize → tools/list → wx_audit
node smoke.mjs wx_env   # 顺便跑环境自检
```

输出示例：

```
serverInfo: {"name":"wx-devtools","version":"0.1.0"}
tools: wx_env, wx_login, wx_open_project, ...
=== wx_audit ===
工程：F:\xiaodida\miniprogram
页面数：5
✓ 页面文件齐全
主包大小：0.08 MB（微信上限 2 MB） ✓
```

---

## 踩过的坑（都已在代码里处理）

| 坑 | 处理 |
| --- | --- |
| `cli.bat` 是批处理，直接 spawn 会失败 | 拼完整命令行走 `cmd.exe`，路径自己加引号（含中文和空格） |
| `cli.bat islogin` 的 JSON 混在日志里 | 从后往前逐行找可解析的那一行 |
| 未登录时 `preview`/`upload` 一定失败 | `wx_env` 先报 `login:false`，给出明确提示 |
| HBuilderX CLI 所有命令都回「未检测到已打开的HBuilderX」 | 必须先 `cli open` 起 IDE，`wx_compile_mp` 会先探测再给提示 |
| `publish mp-weixin` 报 `appid 不存在` | manifest 里的 `__UNI__xxx` 必须是 DCloud 账号下真实存在的 |
| 项目 manifest 带 BOM 导致 `Unexpected token` | 这是工程侧问题，README 里提醒用无 BOM UTF-8 |

---

## 目录

```
wx-mcp/
├── server.mjs      MCP server（零依赖，含 12 个工具）
├── smoke.mjs       冒烟测试
├── package.json
└── README.md
```

---

## License

MIT
