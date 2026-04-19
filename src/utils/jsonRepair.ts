/**
 * utils/jsonRepair.ts — Robust JSON parser for AI-generated content
 *
 * AI agents sometimes produce JSON with unescaped double quotes inside
 * string values (e.g. 管家透露画题首字"龙"), causing JSON.parse to fail.
 *
 * This module provides a multi-strategy parser:
 *   1. Direct JSON.parse
 *   2. Iterative repair guided by parse-error position
 *   3. Regex-based field extraction as last resort
 */

import { logWarn } from './logger';

/**
 * Parse JSON string with automatic repair for common AI generation errors.
 * Falls back through multiple strategies to maximise success rate.
 */
export function safeJsonParse<T = any>(raw: string): T {
    // ── Strategy 1: Direct parse ──────────────────────────────────────
    try {
        return JSON.parse(raw);
    } catch {
        // Continue to repair strategies
    }

    logWarn('JSON 直接解析失败，尝试自动修复…');

    // ── Strategy 2: Iterative error-position repair ───────────────────
    // V8 reports error positions like "at position 123".
    // Each iteration finds the unescaped " that caused the error and
    // escapes it, then retries. Converges in O(n) iterations where n
    // is the number of unescaped quotes.
    let repaired = raw;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const result = JSON.parse(repaired);
            logWarn(`JSON 自动修复成功（第 ${attempt + 1} 次迭代）`);
            return result;
        } catch (e: any) {
            const msg: string = e.message || '';
            // V8: "... at position 123" or "... at position 123 (line 4 column 5)"
            const posMatch = msg.match(/position\s+(\d+)/i);
            if (!posMatch) {
                break; // Can't determine error position; give up iterating
            }

            const errorPos = parseInt(posMatch[1], 10);

            // The parse error occurs because an unescaped " prematurely
            // closed the string, causing the next character to be unexpected.
            // Scan backward from errorPos to find that unescaped ".
            const quotePos = findPreviousUnescapedQuote(repaired, errorPos);
            if (quotePos < 0) {
                break; // Nothing to fix
            }

            // Escape the problematic quote
            repaired =
                repaired.substring(0, quotePos) +
                '\\"' +
                repaired.substring(quotePos + 1);
        }
    }

    // One final attempt after all iterations
    try {
        const result = JSON.parse(repaired);
        logWarn('JSON 自动修复成功（迭代完成后）');
        return result;
    } catch {
        // Continue to fallback
    }

    // ── Strategy 3: Regex-based field extraction (last resort) ────────
    logWarn('迭代修复失败，使用正则提取兜底');
    return extractFieldsFallback(raw) as T;
}

/**
 * Scan backward from `startPos` to find the nearest unescaped `"`.
 * Returns -1 if none found.
 */
function findPreviousUnescapedQuote(
    str: string,
    startPos: number,
): number {
    for (let i = Math.min(startPos, str.length) - 1; i >= 0; i--) {
        if (str[i] === '"') {
            // Count preceding backslashes to determine if this quote is escaped
            let backslashCount = 0;
            for (let j = i - 1; j >= 0 && str[j] === '\\'; j--) {
                backslashCount++;
            }
            // Quote is unescaped if preceded by even number of backslashes
            if (backslashCount % 2 === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Last-resort extraction: pull known fields from malformed JSON using
 * structural landmarks (key names) rather than quote matching.
 *
 * This handles the case where iterative repair doesn't converge,
 * e.g. extremely mangled output. We at least try to recover `summary`
 * so the Feishu notification can go through.
 */
function extractFieldsFallback(raw: string): Record<string, any> {
    const result: Record<string, any> = {};

    // Known fields and their order of appearance
    const fields = ['summary', 'details', 'files', 'sendFiles'];

    // Build a map of field positions
    const fieldPositions: { field: string; start: number; end: number }[] = [];
    for (const field of fields) {
        const keyRegex = new RegExp(`"${field}"\\s*:\\s*`);
        const match = keyRegex.exec(raw);
        if (match && match.index !== undefined) {
            fieldPositions.push({
                field,
                start: match.index + match[0].length,
                end: raw.length,
            });
        }
    }

    // Sort by position and set each field's end to the next field's key start
    fieldPositions.sort((a, b) => a.start - b.start);
    for (let i = 0; i < fieldPositions.length - 1; i++) {
        // Find the comma + whitespace + quote before the next key
        const nextKeyPos = raw.lastIndexOf(
            `"${fieldPositions[i + 1].field}"`,
            fieldPositions[i + 1].start,
        );
        if (nextKeyPos > fieldPositions[i].start) {
            fieldPositions[i].end = nextKeyPos;
        }
    }
    // Last field ends before the final `}`
    if (fieldPositions.length > 0) {
        const lastBrace = raw.lastIndexOf('}');
        if (lastBrace > 0) {
            fieldPositions[fieldPositions.length - 1].end = lastBrace;
        }
    }

    for (const fp of fieldPositions) {
        const rawValue = raw.substring(fp.start, fp.end).trim();

        if (rawValue.startsWith('[')) {
            // Array field — extract string items
            try {
                // Try to parse the array portion as JSON
                const arrEnd = findMatchingBracket(rawValue, 0);
                const arrStr = rawValue.substring(0, arrEnd + 1);
                result[fp.field] = JSON.parse(arrStr);
            } catch {
                // Extract items manually
                const items: string[] = [];
                const itemRegex = /"([^"]*?)"/g;
                let m;
                while ((m = itemRegex.exec(rawValue)) !== null) {
                    items.push(m[1]);
                }
                result[fp.field] = items;
            }
        } else if (rawValue.startsWith('"')) {
            // String field — extract between first " and last " before trailing comma
            let stripped = rawValue;
            // Remove trailing comma if present
            stripped = stripped.replace(/,\s*$/, '');
            // Remove surrounding quotes
            if (stripped.startsWith('"') && stripped.endsWith('"')) {
                stripped = stripped.substring(1, stripped.length - 1);
            }
            // Unescape standard JSON escapes
            result[fp.field] = stripped
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
    }

    return result;
}

/**
 * Find the matching `]` for a `[` at position `start`.
 */
function findMatchingBracket(str: string, start: number): number {
    let depth = 0;
    let inString = false;
    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
            if (ch === '\\') {
                i++; // skip escaped char
            } else if (ch === '"') {
                inString = false;
            }
        } else {
            if (ch === '"') {
                inString = true;
            } else if (ch === '[') {
                depth++;
            } else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    return i;
                }
            }
        }
    }
    return str.length - 1;
}
