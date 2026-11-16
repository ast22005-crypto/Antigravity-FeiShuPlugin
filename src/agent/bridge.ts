/**
 * agent/bridge.ts — Trigger Antigravity Agent via VS Code Chat API
 *
 * Supports both:
 *  - New Antigravity IDE (`google.google-antigravity` / `agy` webview):
 *    uses `antigravity.addContext` + `antigravity.triggerSend`
 *    (NOTE: `antigravity.sendPromptToAgentPanel` still exists in the workbench
 *     as a dead stub for the retired legacy panel and MUST NOT be preferred
 *     when `antigravity.triggerSend` is available).
 *  - Legacy Antigravity IDE / VS Code / Copilot forks:
 *    falls back to `antigravity.sendPromptToAgentPanel`, `workbench.action.chat.open`,
 *    or focusing the chat panel + copying the prompt to clipboard.
 */

import * as vscode from 'vscode';
import { MessageQueue } from '../queue/messageQueue';
import { FeishuConfig } from '../types';
import { logInfo, logWarn, logError, logSuccess } from '../utils/logger';

/** Sentinel representing the new Antigravity IDE two-step RPC trigger */
const AGY_CONTEXT_SEND_MODE = 'antigravity.addContext+triggerSend';

/**
 * Candidate commands for directly submitting a prompt (legacy Antigravity & VS Code).
 * Only checked AFTER verifying that the new `agy` two-step mode is not available.
 */
const DIRECT_SEND_CANDIDATES = [
    // Legacy Antigravity — send prompt directly (only works on pre-agy IDE)
    'antigravity.sendPromptToAgentPanel',
    // VS Code standard
    'workbench.action.chat.open',
    'workbench.action.chat.newChat',
];

/**
 * Candidate commands for opening/focusing the chat panel (clipboard fallback).
 */
const FOCUS_PANEL_CANDIDATES = [
    'antigravity.panel.focus',
    'antigravity.openAgent',
    'antigravity.toggleChatFocus',
    'antigravity.startNewConversation',
    'antigravity.agentSidePanel.focus',
    'workbench.action.chat.open',
    'workbench.action.chat.newChat',
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
     * Ensure the built-in Antigravity extension (`google.google-antigravity`
     * or `google.antigravity`) is activated so its commands are registered.
     */
    private async ensureAntigravityActivated(): Promise<void> {
        const extIds = ['google.google-antigravity', 'google.antigravity'];
        for (const id of extIds) {
            const ext = vscode.extensions.getExtension(id);
            if (ext && !ext.isActive) {
                try {
                    await ext.activate();
                    logInfo(`已激活内置扩展: ${id}`);
                } catch (e: any) {
                    logWarn(`激活扩展 ${id} 失败: ${e.message}`);
                }
            }
        }
    }

    /**
     * Discover available chat-related commands in the current IDE and
     * pick the best matching one.
     */
    async discoverChatCommand(): Promise<string | null> {
        if (this.resolvedCommand) {
            return this.resolvedCommand;
        }

        await this.ensureAntigravityActivated();

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

        // 1. New Antigravity IDE (`google.google-antigravity` / `agy` webview):
        //    Must take priority over `antigravity.sendPromptToAgentPanel`, which
        //    remains registered as a dead workbench stub in new Antigravity IDE.
        if (
            all.includes('antigravity.addContext') &&
            all.includes('antigravity.triggerSend')
        ) {
            this.resolvedCommand = AGY_CONTEXT_SEND_MODE;
            logSuccess(
                `已发现新版 Antigravity 聊天指令组合: antigravity.addContext + antigravity.triggerSend`,
            );
            return this.resolvedCommand;
        }

        // 2. Direct send commands (legacy Antigravity IDE / standard VS Code)
        for (const candidate of DIRECT_SEND_CANDIDATES) {
            if (all.includes(candidate)) {
                this.resolvedCommand = candidate;
                logSuccess(`已发现聊天命令: ${candidate}`);
                return candidate;
            }
        }

        // 3. Fallback: find any command that looks like a chat open command
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
     * Send prompt into the new Antigravity IDE (`google.google-antigravity`) panel
     * using `antigravity.addContext` followed by `antigravity.triggerSend`.
     */
    private async sendViaAgyPanel(query: string): Promise<void> {
        await this.ensureAntigravityActivated();

        try {
            await vscode.commands.executeCommand('antigravity.addContext', query);
        } catch (firstErr: any) {
            // If the Antigravity sidebar was left on a non-chat subpage (e.g. History /
            // Customizations / Settings), the Lexical chat editor is not mounted yet.
            // `antigravity.startNewConversation` is handled at the app root and navigates
            // back to a live chat input box so `addContext` can succeed.
            logWarn(
                `antigravity.addContext 首次写入失败 (${firstErr.message})，尝试开启新对话页面后重试...`,
            );
            await vscode.commands.executeCommand('antigravity.startNewConversation');
            await this.sleep(600);
            await vscode.commands.executeCommand('antigravity.addContext', query);
        }

        // Brief settle delay before triggering submission
        await this.sleep(150);
        await vscode.commands.executeCommand('antigravity.triggerSend');
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

        // Discover command on first use (or re-discover if previous discovery failed)
        if (!this.discoveryDone || !this.resolvedCommand) {
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
                if (this.resolvedCommand === AGY_CONTEXT_SEND_MODE) {
                    await this.sendViaAgyPanel(query);
                } else {
                    // Legacy antigravity.sendPromptToAgentPanel expects a plain string;
                    // VS Code workbench.action.chat.open expects { query, isPartialQuery }.
                    const isAntigravityCmd =
                        this.resolvedCommand.startsWith('antigravity.');
                    const arg = isAntigravityCmd
                        ? query
                        : { query, isPartialQuery: false };

                    await vscode.commands.executeCommand(
                        this.resolvedCommand,
                        arg,
                    );
                }

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
                // Reset resolvedCommand so next trigger can re-discover if needed
                this.resolvedCommand = null;
            }
        }

        // Fallback: copy query to clipboard + open chat panel + show notification
        try {
            await vscode.env.clipboard.writeText(query);

            // Try each focus candidate command until one works
            for (const cmd of FOCUS_PANEL_CANDIDATES) {
                try {
                    await vscode.commands.executeCommand(cmd);
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

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
