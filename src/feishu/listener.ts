/**
 * feishu/listener.ts — Feishu WebSocket message listener
 *
 * Uses the official @larksuiteoapi/node-sdk to establish a persistent
 * WebSocket connection with the Feishu Open Platform.
 * No public IP or domain required.
 */

import * as vscode from 'vscode';
import { FeishuConfig, FeishuMessage, FeishuTarget } from '../types';
import { FeishuClient } from './client';
import { MessageQueue } from '../queue/messageQueue';
import { FileSearcher } from '../utils/fileSearcher';
import { logInfo, logError, logWarn, logSuccess } from '../utils/logger';
import { recoverFromAuthError } from '../utils/restarter';
import { getAccounts, switchToAccount } from '../utils/managerClient';

/**
 * Regex patterns to detect file-request commands.
 * Captures the query portion after the command keyword.
 */
const FILE_REQUEST_PATTERNS: RegExp[] = [
    /^(?:发送文件|发文件|找文件|查文件|获取文件)\s+(.+)/i,
    /^(?:send\s*file|get\s*file|find\s*file)\s+(.+)/i,
];

/**
 * Patterns to detect a restart command.
 * Matches exactly "重启" (with optional whitespace).
 */
const RESTART_PATTERNS: RegExp[] = [
    /^重启$/,
    /^restart$/i,
];

/**
 * Patterns to detect a new conversation command.
 * Matches exactly "开启新对话" or "新对话" (with optional whitespace).
 */
const NEW_CONVERSATION_PATTERNS: RegExp[] = [
    /^开启新对话$/,
    /^新对话$/,
    /^new\s+conversation$/i,
];

/**
 * Patterns to detect a switch model command.
 * Captures the model name/query portion after the command keyword.
 */
const SWITCH_MODEL_PATTERNS: RegExp[] = [
    /^(?:切换模型|修改模型|使用模型)\s+(.+)/i,
    /^(?:switch\s*model|set\s*model)\s+(.+)/i,
];

/**
 * Patterns to detect a switch planning model command.
 */
const SWITCH_PLAN_MODEL_PATTERNS: RegExp[] = [
    /^(?:切换计划模型|修改计划模型|使用计划模型)\s+(.+)/i,
    /^(?:switch\s*plan\s*model|set\s*plan\s*model)\s+(.+)/i,
];

/**
 * Patterns to detect an account data query command.
 * Matches "账号", "账号数据", "配额", "account data", etc.
 */
const ACCOUNT_DATA_PATTERNS: RegExp[] = [
    /^(?:账号|账号数据|配额|查看账号|查看配额)$/,
    /^(?:account\s*data|accounts|quota)$/i,
];

/**
 * Patterns to detect a switch account command.
 * Captures the email address after the command keyword.
 */
const SWITCH_ACCOUNT_PATTERNS: RegExp[] = [
    /^(?:切换账号|切账号|使用账号)\s+(.+)/i,
    /^(?:switch\s*account|use\s*account)\s+(.+)/i,
];

/** Maximum number of files to list when multiple matches are found */
const MAX_LIST_RESULTS = 10;

export class FeishuListener {
    private config: FeishuConfig;
    private client: FeishuClient;
    private queue: MessageQueue;
    private wsClient: any = null;
    private seenIds = new Set<string>();
    private connected = false;
    private workspaceRoot: string;
    private extensionPath?: string;
    private fileSearcher: FileSearcher;

    private onConnectedCb?: (connected: boolean) => void;
    private onTargetCb?: (target: FeishuTarget) => void;

    constructor(
        config: FeishuConfig,
        client: FeishuClient,
        queue: MessageQueue,
        workspaceRoot?: string,
        extensionPath?: string,
    ) {
        this.config = config;
        this.client = client;
        this.queue = queue;
        this.workspaceRoot = workspaceRoot || '.';
        this.extensionPath = extensionPath;
        this.fileSearcher = new FileSearcher(this.workspaceRoot);
    }

