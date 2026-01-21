import { App, TFile, Editor, MarkdownView } from 'obsidian';
import { Mention, MentionsData, MentionReply } from './types';
import { UserManager } from './userManager';

const MENTIONS_FILE = '.collab-mentions/mentions.json';
const MAX_SAVE_RETRIES = 3;

export class MentionParser {
    private app: App;
    private userManager: UserManager;
    private mentionsData: MentionsData = { mentions: [] };
    private mentionRegex = /@(\w+)/g;

    constructor(app: App, userManager: UserManager) {
        this.app = app;
        this.userManager = userManager;
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
     * Generate a simple unique ID
     */
    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Generate a content-based hash for a mention (for deduplication)
     */
    getMentionContentHash(mention: Mention): string {
        const content = `${mention.to}|${mention.from}|${mention.file}|${mention.context}`;
        return this.computeHash(content);
    }

    /**
     * Load mentions from vault
     */
    async loadMentions(): Promise<void> {
        try {
            if (!await this.app.vault.adapter.exists('.collab-mentions')) {
                await this.app.vault.adapter.mkdir('.collab-mentions');
            }

            if (await this.app.vault.adapter.exists(MENTIONS_FILE)) {
                const content = await this.app.vault.adapter.read(MENTIONS_FILE);
                this.mentionsData = JSON.parse(content);
            } else {
                this.mentionsData = { mentions: [] };
                await this.saveMentions();
            }
        } catch (error) {
            console.error('Failed to load mentions:', error);
            this.mentionsData = { mentions: [] };
        }
    }

    /**
     * Save mentions to vault with merge strategy to prevent data loss
     */
    async saveMentions(): Promise<void> {
        try {
            // Ensure directory exists before saving
            if (!await this.app.vault.adapter.exists('.collab-mentions')) {
                await this.app.vault.adapter.mkdir('.collab-mentions');
            }

            // Try to merge with any changes that happened on disk
            if (await this.app.vault.adapter.exists(MENTIONS_FILE)) {
                try {
                    const diskContent = await this.app.vault.adapter.read(MENTIONS_FILE);
                    const diskData = JSON.parse(diskContent) as MentionsData;

                    // Merge mentions - add any from disk that we don't have
                    const ourMentionIds = new Set(this.mentionsData.mentions.map(m => m.id));
                    for (const mention of diskData.mentions) {
                        if (!ourMentionIds.has(mention.id)) {
                            this.mentionsData.mentions.push(mention);
                        } else {
                            // Update read state if the disk version is read and ours isn't
                            const ourMention = this.mentionsData.mentions.find(m => m.id === mention.id);
                            if (ourMention && mention.read && !ourMention.read) {
                                ourMention.read = true;
                                ourMention.readAt = mention.readAt;
                            }
                            // Merge replies
                            if (mention.replies && mention.replies.length > 0 && ourMention) {
                                if (!ourMention.replies) ourMention.replies = [];
                                const ourReplyIds = new Set(ourMention.replies.map(r => r.id));
                                for (const reply of mention.replies) {
                                    if (!ourReplyIds.has(reply.id)) {
                                        ourMention.replies.push(reply);
                                    }
                                }
                                // Sort replies by timestamp
                                ourMention.replies.sort(
                                    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                                );
                            }
                        }
                    }

                    // Sort all mentions by timestamp
                    this.mentionsData.mentions.sort(
                        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                    );
                } catch (e) {
                    console.warn('Failed to merge mentions data, saving anyway:', e);
                }
            }

            const content = JSON.stringify(this.mentionsData, null, 2);
            const expectedHash = this.computeHash(content);

            // Save with verification and retry
            for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
                await this.app.vault.adapter.write(MENTIONS_FILE, content);

                // Verify the save by reading back and comparing hash
                try {
                    const savedContent = await this.app.vault.adapter.read(MENTIONS_FILE);
                    const savedHash = this.computeHash(savedContent);

                    if (savedHash === expectedHash) {
                        console.log('[Collab-Mentions] Mentions saved and verified (attempt', attempt + ')');
                        return; // Success!
                    } else {
                        console.warn(`[Collab-Mentions] Save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}), hash mismatch`);
                    }
                } catch (verifyError) {
                    console.warn(`[Collab-Mentions] Save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}):`, verifyError);
                }

                // Wait a bit before retry
                if (attempt < MAX_SAVE_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }

            console.error('[Collab-Mentions] Failed to verify mentions save after', MAX_SAVE_RETRIES, 'attempts');
        } catch (error) {
            console.error('Failed to save mentions:', error);
        }
    }

    /**
     * Parse a line of text for @mentions
     */
    parseMentions(text: string): string[] {
        const mentions: string[] = [];
        let match;

        // Reset regex
        this.mentionRegex.lastIndex = 0;

        while ((match = this.mentionRegex.exec(text)) !== null) {
            const mentionedName = match[1];
            console.log('[Collab-Mentions] Found @mention:', mentionedName);
            // Check if this is a registered user
            const user = this.userManager.getUserByName(mentionedName);
            console.log('[Collab-Mentions] User lookup result:', user ? user.vaultName : 'NOT FOUND');
            if (user) {
                mentions.push(mentionedName);
            }
        }

        return mentions;
    }

    /**
     * Get context around a mention (the full line or surrounding text)
     */
    getContext(content: string, lineNumber: number): string {
        const lines = content.split('\n');
        if (lineNumber >= 0 && lineNumber < lines.length) {
            return lines[lineNumber].trim();
        }
        return '';
    }

    /**
     * Create a new mention
     */
    async createMention(
        to: string,
        file: TFile,
        line: number,
        context: string
    ): Promise<Mention | null> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) {
            console.error('Cannot create mention: no current user');
            return null;
        }

