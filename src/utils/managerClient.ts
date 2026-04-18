/**
 * utils/managerClient.ts — Antigravity-Manager 本地 API 客户端
 *
 * Antigravity-Manager (https://github.com/lbjlaq/Antigravity-Manager) 是一个
 * 桌面端多账号管理工具，在本地运行 HTTP API 代理。此模块封装了与 Manager 交互
 * 所需的 HTTP 调用，用于在认证失败时自动切换到另一个健康账号，实现零停机恢复。
 *
 * 核心流程：
 *   1. 探测 Manager 是否运行中
 *   2. 获取所有账号列表及健康状态
 *   3. 切换到下一个可用的健康账号
 *
 * 使用 Node.js 原生 `http` 模块，无外部依赖。
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { logInfo, logWarn, logError, logSuccess } from './logger';

/** Default Manager API port (as documented in Antigravity-Manager README) */
const DEFAULT_MANAGER_PORT = 8045;

/** HTTP request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 5_000;

/** Account info returned by Manager API */
export interface ManagerAccount {
    id: string;
    email?: string;
    is_current: boolean;
    health?: 'ok' | 'banned' | 'expired' | 'unknown';
    quota_remaining?: number;
}

/** health info returned by Manager API */
export interface ManagerHealth {
    status: string;
    version?: string;
}


/** Manager API response wrapper */
interface ManagerResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
}

/**
 * Get the Manager API port from VS Code settings.
 */
function getManagerPort(): number {
    return vscode.workspace
        .getConfiguration('feishuBot')
        .get<number>('managerPort', DEFAULT_MANAGER_PORT);
}

/**
 * Get the Manager API key from VS Code settings.
 */
function getManagerApiKey(): string {
    return vscode.workspace
        .getConfiguration('feishuBot')
        .get<string>('managerApiKey', '');
}

/**
 * Make an HTTP request to the Manager local API.
 */
function managerRequest<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
): Promise<ManagerResponse<T>> {
    return new Promise((resolve) => {
        const port = getManagerPort();
        const apiKey = getManagerApiKey();

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const postData = body ? JSON.stringify(body) : undefined;
        if (postData) {
            headers['Content-Length'] = Buffer.byteLength(postData).toString();
        }

        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method,
                headers,
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => {
                    data += chunk.toString();
                });
                res.on('end', () => {
                    if (!data) {
                        resolve({ success: res.statusCode === 200 });
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && typeof parsed === 'object' && 'success' in parsed) {
                            resolve(parsed as ManagerResponse<T>);
                        } else {
                            resolve({ success: res.statusCode === 200, data: parsed as T });
                        }
                    } catch {
                        // Manager may return non-JSON responses for simple endpoints
                        resolve({ success: res.statusCode === 200, data: data as unknown as T });
                    }
                });
            },
        );

        req.on('error', () => {
            resolve({ success: false, error: 'Manager not reachable' });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, error: 'Request timeout' });
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

/**
 * Check if Antigravity-Manager is running on the local machine.
 */
export async function isManagerRunning(): Promise<boolean> {
    const port = getManagerPort();
    logInfo(`[ManagerClient] 探测 Antigravity-Manager (127.0.0.1:${port})...`);

    try {
        const result = await managerRequest<ManagerHealth>('GET', '/healthz');
        const running = result.success;
        if (running) {
            logSuccess(`[ManagerClient] Antigravity-Manager 正在运行 (端口 ${port})`);
        } else {
            logWarn(`[ManagerClient] Antigravity-Manager 未运行或不可达: ${result.error}`);
        }
        return running;
    } catch {
        logWarn('[ManagerClient] Antigravity-Manager 连接失败');
        
        return false;
    }
}

/**
 * Get all accounts from the Manager.
 */
export async function getCurrentAccount(): Promise<ManagerAccount> {
    logInfo('[ManagerClient] 获取当前账号...');

    const result = await managerRequest<ManagerAccount>('GET', '/api/accounts/current');

    if (!result.success || !result.data) {
        logWarn(`[ManagerClient] 获取当前账号失败: ${result.error || 'unknown'}`);
        throw new Error(`[ManagerClient] 获取当前账号失败: ${result.error || 'unknown'}`);
    }

    const account = result.data;
    logInfo(`[ManagerClient] 获取到当前账号: ${account.email}`);
    return account;
}

/**
 * Get all accounts from the Manager.
 */
export async function getAccounts(): Promise<ManagerAccount[]> {
    logInfo('[ManagerClient] 获取账号列表...');

    const result = await managerRequest<ManagerAccount[]>('GET', '/api/accounts');

    if (!result.success || !result.data) {
        logWarn(`[ManagerClient] 获取账号列表失败: ${result.error || 'unknown'}`);
        return [];
    }

    // Handle both array responses and wrapped responses
    const accounts = Array.isArray(result.data) ? result.data : [];
    logInfo(`[ManagerClient] 获取到 ${accounts.length} 个账号`);
    return accounts;
}

/**
 * Switch to the next healthy account.
 *
 * Logic:
 *   1. Get all accounts
 *   2. Find the currently active account
 *   3. Pick the next healthy (non-banned, non-expired) account
 *   4. Call the Manager switch API
 *
 * @returns true if successfully switched, false otherwise
 */
export async function switchToNextAccount(): Promise<boolean> {
    logInfo('[ManagerClient] 尝试切换到下一个可用账号...');

    const accounts = await getAccounts();
    if (accounts.length < 2) {
        logWarn(`[ManagerClient] 账号数量不足 (${accounts.length})，无法切换`);
        return false;
    }

    // Find healthy candidates (not the current active one)
    const candidates = accounts.filter(
        a => !a.is_current && (!a.health || a.health === 'ok'),
    );

    if (candidates.length === 0) {
        logWarn('[ManagerClient] 没有可切换的健康账号');
        return false;
    }

    // Pick the one with the highest remaining quota, or the first one
    const target = candidates.reduce((best, cur) => {
        if ((cur.quota_remaining ?? 0) > (best.quota_remaining ?? 0)) {
            return cur;
        }
        return best;
    }, candidates[0]);

    return switchToAccount(target.id, target.email);
}

/**
 * Switch to a specific account by ID.
 */
export async function switchToAccount(
    accountId: string,
    email?: string,
): Promise<boolean> {
    const label = email || accountId;
    logInfo(`[ManagerClient] 切换到账号: ${label}`);

    const result = await managerRequest<unknown>('POST', '/api/accounts/switch', {
        accountId: accountId,
    });

    if (result.success) {
        logSuccess(`[ManagerClient] ✅ 已切换到账号: ${label}`);
        return true;
    }

    // Try alternative API path — some Manager versions use a different endpoint
    const altResult = await managerRequest<unknown>('PUT', `/api/accounts/${accountId}/activate`, {});
    if (altResult.success) {
        logSuccess(`[ManagerClient] ✅ 已切换到账号 (alt API): ${label}`);
        return true;
    }

    logError(`[ManagerClient] 切换账号失败: ${result.error || 'unknown'}`);
    return false;
}

/**
 * Trigger the Manager's "smart recommendation" to auto-select the best account.
 */
export async function triggerSmartSwitch(): Promise<boolean> {
    logInfo('[ManagerClient] 触发智能推荐切换...');

    const result = await managerRequest<unknown>('POST', '/api/accounts/smart-switch', {});

    if (result.success) {
        logSuccess('[ManagerClient] ✅ 智能切换成功');
        return true;
    }

    // Fallback to manual next-account switching
    logInfo('[ManagerClient] 智能切换 API 不可用，降级到手动切换...');
    return switchToNextAccount();
}
