# 飞书机器人 (Feishu Bot) — Antigravity 集成插件

> 🤖 将飞书消息变成 AI Agent 的任务输入，处理完成后自动回复 —— 实现**真正的无人值守 AI 工作流**。

[![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.90.0-blue?logo=visual-studio-code)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Feishu](https://img.shields.io/badge/飞书-Open%20Platform-4A90E2?logo=bytedance)](https://open.feishu.cn/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## ✨ 功能亮点

| 功能 | 描述 |
|------|------|
| 📨 **双向消息通信** | 通过 WebSocket 实时接收飞书消息，处理结果自动推送回飞书 |
| 🤖 **AI Agent 自动触发** | 收到消息后自动唤起 Antigravity Agent 处理任务 |
| 📁 **文件传输** | 在飞书中发送 `发送文件 xxx` 即可获取项目文件 |
| 🔄 **错误自动重试** | 通过 UI Automation 自动点击 Retry 按钮（Windows / macOS），并同步重试次数到飞书 |
| 🔌 **自动/手动重启** | 支持手动发送 `重启` 指令，或连续重试达阈值后自动重载恢复工作流 |
| 🚫 **配额异常通知** | 检测到 Model quota reached 时自动通知飞书 |
| 📋 **消息队列管理** | 支持消息排队、去重、超时保护、自动批处理 |
| 🧠 **Skill 自动注入** | 自动生成 SKILL.md，让 Agent 理解飞书工作流 |
| 🎯 **状态栏 & 侧边栏** | 实时显示连接状态、消息队列、处理进度 |

---

## 📐 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        飞书用户                              │
│              (发消息 / 发指令 / 接收结果)                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket (Feishu Open Platform)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  VS Code Extension                          │
│                                                             │
│  ┌──────────┐  ┌────────────┐  ┌───────────────────┐       │
│  │ Listener │→ │   Queue    │→ │   Agent Bridge    │       │
│  │ (WS接收) │  │ (消息队列) │  │ (触发Antigravity) │       │
│  └──────────┘  └────────────┘  └─────────┬─────────┘       │
│                                          │                  │
│  ┌──────────┐  ┌────────────┐  ┌─────────▼─────────┐       │
│  │  Client  │← │ Response   │← │  Antigravity AI   │       │
│  │ (API发送)│  │  Watcher   │  │     Agent         │       │
│  └──────────┘  └────────────┘  └───────────────────┘       │
│                                                             │
│  ┌──────────┐  ┌────────────┐  ┌───────────────────┐       │
│  │StatusBar │  │ Tree View  │  │  Error Watcher    │       │
│  │ (状态栏) │  │ (侧边栏)  │  │  (自动重试)       │       │
│  └──────────┘  └────────────┘  └───────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

**核心数据流：**

```
飞书消息 → WebSocket → MessageQueue → AgentBridge → Antigravity Agent
                                                          │
飞书回复 ← FeishuClient ← ResponseWatcher ← feishu_response.json
```

---

## 🚀 快速开始

### 前置要求

- **[Antigravity](https://antigravity.dev/)** (VS Code fork) 或 VS Code ≥ 1.90.0
- **Node.js** ≥ 18
- **飞书开放平台应用** (需要 App ID 和 App Secret)
- **Windows / macOS**（错误自动重试功能：Windows 使用 UI Automation，macOS 使用 AppleScript + 辅助功能 API）

### 1. 创建飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn/app) 创建一个企业自建应用
2. 在 **凭证与基础信息** 页面获取 `App ID` 和 `App Secret`
3. 在 **权限管理** 中开通以下权限：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message.group_at_msg` — 接收群聊 @ 机器人消息
   - `im:resource` — 上传与下载文件/图片
4. 在 **事件与回调** 中添加事件：
   - `im.message.receive_v1` — 接收消息事件
5. 发布应用版本

### 2. 安装插件

```bash
# 克隆仓库
git clone https://github.com/ast22005-crypto/Antigravity-FeiShuPlugin.git

# 安装依赖
cd Antigravity-FeiShuPlugin
npm install

# 编译
npm run compile

# 打包为 .vsix (可选)
npm run package
```

在 Antigravity / VS Code 中通过 `Extensions: Install from VSIX...` 安装生成的 `.vsix` 文件。

### 3. 配置插件

打开 Settings (`Ctrl + ,`)，搜索 `feishuBot`：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `feishuBot.appId` | string | `""` | 飞书应用 App ID |
| `feishuBot.appSecret` | string | `""` | 飞书应用 App Secret |
| `feishuBot.enabled` | boolean | `true` | 启用飞书集成 |
| `feishuBot.projectName` | string | `""` | 项目名称（留空使用工作区名） |
| `feishuBot.notifyOnOpen` | boolean | `true` | 项目打开时通知飞书 |
| `feishuBot.notifyOnCompletion` | boolean | `true` | Agent 完成后推送结果 |
| `feishuBot.autoTriggerAgent` | boolean | `true` | 收到消息后自动触发 Agent |
| `feishuBot.triggerCooldown` | number | `10` | 自动触发冷却时间（秒） |
| `feishuBot.autoRetryOnError` | boolean | `true` | Agent 出错时自动 Retry |
| `feishuBot.autoRetryInterval` | number | `15` | 自动重试检测间隔（秒） |
| `feishuBot.autoRestartThreshold`| number | `10` | 连续重试达到此次数后，自动重启 Antigravity |

### 4. 开始使用

1. 配置好 App ID 和 App Secret 后，插件会在启动时自动连接飞书 WebSocket
2. 在飞书中给机器人发送第一条消息，双向通信自动激活
3. 后续消息会自动进入队列并触发 AI Agent 处理
4. Agent 处理完成后，结果自动推送到飞书

---

## 📖 使用指南

### 常用命令

在命令面板 (`Ctrl + Shift + P`) 中可以使用以下命令：

| 命令 | 说明 |
|------|------|
| `飞书: 连接` | 连接飞书 WebSocket |
| `飞书: 断开连接` | 断开 WebSocket |
| `飞书: 发送文本消息` | 手动发送文本到飞书 |
| `飞书: 发送处理结果` | 手动推送处理结果 |
| `飞书: 读取消息队列` | 查看当前待处理消息 |
| `飞书: 清空消息队列` | 清空所有消息 |
| `飞书: 手动触发 Agent 处理` | 手动触发 Agent |
| `飞书: 查看状态` | 查看连接 / 队列 / Agent 状态 |
| `飞书: 打开设置` | 快速打开飞书相关设置 |

### 飞书端快捷指令

在飞书聊天中直接发送以下格式的消息，插件会**跳过 Agent 队列**直接响应：

#### 1. 文件传输

```text
发送文件 config.ts
发文件 package.json
找文件 readme
send file extension.ts
```

- 精确匹配时直接发送文件
- 多个匹配时列出候选文件
- 支持模糊搜索（部分文件名匹配）
- 单文件大小限制 30 MB

#### 2. 服务重启

直接发送：

```text
重启
```

- 插件将立即重载 VS Code 窗口，完全重启 Antigravity Agent 并恢复后续队列。

#### 3. 开启新对话

直接发送：

```text
开启新对话
新对话
new conversation
```

- 插件将调用 `antigravity.startNewConversation` 为 Antigravity Agent 开启新对话。

### Agent 响应协议

Agent 处理完飞书任务后，需要在工作区创建 `.antigravity/feishu_response.json`：

```json
{
  "summary": "一句话概括处理结果",
  "details": "详细的处理过程说明（可选）",
  "files": ["修改过的文件列表（可选）"],
  "sendFiles": ["需要发送给用户的文件路径（可选）"]
}
```

插件会自动：
1. 检测到文件 → 读取内容
2. 发送卡片消息到飞书
3. 上传并发送 `sendFiles` 中的文件
4. 清空消息队列，释放 processing 锁
5. 删除响应文件
6. 如有新消息排队，自动触发下一轮处理

---

## 🔧 项目结构

```
FeiShuPlugin/
├── src/
│   ├── extension.ts            # 插件入口，生命周期管理
│   ├── types.ts                # 共享类型定义
│   ├── config/
│   │   └── configManager.ts    # VS Code Settings 读取
│   ├── feishu/
│   │   ├── client.ts           # 飞书 REST API 客户端（Token / 消息 / 文件上传）
│   │   └── listener.ts         # WebSocket 消息监听 + 文件请求处理
│   ├── queue/
│   │   └── messageQueue.ts     # 消息队列（内存 + 文件持久化）
│   ├── agent/
│   │   ├── bridge.ts           # Agent 触发桥接（命令自动发现）
│   │   ├── errorWatcher.ts     # 错误对话框自动重试（PowerShell）
│   │   └── skillInjector.ts    # SKILL.md 自动注入
│   ├── ui/
│   │   ├── statusBar.ts        # 底部状态栏
│   │   └── treeView.ts         # 侧边栏消息列表 & 连接状态
│   └── utils/
│       ├── logger.ts           # 输出通道日志
│       └── fileSearcher.ts     # 工作区文件搜索
├── resources/
│   ├── feishu-icon.svg         # 侧边栏图标
│   ├── auto_retry.ps1          # Windows UI Automation 重试脚本
│   ├── auto_retry_mac.py       # macOS Accessibility API 重试脚本 (Python)
│   ├── hard_restart.ps1        # Windows 硬重启脚本
│   ├── hard_restart_mac.sh     # macOS 硬重启脚本
├── package.json                # 插件清单 & 配置声明
└── tsconfig.json               # TypeScript 编译配置
```

---

## 🛡️ 可靠性保障

| 机制 | 说明 |
|------|------|
| **消息去重** | 基于 `messageId` 的内存 + 队列双重去重 |
| **处理超时保护** | 5 分钟超时自动释放 processing 锁 |
| **错误重试与重启** | 跨平台脚本（Windows PowerShell / macOS Python Accessibility API）自动点击 Retry 并同步次数，连续重试达阈值（默认 10 次）自动重载恢复 |
| **配额异常通知** | 检测到 Model quota reached 时推送飞书通知 |
| **冷却机制** | 可配置的触发冷却时间，防止短时间内重复触发 |
| **队列持久化** | 消息队列写入 `.antigravity/feishu_messages.json`，重启不丢失 |
| **连续处理** | 处理完成后自动检查队列，如有新消息自动触发下一轮 |
| **残留锁清理** | 启动时自动检测并清理上次残留的 processing 锁 |

---

## 🔨 开发

```bash
# 安装依赖
npm install

# 编译（单次）
npm run compile

# 监听模式（开发推荐）
npm run watch

# 打包 .vsix
npm run package
```

### 调试

1. 在 Antigravity / VS Code 中按 `F5` 启动扩展开发宿主
2. 在 Output 面板中选择 `飞书机器人` 通道查看日志
3. 使用侧边栏的「飞书消息」面板查看消息队列和连接状态

### 依赖

| 包名 | 说明 |
|------|------|
| `@larksuiteoapi/node-sdk` | 飞书官方 Node.js SDK（WebSocket 连接） |
| `typescript` | TypeScript 编译器 |
| `@types/vscode` | VS Code 扩展 API 类型定义 |
| `@types/node` | Node.js 类型定义 |

---

## ⚠️ 注意事项

- **自动重试平台支持**: 错误自动重试功能支持 Windows（UI Automation）和 macOS（Python + macOS Accessibility API）。Linux 上该功能不可用，但不影响其他功能正常工作。
- **macOS 辅助功能权限**: 在 macOS 上使用自动重试功能，需要在 **系统设置 → 隐私与安全 → 辅助功能** 中授权 Antigravity 应用。macOS 需要系统自带的 Python 3。
- **安全提醒**: App Secret 等敏感凭证存储在 VS Code Settings 中，请勿将 `.vscode/settings.json` 提交到公开仓库。
- **飞书应用权限**: 确保飞书应用已开通所需的 API 权限并发布了可用版本。
- **网络要求**: WebSocket 连接需要能访问 `open.feishu.cn`。

---

## 📄 License

MIT
