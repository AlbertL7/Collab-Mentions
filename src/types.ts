// Types for Collab Mentions Plugin

export type UserStatus = 'active' | 'snooze' | 'offline';

// Manual status includes 'auto' option to use automatic detection
export type ManualStatus = 'auto' | 'active' | 'snooze' | 'offline';

export type AdminLevel = 'primary' | 'secondary';

export interface VaultUser {
    vaultName: string;
    localIdentifier: string;  // username@hostname
    os: string;
    registered: string;
    registrationNumber?: number;  // Order of registration (1 = first user)
    color?: string;  // For UI differentiation
    isAdmin?: boolean;  // Admin users have elevated permissions
    adminLevel?: AdminLevel;  // 'primary' = original admin, 'secondary' = promoted admin
}

export interface UserPresence {
    vaultName: string;
    lastSeen: string;  // ISO timestamp - when vault was last open (heartbeat)
    lastActivity?: string;  // ISO timestamp - when user last interacted with a file
    activeFile?: string;  // Currently open file (optional)
    manualStatus?: ManualStatus;  // User's manually set status (overrides automatic)
    typingInChannel?: string;  // Channel ID where user is currently typing
    typingStarted?: string;  // ISO timestamp when typing started
}

export interface PresenceData {
    presence: UserPresence[];
}

export interface UsersConfig {
    users: VaultUser[];
}

export interface Mention {
    id: string;
    to: string;
    from: string;
    file: string;
    line: number;
    context: string;
    timestamp: string;
    read: boolean;
    readAt?: string;  // When the recipient marked it as read
    notifiedIds?: string[];  // Track which machines have been notified (local only)
    replies?: MentionReply[];
}

export interface MentionReply {
    id: string;
    from: string;
    message: string;
    timestamp: string;
}

export interface MentionsData {
    mentions: Mention[];
    lastCleanup?: string;
}

export interface ChatReaction {
    emoji: string;
    users: string[];  // usernames who reacted
}

export interface ChatMessage {
    id: string;
    from: string;
    message: string;
    timestamp: string;
    fileLinks?: string[];  // Array of file paths linked in message
    mentions?: string[];   // Array of @mentioned usernames
    channelMentions?: string[];  // Array of @#mentioned channel IDs
    images?: ChatImage[];  // Array of embedded images
    reactions?: ChatReaction[];  // Emoji reactions
    edited?: boolean;
    editedAt?: string;
    deleted?: boolean;  // Soft delete - shows "message deleted"
    replyTo?: string;  // ID of message being replied to
}

export interface ChatImage {
    id: string;
    filename: string;
    path: string;  // Path in vault
}

// Legacy chat data format (v1) - single channel
export interface ChatDataV1 {
    version?: 1;
    messages: ChatMessage[];
    lastReadTimestamp?: { [username: string]: string };
}

// Channel types
export type ChannelType = 'general' | 'group' | 'dm';

export const GENERAL_CHANNEL_ID = 'general';

// Channel definition
export interface Channel {
    id: string;
    type: ChannelType;
    name: string;
    members: string[];         // Empty array for general = all users
    createdBy: string;
    createdAt: string;
}

// Track deleted channels to sync deletions across computers
export interface DeletedChannel {
    id: string;
    deletedAt: string;  // ISO timestamp
    deletedBy: string;  // Who deleted it
}

// New chat data format (v2) - multi-channel
export interface ChatDataV2 {
    version: 2;
    channels: Channel[];
    channelMessages: { [channelId: string]: ChatMessage[] };
    readState: { [channelId: string]: { [username: string]: string } };
    mutedChannels?: { [username: string]: string[] };  // User -> muted channel IDs
    deletedChannels?: DeletedChannel[];  // Track deleted channels to sync across computers
    _checksum?: string;  // File integrity check - computed from content (excluding this field)
}

// Union type for migration compatibility
export type ChatData = ChatDataV1 | ChatDataV2;

// ===== Reminders =====

export type ReminderPriority = 'low' | 'normal' | 'high';

export interface Reminder {
    id: string;
    user: string;           // Who created the reminder
    message: string;        // The reminder text
    dueDate: string;        // ISO timestamp when due
    createdAt: string;      // ISO timestamp when created
    completed: boolean;     // Whether it's been marked done
    completedAt?: string;   // When it was completed
    notified: boolean;      // Whether notification was shown
    notifiedUsers?: string[];  // Track which users have been notified (for global reminders)
    priority: ReminderPriority;
    linkedFile?: string;    // Optional file link
    isGlobal: boolean;      // If true, visible and notifies all users
    recurring?: {           // Optional recurring settings
        type: 'daily' | 'weekly' | 'monthly';
        interval: number;   // e.g., every 2 days
    };
}

export interface RemindersData {
    reminders: Reminder[];
    lastChecked?: string;   // Last time we checked for due reminders
}

export interface CollabMentionsSettings {
    enableNotifications: boolean;
    notificationSound: boolean;
    autoMarkReadDelay: number;  // seconds, 0 = manual only
    showMentionHighlights: boolean;
    mentionColor: string;
    autoCleanup: boolean;
    maxMentionsPerUser: number;
    cleanupIntervalHours: number;
    enableFileWatcher: boolean;  // Watch for changes while vault is open
    // Per-user notification tracking (keyed by username so each user has separate tracking)
    notifiedMentionIdsByUser: { [username: string]: string[] };  // Mention IDs already notified per user
    lastNotifiedChatTimestampByUser: { [username: string]: { [channelId: string]: string } };  // Per user, per channel
}

export const DEFAULT_SETTINGS: CollabMentionsSettings = {
    enableNotifications: true,
    notificationSound: true,
    autoMarkReadDelay: 0,
    showMentionHighlights: true,
    mentionColor: '#7c3aed',
    autoCleanup: true,
    maxMentionsPerUser: 30,
    cleanupIntervalHours: 24,
    enableFileWatcher: true,
    notifiedMentionIdsByUser: {},
    lastNotifiedChatTimestampByUser: {}
};