        // Cannot mention yourself
        if (to.toLowerCase() === currentUser.vaultName.toLowerCase()) {
            console.log('[Collab-Mentions] Skipping self-mention');
            return null;
        }

        // Check if someone ELSE already created this mention (e.g., file synced from another user)
        // Don't overwrite mentions from other users
        const existingFromOther = this.mentionsData.mentions.find(
            m => m.to.toLowerCase() === to.toLowerCase() &&
                 m.file === file.path &&
                 m.line === line &&
                 m.from.toLowerCase() !== currentUser.vaultName.toLowerCase()
        );

        if (existingFromOther) {
            console.log('[Collab-Mentions] Mention already exists from another user:', existingFromOther.from);
            return null;
        }

        // Check if this exact mention already exists
        // Multiple checks to prevent duplicates:
        // 1. Same file + same line + same user (regardless of read status)
        // 2. Same file + same context + same user (in case lines shifted)
        const existingByLine = this.mentionsData.mentions.find(
            m => m.to.toLowerCase() === to.toLowerCase() &&
                 m.file === file.path &&
                 m.line === line &&
                 m.from.toLowerCase() === currentUser.vaultName.toLowerCase()
        );

        if (existingByLine) {
            // Update context if it changed (line content edited)
            if (existingByLine.context !== context) {
                existingByLine.context = context;
                await this.saveMentions();
            }
            return null; // Don't create duplicate
        }

        // Also check by context to catch shifted lines (e.g., adding a line above pushed the mention down)
        // Only consider it a "shift" if within a reasonable distance (10 lines)
        // If farther apart, they're likely genuinely different mentions with the same text
        const LINE_SHIFT_THRESHOLD = 10;
        const existingByContext = this.mentionsData.mentions.find(
            m => m.to.toLowerCase() === to.toLowerCase() &&
                 m.file === file.path &&
                 m.context === context &&
                 m.from.toLowerCase() === currentUser.vaultName.toLowerCase() &&
                 Math.abs(m.line - line) <= LINE_SHIFT_THRESHOLD // Only match if within threshold
        );

