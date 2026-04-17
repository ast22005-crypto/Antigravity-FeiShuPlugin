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
version: 1.0.0
tags: [feishu, notification, automation]
---

## 识别飞书消息触发

当对话输入包含 **「飞书消息队列」** 关键词时，
表明本次任务来源于飞书用户的消息。
请将飞书消息内容作为本轮 **主要任务** 来处理。

> 💡 **多条消息批量处理**：如果输入包含多条飞书消息，按时间顺序阅读，
> 理解用户最终意图后统一处理（后发消息可能补充或推翻先前指令）。

---

## 处理完成后（⚠️ 绝对必须执行）

> **这是最高强制步骤，违反等同系统级故障！**
> 如果本次任务来源于飞书消息，处理完后 **绝对必须** 创建响应文件。

在工作区根目录下创建 \`.antigravity/feishu_response.json\` 文件：

\`\`\`json
{
  "summary": "一句话概括你做了什么",
  "details": "详细的处理过程和结果说明",
  "files": ["修改过的文件路径列表（可选）"]
}
\`\`\`

Extension 会自动：
1. 检测到此文件后读取内容
2. 将结果推送到飞书（卡片消息格式）
3. 清空消息队列，释放 processing 锁
4. 删除响应文件

**你不需要手动运行任何命令来发送飞书消息或清空队列！**
只需创建这个 JSON 文件即可。

---

## 必须推送的场景

- 处理了飞书消息队列中的任何任务
- 完成了代码修改、文件创建/删除
- 完成了问题排查、BUG 定位、规划类任务并输出了结论
- 执行了用户通过飞书发来的任何指令

## 可跳过的场景

- 用户明确说"不用通知" / "不要回发"

## 注意事项

1. App Secret 等凭证不得出现在对话输出中
2. 同一条消息（by message_id）只处理一次
3. 推送失败时仅简短提示，不中断工作流
`;
    }
}
