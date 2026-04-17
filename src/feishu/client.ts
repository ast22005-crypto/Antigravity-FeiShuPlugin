/**
 * feishu/client.ts — Feishu REST API client
 *
 * Handles token management and message sending via raw HTTPS requests.
 * Mirrors the capabilities of the original feishu.py Python script.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { FeishuConfig, FeishuTarget } from '../types';
import { logInfo, logError, logSuccess, logWarn } from '../utils/logger';

const BASE = 'https://open.feishu.cn/open-apis';

/** Maximum file size for Feishu upload: 30 MB */
const MAX_FILE_SIZE = 30 * 1024 * 1024;

interface TokenCache {
    token: string;
    expireAt: number;
}

export class FeishuClient {
    private config: FeishuConfig;
    private target: FeishuTarget | null = null;
    private tokenCache: TokenCache | null = null;

    constructor(config: FeishuConfig) {
        this.config = config;
    }

    updateConfig(config: FeishuConfig): void {
        this.config = config;
        this.tokenCache = null;
    }

    setTarget(target: FeishuTarget): void {
        this.target = target;
    }

    getTarget(): FeishuTarget | null {
        return this.target;
    }

    hasTarget(): boolean {
        return this.target !== null && !!this.target.targetId;
    }

    // ── Token Management ──────────────────────────────────────────────────

    async getToken(force = false): Promise<string> {
        if (
            !force &&
            this.tokenCache &&
            Date.now() < this.tokenCache.expireAt - 300_000
        ) {
            return this.tokenCache.token;
        }

        const data = await this.httpPost(
            `${BASE}/auth/v3/tenant_access_token/internal`,
            {
                app_id: this.config.appId,
                app_secret: this.config.appSecret,
            },
        );

        if (data.code !== 0) {
            logError(`Token 获取失败: ${data.msg} (code=${data.code})`);
            return '';
        }

        const token: string = data.tenant_access_token;
        this.tokenCache = {
            token,
            expireAt: Date.now() + (data.expire || 7200) * 1000,
        };
        return token;
    }

    // ── Public Send Methods ───────────────────────────────────────────────

    async sendText(text: string): Promise<boolean> {
        if (text.length > 4000) {
            text = text.slice(0, 3950) + '\n\n...（内容过长，已截断）';
        }
        return this.sendMessage('text', { text });
    }

    async sendCard(
        title: string,
        body: string,
        color = 'blue',
    ): Promise<boolean> {
        if (Buffer.byteLength(body, 'utf-8') > 28_000) {
            body = body.slice(0, 9000) + '\n\n...（内容过长，已截断）';
        }
        const card = {
            config: { wide_screen_mode: true },
            header: {
                title: { tag: 'plain_text', content: title },
                template: color,
            },
            elements: [
                { tag: 'div', text: { tag: 'lark_md', content: body } },
            ],
        };
        return this.sendMessage('interactive', card);
    }

    async sendReaction(messageId: string, emoji = 'OK'): Promise<boolean> {
        const token = await this.getToken();
        if (!token) {
            return false;
        }
        const result = await this.httpPost(
            `${BASE}/im/v1/messages/${messageId}/reactions`,
            { reaction_type: { emoji_type: emoji } },
            token,
        );
        return result.code === 0;
    }

    // ── File Upload & Send ────────────────────────────────────────────────

    /**
     * Upload a local file to Feishu and return its file_key.
     * Returns null on failure.
     */
    async uploadFile(filePath: string): Promise<string | null> {
        const token = await this.getToken();
        if (!token) {
            return null;
        }

        // Validate file
        if (!fs.existsSync(filePath)) {
            logError(`文件不存在: ${filePath}`);
            return null;
        }

        const stat = fs.statSync(filePath);
        if (stat.size === 0) {
            logError(`不允许上传空文件: ${filePath}`);
            return null;
        }
        if (stat.size > MAX_FILE_SIZE) {
            logError(
                `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)，飞书限制 30 MB: ${filePath}`,
            );
            return null;
        }

        const fileName = path.basename(filePath);
        logInfo(`正在上传文件到飞书: ${fileName} (${(stat.size / 1024).toFixed(1)} KB)`);

        const result = await this.httpPostMultipart(
            `${BASE}/im/v1/files`,
            {
                file_type: 'stream',
                file_name: fileName,
            },
            filePath,
            token,
        );

        if (result.code === 0 && result.data?.file_key) {
            logSuccess(`文件上传成功: ${fileName} → ${result.data.file_key}`);
            return result.data.file_key as string;
        }

        logError(
            `文件上传失败: ${result.msg || 'unknown error'} (code=${result.code})`,
        );
        return null;
    }

    /**
     * Send a file message using an already-uploaded file_key.
     */
    async sendFileMessage(fileKey: string): Promise<boolean> {
        return this.sendMessage('file', { file_key: fileKey });
    }

    /**
     * Upload a local file and send it as a file message in one step.
     * Returns true if both upload and send succeed.
     */
    async uploadAndSendFile(filePath: string): Promise<boolean> {
        if (!this.hasTarget()) {
            logWarn('尚未激活双向通信，无法发送文件');
            return false;
        }

        const fileKey = await this.uploadFile(filePath);
        if (!fileKey) {
            return false;
        }

        const ok = await this.sendFileMessage(fileKey);
        if (ok) {
            logSuccess(`文件已发送到飞书: ${path.basename(filePath)}`);
        }
        return ok;
    }

    // ── Existing Public Methods (continued) ───────────────────────────────

