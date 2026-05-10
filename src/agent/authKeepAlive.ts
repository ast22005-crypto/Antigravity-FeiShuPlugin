/**
 * agent/authKeepAlive.ts — Proactive OAuth2 token refresh for Antigravity
 *
 * Prevents the common scenario where Antigravity's OAuth2 token expires
 * after long idle periods (e.g. overnight automated workflows).
 *
 * Strategy:
 *   1. Periodically call `antigravity.handleAuthRefresh` to refresh the token
 *      BEFORE it expires (proactive, not reactive).
 *   2. After each refresh attempt, briefly monitor the Output Channel for
 *      auth error signals. If detected → fire event so the extension can
 *      trigger account switching as a fallback.
 *   3. Existing ErrorWatcher / OutputWatcher remain as last-resort safety nets.
 *
 * Default interval: 30 minutes (configurable via `feishuBot.authKeepAliveInterval`).
 */

import * as vscode from 'vscode';
import { logInfo, logWarn, logError, logSuccess } from '../utils/logger';

/** Patterns in the Output Channel that indicate a refresh failure */
const AUTH_FAILURE_PATTERNS = [
    'unauthorized_client',
    'Failed to get OAuth token',
    'failed to compute token',
    'failed to set auth token',
    'oauth2:',
];

/** How long to watch the Output Channel for errors after a refresh attempt */
const POST_REFRESH_WATCH_MS = 5_000;

export interface AuthKeepAliveStats {
    refreshCount: number;
    lastRefreshTime: number;
    failureCount: number;
    isRunning: boolean;
}

export class AuthKeepAlive {
    private timer: ReturnType<typeof setInterval> | undefined;
    private refreshCount = 0;
    private failureCount = 0;
    private lastRefreshTime = 0;
    private intervalMs: number;
    private refreshing = false;

    /** Fires when a refresh attempt detects an auth error (token may be dead). */
    private _onRefreshFailed = new vscode.EventEmitter<{ detail: string; count: number }>();
    readonly onRefreshFailed = this._onRefreshFailed.event;

    /** Fires after each successful refresh (for status reporting). */
    private _onRefreshSuccess = new vscode.EventEmitter<number>();
    readonly onRefreshSuccess = this._onRefreshSuccess.event;

    constructor(intervalMs: number) {
        this.intervalMs = intervalMs;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    start(): void {
        if (this.timer) {
            return;
        }

        logInfo(
            `🔑 Auth KeepAlive 已启动 (每 ${Math.round(this.intervalMs / 60_000)} 分钟刷新一次认证)`,
        );

        // First refresh after one interval (not immediately — extension just started)
        this.timer = setInterval(() => this.doRefresh(), this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        logInfo('🔑 Auth KeepAlive 已停止');
    }

    isRunning(): boolean {
        return !!this.timer;
    }

    getStats(): AuthKeepAliveStats {
        return {
            refreshCount: this.refreshCount,
            lastRefreshTime: this.lastRefreshTime,
            failureCount: this.failureCount,
            isRunning: this.isRunning(),
        };
    }

    /**
     * Manually trigger an immediate refresh.
     * Returns true if the refresh completed without detecting errors.
     */
    async refreshNow(): Promise<boolean> {
        return this.doRefresh();
    }

    dispose(): void {
        this.stop();
        this._onRefreshFailed.dispose();
        this._onRefreshSuccess.dispose();
    }

    // ── Core refresh logic ────────────────────────────────────────────────

    private async doRefresh(): Promise<boolean> {
        if (this.refreshing) {
            return true; // Already running — skip
        }
        this.refreshing = true;

        try {
            logInfo('🔑 [AuthKeepAlive] 正在刷新 Antigravity 认证...');

            // Set up a temporary listener on the Output Channel to detect errors
            let authErrorDetected = false;
            let errorDetail = '';

            const disposable = vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.scheme !== 'output') {
                    return;
                }

                const uriStr = e.document.uri.toString().toLowerCase();
                const isAntigravity = ['antigravity', 'gemini', 'cloudcode'].some(
                    hint => uriStr.includes(hint),
                );
                if (!isAntigravity) {
                    return;
                }

                for (const change of e.contentChanges) {
                    const text = change.text.toLowerCase();
                    const matched = AUTH_FAILURE_PATTERNS.find(p => text.includes(p.toLowerCase()));
                    if (matched) {
                        authErrorDetected = true;
                        errorDetail = matched;
                    }
                }
            });

            // Execute the built-in auth refresh command
            try {
                await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
            } catch (e: any) {
                logWarn(`🔑 [AuthKeepAlive] handleAuthRefresh 命令执行异常: ${e.message}`);
                // Command might not exist or might throw — not fatal
            }

            // Wait briefly to observe Output Channel for errors
            await this.sleep(POST_REFRESH_WATCH_MS);

            // Clean up the temporary listener
            disposable.dispose();

            // Record result
            this.refreshCount++;
            this.lastRefreshTime = Date.now();

            if (authErrorDetected) {
                this.failureCount++;
                logError(
                    `🔑 [AuthKeepAlive] 刷新后检测到认证错误 (第 ${this.failureCount} 次): ${errorDetail}`,
                );
                this._onRefreshFailed.fire({
                    detail: errorDetail,
                    count: this.failureCount,
                });
                return false;
            }

            logSuccess(
                `🔑 [AuthKeepAlive] 认证刷新成功 (第 ${this.refreshCount} 次)`,
            );
            this._onRefreshSuccess.fire(this.refreshCount);
            return true;
        } catch (e: any) {
            logError(`🔑 [AuthKeepAlive] 刷新异常: ${e.message}`);
            return false;
        } finally {
            this.refreshing = false;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
