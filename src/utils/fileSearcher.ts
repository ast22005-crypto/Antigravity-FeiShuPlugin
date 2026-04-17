/**
 * utils/fileSearcher.ts — Workspace file search utility
 *
 * Recursively searches the workspace for files matching a given query.
 * Supports exact filename match, partial match, and glob-like patterns.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Directories to skip during search */
const IGNORED_DIRS = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    'out',
    'dist',
    'build',
    '.antigravity',
    '.agents',
    '.vscode',
    '__pycache__',
    '.next',
    '.nuxt',
    'coverage',
]);

/** Maximum search depth to avoid extremely deep trees */
const MAX_DEPTH = 20;

/** Maximum number of results to return */
const MAX_RESULTS = 50;

export interface FileSearchResult {
    /** Absolute path to the matched file */
    absolutePath: string;
    /** Path relative to the workspace root */
    relativePath: string;
    /** File size in bytes */
    size: number;
}

export class FileSearcher {
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Search for files matching the given query.
     *
     * Matching strategy (in priority order):
     *  1. Exact filename match (case-insensitive)
     *  2. Filename starts-with match
     *  3. Filename contains match (substring)
     *  4. Relative path contains match
     *
     * Results are sorted: exact matches first, then by path length (shorter = better).
     */
    search(query: string): FileSearchResult[] {
        if (!query || !query.trim()) {
            return [];
        }

        const normalizedQuery = query.trim().toLowerCase();
        const allFiles: FileSearchResult[] = [];

        this.walkDir(this.workspaceRoot, 0, allFiles);

        // Categorize matches by quality
        const exact: FileSearchResult[] = [];
        const startsWith: FileSearchResult[] = [];
        const contains: FileSearchResult[] = [];
        const pathContains: FileSearchResult[] = [];

        for (const f of allFiles) {
            const baseName = path.basename(f.relativePath).toLowerCase();
            const relLower = f.relativePath.toLowerCase();

            if (baseName === normalizedQuery) {
                exact.push(f);
            } else if (baseName.startsWith(normalizedQuery)) {
                startsWith.push(f);
            } else if (baseName.includes(normalizedQuery)) {
                contains.push(f);
            } else if (relLower.includes(normalizedQuery)) {
                pathContains.push(f);
            }
        }

        // Sort each category by path length (shorter is more relevant)
        const sortByPathLen = (a: FileSearchResult, b: FileSearchResult) =>
            a.relativePath.length - b.relativePath.length;

        exact.sort(sortByPathLen);
        startsWith.sort(sortByPathLen);
        contains.sort(sortByPathLen);
        pathContains.sort(sortByPathLen);

        // Merge in priority order, capping total results
        const merged = [...exact, ...startsWith, ...contains, ...pathContains];
        return merged.slice(0, MAX_RESULTS);
    }

    /**
     * Recursively walk a directory and collect file entries.
     */
    private walkDir(
        dir: string,
        depth: number,
        results: FileSearchResult[],
    ): void {
        if (depth > MAX_DEPTH || results.length >= MAX_RESULTS * 5) {
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // Permission denied or inaccessible
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) {
                continue;
            }

            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) {
                    continue;
                }
                this.walkDir(fullPath, depth + 1, results);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    results.push({
                        absolutePath: fullPath,
                        relativePath: path.relative(
                            this.workspaceRoot,
                            fullPath,
                        ),
                        size: stat.size,
                    });
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }

    /**
     * Format file size for display.
     */
    static formatSize(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
