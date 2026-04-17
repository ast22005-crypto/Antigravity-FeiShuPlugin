/**
 * agent/bridge.ts — Trigger Antigravity Agent via VS Code Chat API
 *
 * Replaces the Win32 window-simulation hack (SetForegroundWindow + Ctrl+L)
 * with native VS Code / Antigravity commands.
 *
 * Since Antigravity is a VS Code fork, the exact chat command names differ.
 * We auto-discover the correct command on first use.
 */

import * as vscode from 'vscode';
import { MessageQueue } from '../queue/messageQueue';
import { FeishuConfig } from '../types';
import { logInfo, logWarn, logError, logSuccess } from '../utils/logger';

/**
 * Known candidate commands for opening the chat panel across
 * VS Code, Copilot, Antigravity, Cursor, and other forks.
 */
const CHAT_COMMAND_CANDIDATES = [
    // Antigravity — send prompt directly (BEST match)
    'antigravity.sendPromptToAgentPanel',
    // Antigravity — open/focus agent
    'antigravity.openAgent',
    'antigravity.toggleChatFocus',
    'antigravity.startNewConversation',
    'antigravity.agentSidePanel.focus',
    // VS Code standard
    'workbench.action.chat.open',
    'workbench.action.chat.newChat',
    // Copilot Chat
    'workbench.panel.chat.view.copilot.focus',
];

export class AgentBridge {
    private queue: MessageQueue;
    private config: FeishuConfig;
    private lastTriggerTime = 0;
    private resolvedCommand: string | null = null;
    private discoveryDone = false;

    constructor(queue: MessageQueue, config: FeishuConfig) {
        this.queue = queue;
        this.config = config;
    }

    updateConfig(config: FeishuConfig): void {
        this.config = config;
    }

    /**
     * Discover available chat-related commands in the current IDE and
     * pick the best matching one from our candidates list.
     */
    async discoverChatCommand(): Promise<string | null> {
        if (this.resolvedCommand) {
            return this.resolvedCommand;
        }

        const all = await vscode.commands.getCommands(true);

        // Log all chat-related commands for debugging
        const chatCommands = all.filter(
            c =>
                c.toLowerCase().includes('chat') ||
                c.toLowerCase().includes('agent') ||
                c.toLowerCase().includes('antigravity'),
        );
        logInfo(
            `可用的 Chat/Agent 相关命令 (${chatCommands.length}):\n  ${chatCommands.join('\n  ')}`,
        );

        // Try our candidates first (in priority order)
        for (const candidate of CHAT_COMMAND_CANDIDATES) {
            if (all.includes(candidate)) {
                this.resolvedCommand = candidate;
                logSuccess(`已发现聊天命令: ${candidate}`);
                return candidate;
            }
        }

        // Fallback: find any command that looks like a chat open command
        const fallback = chatCommands.find(
            c =>
                (c.includes('chat') && c.includes('open')) ||
                (c.includes('chat') && c.includes('new')) ||
                (c.includes('chat') && c.includes('focus')),
        );
        if (fallback) {
            this.resolvedCommand = fallback;
            logSuccess(`已发现备选聊天命令: ${fallback}`);
            return fallback;
        }

        logError('未找到任何可用的聊天命令');
        return null;
    }

    /**
     * Trigger the Antigravity Agent to process pending Feishu messages.
     */
    async trigger(): Promise<boolean> {
        const now = Date.now();
        const cooldownMs = this.config.triggerCooldown * 1000;

        if (now - this.lastTriggerTime < cooldownMs) {
            const remaining = Math.ceil(
                (cooldownMs - (now - this.lastTriggerTime)) / 1000,
            );
            logInfo(`冷却中 (剩余 ${remaining}s)，跳过触发`);
            return false;
        }

        if (this.queue.isProcessing()) {
            // If processing is stuck (timed out), release the lock
            if (this.queue.isProcessingTimedOut()) {
                logWarn('处理超时，自动释放锁并重新触发');
                this.queue.clearProcessed();
            } else {
                logInfo('Agent 正在处理中，跳过触发');
                return false;
            }
        }

        const actionableCount = this.queue.getActionableCount();
        if (actionableCount === 0) {
            logInfo('无可处理消息，跳过触发');
            return false;
        }

        // Discover command on first use
        if (!this.discoveryDone) {
            this.discoveryDone = true;
            await this.discoverChatCommand();
        }

        // Build the query from pending messages
        const messages = this.queue.peek();
        const preview = messages
            .filter(m => !m.pendingInstruction)
            .map(m => `[${m.time}] ${m.text}`)
            .join('\n')
            .slice(0, 800);

        const wsPath =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';

        const query = [
            `处理飞书消息队列（${messages.length} 条待处理） --workspace ${wsPath}`,
            '',
            preview,
        ].join('\n');

        // Try discovered command first
        if (this.resolvedCommand) {
            try {
                // antigravity.sendPromptToAgentPanel expects a plain string
                // VS Code workbench.action.chat.open expects { query, isPartialQuery }
                const isAntigravityCmd =
                    this.resolvedCommand.startsWith('antigravity.');
                const arg = isAntigravityCmd
                    ? query
                    : { query, isPartialQuery: false };

                await vscode.commands.executeCommand(
                    this.resolvedCommand,
                    arg,
                );
                this.lastTriggerTime = now;
                this.queue.readAndLock();
                logSuccess(
                    `已触发 Agent 处理 ${messages.length} 条飞书消息 (via ${this.resolvedCommand})`,
                );
                return true;
            } catch (e: any) {
                logWarn(
                    `命令 ${this.resolvedCommand} 执行失败: ${e.message}，尝试备选方案`,
                );
            }
        }

        // Fallback: copy query to clipboard + open chat panel + show notification
        try {
            await vscode.env.clipboard.writeText(query);

            // Try each candidate command until one works
            for (const cmd of CHAT_COMMAND_CANDIDATES) {
                try {
                    await vscode.commands.executeCommand(cmd);
                    this.resolvedCommand = cmd;
                    this.lastTriggerTime = now;
                    this.queue.readAndLock();
                    logSuccess(
                        `已打开聊天面板 (via ${cmd})，消息已复制到剪贴板`,
                    );
                    vscode.window.showInformationMessage(
                        '📨 飞书消息已复制到剪贴板，请粘贴到聊天框中发送',
                    );
                    return true;
                } catch {
                    // try next
                }
            }

            // Ultimate fallback: just show notification
            logWarn('所有聊天命令均不可用，仅显示通知');
            this.queue.readAndLock();
            vscode.window
                .showWarningMessage(
                    `📨 收到 ${messages.length} 条飞书消息（已复制到剪贴板）`,
                    '打开输出日志',
                )
                .then(action => {
                    if (action === '打开输出日志') {
                        vscode.commands.executeCommand(
                            'workbench.action.output.toggleOutput',
                        );
                    }
                });
            this.lastTriggerTime = now;
            return true;
        } catch (e: any) {
            logError(`Agent 触发失败: ${e.message}`);
            return false;
        }
    }
}
