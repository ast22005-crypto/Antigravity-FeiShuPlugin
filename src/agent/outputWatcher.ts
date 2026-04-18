/**
 * agent/outputWatcher.ts — Monitor Antigravity Output Channel for auth errors
 *
 * Listens to `vscode.workspace.onDidChangeTextDocument` for documents
 * with the `output` scheme. When the Antigravity output channel writes
 * lines containing `unauthorized_client` or `oauth2` auth failures,
 * fires an event so the extension can clear credentials and restart.
 *
 * This is more reliable and faster than UI-based detection because
 * it reads the raw log output directly.
 */

import * as vscode from 'vscode';
import { logInfo, logWarn, logError } from '../utils/logger';

/** Patterns that indicate an OAuth2/auth failure in the log output */
const AUTH_ERROR_PATTERNS = [
    'oauth2: "unauthorized_client"',
    'unauthorized_client',
    'Failed to get OAuth token',
    'failed to compute token',
    'failed to set auth token',
];

/**
 * Keywords in the output channel URI or document content that identify
 * it as belonging to Antigravity / Gemini Code Assist.
 */
const ANTIGRAVITY_CHANNEL_HINTS = [
    'antigravity',
    'gemini',
    'cloudcode',
    'cloud code',
];

/** Minimum interval between firing auth error events (ms) */
const DEBOUNCE_MS = 30_000; // 30 seconds — avoid rapid-fire triggers

export class OutputWatcher {
    private disposables: vscode.Disposable[] = [];
    private lastFireTime = 0;
    private authErrorCount = 0;
    private enabled = true;

    /** Fires when an OAuth2/auth error is detected in the output log. */
    private _onAuthError = new vscode.EventEmitter<{ detail: string; count: number }>();
    readonly onAuthError = this._onAuthError.event;

    constructor() {
        // Subscribe to all text document changes
        const sub = vscode.workspace.onDidChangeTextDocument(e => {
            if (!this.enabled) {
                return;
            }
            this.handleDocumentChange(e);
        });
        this.disposables.push(sub);
    }

    start(): void {
        this.enabled = true;
        logInfo('📡 Antigravity Output 日志监控已启动');
    }

    stop(): void {
        this.enabled = false;
        logInfo('📡 Antigravity Output 日志监控已停止');
    }

    getAuthErrorCount(): number {
        return this.authErrorCount;
    }

    dispose(): void {
        this.stop();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this._onAuthError.dispose();
    }

    // ── Core handler ──────────────────────────────────────────────────────

    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const doc = event.document;

        // Only watch output channel documents
        if (doc.uri.scheme !== 'output') {
            return;
        }

        // Check if this output channel belongs to Antigravity
        const uriStr = doc.uri.toString().toLowerCase();
        const isAntigravity = ANTIGRAVITY_CHANNEL_HINTS.some(hint => uriStr.includes(hint));

        if (!isAntigravity) {
            // Also check the first few lines of content for Antigravity indicators
            // (some output channels have generic URIs)
            return;
        }

        // Scan the content changes (only new text, not entire document)
        for (const change of event.contentChanges) {
            const text = change.text;
            if (!text) {
                continue;
            }

            // Check each line for auth error patterns
            const lines = text.split('\n');
            for (const line of lines) {
                const lineLower = line.toLowerCase();
                const matchedPattern = AUTH_ERROR_PATTERNS.find(p =>
                    lineLower.includes(p.toLowerCase()),
                );

                if (matchedPattern) {
                    this.handleAuthError(line.trim(), matchedPattern);
                    return; // One detection per change event is enough
                }
            }
        }
    }

    private handleAuthError(logLine: string, pattern: string): void {
        const now = Date.now();

        // Debounce — don't trigger too frequently
        if (now - this.lastFireTime < DEBOUNCE_MS) {
            return;
        }

        this.authErrorCount++;
        this.lastFireTime = now;

        logError(
            `🔐 [OutputWatcher] 检测到 OAuth2 认证错误 (第 ${this.authErrorCount} 次): ${pattern}`,
        );
        logWarn(`🔐 [OutputWatcher] 原始日志: ${logLine.slice(0, 200)}`);

        this._onAuthError.fire({
            detail: logLine.slice(0, 300),
            count: this.authErrorCount,
        });
    }
}
