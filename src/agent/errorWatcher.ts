/**
 * agent/errorWatcher.ts — Auto-retry on Antigravity Agent error dialogs
 *
 * Periodically runs a platform-specific script that uses UI Automation
 * to detect the "Agent terminated due to error" notification and
 * programmatically click the "Retry" button.
 *
 * Supported platforms:
 *   - Windows: PowerShell + Windows UI Automation (auto_retry.ps1)
 *   - macOS:   AppleScript + System Events Accessibility API (auto_retry_mac.sh)
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
const EXEC_TIMEOUT_MS_WIN = 10_000;       // single-run timeout (Windows)
const EXEC_TIMEOUT_MS_MAC = 15_000;       // macOS needs more time for AXManualAccessibility

/** Types of errors detected by the watcher */
export type ErrorType = 'retry' | 'quota' | 'restart' | 'auth';

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
    private consecutiveRetryCount = 0;
    private quotaCount = 0;
    private authErrorCount = 0;
    private intervalMs: number;
    private restartThreshold: number;
    private platform: NodeJS.Platform;

    /** Fires when the Retry button was successfully clicked. */
    private _onRetryTriggered = new vscode.EventEmitter<number>();
    readonly onRetryTriggered = this._onRetryTriggered.event;

    /** Fires when any Antigravity error is detected (retry, quota, etc). */
    private _onErrorDetected = new vscode.EventEmitter<ErrorEvent>();
    readonly onErrorDetected = this._onErrorDetected.event;

    /** Fires when retry count reaches threshold and a full restart is needed. */
    private _onRestartRequired = new vscode.EventEmitter<number>();
    readonly onRestartRequired = this._onRestartRequired.event;

    /** Fires when an OAuth2/auth error is detected (needs credential clearing + restart). */
    private _onAuthErrorDetected = new vscode.EventEmitter<string>();
    readonly onAuthErrorDetected = this._onAuthErrorDetected.event;

    constructor(extensionPath: string, intervalMs?: number, restartThreshold?: number) {
        this.platform = process.platform;

        // Select platform-specific script
        if (this.platform === 'win32') {
            this.scriptPath = path.join(extensionPath, 'resources', 'auto_retry.ps1');
        } else if (this.platform === 'darwin') {
            this.scriptPath = path.join(extensionPath, 'resources', 'auto_retry_mac.py');
        } else {
            // Linux / other — no UI automation support, but we still set a path
            this.scriptPath = '';
        }

        this.intervalMs = intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
        this.restartThreshold = restartThreshold ?? 10;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    start(): void {
        if (this.timer) {
            return;
        }

        if (this.platform !== 'win32' && this.platform !== 'darwin') {
            logWarn('⚠️ 当前平台不支持 Agent 错误自动重试 (仅支持 Windows 和 macOS)');
            return;
        }

        logInfo(
            `🔄 Agent 错误自动重试监控已启动 (每 ${this.intervalMs / 1000}s 检查, 平台: ${this.platform})`,
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

    getConsecutiveRetryCount(): number {
        return this.consecutiveRetryCount;
    }

    getQuotaCount(): number {
        return this.quotaCount;
    }

    dispose(): void {
        this.stop();
        this._onRetryTriggered.dispose();
        this._onErrorDetected.dispose();
        this._onRestartRequired.dispose();
        this._onAuthErrorDetected.dispose();
    }

    // ── Core check ────────────────────────────────────────────────────────

    private async check(): Promise<void> {
        if (this.checking) {
            return;
        }
        this.checking = true;
        try {
            const result = await this.runScript();

            // Parse result — some results include "|detail" suffix
            const [status, detail] = this.parseResult(result);

            switch (status) {
                case 'RETRY_CLICKED':
                    this.retryCount++;
                    this.consecutiveRetryCount++;
                    logSuccess(
                        `✅ 自动点击了 Retry 按钮 (累计 ${this.retryCount} 次, 连续 ${this.consecutiveRetryCount} 次)`,
                    );
                    vscode.window.showInformationMessage(
                        `🔄 Antigravity Agent 错误已自动重试 (连续第 ${this.consecutiveRetryCount} 次)`,
                    );
                    this._onRetryTriggered.fire(this.retryCount);
                    this._onErrorDetected.fire({
                        type: 'retry',
                        count: this.consecutiveRetryCount,
                    });

                    // When CONSECUTIVE retry count reaches threshold, request a full restart
                    if (this.consecutiveRetryCount >= this.restartThreshold) {
                        logWarn(
                            `⚠️ 连续重试已达 ${this.consecutiveRetryCount} 次 (阈值 ${this.restartThreshold})，请求完全重启 Antigravity`,
                        );
                        this._onErrorDetected.fire({
                            type: 'restart',
                            count: this.consecutiveRetryCount,
                        });
                        this._onRestartRequired.fire(this.consecutiveRetryCount);
                    }
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

                case 'AUTH_ERROR':
                    this.authErrorCount++;
                    logError(
                        `🔐 检测到 OAuth2 认证错误 (第 ${this.authErrorCount} 次): ${detail || 'unauthorized_client'}`,
                    );
                    vscode.window.showErrorMessage(
                        `🔐 Antigravity 认证失效 (unauthorized_client)，即将清除凭据并重启...`,
                    );
                    this._onErrorDetected.fire({
                        type: 'auth',
                        count: this.authErrorCount,
                        detail: detail || 'unauthorized_client',
                    });
                    this._onAuthErrorDetected.fire(detail || 'unauthorized_client');
                    break;

                case 'QUOTA_NOT_FOUND':
                    // Silent ignore — this means the text was found (e.g. in chat history) 
                    // but no dismiss button was present, indicating the dialog is already closed.
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
                    // Normal — no error dialog present
                    // Reset consecutive retry count since agent is healthy
                    if (this.consecutiveRetryCount > 0) {
                        logInfo(
                            `Agent 恢复正常，连续重试计数已重置 (之前连续 ${this.consecutiveRetryCount} 次)`,
                        );
                        this.consecutiveRetryCount = 0;
                    }
                    break;

                default:
                    // Unexpected output
                    break;
            }
        } catch {
            // Script execution failed (e.g. timeout) — silently ignore
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

    // ── Platform-specific script execution ────────────────────────────────

    private runScript(): Promise<string> {
        return new Promise((resolve, reject) => {
            let cmd: string;

            if (this.platform === 'win32') {
                // Windows: PowerShell + UI Automation
                cmd = [
                    'powershell.exe',
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy', 'Bypass',
                    '-File', `"${this.scriptPath}"`,
                ].join(' ');
            } else if (this.platform === 'darwin') {
                // macOS: Python + native Accessibility API (ctypes)
                cmd = `python3 "${this.scriptPath}"`;
            } else {
                // Unsupported platform — return NO_ERROR immediately
                resolve('NO_ERROR');
                return;
            }

            const timeout = this.platform === 'darwin' ? EXEC_TIMEOUT_MS_MAC : EXEC_TIMEOUT_MS_WIN;
            exec(cmd, { timeout }, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }
}
