/**
 * agent/errorWatcher.ts — Auto-retry on Antigravity Agent error dialogs
 *
 * Periodically runs a PowerShell script that uses Windows UI Automation
 * to detect the "Agent terminated due to error" notification and
 * programmatically click the "Retry" button.
 *
 * Also detects "Model quota reached" dialogs and notifies via event.
 *
 * This keeps automated Feishu→Agent workflows running unattended.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { logInfo, logWarn, logError, logSuccess } from '../utils/logger';

const DEFAULT_CHECK_INTERVAL_MS = 15_000; // 15 seconds
const EXEC_TIMEOUT_MS = 10_000;           // single-run timeout

/** Types of errors detected by the watcher */
export type ErrorType = 'retry' | 'quota';

export interface ErrorEvent {
    type: ErrorType;
    count: number;
    detail?: string;
}

export class ErrorWatcher {
    private timer: ReturnType<typeof setInterval> | undefined;
    private checking = false;
    private scriptPath: string;
    private retryCount = 0;
    private quotaCount = 0;
    private intervalMs: number;

    /** Fires when the Retry button was successfully clicked. */
    private _onRetryTriggered = new vscode.EventEmitter<number>();
    readonly onRetryTriggered = this._onRetryTriggered.event;

    /** Fires when any Antigravity error is detected (retry, quota, etc). */
    private _onErrorDetected = new vscode.EventEmitter<ErrorEvent>();
    readonly onErrorDetected = this._onErrorDetected.event;

    constructor(extensionPath: string, intervalMs?: number) {
        this.scriptPath = path.join(
            extensionPath,
            'resources',
            'auto_retry.ps1',
        );
        this.intervalMs = intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    start(): void {
        if (this.timer) {
            return;
        }
        logInfo(
            `🔄 Agent 错误自动重试监控已启动 (每 ${this.intervalMs / 1000}s 检查)`,
        );
        // Run once immediately, then on interval
        this.check();
        this.timer = setInterval(() => this.check(), this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        logInfo('Agent 错误自动重试监控已停止');
    }

    isRunning(): boolean {
        return !!this.timer;
    }

    getRetryCount(): number {
        return this.retryCount;
    }

    getQuotaCount(): number {
        return this.quotaCount;
    }

    dispose(): void {
        this.stop();
        this._onRetryTriggered.dispose();
        this._onErrorDetected.dispose();
    }

    // ── Core check ────────────────────────────────────────────────────────

    private async check(): Promise<void> {
        if (this.checking) {
            return;
        }
        this.checking = true;
        try {
            const result = await this.runPowerShell();

            // Parse result — some results include "|detail" suffix
            const [status, detail] = this.parseResult(result);

            switch (status) {
                case 'RETRY_CLICKED':
                    this.retryCount++;
                    logSuccess(
                        `✅ 自动点击了 Retry 按钮 (第 ${this.retryCount} 次)`,
                    );
                    vscode.window.showInformationMessage(
                        `🔄 Antigravity Agent 错误已自动重试 (第 ${this.retryCount} 次)`,
                    );
                    this._onRetryTriggered.fire(this.retryCount);
                    this._onErrorDetected.fire({
                        type: 'retry',
                        count: this.retryCount,
                    });
                    break;

                case 'QUOTA_REACHED':
                    this.quotaCount++;
                    logWarn(
                        `⚠️ 检测到 Model quota reached (第 ${this.quotaCount} 次): ${detail || '未知详情'}`,
                    );
                    vscode.window.showWarningMessage(
                        `⚠️ Model quota reached — ${detail || '配额已用尽'}`,
                    );
                    this._onErrorDetected.fire({
                        type: 'quota',
                        count: this.quotaCount,
                        detail: detail || undefined,
                    });
                    break;

                case 'QUOTA_DISMISSED':
                    this.quotaCount++;
                    logWarn(
                        `⚠️ 已关闭 Model quota 弹框 (第 ${this.quotaCount} 次): ${detail || '未知详情'}`,
                    );
                    vscode.window.showWarningMessage(
                        `⚠️ Model quota reached (已自动关闭) — ${detail || '配额已用尽'}`,
                    );
                    this._onErrorDetected.fire({
                        type: 'quota',
                        count: this.quotaCount,
                        detail: detail || undefined,
                    });
                    break;

                case 'RETRY_NOT_FOUND':
                    logWarn(
                        '检测到 Agent 错误弹框，但未找到 Retry 按钮',
                    );
                    break;

                case 'INVOKE_FAILED':
                    logError('找到 Retry 按钮但点击失败');
                    break;

                case 'NO_ERROR':
                    // Normal — no error dialog present, do nothing
                    break;

                default:
                    // Unexpected output
                    break;
            }
        } catch {
            // PowerShell execution failed (e.g. timeout) — silently ignore
        } finally {
            this.checking = false;
        }
    }

    // ── Result parser ─────────────────────────────────────────────────────

    private parseResult(raw: string): [string, string] {
        const idx = raw.indexOf('|');
        if (idx === -1) {
            return [raw, ''];
        }
        return [raw.slice(0, idx), raw.slice(idx + 1)];
    }

    // ── PowerShell bridge ─────────────────────────────────────────────────

    private runPowerShell(): Promise<string> {
        return new Promise((resolve, reject) => {
            const cmd = [
                'powershell.exe',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                '-File', `"${this.scriptPath}"`,
            ].join(' ');

            exec(cmd, { timeout: EXEC_TIMEOUT_MS }, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }
}
