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
    private fileSearcher: FileSearcher;

    private onConnectedCb?: (connected: boolean) => void;
    private onTargetCb?: (target: FeishuTarget) => void;

    constructor(
        config: FeishuConfig,
        client: FeishuClient,
        queue: MessageQueue,
        workspaceRoot?: string,
    ) {
        this.config = config;
        this.client = client;
        this.queue = queue;
        this.workspaceRoot = workspaceRoot || '.';
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
                    `**事件**：收到飞书重启指令，即将重载 VS Code 窗口`,
                    `**时间**：${now}`,
                    '',
                    '---',
                    '> 🔄 窗口即将重载，Antigravity 将完全重启。',
                ].join('\n'),
                'blue',
            );

            // Small delay to let the Feishu message send
            await new Promise(resolve => setTimeout(resolve, 2000));

            logInfo('🔄 收到飞书重启指令，正在重载窗口...');
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch (e: any) {
            logError(`重启处理失败: ${e.message}`);
            await this.client.sendText(`❌ 重启失败: ${e.message}`);
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
