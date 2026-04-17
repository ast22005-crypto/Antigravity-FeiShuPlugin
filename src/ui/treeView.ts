/**
 * ui/treeView.ts — Sidebar tree views for messages and connection status
 */

import * as vscode from 'vscode';
import { FeishuMessage } from '../types';

// ── Message list tree ─────────────────────────────────────────────────────

class MessageTreeItem extends vscode.TreeItem {
    constructor(msg: FeishuMessage) {
        super(
            msg.text.slice(0, 80) || `[${msg.msgType}]`,
            vscode.TreeItemCollapsibleState.None,
        );

        const ts = new Date(msg.time).toLocaleTimeString('zh-CN', {
            hour12: false,
        });
        this.description = ts;
        this.tooltip = `[${msg.chatType}] ${msg.text}\n${msg.time}`;

        if (msg.pendingInstruction) {
            this.iconPath = new vscode.ThemeIcon('file-media');
        } else if (msg.msgType === 'text' || msg.msgType === 'post') {
            this.iconPath = new vscode.ThemeIcon('comment');
        } else {
            this.iconPath = new vscode.ThemeIcon('file');
        }
    }
}

export class MessageTreeProvider
    implements vscode.TreeDataProvider<vscode.TreeItem>
{
    private _onChange = new vscode.EventEmitter<
        vscode.TreeItem | undefined
    >();
    readonly onDidChangeTreeData = this._onChange.event;

    private messages: FeishuMessage[] = [];

    refresh(messages: FeishuMessage[]): void {
        this.messages = messages;
        this._onChange.fire(undefined);
    }

    getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
        return el;
    }

    getChildren(): vscode.TreeItem[] {
        if (this.messages.length === 0) {
            const empty = new vscode.TreeItem(
                '暂无消息',
                vscode.TreeItemCollapsibleState.None,
            );
            empty.description = '等待飞书消息...';
            empty.iconPath = new vscode.ThemeIcon('inbox');
            return [empty];
        }
        return this.messages.map(m => new MessageTreeItem(m));
    }

    dispose(): void {
        this._onChange.dispose();
    }
}

// ── Connection status tree ────────────────────────────────────────────────

class StatusItem extends vscode.TreeItem {
    constructor(label: string, value: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = value;
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

export class ConnectionStatusProvider
    implements vscode.TreeDataProvider<vscode.TreeItem>
{
    private _onChange = new vscode.EventEmitter<
        vscode.TreeItem | undefined
    >();
    readonly onDidChangeTreeData = this._onChange.event;

    private connected = false;
    private hasTarget = false;
    private processing = false;
    private messageCount = 0;

    update(state: {
        connected: boolean;
        hasTarget: boolean;
        processing: boolean;
        messageCount: number;
    }): void {
        this.connected = state.connected;
        this.hasTarget = state.hasTarget;
        this.processing = state.processing;
        this.messageCount = state.messageCount;
        this._onChange.fire(undefined);
    }

    getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
        return el;
    }

    getChildren(): vscode.TreeItem[] {
        return [
            new StatusItem(
                'WebSocket',
                this.connected ? '已连接' : '未连接',
                this.connected ? 'pass' : 'error',
            ),
            new StatusItem(
                '双向通信',
                this.hasTarget ? '已激活' : '等待首次消息',
                this.hasTarget ? 'pass' : 'watch',
            ),
            new StatusItem(
                '待处理消息',
                `${this.messageCount} 条`,
                this.messageCount > 0 ? 'mail' : 'inbox',
            ),
            new StatusItem(
                'Agent',
                this.processing ? '处理中...' : '空闲',
                this.processing ? 'sync~spin' : 'check',
            ),
        ];
    }

    dispose(): void {
        this._onChange.dispose();
    }
}
