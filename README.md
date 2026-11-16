# 飞书机器人 (Feishu Bot) — Antigravity 集成插件

> 🤖 将飞书消息变成 AI Agent 的任务输入，处理完成后自动回复 —— 实现**真正的无人值守 AI 工作流**。
>
> 📌 本仓库（[ahkimkoo/Antigravity-FeiShuPlugin](https://github.com/ahkimkoo/Antigravity-FeiShuPlugin)）Fork 自 [ast22005-crypto/Antigravity-FeiShuPlugin](https://github.com/ast22005-crypto/Antigravity-FeiShuPlugin)，已完成对**新版 Antigravity IDE（`v1.107.0+` / `google.google-antigravity` / `agy` 架构）**的全面兼容修复，并随仓库直接发布预打包好的 `.vsix` 插件文件。

[![Version](https://img.shields.io/badge/version-1.0.2-brightgreen)](antigravity-feishu-bot-1.0.2.vsix)
[![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.90.0-blue?logo=visual-studio-code)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Feishu](https://img.shields.io/badge/飞书-Open%20Platform-4A90E2?logo=bytedance)](https://open.feishu.cn/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 🛠️ 本 Fork 版本修改说明（v1.0.2 新版 Antigravity IDE 适配）

原版插件（`v1.0.1`）在升级到新版 **Antigravity IDE（`v1.107.0+`）** 后无法正常触发 Agent 且后台持续报错。本仓库针对新版架构进行了以下核心修复：

1. **修复飞书消息无法触发 Agent（卡死 5 分钟超时）的主故障（`src/agent/bridge.ts`）**
   - **原因**：新版 Antigravity IDE 将 Agent 聊天面板重构为内置扩展 `google.google-antigravity`（`agy --hub`）托管的 `antigravity.panel` Webview；旧版侧边栏已废弃，但 Workbench 中仍残留了空壳命令 `antigravity.sendPromptToAgentPanel`（调用不抛错但消息发往已废弃面板，导致 Agent 完全收不到指令）。
   - **修复**：
     - 触发前自动检测并激活内置 `google.google-antigravity` 扩展；
     - 优先采用新版 `antigravity.addContext` + `antigravity.triggerSend` 双步 RPC 协议将飞书消息注入输入框并自动提交，跳过空壳旧命令，同时保留对旧版 Antigravity IDE 的向后兼容；
     - 增加页面状态容错：若侧边栏停留在历史会话/设置等非对话子页面导致首次写入失败，自动调用 `antigravity.startNewConversation` 切回对话输入框后重试发送。
2. **修复认证保活每 30 分钟报错刷屏（`src/agent/authKeepAlive.ts` & `src/agent/outputWatcher.ts`）**
   - **原因**：新版移除了 `antigravity.handleAuthRefresh` 命令，导致原插件定时任务反复抛出 `command 'antigravity.handleAuthRefresh' not found`。
   - **修复**：按当前 IDE 可用命令自适应切换——旧版调用 `antigravity.handleAuthRefresh`，新版改用 `antigravity.internal.getAuthStatus` 探测后端认证状态，彻底消除错误刷屏；同时为日志监控新增 `agy` 输出通道匹配。
3. **优化飞书快捷指令兼容性（`src/feishu/listener.ts`）**
   - 优化 `开启新对话` / `新对话` 指令：执行前自动激活内置扩展、`await` 新建对话完成，并自动释放残留的 `processing` 队列锁；
   - 为 `切换模型` / `切换计划模型` 增加命令存在性检测（新版 Webview 已将模型选择器内聚至面板内部，不再注册外部 `toggleModelSelector` 命令）与 Linux 平台兜底提示，避免抛错或无响应。
4. **跨平台自动化脚本适配新版进程与窗口名（`resources/*`）**
   - 更新 macOS（`auto_retry_mac.py`、`select_model_mac.py`）与 Windows（`auto_retry.ps1`）脚本，支持匹配新版 `Antigravity IDE.app` 进程路径及 `Antigravity` 窗口标题。

---

## 🤖 一键自动安装提示词（复制发给 Antigravity 即可）

你可以直接将下面这段提示词复制并发送给 **Antigravity IDE 中的 Agent**，它会自动下载仓库中已发布的 `.vsix` 插件文件并完成安装：

```markdown
请帮我自动下载并安装飞书机器人插件（antigravity-feishu-bot v1.0.2），按以下步骤在终端执行：

1. 获取插件文件 `antigravity-feishu-bot-1.0.2.vsix`：
   - 优先使用 curl/Invoke-WebRequest 下载：`https://github.com/ahkimkoo/Antigravity-FeiShuPlugin/raw/main/antigravity-feishu-bot-1.0.2.vsix` 保存到临时目录；
   - 如果直接下载失败，请执行 `git clone https://github.com/ahkimkoo/Antigravity-FeiShuPlugin.git`（或 `git@github.com:ahkimkoo/Antigravity-FeiShuPlugin.git`）获取仓库根目录下的 `antigravity-feishu-bot-1.0.2.vsix`（若文件不存在则在仓库内执行 `npm install && npm run package` 生成）。

2. 自动查找当前系统上的 Antigravity IDE 命令行工具（按系统依次检查）：
   - Linux：检查 `which antigravity-ide`、`/app/Antigravity-IDE/bin/antigravity-ide`、`/usr/share/antigravity-ide/bin/antigravity-ide`、`/opt/Antigravity-IDE/bin/antigravity-ide`、`which antigravity`
   - macOS：检查 `which antigravity-ide`、`"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"`、`"/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity"`
   - Windows：检查 `antigravity-ide.cmd`、`"%LOCALAPPDATA%\Programs\Antigravity IDE\bin\antigravity-ide.cmd"`、`"%LOCALAPPDATA%\Programs\Antigravity\bin\antigravity.cmd"`

3. 执行安装并验证：
   - 运行 `<找到的CLI路径> --install-extension <vsix文件路径> --force`
   - 运行 `<找到的CLI路径> --list-extensions` 确认输出中包含 `stone.antigravity-feishu-bot`

4. 安装完成后清理临时下载文件，并提示我执行 `Developer: Reload Window` 重载窗口，以及在 Settings 中配置 `feishuBot.appId` 和 `feishuBot.appSecret`。
```

---

## 📦 插件文件（`.vsix`）安装与使用指南

本仓库根目录已直接发布预构建好的插件安装包：**[`antigravity-feishu-bot-1.0.2.vsix`](antigravity-feishu-bot-1.0.2.vsix)**，无需本地配置 Node.js 编译环境即可直接安装使用。

### 方式一：图形界面手动安装 `.vsix` 文件

1. 在 GitHub 仓库页面点击 [`antigravity-feishu-bot-1.0.2.vsix`](antigravity-feishu-bot-1.0.2.vsix)，点击右上角 **Download raw file** 下载到本地。
2. 打开 **Antigravity IDE**，点击左侧活动栏的 **Extensions（扩展）** 图标（或按 `Ctrl + Shift + X` / `Cmd + Shift + X`）。
3. 点击扩展面板右上角的 **`...`（更多操作）** 菜单 → 选择 **`Install from VSIX...`**。
4. 选中刚刚下载的 `antigravity-feishu-bot-1.0.2.vsix` 文件并确认安装。
5. 按 `Ctrl + Shift + P`（macOS 为 `Cmd + Shift + P`），输入并执行 **`Developer: Reload Window`** 重载窗口使插件生效。

### 方式二：命令行安装 `.vsix` 文件

```bash
# 1. 下载插件文件
curl -L -o antigravity-feishu-bot-1.0.2.vsix \
  https://github.com/ahkimkoo/Antigravity-FeiShuPlugin/raw/main/antigravity-feishu-bot-1.0.2.vsix

# 2. 使用 Antigravity IDE CLI 安装（若 antigravity-ide 不在 PATH，请替换为实际安装路径，如 /app/Antigravity-IDE/bin/antigravity-ide）
antigravity-ide --install-extension ./antigravity-feishu-bot-1.0.2.vsix --force
```

安装完成后在 Antigravity IDE 中执行 **`Developer: Reload Window`** 即可。

### 方式三：从源码编译打包

如果你需要自行修改源码并重新打包：

```bash
git clone git@github.com:ahkimkoo/Antigravity-FeiShuPlugin.git
cd Antigravity-FeiShuPlugin
npm install
npm run compile
npm run package
```

执行完成后会在当前目录生成新的 `antigravity-feishu-bot-1.0.2.vsix`。

---

## 🚀 配置与使用步骤

### 1. 创建并配置飞书开放平台应用

1. 前往 [飞书开放平台](https://open.feishu.cn/app) 创建一个**企业自建应用**，并添加**机器人**能力。
2. 在 **凭证与基础信息** 页面获取 `App ID`（`cli_xxx`）和 `App Secret`。
3. 在 **权限管理** 中开通以下权限：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message.p2p_msg:readonly` / `im:message.group_at_msg:readonly` — 接收单聊及群聊 @ 机器人消息
   - `im:resource` — 上传与下载文件/图片
4. 在 **事件与回调** 页面：
   - **事件配置 → 订阅方式**：选择 **使用长连接接收事件（WebSocket）**（无需公网 IP 或域名；保存前可先完成下方第 2 步让插件启动连接）；
   - 添加事件：**`im.message.receive_v1`（接收消息）**。
5. 创建版本并**申请线上发布**。

### 2. 在 Antigravity IDE 中填入凭证

打开 Antigravity IDE 设置（`Ctrl + ,` / `Cmd + ,`），搜索 `feishuBot`（或在命令面板执行 `飞书: 打开设置`）：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `feishuBot.appId` | string | `""` | **必填**：飞书应用 App ID (`cli_xxx`) |
| `feishuBot.appSecret` | string | `""` | **必填**：飞书应用 App Secret |
| `feishuBot.enabled` | boolean | `true` | 启用飞书集成 |
| `feishuBot.projectName` | string | `""` | 项目名称（留空则使用当前工作区文件夹名） |
| `feishuBot.notifyOnOpen` | boolean | `true` | 项目打开时向飞书发送就绪通知 |
| `feishuBot.notifyOnCompletion` | boolean | `true` | Agent 完成后将结果卡片推送到飞书 |
| `feishuBot.autoTriggerAgent` | boolean | `true` | 收到飞书消息后自动触发 Agent 处理 |
| `feishuBot.triggerCooldown` | number | `10` | 自动触发冷却时间（秒） |
| `feishuBot.autoRetryOnError` | boolean | `true` | Agent 出错时自动点击 Retry（Windows / macOS） |
| `feishuBot.autoRetryInterval` | number | `15` | 自动重试检测间隔（秒） |
| `feishuBot.autoRestartThreshold`| number | `10` | 连续重试达到此次数后，自动通过 Manager 切换账号恢复 |
| `feishuBot.authKeepAlive` | boolean | `true` | 启用定期认证状态保活检测 |
| `feishuBot.authKeepAliveInterval` | number | `30` | 认证保活检测间隔（分钟） |
| `feishuBot.managerPort` | number | `8045` | Antigravity-Manager 本地 API 端口 |
| `feishuBot.managerApiKey` | string | `""` | Antigravity-Manager API Key（可选） |
| `feishuBot.projectsRoot` | string | `""` | 项目根目录路径（`切换项目` 时扫描此目录，留空默认当前工作区父目录） |

### 3. 激活双向通信并开始使用

1. 打开任意项目工作区（注意：**必须打开一个文件夹工作区**，插件才会完整激活并注入 `.agents/skills/feishu-bot/SKILL.md`）。
2. 插件底部状态栏显示飞书已连接后，打开飞书向该机器人**发送任意第一条消息**（例如 `你好`）。
3. 机器人会自动记录你的会话 ID 并回复「✅ 双向通信已激活！」，同时自动唤起 Antigravity Agent 处理你的消息。
4. Agent 完成任务后会自动生成 `.antigravity/feishu_response.json`，插件检测到后立即将结果卡片与相关文档推送回你的飞书，并清理队列与响应文件。

---

## ✨ 功能亮点

| 功能 | 描述 |
|------|------|
| 📨 **双向消息通信** | 通过 WebSocket 实时接收飞书消息，处理结果自动推送回飞书 |
| 🤖 **AI Agent 自动触发** | 适配新旧版 Antigravity IDE，收到消息后自动注入对话面板并触发执行 |
| 📁 **文件传输** | 在飞书中发送 `发送文件 xxx` 即可检索并下载项目文件；Agent 修改文档自动回传 |
| 🔄 **错误自动重试** | 通过 UI Automation 自动点击 Retry 按钮（Windows / macOS），并同步重试次数到飞书 |
| 🔑 **三级鉴权恢复** | 双通道检测 OAuth2 授权异常（UI 对话框 + Output 日志），自动对接 Antigravity-Manager API 无缝切换备用账号 |
| 🔌 **软重启（零停机）** | 手动发送 `重启` 指令或连续重试达阈值时，自动通过 Manager 切换账号恢复 |
| 📊 **账号配额管理** | 在飞书中发送 `账号` / `刷新` 查询配额，并可通过序号或邮箱一键切换账号 |
| 📁 **项目切换** | 在飞书中发送 `切换项目 xxx` 即可将当前窗口切换到目标项目，全平台通用 |
| 📋 **消息队列管理** | 支持消息排队、去重、5 分钟超时兜底通知、多消息自动合并批处理 |
| 🧠 **Skill 自动注入** | 自动生成 `.agents/skills/feishu-bot/SKILL.md`，让 Agent 严格遵循飞书回推协议 |
| 🛠️ **JSON 自动修复** | 三策略容错解析 Agent 响应 JSON，容忍未转义引号等格式瑕疵 |

---

## 📐 架构概览

```text
飞书消息 → WebSocket (FeishuListener) → MessageQueue → AgentBridge (addContext + triggerSend) → Antigravity Agent
                                                                                                      │
飞书卡片/文件回复 ← FeishuClient ← ResponseWatcher (FSWatcher + 10s 轮询) ← .antigravity/feishu_response.json
```

---

## 📖 常用命令与飞书端快捷指令

### IDE 命令面板（`Ctrl + Shift + P` / `Cmd + Shift + P`）

| 命令 | 说明 |
|------|------|
| `飞书: 连接` | 连接飞书 WebSocket |
| `飞书: 断开连接` | 断开 WebSocket |
| `飞书: 发送文本消息` | 手动发送文本到飞书 |
| `飞书: 发送处理结果` | 手动推送处理结果 |
| `飞书: 读取消息队列` | 查看当前待处理消息 |
| `飞书: 清空消息队列` | 清空所有消息及处理锁 |
| `飞书: 手动触发 Agent 处理` | 手动触发 Agent 处理队列 |
| `飞书: 查看账号配额数据` | 获取所有账号配额数据并发送到飞书 |
| `飞书: 刷新账号配额` | 刷新全部账号配额并推送报告 |
| `飞书: 查看状态` | 查看连接 / 队列 / Agent / 保活状态 |
| `飞书: 打开设置` | 快速打开飞书插件设置 |

### 飞书聊天快捷指令（跳过 Agent 队列直接执行）

- **文件查找与下载**：`发送文件 config.ts` / `发文件 package.json` / `找文件 readme` / `send file extension.ts`
- **开启新对话**：`开启新对话` / `新对话` / `new conversation`
- **项目查看与切换**：
  - 查看可切换项目列表：`项目` 或 `切换项目`
  - 切换到指定项目：`切换项目 项目名` 或 `切换项目 序号`
- **账号配额与切换（需配合 Antigravity-Manager）**：
  - 查询配额：`账号` / `配额` / `account data`
  - 刷新配额：`刷新`（全部）或 `刷新 1` / `刷新 user@gmail.com`（指定账号）
  - 切换账号：`账号 1` / `切换账号 user@gmail.com`
- **软重启（账号切换恢复）**：`重启` / `restart`
- **模型切换（旧版 IDE + Windows/macOS UI 自动化）**：`切换模型 xxx` / `切换计划模型 xxx`（新版 Antigravity IDE 请直接在聊天面板底部或 Settings 中选择模型）

### Agent 响应协议

当对话包含「飞书消息队列」关键词时，Agent 会在工作区根目录创建 `.antigravity/feishu_response.json`：

```json
{
  "summary": "一句话概括处理结果",
  "details": "详细的处理过程说明（可选）",
  "files": ["修改过的文件列表（仅展示，可选）"],
  "sendFiles": ["需要实际上传发送给飞书用户的文件路径（可选）"]
}
```

---

## 🔧 项目结构

```text
Antigravity-FeiShuPlugin/
├── antigravity-feishu-bot-1.0.2.vsix  # 预打包可直接安装的插件文件
├── src/
│   ├── extension.ts                   # 插件入口，生命周期管理
│   ├── types.ts                       # 共享类型定义
│   ├── config/configManager.ts        # VS Code Settings 读取
│   ├── feishu/
│   │   ├── client.ts                  # 飞书 REST API 客户端（Token / 消息 / 文件上传）
│   │   └── listener.ts                # WebSocket 消息监听 + 飞书快捷指令处理
│   ├── queue/messageQueue.ts          # 消息队列（内存 + 文件持久化）
│   ├── agent/
│   │   ├── bridge.ts                  # Agent 触发桥接（兼容新版 addContext+triggerSend 与旧版）
│   │   ├── authKeepAlive.ts           # 认证状态定期保活检测
│   │   ├── completionDetector.ts      # 工作区文件变更快照对比
│   │   ├── errorWatcher.ts            # UI 错误对话框检测 + 自动重试（Win / macOS）
│   │   ├── outputWatcher.ts           # Output Channel 日志实时监控
│   │   └── skillInjector.ts           # SKILL.md 自动注入
│   ├── ui/                            # 状态栏 & 侧边栏视图
│   └── utils/                         # 日志、文件检索、JSON 容错修复、Manager 客户端
├── resources/                         # 图标与 Win/macOS UI 自动化脚本
├── package.json                       # 插件清单 & 配置声明
└── tsconfig.json                      # TypeScript 编译配置
```

---

## ⚠️ 注意事项

- **必须打开工作区文件夹**：插件依赖工作区目录存放 `.antigravity/` 消息队列与注入 `.agents/skills/feishu-bot/SKILL.md`，未打开文件夹时仅注册基础设置命令。
- **自动重试平台支持**：UI 错误自动重试功能支持 Windows（UI Automation）和 macOS（Python 3 + Accessibility API，需在「系统设置 → 隐私与安全 → 辅助功能」授权 Antigravity IDE）；Linux 下该项自动跳过，不影响双向通信与任务执行。
- **安全提醒**：`App Secret`、`Manager API Key` 等敏感凭证请保存在用户级 Settings 中，切勿将含密钥的 `.vscode/settings.json` 提交到公开仓库。

---

## 📄 License

MIT
