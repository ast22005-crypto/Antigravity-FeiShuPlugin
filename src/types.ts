/**
 * Shared type definitions for the Feishu Bot extension.
 */

/** Extension configuration from VS Code Settings (feishuBot.*) */
export interface FeishuConfig {
    appId: string;
    appSecret: string;
    enabled: boolean;
    projectName: string;
    notifyOnOpen: boolean;
    notifyOnCompletion: boolean;
    autoTriggerAgent: boolean;
    triggerCooldown: number;
}

/** A message received from Feishu */
export interface FeishuMessage {
    messageId: string;
    chatType: 'p2p' | 'group';
    openId: string;
    chatId: string;
    msgType: string;
    text: string;
    time: string;
    pendingInstruction?: boolean;
}

/** The send target — recorded when the first message is received */
export interface FeishuTarget {
    targetId: string;
    targetType: 'p2p' | 'group';
}

/** Persisted queue data structure (.antigravity/feishu_messages.json) */
export interface QueueData {
    messages: FeishuMessage[];
    processingMessages: FeishuMessage[];
    processing: boolean;
    processingSince?: string;
    lastUpdated?: string;
    lastRead?: string;
    cleared?: string;
}

/** Agent response format (.antigravity/feishu_response.json) */
export interface AgentResponse {
    summary: string;
    details?: string;
    files?: string[];
    /** File paths to upload and send to the Feishu user */
    sendFiles?: string[];
    timestamp?: string;
}
