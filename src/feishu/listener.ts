/**
 * feishu/listener.ts — Feishu WebSocket message listener
 *
 * Uses the official @larksuiteoapi/node-sdk to establish a persistent
 * WebSocket connection with the Feishu Open Platform.
 * No public IP or domain required.
 */

import { FeishuConfig, FeishuMessage, FeishuTarget } from '../types';
import { FeishuClient } from './client';
import { MessageQueue } from '../queue/messageQueue';
import { logInfo, logError, logWarn, logSuccess } from '../utils/logger';

export class FeishuListener {
    private config: FeishuConfig;
    private client: FeishuClient;
    private queue: MessageQueue;
    private wsClient: any = null;
    private seenIds = new Set<string>();
    private connected = false;

    private onConnectedCb?: (connected: boolean) => void;
    private onTargetCb?: (target: FeishuTarget) => void;

    constructor(
        config: FeishuConfig,
        client: FeishuClient,
        queue: MessageQueue,
    ) {
        this.config = config;
        this.client = client;
        this.queue = queue;
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
