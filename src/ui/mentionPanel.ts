import { App, ItemView, WorkspaceLeaf, TFile, MarkdownView, FuzzySuggestModal, Notice, Modal, Setting } from 'obsidian';
import { Mention, UserStatus, ManualStatus, ChatMessage, ChatImage, ChatReaction, Channel, GENERAL_CHANNEL_ID, Reminder, ReminderPriority } from '../types';
import { MentionParser } from '../mentionParser';
import { UserManager } from '../userManager';
import { ChatManager } from '../chatManager';
import { ReminderManager } from '../reminderManager';

export const MENTION_PANEL_VIEW_TYPE = 'collab-mentions-panel';

export class MentionPanelView extends ItemView {
    private mentionParser: MentionParser;
    private userManager: UserManager;
    private chatManager: ChatManager;
    private reminderManager: ReminderManager;
    private onBadgeUpdate?: () => void;  // Callback to update ribbon badge
    private chatContainer: HTMLElement | null = null;
    private pendingImages: ChatImage[] = [];  // Images to attach to next message
    private activeTab: 'inbox' | 'sent' | 'team' | 'chat' | 'reminders' = 'inbox';  // Track active tab
    private channelListCollapsed: boolean = false;  // Track channel list collapsed state
    private isRefreshing: boolean = false;  // Prevent re-renders while refreshing
    private messagesContainer: HTMLElement | null = null;  // Reference for smart updates
    private messagesWrapper: HTMLElement | null = null;  // Reference for messages wrapper (includes jump button)
    private lastInputValue: string = '';  // Preserve input during refresh
    private replyingTo: ChatMessage | null = null;  // Message being replied to
    private inboxFilter: 'all' | 'unread' | 'read' = 'all';  // Inbox filter state
    private chatSearchQuery: string = '';  // Current search query for chat
    private chatSearchResults: Array<ChatMessage & { channelId: string; channelName: string }> = [];  // Search results

    constructor(
        leaf: WorkspaceLeaf,
        mentionParser: MentionParser,
        userManager: UserManager,
        chatManager: ChatManager,
        reminderManager: ReminderManager,
        onBadgeUpdate?: () => void
    ) {
        super(leaf);
        this.mentionParser = mentionParser;
        this.userManager = userManager;
        this.chatManager = chatManager;
        this.reminderManager = reminderManager;
        this.onBadgeUpdate = onBadgeUpdate;
    }

    getViewType(): string {
        return MENTION_PANEL_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Mentions';
    }

    getIcon(): string {
        return 'at-sign';
    }

    async onOpen(): Promise<void> {
        await this.render();
    }

    /**
     * Public method to switch to a specific tab
     */
    switchToTab(tab: 'inbox' | 'sent' | 'team' | 'chat' | 'reminders'): void {
        this.activeTab = tab;
        this.render();
    }

    /**
     * Public method to switch to a specific channel (also switches to chat tab)
     */
    switchToChannel(channelId: string): void {
        this.chatManager.setActiveChannel(channelId);
        this.activeTab = 'chat';
        this.render();
    }

    async render(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();

        container.addClass('collab-mentions-panel');

        const currentUser = this.userManager.getCurrentUser();

        if (!currentUser) {
            container.createEl('div', {
                text: 'Please register to use mentions.',
                cls: 'collab-panel-notice'
            });
            return;
        }

        // Header
        const headerEl = container.createEl('div', { cls: 'collab-panel-header' });
        headerEl.createEl('h4', { text: `@${currentUser.vaultName}` });

        // Tab buttons
        const tabsEl = container.createEl('div', { cls: 'collab-tabs' });

        const inboxTab = tabsEl.createEl('button', {
            text: 'Inbox',
            cls: 'collab-tab active'
        });

        const sentTab = tabsEl.createEl('button', {
            text: 'Sent',
            cls: 'collab-tab'
        });

        const teamTab = tabsEl.createEl('button', {
            text: 'Team',
            cls: 'collab-tab'
        });

        const chatTab = tabsEl.createEl('button', {
            text: 'Chat',
            cls: 'collab-tab'
        });

        const remindersTab = tabsEl.createEl('button', {
            text: 'Reminders',
            cls: 'collab-tab'
        });

        // Content area
        const contentEl = container.createEl('div', { cls: 'collab-panel-content' });

        const setActiveTab = (active: HTMLElement, tabName: 'inbox' | 'sent' | 'team' | 'chat' | 'reminders') => {
            inboxTab.removeClass('active');
            sentTab.removeClass('active');
            teamTab.removeClass('active');
            chatTab.removeClass('active');
            remindersTab.removeClass('active');
            active.addClass('active');
            this.activeTab = tabName;  // Remember active tab
        };

        // Tab switching
        inboxTab.addEventListener('click', () => {
            setActiveTab(inboxTab, 'inbox');
            this.renderInbox(contentEl);
        });

        sentTab.addEventListener('click', () => {
            setActiveTab(sentTab, 'sent');
            this.renderSent(contentEl);
        });

        teamTab.addEventListener('click', async () => {
            setActiveTab(teamTab, 'team');
            await this.renderTeam(contentEl);
        });

        chatTab.addEventListener('click', async () => {
            setActiveTab(chatTab, 'chat');
            await this.renderChat(contentEl);
        });

        remindersTab.addEventListener('click', async () => {
            setActiveTab(remindersTab, 'reminders');
            await this.renderReminders(contentEl);
        });

        // Initial render - restore to previously active tab
        switch (this.activeTab) {
            case 'sent':
                setActiveTab(sentTab, 'sent');
                this.renderSent(contentEl);
                break;
            case 'team':
                setActiveTab(teamTab, 'team');
                this.renderTeam(contentEl);
                break;
            case 'chat':
                setActiveTab(chatTab, 'chat');
                this.renderChat(contentEl);
                break;
            case 'reminders':
                setActiveTab(remindersTab, 'reminders');
                this.renderReminders(contentEl);
                break;
            case 'inbox':
            default:
                setActiveTab(inboxTab, 'inbox');
                this.renderInbox(contentEl);
                break;
        }
    }

    private async renderInbox(container: HTMLElement): Promise<void> {
        container.empty();
        container.removeClass('collab-chat-container');  // Remove chat-specific layout

        const allMentions = this.mentionParser.getAllMentionsForCurrentUser();
        const unreadCount = allMentions.filter(m => !m.read).length;
        const readCount = allMentions.filter(m => m.read).length;

        // Header with filter and refresh
        const headerRow = container.createEl('div', { cls: 'collab-inbox-header' });

        // Filter dropdown
        const filterWrapper = headerRow.createEl('div', { cls: 'collab-inbox-filter-wrapper' });
        filterWrapper.createEl('span', { text: 'Show: ', cls: 'collab-inbox-filter-label' });

        const filterSelect = filterWrapper.createEl('select', { cls: 'collab-inbox-filter-select' });
        const allOption = filterSelect.createEl('option', { text: `All (${allMentions.length})`, attr: { value: 'all' } });
        const unreadOption = filterSelect.createEl('option', { text: `Unread (${unreadCount})`, attr: { value: 'unread' } });
        const readOption = filterSelect.createEl('option', { text: `Read (${readCount})`, attr: { value: 'read' } });

        filterSelect.value = this.inboxFilter;
        filterSelect.addEventListener('change', () => {
            this.inboxFilter = filterSelect.value as 'all' | 'unread' | 'read';
            this.renderInbox(container);
        });

        // Right side buttons
        const actionWrapper = headerRow.createEl('div', { cls: 'collab-inbox-actions' });

        // Refresh button
        const refreshBtn = actionWrapper.createEl('button', {
            text: '🔄',
            cls: 'collab-btn-small collab-refresh-btn',
            attr: { title: 'Refresh' }
        });
        refreshBtn.addEventListener('click', async () => {
            await this.mentionParser.loadMentions();
            this.renderInbox(container);
            new Notice('Inbox refreshed');
        });

        // Mark all as read button - only show if there are unread messages
        if (unreadCount > 0) {
            const markAllBtn = actionWrapper.createEl('button', {
                text: 'Mark all read',
                cls: 'collab-btn-small'
            });
            markAllBtn.addEventListener('click', async () => {
                await this.mentionParser.markAllAsRead();
                this.renderInbox(container);
            });
        }

        // Unread count badge
        if (unreadCount > 0) {
            const badge = container.createEl('div', { cls: 'collab-unread-badge' });
            badge.createEl('span', { text: `${unreadCount} unread mention${unreadCount !== 1 ? 's' : ''}` });
        }

        // Filter mentions
        let filteredMentions = allMentions;
        if (this.inboxFilter === 'unread') {
            filteredMentions = allMentions.filter(m => !m.read);
        } else if (this.inboxFilter === 'read') {
            filteredMentions = allMentions.filter(m => m.read);
        }

        if (filteredMentions.length === 0) {
            const emptyText = this.inboxFilter === 'unread'
                ? 'No unread mentions.'
                : this.inboxFilter === 'read'
                    ? 'No read mentions.'
                    : 'No mentions yet.';
            container.createEl('div', {
                text: emptyText,
                cls: 'collab-empty-state'
            });
            return;
        }

        for (const mention of filteredMentions) {
            this.renderMentionItem(container, mention, 'inbox');
        }
    }

    private async renderSent(container: HTMLElement): Promise<void> {
        container.empty();
        container.removeClass('collab-chat-container');  // Remove chat-specific layout

        // Header with refresh
        const headerRow = container.createEl('div', { cls: 'collab-inbox-header' });
        headerRow.createEl('span', { text: 'Sent Mentions', cls: 'collab-inbox-title' });

        const refreshBtn = headerRow.createEl('button', {
            text: '🔄',
            cls: 'collab-btn-small collab-refresh-btn',
            attr: { title: 'Refresh' }
        });
        refreshBtn.addEventListener('click', async () => {
            await this.mentionParser.loadMentions();
            this.renderSent(container);
            new Notice('Sent refreshed');
        });

        const mentions = this.mentionParser.getMentionsFromCurrentUser();

        if (mentions.length === 0) {
            container.createEl('div', {
                text: 'You haven\'t mentioned anyone yet.',
                cls: 'collab-empty-state'
            });
            return;
        }

        for (const mention of mentions) {
            this.renderMentionItem(container, mention, 'sent');
        }
    }

    private async renderTeam(container: HTMLElement): Promise<void> {
        container.empty();
        container.removeClass('collab-chat-container');  // Remove chat-specific layout

        // Header with refresh
        const headerRow = container.createEl('div', { cls: 'collab-inbox-header' });
        headerRow.createEl('span', { text: 'Team Members', cls: 'collab-inbox-title' });

        const refreshBtn = headerRow.createEl('button', {
            text: '🔄',
            cls: 'collab-btn-small collab-refresh-btn',
            attr: { title: 'Refresh' }
        });
        refreshBtn.addEventListener('click', async () => {
            await this.userManager.loadPresence();
            await this.userManager.loadUsers();
            this.renderTeam(container);
            new Notice('Team refreshed');
        });

        // Reload presence data to get latest status
        await this.userManager.loadPresence();

        const usersWithStatus = this.userManager.getAllUsersWithStatus();
        const currentUser = this.userManager.getCurrentUser();

        // Status selector for current user
        if (currentUser) {
            const statusSection = container.createEl('div', { cls: 'collab-status-selector-section' });

            const statusLabel = statusSection.createEl('span', {
                text: 'Your Status:',
                cls: 'collab-status-selector-label'
            });

            const statusSelect = statusSection.createEl('select', { cls: 'collab-status-selector' });

            const currentManualStatus = this.userManager.getCurrentUserManualStatus();

            const statusOptions: { value: ManualStatus; label: string }[] = [
                { value: 'auto', label: '🤖 Automatic' },
                { value: 'active', label: '🟢 Active' },
                { value: 'snooze', label: '🟡 Snooze' },
                { value: 'offline', label: '⚫ Appear Offline' }
            ];

            for (const opt of statusOptions) {
                const option = statusSelect.createEl('option', {
                    value: opt.value,
                    text: opt.label
                });
                if (opt.value === currentManualStatus) {
                    option.selected = true;
                }
            }

            statusSelect.addEventListener('change', async () => {
                await this.userManager.setManualStatus(statusSelect.value as ManualStatus);
                this.renderTeam(container);
            });
        }

        if (usersWithStatus.length === 0) {
            container.createEl('div', {
                text: 'No team members registered yet.',
                cls: 'collab-empty-state'
            });
            return;
        }

        // Sort: active first, then snooze, then offline
        const statusOrder: Record<UserStatus, number> = { active: 0, snooze: 1, offline: 2 };
        usersWithStatus.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

        // Group by status
        const active = usersWithStatus.filter(u => u.status === 'active');
        const snooze = usersWithStatus.filter(u => u.status === 'snooze');
        const offline = usersWithStatus.filter(u => u.status === 'offline');

        if (active.length > 0) {
            container.createEl('div', { text: `Active (${active.length})`, cls: 'collab-team-section-header' });
            for (const user of active) {
                this.renderTeamMember(container, user, currentUser?.vaultName === user.vaultName);
            }
        }

        if (snooze.length > 0) {
            container.createEl('div', { text: `Snooze (${snooze.length})`, cls: 'collab-team-section-header' });
            for (const user of snooze) {
                this.renderTeamMember(container, user, currentUser?.vaultName === user.vaultName);
            }
        }

        if (offline.length > 0) {
            container.createEl('div', { text: `Offline (${offline.length})`, cls: 'collab-team-section-header' });
            for (const user of offline) {
                this.renderTeamMember(container, user, currentUser?.vaultName === user.vaultName);
            }
        }
    }

