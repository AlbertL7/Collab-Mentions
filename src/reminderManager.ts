import { App, Notice } from 'obsidian';
import { Reminder, RemindersData, ReminderPriority } from './types';
import { UserManager } from './userManager';

const REMINDERS_FILE = '.collab-mentions/reminders.json';

export class ReminderManager {
    private app: App;
    private userManager: UserManager;
    private remindersData: RemindersData;
    private checkInterval: number | null = null;
    private onReminderDue: ((reminder: Reminder) => void) | null = null;

    constructor(app: App, userManager: UserManager) {
        this.app = app;
        this.userManager = userManager;
        this.remindersData = { reminders: [] };
    }

    /**
     * Set callback for when a reminder is due
     */
    setOnReminderDue(callback: (reminder: Reminder) => void): void {
        this.onReminderDue = callback;
    }

    /**
     * Generate a simple unique ID
     */
    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
    }

    /**
     * Load reminders from vault
     */
    async loadReminders(): Promise<void> {
        try {
            if (!await this.app.vault.adapter.exists('.collab-mentions')) {
                await this.app.vault.adapter.mkdir('.collab-mentions');
            }

            if (await this.app.vault.adapter.exists(REMINDERS_FILE)) {
                const content = await this.app.vault.adapter.read(REMINDERS_FILE);
                this.remindersData = JSON.parse(content);
            } else {
                this.remindersData = { reminders: [] };
            }
        } catch (error) {
            console.error('Error loading reminders:', error);
            this.remindersData = { reminders: [] };
        }
    }

    /**
     * Save reminders to vault
     */
    async saveReminders(): Promise<void> {
        try {
            const content = JSON.stringify(this.remindersData, null, 2);
            await this.app.vault.adapter.write(REMINDERS_FILE, content);
        } catch (error) {
            console.error('Error saving reminders:', error);
        }
    }

    /**
     * Create a new reminder
     */
    async createReminder(
        message: string,
        dueDate: Date,
        priority: ReminderPriority = 'normal',
        linkedFile?: string,
        isGlobal: boolean = false
    ): Promise<Reminder | null> {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return null;

        const reminder: Reminder = {
            id: this.generateId(),
            user: currentUser.vaultName,
            message,
            dueDate: dueDate.toISOString(),
            createdAt: new Date().toISOString(),
            completed: false,
            notified: false,
            notifiedUsers: [],
            priority,
            linkedFile,
            isGlobal
        };

        this.remindersData.reminders.push(reminder);
        await this.saveReminders();

        return reminder;
    }

    /**
     * Get all reminders (for tracking purposes)
     */
    getReminders(): Reminder[] {
        return this.remindersData.reminders;
    }

    /**
     * Get all reminders visible to the current user (own + global)
     */
    getRemindersForCurrentUser(): Reminder[] {
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) return [];

        return this.remindersData.reminders
            .filter(r => r.user === currentUser.vaultName || r.isGlobal)
            .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    }

    /**
     * Get upcoming reminders (not completed, not past due)
     */
    getUpcomingReminders(): Reminder[] {
        const now = new Date();
        return this.getRemindersForCurrentUser()
            .filter(r => !r.completed && new Date(r.dueDate) > now);
    }

    /**
     * Get past due reminders (not completed, past due date)
     */
    getPastDueReminders(): Reminder[] {
        const now = new Date();
        return this.getRemindersForCurrentUser()
            .filter(r => !r.completed && new Date(r.dueDate) <= now);
    }

    /**
     * Get completed reminders
     */
    getCompletedReminders(): Reminder[] {
        return this.getRemindersForCurrentUser()
            .filter(r => r.completed)
            .sort((a, b) => new Date(b.completedAt || b.dueDate).getTime() - new Date(a.completedAt || a.dueDate).getTime());
    }

    /**
     * Mark a reminder as completed
     */
    async completeReminder(reminderId: string): Promise<void> {
        const reminder = this.remindersData.reminders.find(r => r.id === reminderId);
        if (reminder) {
            reminder.completed = true;
            reminder.completedAt = new Date().toISOString();
            await this.saveReminders();
        }
    }

    /**
     * Delete a reminder
     */
    async deleteReminder(reminderId: string): Promise<void> {
        this.remindersData.reminders = this.remindersData.reminders.filter(r => r.id !== reminderId);
        await this.saveReminders();
    }

    /**
     * Edit a reminder
     */
    async editReminder(reminderId: string, updates: Partial<Pick<Reminder, 'message' | 'dueDate' | 'priority'>>): Promise<void> {
        const reminder = this.remindersData.reminders.find(r => r.id === reminderId);
        if (reminder) {
            if (updates.message !== undefined) reminder.message = updates.message;
            if (updates.dueDate !== undefined) reminder.dueDate = updates.dueDate;
            if (updates.priority !== undefined) reminder.priority = updates.priority;
            // Reset notified if due date changed
            if (updates.dueDate !== undefined) {
                reminder.notified = false;
                reminder.notifiedUsers = [];  // Reset for global reminders too
            }
            await this.saveReminders();
        }
    }

    /**
     * Snooze a reminder by a certain amount of time
     */
    async snoozeReminder(reminderId: string, minutes: number): Promise<void> {
        const reminder = this.remindersData.reminders.find(r => r.id === reminderId);
        if (reminder) {
            const newDueDate = new Date(Date.now() + minutes * 60 * 1000);
            reminder.dueDate = newDueDate.toISOString();
            reminder.notified = false;
            reminder.notifiedUsers = [];  // Reset for global reminders too
            await this.saveReminders();
        }
    }

    /**
     * Check for due reminders and trigger notifications
     */
    async checkDueReminders(): Promise<Reminder[]> {
        const now = new Date();
        const currentUser = this.userManager.getCurrentUser();
        if (!currentUser) {
            console.debug('[Collab-Mentions] checkDueReminders: no current user');
            return [];
        }

        const dueReminders: Reminder[] = [];
        let needsSave = false;

        // Log all non-completed reminders for debugging
        const activeReminders = this.remindersData.reminders.filter(r => !r.completed);
        if (activeReminders.length > 0) {
            console.debug('[Collab-Mentions] checkDueReminders: checking', activeReminders.length, 'active reminders at', now.toISOString());
        }

        for (const reminder of this.remindersData.reminders) {
            if (reminder.completed) continue;

            const dueDate = new Date(reminder.dueDate);

            // Log each reminder check
            const isDue = dueDate <= now;
            const isOwner = reminder.user === currentUser.vaultName;
            const alreadyNotified = reminder.notified;

            if (isDue) {
                console.debug('[Collab-Mentions] Reminder due check:', {
                    id: reminder.id,
                    message: reminder.message.substring(0, 30),
                    dueDate: dueDate.toISOString(),
                    now: now.toISOString(),
                    isDue,
                    isOwner,
                    alreadyNotified,
                    isGlobal: reminder.isGlobal
                });
            }

            if (dueDate > now) continue;

            // Check if this user should be notified
            let shouldNotify = false;

            if (reminder.isGlobal) {
                // Global reminder: check if this user has been notified
                const notifiedUsers = reminder.notifiedUsers || [];
                if (!notifiedUsers.includes(currentUser.vaultName)) {
                    shouldNotify = true;
                    // Add current user to notified list
                    if (!reminder.notifiedUsers) reminder.notifiedUsers = [];
                    reminder.notifiedUsers.push(currentUser.vaultName);
                    needsSave = true;
                    console.debug('[Collab-Mentions] Global reminder needs notification for user:', currentUser.vaultName);
                }
            } else {
                // Personal reminder: only notify owner, only once
                if (reminder.user === currentUser.vaultName && !reminder.notified) {
                    shouldNotify = true;
                    reminder.notified = true;
                    needsSave = true;
                    console.debug('[Collab-Mentions] Personal reminder needs notification');
                }
            }

            if (shouldNotify) {
                dueReminders.push(reminder);
                // Trigger callback
                if (this.onReminderDue) {
                    console.debug('[Collab-Mentions] Triggering onReminderDue callback for:', reminder.message.substring(0, 30));
                    this.onReminderDue(reminder);
                } else {
                    console.error('[Collab-Mentions] WARNING: onReminderDue callback not set!');
                }
            }
        }

        if (needsSave) {
            this.remindersData.lastChecked = now.toISOString();
            await this.saveReminders();
            console.debug('[Collab-Mentions] Saved reminders after marking as notified');
        }

        return dueReminders;
    }

    /**
     * Start periodic checking for due reminders
     */
    startPeriodicCheck(intervalMs: number = 60000): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }

        console.debug('[Collab-Mentions] Starting periodic reminder check every', intervalMs, 'ms');

        // Check immediately on start
        console.debug('[Collab-Mentions] Running immediate check on startPeriodicCheck');
        this.checkDueReminders();

        // Then check periodically - reload from disk first to catch any changes
        this.checkInterval = window.setInterval(async () => {
            // Log each interval tick for debugging
            const now = new Date();
            const activeReminders = this.remindersData.reminders.filter(r => !r.completed && !r.notified);
            if (activeReminders.length > 0) {
                console.debug('[Collab-Mentions] Periodic check running at', now.toISOString(),
                    'with', activeReminders.length, 'active unnotified reminders');
            }

            // Reload from disk to ensure we have latest data
            await this.loadReminders();
            const dueReminders = await this.checkDueReminders();
            if (dueReminders.length > 0) {
                console.debug('[Collab-Mentions] Periodic check found due reminders:', dueReminders.length);
            }
        }, intervalMs);
    }

    /**
     * Stop periodic checking
     */
    stopPeriodicCheck(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    /**
     * Get the reminders file path for file watching
     */
    getRemindersFilePath(): string {
        return REMINDERS_FILE;
    }

    /**
     * Parse natural language date/time string
     * Supports: "tomorrow", "in 2 hours", "next monday", "jan 15 3pm", etc.
     */
    static parseNaturalDate(input: string): Date | null {
        const now = new Date();
        const lowered = input.toLowerCase().trim();

        // "now" or "immediately"
        if (lowered === 'now' || lowered === 'immediately') {
            return now;
        }

        // "in X minutes/hours/days/weeks"
        const inMatch = lowered.match(/^in\s+(\d+)\s*(min(?:ute)?s?|hours?|days?|weeks?|months?)$/);
        if (inMatch) {
            const amount = parseInt(inMatch[1]);
            const unit = inMatch[2];
            const result = new Date(now);

            if (unit.startsWith('min')) {
                result.setMinutes(result.getMinutes() + amount);
            } else if (unit.startsWith('hour')) {
                result.setHours(result.getHours() + amount);
            } else if (unit.startsWith('day')) {
                result.setDate(result.getDate() + amount);
            } else if (unit.startsWith('week')) {
                result.setDate(result.getDate() + amount * 7);
            } else if (unit.startsWith('month')) {
                result.setMonth(result.getMonth() + amount);
            }

            return result;
        }

        // "tomorrow" with optional time
        if (lowered.startsWith('tomorrow')) {
            const result = new Date(now);
            result.setDate(result.getDate() + 1);
            const timeMatch = lowered.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
            if (timeMatch) {
                let hours = parseInt(timeMatch[1]);
                const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
                const ampm = timeMatch[3];
                if (ampm === 'pm' && hours < 12) hours += 12;
                if (ampm === 'am' && hours === 12) hours = 0;
                result.setHours(hours, minutes, 0, 0);
            } else {
                result.setHours(9, 0, 0, 0); // Default to 9am
            }
            return result;
        }

        // "today" with optional time
        if (lowered.startsWith('today')) {
            const result = new Date(now);
            const timeMatch = lowered.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
            if (timeMatch) {
                let hours = parseInt(timeMatch[1]);
                const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
                const ampm = timeMatch[3];
                if (ampm === 'pm' && hours < 12) hours += 12;
                if (ampm === 'am' && hours === 12) hours = 0;
                result.setHours(hours, minutes, 0, 0);
            }
            return result;
        }

        // "next monday/tuesday/etc" with optional time
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const nextDayMatch = lowered.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
        if (nextDayMatch) {
            const targetDay = dayNames.indexOf(nextDayMatch[1]);
            const result = new Date(now);
            const currentDay = result.getDay();
            let daysToAdd = targetDay - currentDay;
            if (daysToAdd <= 0) daysToAdd += 7;
            result.setDate(result.getDate() + daysToAdd);

            if (nextDayMatch[2]) {
                let hours = parseInt(nextDayMatch[2]);
                const minutes = nextDayMatch[3] ? parseInt(nextDayMatch[3]) : 0;
                const ampm = nextDayMatch[4];
                if (ampm === 'pm' && hours < 12) hours += 12;
                if (ampm === 'am' && hours === 12) hours = 0;
                result.setHours(hours, minutes, 0, 0);
            } else {
                result.setHours(9, 0, 0, 0);
            }

            return result;
        }

        // "this monday/tuesday/etc" (this week)
        const thisDayMatch = lowered.match(/^this\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
        if (thisDayMatch) {
            const targetDay = dayNames.indexOf(thisDayMatch[1]);
            const result = new Date(now);
            const currentDay = result.getDay();
            let daysToAdd = targetDay - currentDay;
            if (daysToAdd < 0) daysToAdd += 7;
            result.setDate(result.getDate() + daysToAdd);

            if (thisDayMatch[2]) {
                let hours = parseInt(thisDayMatch[2]);
                const minutes = thisDayMatch[3] ? parseInt(thisDayMatch[3]) : 0;
                const ampm = thisDayMatch[4];
                if (ampm === 'pm' && hours < 12) hours += 12;
                if (ampm === 'am' && hours === 12) hours = 0;
                result.setHours(hours, minutes, 0, 0);
            } else {
                result.setHours(9, 0, 0, 0);
            }

            return result;
        }

        // Month day format: "jan 15", "january 15 3pm", "dec 25 at 10:30am"
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const monthMatch = lowered.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:(?:st|nd|rd|th))?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
        if (monthMatch) {
            const monthStr = monthMatch[1].substring(0, 3);
            const month = monthNames.indexOf(monthStr);
            const day = parseInt(monthMatch[2]);
            const result = new Date(now.getFullYear(), month, day);

            // If the date is in the past, assume next year
            if (result < now) {
                result.setFullYear(result.getFullYear() + 1);
            }

            if (monthMatch[3]) {
                let hours = parseInt(monthMatch[3]);
                const minutes = monthMatch[4] ? parseInt(monthMatch[4]) : 0;
                const ampm = monthMatch[5];
                if (ampm === 'pm' && hours < 12) hours += 12;
                if (ampm === 'am' && hours === 12) hours = 0;
                result.setHours(hours, minutes, 0, 0);
            } else {
                result.setHours(9, 0, 0, 0);
            }

            return result;
        }

        // Time only: "3pm", "10:30am", "15:00"
        const timeOnlyMatch = lowered.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
        if (timeOnlyMatch) {
            const result = new Date(now);
            let hours = parseInt(timeOnlyMatch[1]);
            const minutes = timeOnlyMatch[2] ? parseInt(timeOnlyMatch[2]) : 0;
            const ampm = timeOnlyMatch[3];

            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;

            result.setHours(hours, minutes, 0, 0);

            // If time is in the past today, move to tomorrow
            if (result <= now) {
                result.setDate(result.getDate() + 1);
            }

            return result;
        }

        // Try parsing as standard date
        const parsed = Date.parse(input);
        if (!isNaN(parsed)) {
            return new Date(parsed);
        }

        return null;
    }

    /**
     * Format a date for display
     */
    static formatDueDate(dueDate: string): string {
        const date = new Date(dueDate);
        const now = new Date();
        const diff = date.getTime() - now.getTime();

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        // Past due
        if (diff < 0) {
            const absDays = Math.abs(days);
            const absHours = Math.abs(hours);
            const absMinutes = Math.abs(minutes);

            if (absDays > 0) {
                return `${absDays} day${absDays > 1 ? 's' : ''} overdue`;
            } else if (absHours > 0) {
                return `${absHours} hour${absHours > 1 ? 's' : ''} overdue`;
            } else {
                return `${absMinutes} min overdue`;
            }
        }

        // Future
        if (days === 0) {
            if (hours === 0) {
                return `in ${minutes} min`;
            }
            return `in ${hours} hour${hours > 1 ? 's' : ''}`;
        } else if (days === 1) {
            return `tomorrow at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        } else if (days < 7) {
            return `${date.toLocaleDateString([], { weekday: 'long' })} at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        } else {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        }
    }

    /**
     * Get suggestion for natural language input
     */
    static getSuggestions(): string[] {
        return [
            'in 30 minutes',
            'in 1 hour',
            'in 2 hours',
            'tomorrow',
            'tomorrow 9am',
            'tomorrow 2pm',
            'next monday',
            'next friday 3pm',
            'in 3 days',
            'in 1 week'
        ];
    }
}