    onConnectionChange(cb: (connected: boolean) => void): void {
        this.onConnectedCb = cb;
    }

    onTargetRecorded(cb: (target: FeishuTarget) => void): void {
        this.onTargetCb = cb;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async start(): Promise<void> {
        // Dynamic import so the extension still loads if lark SDK is missing
        let lark: any;
        try {
            lark = require('@larksuiteoapi/node-sdk');
        } catch {
            logError(
                '缺少飞书 SDK，请在插件目录运行：npm install @larksuiteoapi/node-sdk',
            );
            throw new Error('Missing @larksuiteoapi/node-sdk');
        }

        logInfo('正在连接飞书 WebSocket...');

        try {
            // Build event dispatcher (SDK v1.60 API)
            const dispatcher = new lark.EventDispatcher({}).register({
                'im.message.receive_v1': async (data: any) => {
                    this.handleMessage(data);
                },
            });

            // WSClient constructor takes ONLY appId/appSecret
            this.wsClient = new lark.WSClient({
                appId: this.config.appId,
                appSecret: this.config.appSecret,
                loggerLevel: lark.LoggerLevel?.ERROR,
            });

            // eventDispatcher is passed to start(), NOT the constructor
            await this.wsClient.start({ eventDispatcher: dispatcher });

            this.connected = true;
            this.onConnectedCb?.(true);
            logSuccess('飞书 WebSocket 已连接');
        } catch (e: any) {
            this.connected = false;
            this.onConnectedCb?.(false);
            logError(`WebSocket 连接失败: ${e.message}`);
            throw e;
        }
    }

    stop(): void {
        if (this.wsClient) {
            try {
                // SDK v1.60 uses close() method
                if (typeof this.wsClient.close === 'function') {
                    this.wsClient.close();
                }
            } catch {
                /* ignore */
            }
            this.wsClient = null;
        }
        this.connected = false;
        this.onConnectedCb?.(false);
        logInfo('飞书 WebSocket 已断开');
    }

    // ── Message handler ───────────────────────────────────────────────────

    private handleMessage(data: any): void {
        try {
            // SDK v1.60 EventDispatcher.parse() flattens the structure:
            //   Original: { header: { event_type, ... }, event: { message, sender } }
            //   Parsed:   { event_type, ..., message, sender }
            // So `message` and `sender` are at the TOP level of `data`.
            const message = data.message;
            const sender = data.sender;

            if (!message || !sender) {
                logWarn(`收到未识别的事件格式 (keys: ${Object.keys(data).join(', ')})`);
                return;
            }

            // Ignore messages sent by the bot itself
            if (sender.sender_type === 'bot') {
                return;
            }

            const msgId: string = message.message_id;
            const chatType = message.chat_type as 'p2p' | 'group';
            const chatId: string = message.chat_id || '';
            const openId: string = sender.sender_id?.open_id || '';

            // In-memory dedup
            if (this.seenIds.has(msgId)) {
                return;
            }
            this.seenIds.add(msgId);
            if (this.seenIds.size > 500) {
                const arr = Array.from(this.seenIds);
                this.seenIds = new Set(arr.slice(-250));
            }

            // Parse content
            const msgType: string = message.message_type;
            const text = this.parseContent(msgType, message.content);
            if (!text.trim()) {
                return;
            }

            // Auto-record target on first message
            if (!this.client.hasTarget()) {
                let target: FeishuTarget | null = null;
                if (chatType === 'p2p' && openId) {
                    target = { targetId: openId, targetType: 'p2p' };
                } else if (chatType === 'group' && chatId) {
                    target = { targetId: chatId, targetType: 'group' };
                }
                if (target) {
                    this.client.setTarget(target);
                    this.onTargetCb?.(target);
                    logInfo(
                        `🎯 已自动记录目标 [${chatType}]: ${target.targetId.slice(0, 20)}...`,
                    );
                    this.sendActivation();
                }
            }

            // ── Check for instant commands (handled directly, not queued) ──
            if (msgType === 'text') {
                // Restart command
                if (this.isRestartCommand(text)) {
                    logInfo(`🔄 [${chatType}] 重启指令`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleRestart();
                    return;
                }

                // New conversation command
                if (this.isNewConversationCommand(text)) {
                    logInfo(`💬 [${chatType}] 开启新对话指令`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleNewConversation();
                    return;
                }

                // Switch model command
                const modelQuery = this.extractSwitchModelCommand(text);
                if (modelQuery) {
                    logInfo(`🤖 [${chatType}] 切换模型指令: ${modelQuery}`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleSwitchModel(modelQuery);
                    return;
                }

                // Switch plan model command
                const planModelQuery = this.extractSwitchPlanModelCommand(text);
                if (planModelQuery) {
                    logInfo(`🤖 [${chatType}] 切换计划模型指令: ${planModelQuery}`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleSwitchPlanModel(planModelQuery);
                    return;
                }

                // Switch account command
                const switchAccountEmail = this.extractSwitchAccountCommand(text);
                if (switchAccountEmail) {
                    logInfo(`🔀 [${chatType}] 切换账号指令: ${switchAccountEmail}`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleSwitchAccount(switchAccountEmail);
                    return;
                }

                // Account data command
                if (this.isAccountDataCommand(text)) {
                    logInfo(`📊 [${chatType}] 账号数据查询指令`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleAccountData();
                    return;
                }

                // File-request command
                const fileQuery = this.extractFileQuery(text);
                if (fileQuery) {
                    logInfo(`📂 [${chatType}] 文件请求: ${fileQuery}`);
                    this.client.sendReaction(msgId, 'OK');
                    this.handleFileRequest(fileQuery);
                    return;
                }
            }

            // Media messages — enqueue but wait for follow-up instruction
            const isMedia = msgType === 'image' || msgType === 'file';
            if (isMedia) {
                const feishuMsg: FeishuMessage = {
                    messageId: msgId,
                    chatType,
                    openId,
                    chatId,
                    msgType,
                    text,
                    time: new Date().toISOString(),
                    pendingInstruction: true,
                };
                this.queue.enqueue(feishuMsg);
                logInfo(
                    `📎 [${chatType}] 收到${msgType}，等待指令: ${text.slice(0, 60)}`,
                );
                this.client.sendReaction(msgId, 'OK');
                const label = msgType === 'image' ? '图片' : '文件';
                this.client.sendText(`✅ 已收到${label}，需要怎么处理？`);
                return;
            }

            // Regular text / rich-text message
            const feishuMsg: FeishuMessage = {
                messageId: msgId,
                chatType,
                openId,
                chatId,
                msgType,
                text,
                time: new Date().toISOString(),
            };
            const { isProcessing, queueLength } =
                this.queue.enqueue(feishuMsg);
            logInfo(`📨 [${chatType}] ${text.slice(0, 60)}`);
            this.client.sendReaction(msgId, 'OK');

            if (isProcessing) {
                logInfo(
                    `⏸️ 当前有任务在处理，新消息已入队 (第 ${queueLength} 位)`,
                );
                this.client.sendText(
                    `⏸️ [系统忙碌] 当前有任务正在处理中！\n` +
                        `您的指令已入队 (等待顺位：${queueLength})，完毕后自动执行！`,
                );
            }
        } catch (e: any) {
            logError(`消息处理异常: ${e.message}`);
        }
    }

    // ── Restart handling ──────────────────────────────────────────────────

    /**
     * Check if the message is a restart command.
     */
    private isRestartCommand(text: string): boolean {
        const trimmed = text.trim();
        return RESTART_PATTERNS.some(p => p.test(trimmed));
    }

    /**
     * Handle the restart command:
     *  - Acknowledge to Feishu
     *  - Reload VS Code window to fully restart Antigravity
     */
    private async handleRestart(): Promise<void> {
        try {
            const pn = this.config.projectName || 'Project';
            const now = new Date().toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });

            await this.client.sendCard(
                `🔄 ${pn} · 收到重启指令`,
                [
                    `**项目**：${pn}`,
                    `**事件**：收到飞书重启指令，即将尝试软重启（账号切换）`,
                    `**时间**：${now}`,
                    '',
                    '---',
                    '> 🔄 尝试跨账号切换兜底，从而恢复认证状态。',
                ].join('\n'),
                'blue',
            );

            // Small delay to let the Feishu message send
            await new Promise(resolve => setTimeout(resolve, 2000));

            logInfo('🔄 收到飞书重启指令，尝试执行软重启...');
            
            const result = await recoverFromAuthError();
            if (result === 'switched') {
                await this.client.sendText('✅ 软重启成功：已通过无缝切换账号完成恢复（零停机）');
            } else {
                await this.client.sendText('❌ 软重启失败：未能切换账号。请确认 Manager 已运行且具备可用账号。');
            }
        } catch (e: any) {
            logError(`重启处理失败: ${e.message}`);
            await this.client.sendText(`❌ 重启指令处理出错: ${e.message}`);
        }
    }

    /**
     * Check if the message is a new conversation command.
     */
    private isNewConversationCommand(text: string): boolean {
        const trimmed = text.trim();
        return NEW_CONVERSATION_PATTERNS.some(p => p.test(trimmed));
    }

    /**
     * Handle the new conversation command:
     *  - Acknowledge to Feishu
     *  - Execute VS Code command to start a new Antigravity conversation
     */
    private async handleNewConversation(): Promise<void> {
        try {
            const pn = this.config.projectName || 'Project';
            await this.client.sendCard(
                `💬 ${pn} · 开启新对话`,
                [
                    `**事件**：已触发新建对话指令`,
                    `**状态**：Antigravity Agent 已开启新对话`,
                    '',
                    '---',
                    '> 💡 您现在可以开始新的任务了。'
                ].join('\n'),
                'green',
            );

            logInfo('💬 收到飞书开启新对话指令，正在执行...');
            vscode.commands.executeCommand('antigravity.startNewConversation');
        } catch (e: any) {
            logError(`开启新对话处理失败: ${e.message}`);
            await this.client.sendText(`❌ 开启新对话失败: ${e.message}`);
        }
    }

    // ── Switch Model handling ─────────────────────────────────────────────

    /**
     * Extract the model name query if it matches a switch-model
     * command pattern. Returns null if it is not a switch model request.
     */
    private extractSwitchModelCommand(text: string): string | null {
        const trimmed = text.trim();
        for (const pattern of SWITCH_MODEL_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }
        return null;
    }

    /**
     * Handle the switch model command:
     *  - Acknowledge to Feishu
     *  - Update VS Code Setting for the Antigravity Agent model
     */
    private async handleSwitchModel(modelName: string): Promise<void> {
        try {
            // 唤出 Antigravity 模型选择器 (UI 层面)
            await vscode.commands.executeCommand('antigravity.toggleModelSelector');
            
            // 使用 child_process 调用 Python UI Automation 脚本
            const cp = require('child_process');
            const path = require('path');
            
            if (process.platform === 'darwin') {
                // Mac: 使用专门定制的 Accessibility 接口，不走输入流，直接抓取匹配项然后选中+回车
                const scriptPath = this.extensionPath 
                    ? path.join(this.extensionPath, 'resources', 'select_model_mac.py')
                    : path.join(this.workspaceRoot, 'resources', 'select_model_mac.py');

                const cmd = `python3 "${scriptPath}" "${modelName}"`;

                cp.exec(cmd, async (err: any, stdout: string) => {
                    const result = stdout ? stdout.trim() : '';

                    if (err || result !== 'SUCCESS') {
                        logError(`模型 UI 选择自动化脚本失败: ${err?.message || result}`);
                        await this.client.sendText(`⚠️ 未能在界面中找到选项「${modelName}」，请确保下拉框中有该选项匹配，或手动点击确认。`);
                    } else {
                        const pn = this.config.projectName || 'Project';
                        await this.client.sendCard(
                            `🤖 ${pn} · 模型切换成功`,
                            [
                                `**事件**：已收到飞书切换模型指令`,
                                `**动作**：已精准匹配并选中界面列表项：**${modelName}**`,
                                '',
                                '---',
                                '> 💡 已成功联动前台 UI 的无输入式选择。'
                            ].join('\n'),
                            'green',
                        );
                        logInfo(`✅ 成功向 Antigravity 选中模型项: ${modelName}`);
                    }
                });
            } else if (process.platform === 'win32') {
                const scriptPath = this.extensionPath 
                    ? path.join(this.extensionPath, 'resources', 'select_model.ps1')
                    : path.join(this.workspaceRoot, 'resources', 'select_model.ps1');

                const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" "${modelName}"`;

                cp.exec(cmd, async (err: any, stdout: string) => {
                    const result = stdout ? stdout.trim() : '';
                    if (err || !result.includes('SUCCESS')) {
                        logError(`模型 UI 选择自动化脚本失败: ${err?.message || result}`);
                        await this.client.sendText(`⚠️ 自动化选取失败，请手动在弹出的界面选择模型: ${modelName}`);
                    } else {
                        const pn = this.config.projectName || 'Project';
                        await this.client.sendCard(
                            `🤖 ${pn} · 模型切换成功`,
                            [
                                `**事件**：已收到飞书切换模型指令`,
                                `**动作**：已在 Windows 环境唤起面板并选中：**${modelName}**`,
                                '',
                                '---',
                                '> 💡 已成功联动前台 UI 的无输入式选择。'
                            ].join('\n'),
                            'green',
                        );
                        logInfo(`✅ 成功向 Antigravity 选中模型项: ${modelName}`);
                    }
                });
            }

        } catch (e: any) {
            logError(`唤醒模型选择面板遇到错误: ${e.message}`);
            await this.client.sendText(`❌ 执行失败: ${e.message}`);
        }
    }

    /**
     * Extract the plan model name query if it matches a switch-plan-model
     * command pattern. Returns null if it is not a switch plan model request.
     */
    private extractSwitchPlanModelCommand(text: string): string | null {
        const trimmed = text.trim();
        for (const pattern of SWITCH_PLAN_MODEL_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }
        return null;
    }

    /**
     * Handle the switch plan model command:
     *  - Acknowledge to Feishu
     *  - Update VS Code Setting for the Antigravity Agent Planning mode model
     */
    private async handleSwitchPlanModel(modelName: string): Promise<void> {
        try {
            await vscode.commands.executeCommand('antigravity.togglePlanningModeSelector');
            
            const cp = require('child_process');
            const path = require('path');
            
            if (process.platform === 'darwin') {
                const scriptPath = this.extensionPath 
                    ? path.join(this.extensionPath, 'resources', 'select_model_mac.py')
                    : path.join(this.workspaceRoot, 'resources', 'select_model_mac.py');

                const cmd = `python3 "${scriptPath}" "${modelName}"`;

                cp.exec(cmd, async (err: any, stdout: string) => {
                    const result = stdout ? stdout.trim() : '';
                    if (err || result !== 'SUCCESS') {
                        logError(`计划模型 UI 自动化脚本失败: ${err?.message || result}`);
                        await this.client.sendText(`⚠️ 未能在面板找到「${modelName}」，请手动确认选项。`);
                    } else {
                        const pn = this.config.projectName || 'Project';
                        await this.client.sendCard(
                            `🤖 ${pn} · 计划模型切换成功`,
                            [
                                `**事件**：已收到飞书切换计划模型指令`,
                                `**动作**：已精准匹配并选中计划模型：**${modelName}**`,
                            ].join('\n'),
                            'green',
                        );
                        logInfo(`✅ 成功向 Antigravity 选中计划模型项: ${modelName}`);
                    }
                });
            } else if (process.platform === 'win32') {
                const scriptPath = this.extensionPath 
                    ? path.join(this.extensionPath, 'resources', 'select_model.ps1')
                    : path.join(this.workspaceRoot, 'resources', 'select_model.ps1');

                const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" "${modelName}"`;

                cp.exec(cmd, async (err: any, stdout: string) => {
                    const result = stdout ? stdout.trim() : '';
                    if (err || !result.includes('SUCCESS')) {
                        logError(`计划模型 UI 自动化脚本失败: ${err?.message || result}`);
                        await this.client.sendText(`⚠️ 自动化选取失败，请手动确认选项。`);
                    } else {
                        const pn = this.config.projectName || 'Project';
                        await this.client.sendCard(
                            `🤖 ${pn} · 计划模型切换成功`,
                            [
                                `**事件**：已收到飞书切换计划模型指令`,
                                `**动作**：已在 Windows 环境唤起面板并选中：**${modelName}**`,
                            ].join('\n'),
                            'green',
                        );
                        logInfo(`✅ 成功向 Antigravity 选中计划模型项: ${modelName}`);
                    }
                });
            }

        } catch (e: any) {
            logError(`唤醒计划模型选择面板遇到错误: ${e.message}`);
            await this.client.sendText(`❌ 计划模型切换指令失败: ${e.message}`);
        }
    }

    // ── Account data handling ─────────────────────────────────────────────

    /**
     * Check if the message is an account data query command.
     */
    private isAccountDataCommand(text: string): boolean {
        const trimmed = text.trim();
        return ACCOUNT_DATA_PATTERNS.some(p => p.test(trimmed));
    }

    /**
     * Handle the account data command:
     *  - Fetch all accounts from Manager
     *  - Extract gemini-3.1-pro-high and claude-opus-4-6-thinking percentages
     *  - Send report card to Feishu
     */
    private async handleAccountData(): Promise<void> {
        try {
            const accounts = await getAccounts();
            if (accounts.length === 0) {
                await this.client.sendText('❌ 未获取到任何账号数据（Manager 可能未运行）');
                return;
            }

            const TARGET_MODELS = ['gemini-3.1-pro-high', 'claude-opus-4-6-thinking'];

            const lines: string[] = [];
            for (const account of accounts) {
                const email = account.email || account.id;
                const currentTag = account.is_current ? ' 🟢' : '';
                lines.push(`**${email}**${currentTag}`);

                for (const modelName of TARGET_MODELS) {
                    const model = account.quota?.models?.find(m => m.name === modelName);
                    const pct = model ? `${model.percentage}%` : 'N/A';
                    let reset_time = 'N/A';
                    if (model?.reset_time) {
                        // API returns UTC time — convert to local timezone
                        const utcDate = new Date(model.reset_time.endsWith('Z') ? model.reset_time : model.reset_time + 'Z');
                        reset_time = utcDate.toLocaleString('zh-CN', {
                            year: 'numeric', month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit', second: '2-digit',
                            hour12: false,
                        });
                    }
                    lines.push(`  · \`${modelName}\`: **${pct}** (重置时间: ${reset_time})`);
                }
                lines.push('');
            }

            const now = new Date().toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });

            await this.client.sendCard(
                `📊 账号配额报告`,
                [
                    `**账号总数**：${accounts.length}`,
                    '',
                    '---',
                    '',
                    ...lines,
                    '---',
                    `**⏰ 查询时间**：${now}`,
                ].join('\n'),
                'blue',
            );

            logSuccess('账号配额数据已通过飞书指令发送');
        } catch (e: any) {
            logError(`账号数据查询失败: ${e.message}`);
            await this.client.sendText(`❌ 获取账号数据失败: ${e.message}`);
        }
    }

    // ── Switch account handling ───────────────────────────────────────────

    /**
     * Extract the email from a switch-account command.
     * Returns null if the message is not a switch account request.
     */
    private extractSwitchAccountCommand(text: string): string | null {
        const trimmed = text.trim();
        for (const pattern of SWITCH_ACCOUNT_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }
        return null;
    }

    /**
     * Handle the switch account command:
     *  - Fetch all accounts from Manager
     *  - Find the account matching the given email
     *  - Switch to that account
     *  - Report result to Feishu
     */
    private async handleSwitchAccount(email: string): Promise<void> {
        try {
            const accounts = await getAccounts();
            if (accounts.length === 0) {
                await this.client.sendText('❌ 未获取到任何账号数据（Manager 可能未运行）');
                return;
            }

            // Find account by email (case-insensitive partial match)
            const emailLower = email.toLowerCase();
            const target = accounts.find(
                a => a.email?.toLowerCase() === emailLower,
            ) || accounts.find(
                a => a.email?.toLowerCase().includes(emailLower),
            );

            if (!target) {
                const availableEmails = accounts
                    .map(a => `• \`${a.email || a.id}\`${a.is_current ? ' 🟢' : ''}`)
                    .join('\n');
                await this.client.sendCard(
                    '❌ 未找到匹配的账号',
                    [
                        `未找到邮箱匹配「${email}」的账号。`,
                        '',
                        '**可用账号：**',
                        availableEmails,
                        '',
                        '💡 请使用完整邮箱名，例如：`切换账号 user@gmail.com`',
                    ].join('\n'),
                    'orange',
                );
                return;
            }

            if (target.is_current) {
                await this.client.sendText(`ℹ️ 账号 \`${target.email}\` 已经是当前活跃账号，无需切换。`);
                return;
            }

            const pn = this.config.projectName || 'Project';
            await this.client.sendText(`🔄 正在切换到账号: ${target.email}...`);

            const ok = await switchToAccount(target.id, target.email);

            if (ok) {
                await this.client.sendCard(
                    `✅ ${pn} · 账号切换成功`,
                    [
                        `**目标账号**：${target.email}`,
                        `**状态**：已成功切换`,
                        '',
                        '---',
                        '> 💡 新账号已生效，后续操作将使用该账号。',
                    ].join('\n'),
                    'green',
                );
                logSuccess(`飞书指令切换账号成功: ${target.email}`);
            } else {
                await this.client.sendText(`❌ 切换到账号 \`${target.email}\` 失败，请检查 Manager 状态。`);
            }
        } catch (e: any) {
            logError(`切换账号失败: ${e.message}`);
            await this.client.sendText(`❌ 切换账号失败: ${e.message}`);
        }
    }

    // ── File request handling ─────────────────────────────────────────────


    /**
     * Extract the file query from a text message if it matches a file-request
     * command pattern. Returns null if the message is not a file request.
     */
    private extractFileQuery(text: string): string | null {
        const trimmed = text.trim();
        for (const pattern of FILE_REQUEST_PATTERNS) {
            const match = trimmed.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }
        return null;
    }

    /**
     * Handle a file-request command:
     *  - Search for matching files in the workspace
     *  - 0 results: notify user
     *  - 1 result: upload and send immediately
     *  - 2~10 results: show a list for the user to identify
     *  - >10 results: ask user to refine the query
     */
    private async handleFileRequest(query: string): Promise<void> {
        try {
            const results = this.fileSearcher.search(query);

            if (results.length === 0) {
                await this.client.sendText(
                    `❌ 未找到匹配「${query}」的文件。\n\n` +
                    `💡 提示：\n` +
                    `• 试试文件名关键词，如 \`发送文件 config\`\n` +
                    `• 支持部分匹配，如 \`发送文件 extension\``,
                );
                return;
            }

            if (results.length === 1) {
                const file = results[0];
                await this.client.sendText(
                    `📂 找到文件: \`${file.relativePath}\` (${FileSearcher.formatSize(file.size)})\n正在上传...`,
                );

                const ok = await this.client.uploadAndSendFile(
                    file.absolutePath,
                );
                if (!ok) {
                    await this.client.sendText(
                        `❌ 文件上传失败: ${file.relativePath}`,
                    );
                }
                return;
            }

            if (results.length > MAX_LIST_RESULTS) {
                // Too many results — show first 10 and ask to refine
                const listLines = results
                    .slice(0, MAX_LIST_RESULTS)
                    .map(
                        (f, i) =>
                            `${i + 1}. \`${f.relativePath}\` (${FileSearcher.formatSize(f.size)})`,
                    )
                    .join('\n');

                await this.client.sendCard(
                    `📂 匹配结果过多 (${results.length} 个)`,
                    `关键词「${query}」匹配到太多文件，请提供更精确的名称。\n\n` +
                    `**前 ${MAX_LIST_RESULTS} 个匹配：**\n${listLines}\n\n` +
                    `💡 发送完整文件名可精确定位，例如：\n\`发送文件 ${results[0].relativePath}\``,
                    'orange',
                );
                return;
            }

            // 2~10 results — show list, send all exact-name matches or ask
            // Check if there are exact filename matches
            const queryLower = query.toLowerCase();
            const exactMatches = results.filter(
                f =>
                    f.relativePath
                        .split(/[/\\]/)
                        .pop()
                        ?.toLowerCase() === queryLower,
            );

            if (exactMatches.length === 1) {
                // Only one exact name match among multiple partial matches — send it
                const file = exactMatches[0];
                await this.client.sendText(
                    `📂 精确匹配: \`${file.relativePath}\` (${FileSearcher.formatSize(file.size)})\n正在上传...`,
                );
                const ok = await this.client.uploadAndSendFile(
                    file.absolutePath,
                );
                if (!ok) {
                    await this.client.sendText(
                        `❌ 文件上传失败: ${file.relativePath}`,
                    );
                }
                return;
            }

            // Multiple matches — show all and let user pick
            const listLines = results
                .map(
                    (f, i) =>
                        `${i + 1}. \`${f.relativePath}\` (${FileSearcher.formatSize(f.size)})`,
                )
                .join('\n');

            await this.client.sendCard(
                `📂 找到 ${results.length} 个匹配文件`,
                `关键词「${query}」匹配到以下文件：\n\n${listLines}\n\n` +
                `💡 请发送完整路径来获取指定文件，例如：\n\`发送文件 ${results[0].relativePath}\``,
                'blue',
            );
        } catch (e: any) {
            logError(`文件请求处理失败: ${e.message}`);
            await this.client.sendText(
                `❌ 文件查找出错: ${e.message}`,
            );
        }
    }

    // ── Content parser ────────────────────────────────────────────────────

    private parseContent(msgType: string, contentRaw: string): string {
        try {
            const content = JSON.parse(contentRaw);

            if (typeof content !== 'object' || content === null) {
                return String(content).trim();
            }

            if (msgType === 'text') {
                return (content.text || '').trim();
            }

            if (msgType === 'post') {
                const parts: string[] = [];
                for (const langContent of Object.values(content)) {
                    if (
                        typeof langContent !== 'object' ||
                        langContent === null
                    ) {
                        continue;
                    }
                    const lc = langContent as any;
                    if (lc.title) {
                        parts.push(lc.title);
                    }
                    for (const row of lc.content || []) {
                        if (!Array.isArray(row)) {
                            continue;
                        }
                        for (const elem of row) {
                            if (typeof elem === 'object' && elem.text) {
                                parts.push(elem.text);
                            }
                        }
                    }
                }
                return parts.join(' ').trim();
            }

            if (msgType === 'image') {
                const key = content.image_key || '';
                return key ? `[image:${key}]` : '[image]';
            }

            if (msgType === 'file') {
                const key = content.file_key || '';
                const name = content.file_name || '';
                if (key) {
                    return name
                        ? `[file:${key}:${name}]`
                        : `[file:${key}]`;
                }
                return '[file]';
            }

            return `[${msgType}]`;
        } catch {
            return contentRaw || '';
        }
    }

    private async sendActivation(): Promise<void> {
        const pn = this.config.projectName || 'Project';
        await this.client.sendText(
            `✅ 双向通信已激活！\n` +
                `我是「${pn}」的 Antigravity AI 助手。\n` +
                `发指令给我，我会立即处理并回复结果。`,
        );
    }
}
