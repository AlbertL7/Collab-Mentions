import {
    App,
    Editor,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    debounce,
    EditorSuggest,
    EditorPosition,
    EditorSuggestTriggerInfo,
    EditorSuggestContext,
    Notice
} from 'obsidian';

import { CollabMentionsSettings, DEFAULT_SETTINGS, Reminder, ChatMessage, VaultUser, Mention } from './src/types';
import { UserManager } from './src/userManager';
import { MentionParser } from './src/mentionParser';
import { ChatManager } from './src/chatManager';
import { ReminderManager } from './src/reminderManager';
import { Notifier } from './src/notifier';
import { RegisterModal, UserManagementModal } from './src/ui/registerModal';
import { MentionPanelView, MENTION_PANEL_VIEW_TYPE, ReminderNotificationModal } from './src/ui/mentionPanel';

export default class CollabMentionsPlugin extends Plugin {
    settings: CollabMentionsSettings;
    userManager: UserManager;
    mentionParser: MentionParser;
    chatManager: ChatManager;
    reminderManager: ReminderManager;
    notifier: Notifier;
    private fileWatcherInterval: number | null = null;
    private heartbeatInterval: number | null = null;
    private cleanupInterval: number | null = null;  // Periodic cleanup of tracking Sets
    private lastMentionsFileHash: string | null = null;
    private lastChatFileHash: string | null = null;
    private lastUsersFileHash: string | null = null;
    private lastRemindersFileHash: string | null = null;
    private notifiedMentionIds: Set<string> = new Set();  // Track already-notified mentions
    private notifiedContentHashes: Set<string> = new Set();  // Track by content hash for extra robustness
    private knownChannelIds: Set<string> = new Set();  // Track channels user is in
    private ribbonIconEl: HTMLElement | null = null;  // Reference to ribbon icon for badge updates
    private lastUnreadNotificationTime: number = 0;  // Prevent repeated unread notifications
    private wasSnoozing: boolean = false;  // Track if user was snoozing
    private lastKnownMessageIds: Map<string, Set<string>> = new Map();  // Track known message IDs per channel
    private notifiedMessageHashes: Set<string> = new Set();  // Track message content hashes for notification dedup
    private notifiedReminderIds: Set<string> = new Set();  // Track already-notified reminders
    private lastCleanupTime: number = 0;  // Track last cleanup time
    // Cached stat-key + hash per file path — lets us skip re-reading unchanged files
    private fileStatKeys: Map<string, string> = new Map();
    private fileHashes: Map<string, string> = new Map();
    private fileWatcherTickCount: number = 0;
    private notificationHost: HTMLElement | null = null;
    private deferredLoadsPromise: Promise<unknown> = Promise.resolve();
    /** vault.on('modify') events before this timestamp are ignored. Drive sync at
     *  vault-open fires a flood of modify events for pre-existing files; processing
     *  them all reads + regex-scans every file and competes with Obsidian's
     *  own indexing. New mentions from *other* users arrive via mentions.json
     *  (caught by the file watcher), so skipping markdown sync events is safe. */
    private modifyHandlerReadyAt: number = 0;