    async sendOpenMessage(projectName: string): Promise<boolean> {
        if (!this.hasTarget()) {
            return false;
        }
        return this.sendCard(
            `🚀 ${projectName} · 准备就绪`,
            [
                `**项目**：${projectName}`,
                `**状态**：✅ Antigravity 已就绪，可以开始工作`,
                `**时间**：${this.now()}`,
                '',
                '---',
                '> 💡 直接给我发消息，将作为 AI 下一轮对话输入',
            ].join('\n'),
            'green',
        );
    }

    async sendResult(
        summary: string,
        details?: string,
        files?: string[],
    ): Promise<boolean> {
        if (!this.hasTarget()) {
            logWarn('尚未激活双向通信，无法发送结果');
            return false;
        }

        const projectName = this.config.projectName || 'Project';
        const parts = [`**📋 摘要**\n${summary}`];
        if (details) {
            parts.push(`\n**📝 详情**\n${details}`);
        }
        if (files && files.length > 0) {
            const fileLines = files
                .slice(0, 8)
                .map(f => `• \`${f}\``)
                .join('\n');
            parts.push(`\n**📁 文件**\n${fileLines}`);
        }
        parts.push(`\n---\n**⏰ 时间**：${this.now()}`);

        const ok = await this.sendCard(
            `✅ ${projectName} · 任务完成`,
            parts.join('\n'),
            'blue',
        );
        if (ok) {
            logSuccess('结果已推送到飞书');
        }
        return ok;
    }

    // ── Private Helpers ───────────────────────────────────────────────────

    private async sendMessage(
        msgType: string,
        content: Record<string, unknown>,
    ): Promise<boolean> {
        if (!this.target) {
            logWarn('尚未激活双向通信。请先在飞书中向机器人发送消息。');
            return false;
        }

        const token = await this.getToken();
        if (!token) {
            return false;
        }

        const ridType =
            this.target.targetType === 'p2p' ? 'open_id' : 'chat_id';
        const result = await this.httpPost(
            `${BASE}/im/v1/messages?receive_id_type=${ridType}`,
            {
                receive_id: this.target.targetId,
                msg_type: msgType,
                content: JSON.stringify(content),
            },
            token,
        );

        if (result.code === 0) {
            return true;
        }
        logError(`消息发送失败: ${result.msg} (code=${result.code})`);
        return false;
    }

    /** Low-level HTTPS POST helper (JSON body) */
    private httpPost(
        url: string,
        body: Record<string, unknown>,
        token?: string,
    ): Promise<Record<string, any>> {
        return new Promise(resolve => {
            const data = JSON.stringify(body);
            const urlObj = new URL(url);

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(data)),
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const req = https.request(
                {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers,
                },
                res => {
                    let responseBody = '';
                    res.on('data', (chunk: Buffer) => {
                        responseBody += chunk.toString();
                    });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(responseBody));
                        } catch {
                            resolve({
                                code: -1,
                                msg: `Invalid JSON: ${responseBody.slice(0, 200)}`,
                            });
                        }
                    });
                },
            );

            req.on('error', (e: Error) => {
                logError(`网络请求失败: ${e.message}`);
                resolve({ code: -1, msg: e.message });
            });

            req.setTimeout(15_000, () => {
                req.destroy();
                resolve({ code: -1, msg: 'Request timeout (15s)' });
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Low-level HTTPS POST helper for multipart/form-data uploads.
     * Manually constructs the multipart body using Node.js buffers.
     */
    private httpPostMultipart(
        url: string,
        fields: Record<string, string>,
        filePath: string,
        token: string,
    ): Promise<Record<string, any>> {
        return new Promise(resolve => {
            const boundary = `----FeishuUpload${Date.now()}${Math.random().toString(36).slice(2)}`;
            const urlObj = new URL(url);
            const fileName = path.basename(filePath);

            // Build multipart body parts
            const parts: Buffer[] = [];

            // Add text fields
            for (const [key, value] of Object.entries(fields)) {
                parts.push(
                    Buffer.from(
                        `--${boundary}\r\n` +
                        `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
                        `${value}\r\n`,
                    ),
                );
            }

            // Add file field
            const fileHeader = Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
                `Content-Type: application/octet-stream\r\n\r\n`,
            );
            const fileContent = fs.readFileSync(filePath);
            const fileFooter = Buffer.from(`\r\n`);

            parts.push(fileHeader, fileContent, fileFooter);

            // Closing boundary
            parts.push(Buffer.from(`--${boundary}--\r\n`));

            const body = Buffer.concat(parts);

            const headers: Record<string, string> = {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': String(body.length),
                'Authorization': `Bearer ${token}`,
            };

            const req = https.request(
                {
                    hostname: urlObj.hostname,
                    path: urlObj.pathname + urlObj.search,
                    method: 'POST',
                    headers,
                },
                res => {
                    let responseBody = '';
                    res.on('data', (chunk: Buffer) => {
                        responseBody += chunk.toString();
                    });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(responseBody));
                        } catch {
                            resolve({
                                code: -1,
                                msg: `Invalid JSON: ${responseBody.slice(0, 200)}`,
                            });
                        }
                    });
                },
            );

            req.on('error', (e: Error) => {
                logError(`文件上传网络请求失败: ${e.message}`);
                resolve({ code: -1, msg: e.message });
            });

            // Longer timeout for file uploads (60s)
            req.setTimeout(60_000, () => {
                req.destroy();
                resolve({ code: -1, msg: 'File upload timeout (60s)' });
            });

            req.write(body);
            req.end();
        });
    }

    private now(): string {
        return new Date().toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }
}
