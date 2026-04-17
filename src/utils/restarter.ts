import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import { logInfo, logError } from './logger';

/**
 * Initiates a thorough restart of the Antigravity application.
 * Spawns a detached background script that waits slightly, 
 * kills all Antigravity processes, and restarts it with the current workspace.
 */
export function hardRestartAntigravity(extensionPath: string): void {
    try {
        const execPath = process.execPath;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspacePath = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';

        const scriptPath = path.join(extensionPath, 'resources', 'hard_restart.ps1');

        logInfo(`[Restarter] ExecPath: ${execPath}`);
        logInfo(`[Restarter] Workspace: ${workspacePath}`);
        logInfo(`[Restarter] ScriptPath: ${scriptPath}`);

        // We use powershell on Windows to do a hard restart
        if (process.platform === 'win32') {
            const child = child_process.spawn('powershell.exe', [
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptPath,
                '-ExecPath', execPath,
                '-WorkspacePath', workspacePath
            ], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });

            child.unref();

            logInfo('🔄 已触发后台强刷进程，即将关闭当前窗口...');
            // Tell VS Code to wait and quit or reload (the external script will kill it anyway)
            // Using reloadWindow or quit to fail fast visually
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
            // Fallback for non-Windows platforms: just reload window
            logInfo('🔄 非 Windows 平台，使用常规重载窗口');
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (e: any) {
        logError(`触发强制重启失败: ${e.message}`);
        // Fallback
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