    async onload(): Promise<void> {
        console.debug('Loading Collab Mentions plugin');

        // Construct managers eagerly (sync; just sets up empty state). Anything
        // that holds a reference — registerView, registerEditorSuggest — gets
        // a valid object even before its file has loaded.
        this.userManager = new UserManager(this.app);
        this.mentionParser = new MentionParser(this.app, this.userManager);
        this.chatManager = new ChatManager(this.app, this.userManager);
        this.reminderManager = new ReminderManager(this.app, this.userManager);

        // CRITICAL PATH — only what the ribbon icon + commands need before
        // onload returns: settings (for feature flags), users (for isRegistered),
        // mentions (for the ribbon badge count). Run them in parallel.
        await Promise.all([
            this.loadSettings(),
            this.userManager.loadUsers(),
            this.mentionParser.loadMentions(),
        ]);
        this.userManager.identifyCurrentUser();

        // DEFERRED — chat.json and reminders.json kicked off in the background.
        // Tracked as a promise so the 3 s startup-notification batch and the
        // file watcher / heartbeat startup can wait on them rather than racing.
        this.deferredLoadsPromise = Promise.all([
            this.chatManager.loadChat(),
            this.reminderManager.loadReminders(),
        ]).then(() => {
            // If Obsidian restored our panel during vault-open, it rendered
            // before chat data finished loading. Refresh it now that data is in.
            this.refreshPanel();
            this.updateRibbonBadge();
        }).catch(e => {
            console.error('[Collab-Mentions] Deferred load failed:', e);
        });

        // Set up reminder notification callback
        this.reminderManager.setOnReminderDue((reminder: Reminder) => {
            this.showReminderNotification(reminder);
        });

        this.notifier = new Notifier(this.app, this.mentionParser, this.userManager);

        // Register the mentions panel view
        this.registerView(
            MENTION_PANEL_VIEW_TYPE,
            (leaf) => new MentionPanelView(
                leaf,
                this.mentionParser,
                this.userManager,
                this.chatManager,
                this.reminderManager,
                () => this.updateRibbonBadge()  // Callback to update badge when read status changes
            )
        );

        // Add ribbon icon with unread badge - toggles panel open/closed
        this.ribbonIconEl = this.addRibbonIcon('at-sign', 'Collab mentions', async () => {
            if (!this.userManager.isRegistered()) {
                // Open registration modal if not registered
                new RegisterModal(
                    this.app,
                    this.userManager,
                    () => this.onUserRegistered()
                ).open();
            } else {
                // Toggle mentions panel if registered
                await this.toggleMentionPanel();
            }
        });

        // Add badge element to ribbon icon
        this.ribbonIconEl.addClass('collab-ribbon-icon');
        const badgeEl = this.ribbonIconEl.createEl('span', { cls: 'collab-ribbon-badge collab-hidden' });

        // Plugin-owned host for centered notifications. Lives at body level so it
        // can position above the workspace, but everything inside is scoped under
        // .collab-mentions-host so theme rules can't accidentally bleed in, and
        // onunload removes the whole subtree in one shot.
        this.notificationHost = document.body.createDiv({ cls: 'collab-mentions-host' });

        // Add commands
        this.addCommand({
            id: 'open-mentions-panel',
            name: 'Open mentions panel',
            callback: async () => {
                await this.activateMentionPanel();
            }
        });

        this.addCommand({
            id: 'register-user',
            name: 'Register / manage user',
            callback: () => {
                if (this.userManager.isRegistered()) {
                    new UserManagementModal(
                        this.app,
                        this.userManager,
                        () => this.onUserRegistered()
                    ).open();
                } else {
                    new RegisterModal(
                        this.app,
                        this.userManager,
                        () => this.onUserRegistered()
                    ).open();
                }
            }
        });

        this.addCommand({
            id: 'check-mentions',
            name: 'Check for new mentions',
            callback: async () => {
                await this.mentionParser.loadMentions();
                const unread = this.mentionParser.getUnreadMentions();
                if (unread.length === 0) {
                    this.notifier.showNotice('No new mentions');
                    return;
                }
                this.notifyAboutNewMentions(unread);
            }
        });

        this.addCommand({
            id: 'mark-all-read',
            name: 'Mark all mentions as read',
            callback: async () => {
                await this.mentionParser.markAllAsRead();
                this.notifier.showNotice('All mentions marked as read');
                this.refreshPanel();
            }
        });

        // Register the @ autocomplete suggester
        this.registerEditorSuggest(new MentionSuggest(this.app, this.userManager, this.chatManager));

        // Watch for file changes to detect new mentions
        // Uses a hybrid approach: immediate processing + follow-up processing for rapid edits
        // This ensures notifications go out immediately AND we don't miss mentions from rapid consecutive edits
        const pendingFiles: Map<string, TFile> = new Map();
        let followUpTimer: number | null = null;

        const processFileForMentions = async (file: TFile): Promise<void> => {
            console.debug('[Collab-Mentions] Processing file for mentions:', file.path);
            if (this.userManager.isRegistered()) {
                const newMentions = await this.mentionParser.processFile(file);
                console.debug('[Collab-Mentions] New mentions found:', newMentions.length);
                for (const mention of newMentions) {
                    console.debug('[Collab-Mentions] Notifying mention to:', mention.to);
                    this.notifier.notifyNewMention(mention);
                }
            }
        };

        // Debounced immediate processing (leading edge for responsiveness)
        const debouncedProcessFile = debounce(
            async (file: TFile) => {
                console.debug('[Collab-Mentions] File modified (immediate):', file.path);
                await processFileForMentions(file);
            },
            1000,
            true
        );

        // 10-second grace window after onload during which we ignore modify
        // events. This skips the burst of Drive-sync events fired during
        // Obsidian's vault-opening phase without losing real edits the user
        // makes themselves (they aren't editing in the first 10s anyway).
        this.modifyHandlerReadyAt = Date.now() + 10000;

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (Date.now() < this.modifyHandlerReadyAt) return;
                if (file instanceof TFile && file.extension === 'md') {
                    // Immediate processing via debounce (first edit processed right away)
                    debouncedProcessFile(file);

                    // Track this file for follow-up processing (catches rapid consecutive edits)
                    pendingFiles.set(file.path, file);

                    // Reset follow-up timer
                    if (followUpTimer !== null) {
                        window.clearTimeout(followUpTimer);
                    }

                    // After 1.5 seconds of no edits, re-process all pending files
                    // This catches any mentions added during the debounce period
                    followUpTimer = window.setTimeout(() => {
                        void (async () => {
                            if (pendingFiles.size > 0) {
                                console.debug('[Collab-Mentions] Follow-up processing', pendingFiles.size, 'files');
                                for (const [, pendingFile] of pendingFiles) {
                                    await processFileForMentions(pendingFile);
                                }
                                pendingFiles.clear();
                            }
                            followUpTimer = null;
                        })();
                    }, 1500);
                }
            })
        );

        // Add settings tab
        this.addSettingTab(new CollabMentionsSettingTab(this.app, this));

        // Check for mentions on startup (after a delay to let vault sync)
        if (this.userManager.isRegistered() && this.settings.enableNotifications) {
            setTimeout(() => {
                void (async () => {
                    // Wait for deferred chat/reminder loads before reading them.
                    await this.deferredLoadsPromise;

                    const currentUser = this.userManager.getCurrentUser();
                    if (!currentUser) return;

                    const username = currentUser.vaultName;

                    // Initialize per-user notification tracking if needed
                    if (!this.settings.notifiedMentionIdsByUser[username]) {
                        this.settings.notifiedMentionIdsByUser[username] = [];
                    }
                    if (!this.settings.lastNotifiedChatTimestampByUser[username]) {
                        this.settings.lastNotifiedChatTimestampByUser[username] = {};
                    }

                    const userNotifiedMentions = this.settings.notifiedMentionIdsByUser[username];
                    const userChatTimestamps = this.settings.lastNotifiedChatTimestampByUser[username];

                    const unreadMentions = this.mentionParser.getUnreadMentions();

                    // Filter to only mentions not yet notified for THIS user
                    const notNotifiedYet = unreadMentions.filter(
                        m => !userNotifiedMentions.includes(m.id)
                    );

                    // Check for unread mentions that haven't been notified yet
                    if (notNotifiedYet.length > 0) {
                        this.notifier.showStartupNotifications(notNotifiedYet);
                        // Mark these as notified for this user
                        notNotifiedYet.forEach(m => {
                            if (!userNotifiedMentions.includes(m.id)) {
                                userNotifiedMentions.push(m.id);
                            }
                        });
                        // Cleanup old notified IDs (keep only those that still exist)
                        const existingIds = new Set(this.mentionParser.getAllMentionIds());
                        this.settings.notifiedMentionIdsByUser[username] = userNotifiedMentions.filter(
                            id => existingIds.has(id)
                        );
                        await this.saveSettings();
                    }

                    // Check for unread chat messages (only notify once per session for new messages)
                    const channels = this.chatManager.getChannelsForUser(username);
                    let newUnreadCount = 0;

                    for (const channel of channels) {
                        const lastNotified = userChatTimestamps[channel.id];
                        const lastNotifiedTime = lastNotified ? new Date(lastNotified).getTime() : 0;
                        const messages = this.chatManager.getMessages(channel.id);

                        // Count messages newer than our last notification that aren't from us
                        const newMessages = messages.filter(m =>
                            new Date(m.timestamp).getTime() > lastNotifiedTime &&
                            m.from !== username &&
                            m.from !== 'system' &&
                            !m.deleted
                        );
                        newUnreadCount += newMessages.length;

                        // Update last notified timestamp for this channel for this user
                        if (messages.length > 0) {
                            const latestMsg = messages[messages.length - 1];
                            userChatTimestamps[channel.id] = latestMsg.timestamp;
                        }
                    }

                    if (newUnreadCount > 0) {
                        this.showCenteredNotification(
                            '💬 Unread Messages',
                            `You have ${newUnreadCount} unread chat message${newUnreadCount > 1 ? 's' : ''}`,
                            () => {
                                void this.activateMentionPanel({ tab: 'chat' });
                            }
                        );
                        await this.saveSettings();
                    }

                    // Check for missed/due reminders - show individual modals
                    const dueReminders = await this.reminderManager.checkDueReminders();
                    if (dueReminders.length > 0) {
                        console.debug('[Collab-Mentions] Due reminders on startup:', dueReminders.length);
                        // Track and show each reminder - the callback already fired in checkDueReminders
                        // but we need to track them to prevent duplicate notifications
                        for (const reminder of dueReminders) {
                            this.notifiedReminderIds.add(reminder.id);
                        }
                    }

                    // Start periodic reminder checking (every 30s — sub-minute precision is unnecessary for reminders)
                    this.reminderManager.startPeriodicCheck(30000);

                    // Run initial auto-cleanup
                    if (this.settings.autoCleanup) {
                        await this.mentionParser.autoCleanupMentions(
                            this.settings.maxMentionsPerUser,
                            this.settings.cleanupIntervalHours
                        );
                    }

                    // Update ribbon badge with initial counts
                    this.updateRibbonBadge();
                })();
            }, 3000);
        }

        // File watcher and heartbeat both depend on chat data being loaded
        // (the watcher iterates channels/messages to seed its tracking sets;
        // the heartbeat triggers an immediate presence write). Defer both until
        // after the background chat/reminder loads finish so onload returns ASAP.
        if (this.userManager.isRegistered()) {
            void this.deferredLoadsPromise.then(() => {
                if (this.settings.enableFileWatcher) {
                    this.startFileWatcher();
                }
                this.startHeartbeat();
            });
        } else {
            // Show registration prompt if not registered
            setTimeout(() => {
                this.notifier.showNotice(
                    '👋 Welcome to Collab Mentions! Click the @ icon to register.',
                    10000
                );
            }, 2000);
        }
    }

    onunload(): void {
        console.debug('Unloading Collab Mentions plugin');
        this.stopFileWatcher();
        this.stopHeartbeat();
        this.stopCleanupInterval();
        this.reminderManager.stopPeriodicCheck();
        if (this.refreshPanelTimeout !== null) {
            window.clearTimeout(this.refreshPanelTimeout);
            this.refreshPanelTimeout = null;
        }
        this.clearAllNotifications();
        if (this.notificationHost) {
            this.notificationHost.remove();
            this.notificationHost = null;
        }
        // Clear presence so we show as offline
        void (async () => {
            await this.userManager.clearPresence();
        })();
    }

    /**
     * Called after a user successfully registers - starts file watcher and heartbeat
     */
    private onUserRegistered(): void {
        console.debug('[Collab-Mentions] User registered, starting services...');

        // Start file watcher if enabled
        if (this.settings.enableFileWatcher) {
            this.startFileWatcher();
        }

        // Start heartbeat for presence tracking
        this.startHeartbeat();

        // Start periodic reminder checking (every 30s — sub-minute precision is unnecessary for reminders)
        this.reminderManager.startPeriodicCheck(30000);

        // Start periodic cleanup of notification tracking
        this.startCleanupInterval();

        // Refresh the panel to show updated state
        this.refreshPanel();
    }

    /**
     * Show notification for a due reminder with centered modal
     */
    private showReminderNotification(reminder: Reminder): void {
        console.debug('[Collab-Mentions] showReminderNotification called for:', reminder.message.substring(0, 30), 'id:', reminder.id);

        // Check if we've already notified for this reminder in this session
        if (this.notifiedReminderIds.has(reminder.id)) {
            console.debug('[Collab-Mentions] Skipping duplicate notification for reminder:', reminder.id);
            return;
        }

        // Track this reminder as notified to prevent duplicates
        this.notifiedReminderIds.add(reminder.id);

        // Create and open the modal
        const modal = new ReminderNotificationModal(
            this.app,
            reminder,
            this.reminderManager,
            () => this.refreshPanel()
        );

        console.debug('[Collab-Mentions] Opening ReminderNotificationModal for:', reminder.id);
        modal.open();
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    async activateMentionPanel(options?: {
        tab?: 'inbox' | 'sent' | 'team' | 'chat' | 'reminders';
        channelId?: string;
    }): Promise<void> {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(MENTION_PANEL_VIEW_TYPE)[0];

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({
                    type: MENTION_PANEL_VIEW_TYPE,
                    active: true
                });
                leaf = rightLeaf;
            }
        }

        if (leaf) {
            void workspace.revealLeaf(leaf);

            // Navigate to specific tab or channel if requested
            const view = leaf.view as MentionPanelView;
            if (view) {
                if (options?.channelId) {
                    void view.switchToChannel(options.channelId);
                } else if (options?.tab) {
                    void view.switchToTab(options.tab);
                } else if (view.render) {
                    // Re-render on reveal in case panel was hidden during recent file changes
                    void view.render();
                }
            }
        }
    }

    /**
     * Toggle the mention panel open/closed
     */
    async toggleMentionPanel(): Promise<void> {
        const { workspace } = this.app;
        const leaves = workspace.getLeavesOfType(MENTION_PANEL_VIEW_TYPE);

        if (leaves.length > 0) {
            // Panel exists - check if it's visible in the right sidebar
            const leaf = leaves[0];
            const rightSplit = workspace.rightSplit;

            // Check if the right sidebar is collapsed or if our leaf is the active one
            if (rightSplit && !rightSplit.collapsed) {
                // Right sidebar is open - close our panel
                leaf.detach();
                return;
            }
        }

        // Panel doesn't exist or sidebar is collapsed - open it
        await this.activateMentionPanel();
    }

    private refreshPanelTimeout: number | null = null;
    private pendingFullRefresh: boolean = false;

    refreshPanel(smartRefresh: boolean = false): void {
        // Coalesce bursts of refresh calls (e.g., multiple file changes in one watcher tick)
        // into one render on the next tick. If any caller wants a full refresh, that wins.
        if (!smartRefresh) {
            this.pendingFullRefresh = true;
        }
        if (this.refreshPanelTimeout !== null) return;
        this.refreshPanelTimeout = window.setTimeout(() => {
            this.refreshPanelTimeout = null;
            const fullRefresh = this.pendingFullRefresh;
            this.pendingFullRefresh = false;
            this.doRefreshPanel(!fullRefresh);
        }, 50);
    }

    private doRefreshPanel(smartRefresh: boolean): void {
        const leaves = this.app.workspace.getLeavesOfType(MENTION_PANEL_VIEW_TYPE);
        for (const leaf of leaves) {
            const view = leaf.view as MentionPanelView;
            if (!view) continue;
            // Skip rendering if the panel isn't actually visible — saves a lot of work
            // when users keep the right sidebar collapsed. The view will be re-rendered
            // when it becomes visible via activateMentionPanel / setViewState.
            const isVisible = (view.containerEl as HTMLElement)?.offsetParent !== null;
            if (!isVisible) continue;
            if (smartRefresh && view.refreshChat) {
                void view.refreshChat();
            } else if (view.render) {
                void view.render();
            }
        }
        // Always update badge — it's a separate DOM element on the ribbon and is cheap
        this.updateRibbonBadge();
    }

    /**
     * Update the unread badge on the ribbon icon
     */
    updateRibbonBadge(): void {
        if (!this.ribbonIconEl) return;

        const badgeEl = this.ribbonIconEl.querySelector('.collab-ribbon-badge') as HTMLElement;
        if (!badgeEl) return;

        // Count unread mentions
        const unreadMentions = this.mentionParser.getUnreadMentions().length;

        // Count unread chat messages across all channels
        let unreadChat = 0;
        const currentUser = this.userManager.getCurrentUser();
        if (currentUser) {
            const channels = this.chatManager.getChannelsForUser(currentUser.vaultName);
            for (const channel of channels) {
                // Skip muted channels
                if (this.chatManager.isChannelMuted(channel.id)) continue;
                unreadChat += this.chatManager.getUnreadCount(channel.id, currentUser.vaultName);
            }
        }

        const totalUnread = unreadMentions + unreadChat;

        if (totalUnread > 0) {
            badgeEl.textContent = totalUnread > 99 ? '99+' : String(totalUnread);
            badgeEl.removeClass('collab-hidden');
            badgeEl.addClass('collab-visible');
        } else {
            badgeEl.removeClass('collab-visible');
            badgeEl.addClass('collab-hidden');
        }
    }

    /**
     * Fast non-cryptographic hash (FNV-1a) for file change detection
     * Consistent with hashing used in mentionParser, chatManager, userManager
     * Much faster than SHA-256 - optimized for speed, not security
     */
    private computeContentHash(content: string): string {
        let hash = 2166136261; // FNV offset basis
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = (hash * 16777619) >>> 0; // FNV prime, keep as 32-bit unsigned
        }
        return hash.toString(16);
    }

    /**
     * Cheap stat-based change detection: only re-reads + hashes when mtime/size differ.
     * Avoids reading the entire JSON every poll for files that haven't changed.
     */
    private async getFileHashCached(path: string): Promise<string | null> {
        try {
            const adapter = this.app.vault.adapter;
            const stat = await adapter.stat(path);
            if (!stat) return null;
            const statKey = `${stat.mtime}-${stat.size}`;
            const cachedKey = this.fileStatKeys.get(path);
            if (cachedKey === statKey) {
                return this.fileHashes.get(path) ?? null;
            }
            const content = await adapter.read(path);
            const hash = this.computeContentHash(content);
            this.fileStatKeys.set(path, statKey);
            this.fileHashes.set(path, hash);
            return hash;
        } catch (e) {
            // File may not exist yet — return null (caller already handles)
            return null;
        }
    }

    /**
     * FILE WATCHER - Detect changes to mentions.json while vault is open
     */
    private async getMentionsFileHash(): Promise<string | null> {
        return this.getFileHashCached(this.mentionParser.getMentionsFilePath());
    }

    private async checkForMentionsFileChanges(): Promise<void> {
        const currentHash = await this.getMentionsFileHash();

        // Skip if hash not initialized yet (will be set by startFileWatcher)
        if (this.lastMentionsFileHash === null) {
            return;
        }

        // Check if file changed
        if (currentHash && currentHash !== this.lastMentionsFileHash) {
            console.debug('Mentions file changed, reloading...');

            // Reload mentions
            await this.mentionParser.loadMentions();

            // Check for NEW unread mentions (not already notified)
            // Use BOTH ID tracking AND content hash tracking for maximum robustness
            const unread = this.mentionParser.getUnreadMentions();
            console.debug('[Collab-Mentions] Total unread mentions for current user:', unread.length);

            const newUnread: typeof unread = [];

            for (const mention of unread) {
                // Skip if already notified by ID
                if (this.notifiedMentionIds.has(mention.id)) {
                    console.debug('[Collab-Mentions] Skipping mention (already notified by ID):', mention.id, 'from:', mention.from);
                    continue;
                }

                // Also check by content hash (catches edge cases where IDs might differ)
                const contentHash = this.mentionParser.getMentionContentHash(mention);
                if (this.notifiedContentHashes.has(contentHash)) {
                    console.debug('[Collab-Mentions] Skipping mention (already notified by hash):', mention.id, 'from:', mention.from);
                    continue;
                }

                console.debug('[Collab-Mentions] NEW mention to notify:', mention.id, 'from:', mention.from, 'context:', mention.context.substring(0, 50));
                newUnread.push(mention);
                // Track by both ID and hash
                this.notifiedMentionIds.add(mention.id);
                this.notifiedContentHashes.add(contentHash);
            }

            this.notifyAboutNewMentions(newUnread);

            // Smart refresh the panel to show any updates (preserves input focus)
            this.refreshPanel(true);

            // Auto-cleanup if enabled
            if (this.settings.autoCleanup) {
                await this.mentionParser.autoCleanupMentions(
                    this.settings.maxMentionsPerUser,
                    this.settings.cleanupIntervalHours
                );
            }

            this.lastMentionsFileHash = currentHash;
        }
    }

    private async getChatFileHash(): Promise<string | null> {
        return this.getFileHashCached(this.chatManager.getChatFilePath());
    }

    private async checkForChatFileChanges(): Promise<void> {
        const currentHash = await this.getChatFileHash();
        const currentUser = this.userManager.getCurrentUser();

        // Skip if hash not initialized yet (will be set by startFileWatcher)
        if (this.lastChatFileHash === null) {
            return;
        }

        // Check if file changed
        if (currentHash && currentHash !== this.lastChatFileHash) {
            console.debug('Chat file changed, reloading...');

            // Reload chat
            await this.chatManager.loadChat();

            // Check if user was added to any new channels (or re-added after leaving/restore)
            if (currentUser && this.settings.enableNotifications) {
                const currentChannels = this.chatManager.getChannelsForUser(currentUser.vaultName);
                const currentChannelIds = new Set(currentChannels.map(ch => ch.id));

                // Remove channels from known list that user is no longer in (they left)
                for (const knownId of this.knownChannelIds) {
                    if (!currentChannelIds.has(knownId)) {
                        console.debug('[Collab-Mentions] User left channel, removing from known:', knownId);
                        this.knownChannelIds.delete(knownId);
                        this.lastKnownMessageIds.delete(knownId);
                    }
                }

                // Find channels the user is now in but wasn't before (new or re-added)
                const newChannels = currentChannels.filter(ch => !this.knownChannelIds.has(ch.id));

                for (const channel of newChannels) {
                    // DEFENSIVE CHECK: Verify user is actually in the channel's members list
                    // (General channel has empty members = everyone, so skip this check for general)
                    const isActuallyMember = channel.type === 'general' ||
                        channel.members.includes(currentUser.vaultName);

                    if (!isActuallyMember) {
                        console.debug('[Collab-Mentions] Skipping channel notification - user not actually a member:',
                            channel.id, channel.name, 'members:', channel.members);
                        // Still add to known to prevent repeated checks
                        this.knownChannelIds.add(channel.id);
                        continue;
                    }

                    // Capture channel.id for closure
                    const channelId = channel.id;
                    // Show centered notification for new/restored channel
                    console.debug('[Collab-Mentions] User added to channel:', channel.id, channel.name,
                        'members:', channel.members);
                    this.showCenteredNotification(
                        '💬 New Channel',
                        `You were added to "${channel.name || 'a conversation'}"`,
                        () => {
                            // Switch to the new channel when clicked
                            void this.activateMentionPanel({ channelId });
                        }
                    );
                    this.knownChannelIds.add(channel.id);

                    // Initialize message tracking for new channel
                    const messages = this.chatManager.getMessages(channel.id);
                    this.lastKnownMessageIds.set(channel.id, new Set(messages.map(m => m.id)));

                    if (this.settings.notificationSound) {
                        this.notifier.playSound();
                    }
                }

                // Check for NEW messages in existing channels (by message ID AND content hash)
                const newMessagesFromOthers: Array<{ channelId: string; channelName: string; message: ChatMessage; contentHash: string }> = [];

                for (const channel of currentChannels) {
                    if (!this.knownChannelIds.has(channel.id)) continue; // Skip newly added channels
                    if (this.chatManager.isChannelMuted(channel.id)) continue; // Skip muted channels

                    const messages = this.chatManager.getMessages(channel.id);
                    const knownIds = this.lastKnownMessageIds.get(channel.id) || new Set();

                    for (const msg of messages) {
                        // Skip if from current user, system, or deleted
                        if (msg.from === currentUser.vaultName || msg.from === 'system' || msg.deleted) continue;

                        // Check by ID first
                        if (knownIds.has(msg.id)) continue;

                        // Also check by content hash for extra robustness
                        const contentHash = this.chatManager.getMessageContentHash(msg);
                        if (this.notifiedMessageHashes.has(contentHash)) continue;

                        newMessagesFromOthers.push({
                            channelId: channel.id,
                            channelName: channel.name,
                            message: msg,
                            contentHash: contentHash
                        });
                    }

                    // Update known message IDs
                    this.lastKnownMessageIds.set(channel.id, new Set(messages.map(m => m.id)));
                }

                // Notify about new messages (batch if many)
                if (newMessagesFromOthers.length > 0) {
                    console.debug('[Collab-Mentions] New messages from others:', newMessagesFromOthers.length,
                        newMessagesFromOthers.map(m => ({
                            id: m.message.id,
                            from: m.message.from,
                            channel: m.channelName,
                            hasImages: !!(m.message.images && m.message.images.length > 0),
                            hasText: !!m.message.message
                        })));

                    // Track all messages by content hash first
                    for (const { contentHash } of newMessagesFromOthers) {
                        this.notifiedMessageHashes.add(contentHash);
                    }

                    // Batch notifications when there are many to prevent notification storm
                    if (newMessagesFromOthers.length > 5) {
                        // Show single batched notification for many messages
                        const uniqueSenders = [...new Set(newMessagesFromOthers.map(m => m.message.from))];
                        const uniqueChannels = [...new Set(newMessagesFromOthers.map(m => m.channelName))];
                        const channelText = uniqueChannels.length === 1
                            ? `in ${uniqueChannels[0]}`
                            : `across ${uniqueChannels.length} channels`;
                        const senderText = uniqueSenders.length === 1
                            ? `from @${uniqueSenders[0]}`
                            : `from ${uniqueSenders.length} people`;

                        // Navigate to the first channel with new messages
                        const firstChannelId = newMessagesFromOthers[0].channelId;

                        this.showCenteredNotification(
                            '💬 New Messages',
                            `${newMessagesFromOthers.length} new messages ${senderText} ${channelText}`,
                            () => { void this.activateMentionPanel({ channelId: firstChannelId }); }
                        );
                    } else {
                        // Show individual notifications for small batches (1-5)
                        for (const { channelId, channelName, message } of newMessagesFromOthers) {
                            // Build notification text - handle image-only messages
                            let notificationText: string;
                            const hasImages = message.images && message.images.length > 0;
                            const hasText = message.message && message.message.trim().length > 0;

                            if (hasText && hasImages) {
                                // Both text and images
                                notificationText = `@${message.from} in ${channelName}: "${this.truncateText(message.message, 30)}" 📷`;
                            } else if (hasImages) {
                                // Image only
                                const imageCount = message.images!.length;
                                notificationText = `@${message.from} sent ${imageCount > 1 ? imageCount + ' images' : 'an image'} in ${channelName}`;
                            } else {
                                // Text only (or empty - shouldn't happen but handle it)
                                notificationText = `@${message.from} in ${channelName}: "${this.truncateText(message.message || '', 40)}"`;
                            }

                            this.showCenteredNotification(
                                '💬 New Message',
                                notificationText,
                                () => { void this.activateMentionPanel({ channelId }); }
                            );
                        }
                    }

                    // Play sound once for the batch
                    if (this.settings.notificationSound) {
                        this.notifier.playSound();
                    }
                }
            }

            // Smart refresh panel to show new messages (preserves input focus)
            this.refreshPanel(true);

            this.lastChatFileHash = currentHash;
        }
    }

    private async getUsersFileHash(): Promise<string | null> {
        return this.getFileHashCached(this.userManager.getUsersFilePath());
    }

    private async checkForUsersFileChanges(): Promise<void> {
        const currentHash = await this.getUsersFileHash();

        // Initialize on first run
        if (this.lastUsersFileHash === null) {
            this.lastUsersFileHash = currentHash;
            return;
        }

        // Check if file changed
        if (currentHash && currentHash !== this.lastUsersFileHash) {
            console.debug('Users file changed, reloading...');

            // Reload users
            await this.userManager.loadUsers();

            // Refresh the panel (Team tab will show updated user list)
            this.refreshPanel();

            this.lastUsersFileHash = currentHash;
        }
    }

    private async getRemindersFileHash(): Promise<string | null> {
        return this.getFileHashCached(this.reminderManager.getRemindersFilePath());
    }

    private async checkForRemindersFileChanges(): Promise<void> {
        const currentHash = await this.getRemindersFileHash();

        // Skip if hash not initialized yet
        if (this.lastRemindersFileHash === null) {
            return;
        }

        // Check if file changed
        if (currentHash && currentHash !== this.lastRemindersFileHash) {
            console.debug('[Collab-Mentions] Reminders file changed, reloading...');

            // Reload reminders from disk
            await this.reminderManager.loadReminders();

            // Check for due reminders (this will trigger callback for each)
            const dueReminders = await this.reminderManager.checkDueReminders();

            // Track notified reminders to prevent duplicates
            for (const reminder of dueReminders) {
                if (!this.notifiedReminderIds.has(reminder.id)) {
                    this.notifiedReminderIds.add(reminder.id);
                    console.debug('[Collab-Mentions] Notified for reminder:', reminder.id, reminder.message.substring(0, 30));
                }
            }

            // Refresh panel to show any new/changed reminders
            this.refreshPanel();

            this.lastRemindersFileHash = currentHash;
        }
    }

    /**
     * Show a centered notification modal (stacks multiple notifications)
     */
    private activeNotifications: HTMLElement[] = [];
    private notificationTimers: Map<HTMLElement, number> = new Map();
    private recentNotificationKeys: Map<string, number> = new Map();

    /**
     * Single entry point for "tell the user about these unread mentions".
     * Handles batching (1–3 individual modals, 4+ collapsed to one), sound
     * (once per call), and dedupe-set bookkeeping so the file watcher won't
     * re-notify for the same mentions later.
     */
    private notifyAboutNewMentions(mentions: Mention[]): void {
        if (mentions.length === 0) return;

        // Always record into dedupe sets, even if notifications are disabled —
        // otherwise toggling notifications back on would replay every mention.
        for (const m of mentions) {
            this.notifiedMentionIds.add(m.id);
            this.notifiedContentHashes.add(this.mentionParser.getMentionContentHash(m));
        }

        if (!this.settings.enableNotifications) return;

        if (mentions.length > 3) {
            const uniqueSenders = [...new Set(mentions.map(m => m.from))];
            const senderText = uniqueSenders.length === 1
                ? `from @${uniqueSenders[0]}`
                : `from ${uniqueSenders.length} people`;
            this.showCenteredNotification(
                '📣 New Mentions',
                `You have ${mentions.length} new mentions ${senderText}`,
                () => { void this.activateMentionPanel({ tab: 'inbox' }); }
            );
        } else {
            for (const mention of mentions) {
                this.showCenteredNotification(
                    '📣 New Mention',
                    `@${mention.from} mentioned you: "${this.truncateText(mention.context, 50)}"`,
                    () => { void this.activateMentionPanel({ tab: 'inbox' }); }
                );
            }
        }

        if (this.settings.notificationSound) {
            this.notifier.playSound();
        }
    }

    private showCenteredNotification(title: string, message: string, onClick?: () => void): void {
        // Dedupe: suppress identical title+message shown within the last 5s.
        // Two parallel notify paths (startup batch + file watcher) used to fire
        // for the same event, double-stacking modals on top of each other.
        const key = `${title} ${message}`;
        const now = Date.now();
        const lastShown = this.recentNotificationKeys.get(key);
        if (lastShown !== undefined && now - lastShown < 5000) {
            return;
        }
        this.recentNotificationKeys.set(key, now);
        // Trim old keys (keep map bounded)
        if (this.recentNotificationKeys.size > 50) {
            for (const [k, t] of this.recentNotificationKeys) {
                if (now - t > 60000) this.recentNotificationKeys.delete(k);
            }
        }

        // Create notification container (not full overlay - allows stacking)
        const notification = document.createElement('div');
        notification.className = 'collab-stacked-notification';

        // Calculate position based on existing notifications
        const existingCount = this.activeNotifications.length;
        const topOffset = 20 + (existingCount * 90); // Stack vertically
        notification.setCssProps({ '--notification-top': `${topOffset}px` });

        const titleEl = document.createElement('h3');
        titleEl.textContent = title;
        notification.appendChild(titleEl);

        const messageEl = document.createElement('p');
        messageEl.textContent = message;
        notification.appendChild(messageEl);

        const buttonRow = document.createElement('div');
        buttonRow.className = 'collab-centered-notification-buttons';

        if (onClick) {
            const viewBtn = document.createElement('button');
            viewBtn.textContent = 'View';
            viewBtn.className = 'collab-centered-notification-view-btn';
            viewBtn.addEventListener('click', () => {
                onClick();
                this.removeNotification(notification);
            });
            buttonRow.appendChild(viewBtn);
        }

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.className = 'collab-centered-notification-dismiss-btn';
        dismissBtn.addEventListener('click', () => this.removeNotification(notification));
        buttonRow.appendChild(dismissBtn);

        notification.appendChild(buttonRow);

        // Track this notification
        this.activeNotifications.push(notification);

        // Auto-dismiss after 10s — track timer so manual dismiss can clear it
        const timer = window.setTimeout(() => {
            this.notificationTimers.delete(notification);
            this.removeNotification(notification);
        }, 10000);
        this.notificationTimers.set(notification, timer);

        (this.notificationHost ?? document.body).appendChild(notification);
    }

    private removeNotification(notification: HTMLElement): void {
        const timer = this.notificationTimers.get(notification);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            this.notificationTimers.delete(notification);
        }
        if (notification.parentNode) {
            notification.remove();
        }
        // Remove from tracking array
        const index = this.activeNotifications.indexOf(notification);
        if (index > -1) {
            this.activeNotifications.splice(index, 1);
        }
        // Reposition remaining notifications
        this.activeNotifications.forEach((n, i) => {
            n.setCssProps({ '--notification-top': `${20 + (i * 90)}px` });
        });
    }

    private clearAllNotifications(): void {
        for (const timer of this.notificationTimers.values()) {
            window.clearTimeout(timer);
        }
        this.notificationTimers.clear();
        for (const n of this.activeNotifications) {
            if (n.parentNode) n.remove();
        }
        this.activeNotifications = [];
        this.recentNotificationKeys.clear();
    }

    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    startFileWatcher(): void {
        if (this.fileWatcherInterval !== null) {
            return; // Already running
        }

        console.debug('Starting mentions file watcher...');

        // Poll every 8s. Each tick uses adapter.stat() to skip files whose mtime/size
        // haven't changed — so the typical idle cost is 4 cheap stat() calls, not 4 reads.
        // Presence (other users' online status) reloads every 4th tick (~32s).
        this.fileWatcherInterval = window.setInterval(() => {
            void (async () => {
                this.fileWatcherTickCount++;
                await this.checkForMentionsFileChanges();
                await this.checkForChatFileChanges();
                await this.checkForUsersFileChanges();
                await this.checkForRemindersFileChanges();
                if (this.fileWatcherTickCount % 4 === 0) {
                    await this.userManager.loadPresence();
                }
            })();
        }, 8000);

        // Initial hashes - initialize ALL file hashes
        void this.getMentionsFileHash().then(hash => {
            this.lastMentionsFileHash = hash;
            console.debug('[Collab-Mentions] Initialized mentions hash');
        });
        void this.getChatFileHash().then(hash => {
            this.lastChatFileHash = hash;
            console.debug('[Collab-Mentions] Initialized chat hash');
        });
        void this.getUsersFileHash().then(hash => {
            this.lastUsersFileHash = hash;
            console.debug('[Collab-Mentions] Initialized users hash');
        });
        void this.getRemindersFileHash().then(hash => {
            this.lastRemindersFileHash = hash;
            console.debug('[Collab-Mentions] Initialized reminders hash');
        });

        // Initialize notified mention IDs, content hashes, and known channel IDs
        const unread = this.mentionParser.getUnreadMentions();
        unread.forEach(m => {
            this.notifiedMentionIds.add(m.id);
            // Also initialize content hash tracking for robustness
            const contentHash = this.mentionParser.getMentionContentHash(m);
            this.notifiedContentHashes.add(contentHash);
        });
        console.debug('[Collab-Mentions] Initialized mention tracking:', unread.length, 'mentions');

        const currentUser = this.userManager.getCurrentUser();
        if (currentUser) {
            const channels = this.chatManager.getChannelsForUser(currentUser.vaultName);
            channels.forEach(ch => this.knownChannelIds.add(ch.id));

            // Initialize known message IDs and content hashes per channel
            for (const channel of channels) {
                const messages = this.chatManager.getMessages(channel.id);
                const messageIds = new Set(messages.map(m => m.id));
                this.lastKnownMessageIds.set(channel.id, messageIds);

                // Also initialize message content hashes for robustness
                for (const msg of messages) {
                    if (msg.from !== currentUser.vaultName && msg.from !== 'system') {
                        const contentHash = this.chatManager.getMessageContentHash(msg);
                        this.notifiedMessageHashes.add(contentHash);
                    }
                }
            }
            console.debug('[Collab-Mentions] Initialized channel tracking:', channels.length, 'channels');

            // Initialize notified reminder IDs (reminders that have already notified this user)
            const reminders = this.reminderManager.getReminders();
            for (const reminder of reminders) {
                if (reminder.completed) continue;
                // Check if already notified
                if (reminder.isGlobal) {
                    if (reminder.notifiedUsers?.includes(currentUser.vaultName)) {
                        this.notifiedReminderIds.add(reminder.id);
                    }
                } else if (reminder.user === currentUser.vaultName && reminder.notified) {
                    this.notifiedReminderIds.add(reminder.id);
                }
            }
            console.debug('[Collab-Mentions] Initialized reminder tracking:', this.notifiedReminderIds.size, 'notified reminders');
        }

        // Start cleanup interval to prevent memory leaks
        this.startCleanupInterval();
    }

    stopFileWatcher(): void {
        if (this.fileWatcherInterval !== null) {
            console.debug('Stopping mentions file watcher...');
            window.clearInterval(this.fileWatcherInterval);
            this.fileWatcherInterval = null;
        }
    }

    restartFileWatcher(): void {
        this.stopFileWatcher();
        if (this.settings.enableFileWatcher && this.userManager.isRegistered()) {
            this.startFileWatcher();
        }
    }

    /**
     * Start periodic cleanup of notification tracking Sets to prevent memory leaks.
     * Runs every 30 minutes and removes IDs that no longer exist in the system.
     */
    startCleanupInterval(): void {
        if (this.cleanupInterval !== null) {
            return; // Already running
        }

        console.debug('[Collab-Mentions] Starting periodic cleanup interval...');

        // Run cleanup every 30 minutes
        this.cleanupInterval = window.setInterval(() => {
            this.cleanupNotificationTracking();
        }, 30 * 60 * 1000); // 30 minutes

        // Also run initial cleanup after a delay
        setTimeout(() => this.cleanupNotificationTracking(), 60 * 1000); // 1 minute after start
    }

    /**
     * Stop the cleanup interval
     */
    stopCleanupInterval(): void {
        if (this.cleanupInterval !== null) {
            console.debug('[Collab-Mentions] Stopping cleanup interval...');
            window.clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    /**
     * Clean up notification tracking Sets by removing IDs that no longer exist.
     * This prevents unbounded memory growth over time.
     */
    private cleanupNotificationTracking(): void {
        const startSize = {
            mentionIds: this.notifiedMentionIds.size,
            contentHashes: this.notifiedContentHashes.size,
            messageHashes: this.notifiedMessageHashes.size,
            reminderIds: this.notifiedReminderIds.size,
            channelIds: this.knownChannelIds.size
        };

        // Get current valid IDs from the system
        const allMentions = this.mentionParser.getAllMentions();
        const validMentionIds = new Set(allMentions.map(m => m.id));
        const validMentionHashes = new Set(allMentions.map(m => this.mentionParser.getMentionContentHash(m)));

        // Clean up mention tracking
        this.notifiedMentionIds = new Set(
            [...this.notifiedMentionIds].filter(id => validMentionIds.has(id))
        );
        this.notifiedContentHashes = new Set(
            [...this.notifiedContentHashes].filter(hash => validMentionHashes.has(hash))
        );

        // Get current valid message IDs from all channels
        const currentUser = this.userManager.getCurrentUser();
        if (currentUser) {
            const channels = this.chatManager.getChannelsForUser(currentUser.vaultName);
            const validChannelIds = new Set(channels.map(ch => ch.id));

            // Clean up channel tracking
            this.knownChannelIds = new Set(
                [...this.knownChannelIds].filter(id => validChannelIds.has(id))
            );

            // Collect all valid message hashes
            const validMessageHashes = new Set<string>();
            for (const channel of channels) {
                const messages = this.chatManager.getMessages(channel.id);
                for (const msg of messages) {
                    validMessageHashes.add(this.chatManager.getMessageContentHash(msg));
                }
            }

            // Clean up message hash tracking (keep hashes from last 24 hours even if message deleted)
            // This is more aggressive - only keep hashes for messages that still exist
            this.notifiedMessageHashes = new Set(
                [...this.notifiedMessageHashes].filter(hash => validMessageHashes.has(hash))
            );

            // Clean up lastKnownMessageIds map - remove channels that no longer exist
            for (const channelId of this.lastKnownMessageIds.keys()) {
                if (!validChannelIds.has(channelId)) {
                    this.lastKnownMessageIds.delete(channelId);
                }
            }
        }

        // Get current valid reminder IDs
        const allReminders = this.reminderManager.getReminders();
        const validReminderIds = new Set(allReminders.map(r => r.id));

        // Clean up reminder tracking
        this.notifiedReminderIds = new Set(
            [...this.notifiedReminderIds].filter(id => validReminderIds.has(id))
        );

        const endSize = {
            mentionIds: this.notifiedMentionIds.size,
            contentHashes: this.notifiedContentHashes.size,
            messageHashes: this.notifiedMessageHashes.size,
            reminderIds: this.notifiedReminderIds.size,
            channelIds: this.knownChannelIds.size
        };

        // Log cleanup results if anything was cleaned
        const cleaned =
            (startSize.mentionIds - endSize.mentionIds) +
            (startSize.contentHashes - endSize.contentHashes) +
            (startSize.messageHashes - endSize.messageHashes) +
            (startSize.reminderIds - endSize.reminderIds) +
            (startSize.channelIds - endSize.channelIds);

        if (cleaned > 0) {
            console.debug('[Collab-Mentions] Cleanup completed:', {
                mentionIds: `${startSize.mentionIds} → ${endSize.mentionIds}`,
                contentHashes: `${startSize.contentHashes} → ${endSize.contentHashes}`,
                messageHashes: `${startSize.messageHashes} → ${endSize.messageHashes}`,
                reminderIds: `${startSize.reminderIds} → ${endSize.reminderIds}`,
                channelIds: `${startSize.channelIds} → ${endSize.channelIds}`,
                totalCleaned: cleaned
            });
        }

        this.lastCleanupTime = Date.now();
    }

    /**
     * HEARTBEAT - Update presence every 10 seconds for online status
     * FILE ACTIVITY - Record when user interacts with files (for active vs snooze status)
     */
    startHeartbeat(): void {
        if (this.heartbeatInterval !== null) {
            return; // Already running
        }

        console.debug('Starting presence heartbeat...');

        // Get current active file
        const getActiveFile = (): string | undefined => {
            const activeFile = this.app.workspace.getActiveFile();
            return activeFile?.path;
        };

        // Initial heartbeat with file activity (user just opened vault)
        void this.userManager.recordFileActivity(getActiveFile());

        // Heartbeat every 10 seconds - keeps vault "alive" but doesn't update activity
        this.heartbeatInterval = window.setInterval(() => {
            void (async () => {
                await this.userManager.updateHeartbeat(getActiveFile());
            })();
        }, 10000);

        // Record file activity when user switches files (actual interaction)
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async () => {
                // Check if user was snoozing before this activity
                const currentUser = this.userManager.getCurrentUser();
                if (currentUser) {
                    const statusBeforeActivity = this.userManager.getUserStatus(currentUser.vaultName);
                    this.wasSnoozing = statusBeforeActivity === 'snooze';
                }

                await this.userManager.recordFileActivity(getActiveFile());

                // If returning from snooze, check for unread messages
                if (this.wasSnoozing && currentUser && this.settings.enableNotifications) {
                    const now = Date.now();
                    // Only show notification if we haven't shown one in the last 5 minutes
                    if (now - this.lastUnreadNotificationTime > 5 * 60 * 1000) {
                        const unreadCount = this.chatManager.getTotalUnreadCount(currentUser.vaultName);
                        if (unreadCount > 0) {
                            this.showCenteredNotification(
                                '💬 Welcome Back!',
                                `You have ${unreadCount} unread message${unreadCount > 1 ? 's' : ''} while you were away`,
                                () => { void this.activateMentionPanel({ tab: 'chat' }); }
                            );
                            this.lastUnreadNotificationTime = now;
                        }
                    }
                    this.wasSnoozing = false;
                }
            })
        );
    }

    stopHeartbeat(): void {
        if (this.heartbeatInterval !== null) {
            console.debug('Stopping presence heartbeat...');
            window.clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
}

/**
 * Type for mention suggestions (users, special mentions, or channels)
 */
type MentionSuggestion = {
    vaultName: string;
    color?: string;
    os?: string;
    isSpecial?: boolean;
    description?: string;
    type?: 'user' | 'special' | 'channel';
    channelId?: string;
};

/**
 * Editor suggester for @mentions autocomplete in markdown files
 * Supports @user, @everyone, and @#channel mentions
 */
class MentionSuggest extends EditorSuggest<MentionSuggestion> {
    private userManager: UserManager;
    private chatManager: ChatManager;

    constructor(app: App, userManager: UserManager, chatManager: ChatManager) {
        super(app);
        this.userManager = userManager;
        this.chatManager = chatManager;
    }

    onTrigger(
        cursor: EditorPosition,
        editor: Editor,
        file: TFile
    ): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        const subString = line.substring(0, cursor.ch);

        // Check for @# (channel mention) or @ (user mention)
        const channelMatch = subString.match(/@#([\w-]*)$/);
        const userMatch = subString.match(/@(\w*)$/);

        if (channelMatch) {
            return {
                start: { line: cursor.line, ch: cursor.ch - channelMatch[0].length },
                end: cursor,
                query: '#' + channelMatch[1]
            };
        }

        if (userMatch) {
            return {
                start: { line: cursor.line, ch: cursor.ch - userMatch[0].length },
                end: cursor,
                query: userMatch[1]
            };
        }

        return null;
    }

    getSuggestions(context: EditorSuggestContext): MentionSuggestion[] {
        const query = context.query.toLowerCase();

        // Check if this is a channel search (starts with #)
        if (query.startsWith('#')) {
            const channelQuery = query.substring(1);
            const currentUser = this.userManager.getCurrentUser();
            if (!currentUser) return [];

            const channels = this.chatManager.getChannelsForUser(currentUser.vaultName);

            return channels
                .filter(ch => ch.name.toLowerCase().includes(channelQuery))
                .map(ch => ({
                    vaultName: ch.name,
                    color: '#3b82f6',
                    type: 'channel' as const,
                    channelId: ch.id,
                    description: ch.type === 'dm' ? 'Direct message' : ch.type === 'group' ? 'Group' : 'Channel'
                }));
        }

        // User and special mentions
        const users = this.userManager.getAllUsers();
        const currentUser = this.userManager.getCurrentUser();

        // Special mentions
        const specialMentions: MentionSuggestion[] = [
            { vaultName: 'everyone', color: '#ef4444', isSpecial: true, type: 'special', description: 'Notify all users' }
        ];

        // Filter special mentions by query
        const filteredSpecial = specialMentions.filter(s =>
            s.vaultName.toLowerCase().includes(query)
        );

        // Filter users by query (excluding current user)
        const filteredUsers: MentionSuggestion[] = users
            .filter(user => {
                if (currentUser && user.vaultName === currentUser.vaultName) {
                    return false;
                }
                return user.vaultName.toLowerCase().includes(query);
            })
            .map(user => ({
                vaultName: user.vaultName,
                color: user.color,
                os: user.os,
                type: 'user' as const
            }));

        return [...filteredSpecial, ...filteredUsers];
    }

    renderSuggestion(suggestion: MentionSuggestion, el: HTMLElement): void {
        const container = el.createEl('div', { cls: 'collab-suggestion' });

        if (suggestion.type === 'channel') {
            container.createEl('span', {
                text: '#',
                cls: 'collab-channel-icon'
            });
            container.createEl('span', {
                text: suggestion.vaultName,
                cls: 'collab-suggestion-name'
            });
            if (suggestion.description) {
                container.createEl('span', {
                    text: suggestion.description,
                    cls: 'collab-suggestion-os'
                });
            }
        } else {
            const colorDot = container.createEl('span', { cls: 'collab-user-dot' });
            colorDot.setCssProps({ '--user-dot-color': suggestion.color || '#7c3aed' });

            container.createEl('span', {
                text: `@${suggestion.vaultName}`,
                cls: 'collab-suggestion-name'
            });

            if (suggestion.isSpecial && suggestion.description) {
                container.createEl('span', {
                    text: suggestion.description,
                    cls: 'collab-suggestion-os'
                });
            } else if (suggestion.os) {
                container.createEl('span', {
                    text: suggestion.os,
                    cls: 'collab-suggestion-os'
                });
            }
        }
    }

    selectSuggestion(suggestion: MentionSuggestion, evt: MouseEvent | KeyboardEvent): void {
        if (!this.context) return;

        const editor = this.context.editor;
        const start = this.context.start;
        const end = this.context.end;

        if (suggestion.type === 'channel') {
            editor.replaceRange(`@#${suggestion.vaultName} `, start, end);
        } else {
            editor.replaceRange(`@${suggestion.vaultName} `, start, end);
        }
    }
}

/**
 * Settings tab for the plugin
 */
class CollabMentionsSettingTab extends PluginSettingTab {
    plugin: CollabMentionsPlugin;

    constructor(app: App, plugin: CollabMentionsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl).setName('Registration').setHeading();

        // User info
        const currentUser = this.plugin.userManager.getCurrentUser();
        const isAdmin = this.plugin.userManager.isCurrentUserAdmin();

        if (currentUser) {
            const userInfoEl = containerEl.createEl('div', { cls: 'collab-settings-user-info' });
            const userNameEl = userInfoEl.createEl('p');
            userNameEl.createEl('span', { text: `Registered as: @${currentUser.vaultName}` });
            if (isAdmin) {
                const isPrimary = this.plugin.userManager.isCurrentUserPrimaryAdmin();
                userNameEl.createEl('span', {
                    text: isPrimary ? ' (Primary admin)' : ' (Secondary admin)',
                    cls: isPrimary ? 'collab-admin-badge collab-primary-admin' : 'collab-admin-badge'
                });
            }
            if (currentUser.registrationNumber) {
                userNameEl.createEl('span', {
                    text: ` #${currentUser.registrationNumber}`,
                    cls: 'collab-registration-number'
                });
            }
            userInfoEl.createEl('p', {
                text: `Machine: ${currentUser.localIdentifier}`,
                cls: 'setting-item-description'
            });
        } else {
            const registerBtn = containerEl.createEl('button', {
                text: 'Register now',
                cls: 'mod-cta'
            });
            registerBtn.addEventListener('click', () => {
                new RegisterModal(
                    this.app,
                    this.plugin.userManager,
                    () => this.display()
                ).open();
            });
        }

        new Setting(containerEl).setName('Real-time monitoring').setHeading();

        new Setting(containerEl)
            .setName('Enable file watcher')
            .setDesc('Monitor for changes in real-time (checks every 3 seconds)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFileWatcher)
                .onChange(async (value) => {
                    this.plugin.settings.enableFileWatcher = value;
                    await this.plugin.saveSettings();
                    this.plugin.restartFileWatcher();
                })
            );

        new Setting(containerEl).setName('Notifications').setHeading();

        new Setting(containerEl)
            .setName('Enable notifications')
            .setDesc('Show notifications for new mentions when opening the vault')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.enableNotifications = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Notification sound')
            .setDesc('Play a sound when you have new mentions')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.notificationSound)
                .onChange(async (value) => {
                    this.plugin.settings.notificationSound = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl).setName('Auto-cleanup').setHeading();

        new Setting(containerEl)
            .setName('Enable auto-cleanup')
            .setDesc('Automatically limit mentions per user to prevent file bloat')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoCleanup)
                .onChange(async (value) => {
                    this.plugin.settings.autoCleanup = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Max mentions per user')
            .setDesc('Keep only this many recent mentions per user (unread always kept)')
            .addSlider(slider => slider
                .setLimits(10, 100, 5)
                .setValue(this.plugin.settings.maxMentionsPerUser)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxMentionsPerUser = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Cleanup interval')
            .setDesc('How often to run auto-cleanup (hours)')
            .addSlider(slider => slider
                .setLimits(1, 168, 1)
                .setValue(this.plugin.settings.cleanupIntervalHours)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.cleanupIntervalHours = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl).setName('Appearance').setHeading();

        new Setting(containerEl)
            .setName('Highlight mentions')
            .setDesc('Visually highlight @mentions in the editor')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showMentionHighlights)
                .onChange(async (value) => {
                    this.plugin.settings.showMentionHighlights = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Mention highlight color')
            .setDesc('Color used to highlight @mentions')
            .addText(text => text
                .setPlaceholder('#7c3aed')
                .setValue(this.plugin.settings.mentionColor)
                .onChange(async (value) => {
                    this.plugin.settings.mentionColor = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl).setName('Maintenance').setHeading();

        // Cleanup scope selector
        let cleanupScope: 'my-received' | 'my-sent' | 'all' = 'my-received';
        let cleanupDays = 30;

        new Setting(containerEl)
            .setName('Cleanup scope')
            .setDesc('Choose which mentions to clean up' + (isAdmin ? '' : ' (Admin-only options hidden)'))
            .addDropdown(dropdown => {
                dropdown
                    .addOption('my-received', 'My received mentions (inbox)')
                    .addOption('my-sent', 'My sent mentions');
                // Only admins can clean up everyone's mentions
                if (isAdmin) {
                    dropdown.addOption('all', 'All mentions (everyone) [admin]');
                }
                dropdown
                    .setValue(cleanupScope)
                    .onChange((value) => {
                        cleanupScope = value as 'my-received' | 'my-sent' | 'all';
                    });
            });

        new Setting(containerEl)
            .setName('Cleanup age')
            .setDesc('Only remove read mentions older than X days (0 = all read mentions)')
            .addSlider(slider => slider
                .setLimits(0, 90, 1)
                .setValue(cleanupDays)
                .setDynamicTooltip()
                .onChange((value) => {
                    cleanupDays = value;
                })
            );

        new Setting(containerEl)
            .setName('Run cleanup')
            .setDesc('Remove read mentions based on scope and age settings above')
            .addButton(btn => btn
                .setButtonText('Clean up')
                .onClick(async () => {
                    const currentUser = this.plugin.userManager.getCurrentUser();
                    if (!currentUser && cleanupScope !== 'all') {
                        new Notice('You must be registered to clean up your mentions');
                        return;
                    }

                    const targetUser = currentUser?.vaultName || '';
                    const scopeLabel = cleanupScope === 'my-received' ? 'received' :
                                       cleanupScope === 'my-sent' ? 'sent' : 'all';

                    const removed = await this.plugin.mentionParser.cleanupMentionsScoped(
                        cleanupScope,
                        targetUser,
                        cleanupDays
                    );

                    new Notice(`Removed ${removed} ${scopeLabel} mentions`);
                    this.plugin.refreshPanel();
                })
            );

        // Force auto-cleanup - admin only since it affects everyone
        if (isAdmin) {
            new Setting(containerEl)
                .setName('Force auto-cleanup now')
                .setDesc('Run auto-cleanup immediately for all users, keeping the last configured number per user.')
                .addButton(btn => btn
                    .setButtonText('Run auto-cleanup')
                    .onClick(async () => {
                        const removed = await this.plugin.mentionParser.autoCleanupMentions(
                            this.plugin.settings.maxMentionsPerUser,
                            0 // Force run by setting interval to 0
                        );
                        new Notice(`Auto-cleanup: removed ${removed} mentions`);
                        this.plugin.refreshPanel();
                    })
                );
        }

        new Setting(containerEl)
            .setName('Manage team members')
            .setDesc('View and manage registered users')
            .addButton(btn => btn
                .setButtonText('Manage')
                .onClick(() => {
                    new UserManagementModal(
                        this.app,
                        this.plugin.userManager,
                        () => this.display()
                    ).open();
                })
            );
    }
}