    private async renderReminders(container: HTMLElement): Promise<void> {
        container.empty();
        container.removeClass('collab-chat-container');

        // Reload reminders
        await this.reminderManager.loadReminders();

        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return;

        // Header with add button
        const headerEl = container.createEl('div', { cls: 'collab-reminders-header' });
        headerEl.createEl('h3', { text: 'Reminders' });

        const addBtn = headerEl.createEl('button', {
            text: '+ New Reminder',
            cls: 'collab-reminder-add-btn'
        });
        addBtn.addEventListener('click', () => {
            new NewReminderModal(this.app, this.reminderManager, async () => {
                await this.renderReminders(container);
            }).open();
        });

        // Past due section
        const pastDue = this.reminderManager.getPastDueReminders();
        if (pastDue.length > 0) {
            container.createEl('div', { text: `⚠️ Overdue (${pastDue.length})`, cls: 'collab-reminder-section-header overdue' });
            for (const reminder of pastDue) {
                this.renderReminderItem(container, reminder, async () => {
                    await this.renderReminders(container);
                });
            }
        }

        // Upcoming section
        const upcoming = this.reminderManager.getUpcomingReminders();
        if (upcoming.length > 0) {
            container.createEl('div', { text: `Upcoming (${upcoming.length})`, cls: 'collab-reminder-section-header' });
            for (const reminder of upcoming) {
                this.renderReminderItem(container, reminder, async () => {
                    await this.renderReminders(container);
                });
            }
        }

        // Completed section (collapsed by default)
        const completed = this.reminderManager.getCompletedReminders();
        if (completed.length > 0) {
            const completedHeader = container.createEl('div', {
                text: `✓ Completed (${completed.length})`,
                cls: 'collab-reminder-section-header completed collapsible'
            });
            const completedContainer = container.createEl('div', { cls: 'collab-reminder-completed-list collapsed' });

            completedHeader.addEventListener('click', () => {
                completedContainer.toggleClass('collapsed', !completedContainer.hasClass('collapsed'));
                completedHeader.toggleClass('expanded', !completedContainer.hasClass('collapsed'));
            });

            for (const reminder of completed.slice(0, 10)) {  // Show only last 10
                this.renderReminderItem(completedContainer, reminder, async () => {
                    await this.renderReminders(container);
                }, true);
            }
        }

        // Empty state
        if (pastDue.length === 0 && upcoming.length === 0 && completed.length === 0) {
            container.createEl('div', {
                text: 'No reminders yet. Create one to get started!',
                cls: 'collab-empty-state'
            });
        }
    }

    private renderReminderItem(
        container: HTMLElement,
        reminder: Reminder,
        onUpdate: () => void,
        isCompleted: boolean = false
    ): void {
        const isPastDue = !reminder.completed && new Date(reminder.dueDate) <= new Date();
        const priorityClass = reminder.priority !== 'normal' ? `priority-${reminder.priority}` : '';
        const globalClass = reminder.isGlobal ? 'global' : '';

        const itemEl = container.createEl('div', {
            cls: `collab-reminder-item ${isCompleted ? 'completed' : ''} ${isPastDue ? 'overdue' : ''} ${priorityClass} ${globalClass}`
        });

        // Checkbox
        const checkbox = itemEl.createEl('input', {
            cls: 'collab-reminder-checkbox',
            attr: { type: 'checkbox' }
        });
        checkbox.checked = reminder.completed;
        checkbox.addEventListener('change', async () => {
            if (!reminder.completed) {
                await this.reminderManager.completeReminder(reminder.id);
                new Notice('Reminder completed! ✓');
            }
            onUpdate();
        });

        // Content
        const contentEl = itemEl.createEl('div', { cls: 'collab-reminder-content' });

        // Message
        contentEl.createEl('div', {
            text: reminder.message,
            cls: 'collab-reminder-message'
        });

        // Due date
        const dueText = ReminderManager.formatDueDate(reminder.dueDate);
        const dueEl = contentEl.createEl('div', {
            text: dueText,
            cls: `collab-reminder-due ${isPastDue ? 'overdue' : ''}`
        });

        // Priority badge
        if (reminder.priority !== 'normal') {
            contentEl.createEl('span', {
                text: reminder.priority === 'high' ? '🔴 High' : '🔵 Low',
                cls: 'collab-reminder-priority'
            });
        }

        // Global badge
        if (reminder.isGlobal) {
            contentEl.createEl('span', {
                text: '🌐 Team',
                cls: 'collab-reminder-global-badge'
            });
        }

        // Actions
        const actionsEl = itemEl.createEl('div', { cls: 'collab-reminder-actions' });

        if (!isCompleted) {
            // Snooze button
            const snoozeBtn = actionsEl.createEl('button', {
                cls: 'collab-reminder-action-btn',
                attr: { title: 'Snooze' }
            });
            snoozeBtn.innerHTML = '⏰';
            snoozeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                new SnoozeModal(this.app, this.reminderManager, reminder.id, onUpdate).open();
            });

