/**
 * extension.ts — Entry point for the Feishu Bot VS Code Extension
 *
 * Lifecycle:
 *  1. Read VS Code Settings for feishuBot.*
 *  2. Initialize UI (status bar, tree views)
 *  3. Initialize core modules (client, queue, listener, bridge)
 *  4. Inject SKILL.md into .agents/skills/feishu-bot/
 *  5. Start WebSocket listener
 *  6. Watch for Agent response file (.antigravity/feishu_response.json)
 *  7. Register all commands
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import {
    loadConfig,
    isConfigured,
    getProjectName,
    onConfigChange,
} from './config/configManager';
import { FeishuClient } from './feishu/client';
import { FeishuListener } from './feishu/listener';
import { MessageQueue } from './queue/messageQueue';
import { AgentBridge } from './agent/bridge';
import { ErrorWatcher } from './agent/errorWatcher';
import { SkillInjector } from './agent/skillInjector';
import { StatusBar } from './ui/statusBar';
import {
    MessageTreeProvider,
    ConnectionStatusProvider,
} from './ui/treeView';
import {
    logInfo,
    logError,
    logSuccess,
    logWarn,
    showOutputChannel,
    disposeLogger,
} from './utils/logger';
import { FeishuConfig, FeishuTarget, AgentResponse } from './types';

// ── Module-level references (accessible from command handlers) ────────────

let feishuClient: FeishuClient | undefined;
let feishuListener: FeishuListener | undefined;
let messageQueue: MessageQueue | undefined;
let agentBridge: AgentBridge | undefined;
let statusBar: StatusBar | undefined;
let msgTreeProvider: MessageTreeProvider | undefined;
let connStatusProvider: ConnectionStatusProvider | undefined;
let responseWatcher: vscode.FileSystemWatcher | undefined;
let errorWatcher: ErrorWatcher | undefined;
let processingTimeoutTimer: ReturnType<typeof setInterval> | undefined;

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Activate ──────────────────────────────────────────────────────────────

export async function activate(
    context: vscode.ExtensionContext,
): Promise<void> {
    logInfo('飞书机器人插件启动中...');

    let config = loadConfig();

    const workspaceRoot =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspaceRoot) {
        logWarn('未打开工作区，仅注册基础命令');
        registerOpenSettingsCommand(context);
        return;
    }

    // ── 1. UI ─────────────────────────────────────────────────────────

    statusBar = new StatusBar();
    context.subscriptions.push({ dispose: () => statusBar!.dispose() });

    msgTreeProvider = new MessageTreeProvider();
    connStatusProvider = new ConnectionStatusProvider();

    vscode.window.registerTreeDataProvider(
        'feishu-bot.messages',
        msgTreeProvider,
    );
    vscode.window.registerTreeDataProvider(
        'feishu-bot.connectionStatus',
        connStatusProvider,
    );

    // ── 2. Core modules ───────────────────────────────────────────────

    feishuClient = new FeishuClient(config);
    messageQueue = new MessageQueue(workspaceRoot);
    agentBridge = new AgentBridge(messageQueue, config);

    // Reset stale processing lock from previous session —
    // on fresh start, no Agent is actually processing anything.
    if (messageQueue.isProcessing()) {
        logInfo('检测到上次残留的 processing 锁，已重置');
        messageQueue.clearProcessed();
    }

    // Restore saved target
    const savedTarget =
        context.workspaceState.get<FeishuTarget>('feishuTarget');
    if (savedTarget) {
        feishuClient.setTarget(savedTarget);
    }

    // ── 3. Register commands ──────────────────────────────────────────

    registerCommands(context, workspaceRoot);

    // ── 4. Config change listener ─────────────────────────────────────

    context.subscriptions.push(
        onConfigChange(newConfig => {
            config = newConfig;
            feishuClient!.updateConfig(config);
            agentBridge!.updateConfig(config);
            logInfo('配置已更新');

            if (!isConfigured(config)) {
                feishuListener?.stop();
                statusBar!.setNotConfigured();
            }
        }),
    );

    // ── 5. Check configuration ────────────────────────────────────────

    if (!isConfigured(config)) {
        statusBar.setNotConfigured();
        logWarn(
            '飞书未配置。请在 Settings 中搜索 feishuBot 并填入 App ID 和 App Secret。',
        );
        return;
    }

    // ── 6. Feishu listener ────────────────────────────────────────────

    feishuListener = new FeishuListener(
        config,
        feishuClient,
        messageQueue,
        workspaceRoot,
    );

    feishuListener.onConnectionChange(connected => {
        if (connected) {
            statusBar!.setConnected(messageQueue!.getMessageCount());
        } else {
            statusBar!.setDisconnected();
        }
        refreshConnectionStatus();
    });

    feishuListener.onTargetRecorded(target => {
        context.workspaceState.update('feishuTarget', target);
        logSuccess(
            `目标已保存: [${target.targetType}] ${target.targetId.slice(0, 20)}...`,
        );
        refreshConnectionStatus();
    });

    // ── 7. React to new messages ──────────────────────────────────────

    context.subscriptions.push(
        messageQueue.onNewMessage(messages => {
            statusBar!.setConnected(messages.length);
            msgTreeProvider!.refresh(messages);
            refreshConnectionStatus();

            // Notification
            const last = messages[messages.length - 1];
            vscode.window
                .showInformationMessage(
                    `📨 飞书消息: ${last.text.slice(0, 50)}`,
                    '查看',
                )
                .then(action => {
                    if (action === '查看') {
                        vscode.commands.executeCommand(
                            'feishu-bot.messages.focus',
                        );
                    }
                });

            // Auto-trigger Agent
            if (config.autoTriggerAgent) {
                // Small delay so rapid sequential messages can batch
                setTimeout(() => agentBridge!.trigger(), 2000);
            }
        }),
    );

    context.subscriptions.push(
        messageQueue.onQueueChange(data => {
            if (data.processing) {
                statusBar!.setProcessing();
            } else {
                statusBar!.setConnected(data.messages.length);
            }
            msgTreeProvider!.refresh(data.messages);
            refreshConnectionStatus();
        }),
    );

    // ── 8. Inject SKILL.md ────────────────────────────────────────────

    SkillInjector.inject(workspaceRoot);

    // ── 9. Start WebSocket ────────────────────────────────────────────

    statusBar.setConnecting();
    try {
        await feishuListener.start();
    } catch (e: any) {
        statusBar.setError(e.message);
        logError(`飞书连接失败: ${e.message}`);
        vscode.window.showErrorMessage(
            `飞书连接失败: ${e.message}。请检查 App ID / App Secret 设置。`,
        );
    }

    // ── 10. Response file watcher (FileSystemWatcher) ─────────────────

    setupResponseWatcher(context, workspaceRoot, config);

    // ── 11. Error auto-retry watcher ──────────────────────────────────

    const autoRetryEnabled = vscode.workspace
        .getConfiguration('feishuBot')
        .get<boolean>('autoRetryOnError', true);

    if (autoRetryEnabled) {
        const checkInterval = vscode.workspace
            .getConfiguration('feishuBot')
            .get<number>('autoRetryInterval', 15) * 1000;

        const restartThreshold = vscode.workspace
            .getConfiguration('feishuBot')
            .get<number>('autoRestartThreshold', 10);

        errorWatcher = new ErrorWatcher(
            context.extensionPath,
            checkInterval,
            restartThreshold,
        );

        // When auto-retry fires, release stale processing lock
        // so the re-triggered Agent can pick up messages again.
        errorWatcher.onRetryTriggered(() => {
            if (messageQueue?.isProcessing()) {
                logInfo('自动重试后释放 processing 锁');
                messageQueue.clearProcessed();
            }
        });

        // Unified error notification → Feishu
        errorWatcher.onErrorDetected(evt => {
            if (!feishuClient?.hasTarget()) {
                return;
            }

            const pn = getProjectName(config);
            const now = new Date().toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });

            if (evt.type === 'retry') {
                feishuClient.sendCard(
                    `🔄 ${pn} · Antigravity 自动重试`,
                    [
                        `**项目**：${pn}`,
                        `**事件**：检测到 Antigravity Agent 异常，已自动点击 Retry`,
                        `**累计重试**：第 **${evt.count}** 次`,
                        `**时间**：${now}`,
                        '',
                        '---',
                        '> ⚠️ 如频繁重试，请检查 Agent 状态或手动介入',
                    ].join('\n'),
                    'orange',
                );
            } else if (evt.type === 'quota') {
                feishuClient.sendCard(
                    `🚫 ${pn} · Model 配额用尽`,
                    [
                        `**项目**：${pn}`,
                        `**事件**：检测到 Model quota reached 异常`,
                        evt.detail ? `**详情**：${evt.detail}` : '',
                        `**累计触发**：第 **${evt.count}** 次`,
                        `**时间**：${now}`,
                        '',
                        '---',
                        '> 🚫 模型配额已用尽，Agent 无法继续工作。请升级 Plan 或等待配额刷新后重试。',
                    ].filter(Boolean).join('\n'),
                    'red',
                );
            }
        });

        errorWatcher.start();
        context.subscriptions.push({ dispose: () => errorWatcher!.dispose() });

        // When retry count reaches threshold, restart Antigravity (reload window)
        errorWatcher.onRestartRequired(async (count) => {
            const pn = getProjectName(config);
            const now = new Date().toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            });

            logWarn(
                `🔄 重试已达 ${count} 次，即将重载 VS Code 窗口以完全重启 Antigravity...`,
            );

            // Notify Feishu before restarting
            if (feishuClient?.hasTarget()) {
                await feishuClient.sendCard(
                    `🔄 ${pn} · Antigravity 即将完全重启`,
                    [
                        `**项目**：${pn}`,
                        `**事件**：连续重试已达 **${count}** 次，自动触发完全重启`,
                        `**操作**：重载 VS Code 窗口`,
                        `**时间**：${now}`,
                        '',
                        '---',
                        '> 🔄 窗口即将重载，Antigravity 将完全重启。如重启后仍频繁异常，请手动检查。',
                    ].join('\n'),
                    'red',
                );
            }

            // Small delay to let the Feishu message send
            await sleep(2000);

            // Reload the VS Code window — this fully restarts all extensions including Antigravity
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    }

    // ── 12. Send project-open notification ─────────────────────────────

    if (config.notifyOnOpen && feishuClient.hasTarget()) {
        const pn = getProjectName(config);
        feishuClient.sendOpenMessage(pn).then(ok => {
            if (ok) {
                logSuccess(`已发送项目打开通知: ${pn}`);
            }
        });
    }

    // ── 13. Processing timeout watchdog ───────────────────────────────

    processingTimeoutTimer = setInterval(() => {
        if (messageQueue?.isProcessingTimedOut(PROCESSING_TIMEOUT_MS)) {
            logWarn(
                `⏰ 处理超时（${PROCESSING_TIMEOUT_MS / 60000} 分钟），自动释放 processing 锁`,
            );
            messageQueue.clearProcessed();
            statusBar?.setConnected(messageQueue.getMessageCount());
            refreshConnectionStatus();

            // If new messages arrived during the stalled processing, trigger them
            if (messageQueue.getActionableCount() > 0) {
                logInfo(
                    `队列中有 ${messageQueue.getActionableCount()} 条待处理消息，5s 后自动触发`,
                );
                setTimeout(() => agentBridge?.trigger(), 5000);
            }
        }
    }, 30_000); // check every 30s

    context.subscriptions.push({
        dispose: () => {
            if (processingTimeoutTimer) {
                clearInterval(processingTimeoutTimer);
            }
        },
    });

    logSuccess('飞书机器人插件启动完成');
}

// ── Response file watcher ─────────────────────────────────────────────────

function setupResponseWatcher(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    config: FeishuConfig,
): void {
    const antigravityDir = path.join(workspaceRoot, '.antigravity');
    if (!fs.existsSync(antigravityDir)) {
        fs.mkdirSync(antigravityDir, { recursive: true });
    }

    const pattern = new vscode.RelativePattern(
        antigravityDir,
        'feishu_response.json',
    );

    responseWatcher = vscode.workspace.createFileSystemWatcher(
        pattern,
        /* ignoreCreate */ false,
        /* ignoreChange */ false,
        /* ignoreDelete */ true,
    );

    const handle = async (uri: vscode.Uri) => {
        // Wait briefly so the file is fully written
        await sleep(500);

        if (!fs.existsSync(uri.fsPath)) {
            return;
        }

        try {
            const raw = fs.readFileSync(uri.fsPath, 'utf-8');
            const response: AgentResponse = JSON.parse(raw);

            if (!response.summary) {
                logWarn('响应文件缺少 summary 字段，跳过');
                return;
            }

            logInfo(
                `检测到 Agent 响应: ${response.summary.slice(0, 60)}`,
            );

            // Send result to Feishu
            if (config.notifyOnCompletion && feishuClient) {
                const ok = await feishuClient.sendResult(
                    response.summary,
                    response.details,
                    response.files,
                );
                if (ok) {
                    logSuccess('处理结果已推送到飞书');
                } else {
                    logError('推送结果到飞书失败');
                }
            }

            // Send files if requested by Agent
            if (response.sendFiles && response.sendFiles.length > 0 && feishuClient) {
                logInfo(`Agent 请求发送 ${response.sendFiles.length} 个文件`);
                for (const filePath of response.sendFiles) {
                    // Resolve relative paths against workspace root
                    const absPath = path.isAbsolute(filePath)
                        ? filePath
                        : path.join(workspaceRoot, filePath);
                    const ok = await feishuClient.uploadAndSendFile(absPath);
                    if (!ok) {
                        logWarn(`文件发送失败: ${filePath}`);
                    }
                }
            }

            // Clear queue
            if (messageQueue) {
                const remaining = messageQueue.clearProcessed();
                if (remaining > 0) {
                    logInfo(
                        `队列中还有 ${remaining} 条新消息，5s 后自动触发下一轮`,
                    );
                    setTimeout(() => agentBridge?.trigger(), 5000);
                }
            }

            // Delete the response file
            try {
                fs.unlinkSync(uri.fsPath);
                logInfo('响应文件已清理');
            } catch {
                /* ignore */
            }

            statusBar?.setConnected(
                messageQueue?.getMessageCount() ?? 0,
            );
            refreshConnectionStatus();
        } catch (e: any) {
            logError(`处理响应文件失败: ${e.message}`);
        }
    };

    responseWatcher.onDidCreate(handle);
    responseWatcher.onDidChange(handle);
    context.subscriptions.push(responseWatcher);
}

