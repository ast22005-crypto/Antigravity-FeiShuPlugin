/**
 * agent/completionDetector.ts — Detect Agent completion & workspace changes
 *
 * When the message queue enters "processing" state, this module takes a
 * snapshot of the workspace's key file modification times. When processing
 * times out without a feishu_response.json being created, the snapshot is
 * compared against current state to determine what changed, enabling a
 * useful fallback notification to be sent to Feishu.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn } from '../utils/logger';

/** A snapshot entry: relative path + mtime */
interface FileSnapshot {
    relativePath: string;
    mtime: number;
    size: number;
}

/** Result of comparing two snapshots */
export interface SnapshotDiff {
    created: string[];
    modified: string[];
    hasChanges: boolean;
}

/** Directories to skip when snapshotting (performance) */
const IGNORED_DIRS = new Set([
    'node_modules',
    '.git',
    '.antigravity',
    'out',
    'dist',
    '.next',
    '.vscode',
    '.agents',
    '__pycache__',
]);

/** Max files to track (avoid OOM on huge repos) */
const MAX_SNAPSHOT_FILES = 2000;

/** Max depth when walking directories */
const MAX_DEPTH = 6;

export class CompletionDetector {
    private workspaceRoot: string;
    private snapshot: Map<string, FileSnapshot> | null = null;
    private snapshotTime: number = 0;
    private processingMessages: string[] = [];

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Take a snapshot of the current workspace file states.
     * Call this when entering "processing" state.
     *
     * @param messageTexts - The original Feishu message texts being processed
     */
    takeSnapshot(messageTexts: string[]): void {
        this.processingMessages = messageTexts;
        this.snapshotTime = Date.now();

        try {
            const files = this.walkDir(this.workspaceRoot, '', 0);
            this.snapshot = new Map(
                files.map(f => [f.relativePath, f]),
            );
            logInfo(
                `[CompletionDetector] 已拍快照: ${this.snapshot.size} 个文件`,
            );
        } catch (e: any) {
            logWarn(
                `[CompletionDetector] 快照失败: ${e.message}`,
            );
            this.snapshot = null;
        }
    }

    /**
     * Compare current workspace state against the saved snapshot.
     * Returns a diff of created and modified files.
     */
    compareSnapshot(): SnapshotDiff {
        const result: SnapshotDiff = {
            created: [],
            modified: [],
            hasChanges: false,
        };

        if (!this.snapshot) {
            return result;
        }

        try {
            const current = this.walkDir(this.workspaceRoot, '', 0);

            for (const file of current) {
                const prev = this.snapshot.get(file.relativePath);
                if (!prev) {
                    result.created.push(file.relativePath);
                } else if (
                    file.mtime > prev.mtime ||
                    file.size !== prev.size
                ) {
                    result.modified.push(file.relativePath);
                }
            }

            result.hasChanges =
                result.created.length > 0 || result.modified.length > 0;

            if (result.hasChanges) {
                logInfo(
                    `[CompletionDetector] 检测到变更: ${result.created.length} 新建, ${result.modified.length} 修改`,
                );
            }
        } catch (e: any) {
            logWarn(
                `[CompletionDetector] 对比失败: ${e.message}`,
            );
        }

        return result;
    }

    /**
     * Get the original Feishu messages that were being processed.
     */
    getProcessingMessages(): string[] {
        return this.processingMessages;
    }

    /**
     * Get the time when the snapshot was taken.
     */
    getSnapshotTime(): number {
        return this.snapshotTime;
    }

    /**
     * Clear the snapshot (after processing completes normally).
     */
    clear(): void {
        this.snapshot = null;
        this.processingMessages = [];
        this.snapshotTime = 0;
    }

    /**
     * Build a human-readable summary of workspace changes for the
     * fallback Feishu notification.
     */
    buildChangeSummary(diff: SnapshotDiff): string {
        if (!diff.hasChanges) {
            return '未检测到工作区文件变更。';
        }

        const lines: string[] = [];

        if (diff.created.length > 0) {
            lines.push('**新建文件：**');
            for (const f of diff.created.slice(0, 8)) {
                lines.push(`  + \`${f}\``);
            }
            if (diff.created.length > 8) {
                lines.push(`  ... 另有 ${diff.created.length - 8} 个文件`);
            }
        }

        if (diff.modified.length > 0) {
            if (lines.length > 0) {
                lines.push('');
            }
            lines.push('**修改文件：**');
            for (const f of diff.modified.slice(0, 8)) {
                lines.push(`  · \`${f}\``);
            }
            if (diff.modified.length > 8) {
                lines.push(`  ... 另有 ${diff.modified.length - 8} 个文件`);
            }
        }

        return lines.join('\n');
    }

    // ── Private helpers ───────────────────────────────────────────────────

    /**
     * Recursively walk a directory, collecting file metadata.
     */
    private walkDir(
        baseDir: string,
        relativeTo: string,
        depth: number,
    ): FileSnapshot[] {
        if (depth > MAX_DEPTH) {
            return [];
        }

        const results: FileSnapshot[] = [];
        let entries: fs.Dirent[];

        try {
            entries = fs.readdirSync(baseDir, { withFileTypes: true });
        } catch {
            return [];
        }

        for (const entry of entries) {
            if (results.length >= MAX_SNAPSHOT_FILES) {
                break;
            }

            const relPath = relativeTo
                ? `${relativeTo}/${entry.name}`
                : entry.name;

            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
                    continue;
                }
                const subFiles = this.walkDir(
                    path.join(baseDir, entry.name),
                    relPath,
                    depth + 1,
                );
                results.push(...subFiles);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(
                        path.join(baseDir, entry.name),
                    );
                    results.push({
                        relativePath: relPath,
                        mtime: stat.mtimeMs,
                        size: stat.size,
                    });
                } catch {
                    // Skip files we can't stat
                }
            }
        }

        return results;
    }
}
