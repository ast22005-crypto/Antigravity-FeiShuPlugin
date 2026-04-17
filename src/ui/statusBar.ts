/**
 * ui/statusBar.ts — Status bar item showing Feishu connection state
 */

import * as vscode from 'vscode';

export class StatusBar {
    private item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.item.command = 'feishu-bot.showStatus';
        this.setDisconnected();
        this.item.show();
    }

    setConnected(msgCount = 0): void {
        if (msgCount > 0) {
            this.item.text = `$(comment-discussion) 飞书 (${msgCount})`;
            this.item.tooltip = `飞书已连接 · ${msgCount} 条待处理消息`;
            this.item.backgroundColor = new vscode.ThemeColor(
                'statusBarItem.warningBackground',
            );
        } else {
            this.item.text = '$(check) 飞书';
            this.item.tooltip = '飞书已连接 · 无待处理消息';
            this.item.backgroundColor = undefined;
        }
    }

    setDisconnected(): void {
        this.item.text = '$(circle-slash) 飞书';
        this.item.tooltip = '飞书未连接';
        this.item.backgroundColor = undefined;
    }

    setConnecting(): void {
        this.item.text = '$(sync~spin) 飞书';
        this.item.tooltip = '正在连接飞书...';
        this.item.backgroundColor = undefined;
    }

    setProcessing(): void {
        this.item.text = '$(sync~spin) 飞书 处理中';
        this.item.tooltip = 'Agent 正在处理飞书消息...';
        this.item.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground',
        );
    }

    setError(msg: string): void {
        this.item.text = '$(error) 飞书';
        this.item.tooltip = `飞书连接错误: ${msg}`;
        this.item.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.errorBackground',
        );
    }

    setNotConfigured(): void {
        this.item.text = '$(gear) 飞书 未配置';
        this.item.tooltip = '点击配置飞书机器人';
        this.item.command = 'feishu-bot.openSettings';
        this.item.backgroundColor = undefined;
    }

    dispose(): void {
        this.item.dispose();
    }
}