            // Edit button
            const editBtn = actionsEl.createEl('button', {
                cls: 'collab-reminder-action-btn',
                attr: { title: 'Edit' }
            });
            editBtn.innerHTML = '✏️';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                new EditReminderModal(this.app, this.reminderManager, reminder, onUpdate).open();
            });
        }

        // Delete button
        const deleteBtn = actionsEl.createEl('button', {
            cls: 'collab-reminder-action-btn',
            attr: { title: 'Delete' }
        });
        deleteBtn.innerHTML = '🗑️';
        deleteBtn.addEventListener('click', async (e: MouseEvent) => {
            e.stopPropagation();
            await this.reminderManager.deleteReminder(reminder.id);
            onUpdate();
        });
    }

    private renderTeamMember(
        container: HTMLElement,
        user: { vaultName: string; status: UserStatus; lastSeen?: string; os: string; color?: string },
        isCurrentUser: boolean
    ): void {
        const itemEl = container.createEl('div', { cls: 'collab-team-member' });

        // Status indicator dot
        const statusDot = itemEl.createEl('span', { cls: `collab-status-dot collab-status-${user.status}` });

        // User info
        const infoEl = itemEl.createEl('div', { cls: 'collab-team-info' });

        const nameEl = infoEl.createEl('div', { cls: 'collab-team-name' });
        nameEl.createEl('span', {
            text: `@${user.vaultName}`,
            cls: 'collab-username'
        });

        if (isCurrentUser) {
            nameEl.createEl('span', { text: ' (you)', cls: 'collab-you-tag' });
        }

        // Show admin badge
        const userInfo = this.userManager.getUserByName(user.vaultName);
        if (userInfo?.isAdmin) {
            nameEl.createEl('span', {
                text: userInfo.adminLevel === 'primary' ? ' 👑' : ' ⭐',
                cls: 'collab-admin-indicator',
                attr: { title: userInfo.adminLevel === 'primary' ? 'Primary Admin' : 'Admin' }
            });
        }

        // Status text with last seen time
        const statusText = this.getStatusText(user.status, user.lastSeen);
        infoEl.createEl('div', {
            text: statusText,
            cls: 'collab-team-status-text'
        });

        // Admin actions (for admins to manage other users)
        const currentUserIsAdmin = this.userManager.isCurrentUserAdmin();
        const targetIsPrimaryAdmin = userInfo?.adminLevel === 'primary';

        if (currentUserIsAdmin && !isCurrentUser && !targetIsPrimaryAdmin) {
            const actionsEl = itemEl.createEl('div', { cls: 'collab-team-member-actions' });

            const removeBtn = actionsEl.createEl('button', {
                text: '✕',
                cls: 'collab-team-remove-btn',
                attr: { title: `Remove @${user.vaultName} from team` }
            });

            removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const confirmed = confirm(`Are you sure you want to remove @${user.vaultName} from the team?`);
                if (confirmed) {
                    await this.userManager.removeUser(user.vaultName);
                    // Re-render the team tab
                    const teamContainer = container.parentElement;
                    if (teamContainer) {
                        await this.renderTeam(teamContainer);
                    }
                    new Notice(`@${user.vaultName} has been removed from the team`);
                }
            });
        }
    }

    private getStatusText(status: UserStatus, lastSeen?: string): string {
        if (status === 'active') {
            return 'Active now';
        } else if (status === 'snooze') {
            if (lastSeen) {
                return `Snoozing - last active ${this.formatDate(lastSeen)}`;
            }
            return 'Snoozing';
        } else {
            if (lastSeen) {
                return `Offline - last seen ${this.formatDate(lastSeen)}`;
            }
            return 'Offline';
        }
    }

    private async renderChat(container: HTMLElement): Promise<void> {
        container.empty();
        container.addClass('collab-chat-container');
        this.chatContainer = container;

        // Clean up any lingering reaction pickers
        document.querySelectorAll('.collab-reaction-picker').forEach(el => el.remove());

        // Reload chat to get latest data
        await this.chatManager.loadChat();

        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return;

        // Two-pane layout
        const channelListEl = container.createEl('div', { cls: 'collab-channel-list' });
        const messagePaneEl = container.createEl('div', { cls: 'collab-message-pane' });

        // Render channel list
        this.renderChannelList(channelListEl, currentUser.vaultName);

        // Render message pane for active channel
        await this.renderMessagePane(messagePaneEl, currentUser.vaultName);
    }

    private renderChannelList(container: HTMLElement, currentUser: string): void {
        // Apply collapsed class if needed
        if (this.channelListCollapsed) {
            container.addClass('collapsed');
        }

        // Header with collapse toggle and New button
        const headerEl = container.createEl('div', { cls: 'collab-channel-header' });

        // Collapse toggle button
        const collapseBtn = headerEl.createEl('button', {
            cls: 'collab-channel-collapse-btn',
            text: this.channelListCollapsed ? '»' : '«'
        });
        collapseBtn.setAttribute('title', this.channelListCollapsed ? 'Expand channels' : 'Collapse channels');
        collapseBtn.addEventListener('click', async () => {
            this.channelListCollapsed = !this.channelListCollapsed;
            if (this.chatContainer) {
                await this.renderChat(this.chatContainer);
            }
        });

        // Only show these when expanded
        if (!this.channelListCollapsed) {
            headerEl.createEl('span', { text: 'Channels', cls: 'collab-channel-header-text' });

            const newBtn = headerEl.createEl('button', {
                cls: 'collab-channel-new-btn',
                text: '+'
            });
            newBtn.setAttribute('title', 'New channel or DM');
            newBtn.addEventListener('click', () => this.showNewChannelModal());

            // Channel items
            const listEl = container.createEl('div', { cls: 'collab-channel-items' });

            const channels = this.chatManager.getChannelsForUser(currentUser);
            const sortedChannels = this.sortChannels(channels, currentUser);

            for (const channel of sortedChannels) {
                this.renderChannelItem(listEl, channel, currentUser);
            }
        }
    }

    private renderChannelItem(container: HTMLElement, channel: Channel, currentUser: string): void {
        const activeChannelId = this.chatManager.getActiveChannelId();
        const isActive = channel.id === activeChannelId;
        const isMuted = this.chatManager.isChannelMuted(channel.id);

        const itemEl = container.createEl('div', {
            cls: `collab-channel-item ${isActive ? 'active' : ''} ${isMuted ? 'muted' : ''}`
        });

        // Left side: icon + content
        const leftEl = itemEl.createEl('div', { cls: 'collab-channel-left' });

        // Icon
        const iconEl = leftEl.createEl('span', { cls: 'collab-channel-icon' });
        iconEl.setText(channel.type === 'dm' ? '@' : '#');

        // Content wrapper (name + preview)
        const contentEl = leftEl.createEl('div', { cls: 'collab-channel-content' });

        // Name row
        const nameRowEl = contentEl.createEl('div', { cls: 'collab-channel-name-row' });
        const nameEl = nameRowEl.createEl('span', { cls: 'collab-channel-name' });
        if (channel.type === 'dm') {
            const otherMembers = channel.members.filter(m => m !== currentUser);
            nameEl.setText(otherMembers.join(', ') || 'Empty DM');
        } else {
            nameEl.setText(channel.name);
        }

        // Mute indicator
        if (isMuted) {
            nameRowEl.createEl('span', { cls: 'collab-channel-muted-icon', text: '🔇' });
        }

        // @mention indicator (shows if channel was @#mentioned in unread messages)
        const hasChannelMention = this.chatManager.hasUnreadChannelMention(channel.id, currentUser);
        if (hasChannelMention) {
            nameRowEl.createEl('span', { cls: 'collab-channel-mention-icon', text: '@' });
        }

        // Last message preview
        const messages = this.chatManager.getMessages(channel.id);
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && !lastMsg.deleted) {
            const previewEl = contentEl.createEl('div', { cls: 'collab-channel-preview' });
            const previewText = lastMsg.from === 'system'
                ? lastMsg.message
                : `${lastMsg.from}: ${lastMsg.message}`;
            previewEl.setText(this.truncate(previewText, 30));
        }

        // Right side: unread badge
        const unreadCount = this.chatManager.getUnreadCount(channel.id, currentUser);
        if (unreadCount > 0 && !isMuted) {
            itemEl.createEl('span', {
                cls: 'collab-channel-unread',
                text: unreadCount > 99 ? '99+' : String(unreadCount)
            });
        }

        // Click to switch channel
        itemEl.addEventListener('click', async () => {
            this.chatManager.setActiveChannel(channel.id);
            if (this.chatContainer) {
                await this.renderChat(this.chatContainer);
            }
        });
    }

    private sortChannels(channels: Channel[], currentUser: string): Channel[] {
        return [...channels].sort((a, b) => {
            // General always first
            if (a.id === GENERAL_CHANNEL_ID) return -1;
            if (b.id === GENERAL_CHANNEL_ID) return 1;

            // Groups before DMs
            if (a.type === 'group' && b.type === 'dm') return -1;
            if (a.type === 'dm' && b.type === 'group') return 1;

            // Sort by most recent message
            const aMessages = this.chatManager.getMessages(a.id);
            const bMessages = this.chatManager.getMessages(b.id);
            const aLastMsg = aMessages[aMessages.length - 1];
            const bLastMsg = bMessages[bMessages.length - 1];
            const aTime = aLastMsg ? new Date(aLastMsg.timestamp).getTime() : new Date(a.createdAt).getTime();
            const bTime = bLastMsg ? new Date(bLastMsg.timestamp).getTime() : new Date(b.createdAt).getTime();
            return bTime - aTime;
        });
    }

    private async renderMessagePane(container: HTMLElement, currentUser: string): Promise<void> {
        const activeChannelId = this.chatManager.getActiveChannelId();
        const channel = this.chatManager.getChannel(activeChannelId);

        if (!channel) {
            container.createEl('div', {
                text: 'Select a channel',
                cls: 'collab-empty-state'
            });
            return;
        }

        // Mark as read and update badge
        await this.chatManager.markAsRead(activeChannelId);
        if (this.onBadgeUpdate) {
            this.onBadgeUpdate();
        }

        // Channel header
        const headerEl = container.createEl('div', { cls: 'collab-message-header' });

        const titleEl = headerEl.createEl('h3', { cls: 'collab-message-title' });
        if (channel.type === 'dm') {
            const others = channel.members.filter(m => m !== currentUser);
            titleEl.setText(others.join(', ') || 'Empty DM');
        } else {
            titleEl.setText(channel.name);
        }

        // Search input
        const searchWrapper = headerEl.createEl('div', { cls: 'collab-chat-search-wrapper' });
        const searchInput = searchWrapper.createEl('input', {
            cls: 'collab-chat-search-input',
            attr: {
                type: 'text',
                placeholder: '🔍 Search messages...',
                value: this.chatSearchQuery
            }
        });

        if (this.chatSearchQuery) {
            const clearBtn = searchWrapper.createEl('button', {
                cls: 'collab-chat-search-clear',
                text: '✕'
            });
            clearBtn.addEventListener('click', () => {
                this.chatSearchQuery = '';
                this.chatSearchResults = [];
                if (this.chatContainer) {
                    this.renderChat(this.chatContainer);
                }
            });
        }

        let searchTimeout: number | null = null;
        searchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value;

            // Debounce search
            if (searchTimeout) {
                window.clearTimeout(searchTimeout);
            }
            searchTimeout = window.setTimeout(() => {
                this.chatSearchQuery = query;
                if (query.trim()) {
                    this.chatSearchResults = this.chatManager.searchMessages(query);
                } else {
                    this.chatSearchResults = [];
                }
                // Only update messages area, not the entire chat (preserves search input focus)
                this.updateMessagesForSearch();
            }, 300);
        });

        // Always add a header actions container for refresh button
        const headerActionsEl = headerEl.createEl('div', { cls: 'collab-message-header-actions' });

        // Refresh button (always visible)
        const refreshBtn = headerActionsEl.createEl('button', {
            cls: 'collab-header-btn collab-refresh-btn',
            text: '🔄',
            attr: { title: 'Refresh chat' }
        });
        refreshBtn.addEventListener('click', async () => {
            await this.chatManager.loadChat();
            if (this.chatContainer) {
                await this.renderChat(this.chatContainer);
            }
            new Notice('Chat refreshed');
        });

        // Channel actions (for non-general channels)
        if (channel.type !== 'general') {
            // Member count
            headerActionsEl.createEl('span', {
                cls: 'collab-message-members',
                text: `${channel.members.length} member${channel.members.length !== 1 ? 's' : ''}`
            });

            // Mute button
            const isMuted = this.chatManager.isChannelMuted(channel.id);
            const muteBtn = headerActionsEl.createEl('button', {
                cls: 'collab-header-btn collab-mute-btn',
                text: isMuted ? '🔇 Muted' : '🔔'
            });
            muteBtn.setAttribute('title', isMuted ? 'Unmute channel' : 'Mute notifications');
            muteBtn.addEventListener('click', async () => {
                await this.chatManager.toggleChannelMute(channel.id);
                if (this.chatContainer) {
                    await this.renderChat(this.chatContainer);
                }
            });

            // Add member button
            const addBtn = headerActionsEl.createEl('button', {
                cls: 'collab-header-btn',
                text: '+ Add'
            });
            addBtn.addEventListener('click', () => this.showAddMemberModal(channel));

            // Delete button (only for creator)
            if (this.chatManager.canDeleteChannel(channel.id, currentUser)) {
                const deleteBtn = headerActionsEl.createEl('button', {
                    cls: 'collab-header-btn collab-delete-btn',
                    text: 'Delete'
                });
                deleteBtn.addEventListener('click', () => {
                    const channelType = channel.type === 'dm' ? 'conversation' : 'channel';
                    new DeleteChannelModal(
                        this.app,
                        channelType,
                        // Export and delete
                        async () => {
                            const exportPath = await this.chatManager.exportChannel(channel.id);
                            if (exportPath) {
                                new Notice(`Chat exported to: ${exportPath}`);
                            }
                            await this.chatManager.deleteChannel(channel.id);
                            if (this.chatContainer) {
                                await this.renderChat(this.chatContainer);
                            }
                        },
                        // Delete only
                        async () => {
                            await this.chatManager.deleteChannel(channel.id);
                            if (this.chatContainer) {
                                await this.renderChat(this.chatContainer);
                            }
                        }
                    ).open();
                });
            }

            // Leave button
            const leaveBtn = headerActionsEl.createEl('button', {
                cls: 'collab-header-btn collab-leave-btn',
                text: 'Leave'
            });
            leaveBtn.addEventListener('click', () => {
                const channelType = channel.type === 'dm' ? 'conversation' : 'channel';
                const isLastMember = this.chatManager.isLastMember(channel.id, currentUser);

                if (isLastMember) {
                    // Last member leaving - show export option since channel will be deleted
                    new LeaveAsLastMemberModal(
                        this.app,
                        channelType,
                        // Export and leave (deletes channel)
                        async () => {
                            const exportPath = await this.chatManager.exportChannel(channel.id);
                            if (exportPath) {
                                new Notice(`Chat exported to: ${exportPath}`);
                            }
                            await this.chatManager.leaveChannel(channel.id, currentUser);
                            if (this.chatContainer) {
                                await this.renderChat(this.chatContainer);
                            }
                        },
                        // Leave without export (deletes channel)
                        async () => {
                            await this.chatManager.leaveChannel(channel.id, currentUser);
                            if (this.chatContainer) {
                                await this.renderChat(this.chatContainer);
                            }
                        }
                    ).open();
                } else {
                    // Not the last member - normal leave confirmation
                    new ConfirmActionModal(this.app, `Leave ${channelType}?`, `You will no longer see messages in this ${channelType}.`, async () => {
                        await this.chatManager.leaveChannel(channel.id, currentUser);
                        if (this.chatContainer) {
                            await this.renderChat(this.chatContainer);
                        }
                    }).open();
                }
            });
        }

        // Messages area wrapper (for jump to bottom button positioning)
        const messagesWrapper = container.createEl('div', { cls: 'collab-chat-messages-wrapper' });
        this.messagesWrapper = messagesWrapper;  // Store reference for search updates
        const messagesEl = messagesWrapper.createEl('div', { cls: 'collab-chat-messages' });
        this.messagesContainer = messagesEl;  // Store reference for smart updates

        // Check if we're displaying search results or regular messages
        if (this.chatSearchQuery && this.chatSearchResults.length > 0) {
            // Display search results
            const searchHeaderEl = messagesEl.createEl('div', { cls: 'collab-search-results-header' });
            searchHeaderEl.createEl('span', { text: `Found ${this.chatSearchResults.length} result${this.chatSearchResults.length !== 1 ? 's' : ''} for "${this.chatSearchQuery}"` });

            let lastDate: string | null = null;
            let lastChannelId: string | null = null;

            for (const msg of this.chatSearchResults) {
                // Add channel separator if channel changed
                if (msg.channelId !== lastChannelId) {
                    const channelSeparatorEl = messagesEl.createEl('div', { cls: 'collab-search-channel-separator' });
                    channelSeparatorEl.createEl('span', { text: `# ${msg.channelName}` });
                    channelSeparatorEl.addEventListener('click', () => {
                        // Navigate to the channel
                        this.chatManager.setActiveChannel(msg.channelId);
                        this.chatSearchQuery = '';
                        this.chatSearchResults = [];
                        if (this.chatContainer) {
                            this.renderChat(this.chatContainer);
                        }
                    });
                    lastChannelId = msg.channelId;
                    lastDate = null;  // Reset date when channel changes
                }

                // Add date separator if date changed
                const msgDate = this.getDateString(msg.timestamp);
                if (msgDate !== lastDate) {
                    const separatorEl = messagesEl.createEl('div', { cls: 'collab-date-separator' });
                    separatorEl.createEl('span', { text: msgDate });
                    lastDate = msgDate;
                }

                // Render message with click to navigate
                const msgEl = this.renderChatMessage(messagesEl, msg, currentUser === msg.from);
                if (msgEl) {
                    msgEl.addClass('collab-search-result-message');
                    msgEl.addEventListener('click', () => {
                        // Navigate to the message's channel
                        this.chatManager.setActiveChannel(msg.channelId);
                        this.chatSearchQuery = '';
                        this.chatSearchResults = [];
                        if (this.chatContainer) {
                            this.renderChat(this.chatContainer);
                        }
                    });
                }
            }
        } else if (this.chatSearchQuery && this.chatSearchResults.length === 0) {
            // No search results
            messagesEl.createEl('div', {
                text: `No messages found for "${this.chatSearchQuery}"`,
                cls: 'collab-empty-state'
            });
        } else {
            // Display regular channel messages
            const messages = this.chatManager.getMessages(activeChannelId);

            if (messages.length === 0) {
                messagesEl.createEl('div', {
                    text: 'No messages yet. Start the conversation!',
                    cls: 'collab-empty-state'
                });
            } else {
                let lastDate: string | null = null;

                for (const msg of messages) {
                    // Add date separator if date changed
                    const msgDate = this.getDateString(msg.timestamp);
                    if (msgDate !== lastDate) {
                        const separatorEl = messagesEl.createEl('div', { cls: 'collab-date-separator' });
                        separatorEl.createEl('span', { text: msgDate });
                        lastDate = msgDate;
                    }

                    this.renderChatMessage(messagesEl, msg, currentUser === msg.from);
                }
            }
        }

        // Jump to bottom button (hidden by default, shown when scrolled up)
        const jumpBtn = messagesWrapper.createEl('button', {
            cls: 'collab-jump-to-bottom',
            text: '↓ Jump to latest'
        });
        jumpBtn.style.display = 'none';

        // Show/hide jump button based on scroll position
        messagesEl.addEventListener('scroll', () => {
            const isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
            jumpBtn.style.display = isNearBottom ? 'none' : 'flex';
        });

        jumpBtn.addEventListener('click', () => {
            messagesEl.scrollTop = messagesEl.scrollHeight;
            jumpBtn.style.display = 'none';
        });

        // Scroll to bottom initially
        messagesEl.scrollTop = messagesEl.scrollHeight;

        // Image preview area
        const imagePreviewArea = container.createEl('div', { cls: 'collab-chat-image-preview' });
        this.updateImagePreview(imagePreviewArea);

        // Input area
        this.renderMessageInput(container, imagePreviewArea);
    }

    private inputAreaContainer: HTMLElement | null = null;  // Reference for updating input area
    private imagePreviewContainer: HTMLElement | null = null;  // Reference for image preview
    private typingIndicatorEl: HTMLElement | null = null;  // Reference for typing indicator
    private typingTimeout: number | null = null;  // Timeout for clearing typing status

    private renderMessageInput(container: HTMLElement, imagePreviewArea: HTMLElement): void {
        // Typing indicator
        const typingIndicator = container.createEl('div', { cls: 'collab-typing-indicator' });
        typingIndicator.style.display = 'none';
        this.typingIndicatorEl = typingIndicator;
        this.updateTypingIndicator();

        const inputArea = container.createEl('div', { cls: 'collab-chat-input-area' });
        this.inputAreaContainer = inputArea;
        this.imagePreviewContainer = imagePreviewArea;

        // Reply preview (if replying to a message)
        if (this.replyingTo) {
            const replyPreview = inputArea.createEl('div', { cls: 'collab-reply-preview' });
            const replyText = replyPreview.createEl('div', { cls: 'collab-reply-preview-text' });
            replyText.createEl('span', { text: `Replying to @${this.replyingTo.from}: `, cls: 'collab-reply-preview-from' });
            replyText.createEl('span', { text: this.truncate(this.replyingTo.message, 50) });

            const cancelReply = replyPreview.createEl('button', {
                cls: 'collab-reply-preview-cancel',
                text: '✕'
            });
            cancelReply.addEventListener('click', () => {
                this.replyingTo = null;
                this.updateInputArea();
            });
        }

        const inputWrapper = inputArea.createEl('div', { cls: 'collab-chat-input-wrapper' });

        const textInput = inputWrapper.createEl('textarea', {
            cls: 'collab-chat-input',
            attr: { placeholder: 'Type a message... Use @name to mention someone' }
        });

        // Handle paste for images
        textInput.addEventListener('paste', async (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    if (blob) {
                        const image = await this.chatManager.saveImageFromClipboard(blob);
                        if (image) {
                            this.pendingImages.push(image);
                            this.updateImagePreview(imagePreviewArea);
                            new Notice('Image added to message');
                        }
                    }
                    break;
                }
            }
        });

        // Button row
        const buttonRow = inputWrapper.createEl('div', { cls: 'collab-chat-buttons' });
        const leftButtons = buttonRow.createEl('div', { cls: 'collab-chat-buttons-left' });

        // File link button
        const fileLinkBtn = leftButtons.createEl('button', {
            cls: 'collab-chat-btn',
            attr: { title: 'Insert file link [[filename]]' }
        });
        fileLinkBtn.innerHTML = '📄';
        fileLinkBtn.addEventListener('click', () => {
            new FileLinkModal(this.app, (filePath) => {
                const linkText = `[[${filePath}]]`;
                const cursorPos = textInput.selectionStart;
                const before = textInput.value.substring(0, cursorPos);
                const after = textInput.value.substring(cursorPos);
                textInput.value = before + linkText + after;
                textInput.focus();
                textInput.selectionStart = textInput.selectionEnd = cursorPos + linkText.length;
            }).open();
        });

        // Image upload button
        const imageBtn = leftButtons.createEl('button', {
            cls: 'collab-chat-btn',
            attr: { title: 'Attach image (or paste from clipboard)' }
        });
        imageBtn.innerHTML = '🖼️';

        const imageInput = leftButtons.createEl('input', {
            attr: { type: 'file', accept: 'image/*', style: 'display: none' }
        });
        imageBtn.addEventListener('click', () => imageInput.click());
        imageInput.addEventListener('change', async () => {
            const file = imageInput.files?.[0];
            if (file) {
                const image = await this.chatManager.saveImage(file);
                if (image) {
                    this.pendingImages.push(image);
                    this.updateImagePreview(imagePreviewArea);
                    new Notice('Image added to message');
                }
            }
            imageInput.value = '';
        });

        // Mention button
        const mentionBtn = leftButtons.createEl('button', {
            cls: 'collab-chat-btn',
            attr: { title: 'Mention someone @name' }
        });
        mentionBtn.innerHTML = '@';
        mentionBtn.addEventListener('click', () => {
            new UserMentionModal(this.app, this.userManager, (username) => {
                const mentionText = `@${username} `;
                const cursorPos = textInput.selectionStart;
                const before = textInput.value.substring(0, cursorPos);
                const after = textInput.value.substring(cursorPos);
                textInput.value = before + mentionText + after;
                textInput.focus();
                textInput.selectionStart = textInput.selectionEnd = cursorPos + mentionText.length;
            }).open();
        });

        // Send button
        const sendBtn = buttonRow.createEl('button', {
            text: 'Send',
            cls: 'collab-chat-send-btn'
        });

        const sendMessage = async () => {
            const message = textInput.value.trim();
            if (!message && this.pendingImages.length === 0) return;

            // Clear typing status when sending
            await this.userManager.clearTyping();
            if (this.typingTimeout) {
                window.clearTimeout(this.typingTimeout);
                this.typingTimeout = null;
            }

            const fileLinks = ChatManager.extractFileLinks(message);

            await this.chatManager.sendMessage(
                message || '(image)',
                fileLinks.length > 0 ? fileLinks : undefined,
                this.pendingImages.length > 0 ? [...this.pendingImages] : undefined,
                undefined,  // channelId - use active channel
                this.replyingTo?.id  // replyTo
            );

            textInput.value = '';
            this.pendingImages = [];
            this.replyingTo = null;  // Clear reply state

            if (this.chatContainer) {
                await this.renderChat(this.chatContainer);
            }
        };

        sendBtn.addEventListener('click', sendMessage);

        // Track typing status
        textInput.addEventListener('input', async () => {
            const activeChannelId = this.chatManager.getActiveChannelId();

            // Set typing status
            await this.userManager.setTyping(activeChannelId);

            // Clear typing after 3 seconds of no input
            if (this.typingTimeout) {
                window.clearTimeout(this.typingTimeout);
            }
            this.typingTimeout = window.setTimeout(async () => {
                await this.userManager.clearTyping();
            }, 3000);
        });

        textInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                await sendMessage();
            }
        });
    }

    /**
     * Update the typing indicator to show who's typing
     */
    private updateTypingIndicator(): void {
        if (!this.typingIndicatorEl) return;

        const activeChannelId = this.chatManager.getActiveChannelId();
        const typingUsers = this.userManager.getTypingUsers(activeChannelId);

        if (typingUsers.length === 0) {
            this.typingIndicatorEl.style.display = 'none';
            return;
        }

        this.typingIndicatorEl.style.display = 'flex';

        let text: string;
        if (typingUsers.length === 1) {
            text = `${typingUsers[0]} is typing...`;
        } else if (typingUsers.length === 2) {
            text = `${typingUsers[0]} and ${typingUsers[1]} are typing...`;
        } else {
            text = `${typingUsers.length} people are typing...`;
        }

        this.typingIndicatorEl.innerHTML = `<span class="collab-typing-dots">•••</span> ${text}`;
    }

    private showNewChannelModal(): void {
        new NewChannelModal(this.app, this.userManager, this.chatManager, async (channel) => {
            this.chatManager.setActiveChannel(channel.id);
            if (this.chatContainer) {
                await this.renderChat(this.chatContainer);
            }
        }).open();
    }

    private showAddMemberModal(channel: Channel): void {
        new AddMemberModal(this.app, this.userManager, this.chatManager, channel, async () => {
            if (this.chatContainer) {
                await this.renderChat(this.chatContainer);
            }
        }).open();
    }

    private updateImagePreview(container: HTMLElement): void {
        container.empty();

        if (this.pendingImages.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';

        for (const img of this.pendingImages) {
            const previewItem = container.createEl('div', { cls: 'collab-image-preview-item' });

            const imgEl = previewItem.createEl('img', {
                cls: 'collab-image-preview-img',
                attr: { src: this.app.vault.adapter.getResourcePath(img.path) }
            });

            const removeBtn = previewItem.createEl('button', {
                cls: 'collab-image-preview-remove',
                text: '×'
            });
            removeBtn.addEventListener('click', () => {
                this.pendingImages = this.pendingImages.filter(i => i.id !== img.id);
                this.updateImagePreview(container);
            });
        }
    }

    private renderChatMessage(container: HTMLElement, msg: ChatMessage, isOwn: boolean): HTMLElement | null {
        const currentUser = this.userManager.getCurrentUser();
        const isMentioned = msg.mentions?.some(
            m => m.toLowerCase() === currentUser?.vaultName.toLowerCase()
        );

        // Handle deleted messages
        if (msg.deleted) {
            const msgEl = container.createEl('div', {
                cls: 'collab-chat-message deleted'
            });
            msgEl.createEl('div', {
                text: '🗑️ This message was deleted',
                cls: 'collab-chat-deleted-text'
            });
            return msgEl;
        }

        // Handle system messages
        if (msg.from === 'system') {
            const msgEl = container.createEl('div', {
                cls: 'collab-chat-message system'
            });

            // Create message content with clickable file links
            const contentEl = msgEl.createEl('span', { cls: 'collab-system-msg-content' });

            // Parse and render file links as clickable
            let messageText = msg.message;
            const fileLinkRegex = /\[\[([^\]]+)\]\]/g;
            let lastIndex = 0;
            let match;

            while ((match = fileLinkRegex.exec(msg.message)) !== null) {
                // Add text before the link
                if (match.index > lastIndex) {
                    contentEl.appendText(msg.message.slice(lastIndex, match.index));
                }
                // Add clickable file link
                const filePath = match[1];
                const linkEl = contentEl.createEl('a', {
                    text: match[0],
                    cls: 'collab-file-link',
                    attr: { href: '#' }
                });
                linkEl.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const file = this.app.vault.getAbstractFileByPath(filePath);
                    if (file instanceof TFile) {
                        await this.app.workspace.getLeaf().openFile(file);
                    }
                });
                lastIndex = match.index + match[0].length;
            }
            // Add remaining text
            if (lastIndex < msg.message.length) {
                contentEl.appendText(msg.message.slice(lastIndex));
            }

            return msgEl;
        }

        // Get user info for color
        const user = this.userManager.getUserByName(msg.from);
        const userColor = user?.color || '#7c3aed';  // Default purple if no color

        const msgEl = container.createEl('div', {
            cls: `collab-chat-message ${isOwn ? 'own' : 'other'} ${isMentioned ? 'mentioned' : ''}`,
            attr: { 'data-message-id': msg.id }
        });

        // Apply user color as left border/indicator
        msgEl.style.setProperty('--user-color', userColor);

        // Header with name (always show for clarity)
        const headerEl = msgEl.createEl('div', { cls: 'collab-chat-msg-header' });
        const nameEl = headerEl.createEl('span', {
            text: isOwn ? 'You' : `@${msg.from}`,
            cls: 'collab-chat-msg-from'
        });
        nameEl.style.color = userColor;

        // Replied-to message preview (if this is a reply)
        if (msg.replyTo) {
            const repliedMsg = this.chatManager.getMessageById(msg.replyTo);
            if (repliedMsg && !repliedMsg.deleted) {
                const replyRefEl = msgEl.createEl('div', { cls: 'collab-message-reply-ref' });
                const replyUser = this.userManager.getUserByName(repliedMsg.from);
                const replyColor = replyUser?.color || '#7c3aed';

                replyRefEl.style.setProperty('--reply-user-color', replyColor);

                replyRefEl.createEl('span', {
                    text: `↩ @${repliedMsg.from}: `,
                    cls: 'collab-reply-ref-from'
                });
                replyRefEl.createEl('span', {
                    text: this.truncate(repliedMsg.message, 40),
                    cls: 'collab-reply-ref-text'
                });

                // Click to scroll to original message
                replyRefEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.scrollToMessage(msg.replyTo!);
                });
            } else if (repliedMsg?.deleted) {
                const replyRefEl = msgEl.createEl('div', { cls: 'collab-message-reply-ref deleted' });
                replyRefEl.createEl('span', { text: '↩ Original message was deleted' });
            }
        }

        // Message content with file links, URLs, and @mentions
        const contentEl = msgEl.createEl('div', { cls: 'collab-chat-msg-content' });
        this.renderMessageContent(contentEl, msg.message, isOwn);

        // Show edited indicator
        if (msg.edited) {
            contentEl.createEl('span', {
                text: ' (edited)',
                cls: 'collab-chat-edited'
            });
        }

        // Render images if any
        if (msg.images && msg.images.length > 0) {
            const imagesEl = msgEl.createEl('div', { cls: 'collab-chat-images' });
            for (const img of msg.images) {
                const imgWrapper = imagesEl.createEl('div', { cls: 'collab-chat-image-wrapper' });
                const imgEl = imgWrapper.createEl('img', {
                    cls: 'collab-chat-image',
                    attr: { src: this.app.vault.adapter.getResourcePath(img.path) }
                });
                // Click to open full size
                imgEl.addEventListener('click', () => {
                    this.openImageModal(img.path);
                });
            }
        }

        // Reactions display
        if (msg.reactions && msg.reactions.length > 0) {
            const reactionsEl = msgEl.createEl('div', { cls: 'collab-chat-reactions' });
            for (const reaction of msg.reactions) {
                const reactionBtn = reactionsEl.createEl('button', {
                    cls: 'collab-chat-reaction-btn'
                });
                reactionBtn.createEl('span', { text: reaction.emoji });
                reactionBtn.createEl('span', {
                    text: reaction.users.length.toString(),
                    cls: 'collab-reaction-count'
                });

                // Highlight if current user reacted
                if (currentUser && reaction.users.includes(currentUser.vaultName)) {
                    reactionBtn.addClass('reacted');
                }

                // Tooltip showing who reacted
                reactionBtn.setAttribute('title', reaction.users.join(', '));

                // Click to toggle reaction
                reactionBtn.addEventListener('click', async () => {
                    await this.chatManager.toggleReaction(msg.id, reaction.emoji);
                    if (this.chatContainer) {
                        await this.renderChat(this.chatContainer);
                    }
                });
            }
        }

        // Footer with timestamp and actions
        const footerEl = msgEl.createEl('div', { cls: 'collab-chat-msg-footer' });

        // Timestamp
        footerEl.createEl('span', {
            text: this.formatDate(msg.timestamp),
            cls: 'collab-chat-msg-time'
        });

        // Action buttons (hover to show)
        const actionsEl = footerEl.createEl('div', { cls: 'collab-chat-msg-actions' });

        // Reply button (for all messages)
        const replyBtn = actionsEl.createEl('button', {
            cls: 'collab-chat-action-btn',
            attr: { title: 'Reply' }
        });
        replyBtn.innerHTML = '↩️';
        replyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.replyingTo = msg;
            this.updateInputArea();
            // Focus the input
            const inputEl = this.chatContainer?.querySelector('.collab-chat-input') as HTMLTextAreaElement;
            if (inputEl) inputEl.focus();
        });

        // Reaction button (for all messages)
        const addReactionBtn = actionsEl.createEl('button', {
            cls: 'collab-chat-action-btn',
            attr: { title: 'Add reaction' }
        });
        addReactionBtn.innerHTML = '😊';
        addReactionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showReactionPicker(msg.id, addReactionBtn);
        });

        // Edit and Delete buttons (only for own messages)
        if (isOwn) {
            const editBtn = actionsEl.createEl('button', {
                cls: 'collab-chat-action-btn',
                attr: { title: 'Edit message' }
            });
            editBtn.innerHTML = '✏️';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                new EditMessageModal(this.app, msg.message, async (newContent) => {
                    await this.chatManager.editMessage(msg.id, newContent);
                    if (this.chatContainer) {
                        await this.renderChat(this.chatContainer);
                    }
                }).open();
            });

            const deleteBtn = actionsEl.createEl('button', {
                cls: 'collab-chat-action-btn',
                attr: { title: 'Delete message' }
            });
            deleteBtn.innerHTML = '🗑️';
            deleteBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                new ConfirmDeleteModal(this.app, async () => {
                    await this.chatManager.deleteMessage(msg.id);
                    if (this.chatContainer) {
                        await this.renderChat(this.chatContainer);
                    }
                }).open();
            });
        }

        return msgEl;
    }

    private showReactionPicker(messageId: string, anchorEl: HTMLElement): void {
        // Create reaction picker popup
        const picker = document.createElement('div');
        picker.className = 'collab-reaction-picker';

        for (const emoji of ChatManager.QUICK_REACTIONS) {
            const btn = document.createElement('button');
            btn.className = 'collab-reaction-picker-btn';
            btn.textContent = emoji;
            btn.addEventListener('click', async () => {
                await this.chatManager.toggleReaction(messageId, emoji);
                picker.remove();
                if (this.chatContainer) {
                    await this.renderChat(this.chatContainer);
                }
            });
            picker.appendChild(btn);
        }

        // Add to DOM first to measure dimensions
        picker.style.position = 'fixed';
        picker.style.visibility = 'hidden';
        document.body.appendChild(picker);

        // Get dimensions
        const rect = anchorEl.getBoundingClientRect();
        const pickerRect = picker.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Calculate position - prefer above the button
        let top = rect.top - pickerRect.height - 8;
        let left = rect.left;

        // If it would go off the top, show below instead
        if (top < 8) {
            top = rect.bottom + 8;
        }

        // If it would go off the right edge, align to right side
        if (left + pickerRect.width > viewportWidth - 8) {
            left = viewportWidth - pickerRect.width - 8;
        }

        // If it would go off the left edge
        if (left < 8) {
            left = 8;
        }

        picker.style.left = `${left}px`;
        picker.style.top = `${top}px`;
        picker.style.visibility = 'visible';

        // Close picker when clicking outside
        const closeHandler = (e: MouseEvent) => {
            if (!picker.contains(e.target as Node)) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }

    private renderMessageContent(container: HTMLElement, message: string, isOwn: boolean): void {
        // Combined regex to match [[file]], @#channel, @mention, and URLs
        // Order matters: @#channel must be checked before @mention
        const combinedRegex = /(\[\[[^\]]+\]\])|(@#[\w-]+)|(@\w+)|(https?:\/\/[^\s<>\[\]]+)/g;

        let lastIndex = 0;
        let match;

        while ((match = combinedRegex.exec(message)) !== null) {
            // Add text before match
            if (match.index > lastIndex) {
                container.createEl('span', { text: message.substring(lastIndex, match.index) });
            }

            const matchedText = match[0];

            if (matchedText.startsWith('[[')) {
                // File link
                const filePath = matchedText.slice(2, -2);
                const link = container.createEl('a', {
                    text: `📄 ${filePath}`,
                    cls: 'collab-chat-file-link'
                });
                link.addEventListener('click', async (e) => {
                    e.preventDefault();
                    await this.openFile(filePath);
                });
            } else if (matchedText.startsWith('@#')) {
                // @#channel mention
                const channelName = matchedText.substring(2);
                const channelMentionEl = container.createEl('span', {
                    text: matchedText,
                    cls: 'collab-chat-channel-mention'
                });
                // Make clickable to navigate to channel
                channelMentionEl.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Find channel by name
                    const currentUser = this.userManager.getCurrentUser();
                    if (currentUser) {
                        const channels = this.chatManager.getChannelsForUser(currentUser.vaultName);
                        const channel = channels.find(ch => ch.name.toLowerCase() === channelName.toLowerCase());
                        if (channel) {
                            this.chatManager.setActiveChannel(channel.id);
                            if (this.chatContainer) {
                                await this.renderChat(this.chatContainer);
                            }
                        }
                    }
                });
            } else if (matchedText.startsWith('@')) {
                // @mention
                const username = matchedText.substring(1);
                const user = this.userManager.getUserByName(username);
                const mentionEl = container.createEl('span', {
                    text: matchedText,
                    cls: 'collab-chat-mention'
                });
                if (user?.color) {
                    mentionEl.style.setProperty('--mention-color', user.color);
                }
                // Highlight if it's the current user
                const currentUser = this.userManager.getCurrentUser();
                if (currentUser && username.toLowerCase() === currentUser.vaultName.toLowerCase()) {
                    mentionEl.addClass('collab-chat-mention-me');
                }
            } else if (matchedText.startsWith('http')) {
                // URL
                const link = container.createEl('a', {
                    text: this.truncateUrl(matchedText),
                    cls: 'collab-chat-url',
                    attr: { href: matchedText, target: '_blank', rel: 'noopener' }
                });
            }

            lastIndex = match.index + matchedText.length;
        }

        // Add remaining text
        if (lastIndex < message.length) {
            container.createEl('span', { text: message.substring(lastIndex) });
        }
    }

    private truncateUrl(url: string): string {
        if (url.length > 50) {
            return url.substring(0, 47) + '...';
        }
        return url;
    }

    private openImageModal(imagePath: string): void {
        const modal = document.createElement('div');
        modal.className = 'collab-image-modal';
        modal.innerHTML = `
            <div class="collab-image-modal-content">
                <img src="${this.app.vault.adapter.getResourcePath(imagePath)}" />
                <button class="collab-image-modal-close">×</button>
            </div>
        `;
        modal.addEventListener('click', (e) => {
            if (e.target === modal || (e.target as HTMLElement).classList.contains('collab-image-modal-close')) {
                modal.remove();
            }
        });
        document.body.appendChild(modal);
    }

    private async openFile(path: string): Promise<void> {
        // Try to find the file - could be full path or just filename
        let file = this.app.vault.getAbstractFileByPath(path);

        // If not found by exact path, search by name
        if (!file) {
            const files = this.app.vault.getFiles();
            file = files.find(f => f.path === path || f.name === path || f.basename === path) || null;
        }

        if (file && file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
        }
    }

    /**
     * Refresh only the chat messages without destroying input (called from outside)
     */
    async refreshChat(): Promise<void> {
        // If not on chat tab, just update badge
        if (this.activeTab !== 'chat') {
            return;
        }

        // Don't refresh if already refreshing
        if (this.isRefreshing) return;
        this.isRefreshing = true;

        try {
            // Save current input state
            const inputEl = this.chatContainer?.querySelector('.collab-chat-input') as HTMLTextAreaElement;
            const hadFocus = document.activeElement === inputEl;
            const inputValue = inputEl?.value || '';
            const selectionStart = inputEl?.selectionStart || 0;
            const selectionEnd = inputEl?.selectionEnd || 0;

            // Only update messages area if it exists
            if (this.messagesContainer) {
                await this.chatManager.loadChat();
                await this.refreshMessagesOnly();
            } else if (this.chatContainer) {
                // Full refresh if no messages container reference
                await this.renderChat(this.chatContainer);
            }

            // Update typing indicator
            this.updateTypingIndicator();

            // Restore input state
            const newInputEl = this.chatContainer?.querySelector('.collab-chat-input') as HTMLTextAreaElement;
            if (newInputEl && inputValue) {
                newInputEl.value = inputValue;
                if (hadFocus) {
                    newInputEl.focus();
                    newInputEl.setSelectionRange(selectionStart, selectionEnd);
                }
            }
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * Refresh only the messages area without touching input
     */
    private async refreshMessagesOnly(): Promise<void> {
        if (!this.messagesContainer) return;

        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return;

        const activeChannelId = this.chatManager.getActiveChannelId();
        const messages = this.chatManager.getMessages(activeChannelId);

        // Remember scroll position
        const wasNearBottom = this.messagesContainer.scrollHeight - this.messagesContainer.scrollTop - this.messagesContainer.clientHeight < 100;

        // Clear and re-render messages
        this.messagesContainer.empty();

        if (messages.length === 0) {
            this.messagesContainer.createEl('div', {
                text: 'No messages yet. Start the conversation!',
                cls: 'collab-empty-state'
            });
        } else {
            let lastDate: string | null = null;

            for (const msg of messages) {
                const msgDate = this.getDateString(msg.timestamp);
                if (msgDate !== lastDate) {
                    const separatorEl = this.messagesContainer.createEl('div', { cls: 'collab-date-separator' });
                    separatorEl.createEl('span', { text: msgDate });
                    lastDate = msgDate;
                }

                this.renderChatMessage(this.messagesContainer, msg, currentUser.vaultName === msg.from);
            }
        }

        // Scroll to bottom if was near bottom
        if (wasNearBottom) {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }

        // Update channel list unread counts
        const channelListEl = this.chatContainer?.querySelector('.collab-channel-items');
        if (channelListEl) {
            channelListEl.empty();
            const channels = this.chatManager.getChannelsForUser(currentUser.vaultName);
            const sortedChannels = this.sortChannels(channels, currentUser.vaultName);
            for (const channel of sortedChannels) {
                this.renderChannelItem(channelListEl as HTMLElement, channel, currentUser.vaultName);
            }
        }
    }

    /**
     * Update only the messages area for search results without re-rendering the entire chat
     * This preserves the search input focus
     */
    private updateMessagesForSearch(): void {
        if (!this.messagesContainer) return;

        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return;

        // Clear existing messages
        this.messagesContainer.empty();

        // Check if we're displaying search results or regular messages
        if (this.chatSearchQuery && this.chatSearchResults.length > 0) {
            // Display search results
            const searchHeaderEl = this.messagesContainer.createEl('div', { cls: 'collab-search-results-header' });
            searchHeaderEl.createEl('span', { text: `Found ${this.chatSearchResults.length} result${this.chatSearchResults.length !== 1 ? 's' : ''} for "${this.chatSearchQuery}"` });

            let lastDate: string | null = null;
            let lastChannelId: string | null = null;

            for (const msg of this.chatSearchResults) {
                // Add channel separator if channel changed
                if (msg.channelId !== lastChannelId) {
                    const channelSeparatorEl = this.messagesContainer.createEl('div', { cls: 'collab-search-channel-separator' });
                    channelSeparatorEl.createEl('span', { text: `# ${msg.channelName}` });
                    channelSeparatorEl.addEventListener('click', () => {
                        // Navigate to the channel
                        this.chatManager.setActiveChannel(msg.channelId);
                        this.chatSearchQuery = '';
                        this.chatSearchResults = [];
                        if (this.chatContainer) {
                            this.renderChat(this.chatContainer);
                        }
                    });
                    lastChannelId = msg.channelId;
                    lastDate = null;  // Reset date when channel changes
                }

                // Add date separator if date changed
                const msgDate = this.getDateString(msg.timestamp);
                if (msgDate !== lastDate) {
                    const separatorEl = this.messagesContainer.createEl('div', { cls: 'collab-date-separator' });
                    separatorEl.createEl('span', { text: msgDate });
                    lastDate = msgDate;
                }

                // Render message with click to navigate
                const msgEl = this.renderChatMessage(this.messagesContainer, msg, currentUser.vaultName === msg.from);
                if (msgEl) {
                    msgEl.addClass('collab-search-result-message');
                    msgEl.addEventListener('click', () => {
                        // Navigate to the message's channel
                        this.chatManager.setActiveChannel(msg.channelId);
                        this.chatSearchQuery = '';
                        this.chatSearchResults = [];
                        if (this.chatContainer) {
                            this.renderChat(this.chatContainer);
                        }
                    });
                }
            }
        } else if (this.chatSearchQuery && this.chatSearchResults.length === 0) {
            // No search results
            this.messagesContainer.createEl('div', {
                text: `No messages found for "${this.chatSearchQuery}"`,
                cls: 'collab-empty-state'
            });
        } else {
            // Display regular channel messages
            const activeChannelId = this.chatManager.getActiveChannelId();
            const messages = this.chatManager.getMessages(activeChannelId);

            if (messages.length === 0) {
                this.messagesContainer.createEl('div', {
                    text: 'No messages yet. Start the conversation!',
                    cls: 'collab-empty-state'
                });
            } else {
                let lastDate: string | null = null;

                for (const msg of messages) {
                    // Add date separator if date changed
                    const msgDate = this.getDateString(msg.timestamp);
                    if (msgDate !== lastDate) {
                        const separatorEl = this.messagesContainer.createEl('div', { cls: 'collab-date-separator' });
                        separatorEl.createEl('span', { text: msgDate });
                        lastDate = msgDate;
                    }

                    this.renderChatMessage(this.messagesContainer, msg, currentUser.vaultName === msg.from);
                }
            }

            // Scroll to bottom for regular messages
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
    }

    /**
     * Update only the input area (for reply state changes) without touching messages
     */
    private updateInputArea(): void {
        if (!this.inputAreaContainer || !this.imagePreviewContainer || !this.chatContainer) return;

        // Save current input state
        const oldInputEl = this.inputAreaContainer.querySelector('.collab-chat-input') as HTMLTextAreaElement;
        const hadFocus = document.activeElement === oldInputEl;
        const inputValue = oldInputEl?.value || '';
        const selectionStart = oldInputEl?.selectionStart || 0;
        const selectionEnd = oldInputEl?.selectionEnd || 0;

        // Remove old input area
        this.inputAreaContainer.remove();

        // Find the message pane to append to
        const messagePane = this.chatContainer.querySelector('.collab-message-pane');
        if (!messagePane) return;

        // Re-render input area
        this.renderMessageInput(messagePane as HTMLElement, this.imagePreviewContainer);

        // Restore input state
        const newInputEl = this.inputAreaContainer?.querySelector('.collab-chat-input') as HTMLTextAreaElement;
        if (newInputEl) {
            newInputEl.value = inputValue;
            if (hadFocus) {
                newInputEl.focus();
                newInputEl.setSelectionRange(selectionStart, selectionEnd);
            }
        }
    }

    /**
     * Scroll to a specific message by ID
     */
    private scrollToMessage(messageId: string): void {
        if (!this.messagesContainer) return;

        const msgEl = this.messagesContainer.querySelector(`[data-message-id="${messageId}"]`);
        if (msgEl) {
            msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Highlight briefly
            msgEl.addClass('collab-message-highlight');
            setTimeout(() => {
                msgEl.removeClass('collab-message-highlight');
            }, 1500);
        }
    }

    private renderMentionItem(
        container: HTMLElement,
        mention: Mention,
        type: 'inbox' | 'sent'
    ): void {
        const itemEl = container.createEl('div', {
            cls: `collab-mention-item ${mention.read ? '' : 'unread'}`
        });

        const headerEl = itemEl.createEl('div', { cls: 'collab-mention-header' });

        if (type === 'inbox') {
            headerEl.createEl('span', {
                text: `From @${mention.from}`,
                cls: 'collab-mention-from'
            });
        } else {
            headerEl.createEl('span', {
                text: `To @${mention.to}`,
                cls: 'collab-mention-to'
            });
        }

        headerEl.createEl('span', {
            text: this.formatDate(mention.timestamp),
            cls: 'collab-mention-date'
        });

        // Show read status for sent mentions
        if (type === 'sent') {
            const statusEl = headerEl.createEl('span', {
                cls: 'collab-mention-status'
            });
            if (mention.read && mention.readAt) {
                statusEl.setText(`✓ Read ${this.formatDate(mention.readAt)}`);
                statusEl.addClass('collab-status-read');
            } else {
                statusEl.setText('Unread');
                statusEl.addClass('collab-status-unread');
            }
        }

        // Context
        itemEl.createEl('div', {
            text: this.truncate(mention.context, 100),
            cls: 'collab-mention-context'
        });

        // File link
        const fileEl = itemEl.createEl('div', { cls: 'collab-mention-file' });
        const fileName = mention.file.split('/').pop() || mention.file;

        const link = fileEl.createEl('a', {
            text: `📄 ${fileName}:${mention.line + 1}`,
            cls: 'collab-file-link'
        });

        link.addEventListener('click', async (e) => {
            e.preventDefault();
            await this.openFileAtLine(mention.file, mention.line);
        });

        // Actions
        if (type === 'inbox' && !mention.read) {
            const actionsEl = itemEl.createEl('div', { cls: 'collab-mention-actions' });

            const markReadBtn = actionsEl.createEl('button', {
                text: '✓',
                cls: 'collab-btn-icon',
                attr: { title: 'Mark as read' }
            });

            markReadBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.mentionParser.markAsRead(mention.id);
                itemEl.removeClass('unread');
                markReadBtn.remove();
                if (this.onBadgeUpdate) {
                    this.onBadgeUpdate();
                }
            });
        }

        // Replies
        if (mention.replies && mention.replies.length > 0) {
            const repliesEl = itemEl.createEl('div', { cls: 'collab-replies' });
            repliesEl.createEl('span', {
                text: `💬 ${mention.replies.length} repl${mention.replies.length > 1 ? 'ies' : 'y'}`,
                cls: 'collab-replies-count'
            });
        }
    }

    private async openFileAtLine(path: string, line: number): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);

        if (file && file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);

            // Wait for the view to be ready
            setTimeout(() => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.editor) {
                    view.editor.setCursor({ line: line, ch: 0 });
                    view.editor.scrollIntoView(
                        { from: { line: line, ch: 0 }, to: { line: line, ch: 0 } },
                        true
                    );
                }
            }, 100);
        }
    }

    private getDateString(timestamp: string): string {
        const date = new Date(timestamp);
        const now = new Date();

        // Reset times to compare just dates
        const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayOnly = new Date(todayOnly);
        yesterdayOnly.setDate(yesterdayOnly.getDate() - 1);

        if (dateOnly.getTime() === todayOnly.getTime()) {
            return 'Today';
        } else if (dateOnly.getTime() === yesterdayOnly.getTime()) {
            return 'Yesterday';
        } else {
            // Format as "January 15, 2024"
            return date.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        }
    }

    private formatDate(timestamp: string): string {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) {
            return 'just now';
        } else if (minutes < 60) {
            return `${minutes}m`;
        } else if (hours < 24) {
            return `${hours}h`;
        } else if (days < 7) {
            return `${days}d`;
        } else {
            return date.toLocaleDateString();
        }
    }

    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    async onClose(): Promise<void> {
        // Cleanup if needed
    }
}