// ── Commands ──────────────────────────────────────────────────────────────

function registerOpenSettingsCommand(
    context: vscode.ExtensionContext,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('feishu-bot.openSettings', () =>
            vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'feishuBot',
            ),
        ),
    );
}

function registerCommands(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
): void {
    const push = (
        id: string,
        handler: (...args: any[]) => any,
    ) => {
        context.subscriptions.push(
            vscode.commands.registerCommand(id, handler),
        );
    };

    // Open settings
    push('feishu-bot.openSettings', () =>
        vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'feishuBot',
        ),
    );

    // Connect
    push('feishu-bot.connect', async () => {
        if (feishuListener?.isConnected()) {
            vscode.window.showInformationMessage('飞书已连接');
            return;
        }
        try {
            statusBar?.setConnecting();
            await feishuListener?.start();
            vscode.window.showInformationMessage('✅ 飞书已连接');
        } catch (e: any) {
            statusBar?.setError(e.message);
            vscode.window.showErrorMessage(
                `飞书连接失败: ${e.message}`,
            );
        }
    });

    // Disconnect
    push('feishu-bot.disconnect', () => {
        feishuListener?.stop();
        statusBar?.setDisconnected();
        vscode.window.showInformationMessage('飞书已断开');
    });

    // Send text
    push('feishu-bot.sendText', async (text?: string) => {
        if (!text) {
            text = await vscode.window.showInputBox({
                prompt: '输入要发送到飞书的消息',
                placeHolder: '消息内容...',
            });
        }
        if (text && feishuClient) {
            const ok = await feishuClient.sendText(text);
            if (ok) {
                vscode.window.showInformationMessage('✅ 消息已发送');
            }
        }
    });

    // Send result
    push(
        'feishu-bot.sendResult',
        async (summary?: string, details?: string) => {
            if (!summary) {
                summary = await vscode.window.showInputBox({
                    prompt: '处理结果摘要',
                });
            }
            if (summary && feishuClient) {
                const ok = await feishuClient.sendResult(
                    summary,
                    details,
                );
                if (ok) {
                    messageQueue?.clearProcessed();
                    vscode.window.showInformationMessage(
                        '✅ 结果已推送到飞书',
                    );
                }
            }
        },
    );

    // Read messages
    push('feishu-bot.readMessages', () => {
        const msgs = messageQueue?.peek() ?? [];
        if (msgs.length === 0) {
            vscode.window.showInformationMessage('📭 暂无待处理消息');
        } else {
            const output = msgs
                .map(m => `[${m.time}] ${m.text}`)
                .join('\n');
            showOutputChannel();
            logInfo(`当前队列 (${msgs.length} 条):\n${output}`);
        }
    });

    // Clear messages
    push('feishu-bot.clearMessages', () => {
        messageQueue?.clearProcessed();
        vscode.window.showInformationMessage('✅ 消息队列已清空');
    });

    // Manual trigger
    push('feishu-bot.triggerAgent', async () => {
        const ok = await agentBridge?.trigger();
        if (!ok) {
            vscode.window.showWarningMessage(
                '无法触发 Agent（队列为空或正在处理中）',
            );
        }
    });

    // Status
    push('feishu-bot.showStatus', () => {
        const items = [
            `WebSocket: ${feishuListener?.isConnected() ? '✅' : '❌'}`,
            `双向通信: ${feishuClient?.hasTarget() ? '✅' : '⏳'}`,
            `待处理: ${messageQueue?.getMessageCount() ?? 0} 条`,
            `Agent: ${messageQueue?.isProcessing() ? '🔄' : '💤'}`,
            `自动重试: ${errorWatcher?.isRunning() ? `✅ (累计 ${errorWatcher.getRetryCount()} 次, 连续 ${errorWatcher.getConsecutiveRetryCount()} 次, 配额 ${errorWatcher.getQuotaCount()} 次)` : '❌'}`,
        ];
        showOutputChannel();
        logInfo(`飞书状态:\n  ${items.join('\n  ')}`);
        vscode.window.showInformationMessage(items.join(' | '));
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function refreshConnectionStatus(): void {
    connStatusProvider?.update({
        connected: feishuListener?.isConnected() ?? false,
        hasTarget: feishuClient?.hasTarget() ?? false,
        processing: messageQueue?.isProcessing() ?? false,
        messageCount: messageQueue?.getMessageCount() ?? 0,
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Deactivate ────────────────────────────────────────────────────────────

export function deactivate(): void {
    logInfo('飞书机器人插件正在停止...');
    feishuListener?.stop();
    errorWatcher?.dispose();
    messageQueue?.dispose();
    responseWatcher?.dispose();
    disposeLogger();
}
