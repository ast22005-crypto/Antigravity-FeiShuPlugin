/**
 * feishu/client.ts — Feishu REST API client
 *
 * Handles token management and message sending via raw HTTPS requests.
 * Mirrors the capabilities of the original feishu.py Python script.
 */

import * as https from 'https';
import { FeishuConfig, FeishuTarget } from '../types';
import { logInfo, logError, logSuccess, logWarn } from '../utils/logger';

const BASE = 'https://open.feishu.cn/open-apis';

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

    /** Low-level HTTPS POST helper */
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