/**
 * Modal for selecting a file to link in chat
 */
class FileLinkModal extends FuzzySuggestModal<TFile> {
    private onSelect: (path: string) => void;

    constructor(app: App, onSelect: (path: string) => void) {
        super(app);
        this.onSelect = onSelect;
        this.setPlaceholder('Search for a file to link...');
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item.path);
    }
}

/**
 * Modal for selecting a user to mention in chat
 */
class UserMentionModal extends FuzzySuggestModal<{ vaultName: string; color?: string; isSpecial?: boolean; description?: string }> {
    private userManager: UserManager;
    private onSelect: (username: string) => void;

    constructor(app: App, userManager: UserManager, onSelect: (username: string) => void) {
        super(app);
        this.userManager = userManager;
        this.onSelect = onSelect;
        this.setPlaceholder('Search for a team member to mention...');
    }

    getItems(): { vaultName: string; color?: string; isSpecial?: boolean; description?: string }[] {
        const currentUser = this.userManager.getCurrentUser();
        const users = this.userManager.getAllUsers().filter(
            u => u.vaultName !== currentUser?.vaultName
        );

        // Add special mentions at the top
        const specialMentions: { vaultName: string; color?: string; isSpecial?: boolean; description?: string }[] = [
            { vaultName: 'everyone', color: '#ef4444', isSpecial: true, description: 'Notify all users' }
        ];

        return [...specialMentions, ...users];
    }

