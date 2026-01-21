import { App } from 'obsidian';
import { ChatMessage, ChatData, ChatDataV1, ChatDataV2, ChatImage, ChatReaction, Channel, ChannelType, GENERAL_CHANNEL_ID, DeletedChannel } from './types';
import { UserManager } from './userManager';

const CHAT_FILE = '.collab-mentions/chat.json';
const IMAGES_FOLDER = '.collab-mentions/images';
const MAX_MESSAGES_PER_CHANNEL = 200;
const MAX_SAVE_RETRIES = 3;
const MAX_LOAD_RETRIES = 3;
const DELETED_CHANNEL_RETENTION_MS = 24 * 60 * 60 * 1000; // Keep deleted channel records for 24 hours

export class ChatManager {
    private app: App;
    private userManager: UserManager;
    private chatData: ChatDataV2;
    private activeChannelId: string = GENERAL_CHANNEL_ID;
    // Safeguard: Track recently sent messages to prevent loss during sync conflicts
    private recentlySentMessages: Map<string, { channelId: string; message: ChatMessage; timestamp: number }> = new Map();
    private readonly MESSAGE_PROTECTION_DURATION = 60000; // Protect messages for 60 seconds
    // Track recently dismissed messages to prevent them from being re-added during merge
    private recentlyDismissedMessages: Map<string, number> = new Map();
    private readonly DISMISS_PROTECTION_DURATION = 60000; // Prevent re-add for 60 seconds
    // Track recently deleted channels to prevent re-add during sync
    private recentlyDeletedChannels: Map<string, number> = new Map();
    private readonly CHANNEL_DELETE_PROTECTION = 300000; // 5 minutes protection
    // Track channels the current user recently left to prevent re-adding during merge
    private recentlyLeftChannels: Map<string, number> = new Map();
    private readonly LEAVE_PROTECTION_DURATION = 300000; // 5 minutes protection
    // Track recently added members to prevent removal during merge conflicts
    // Key: channelId, Value: Map<username, timestamp>
    private recentlyAddedMembers: Map<string, Map<string, number>> = new Map();
    private readonly ADD_MEMBER_PROTECTION_DURATION = 300000; // 5 minutes protection
    // Track recently toggled reactions to properly sync removals
    // Key: messageId, Value: Map<"emoji|username" -> { added: boolean, timestamp: number }>
    private recentlyToggledReactions: Map<string, Map<string, { added: boolean; timestamp: number }>> = new Map();
    private readonly REACTION_TOGGLE_PROTECTION_DURATION = 60000; // 60 seconds protection

    constructor(app: App, userManager: UserManager) {
        this.app = app;
        this.userManager = userManager;
        // Initialize with empty v2 structure
        this.chatData = this.createEmptyV2Data();
    }