        if (existingByContext) {
            // Update line number if it shifted (but still within threshold)
            if (existingByContext.line !== line) {
                existingByContext.line = line;
                await this.saveMentions();
            }
            return null; // Don't create duplicate
        }

        const mention: Mention = {
            id: this.generateId(),
            to: to,
            from: currentUser.vaultName,
            file: file.path,
            line: line,
            context: context,
            timestamp: new Date().toISOString(),
            read: false,
            replies: []
        };

        this.mentionsData.mentions.push(mention);
        await this.saveMentions();

        return mention;
    }

    /**
     * Process a file for new mentions (called on file modify)
     */
    async processFile(file: TFile): Promise<Mention[]> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        const newMentions: Mention[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const mentionedUsers = this.parseMentions(line);

            for (const userName of mentionedUsers) {
                // Don't create mention for yourself
                if (userName.toLowerCase() === currentUser.vaultName.toLowerCase()) {
                    continue;
                }

                const mention = await this.createMention(
                    userName,
                    file,
                    i,
                    line.trim()
                );

                if (mention) {
                    newMentions.push(mention);
                }
            }
        }

        return newMentions;
    }

    /**
     * Get unread mentions for the current user
     */
    getUnreadMentions(): Mention[] {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        return this.mentionsData.mentions.filter(
            m => m.to.toLowerCase() === currentUser.vaultName.toLowerCase() && !m.read
        );
    }

    /**
     * Get all mentions for the current user
     */
    getAllMentionsForCurrentUser(): Mention[] {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        return this.mentionsData.mentions.filter(
            m => m.to.toLowerCase() === currentUser.vaultName.toLowerCase()
        ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    /**
     * Get all mentions from the current user
     */
    getMentionsFromCurrentUser(): Mention[] {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        return this.mentionsData.mentions.filter(
            m => m.from.toLowerCase() === currentUser.vaultName.toLowerCase()
        ).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    /**
     * Mark a mention as read
     */
    async markAsRead(mentionId: string): Promise<void> {
        const mention = this.mentionsData.mentions.find(m => m.id === mentionId);
        if (mention && !mention.read) {
            mention.read = true;
            mention.readAt = new Date().toISOString();
            await this.saveMentions();
        }
    }

    /**
     * Mark all mentions as read for current user
     */
    async markAllAsRead(): Promise<void> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return;

        const now = new Date().toISOString();
        this.mentionsData.mentions.forEach(m => {
            if (m.to.toLowerCase() === currentUser.vaultName.toLowerCase() && !m.read) {
                m.read = true;
                m.readAt = now;
            }
        });

        await this.saveMentions();
    }

    /**
     * Add a reply to a mention
     */
    async addReply(mentionId: string, message: string): Promise<MentionReply | null> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return null;

        const mention = this.mentionsData.mentions.find(m => m.id === mentionId);
        if (!mention) return null;

        if (!mention.replies) {
            mention.replies = [];
        }

        const reply: MentionReply = {
            id: this.generateId(),
            from: currentUser.vaultName,
            message: message,
            timestamp: new Date().toISOString()
        };

        mention.replies.push(reply);
        await this.saveMentions();

        return reply;
    }

    /**
     * Delete old read mentions (cleanup) - ALL mentions
     */
    async cleanupOldMentions(daysOld: number = 30): Promise<number> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysOld);

        const initialCount = this.mentionsData.mentions.length;

        this.mentionsData.mentions = this.mentionsData.mentions.filter(m => {
            const mentionDate = new Date(m.timestamp);
            // Keep if unread OR newer than cutoff
            return !m.read || mentionDate > cutoff;
        });

        const removed = initialCount - this.mentionsData.mentions.length;

        if (removed > 0) {
            await this.saveMentions();
        }

        return removed;
    }

    /**
     * Cleanup mentions with scope options
     * @param scope - 'my-received' | 'my-sent' | 'user-received' | 'user-sent' | 'all'
     * @param targetUser - the user to cleanup for (current user or specified)
     * @param daysOld - how old mentions must be to be removed (0 = all read)
     */
    async cleanupMentionsScoped(
        scope: 'my-received' | 'my-sent' | 'user-received' | 'user-sent' | 'all',
        targetUser: string,
        daysOld: number = 30
    ): Promise<number> {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - daysOld);

        const initialCount = this.mentionsData.mentions.length;

        this.mentionsData.mentions = this.mentionsData.mentions.filter(m => {
            const mentionDate = new Date(m.timestamp);
            const isOldEnough = daysOld === 0 || mentionDate <= cutoff;

            // Always keep unread mentions
            if (!m.read) return true;

            // If not old enough, keep it
            if (!isOldEnough) return true;

            // Check scope
            switch (scope) {
                case 'my-received':
                case 'user-received':
                    // Remove if this mention is TO the target user
                    return m.to !== targetUser;
                case 'my-sent':
                case 'user-sent':
                    // Remove if this mention is FROM the target user
                    return m.from !== targetUser;
                case 'all':
                    // Remove all old read mentions
                    return false;
                default:
                    return true;
            }
        });

        const removed = initialCount - this.mentionsData.mentions.length;

        if (removed > 0) {
            await this.saveMentions();
        }

        return removed;
    }

    /**
     * Get list of all users who have mentions (for cleanup UI)
     */
    getAllMentionedUsers(): string[] {
        const users = new Set<string>();
        for (const mention of this.mentionsData.mentions) {
            users.add(mention.to);
            users.add(mention.from);
        }
        return Array.from(users).sort();
    }

    /**
     * Get all mentions (for admin/debug)
     */
    getAllMentions(): Mention[] {
        return this.mentionsData.mentions;
    }

    /**
     * AUTO CLEANUP - Keep only last N mentions per user
     */
    async autoCleanupMentions(maxPerUser: number, cleanupIntervalHours: number): Promise<number> {
        const now = new Date();
        const lastCleanup = this.mentionsData.lastCleanup 
            ? new Date(this.mentionsData.lastCleanup) 
            : new Date(0);

        const hoursSinceCleanup = (now.getTime() - lastCleanup.getTime()) / (1000 * 60 * 60);

        // Only cleanup if enough time has passed
        if (hoursSinceCleanup < cleanupIntervalHours) {
            return 0;
        }

        const initialCount = this.mentionsData.mentions.length;

        // Group mentions by user
        const mentionsByUser: { [key: string]: Mention[] } = {};

        for (const mention of this.mentionsData.mentions) {
            if (!mentionsByUser[mention.to]) {
                mentionsByUser[mention.to] = [];
            }
            mentionsByUser[mention.to].push(mention);
        }

        // Keep only last N mentions per user
        const kept: Mention[] = [];
        for (const userName in mentionsByUser) {
            const userMentions = mentionsByUser[userName];
            
            // Sort by timestamp (newest first)
            userMentions.sort((a, b) => 
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            // Keep unread mentions + last N mentions
            const unread = userMentions.filter(m => !m.read);
            const read = userMentions.filter(m => m.read);
            
            // Always keep unread, then fill up to maxPerUser with most recent read
            kept.push(...unread);
            kept.push(...read.slice(0, Math.max(0, maxPerUser - unread.length)));
        }

        this.mentionsData.mentions = kept;
        this.mentionsData.lastCleanup = now.toISOString();

        const removed = initialCount - kept.length;

        if (removed > 0) {
            await this.saveMentions();
            console.log(`Auto-cleanup: removed ${removed} old mentions`);
        }

        return removed;
    }

    /**
     * Get file path for watching
     */
    getMentionsFilePath(): string {
        return MENTIONS_FILE;
    }

    /**
     * Get all mention IDs (for cleanup of notification tracking)
     */
    getAllMentionIds(): string[] {
        return this.mentionsData.mentions.map(m => m.id);
    }
}