import { App, Notice, Modal, MarkdownView } from 'obsidian';
import { Mention } from './types';
import { MentionParser } from './mentionParser';
import { UserManager } from './userManager';

export class Notifier {
    private app: App;
    private mentionParser: MentionParser;
    private userManager: UserManager;
    private notificationSound: HTMLAudioElement | null = null;

    constructor(app: App, mentionParser: MentionParser, userManager: UserManager) {
        this.app = app;
        this.mentionParser = mentionParser;
        this.userManager = userManager;
        this.initSound();
    }

    /**
     * Initialize notification sound
     */
    private initSound(): void {
        // Create a simple beep using Web Audio API
        // We'll use a data URI for a simple notification sound
        try {
            this.notificationSound = new Audio(
                'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH2Mi4eBdWxzgImLhXlta3WBi42HfHJud4SLjIV5bmt2goyMhXlsandCjIyFeWxqdYKMjIV5bGp1goyMhXlsanWCjIyFeWxqdYKMjIV5bA=='
            );
        } catch (e) {
            console.log('Could not initialize notification sound');
        }
    }

    /**
     * Play notification sound
     */
    playSound(): void {
        if (this.notificationSound) {
            this.notificationSound.currentTime = 0;
            this.notificationSound.play().catch(() => {
                // Ignore audio play errors (autoplay restrictions)
            });
        }
    }

    /**
     * Show a simple notice
     */
    showNotice(message: string, duration: number = 5000): void {
        console.log('[Collab-Mentions] Showing notice:', message);
        try {
            new Notice(message, duration);
            console.log('[Collab-Mentions] Notice created successfully');
        } catch (e) {
            console.error('[Collab-Mentions] Error creating notice:', e);
        }
    }

    /**
     * Check for unread mentions and notify
     */
    async checkAndNotify(playSound: boolean = true): Promise<number> {
        const unread = this.mentionParser.getUnreadMentions();

        if (unread.length > 0) {
            if (playSound) {
                this.playSound();
            }

            if (unread.length === 1) {
                const mention = unread[0];
                this.showNotice(
                    `📬 New mention from @${mention.from}:\n"${this.truncate(mention.context, 50)}"`,
                    8000
                );
            } else {
                this.showNotice(
                    `📬 You have ${unread.length} unread mentions!`,
                    8000
                );
            }
        }

        return unread.length;
    }

    /**
     * Notify about specific new unread mentions (prevents repeat notifications)
     */
    async notifyNewUnread(mentions: Mention[], playSound: boolean = true): Promise<void> {
        if (mentions.length === 0) return;

        if (playSound) {
            this.playSound();
        }

        if (mentions.length === 1) {
            const mention = mentions[0];
            this.showNotice(
                `📬 New mention from @${mention.from}:\n"${this.truncate(mention.context, 50)}"`,
                8000
            );
        } else {
            this.showNotice(
                `📬 ${mentions.length} new mentions!`,
                8000
            );
        }
    }

    /**
     * Show startup notification modal with all unread mentions
     */
    showStartupNotifications(unreadMentions: Mention[]): void {
        if (unreadMentions.length === 0) return;

        const modal = new UnreadMentionsModal(
            this.app,
            unreadMentions,
            this.mentionParser
        );
        modal.open();
    }

    /**
     * Notify about a new mention that was just created
     */
    notifyNewMention(mention: Mention): void {
        this.showNotice(
            `📤 Mentioned @${mention.to} in ${this.getFileName(mention.file)}`,
            3000
        );
    }

    /**
     * Truncate text to a maximum length
     */
    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    }

    /**
     * Get just the filename from a path
     */
    private getFileName(path: string): string {
        return path.split('/').pop() || path;
    }
}

/**
 * Modal to show unread mentions on startup
 */
class UnreadMentionsModal extends Modal {
    private mentions: Mention[];
    private mentionParser: MentionParser;

    constructor(app: App, mentions: Mention[], mentionParser: MentionParser) {
        super(app);
        this.mentions = mentions;
        this.mentionParser = mentionParser;
    }

    onOpen(): void {
        const { contentEl } = this;

        contentEl.addClass('collab-mentions-modal');

        contentEl.createEl('h2', { text: `📬 You have ${this.mentions.length} unread mention${this.mentions.length > 1 ? 's' : ''}` });

        const listEl = contentEl.createEl('div', { cls: 'mention-list' });

        for (const mention of this.mentions) {
            const itemEl = listEl.createEl('div', { cls: 'mention-item' });

            const headerEl = itemEl.createEl('div', { cls: 'mention-header' });
            headerEl.createEl('span', {
                text: `From @${mention.from}`,
                cls: 'mention-from'
            });
            headerEl.createEl('span', {
                text: this.formatDate(mention.timestamp),
                cls: 'mention-date'
            });

            itemEl.createEl('div', {
                text: mention.context,
                cls: 'mention-context'
            });

            const fileEl = itemEl.createEl('div', { cls: 'mention-file' });
            const link = fileEl.createEl('a', {
                text: `📄 ${mention.file}`,
                cls: 'mention-file-link'
            });

            link.addEventListener('click', async (e) => {
                e.preventDefault();
                this.close();

                // Open the file and go to line
                const file = this.app.vault.getAbstractFileByPath(mention.file);
                if (file) {
                    const leaf = this.app.workspace.getLeaf();
                    await leaf.openFile(file as any);

                    // Try to scroll to line
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (view && view.editor) {
                        view.editor.setCursor({ line: mention.line, ch: 0 });
                        view.editor.scrollIntoView({
                            from: { line: mention.line, ch: 0 },
                            to: { line: mention.line, ch: 0 }
                        }, true);
                    }
                }
            });

            const actionsEl = itemEl.createEl('div', { cls: 'mention-actions' });

            const markReadBtn = actionsEl.createEl('button', {
                text: '✓ Mark Read',
                cls: 'mention-btn'
            });
            markReadBtn.addEventListener('click', async () => {
                await this.mentionParser.markAsRead(mention.id);
                itemEl.addClass('mention-read');
                markReadBtn.disabled = true;
                markReadBtn.textContent = '✓ Read';
            });
        }

        const footerEl = contentEl.createEl('div', { cls: 'mention-footer' });

        const markAllBtn = footerEl.createEl('button', {
            text: 'Mark All as Read',
            cls: 'mention-btn-primary'
        });
        markAllBtn.addEventListener('click', async () => {
            await this.mentionParser.markAllAsRead();
            this.close();
            new Notice('All mentions marked as read');
        });

        const closeBtn = footerEl.createEl('button', {
            text: 'Close',
            cls: 'mention-btn'
        });
        closeBtn.addEventListener('click', () => {
            this.close();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }

    private formatDate(timestamp: string): string {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 60) {
            return `${minutes}m ago`;
        } else if (hours < 24) {
            return `${hours}h ago`;
        } else if (days < 7) {
            return `${days}d ago`;
        } else {
            return date.toLocaleDateString();
        }
    }
}