    /**
     * Fast non-cryptographic hash (FNV-1a) for verification and deduplication
     * Much faster than SHA-256 - optimized for speed, not security
     */
    private computeHash(content: string): string {
        let hash = 2166136261; // FNV offset basis
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = (hash * 16777619) >>> 0; // FNV prime, keep as 32-bit unsigned
        }
        return hash.toString(16);
    }

    /**
     * Compute checksum for data integrity validation (excluding the _checksum field itself)
     */
    private computeDataChecksum(data: ChatDataV2): string {
        const dataWithoutChecksum = { ...data };
        delete dataWithoutChecksum._checksum;
        return this.computeHash(JSON.stringify(dataWithoutChecksum));
    }

    /**
     * Validate file integrity by checking the checksum
     * Returns true if valid, false if corrupted/incomplete
     */
    private validateDataIntegrity(data: ChatDataV2): boolean {
        if (!data._checksum) {
            // No checksum present - file may be from older version, allow it
            return true;
        }
        const expectedChecksum = this.computeDataChecksum(data);
        const valid = data._checksum === expectedChecksum;
        if (!valid) {
            console.warn('[Collab-Mentions] Checksum mismatch - file may be corrupted or incomplete');
        }
        return valid;
    }

    /**
     * Generate a content-based hash for a chat message (for notification deduplication)
     * Includes images in the hash to properly dedupe image-only messages
     */
    getMessageContentHash(message: ChatMessage): string {
        // Include image IDs in hash if present
        const imageIds = message.images ? message.images.map(i => i.id).join(',') : '';
        const content = `${message.from}|${message.message}|${message.timestamp}|${imageIds}`;
        return this.computeHash(content);
    }

    /**
     * Check if a message was recently dismissed and should not be re-added
     */
    private isRecentlyDismissed(messageId: string): boolean {
        const dismissedTime = this.recentlyDismissedMessages.get(messageId);
        if (!dismissedTime) return false;

        const now = Date.now();
        if (now - dismissedTime > this.DISMISS_PROTECTION_DURATION) {
            this.recentlyDismissedMessages.delete(messageId);
            return false;
        }
        return true;
    }

    /**
     * Merge updates from disk message into our in-memory message
     * Handles reactions, edits, and deletions
     *
     * MERGE STRATEGY:
     * - Reactions: ADDITIVE merge (combine all unique emoji+user pairs from both)
     *   BUT respects recent toggles - if current user recently removed a reaction,
     *   it won't be re-added from disk during the protection window.
     * - Edits: Disk wins if disk shows edited and we don't (disk is newer)
     * - Deletions: Disk wins if disk shows deleted (deletions are authoritative)
     */
    private mergeMessageUpdates(ourMsg: ChatMessage, diskMsg: ChatMessage): void {
        // === MERGE REACTIONS ===
        // Strategy: Additive merge with protection for recent local toggles
        // This ensures no reactions are lost while respecting intentional removals

        const mergedReactions: ChatReaction[] = [];
        const emojiMap = new Map<string, Set<string>>(); // emoji -> Set<username>

        // Collect all reactions from our message
        if (ourMsg.reactions) {
            for (const reaction of ourMsg.reactions) {
                if (!emojiMap.has(reaction.emoji)) {
                    emojiMap.set(reaction.emoji, new Set());
                }
                for (const user of reaction.users) {
                    emojiMap.get(reaction.emoji)!.add(user);
                }
            }
        }

        // Merge reactions from disk message, BUT respect recent toggles
        if (diskMsg.reactions) {
            for (const reaction of diskMsg.reactions) {
                if (!emojiMap.has(reaction.emoji)) {
                    emojiMap.set(reaction.emoji, new Set());
                }
                for (const user of reaction.users) {
                    // Check if current user recently toggled this specific reaction
                    const recentToggle = this.getRecentReactionToggle(ourMsg.id, reaction.emoji, user);
                    if (recentToggle && !recentToggle.added) {
                        // User recently REMOVED this reaction - don't re-add from disk
                        console.log(`[Collab-Mentions] Merge: Skipping re-add of ${reaction.emoji} by ${user} (recently removed)`);
                        continue;
                    }
                    emojiMap.get(reaction.emoji)!.add(user);
                }
            }
        }

        // Also ensure recently ADDED reactions are preserved even if not on disk yet
        const msgToggles = this.recentlyToggledReactions.get(ourMsg.id);
        if (msgToggles) {
            const now = Date.now();
            for (const [key, toggle] of msgToggles) {
                if (now - toggle.timestamp > this.REACTION_TOGGLE_PROTECTION_DURATION) {
                    msgToggles.delete(key);
                    continue;
                }
                if (toggle.added) {
                    const [emoji, username] = key.split('|');
                    if (!emojiMap.has(emoji)) {
                        emojiMap.set(emoji, new Set());
                    }
                    emojiMap.get(emoji)!.add(username);
                }
            }
        }

        // Convert back to array format
        for (const [emoji, users] of emojiMap) {
            if (users.size > 0) {
                mergedReactions.push({
                    emoji,
                    users: Array.from(users)
                });
            }
        }

        // Handle reaction removals: If disk has NO reactions at all and we do,
        // AND the disk message has been edited more recently, trust disk
        // Otherwise, keep our additive merge
        if (diskMsg.reactions === undefined && ourMsg.reactions && ourMsg.reactions.length > 0) {
            // Check if disk message was edited/updated after our version
            // If disk has editedAt and it's newer, or disk is deleted, trust disk
            if (diskMsg.deleted || (diskMsg.editedAt && ourMsg.editedAt &&
                new Date(diskMsg.editedAt) > new Date(ourMsg.editedAt))) {
                ourMsg.reactions = undefined;
            } else {
                // Keep our reactions - they might not have synced to disk yet
                ourMsg.reactions = mergedReactions.length > 0 ? mergedReactions : undefined;
            }
        } else {
            ourMsg.reactions = mergedReactions.length > 0 ? mergedReactions : undefined;
        }

        // === MERGE EDITED STATE ===
        // If disk shows edited and we don't, or disk edit is newer, take disk version
        if (diskMsg.edited) {
            if (!ourMsg.edited) {
                // Disk has edit, we don't - take disk
                ourMsg.edited = diskMsg.edited;
                ourMsg.editedAt = diskMsg.editedAt;
                ourMsg.message = diskMsg.message;
                ourMsg.mentions = diskMsg.mentions;
                ourMsg.fileLinks = diskMsg.fileLinks;
                ourMsg.channelMentions = diskMsg.channelMentions;
            } else if (diskMsg.editedAt && ourMsg.editedAt) {
                // Both edited - take the newer one
                if (new Date(diskMsg.editedAt) > new Date(ourMsg.editedAt)) {
                    ourMsg.editedAt = diskMsg.editedAt;
                    ourMsg.message = diskMsg.message;
                    ourMsg.mentions = diskMsg.mentions;
                    ourMsg.fileLinks = diskMsg.fileLinks;
                    ourMsg.channelMentions = diskMsg.channelMentions;
                }
            }
        }

        // === MERGE DELETED STATE ===
        // Deletions are authoritative - if either shows deleted, message is deleted
        if (diskMsg.deleted && !ourMsg.deleted) {
            ourMsg.deleted = diskMsg.deleted;
            ourMsg.message = '';
            ourMsg.images = undefined;
            ourMsg.fileLinks = undefined;
            ourMsg.mentions = undefined;
            ourMsg.channelMentions = undefined;
            ourMsg.reactions = undefined;
        }
    }

    /**
     * Ensure recently sent messages are not lost after load operations
     */
    private ensureRecentMessagesExist(): void {
        const now = Date.now();
        // Clean up old entries and ensure recent messages exist
        for (const [msgId, entry] of this.recentlySentMessages.entries()) {
            // Remove entries older than protection duration
            if (now - entry.timestamp > this.MESSAGE_PROTECTION_DURATION) {
                this.recentlySentMessages.delete(msgId);
                continue;
            }

            // Ensure the message exists in chatData
            if (!this.chatData.channelMessages[entry.channelId]) {
                this.chatData.channelMessages[entry.channelId] = [];
            }

            const exists = this.chatData.channelMessages[entry.channelId].some(m => m.id === msgId);
            if (!exists) {
                console.log(`Re-adding protected message ${msgId} that was lost during sync`);
                this.chatData.channelMessages[entry.channelId].push(entry.message);
                // Sort by timestamp
                this.chatData.channelMessages[entry.channelId].sort(
                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                );
            }
        }
    }

    /**
     * Create empty V2 data structure with General channel
     */
    private createEmptyV2Data(): ChatDataV2 {
        return {
            version: 2,
            channels: [{
                id: GENERAL_CHANNEL_ID,
                type: 'general',
                name: 'General',
                members: [],
                createdBy: 'system',
                createdAt: new Date().toISOString()
            }],
            channelMessages: {
                [GENERAL_CHANNEL_ID]: []
            },
            readState: {
                [GENERAL_CHANNEL_ID]: {}
            },
            deletedChannels: []
        };
    }

    /**
     * Migrate V1 data to V2 format
     */
    private migrateV1ToV2(v1Data: ChatDataV1): ChatDataV2 {
        const v2Data = this.createEmptyV2Data();

        // Move existing messages to General channel
        v2Data.channelMessages[GENERAL_CHANNEL_ID] = v1Data.messages || [];

        // Convert read timestamps to per-channel format
        if (v1Data.lastReadTimestamp) {
            v2Data.readState[GENERAL_CHANNEL_ID] = { ...v1Data.lastReadTimestamp };
        }

        return v2Data;
    }

    /**
     * Check if data is V2 format
     */
    private isV2Data(data: ChatData): data is ChatDataV2 {
        return (data as ChatDataV2).version === 2;
    }

    /**
     * Generate a simple unique ID
     */
    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Load chat data from vault with merge strategy to preserve in-memory changes
     * Includes retry logic for handling incomplete file syncs
     */
    async loadChat(): Promise<void> {
        try {
            if (!await this.app.vault.adapter.exists('.collab-mentions')) {
                await this.app.vault.adapter.mkdir('.collab-mentions');
            }

            if (await this.app.vault.adapter.exists(CHAT_FILE)) {
                // Retry logic for handling incomplete file syncs (Google Drive issue)
                let rawData: ChatData | null = null;
                let lastError: Error | null = null;

                for (let attempt = 1; attempt <= MAX_LOAD_RETRIES; attempt++) {
                    try {
                        const content = await this.app.vault.adapter.read(CHAT_FILE);
                        const parsed = JSON.parse(content) as ChatData;

                        // Validate checksum if present (V2 data)
                        if (this.isV2Data(parsed) && !this.validateDataIntegrity(parsed)) {
                            throw new Error('Checksum validation failed - file may be incomplete');
                        }

                        rawData = parsed;
                        break; // Success!
                    } catch (parseError) {
                        lastError = parseError as Error;
                        console.warn(`[Collab-Mentions] Load attempt ${attempt}/${MAX_LOAD_RETRIES} failed:`, parseError);

                        if (attempt < MAX_LOAD_RETRIES) {
                            // Wait before retry - file may still be syncing
                            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                        }
                    }
                }

                if (!rawData) {
                    console.error('[Collab-Mentions] Failed to load chat after', MAX_LOAD_RETRIES, 'attempts:', lastError);
                    // Keep existing data if we have it
                    if (this.chatData && this.chatData.channels.length > 0) {
                        console.log('[Collab-Mentions] Keeping existing in-memory data');
                        return;
                    }
                    // Otherwise use empty data
                    this.chatData = this.createEmptyV2Data();
                    return;
                }

                let diskData: ChatDataV2;
                if (this.isV2Data(rawData)) {
                    diskData = rawData;
                } else {
                    // Migrate from V1
                    console.log('Migrating chat data from V1 to V2...');
                    diskData = this.migrateV1ToV2(rawData as ChatDataV1);
                }

                // If we have no data yet, just use disk data
                if (!this.chatData || this.chatData.channels.length === 0) {
                    this.chatData = diskData;
                    if (!this.isV2Data(rawData)) {
                        await this.saveChat(); // Save migrated data
                    }
                    return;
                }

                // MERGE disk data with our in-memory data to prevent losing unsaved changes
                // Disk is source of truth for channel existence and membership

                // Initialize deletedChannels if not present
                if (!this.chatData.deletedChannels) {
                    this.chatData.deletedChannels = [];
                }
                if (!diskData.deletedChannels) {
                    diskData.deletedChannels = [];
                }

                // Merge deleted channels from disk - this syncs deletions across computers
                const ourDeletedIds = new Set(this.chatData.deletedChannels.map(d => d.id));
                for (const diskDeleted of diskData.deletedChannels) {
                    if (!ourDeletedIds.has(diskDeleted.id)) {
                        console.log('[Collab-Mentions] Syncing deleted channel from disk:', diskDeleted.id);
                        this.chatData.deletedChannels.push(diskDeleted);
                        // Also add to memory cache for immediate effect
                        this.recentlyDeletedChannels.set(diskDeleted.id, new Date(diskDeleted.deletedAt).getTime());
                    }
                }

                // Clean up old deleted channel records (older than 24 hours)
                const now = Date.now();
                this.chatData.deletedChannels = this.chatData.deletedChannels.filter(d => {
                    const age = now - new Date(d.deletedAt).getTime();
                    return age < DELETED_CHANNEL_RETENTION_MS;
                });

                // Only remove channels that are EXPLICITLY marked as deleted
                // Don't remove channels just because they're missing from disk - they might be newly created locally
                const diskChannelIds = new Set(diskData.channels.map(ch => ch.id));
                const deletedChannelIds = new Set((this.chatData.deletedChannels || []).map(d => d.id));

                const channelsToRemove = this.chatData.channels.filter(ch => {
                    if (ch.id === GENERAL_CHANNEL_ID) return false;

                    // Only remove if BOTH conditions are met:
                    // 1. Not on disk anymore
                    // 2. Explicitly marked as deleted in deletedChannels
                    const notOnDisk = !diskChannelIds.has(ch.id);
                    const explicitlyDeleted = deletedChannelIds.has(ch.id);

                    return notOnDisk && explicitlyDeleted;
                });

                for (const ch of channelsToRemove) {
                    console.log('[Collab-Mentions] Removing explicitly deleted channel:', ch.id, ch.name);
                    this.chatData.channels = this.chatData.channels.filter(c => c.id !== ch.id);
                    delete this.chatData.channelMessages[ch.id];
                    delete this.chatData.readState[ch.id];
                }

                // Log channels that exist locally but not on disk (they'll be preserved and synced back)
                const localOnlyChannels = this.chatData.channels.filter(ch =>
                    ch.id !== GENERAL_CHANNEL_ID && !diskChannelIds.has(ch.id) && !deletedChannelIds.has(ch.id)
                );
                if (localOnlyChannels.length > 0) {
                    console.log('[Collab-Mentions] Preserving local-only channels (will sync back):',
                        localOnlyChannels.map(c => ({ id: c.id, name: c.name })));
                }

                // Merge channels from disk
                const ourChannelMap = new Map(this.chatData.channels.map(ch => [ch.id, ch]));
                for (const diskChannel of diskData.channels) {
                    // Skip if we recently deleted this channel locally
                    if (this.isRecentlyDeletedChannel(diskChannel.id)) {
                        console.log('[Collab-Mentions] Skipping recently deleted channel:', diskChannel.id);
                        continue;
                    }

                    const ourChannel = ourChannelMap.get(diskChannel.id);
                    if (!ourChannel) {
                        // New channel from disk - add it
                        // But first check if current user recently left this channel
                        const currentUser = this.userManager.getCurrentUser();
                        if (currentUser && this.hasRecentlyLeftChannel(diskChannel.id)) {
                            // Remove current user from members if they recently left
                            diskChannel.members = diskChannel.members.filter(m => m !== currentUser.vaultName);
                            console.log('[Collab-Mentions] Adding new channel from disk (filtered after recent leave):', diskChannel.id, diskChannel.name);
                        } else {
                            console.log('[Collab-Mentions] Adding new channel from disk:', diskChannel.id, diskChannel.name);
                        }

                        // Also add any recently added members that aren't on disk yet
                        const recentlyAdded = this.getRecentlyAddedMembers(diskChannel.id);
                        for (const member of recentlyAdded) {
                            if (!diskChannel.members.includes(member)) {
                                diskChannel.members.push(member);
                                console.log('[Collab-Mentions] Preserved recently added member in new channel:', member);
                            }
                        }

                        this.chatData.channels.push(diskChannel);
                    } else {
                        // Existing channel - merge properties
                        // For members: disk is source of truth (handles leaves properly)
                        console.log('[Collab-Mentions] Merging channel:', ourChannel.id,
                            'our members:', ourChannel.members,
                            'disk members:', diskChannel.members);

                        // Use disk members as source of truth, BUT respect recent leaves and adds
                        const currentUser = this.userManager.getCurrentUser();
                        let mergedMembers = [...diskChannel.members];

                        // If current user recently left this channel, don't re-add them from disk
                        if (currentUser && this.hasRecentlyLeftChannel(diskChannel.id)) {
                            const wasInDiskMembers = mergedMembers.includes(currentUser.vaultName);
                            mergedMembers = mergedMembers.filter(m => m !== currentUser.vaultName);
                            if (wasInDiskMembers) {
                                console.log('[Collab-Mentions] Prevented re-adding user after recent leave:', currentUser.vaultName);
                            }
                        }

                        // Preserve recently added members that aren't on disk yet (sync conflict protection)
                        const recentlyAdded = this.getRecentlyAddedMembers(diskChannel.id);
                        for (const member of recentlyAdded) {
                            if (!mergedMembers.includes(member)) {
                                mergedMembers.push(member);
                                console.log('[Collab-Mentions] Preserved recently added member:', member);
                            }
                        }

                        ourChannel.members = mergedMembers;

                        // Merge name changes (prefer disk name for group channels)
                        if (diskChannel.name !== ourChannel.name && diskChannel.type === 'group') {
                            ourChannel.name = diskChannel.name;
                        }
                    }
                }

                // Merge messages - combine disk and memory, keeping all unique messages
                // Also merge reactions and edits for existing messages
                for (const channelId of Object.keys(diskData.channelMessages)) {
                    if (!this.chatData.channelMessages[channelId]) {
                        // Filter out recently dismissed messages when adding new channel
                        this.chatData.channelMessages[channelId] = diskData.channelMessages[channelId].filter(
                            m => !this.isRecentlyDismissed(m.id)
                        );
                    } else {
                        // Build a map of our messages for quick lookup
                        const ourMessageMap = new Map(
                            this.chatData.channelMessages[channelId].map(m => [m.id, m])
                        );

                        for (const diskMsg of diskData.channelMessages[channelId]) {
                            // Skip if recently dismissed
                            if (this.isRecentlyDismissed(diskMsg.id)) continue;

                            const ourMsg = ourMessageMap.get(diskMsg.id);
                            if (!ourMsg) {
                                // New message from disk - add it
                                this.chatData.channelMessages[channelId].push(diskMsg);
                            } else {
                                // Message exists - merge reactions and other updates
                                this.mergeMessageUpdates(ourMsg, diskMsg);
                            }
                        }

                        // Sort by timestamp
                        this.chatData.channelMessages[channelId].sort(
                            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                        );
                    }
                }

                // Also check for channels in memory that have messages but weren't in disk
                for (const channelId of Object.keys(this.chatData.channelMessages)) {
                    if (!diskData.channelMessages[channelId]) {
                        // We have messages for a channel that disk doesn't know about - keep them
                        continue;
                    }
                }

                // Merge read state - take the later timestamp for each user
                for (const channelId of Object.keys(diskData.readState)) {
                    if (!this.chatData.readState[channelId]) {
                        this.chatData.readState[channelId] = diskData.readState[channelId];
                    } else {
                        for (const username of Object.keys(diskData.readState[channelId])) {
                            const diskTimestamp = diskData.readState[channelId][username];
                            const ourTimestamp = this.chatData.readState[channelId][username];
                            if (!ourTimestamp || new Date(diskTimestamp) > new Date(ourTimestamp)) {
                                this.chatData.readState[channelId][username] = diskTimestamp;
                            }
                        }
                    }
                }

                // Merge muted channels - combine mute preferences from both sources
                // Each user's mutes are independent, so we merge per-user
                if (diskData.mutedChannels) {
                    if (!this.chatData.mutedChannels) {
                        this.chatData.mutedChannels = {};
                    }
                    for (const username of Object.keys(diskData.mutedChannels)) {
                        if (!this.chatData.mutedChannels[username]) {
                            this.chatData.mutedChannels[username] = diskData.mutedChannels[username];
                        } else {
                            // Combine muted channels for this user (union of both lists)
                            const combined = new Set([
                                ...this.chatData.mutedChannels[username],
                                ...diskData.mutedChannels[username]
                            ]);
                            this.chatData.mutedChannels[username] = Array.from(combined);
                        }
                    }
                }

            } else {
                // No file exists - create it with initial data
                this.chatData = this.createEmptyV2Data();
                await this.saveChat();
            }

            // CRITICAL: Ensure recently sent messages are not lost
            this.ensureRecentMessagesExist();

        } catch (error) {
            console.error('Failed to load chat:', error);
            // Only reset if we have no data at all
            if (!this.chatData) {
                this.chatData = this.createEmptyV2Data();
            }
            // Still ensure recent messages exist even on error
            this.ensureRecentMessagesExist();
        }
    }

    /**
     * Save chat data to vault with merge strategy to prevent data loss
     */
    async saveChat(): Promise<void> {
        try {
            // Try to merge with any changes that happened on disk
            if (await this.app.vault.adapter.exists(CHAT_FILE)) {
                try {
                    const diskContent = await this.app.vault.adapter.read(CHAT_FILE);
                    const diskData = JSON.parse(diskContent) as ChatDataV2;

                    if (this.isV2Data(diskData)) {
                        // For SAVE: our in-memory data is authoritative
                        // We only merge MESSAGES and READ STATE from disk, NOT channels
                        // This ensures deleted/left channels stay deleted
                        // NOTE: We deliberately do NOT add new channels from disk during save
                        // If we deleted a channel, we don't want to re-add it
                        // New channels will be picked up during loadChat instead

                        // Merge messages - add new messages AND merge updates to existing messages
                        // This is critical for reactions, edits, and deletions to sync properly
                        for (const channelId of Object.keys(diskData.channelMessages)) {
                            if (!this.chatData.channelMessages[channelId]) {
                                this.chatData.channelMessages[channelId] = diskData.channelMessages[channelId];
                            } else {
                                // Build a map for quick lookup
                                const ourMessageMap = new Map(
                                    this.chatData.channelMessages[channelId].map(m => [m.id, m])
                                );

                                for (const diskMsg of diskData.channelMessages[channelId]) {
                                    const ourMsg = ourMessageMap.get(diskMsg.id);
                                    if (!ourMsg) {
                                        // New message from disk - add it
                                        this.chatData.channelMessages[channelId].push(diskMsg);
                                    } else {
                                        // Existing message - merge updates (reactions, edits, deletions)
                                        // This ensures we don't lose changes made by others
                                        this.mergeMessageUpdates(ourMsg, diskMsg);
                                    }
                                }

                                // Sort by timestamp after merge
                                this.chatData.channelMessages[channelId].sort(
                                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                                );
                            }
                        }

                        // Merge read state - take the later timestamp for each user
                        for (const channelId of Object.keys(diskData.readState)) {
                            if (!this.chatData.readState[channelId]) {
                                this.chatData.readState[channelId] = diskData.readState[channelId];
                            } else {
                                for (const username of Object.keys(diskData.readState[channelId])) {
                                    const diskTimestamp = diskData.readState[channelId][username];
                                    const ourTimestamp = this.chatData.readState[channelId][username];
                                    if (!ourTimestamp || new Date(diskTimestamp) > new Date(ourTimestamp)) {
                                        this.chatData.readState[channelId][username] = diskTimestamp;
                                    }
                                }
                            }
                        }

                        // Merge deletedChannels from disk to preserve deletions from other computers
                        if (diskData.deletedChannels) {
                            if (!this.chatData.deletedChannels) {
                                this.chatData.deletedChannels = [];
                            }
                            const ourDeletedIds = new Set(this.chatData.deletedChannels.map(d => d.id));
                            for (const diskDeleted of diskData.deletedChannels) {
                                if (!ourDeletedIds.has(diskDeleted.id)) {
                                    this.chatData.deletedChannels.push(diskDeleted);
                                }
                            }
                        }

                        // Merge muted channels from disk to preserve other users' mute preferences
                        if (diskData.mutedChannels) {
                            if (!this.chatData.mutedChannels) {
                                this.chatData.mutedChannels = {};
                            }
                            for (const username of Object.keys(diskData.mutedChannels)) {
                                if (!this.chatData.mutedChannels[username]) {
                                    this.chatData.mutedChannels[username] = diskData.mutedChannels[username];
                                } else {
                                    // Combine muted channels (union)
                                    const combined = new Set([
                                        ...this.chatData.mutedChannels[username],
                                        ...diskData.mutedChannels[username]
                                    ]);
                                    this.chatData.mutedChannels[username] = Array.from(combined);
                                }
                            }
                        }
                    }
                } catch (e) {
                    // If merge fails, just save our data (might lose some changes)
                    console.warn('Failed to merge chat data, saving anyway:', e);
                }
            }

            // CRITICAL: Ensure recently sent messages are included before saving
            this.ensureRecentMessagesExist();

            // Initialize deletedChannels if not present
            if (!this.chatData.deletedChannels) {
                this.chatData.deletedChannels = [];
            }

            // Add checksum for file integrity validation
            // Remove old checksum first, then compute new one
            delete this.chatData._checksum;
            this.chatData._checksum = this.computeDataChecksum(this.chatData);

            const content = JSON.stringify(this.chatData, null, 2);
            const expectedHash = this.computeHash(content);

            // Save with verification and retry
            for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
                await this.app.vault.adapter.write(CHAT_FILE, content);

                // Verify the save by reading back and comparing hash
                try {
                    const savedContent = await this.app.vault.adapter.read(CHAT_FILE);
                    const savedHash = this.computeHash(savedContent);

                    if (savedHash === expectedHash) {
                        console.log('[Collab-Mentions] Chat saved and verified (attempt', attempt + ')');
                        return; // Success!
                    } else {
                        console.warn(`[Collab-Mentions] Chat save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}), hash mismatch`);
                    }
                } catch (verifyError) {
                    console.warn(`[Collab-Mentions] Chat save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}):`, verifyError);
                }

                // Wait a bit before retry
                if (attempt < MAX_SAVE_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }

            console.error('[Collab-Mentions] Failed to verify chat save after', MAX_SAVE_RETRIES, 'attempts');
        } catch (error) {
            console.error('Failed to save chat:', error);
        }
    }

    // ==================== Channel Management ====================

    /**
     * Get the active channel ID
     */
    getActiveChannelId(): string {
        return this.activeChannelId;
    }

    /**
     * Set the active channel
     */
    setActiveChannel(channelId: string): void {
        if (this.chatData.channels.some(c => c.id === channelId)) {
            this.activeChannelId = channelId;
        }
    }

    /**
     * Get a channel by ID
     */
    getChannel(channelId: string): Channel | undefined {
        return this.chatData.channels.find(c => c.id === channelId);
    }

    /**
     * Get all channels visible to a user
     */
    getChannelsForUser(username: string): Channel[] {
        return this.chatData.channels.filter(channel => {
            if (channel.type === 'general') return true;
            return channel.members.includes(username);
        });
    }

    /**
     * Get all channels (for admin purposes)
     */
    getAllChannels(): Channel[] {
        return this.chatData.channels;
    }

    /**
     * Create a new group channel
     */
    async createGroupChannel(name: string, members: string[], createdBy: string): Promise<Channel> {
        const uniqueMembers = [...new Set(members)];
        const channel: Channel = {
            id: this.generateId(),
            type: 'group',
            name: name.trim(),
            members: uniqueMembers,
            createdBy,
            createdAt: new Date().toISOString()
        };

        this.chatData.channels.push(channel);
        this.chatData.channelMessages[channel.id] = [];
        this.chatData.readState[channel.id] = {};

        // Track all initial members for merge protection
        for (const member of uniqueMembers) {
            this.trackMemberAdded(channel.id, member);
        }

        await this.saveChat();
        return channel;
    }

    /**
     * Start or get existing DM between two users
     */
    async startDM(initiator: string, recipient: string): Promise<Channel> {
        // Check for existing DM between these two users
        const existingDM = this.chatData.channels.find(ch =>
            ch.type === 'dm' &&
            ch.members.length === 2 &&
            ch.members.includes(initiator) &&
            ch.members.includes(recipient)
        );

        if (existingDM) return existingDM;

        // Create new DM
        const channel: Channel = {
            id: this.generateId(),
            type: 'dm',
            name: '', // DMs don't have names, UI shows other participant
            members: [initiator, recipient],
            createdBy: initiator,
            createdAt: new Date().toISOString()
        };

        this.chatData.channels.push(channel);
        this.chatData.channelMessages[channel.id] = [];
        this.chatData.readState[channel.id] = {};

        // Track both members for merge protection
        this.trackMemberAdded(channel.id, initiator);
        this.trackMemberAdded(channel.id, recipient);

        await this.saveChat();
        return channel;
    }

    /**
     * Add member to a channel (DM converts to group if adding third person)
     */
    async addMemberToChannel(channelId: string, newMember: string, addedBy: string): Promise<boolean> {
        const channel = this.chatData.channels.find(ch => ch.id === channelId);
        if (!channel) return false;
        if (channel.type === 'general') return false; // Can't modify General
        if (channel.members.includes(newMember)) return true; // Already a member

        // Clear leave protection if the user is being explicitly added back
        const currentUser = this.userManager.getCurrentUser();
        if (currentUser && newMember === currentUser.vaultName) {
            this.recentlyLeftChannels.delete(channelId);
            console.log('[Collab-Mentions] Cleared leave protection - user explicitly rejoined');
        }

        // If DM, convert to group
        if (channel.type === 'dm') {
            channel.type = 'group';
            channel.name = channel.members.join(', '); // Default name
        }

        channel.members.push(newMember);

        // Track this addition to prevent removal during merge conflicts
        this.trackMemberAdded(channelId, newMember);

        // Add system message
        const systemMsg: ChatMessage = {
            id: this.generateId(),
            from: 'system',
            message: `${addedBy} added ${newMember} to the conversation`,
            timestamp: new Date().toISOString()
        };
        this.chatData.channelMessages[channelId].push(systemMsg);

        await this.saveChat();
        return true;
    }

    /**
     * Check if user is the last member of a channel
     */
    isLastMember(channelId: string, username: string): boolean {
        const channel = this.chatData.channels.find(ch => ch.id === channelId);
        if (!channel) return false;
        return channel.members.length === 1 && channel.members[0] === username;
    }

    /**
     * Leave a channel. Returns 'left' if successful, 'deleted' if channel was deleted (last member), false if failed.
     * Note: If user is last member, the channel is automatically deleted after they leave.
     */
    async leaveChannel(channelId: string, username: string): Promise<'left' | 'deleted' | false> {
        const channel = this.chatData.channels.find(ch => ch.id === channelId);
        if (!channel) {
            console.log('[Collab-Mentions] leaveChannel: channel not found', channelId);
            return false;
        }
        if (channel.type === 'general') return false; // Can't leave General

        const wasLastMember = this.isLastMember(channelId, username);
        console.log('[Collab-Mentions] leaveChannel:', channelId, 'user:', username, 'members before:', channel.members, 'isLastMember:', wasLastMember);

        channel.members = channel.members.filter(m => m !== username);

        // Track this leave to prevent re-adding during merge conflicts
        this.recentlyLeftChannels.set(channelId, Date.now());

        // IMPORTANT: Clear any "recently added" protection for this user
        // Otherwise the add protection would re-add them during merge
        const channelAddedMembers = this.recentlyAddedMembers.get(channelId);
        if (channelAddedMembers) {
            channelAddedMembers.delete(username);
            console.log('[Collab-Mentions] leaveChannel: cleared add protection for', username);
        }

        console.log('[Collab-Mentions] leaveChannel: tracking leave for merge protection');
        console.log('[Collab-Mentions] leaveChannel: members after:', channel.members);

        // If this was the active channel, switch to General
        if (this.activeChannelId === channelId) {
            this.activeChannelId = GENERAL_CHANNEL_ID;
        }

        // If channel is now empty, delete it
        if (channel.members.length === 0) {
            console.log('[Collab-Mentions] leaveChannel: channel now empty, deleting');
            await this.deleteChannel(channelId);
            return 'deleted';
        }

        // Add system message (only if channel still has members)
        const systemMsg: ChatMessage = {
            id: this.generateId(),
            from: 'system',
            message: `${username} left the conversation`,
            timestamp: new Date().toISOString()
        };
        this.chatData.channelMessages[channelId].push(systemMsg);

        await this.saveChat();
        return 'left';
    }

    /**
     * Delete a channel entirely (only creator or last member can delete)
     */
    async deleteChannel(channelId: string): Promise<boolean> {
        if (channelId === GENERAL_CHANNEL_ID) return false;

        const currentUser = this.userManager.getCurrentUser();
        const deletedBy = currentUser?.vaultName || 'unknown';

        console.log('[Collab-Mentions] deleteChannel:', channelId, 'by:', deletedBy, 'channels before:', this.chatData.channels.length);

        // Track this deletion in memory to prevent re-add during sync
        const now = Date.now();
        this.recentlyDeletedChannels.set(channelId, now);

        // Also persist to disk so other computers respect this deletion
        if (!this.chatData.deletedChannels) {
            this.chatData.deletedChannels = [];
        }
        // Only add if not already tracked
        if (!this.chatData.deletedChannels.some(d => d.id === channelId)) {
            this.chatData.deletedChannels.push({
                id: channelId,
                deletedAt: new Date().toISOString(),
                deletedBy: deletedBy
            });
            console.log('[Collab-Mentions] Added to deletedChannels for sync');
        }

        this.chatData.channels = this.chatData.channels.filter(ch => ch.id !== channelId);
        console.log('[Collab-Mentions] deleteChannel: channels after:', this.chatData.channels.length);
        delete this.chatData.channelMessages[channelId];
        delete this.chatData.readState[channelId];

        if (this.activeChannelId === channelId) {
            this.activeChannelId = GENERAL_CHANNEL_ID;
        }

        await this.saveChat();
        console.log('[Collab-Mentions] deleteChannel: saved');
        return true;
    }

    /**
     * Export a channel's messages to a markdown file
     * Creates a "collab-mentions" folder and saves as channelname_YYYY-MM-DD_HH-MM-SS.md
     * Also copies images to a dedicated images folder for the export
     * @returns The path to the exported file, or null if export failed
     */
    async exportChannel(channelId: string): Promise<string | null> {
        const channel = this.chatData.channels.find(ch => ch.id === channelId);
        if (!channel) return null;

        const messages = this.chatData.channelMessages[channelId] || [];
        if (messages.length === 0) return null;

        try {
            // Ensure export folder exists
            const exportFolder = 'collab-mentions';
            if (!await this.app.vault.adapter.exists(exportFolder)) {
                await this.app.vault.adapter.mkdir(exportFolder);
            }

            // Generate filename: channelname_YYYY-MM-DD_HH-MM-SS.md
            const now = new Date();
            const timestamp = now.toISOString()
                .replace(/[:.]/g, '-')
                .replace('T', '_')
                .slice(0, 19);

            // Sanitize channel name for filename
            let channelName = channel.name || channel.id;
            if (channel.type === 'dm') {
                // For DMs, use participants' names
                channelName = `DM_${channel.members.join('_')}`;
            }
            channelName = channelName.replace(/[<>:"/\\|?*]/g, '_');

            const filename = `${channelName}_${timestamp}.md`;
            const filePath = `${exportFolder}/${filename}`;

            // Create images export folder if there are any images
            const allImages: { original: string; exported: string; filename: string }[] = [];
            const hasImages = messages.some(m => m.images && m.images.length > 0);

            let imagesExportFolder = '';
            if (hasImages) {
                imagesExportFolder = `${exportFolder}/exported-images`;
                if (!await this.app.vault.adapter.exists(imagesExportFolder)) {
                    await this.app.vault.adapter.mkdir(imagesExportFolder);
                }

                // Collect all images and copy them
                for (const msg of messages) {
                    if (msg.images && msg.images.length > 0) {
                        for (const img of msg.images) {
                            // Check if source image exists
                            if (await this.app.vault.adapter.exists(img.path)) {
                                // Create new filename with timestamp prefix for uniqueness
                                const exportedFilename = `${channelName}_${img.filename}`;
                                const exportedPath = `${imagesExportFolder}/${exportedFilename}`;

                                // Copy the image file
                                try {
                                    const imageData = await this.app.vault.adapter.readBinary(img.path);
                                    await this.app.vault.adapter.writeBinary(exportedPath, imageData);
                                    allImages.push({
                                        original: img.path,
                                        exported: exportedPath,
                                        filename: exportedFilename
                                    });
                                    console.log('[Collab-Mentions] Exported image:', img.path, '->', exportedPath);
                                } catch (imgError) {
                                    console.warn('[Collab-Mentions] Failed to copy image:', img.path, imgError);
                                }
                            } else {
                                console.warn('[Collab-Mentions] Image not found:', img.path);
                            }
                        }
                    }
                }
            }

            // Build a map of original path to exported path for quick lookup
            const imagePathMap = new Map(allImages.map(i => [i.original, i.exported]));

            // Build markdown content
            let content = `# Chat Export: ${channel.name || channel.id}\n\n`;
            content += `**Type:** ${channel.type}\n`;
            content += `**Created by:** ${channel.createdBy}\n`;
            content += `**Created at:** ${new Date(channel.createdAt).toLocaleString()}\n`;
            content += `**Exported at:** ${now.toLocaleString()}\n`;
            if (channel.members.length > 0) {
                content += `**Members:** ${channel.members.join(', ')}\n`;
            }
            content += `**Total messages:** ${messages.length}\n`;
            if (allImages.length > 0) {
                content += `**Images exported:** ${allImages.length}\n`;
            }
            content += `\n---\n\n`;

            // Add messages
            for (const msg of messages) {
                if (msg.deleted) {
                    content += `**[${new Date(msg.timestamp).toLocaleString()}] ${msg.from}:** *(message deleted)*\n\n`;
                    continue;
                }

                const time = new Date(msg.timestamp).toLocaleString();
                const edited = msg.edited ? ' *(edited)*' : '';

                if (msg.from === 'system') {
                    content += `*[${time}] ${msg.message}*\n\n`;
                } else {
                    content += `**[${time}] ${msg.from}:**${edited}\n`;
                    if (msg.message) {
                        content += `${msg.message}\n`;
                    }

                    // Add file links
                    if (msg.fileLinks && msg.fileLinks.length > 0) {
                        content += `\nLinked files: ${msg.fileLinks.map(f => `[[${f}]]`).join(', ')}\n`;
                    }

                    // Add images with exported paths
                    if (msg.images && msg.images.length > 0) {
                        const imageRefs = msg.images.map(i => {
                            const exportedPath = imagePathMap.get(i.path);
                            if (exportedPath) {
                                return `![[${exportedPath}]]`;
                            } else {
                                // Image wasn't exported (missing), show original path with note
                                return `![[${i.path}]] *(original)*`;
                            }
                        });
                        content += `\n${imageRefs.join(' ')}\n`;
                    }

                    // Add reactions
                    if (msg.reactions && msg.reactions.length > 0) {
                        const reactions = msg.reactions.map(r => `${r.emoji} (${r.users.join(', ')})`).join(' ');
                        content += `\nReactions: ${reactions}\n`;
                    }

                    content += `\n`;
                }
            }

            await this.app.vault.adapter.write(filePath, content);
            console.log('[Collab-Mentions] Exported channel to:', filePath);
            return filePath;
        } catch (error) {
            console.error('[Collab-Mentions] Failed to export channel:', error);
            return null;
        }
    }

    /**
     * Track that a member was recently added to a channel
     */
    private trackMemberAdded(channelId: string, username: string): void {
        if (!this.recentlyAddedMembers.has(channelId)) {
            this.recentlyAddedMembers.set(channelId, new Map());
        }
        this.recentlyAddedMembers.get(channelId)!.set(username, Date.now());
        console.log('[Collab-Mentions] Tracking member added for merge protection:', username, 'to', channelId);
    }

    /**
     * Get recently added members for a channel that should be preserved during merge
     */
    private getRecentlyAddedMembers(channelId: string): string[] {
        const channelMembers = this.recentlyAddedMembers.get(channelId);
        if (!channelMembers) return [];

        const now = Date.now();
        const recentMembers: string[] = [];

        for (const [username, addedTime] of channelMembers) {
            const age = now - addedTime;
            if (age <= this.ADD_MEMBER_PROTECTION_DURATION) {
                recentMembers.push(username);
            } else {
                channelMembers.delete(username);
            }
        }

        return recentMembers;
    }

    /**
     * Check if the current user recently left a channel (should not be re-added during merge)
     */
    private hasRecentlyLeftChannel(channelId: string): boolean {
        const leftTime = this.recentlyLeftChannels.get(channelId);
        if (!leftTime) return false;

        const age = Date.now() - leftTime;
        if (age > this.LEAVE_PROTECTION_DURATION) {
            this.recentlyLeftChannels.delete(channelId);
            return false;
        }
        return true;
    }

    /**
     * Check if a channel was recently deleted (should not be re-added)
     * Checks both in-memory cache and persisted deletedChannels array
     */
    private isRecentlyDeletedChannel(channelId: string): boolean {
        const now = Date.now();

        // Check memory cache first (faster)
        const deletedTime = this.recentlyDeletedChannels.get(channelId);
        if (deletedTime) {
            const age = now - deletedTime;
            if (age <= this.CHANNEL_DELETE_PROTECTION) {
                return true;
            }
            this.recentlyDeletedChannels.delete(channelId);
        }

        // Also check persisted deletedChannels array (synced across computers)
        if (this.chatData.deletedChannels) {
            const persistedDeletion = this.chatData.deletedChannels.find(d => d.id === channelId);
            if (persistedDeletion) {
                const age = now - new Date(persistedDeletion.deletedAt).getTime();
                if (age <= DELETED_CHANNEL_RETENTION_MS) {
                    // Also cache in memory for faster subsequent checks
                    this.recentlyDeletedChannels.set(channelId, new Date(persistedDeletion.deletedAt).getTime());
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Check if a user can delete a channel (must be creator or admin)
     */
    canDeleteChannel(channelId: string, username: string): boolean {
        const channel = this.chatData.channels.find(ch => ch.id === channelId);
        if (!channel) return false;
        if (channel.type === 'general') return false;
        // Creator can always delete
        if (channel.createdBy === username) return true;
        // Admin can delete any channel
        return this.userManager.isUserAdmin(username);
    }

    /**
     * Delete a channel as admin (bypasses creator check)
     */
    async deleteChannelAsAdmin(channelId: string): Promise<boolean> {
        if (!this.userManager.isCurrentUserAdmin()) {
            return false;
        }
        return this.deleteChannel(channelId);
    }

    /**
     * Clean up stale channels (abandoned DMs)
     * - Removes DMs with 1 member (other person left) and no messages in last 7 days
     */
    async cleanupStaleChannels(): Promise<number> {
        const now = Date.now();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        let removedCount = 0;

        const channelsToRemove: string[] = [];

        for (const channel of this.chatData.channels) {
            if (channel.id === GENERAL_CHANNEL_ID) continue;

            // Remove DMs with only 1 member (other person left) and no recent activity
            if (channel.type === 'dm' && channel.members.length === 1) {
                const messages = this.chatData.channelMessages[channel.id] || [];
                const lastMessage = messages[messages.length - 1];
                const lastActivity = lastMessage
                    ? new Date(lastMessage.timestamp).getTime()
                    : new Date(channel.createdAt).getTime();

                if (now - lastActivity > sevenDaysMs) {
                    channelsToRemove.push(channel.id);
                }
            }
        }

        // Remove the channels
        for (const channelId of channelsToRemove) {
            this.chatData.channels = this.chatData.channels.filter(ch => ch.id !== channelId);
            delete this.chatData.channelMessages[channelId];
            delete this.chatData.readState[channelId];
            removedCount++;
        }

        if (removedCount > 0) {
            // Reset active channel if it was removed
            if (channelsToRemove.includes(this.activeChannelId)) {
                this.activeChannelId = GENERAL_CHANNEL_ID;
            }
            await this.saveChat();
        }

        return removedCount;
    }

    /**
     * Get a message by ID from a specific channel
     */
    getMessageById(messageId: string, channelId?: string): ChatMessage | undefined {
        const targetChannel = channelId || this.activeChannelId;
        const messages = this.chatData.channelMessages[targetChannel] || [];
        return messages.find(m => m.id === messageId);
    }

    // ==================== Mute Channels ====================

    /**
     * Check if a channel is muted for current user
     */
    isChannelMuted(channelId: string): boolean {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return false;

        const mutedChannels = this.chatData.mutedChannels?.[currentUser.vaultName] || [];
        return mutedChannels.includes(channelId);
    }

    /**
     * Toggle mute status for a channel
     */
    async toggleChannelMute(channelId: string): Promise<boolean> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return false;

        // Initialize mutedChannels if needed
        if (!this.chatData.mutedChannels) {
            this.chatData.mutedChannels = {};
        }
        if (!this.chatData.mutedChannels[currentUser.vaultName]) {
            this.chatData.mutedChannels[currentUser.vaultName] = [];
        }

        const mutedList = this.chatData.mutedChannels[currentUser.vaultName];
        const index = mutedList.indexOf(channelId);

        if (index === -1) {
            mutedList.push(channelId);
        } else {
            mutedList.splice(index, 1);
        }

        await this.saveChat();
        return this.isChannelMuted(channelId);
    }

    /**
     * Rename a channel (groups only)
     */
    async renameChannel(channelId: string, newName: string): Promise<boolean> {
        const channel = this.chatData.channels.find(ch => ch.id === channelId);
        if (!channel) return false;
        if (channel.type !== 'group') return false;

        channel.name = newName.trim();
        await this.saveChat();
        return true;
    }

    // ==================== Image Management ====================

    /**
     * Ensure images folder exists
     */
    async ensureImagesFolder(): Promise<void> {
        if (!await this.app.vault.adapter.exists(IMAGES_FOLDER)) {
            await this.app.vault.adapter.mkdir(IMAGES_FOLDER);
        }
    }

    /**
     * Save an image to the vault and return the ChatImage object
     */
    async saveImage(file: File): Promise<ChatImage | null> {
        try {
            await this.ensureImagesFolder();

            const id = this.generateId();
            const extension = file.name.split('.').pop() || 'png';
            const filename = `${id}.${extension}`;
            const path = `${IMAGES_FOLDER}/${filename}`;

            const arrayBuffer = await file.arrayBuffer();
            await this.app.vault.adapter.writeBinary(path, arrayBuffer);

            return { id, filename, path };
        } catch (error) {
            console.error('Failed to save image:', error);
            return null;
        }
    }

    /**
     * Save image from clipboard
     */
    async saveImageFromClipboard(blob: Blob): Promise<ChatImage | null> {
        try {
            await this.ensureImagesFolder();

            const id = this.generateId();
            const extension = blob.type.split('/')[1] || 'png';
            const filename = `${id}.${extension}`;
            const path = `${IMAGES_FOLDER}/${filename}`;

            const arrayBuffer = await blob.arrayBuffer();
            await this.app.vault.adapter.writeBinary(path, arrayBuffer);

            return { id, filename, path };
        } catch (error) {
            console.error('Failed to save clipboard image:', error);
            return null;
        }
    }

    // ==================== Message Operations ====================

    /**
     * Send a message to a specific channel
     */
    async sendMessage(message: string, fileLinks?: string[], images?: ChatImage[], channelId?: string, replyTo?: string): Promise<ChatMessage | null> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) {
            console.error('Cannot send message: no current user');
            return null;
        }

        const targetChannel = channelId || this.activeChannelId;

        // Ensure channel exists
        if (!this.chatData.channelMessages[targetChannel]) {
            this.chatData.channelMessages[targetChannel] = [];
        }

        // Extract @mentions from message
        const mentions = ChatManager.extractMentions(message);
        // Allow @everyone as special mention, plus regular user mentions
        const specialMentions = ['everyone'];
        const validMentions = mentions.filter(m =>
            specialMentions.includes(m.toLowerCase()) || this.userManager.getUserByName(m) !== undefined
        );

        // Extract @#channel mentions from message
        const channelMentionNames = ChatManager.extractChannelMentions(message);
        // Validate channel mentions - find matching channels by name and return their IDs
        const validChannelMentions: string[] = [];
        for (const channelName of channelMentionNames) {
            const channel = this.chatData.channels.find(
                ch => ch.name.toLowerCase() === channelName.toLowerCase()
            );
            if (channel) {
                validChannelMentions.push(channel.id);
            }
        }

        const chatMessage: ChatMessage = {
            id: this.generateId(),
            from: currentUser.vaultName,
            message: message.trim(),
            timestamp: new Date().toISOString(),
            fileLinks: fileLinks && fileLinks.length > 0 ? fileLinks : undefined,
            mentions: validMentions.length > 0 ? validMentions : undefined,
            channelMentions: validChannelMentions.length > 0 ? validChannelMentions : undefined,
            images: images && images.length > 0 ? images : undefined,
            replyTo: replyTo
        };

        // CRITICAL: Protect this message from being lost during sync
        this.recentlySentMessages.set(chatMessage.id, {
            channelId: targetChannel,
            message: chatMessage,
            timestamp: Date.now()
        });

        this.chatData.channelMessages[targetChannel].push(chatMessage);

        // Keep only last MAX_MESSAGES_PER_CHANNEL
        if (this.chatData.channelMessages[targetChannel].length > MAX_MESSAGES_PER_CHANNEL) {
            this.chatData.channelMessages[targetChannel] =
                this.chatData.channelMessages[targetChannel].slice(-MAX_MESSAGES_PER_CHANNEL);
        }

        await this.saveChat();
        return chatMessage;
    }

    /**
     * Dismiss/delete a system notification message (like file mention alerts)
     */
    async dismissSystemMessage(messageId: string, channelId?: string): Promise<boolean> {
        const targetChannel = channelId || this.activeChannelId;
        const messages = this.chatData.channelMessages[targetChannel];
        if (!messages) return false;

        const messageIndex = messages.findIndex(m => m.id === messageId);
        if (messageIndex === -1) return false;

        const message = messages[messageIndex];
        // Only allow dismissing system messages
        if (message.from !== 'system') return false;

        // Track as dismissed to prevent re-adding during merge
        this.recentlyDismissedMessages.set(messageId, Date.now());

        // Remove the message
        messages.splice(messageIndex, 1);
        await this.saveChat();
        return true;
    }

    /**
     * Find a channel by name or ID
     */
    getChannelByName(channelName: string): Channel | undefined {
        // First try exact ID match (for built-in channels like "general")
        const byId = this.chatData.channels.find(
            ch => ch.id.toLowerCase() === channelName.toLowerCase()
        );
        if (byId) return byId;

        // Then try name match
        return this.chatData.channels.find(
            ch => ch.name.toLowerCase() === channelName.toLowerCase()
        );
    }

    /**
     * Get messages for a specific channel (or active channel)
     */
    getMessages(channelId?: string): ChatMessage[] {
        const targetChannel = channelId || this.activeChannelId;
        return this.chatData.channelMessages[targetChannel] || [];
    }

    /**
     * Get messages since a specific timestamp for a channel
     */
    getMessagesSince(timestamp: string, channelId?: string): ChatMessage[] {
        const messages = this.getMessages(channelId);
        const since = new Date(timestamp).getTime();
        return messages.filter(m => new Date(m.timestamp).getTime() > since);
    }

    /**
     * Get a message by ID from a specific channel
     */
    getMessage(messageId: string, channelId?: string): ChatMessage | undefined {
        const messages = this.getMessages(channelId);
        return messages.find(m => m.id === messageId);
    }

    /**
     * Toggle a reaction on a message
     */
    async toggleReaction(messageId: string, emoji: string, channelId?: string): Promise<boolean> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return false;

        const targetChannel = channelId || this.activeChannelId;
        const messages = this.chatData.channelMessages[targetChannel];
        if (!messages) return false;

        const message = messages.find(m => m.id === messageId);
        if (!message) return false;

        if (!message.reactions) {
            message.reactions = [];
        }

        let reaction = message.reactions.find(r => r.emoji === emoji);
        let wasAdded = false;

        if (reaction) {
            const userIndex = reaction.users.indexOf(currentUser.vaultName);
            if (userIndex !== -1) {
                // Removing reaction
                reaction.users.splice(userIndex, 1);
                if (reaction.users.length === 0) {
                    message.reactions = message.reactions.filter(r => r.emoji !== emoji);
                }
                wasAdded = false;
            } else {
                // Adding reaction
                reaction.users.push(currentUser.vaultName);
                wasAdded = true;
            }
        } else {
            // Adding new reaction
            message.reactions.push({
                emoji,
                users: [currentUser.vaultName]
            });
            wasAdded = true;
        }

        // Track this toggle to protect it during merge conflicts
        this.trackReactionToggle(messageId, emoji, currentUser.vaultName, wasAdded);

        await this.saveChat();
        return true;
    }

    /**
     * Track a reaction toggle for merge protection
     */
    private trackReactionToggle(messageId: string, emoji: string, username: string, added: boolean): void {
        if (!this.recentlyToggledReactions.has(messageId)) {
            this.recentlyToggledReactions.set(messageId, new Map());
        }
        const key = `${emoji}|${username}`;
        this.recentlyToggledReactions.get(messageId)!.set(key, {
            added,
            timestamp: Date.now()
        });
        console.log(`[Collab-Mentions] Tracked reaction toggle: ${emoji} by ${username} on ${messageId} (${added ? 'added' : 'removed'})`);
    }

    /**
     * Get recent reaction toggle for a specific emoji+user on a message
     * Returns null if no recent toggle or if it's expired
     */
    private getRecentReactionToggle(messageId: string, emoji: string, username: string): { added: boolean } | null {
        const msgToggles = this.recentlyToggledReactions.get(messageId);
        if (!msgToggles) return null;

        const key = `${emoji}|${username}`;
        const toggle = msgToggles.get(key);
        if (!toggle) return null;

        const age = Date.now() - toggle.timestamp;
        if (age > this.REACTION_TOGGLE_PROTECTION_DURATION) {
            msgToggles.delete(key);
            return null;
        }

        return { added: toggle.added };
    }

    /**
     * Edit a message (only allowed for own messages)
     */
    async editMessage(messageId: string, newContent: string, channelId?: string): Promise<boolean> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return false;

        const targetChannel = channelId || this.activeChannelId;
        const messages = this.chatData.channelMessages[targetChannel];
        if (!messages) return false;

        const message = messages.find(m => m.id === messageId);
        if (!message) return false;
        if (message.from !== currentUser.vaultName) return false;
        if (message.deleted) return false;

        message.message = newContent.trim();
        message.edited = true;
        message.editedAt = new Date().toISOString();

        // Re-extract @mentions (including special mentions like @everyone)
        const mentions = ChatManager.extractMentions(newContent);
        const specialMentions = ['everyone'];
        const validMentions = mentions.filter(m =>
            specialMentions.includes(m.toLowerCase()) || this.userManager.getUserByName(m) !== undefined
        );
        message.mentions = validMentions.length > 0 ? validMentions : undefined;

        // Re-extract file links
        const fileLinks = ChatManager.extractFileLinks(newContent);
        message.fileLinks = fileLinks.length > 0 ? fileLinks : undefined;

        // Re-extract @#channel mentions
        const channelMentionNames = ChatManager.extractChannelMentions(newContent);
        const validChannelMentions: string[] = [];
        for (const channelName of channelMentionNames) {
            const channel = this.chatData.channels.find(
                ch => ch.name.toLowerCase() === channelName.toLowerCase()
            );
            if (channel) {
                validChannelMentions.push(channel.id);
            }
        }
        message.channelMentions = validChannelMentions.length > 0 ? validChannelMentions : undefined;

        await this.saveChat();
        return true;
    }

    /**
     * Delete a message (soft delete - only allowed for own messages or admins)
     */
    async deleteMessage(messageId: string, channelId?: string): Promise<boolean> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return false;

        const targetChannel = channelId || this.activeChannelId;
        const messages = this.chatData.channelMessages[targetChannel];
        if (!messages) return false;

        const message = messages.find(m => m.id === messageId);
        if (!message) return false;

        // Must be message owner OR admin to delete
        const isOwner = message.from === currentUser.vaultName;
        const isAdmin = this.userManager.isCurrentUserAdmin();
        if (!isOwner && !isAdmin) return false;

        message.deleted = true;
        message.message = '';
        message.images = undefined;
        message.fileLinks = undefined;
        message.mentions = undefined;
        message.channelMentions = undefined;

        await this.saveChat();
        return true;
    }

    /**
     * Check if current user can delete a specific message
     */
    canDeleteMessage(messageId: string, channelId?: string): boolean {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return false;

        const targetChannel = channelId || this.activeChannelId;
        const messages = this.chatData.channelMessages[targetChannel];
        if (!messages) return false;

        const message = messages.find(m => m.id === messageId);
        if (!message) return false;
        if (message.deleted) return false;

        // Owner can delete their own, admin can delete any
        return message.from === currentUser.vaultName || this.userManager.isCurrentUserAdmin();
    }

    // ==================== Read State Management ====================

    /**
     * Mark a channel as read for current user
     */
    async markAsRead(channelId?: string): Promise<void> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return;

        const targetChannel = channelId || this.activeChannelId;

        if (!this.chatData.readState[targetChannel]) {
            this.chatData.readState[targetChannel] = {};
        }

        this.chatData.readState[targetChannel][currentUser.vaultName] = new Date().toISOString();
        await this.saveChat();
    }

    /**
     * Get unread count for a specific channel
     */
    getUnreadCount(channelId: string, username: string): number {
        const messages = this.chatData.channelMessages[channelId] || [];
        const lastRead = this.chatData.readState[channelId]?.[username];
        const lastReadTime = lastRead ? new Date(lastRead).getTime() : 0;

        return messages.filter(m =>
            new Date(m.timestamp).getTime() > lastReadTime &&
            m.from !== username &&
            m.from !== 'system' &&
            !m.deleted
        ).length;
    }

    /**
     * Get total unread count across all channels for a user
     */
    getTotalUnreadCount(username: string): number {
        const channels = this.getChannelsForUser(username);
        return channels.reduce((total, channel) => {
            return total + this.getUnreadCount(channel.id, username);
        }, 0);
    }

    /**
     * Check if a channel has been @#mentioned in unread messages (across all channels)
     * Returns true if there are unread messages in any channel that @#mention this channel
     */
    hasUnreadChannelMention(channelId: string, username: string): boolean {
        const channels = this.getChannelsForUser(username);

        for (const channel of channels) {
            const lastRead = this.chatData.readState[channel.id]?.[username];
            const lastReadTime = lastRead ? new Date(lastRead).getTime() : 0;
            const messages = this.chatData.channelMessages[channel.id] || [];

            for (const msg of messages) {
                const msgTime = new Date(msg.timestamp).getTime();
                if (msgTime <= lastReadTime) continue;
                if (msg.from === username) continue;
                if (msg.deleted) continue;

                // Check if this message @#mentions the target channel
                if (msg.channelMentions?.includes(channelId)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Get unread messages that mention the current user (across all channels)
     * Also checks for @everyone and @channel mentions
     */
    getUnreadMentionsForCurrentUser(): ChatMessage[] {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        const channels = this.getChannelsForUser(currentUser.vaultName);
        const mentionMessages: ChatMessage[] = [];

        for (const channel of channels) {
            const lastRead = this.chatData.readState[channel.id]?.[currentUser.vaultName];
            const lastReadTime = lastRead ? new Date(lastRead).getTime() : 0;
            const messages = this.chatData.channelMessages[channel.id] || [];

            for (const msg of messages) {
                const msgTime = new Date(msg.timestamp).getTime();
                if (msgTime <= lastReadTime) continue;
                if (msg.from === currentUser.vaultName) continue;

                // Check if user is mentioned directly, or via @everyone
                const isMentioned = msg.mentions?.some(m => {
                    const mentionLower = m.toLowerCase();
                    // Direct mention
                    if (mentionLower === currentUser.vaultName.toLowerCase()) return true;
                    // @everyone mentions all users
                    if (mentionLower === 'everyone') return true;
                    return false;
                });

                if (isMentioned) {
                    mentionMessages.push(msg);
                }
            }
        }

        return mentionMessages;
    }

    /**
     * Get all unread messages for current user (across all channels)
     */
    getUnreadMessagesForCurrentUser(): ChatMessage[] {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        const channels = this.getChannelsForUser(currentUser.vaultName);
        const unreadMessages: ChatMessage[] = [];

        for (const channel of channels) {
            const lastRead = this.chatData.readState[channel.id]?.[currentUser.vaultName];
            const lastReadTime = lastRead ? new Date(lastRead).getTime() : 0;
            const messages = this.chatData.channelMessages[channel.id] || [];

            for (const msg of messages) {
                const msgTime = new Date(msg.timestamp).getTime();
                if (msgTime > lastReadTime && msg.from !== currentUser.vaultName && !msg.deleted) {
                    unreadMessages.push(msg);
                }
            }
        }

        return unreadMessages;
    }

    // ==================== Search ====================

    /**
     * Search messages across all channels or in a specific channel
     * @param query - Search query (case-insensitive)
     * @param channelId - Optional channel ID to search within (null = all channels)
     * @returns Array of messages matching the query with channel info
     */
    searchMessages(query: string, channelId?: string): Array<ChatMessage & { channelId: string; channelName: string }> {
        if (!query.trim()) return [];

        const searchLower = query.toLowerCase();
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        const results: Array<ChatMessage & { channelId: string; channelName: string }> = [];
        const channelsToSearch = channelId
            ? [this.chatData.channels.find(c => c.id === channelId)].filter(Boolean) as Channel[]
            : this.getChannelsForUser(currentUser.vaultName);

        for (const channel of channelsToSearch) {
            const messages = this.chatData.channelMessages[channel.id] || [];

            for (const msg of messages) {
                if (msg.deleted) continue;

                // Search in message content
                if (msg.message.toLowerCase().includes(searchLower)) {
                    results.push({
                        ...msg,
                        channelId: channel.id,
                        channelName: channel.name
                    });
                    continue;
                }

                // Search in sender name
                if (msg.from.toLowerCase().includes(searchLower)) {
                    results.push({
                        ...msg,
                        channelId: channel.id,
                        channelName: channel.name
                    });
                }
            }
        }

        // Sort by timestamp (newest first)
        results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        return results;
    }

    // ==================== Utility ====================

    /**
     * Get the chat file path for watching
     */
    getChatFilePath(): string {
        return CHAT_FILE;
    }

    /**
     * Common emoji reactions for quick access
     */
    static readonly QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

    /**
     * Extract file links from message text (format: [[filename]])
     */
    static extractFileLinks(message: string): string[] {
        const regex = /\[\[([^\]]+)\]\]/g;
        const links: string[] = [];
        let match;

        while ((match = regex.exec(message)) !== null) {
            links.push(match[1]);
        }

        return links;
    }

    /**
     * Extract @mentions from message text (excludes channel mentions)
     */
    static extractMentions(message: string): string[] {
        // Match @word but not @#word (channel mentions)
        const regex = /@(?!#)(\w+)/g;
        const mentions: string[] = [];
        let match;

        while ((match = regex.exec(message)) !== null) {
            mentions.push(match[1]);
        }

        return mentions;
    }

    /**
     * Extract @#channel mentions from message text
     */
    static extractChannelMentions(message: string): string[] {
        const regex = /@#([\w-]+)/g;
        const mentions: string[] = [];
        let match;

        while ((match = regex.exec(message)) !== null) {
            mentions.push(match[1]);
        }

        return mentions;
    }

    /**
     * Extract URLs from message text
     */
    static extractUrls(message: string): string[] {
        const regex = /(https?:\/\/[^\s<>\[\]]+)/g;
        const urls: string[] = [];
        let match;

        while ((match = regex.exec(message)) !== null) {
            urls.push(match[1]);
        }

        return urls;
    }

    /**
     * Check if message contains media (images)
     */
    static hasMedia(message: ChatMessage): boolean {
        return !!(message.images && message.images.length > 0);
    }
}
