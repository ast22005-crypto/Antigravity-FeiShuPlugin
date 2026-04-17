/**
 * queue/messageQueue.ts — In-memory + file-persisted message queue
 *
 * Manages the lifecycle of Feishu messages:
 *   enqueue → readAndLock (processing) → clearProcessed
 *
 * Emits VS Code events so the UI and Agent bridge can react.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FeishuMessage, QueueData } from '../types';
import { logWarn, logError } from '../utils/logger';

export class MessageQueue {
    private workspaceRoot: string;
    private data: QueueData;

    private _onNewMessage = new vscode.EventEmitter<FeishuMessage[]>();
    readonly onNewMessage = this._onNewMessage.event;

    private _onQueueChange = new vscode.EventEmitter<QueueData>();
    readonly onQueueChange = this._onQueueChange.event;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.data = this.loadFromDisk();
    }

    get queueFilePath(): string {
        return path.join(
            this.workspaceRoot,
            '.antigravity',
            'feishu_messages.json',
        );
    }

    get responseFilePath(): string {
        return path.join(
            this.workspaceRoot,
            '.antigravity',
            'feishu_response.json',
        );
    }

    // ── Queue operations ──────────────────────────────────────────────────

    /** Enqueue a message (dedup by messageId across ALL lists). */
    enqueue(msg: FeishuMessage): {
        isProcessing: boolean;
        queueLength: number;
    } {
        // Dedup against both pending AND processing messages
        const allIds = new Set([
            ...this.data.messages.map(m => m.messageId),
            ...this.data.processingMessages.map(m => m.messageId),
        ]);
        if (allIds.has(msg.messageId)) {
            return {
                isProcessing: this.data.processing,
                queueLength: this.data.messages.length,
            };
        }

        this.data.messages.push(msg);
        this.data.lastUpdated = new Date().toISOString();
        this.persist();
        this._onNewMessage.fire([...this.data.messages]);
        this._onQueueChange.fire(this.snapshot());

        return {
            isProcessing: this.data.processing,
            queueLength: this.data.messages.length,
        };
    }

    /** Read messages without side-effects. */
    peek(): FeishuMessage[] {
        return [...this.data.messages];
    }

    /** Move pending messages into processing state and set the lock. */
    readAndLock(): FeishuMessage[] {
        if (this.data.messages.length === 0) {
            return [];
        }
        const msgs = [...this.data.messages];
        this.data.processingMessages = msgs;
        this.data.messages = [];
        this.data.processing = true;
        this.data.processingSince = new Date().toISOString();
        this.data.lastRead = new Date().toISOString();
        this.persist();
        this._onQueueChange.fire(this.snapshot());
        return msgs;
    }

    /** Number of messages excluding media-only (pending_instruction) items. */
    getActionableCount(): number {
        return this.data.messages.filter(m => !m.pendingInstruction).length;
    }

    getMessageCount(): number {
        return this.data.messages.length;
    }

    getProcessingCount(): number {
        return this.data.processingMessages.length;
    }

    isProcessing(): boolean {
        return this.data.processing;
    }

    /** Check if processing has exceeded the given timeout (in ms). */
    isProcessingTimedOut(timeoutMs: number = 5 * 60 * 1000): boolean {
        if (!this.data.processing || !this.data.processingSince) {
            return false;
        }
        const elapsed =
            Date.now() - new Date(this.data.processingSince).getTime();
        return elapsed > timeoutMs;
    }

    setProcessing(value: boolean): void {
        this.data.processing = value;
        if (value) {
            this.data.processingSince = new Date().toISOString();
        } else {
            this.data.processingSince = undefined;
        }
        this.persist();
        this._onQueueChange.fire(this.snapshot());
    }

    /** Clear completed work. Returns count of NEW messages still waiting. */
    clearProcessed(): number {
        this.data.processingMessages = [];
        this.data.processing = false;
        this.data.processingSince = undefined;
        this.data.cleared = new Date().toISOString();
        this.persist();
        this._onQueueChange.fire(this.snapshot());
        return this.data.messages.length;
    }

    getData(): QueueData {
        return this.snapshot();
    }

    dispose(): void {
        this._onNewMessage.dispose();
        this._onQueueChange.dispose();
    }

    // ── Persistence ───────────────────────────────────────────────────────

    private snapshot(): QueueData {
        return { ...this.data };
    }

    private loadFromDisk(): QueueData {
        const empty: QueueData = {
            messages: [],
            processingMessages: [],
            processing: false,
        };
        try {
            if (!fs.existsSync(this.queueFilePath)) {
                return empty;
            }
            const raw = fs.readFileSync(this.queueFilePath, 'utf-8');
            const d = JSON.parse(raw);
            return {
                messages: d.messages || [],
                processingMessages:
                    d.processing_messages || d.processingMessages || [],
                processing: d.processing || false,
                processingSince:
                    d.processing_since || d.processingSince,
                lastUpdated: d.last_updated || d.lastUpdated,
                lastRead: d.last_read || d.lastRead,
                cleared: d.cleared,
            };
        } catch {
            logWarn('消息队列文件读取失败，使用空队列');
            return empty;
        }
    }

    private persist(): void {
        try {
            const dir = path.dirname(this.queueFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // snake_case keys on disk for compatibility with existing tooling
            const out: Record<string, unknown> = {
                messages: this.data.messages,
                processing_messages: this.data.processingMessages,
                processing: this.data.processing,
            };
            if (this.data.processingSince) {
                out['processing_since'] = this.data.processingSince;
            }
            if (this.data.lastUpdated) {
                out['last_updated'] = this.data.lastUpdated;
            }
            if (this.data.lastRead) {
                out['last_read'] = this.data.lastRead;
            }
            if (this.data.cleared) {
                out['cleared'] = this.data.cleared;
            }
            fs.writeFileSync(
                this.queueFilePath,
                JSON.stringify(out, null, 2),
                'utf-8',
            );
        } catch (e: any) {
            logError(`消息队列写入失败: ${e.message}`);
        }
    }
}
