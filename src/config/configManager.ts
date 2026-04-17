import * as vscode from 'vscode';
import { FeishuConfig } from '../types';

const SECTION = 'feishuBot';

/** Read extension configuration from VS Code Settings */
export function loadConfig(): FeishuConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
        appId: cfg.get<string>('appId', ''),
        appSecret: cfg.get<string>('appSecret', ''),
        enabled: cfg.get<boolean>('enabled', true),
        projectName: cfg.get<string>('projectName', ''),
        notifyOnOpen: cfg.get<boolean>('notifyOnOpen', true),
        notifyOnCompletion: cfg.get<boolean>('notifyOnCompletion', true),
        autoTriggerAgent: cfg.get<boolean>('autoTriggerAgent', true),
        triggerCooldown: cfg.get<number>('triggerCooldown', 10),
    };
}

/** Check if app_id and app_secret are set and extension is enabled */
export function isConfigured(config: FeishuConfig): boolean {
    return !!(config.appId && config.appSecret && config.enabled);
}

/** Project display name — uses setting value, falls back to workspace folder name */
export function getProjectName(config: FeishuConfig): string {
    if (config.projectName) {
        return config.projectName;
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].name;
    }
    return 'Unknown Project';
}

/** Register a callback for configuration changes */
export function onConfigChange(
    callback: (config: FeishuConfig) => void,
): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(SECTION)) {
            callback(loadConfig());
        }
    });
}
