/**
 * agent/skillInjector.ts — Dynamically inject SKILL.md into the workspace
 *
 * Writes a SKILL.md file to {workspace}/.agents/skills/feishu-bot/
 * so the Antigravity Agent knows how to handle Feishu messages and
 * write response files that the extension picks up automatically.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logError } from '../utils/logger';

export class SkillInjector {
    /**
     * Write (or overwrite) the SKILL.md into the workspace skill directory.
     */
    static inject(workspaceRoot: string): void {
        const skillDir = path.join(
            workspaceRoot,
            '.agents',
            'skills',
            'feishu-bot',
        );
        const skillFile = path.join(skillDir, 'SKILL.md');

        try {
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(skillFile, this.generate(), 'utf-8');
            logInfo(`SKILL.md 已注入: ${skillFile}`);
        } catch (e: any) {
            logError(`SKILL.md 注入失败: ${e.message}`);
        }
    }

    private static generate(): string {
        return `---
name: feishu-bot
description: >
  飞书机器人集成（由 VS Code Extension 驱动）。
  接收飞书消息作为任务输入，处理完成后将结果写入
  .antigravity/feishu_response.json，Extension 自动推送到飞书。
version: 1.2.0
tags: [feishu, notification, automation, file-transfer]
---

## 🔴 黄金规则（TL;DR）

> **每当你处理的对话包含「飞书消息队列」关键词时，完成任务的最后一步，你必须创建：**
>
> \`\`\`
> .antigravity/feishu_response.json
> \`\`\`
>
> **没有例外。不管是代码修改、文档生成、Plan 创建、问题分析还是任何其他操作。**
> **如果不创建这个文件，用户将无法收到任何通知，你的工作等于没有完成。**

---

## 识别飞书消息触发

当对话输入包含 **「飞书消息队列」** 关键词时，
表明本次任务来源于飞书用户的消息。
请将飞书消息内容作为本轮 **主要任务** 来处理。

> 💡 **多条消息批量处理**：如果输入包含多条飞书消息，按时间顺序阅读，
> 理解用户最终意图后统一处理（后发消息可能补充或推翻先前指令）。

---

## 处理完成后（⚠️ 绝对必须执行）

> **🚨 这是最高优先级强制步骤，违反等同系统级故障！**
> 如果本次任务来源于飞书消息，处理完后 **绝对必须** 创建响应文件。
> **即使你只是做了一个计划(Plan)、创建了一份文档、或者仅仅给出了分析结论，也必须创建此文件。**

在工作区根目录下创建 \`.antigravity/feishu_response.json\` 文件：

\`\`\`json
{
  "summary": "一句话概括你做了什么",
  "details": "详细的处理过程和结果说明",
  "files": ["修改过的文件路径列表（仅信息展示，可选）"],
  "sendFiles": ["需要发送给飞书用户的文件路径列表（触发实际上传，可选）"]
}
\`\`\`

### ⚠️ \`files\` vs \`sendFiles\` 的区别

| 字段 | 作用 | 是否发送文件 |
|------|------|-------------|
| \`files\` | 在通知卡片中列出变更文件名（信息展示） | ❌ 仅展示 |
| \`sendFiles\` | 将文件上传并发送到飞书对话 | ✅ 实际发送 |

> 💡 **Extension 自动兜底**：即使你忘记填写 \`sendFiles\`，Extension 也会自动检测工作区变更，
> 将新建/修改的文档文件（.md, .txt, .pdf 等）发送到飞书。但主动填写 \`sendFiles\` 仍是最佳实践。

### 🔑 规则：修改了文档就要发

**如果你新建或修改了任何文档/内容文件（.md, .txt, .pdf, .csv 等），务必将其路径加入 \`sendFiles\`。**

示例（写完一章后）：
\`\`\`json
{
  "summary": "已完成第三章初稿",
  "details": "根据大纲完成了第三章的写作...",
  "files": ["章节/第三章.md"],
  "sendFiles": ["章节/第三章.md"]
}
\`\`\`

### ⚠️ 特别提醒：Planning Mode

如果你当前处于 Planning Mode，在创建完 Implementation Plan 等文档后，
**仍然必须** 创建 \`feishu_response.json\`。示例：

\`\`\`json
{
  "summary": "已创建实施计划，等待审批",
  "details": "根据飞书指令生成了 implementation_plan.md，包含详细的修改方案和步骤。请审查后回复确认。",
  "files": ["implementation_plan.md"]
}
\`\`\`

### ⚠️ JSON 字符串转义规则（必须遵守）

JSON 值中的特殊字符 **必须** 正确转义，否则文件无法解析：
- 双引号 \`"\` → 写为 \`\\"\`（例：\`"画题首字\\"龙\\""\` 而非 \`"画题首字"龙""\`）
- 换行符 → 写为 \`\\n\`
- 反斜杠 \`\\\` → 写为 \`\\\\\`
- 制表符 → 写为 \`\\t\`

> 💡 **建议**：中文引用推荐使用「」或『』代替""，完全避免转义问题。

Extension 会自动：
1. 检测到此文件后读取内容
2. 将结果推送到飞书（卡片消息格式）
3. 如果 \`sendFiles\` 不为空，自动将列表中的文件上传并发送给飞书用户
4. 清空消息队列，释放 processing 锁
5. 删除响应文件

**你不需要手动运行任何命令来发送飞书消息或清空队列！**
只需创建这个 JSON 文件即可。

---

## 文件发送功能

### 用户直接请求（由 Extension 自动处理，不经过 Agent）

用户可以在飞书中发送以下指令，Extension 会直接在项目中搜索并发送文件：
- \`发送文件 xxx\` / \`发文件 xxx\` / \`找文件 xxx\` / \`查文件 xxx\`
- \`send file xxx\` / \`get file xxx\` / \`find file xxx\`

**这类指令不会进入消息队列，Agent 不需要处理。**

### Agent 主动发送文件

当 Agent 处理完任务后需要将文件发送给用户时，
在 \`feishu_response.json\` 中使用 \`sendFiles\` 字段：

\`\`\`json
{
  "summary": "已生成报告",
  "sendFiles": ["reports/output.pdf", "data/result.csv"]
}
\`\`\`

- 路径支持相对路径（相对于工作区根目录）和绝对路径
- 单文件大小限制 30 MB
- 空文件会被跳过

---

## 必须推送的场景（无一例外）

- 处理了飞书消息队列中的任何任务
- 完成了代码修改、文件创建/删除
- 完成了问题排查、BUG 定位、规划类任务并输出了结论
- 执行了用户通过飞书发来的任何指令
- **生成了 Plan / 文档 / 分析报告**
- **即使只是回答了一个问题**

## 可跳过的场景

- 用户明确说"不用通知" / "不要回发"

## ⚠️ 最终检查清单

在你结束本次对话之前，请确认：
- ✅ 本次对话是否来源于飞书消息？（包含「飞书消息队列」关键词）
- ✅ 如果是，是否已创建 \`.antigravity/feishu_response.json\`？
- ✅ 如果还没创建，**现在立即创建！**

## 注意事项

1. App Secret 等凭证不得出现在对话输出中
2. 同一条消息（by message_id）只处理一次
3. 推送失败时仅简短提示，不中断工作流
`;
    }
}
