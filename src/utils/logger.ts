import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('飞书机器人');
    }
    return channel;
}

function ts(): string {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function logInfo(msg: string): void {
    getChannel().appendLine(`[${ts()}] ℹ️  ${msg}`);
}

export function logWarn(msg: string): void {
    getChannel().appendLine(`[${ts()}] ⚠️  ${msg}`);
}

export function logError(msg: string): void {
    getChannel().appendLine(`[${ts()}] ❌ ${msg}`);
}

export function logSuccess(msg: string): void {
    getChannel().appendLine(`[${ts()}] ✅ ${msg}`);
}

export function showOutputChannel(): void {
    getChannel().show(true);
}

export function disposeLogger(): void {
    channel?.dispose();
    channel = undefined;
}
