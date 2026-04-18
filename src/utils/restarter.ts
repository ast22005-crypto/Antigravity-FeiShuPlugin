import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import { logInfo, logError, logWarn, logSuccess } from './logger';
import { isManagerRunning, getCurrentAccount, triggerSmartSwitch, switchToAccount } from './managerClient';

/** Result of the auth recovery attempt */
export type RecoveryResult = 'switched' | 'failed';

/**
 * Clear cached OAuth2 credentials from the macOS Keychain.
 * This forces Antigravity to re-authenticate on next launch.
 *
 * Targets:
 *  - "Antigravity Safe Storage" entries (account: "Antigravity", "Antigravity Key")
 */
export async function clearAntigravityCredentials(): Promise<boolean> {
    if (process.platform !== 'darwin') {
        logWarn('[Restarter] 清除凭据仅支持 macOS');
        return false;
    }

    const keychainEntries = [
        { service: 'Antigravity Safe Storage', account: 'Antigravity' },
        { service: 'Antigravity Safe Storage', account: 'Antigravity Key' },
    ];

    let cleared = 0;

    for (const entry of keychainEntries) {
        try {
            child_process.execSync(
                `security delete-generic-password -s "${entry.service}" -a "${entry.account}" 2>/dev/null`,
                { timeout: 5000 },
            );
            logInfo(`[Restarter] 已删除 Keychain 条目: ${entry.service} / ${entry.account}`);
            cleared++;
        } catch {
            // Entry may not exist — that's fine
            logInfo(`[Restarter] Keychain 条目不存在或已删除: ${entry.service} / ${entry.account}`);
        }
    }

    if (cleared > 0) {
        logSuccess(`[Restarter] 已清除 ${cleared} 个 Keychain 凭据条目`);
    } else {
        logWarn('[Restarter] 未找到需要清除的 Keychain 条目');
    }

    return cleared > 0;
}

// ── Auth error recovery via account switching ────────────────────────────

/**
 * Auth error recovery — switch to a healthy account via Antigravity-Manager.
 *
 * Previous approaches (antigravity.handleAuthRefresh, clearing Keychain +
 * hard restart) have been proven ineffective for resolving unauthorized_client
 * errors.  The only reliable recovery path is switching to a different
 * account through the local Manager API.
 *
 * @returns 'switched' on success, 'failed' if Manager is unavailable or no healthy account exists
 */
export async function recoverFromAuthError(): Promise<RecoveryResult> {
    logInfo('[Restarter] 🔐 认证恢复: 尝试通过 Antigravity-Manager 切换账号...');

    try {
        const managerUp = await isManagerRunning();
        if (!managerUp) {
            logError('[Restarter] ❌ Manager 未运行，无法切换账号。请手动启动 Antigravity-Manager 后重试。');
            return 'failed';
        }

        const currentAccount = await getCurrentAccount();
        if (!currentAccount) {
            logError('[Restarter] ❌ 获取当前账号失败');
            return 'failed';
        }

        const switchedCurrent = await switchToAccount(currentAccount.id, currentAccount.email);
        if (!switchedCurrent) {
            logError('[Restarter] ❌ 切换当前账号失败');
            return 'failed';
        }

        const switched = await triggerSmartSwitch();
        if (switched) {
            logSuccess('[Restarter] ✅ 已通过 Manager 切换到备用账号');
            return 'switched';
        }

        logError('[Restarter] ❌ Manager 运行中但切换失败（可能没有可用的备用账号）');
        return 'failed';
    } catch (e: any) {
        logError(`[Restarter] ❌ 切换账号异常: ${e.message}`);
        return 'failed';
    }
}