    getItemText(item: { vaultName: string; description?: string }): string {
        if (item.description) {
            return `@${item.vaultName} — ${item.description}`;
        }
        return `@${item.vaultName}`;
    }

    onChooseItem(item: { vaultName: string }, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item.vaultName);
    }
}

/**
 * Modal for editing a chat message
 */
class EditMessageModal extends Modal {
    private originalContent: string;
    private onSave: (newContent: string) => void;

    constructor(app: App, originalContent: string, onSave: (newContent: string) => void) {
        super(app);
        this.originalContent = originalContent;
        this.onSave = onSave;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-edit-message-modal');

        contentEl.createEl('h3', { text: 'Edit Message' });

        const textarea = contentEl.createEl('textarea', {
            cls: 'collab-edit-message-input',
            attr: { rows: '4' }
        });
        textarea.value = this.originalContent;

        const buttonRow = contentEl.createEl('div', { cls: 'collab-edit-message-buttons' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-edit-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = buttonRow.createEl('button', {
            text: 'Save',
            cls: 'collab-edit-save-btn'
        });
        saveBtn.addEventListener('click', () => {
            const newContent = textarea.value.trim();
            if (newContent && newContent !== this.originalContent) {
                this.onSave(newContent);
            }
            this.close();
        });

        // Focus textarea
        setTimeout(() => textarea.focus(), 10);
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for creating a new channel or DM
 */
class NewChannelModal extends Modal {
    private userManager: UserManager;
    private chatManager: ChatManager;
    private onCreated: (channel: Channel) => void;
    private activeTab: 'group' | 'dm' = 'group';

    constructor(app: App, userManager: UserManager, chatManager: ChatManager, onCreated: (channel: Channel) => void) {
        super(app);
        this.userManager = userManager;
        this.chatManager = chatManager;
        this.onCreated = onCreated;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-new-channel-modal');

        contentEl.createEl('h3', { text: 'New Conversation' });

        // Tabs
        const tabsEl = contentEl.createEl('div', { cls: 'collab-modal-tabs' });
        const groupTab = tabsEl.createEl('button', { text: 'Group Channel', cls: 'active' });
        const dmTab = tabsEl.createEl('button', { text: 'Direct Message' });

        const formEl = contentEl.createEl('div', { cls: 'collab-modal-form' });

        const renderGroupForm = () => {
            formEl.empty();
            this.activeTab = 'group';

            // Channel name
            formEl.createEl('label', { text: 'Channel Name' });
            const nameInput = formEl.createEl('input', {
                attr: { type: 'text', placeholder: 'e.g., project-alpha' }
            });

            // Member selection
            formEl.createEl('label', { text: 'Add Members' });
            const membersContainer = formEl.createEl('div', { cls: 'collab-member-select' });

            const currentUser = this.userManager.getCurrentUser();
            const allUsers = this.userManager.getAllUsers();
            const selectedMembers: string[] = currentUser ? [currentUser.vaultName] : [];

            for (const user of allUsers) {
                if (user.vaultName === currentUser?.vaultName) continue;

                const checkboxLabel = membersContainer.createEl('label', { cls: 'collab-member-checkbox' });
                const checkbox = checkboxLabel.createEl('input', { attr: { type: 'checkbox' } });
                checkboxLabel.createEl('span', { text: `@${user.vaultName}` });

                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        if (!selectedMembers.includes(user.vaultName)) {
                            selectedMembers.push(user.vaultName);
                        }
                    } else {
                        const idx = selectedMembers.indexOf(user.vaultName);
                        if (idx > -1) selectedMembers.splice(idx, 1);
                    }
                });
            }

            // Create button
            const createBtn = formEl.createEl('button', {
                text: 'Create Channel',
                cls: 'collab-create-btn'
            });
            createBtn.addEventListener('click', async () => {
                const name = nameInput.value.trim();
                if (!name) {
                    new Notice('Please enter a channel name');
                    return;
                }
                if (!currentUser) return;

                const channel = await this.chatManager.createGroupChannel(name, selectedMembers, currentUser.vaultName);
                this.close();
                this.onCreated(channel);
            });
        };

        const renderDMForm = () => {
            formEl.empty();
            this.activeTab = 'dm';

            formEl.createEl('label', { text: 'Select User' });
            const userSelect = formEl.createEl('select', { cls: 'collab-user-select' });

            const currentUser = this.userManager.getCurrentUser();
            const allUsers = this.userManager.getAllUsers();

            for (const user of allUsers) {
                if (user.vaultName === currentUser?.vaultName) continue;
                userSelect.createEl('option', { value: user.vaultName, text: `@${user.vaultName}` });
            }

            // Start DM button
            const startBtn = formEl.createEl('button', {
                text: 'Start Conversation',
                cls: 'collab-create-btn'
            });
            startBtn.addEventListener('click', async () => {
                const selectedUser = userSelect.value;
                if (!selectedUser || !currentUser) return;

                const channel = await this.chatManager.startDM(currentUser.vaultName, selectedUser);
                this.close();
                this.onCreated(channel);
            });
        };

        groupTab.addEventListener('click', () => {
            groupTab.addClass('active');
            dmTab.removeClass('active');
            renderGroupForm();
        });

        dmTab.addEventListener('click', () => {
            dmTab.addClass('active');
            groupTab.removeClass('active');
            renderDMForm();
        });

        renderGroupForm();
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for adding a member to a channel
 */
class AddMemberModal extends Modal {
    private userManager: UserManager;
    private chatManager: ChatManager;
    private channel: Channel;
    private onAdded: () => void;

    constructor(app: App, userManager: UserManager, chatManager: ChatManager, channel: Channel, onAdded: () => void) {
        super(app);
        this.userManager = userManager;
        this.chatManager = chatManager;
        this.channel = channel;
        this.onAdded = onAdded;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-add-member-modal');

        contentEl.createEl('h3', { text: 'Add Member' });

        // Current members
        contentEl.createEl('p', {
            text: `Current members: ${this.channel.members.join(', ')}`,
            cls: 'collab-current-members'
        });

        // DM conversion warning
        if (this.channel.type === 'dm') {
            contentEl.createEl('p', {
                text: 'Adding a member will convert this DM to a group channel.',
                cls: 'collab-warning-text'
            });
        }

        // User selection
        const currentUser = this.userManager.getCurrentUser();
        const allUsers = this.userManager.getAllUsers();
        const availableUsers = allUsers.filter(u => !this.channel.members.includes(u.vaultName));

        if (availableUsers.length === 0) {
            contentEl.createEl('p', { text: 'All team members are already in this channel.' });
            return;
        }

        contentEl.createEl('label', { text: 'Select User' });
        const userSelect = contentEl.createEl('select', { cls: 'collab-user-select' });

        for (const user of availableUsers) {
            userSelect.createEl('option', { value: user.vaultName, text: `@${user.vaultName}` });
        }

        // Add button
        const addBtn = contentEl.createEl('button', {
            text: 'Add Member',
            cls: 'collab-create-btn'
        });
        addBtn.addEventListener('click', async () => {
            const selectedUser = userSelect.value;
            if (!selectedUser || !currentUser) return;

            await this.chatManager.addMemberToChannel(this.channel.id, selectedUser, currentUser.vaultName);
            this.close();
            this.onAdded();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for confirming message deletion
 */
class ConfirmDeleteModal extends Modal {
    private onConfirm: () => void;

    constructor(app: App, onConfirm: () => void) {
        super(app);
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-confirm-modal');

        contentEl.createEl('h3', { text: 'Delete Message?' });
        contentEl.createEl('p', { text: 'This action cannot be undone.' });

        const buttonRow = contentEl.createEl('div', { cls: 'collab-confirm-buttons' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-confirm-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = buttonRow.createEl('button', {
            text: 'Delete',
            cls: 'collab-confirm-delete-btn'
        });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Generic confirmation modal for actions
 */
class ConfirmActionModal extends Modal {
    private title: string;
    private message: string;
    private onConfirm: () => void;

    constructor(app: App, title: string, message: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-confirm-modal');

        contentEl.createEl('h3', { text: this.title });
        contentEl.createEl('p', { text: this.message });

        const buttonRow = contentEl.createEl('div', { cls: 'collab-confirm-buttons' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-confirm-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = buttonRow.createEl('button', {
            text: 'Confirm',
            cls: 'collab-confirm-action-btn'
        });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for deleting a channel with export option
 */
class DeleteChannelModal extends Modal {
    private channelType: string;
    private onExportAndDelete: () => Promise<void>;
    private onDeleteOnly: () => Promise<void>;

    constructor(
        app: App,
        channelType: string,
        onExportAndDelete: () => Promise<void>,
        onDeleteOnly: () => Promise<void>
    ) {
        super(app);
        this.channelType = channelType;
        this.onExportAndDelete = onExportAndDelete;
        this.onDeleteOnly = onDeleteOnly;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-confirm-modal');

        contentEl.createEl('h3', { text: `Delete ${this.channelType}?` });
        contentEl.createEl('p', {
            text: `This will permanently delete the ${this.channelType} and all its messages for everyone.`
        });
        contentEl.createEl('p', {
            text: 'Would you like to export a copy of the chat before deleting?',
            cls: 'collab-export-hint'
        });

        const buttonRow = contentEl.createEl('div', { cls: 'collab-confirm-buttons collab-delete-options' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-confirm-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const deleteOnlyBtn = buttonRow.createEl('button', {
            text: 'Delete',
            cls: 'collab-confirm-action-btn collab-delete-only-btn'
        });
        deleteOnlyBtn.addEventListener('click', async () => {
            this.close();
            await this.onDeleteOnly();
        });

        const exportBtn = buttonRow.createEl('button', {
            text: 'Export & Delete',
            cls: 'collab-confirm-action-btn collab-export-delete-btn'
        });
        exportBtn.addEventListener('click', async () => {
            this.close();
            await this.onExportAndDelete();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for leaving a channel when you're the last member (channel will be deleted)
 */
class LeaveAsLastMemberModal extends Modal {
    private channelType: string;
    private onExportAndLeave: () => Promise<void>;
    private onLeaveOnly: () => Promise<void>;

    constructor(
        app: App,
        channelType: string,
        onExportAndLeave: () => Promise<void>,
        onLeaveOnly: () => Promise<void>
    ) {
        super(app);
        this.channelType = channelType;
        this.onExportAndLeave = onExportAndLeave;
        this.onLeaveOnly = onLeaveOnly;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-confirm-modal');

        contentEl.createEl('h3', { text: `Leave ${this.channelType}?` });
        contentEl.createEl('p', {
            text: `You are the last member. Leaving will permanently delete this ${this.channelType} and all its messages.`
        });
        contentEl.createEl('p', {
            text: 'Would you like to export a copy of the chat before leaving?',
            cls: 'collab-export-hint'
        });

        const buttonRow = contentEl.createEl('div', { cls: 'collab-confirm-buttons collab-delete-options' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-confirm-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const leaveOnlyBtn = buttonRow.createEl('button', {
            text: 'Leave',
            cls: 'collab-confirm-action-btn collab-delete-only-btn'
        });
        leaveOnlyBtn.addEventListener('click', async () => {
            this.close();
            await this.onLeaveOnly();
        });

        const exportBtn = buttonRow.createEl('button', {
            text: 'Export & Leave',
            cls: 'collab-confirm-action-btn collab-export-delete-btn'
        });
        exportBtn.addEventListener('click', async () => {
            this.close();
            await this.onExportAndLeave();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for creating a new reminder
 */
class NewReminderModal extends Modal {
    private reminderManager: ReminderManager;
    private onCreated: () => void;

    constructor(app: App, reminderManager: ReminderManager, onCreated: () => void) {
        super(app);
        this.reminderManager = reminderManager;
        this.onCreated = onCreated;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-reminder-modal');

        contentEl.createEl('h3', { text: 'New Reminder' });

        // Message input
        contentEl.createEl('label', { text: 'What do you want to remember?' });
        const messageInput = contentEl.createEl('textarea', {
            cls: 'collab-reminder-message-input',
            attr: { placeholder: 'Enter your reminder...', rows: '3' }
        });

        // Date/time input with natural language
        contentEl.createEl('label', { text: 'When?' });
        const dateInputWrapper = contentEl.createEl('div', { cls: 'collab-reminder-date-wrapper' });

        const dateInput = dateInputWrapper.createEl('input', {
            cls: 'collab-reminder-date-input',
            attr: {
                type: 'text',
                placeholder: 'e.g., tomorrow 3pm, in 2 hours, next monday'
            }
        });

        // Date preview
        const previewEl = contentEl.createEl('div', { cls: 'collab-reminder-date-preview' });

        // Suggestions
        const suggestionsEl = dateInputWrapper.createEl('div', { cls: 'collab-reminder-suggestions' });
        for (const suggestion of ReminderManager.getSuggestions().slice(0, 5)) {
            const chip = suggestionsEl.createEl('button', {
                text: suggestion,
                cls: 'collab-reminder-suggestion-chip'
            });
            chip.addEventListener('click', () => {
                dateInput.value = suggestion;
                this.updateDatePreview(dateInput.value, previewEl);
            });
        }

        // Calendar fallback
        const calendarRow = contentEl.createEl('div', { cls: 'collab-reminder-calendar-row' });
        calendarRow.createEl('span', { text: 'Or pick a date: ' });
        const calendarInput = calendarRow.createEl('input', {
            cls: 'collab-reminder-calendar-input',
            attr: { type: 'datetime-local' }
        });
        calendarInput.addEventListener('change', () => {
            if (calendarInput.value) {
                const date = new Date(calendarInput.value);
                dateInput.value = date.toLocaleString();
                this.updateDatePreview(dateInput.value, previewEl);
            }
        });

        dateInput.addEventListener('input', () => {
            this.updateDatePreview(dateInput.value, previewEl);
        });

        // Priority
        contentEl.createEl('label', { text: 'Priority' });
        const prioritySelect = contentEl.createEl('select', { cls: 'collab-reminder-priority-select' });
        prioritySelect.createEl('option', { value: 'low', text: '🔵 Low' });
        prioritySelect.createEl('option', { value: 'normal', text: '⚪ Normal' });
        prioritySelect.createEl('option', { value: 'high', text: '🔴 High' });
        (prioritySelect as HTMLSelectElement).value = 'normal';

        // Global reminder checkbox
        const globalRow = contentEl.createEl('div', { cls: 'collab-reminder-global-row' });
        const globalCheckbox = globalRow.createEl('input', {
            cls: 'collab-reminder-global-checkbox',
            attr: { type: 'checkbox', id: 'reminder-global' }
        });
        const globalLabel = globalRow.createEl('label', {
            text: 'Share with all team members',
            attr: { for: 'reminder-global' }
        });
        globalLabel.addClass('collab-reminder-global-label');

        // Buttons
        const buttonRow = contentEl.createEl('div', { cls: 'collab-reminder-buttons' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-reminder-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const createBtn = buttonRow.createEl('button', {
            text: 'Create Reminder',
            cls: 'collab-reminder-create-btn'
        });
        createBtn.addEventListener('click', async () => {
            const message = messageInput.value.trim();
            if (!message) {
                new Notice('Please enter a reminder message');
                return;
            }

            const dueDate = ReminderManager.parseNaturalDate(dateInput.value);
            if (!dueDate) {
                new Notice('Could not parse date. Try "tomorrow 3pm" or use the calendar picker.');
                return;
            }

            const priority = (prioritySelect as HTMLSelectElement).value as ReminderPriority;
            const isGlobal = (globalCheckbox as HTMLInputElement).checked;

            await this.reminderManager.createReminder(message, dueDate, priority, undefined, isGlobal);
            new Notice(`Reminder set for ${ReminderManager.formatDueDate(dueDate.toISOString())}${isGlobal ? ' (shared with team)' : ''}`);
            this.close();
            this.onCreated();
        });

        // Focus message input
        setTimeout(() => messageInput.focus(), 10);
    }

    private updateDatePreview(input: string, previewEl: HTMLElement): void {
        if (!input.trim()) {
            previewEl.setText('');
            previewEl.removeClass('valid', 'invalid');
            return;
        }

        const parsed = ReminderManager.parseNaturalDate(input);
        if (parsed) {
            previewEl.setText(`📅 ${parsed.toLocaleString()}`);
            previewEl.removeClass('invalid');
            previewEl.addClass('valid');
        } else {
            previewEl.setText('❌ Could not parse date');
            previewEl.removeClass('valid');
            previewEl.addClass('invalid');
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for editing a reminder
 */
class EditReminderModal extends Modal {
    private reminderManager: ReminderManager;
    private reminder: Reminder;
    private onUpdated: () => void;

    constructor(app: App, reminderManager: ReminderManager, reminder: Reminder, onUpdated: () => void) {
        super(app);
        this.reminderManager = reminderManager;
        this.reminder = reminder;
        this.onUpdated = onUpdated;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-reminder-modal');

        contentEl.createEl('h3', { text: 'Edit Reminder' });

        // Message input
        contentEl.createEl('label', { text: 'Message' });
        const messageInput = contentEl.createEl('textarea', {
            cls: 'collab-reminder-message-input',
            attr: { rows: '3' }
        });
        messageInput.value = this.reminder.message;

        // Date/time input
        contentEl.createEl('label', { text: 'When?' });
        const dateInput = contentEl.createEl('input', {
            cls: 'collab-reminder-date-input',
            attr: { type: 'text' }
        });
        dateInput.value = new Date(this.reminder.dueDate).toLocaleString();

        // Calendar fallback
        const calendarRow = contentEl.createEl('div', { cls: 'collab-reminder-calendar-row' });
        calendarRow.createEl('span', { text: 'Or pick: ' });
        const calendarInput = calendarRow.createEl('input', {
            cls: 'collab-reminder-calendar-input',
            attr: { type: 'datetime-local' }
        });
        // Set initial value
        const dueDate = new Date(this.reminder.dueDate);
        calendarInput.value = dueDate.toISOString().slice(0, 16);

        calendarInput.addEventListener('change', () => {
            if (calendarInput.value) {
                dateInput.value = new Date(calendarInput.value).toLocaleString();
            }
        });

        // Priority
        contentEl.createEl('label', { text: 'Priority' });
        const prioritySelect = contentEl.createEl('select', { cls: 'collab-reminder-priority-select' });
        prioritySelect.createEl('option', { value: 'low', text: '🔵 Low' });
        prioritySelect.createEl('option', { value: 'normal', text: '⚪ Normal' });
        prioritySelect.createEl('option', { value: 'high', text: '🔴 High' });
        (prioritySelect as HTMLSelectElement).value = this.reminder.priority;

        // Buttons
        const buttonRow = contentEl.createEl('div', { cls: 'collab-reminder-buttons' });

        const cancelBtn = buttonRow.createEl('button', {
            text: 'Cancel',
            cls: 'collab-reminder-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = buttonRow.createEl('button', {
            text: 'Save',
            cls: 'collab-reminder-create-btn'
        });
        saveBtn.addEventListener('click', async () => {
            const message = messageInput.value.trim();
            if (!message) {
                new Notice('Please enter a reminder message');
                return;
            }

            let newDueDate = ReminderManager.parseNaturalDate(dateInput.value);
            if (!newDueDate) {
                // Try parsing as a standard date
                newDueDate = new Date(dateInput.value);
                if (isNaN(newDueDate.getTime())) {
                    new Notice('Could not parse date');
                    return;
                }
            }

            const priority = (prioritySelect as HTMLSelectElement).value as ReminderPriority;

            await this.reminderManager.editReminder(this.reminder.id, {
                message,
                dueDate: newDueDate.toISOString(),
                priority
            });

            new Notice('Reminder updated');
            this.close();
            this.onUpdated();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for snoozing a reminder
 */
class SnoozeModal extends Modal {
    private reminderManager: ReminderManager;
    private reminderId: string;
    private onSnoozed: () => void;

    constructor(app: App, reminderManager: ReminderManager, reminderId: string, onSnoozed: () => void) {
        super(app);
        this.reminderManager = reminderManager;
        this.reminderId = reminderId;
        this.onSnoozed = onSnoozed;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-snooze-modal');

        contentEl.createEl('h3', { text: 'Snooze Reminder' });
        contentEl.createEl('p', { text: 'Remind me again in...' });

        const optionsEl = contentEl.createEl('div', { cls: 'collab-snooze-options' });

        const snoozeOptions = [
            { label: '15 minutes', minutes: 15 },
            { label: '30 minutes', minutes: 30 },
            { label: '1 hour', minutes: 60 },
            { label: '2 hours', minutes: 120 },
            { label: '4 hours', minutes: 240 },
            { label: 'Tomorrow 9am', minutes: -1 }  // Special case
        ];

        for (const option of snoozeOptions) {
            const btn = optionsEl.createEl('button', {
                text: option.label,
                cls: 'collab-snooze-option-btn'
            });
            btn.addEventListener('click', async () => {
                if (option.minutes === -1) {
                    // Tomorrow 9am
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    tomorrow.setHours(9, 0, 0, 0);
                    const minutesUntil = Math.round((tomorrow.getTime() - Date.now()) / 60000);
                    await this.reminderManager.snoozeReminder(this.reminderId, minutesUntil);
                } else {
                    await this.reminderManager.snoozeReminder(this.reminderId, option.minutes);
                }
                new Notice(`Reminder snoozed for ${option.label}`);
                this.close();
                this.onSnoozed();
            });
        }

        // Cancel
        const cancelBtn = contentEl.createEl('button', {
            text: 'Cancel',
            cls: 'collab-snooze-cancel-btn'
        });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Modal for displaying reminder notification in center of screen
 */
export class ReminderNotificationModal extends Modal {
    private reminder: Reminder;
    private reminderManager: ReminderManager;
    private onAction: () => void;

    constructor(app: App, reminder: Reminder, reminderManager: ReminderManager, onAction: () => void) {
        super(app);
        this.reminder = reminder;
        this.reminderManager = reminderManager;
        this.onAction = onAction;
    }

    onOpen(): void {
        console.log('[Collab-Mentions] ReminderNotificationModal onOpen called for:', this.reminder.id, this.reminder.message.substring(0, 30));

        const { contentEl, modalEl } = this;
        contentEl.empty();
        contentEl.addClass('collab-reminder-notification-modal');
        modalEl.addClass('collab-reminder-notification-container');

        // Icon and header
        const headerEl = contentEl.createEl('div', { cls: 'collab-reminder-notif-header' });
        headerEl.createEl('span', { text: '⏰', cls: 'collab-reminder-notif-icon' });
        headerEl.createEl('h2', { text: 'Reminder' });

        // Global badge
        if (this.reminder.isGlobal) {
            headerEl.createEl('span', { text: '🌐 Team', cls: 'collab-reminder-notif-global-badge' });
        }

        // Message
        contentEl.createEl('div', {
            text: this.reminder.message,
            cls: 'collab-reminder-notif-message'
        });

        // Creator info for global reminders
        if (this.reminder.isGlobal) {
            contentEl.createEl('div', {
                text: `Created by @${this.reminder.user}`,
                cls: 'collab-reminder-notif-creator'
            });
        }

        // Priority badge
        if (this.reminder.priority !== 'normal') {
            const priorityText = this.reminder.priority === 'high' ? '🔴 High Priority' : '🔵 Low Priority';
            contentEl.createEl('div', { text: priorityText, cls: 'collab-reminder-notif-priority' });
        }

        // Action buttons
        const actionsEl = contentEl.createEl('div', { cls: 'collab-reminder-notif-actions' });

        // Snooze options
        const snoozeRow = actionsEl.createEl('div', { cls: 'collab-reminder-notif-snooze-row' });
        snoozeRow.createEl('span', { text: 'Snooze: ' });

        const snoozeOptions = [
            { label: '15m', minutes: 15 },
            { label: '1h', minutes: 60 },
            { label: '4h', minutes: 240 }
        ];

        for (const option of snoozeOptions) {
            const snoozeBtn = snoozeRow.createEl('button', {
                text: option.label,
                cls: 'collab-reminder-notif-snooze-btn'
            });
            snoozeBtn.addEventListener('click', async () => {
                await this.reminderManager.snoozeReminder(this.reminder.id, option.minutes);
                new Notice(`Snoozed for ${option.label}`);
                this.close();
                this.onAction();
            });
        }

        // Main buttons
        const buttonRow = actionsEl.createEl('div', { cls: 'collab-reminder-notif-buttons' });

        const completeBtn = buttonRow.createEl('button', {
            text: '✓ Mark Complete',
            cls: 'collab-reminder-notif-complete-btn'
        });
        completeBtn.addEventListener('click', async () => {
            await this.reminderManager.completeReminder(this.reminder.id);
            new Notice('Reminder completed!');
            this.close();
            this.onAction();
        });

        const dismissBtn = buttonRow.createEl('button', {
            text: 'Dismiss',
            cls: 'collab-reminder-notif-dismiss-btn'
        });
        dismissBtn.addEventListener('click', () => {
            this.close();
            this.onAction();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}