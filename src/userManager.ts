import { App, Notice } from 'obsidian';
import { VaultUser, UsersConfig, UserPresence, PresenceData, UserStatus, ManualStatus } from './types';
import * as os from 'os';

const USERS_FILE = '.collab-mentions/users.json';
const PRESENCE_FILE = '.collab-mentions/presence.json';
const LOCK_FILE = '.collab-mentions/users.lock';
const MAX_SAVE_RETRIES = 3;
const MAX_REGISTRATION_RETRIES = 3;
const LOCK_TIMEOUT = 10000;  // 10 seconds - max time a lock can be held

// Status thresholds in milliseconds
const ACTIVE_THRESHOLD = 5 * 60 * 1000;  // 5 minutes - user is active if they interacted within this time
const HEARTBEAT_THRESHOLD = 30 * 1000;   // 30 seconds - vault is considered open if heartbeat within this time

export class UserManager {
    private app: App;
    private currentUser: VaultUser | null = null;
    private usersConfig: UsersConfig = { users: [] };
    private presenceData: PresenceData = { presence: [] };

    // Track recently deleted users to prevent merge from re-adding them
    private recentlyDeletedUsers: Map<string, number> = new Map();  // localIdentifier -> deletion timestamp
    private readonly USER_DELETE_PROTECTION = 300000;  // 5 minutes

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Fast non-cryptographic hash (FNV-1a) for save verification
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
     * Acquire a lock for user registration/modification.
     * Uses a lock file with timestamp to handle stale locks.
     * @returns true if lock acquired, false if failed
     */
    private async acquireLock(): Promise<boolean> {
        const lockPath = LOCK_FILE;
        const localId = this.getLocalIdentifier();
        const now = Date.now();

        try {
            // Check if lock exists
            if (await this.app.vault.adapter.exists(lockPath)) {
                const content = await this.app.vault.adapter.read(lockPath);
                try {
                    const lockData = JSON.parse(content);
                    const lockAge = now - lockData.timestamp;

                    // If lock is stale (older than timeout), we can take it
                    if (lockAge > LOCK_TIMEOUT) {
                        console.log('[Collab-Mentions] Stale lock found, taking over');
                    } else if (lockData.holder !== localId) {
                        // Lock is held by someone else and not stale
                        console.log('[Collab-Mentions] Lock held by:', lockData.holder);
                        return false;
                    }
                    // If we're the holder, refresh the lock
                } catch {
                    // Invalid lock file, we can take it
                    console.log('[Collab-Mentions] Invalid lock file, taking over');
                }
            }

            // Write our lock
            const lockData = {
                holder: localId,
                timestamp: now
            };
            await this.app.vault.adapter.write(lockPath, JSON.stringify(lockData));

            // Verify we got the lock (handles race condition)
            await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
            const verifyContent = await this.app.vault.adapter.read(lockPath);
            const verifyData = JSON.parse(verifyContent);

            if (verifyData.holder === localId) {
                console.log('[Collab-Mentions] Lock acquired');
                return true;
            } else {
                console.log('[Collab-Mentions] Lost lock race to:', verifyData.holder);
                return false;
            }
        } catch (error) {
            console.error('[Collab-Mentions] Error acquiring lock:', error);
            return false;
        }
    }

    /**
     * Release the registration lock
     */
    private async releaseLock(): Promise<void> {
        const lockPath = LOCK_FILE;
        const localId = this.getLocalIdentifier();

        try {
            if (await this.app.vault.adapter.exists(lockPath)) {
                const content = await this.app.vault.adapter.read(lockPath);
                try {
                    const lockData = JSON.parse(content);
                    // Only release if we hold the lock
                    if (lockData.holder === localId) {
                        await this.app.vault.adapter.remove(lockPath);
                        console.log('[Collab-Mentions] Lock released');
                    }
                } catch {
                    // Invalid lock file, just remove it
                    await this.app.vault.adapter.remove(lockPath);
                }
            }
        } catch (error) {
            console.error('[Collab-Mentions] Error releasing lock:', error);
        }
    }

    /**
     * Check if a user was recently deleted (within protection window)
     */
    private isRecentlyDeletedUser(localIdentifier: string): boolean {
        const deletedTime = this.recentlyDeletedUsers.get(localIdentifier);
        if (!deletedTime) return false;

        const age = Date.now() - deletedTime;
        if (age > this.USER_DELETE_PROTECTION) {
            this.recentlyDeletedUsers.delete(localIdentifier);
            return false;
        }
        return true;
    }

    /**
     * Load presence data from vault
     */
    async loadPresence(): Promise<void> {
        try {
            if (await this.app.vault.adapter.exists(PRESENCE_FILE)) {
                const content = await this.app.vault.adapter.read(PRESENCE_FILE);
                this.presenceData = JSON.parse(content);
            } else {
                this.presenceData = { presence: [] };
            }
        } catch (error) {
            console.error('Failed to load presence data:', error);
            this.presenceData = { presence: [] };
        }
    }

    /**
     * Save presence data to vault with verification
     */
    async savePresence(): Promise<void> {
        try {
            const content = JSON.stringify(this.presenceData, null, 2);
            const expectedHash = this.computeHash(content);

            // Save with verification and retry
            for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
                await this.app.vault.adapter.write(PRESENCE_FILE, content);

                // Verify the save by reading back and comparing hash
                try {
                    const savedContent = await this.app.vault.adapter.read(PRESENCE_FILE);
                    const savedHash = this.computeHash(savedContent);

                    if (savedHash === expectedHash) {
                        return; // Success - presence saves are frequent, skip logging
                    } else {
                        console.warn(`[Collab-Mentions] Presence save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES})`);
                    }
                } catch (verifyError) {
                    console.warn(`[Collab-Mentions] Presence save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}):`, verifyError);
                }

                // Wait a bit before retry
                if (attempt < MAX_SAVE_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 50 * attempt));
                }
            }
        } catch (error) {
            console.error('Failed to save presence data:', error);
        }
    }

    /**
     * Update heartbeat for current user
     * @param activeFile - The currently open file (if any)
     * @param isFileActivity - Whether this is triggered by actual file interaction
     */
    async updateHeartbeat(activeFile?: string, isFileActivity: boolean = false): Promise<void> {
        if (!this.currentUser) return;

        await this.loadPresence();

        const now = new Date().toISOString();
        const existingIndex = this.presenceData.presence.findIndex(
            p => p.vaultName === this.currentUser!.vaultName
        );

        const existingPresence = existingIndex !== -1 ? this.presenceData.presence[existingIndex] : null;

        const presenceEntry: UserPresence = {
            vaultName: this.currentUser.vaultName,
            lastSeen: now,  // Always update heartbeat
            lastActivity: isFileActivity ? now : (existingPresence?.lastActivity || now),  // Only update activity on file interaction
            activeFile: activeFile,
            manualStatus: existingPresence?.manualStatus  // Preserve manual status
        };

        if (existingIndex !== -1) {
            this.presenceData.presence[existingIndex] = presenceEntry;
        } else {
            this.presenceData.presence.push(presenceEntry);
        }

        await this.savePresence();
    }

    /**
     * Record file activity (user clicked/edited a file)
     */
    async recordFileActivity(activeFile?: string): Promise<void> {
        await this.updateHeartbeat(activeFile, true);
    }

    /**
     * Get user status based on heartbeat and activity
     * - Active: File activity within last 5 minutes
     * - Snooze: Vault is open (heartbeat recent) but no activity for 5+ minutes
     * - Offline: Vault is closed (no recent heartbeat)
     *
     * Manual status overrides automatic detection (except 'auto')
     */
    getUserStatus(vaultName: string): UserStatus {
        const presence = this.presenceData.presence.find(
            p => p.vaultName.toLowerCase() === vaultName.toLowerCase()
        );

        if (!presence) {
            return 'offline';
        }

        // Check for manual status override (if set and not 'auto')
        if (presence.manualStatus && presence.manualStatus !== 'auto') {
            return presence.manualStatus;
        }

        const now = Date.now();
        const lastSeen = new Date(presence.lastSeen).getTime();
        const heartbeatAge = now - lastSeen;

        // If no recent heartbeat, vault is closed = offline
        if (heartbeatAge > HEARTBEAT_THRESHOLD) {
            return 'offline';
        }

        // Vault is open - check activity
        const lastActivity = presence.lastActivity ? new Date(presence.lastActivity).getTime() : lastSeen;
        const activityAge = now - lastActivity;

        // Recent activity = active
        if (activityAge <= ACTIVE_THRESHOLD) {
            return 'active';
        }

        // Vault open but no recent activity = snooze
        return 'snooze';
    }

    /**
     * Get presence info for a user
     */
    getUserPresence(vaultName: string): UserPresence | undefined {
        return this.presenceData.presence.find(
            p => p.vaultName.toLowerCase() === vaultName.toLowerCase()
        );
    }

    /**
     * Get the current user's manual status setting
     */
    getCurrentUserManualStatus(): ManualStatus {
        if (!this.currentUser) return 'auto';
        const presence = this.getUserPresence(this.currentUser.vaultName);
        return presence?.manualStatus || 'auto';
    }

    /**
     * Set manual status for the current user
     * @param status - 'auto' for automatic detection, or 'active'/'snooze'/'offline' for manual override
     */
    async setManualStatus(status: ManualStatus): Promise<void> {
        if (!this.currentUser) return;

        await this.loadPresence();

        const existingIndex = this.presenceData.presence.findIndex(
            p => p.vaultName === this.currentUser!.vaultName
        );

        if (existingIndex !== -1) {
            this.presenceData.presence[existingIndex].manualStatus = status;
        } else {
            // Create presence entry if it doesn't exist
            const now = new Date().toISOString();
            this.presenceData.presence.push({
                vaultName: this.currentUser.vaultName,
                lastSeen: now,
                lastActivity: now,
                manualStatus: status
            });
        }

        await this.savePresence();

        const statusText = status === 'auto' ? 'Automatic' : status.charAt(0).toUpperCase() + status.slice(1);
        new Notice(`Status set to: ${statusText}`);
    }

    /**
     * Set typing status for current user in a channel
     */
    async setTyping(channelId: string): Promise<void> {
        if (!this.currentUser) return;

        await this.loadPresence();

        const existingIndex = this.presenceData.presence.findIndex(
            p => p.vaultName === this.currentUser!.vaultName
        );

        if (existingIndex !== -1) {
            this.presenceData.presence[existingIndex].typingInChannel = channelId;
            this.presenceData.presence[existingIndex].typingStarted = new Date().toISOString();
        }

        await this.savePresence();
    }

    /**
     * Clear typing status for current user
     */
    async clearTyping(): Promise<void> {
        if (!this.currentUser) return;

        await this.loadPresence();

        const existingIndex = this.presenceData.presence.findIndex(
            p => p.vaultName === this.currentUser!.vaultName
        );

        if (existingIndex !== -1) {
            this.presenceData.presence[existingIndex].typingInChannel = undefined;
            this.presenceData.presence[existingIndex].typingStarted = undefined;
        }

        await this.savePresence();
    }

    /**
     * Get users currently typing in a channel
     * Only returns users who started typing within the last 5 seconds
     */
    getTypingUsers(channelId: string): string[] {
        const now = Date.now();
        const TYPING_TIMEOUT = 5000; // 5 seconds

        return this.presenceData.presence
            .filter(p => {
                if (p.typingInChannel !== channelId) return false;
                if (!p.typingStarted) return false;
                if (p.vaultName === this.currentUser?.vaultName) return false; // Don't show self

                const typingAge = now - new Date(p.typingStarted).getTime();
                return typingAge < TYPING_TIMEOUT;
            })
            .map(p => p.vaultName);
    }

    /**
     * Get all users with their current status
     */
    getAllUsersWithStatus(): Array<VaultUser & { status: UserStatus; lastSeen?: string }> {
        return this.usersConfig.users.map(user => {
            const presence = this.getUserPresence(user.vaultName);
            return {
                ...user,
                status: this.getUserStatus(user.vaultName),
                lastSeen: presence?.lastSeen
            };
        });
    }

    /**
     * Clear presence for current user (called on unload)
     */
    async clearPresence(): Promise<void> {
        if (!this.currentUser) return;

        await this.loadPresence();

        this.presenceData.presence = this.presenceData.presence.filter(
            p => p.vaultName !== this.currentUser!.vaultName
        );

        await this.savePresence();
    }

    /**
     * Get the local machine identifier (username@hostname)
     */
    getLocalIdentifier(): string {
        const username = os.userInfo().username;
        const hostname = os.hostname();
        return `${username}@${hostname}`;
    }

    /**
     * Get the current operating system
     */
    getOS(): string {
        return process.platform;
    }

    /**
     * Get the path to the users file
     */
    getUsersFilePath(): string {
        return USERS_FILE;
    }

    /**
     * Load users configuration from vault
     */
    async loadUsers(): Promise<void> {
        try {
            const configPath = USERS_FILE;

            // Check if config directory exists
            if (!await this.app.vault.adapter.exists('.collab-mentions')) {
                await this.app.vault.adapter.mkdir('.collab-mentions');
            }

            // Check if users file exists
            if (await this.app.vault.adapter.exists(configPath)) {
                const content = await this.app.vault.adapter.read(configPath);
                this.usersConfig = JSON.parse(content);
                console.log('[Collab-Mentions] Loaded users:', this.usersConfig.users.map(u => u.vaultName));

                // Migration: Ensure at least one admin exists
                await this.ensureAdminExists();
            } else {
                // Create default config
                console.log('[Collab-Mentions] No users file found, creating empty config');
                this.usersConfig = { users: [] };
                await this.saveUsers();
            }
        } catch (error) {
            console.error('[Collab-Mentions] Failed to load users config:', error);
            this.usersConfig = { users: [] };
        }
    }

    /**
     * Migration: Ensure registration numbers and admin status are properly set
     */
    private async ensureAdminExists(): Promise<void> {
        if (this.usersConfig.users.length === 0) return;

        let needsSave = false;

        // Step 1: Assign registration numbers if missing
        const usersWithoutRegNum = this.usersConfig.users.filter(u => !u.registrationNumber);
        if (usersWithoutRegNum.length > 0) {
            // Sort all users by registration date
            const sortedUsers = [...this.usersConfig.users].sort((a, b) =>
                new Date(a.registered).getTime() - new Date(b.registered).getTime()
            );

            // Assign registration numbers based on order
            sortedUsers.forEach((sortedUser, index) => {
                const userInConfig = this.usersConfig.users.find(u => u.vaultName === sortedUser.vaultName);
                if (userInConfig && !userInConfig.registrationNumber) {
                    userInConfig.registrationNumber = index + 1;
                    needsSave = true;
                    console.log(`[Collab-Mentions] Migration: Assigned registration #${index + 1} to ${userInConfig.vaultName}`);
                }
            });
        }

        // Step 2: Ensure EXACTLY ONE primary admin (the one with registration #1)
        const primaryAdmins = this.usersConfig.users.filter(u => u.adminLevel === 'primary');
        console.log('[Collab-Mentions] Current primary admins:', primaryAdmins.map(u => u.vaultName));

        if (primaryAdmins.length !== 1) {
            // Fix: demote all to secondary, then promote registration #1
            for (const user of this.usersConfig.users) {
                if (user.adminLevel === 'primary' && user.registrationNumber !== 1) {
                    user.adminLevel = 'secondary';
                    needsSave = true;
                    console.log(`[Collab-Mentions] Migration: Demoted ${user.vaultName} from primary to secondary admin`);
                }
            }
        }

        // Ensure user with registration #1 is primary admin
        const firstUser = this.usersConfig.users.find(u => u.registrationNumber === 1);
        if (firstUser) {
            if (!firstUser.isAdmin || firstUser.adminLevel !== 'primary') {
                firstUser.isAdmin = true;
                firstUser.adminLevel = 'primary';
                needsSave = true;
                console.log(`[Collab-Mentions] Migration: Set ${firstUser.vaultName} as primary admin (registration #1)`);
            }
        }

        // Step 3: Ensure any existing admin without adminLevel is set to 'secondary'
        // (unless they are registration #1)
        for (const user of this.usersConfig.users) {
            if (user.isAdmin && !user.adminLevel && user.registrationNumber !== 1) {
                user.adminLevel = 'secondary';
                needsSave = true;
                console.log(`[Collab-Mentions] Migration: Set ${user.vaultName} as secondary admin`);
            }
        }

        // Log final state
        console.log('[Collab-Mentions] Users after migration:', this.usersConfig.users.map(u => ({
            name: u.vaultName,
            regNum: u.registrationNumber,
            isAdmin: u.isAdmin,
            adminLevel: u.adminLevel
        })));

        if (needsSave) {
            await this.saveUsers();
        }
    }

    /**
     * Save users configuration to vault with merge logic for concurrent registrations
     */
    async saveUsers(): Promise<void> {
        try {
            // Merge with disk to handle concurrent registrations
            if (await this.app.vault.adapter.exists(USERS_FILE)) {
                try {
                    const diskContent = await this.app.vault.adapter.read(USERS_FILE);
                    const diskConfig = JSON.parse(diskContent) as UsersConfig;

                    // Merge users from disk that we don't have (by localIdentifier)
                    // Skip recently deleted users to prevent them from being re-added
                    const ourLocalIds = new Set(this.usersConfig.users.map(u => u.localIdentifier));
                    for (const diskUser of diskConfig.users) {
                        if (!ourLocalIds.has(diskUser.localIdentifier)) {
                            // Check if this user was recently deleted
                            if (this.isRecentlyDeletedUser(diskUser.localIdentifier)) {
                                console.log('[Collab-Mentions] Skipping recently deleted user:', diskUser.vaultName);
                                continue;
                            }
                            console.log('[Collab-Mentions] Merging user from disk:', diskUser.vaultName);
                            this.usersConfig.users.push(diskUser);
                        }
                    }

                    // Sort by registration timestamp to ensure consistent ordering
                    this.usersConfig.users.sort((a, b) =>
                        new Date(a.registered).getTime() - new Date(b.registered).getTime()
                    );

                    // Re-assign registration numbers based on sorted order
                    this.usersConfig.users.forEach((user, index) => {
                        user.registrationNumber = index + 1;
                    });

                    // Ensure exactly ONE primary admin (the one registered first)
                    let hasPrimary = false;
                    for (const user of this.usersConfig.users) {
                        if (user.registrationNumber === 1) {
                            user.isAdmin = true;
                            user.adminLevel = 'primary';
                            hasPrimary = true;
                        } else if (user.adminLevel === 'primary') {
                            // Demote any other primary admins to secondary
                            user.adminLevel = 'secondary';
                            console.log('[Collab-Mentions] Demoted duplicate primary admin:', user.vaultName);
                        }
                    }

                    console.log('[Collab-Mentions] After merge - users:', this.usersConfig.users.map(u => ({
                        name: u.vaultName,
                        regNum: u.registrationNumber,
                        adminLevel: u.adminLevel
                    })));
                } catch (e) {
                    console.warn('[Collab-Mentions] Failed to merge users, saving anyway:', e);
                }
            }

            const content = JSON.stringify(this.usersConfig, null, 2);
            const expectedHash = this.computeHash(content);

            // Save with verification and retry
            for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
                await this.app.vault.adapter.write(USERS_FILE, content);

                // Verify the save by reading back and comparing hash
                try {
                    const savedContent = await this.app.vault.adapter.read(USERS_FILE);
                    const savedHash = this.computeHash(savedContent);

                    if (savedHash === expectedHash) {
                        console.log('[Collab-Mentions] Users saved and verified (attempt', attempt + ')');
                        return; // Success!
                    } else {
                        console.warn(`[Collab-Mentions] Users save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}), hash mismatch`);
                    }
                } catch (verifyError) {
                    console.warn(`[Collab-Mentions] Users save verification failed (attempt ${attempt}/${MAX_SAVE_RETRIES}):`, verifyError);
                }

                // Wait a bit before retry
                if (attempt < MAX_SAVE_RETRIES) {
                    await new Promise(resolve => setTimeout(resolve, 100 * attempt));
                }
            }

            console.error('[Collab-Mentions] Failed to verify users save after', MAX_SAVE_RETRIES, 'attempts');
        } catch (error) {
            console.error('Failed to save users config:', error);
            new Notice('Failed to save user configuration');
        }
    }

    /**
     * Identify the current user based on local machine identifier
     */
    identifyCurrentUser(): VaultUser | null {
        const localId = this.getLocalIdentifier();
        this.currentUser = this.usersConfig.users.find(
            user => user.localIdentifier === localId
        ) || null;
        return this.currentUser;
    }

    /**
     * Register a new user or claim an existing vault name.
     * Uses file-level locking and retry logic to prevent race conditions.
     */
    async registerUser(vaultName: string): Promise<boolean> {
        const localId = this.getLocalIdentifier();
        const currentOS = this.getOS();

        // Retry loop with locking
        for (let attempt = 1; attempt <= MAX_REGISTRATION_RETRIES; attempt++) {
            console.log(`[Collab-Mentions] Registration attempt ${attempt}/${MAX_REGISTRATION_RETRIES}`);

            // Try to acquire lock
            const lockAcquired = await this.acquireLock();
            if (!lockAcquired) {
                if (attempt < MAX_REGISTRATION_RETRIES) {
                    // Wait and retry
                    const waitTime = 500 * attempt; // 500ms, 1s, 1.5s
                    console.log(`[Collab-Mentions] Could not acquire lock, waiting ${waitTime}ms...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                } else {
                    new Notice('Registration busy, please try again in a moment');
                    return false;
                }
            }

            try {
                // CRITICAL: Reload users from disk FIRST to get the latest state
                await this.loadUsers();
                console.log('[Collab-Mentions] Registration: Reloaded users, count:', this.usersConfig.users.length);

                // Check if this local identifier is already registered
                const existingByLocal = this.usersConfig.users.find(
                    user => user.localIdentifier === localId
                );

                if (existingByLocal) {
                    new Notice(`This machine is already registered as "${existingByLocal.vaultName}"`);
                    return false;
                }

                // Check if vault name is already taken
                const existingByName = this.usersConfig.users.find(
                    user => user.vaultName.toLowerCase() === vaultName.toLowerCase()
                );

                if (existingByName) {
                    new Notice(`The name "${vaultName}" is already taken by another user`);
                    return false;
                }

                // Generate a random color for the user
                const colors = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#7c2d12', '#4f46e5', '#0891b2'];
                const color = colors[this.usersConfig.users.length % colors.length];

                // Calculate registration number (next available)
                const maxRegNum = this.usersConfig.users.reduce((max, user) =>
                    Math.max(max, user.registrationNumber || 0), 0);
                const registrationNumber = maxRegNum + 1;

                // First user registered becomes primary admin
                const isFirstUser = registrationNumber === 1;

                // Register new user
                const newUser: VaultUser = {
                    vaultName: vaultName,
                    localIdentifier: localId,
                    os: currentOS,
                    registered: new Date().toISOString(),
                    registrationNumber: registrationNumber,
                    color: color,
                    isAdmin: isFirstUser,  // First user is automatically admin
                    adminLevel: isFirstUser ? 'primary' : undefined  // First user is primary admin
                };

                this.usersConfig.users.push(newUser);
                await this.saveUsers();

                // Verify registration succeeded by reloading and checking
                await this.loadUsers();
                const verifiedUser = this.usersConfig.users.find(
                    user => user.localIdentifier === localId && user.vaultName === vaultName
                );

                if (verifiedUser) {
                    this.currentUser = verifiedUser;
                    new Notice(`Successfully registered as "${vaultName}"`);
                    return true;
                } else {
                    // Registration was lost (race condition) - retry
                    console.log('[Collab-Mentions] Registration not verified, retrying...');
                    if (attempt >= MAX_REGISTRATION_RETRIES) {
                        new Notice('Registration failed, please try again');
                        return false;
                    }
                    continue;
                }
            } finally {
                // Always release the lock
                await this.releaseLock();
            }
        }

        new Notice('Registration failed after multiple attempts');
        return false;
    }

    /**
     * Unregister the current user
     * If the primary admin unregisters, promotes the next user by registration number
     */
    async unregisterCurrentUser(): Promise<boolean> {
        if (!this.currentUser) {
            new Notice('No user is currently registered on this machine');
            return false;
        }

        const index = this.usersConfig.users.findIndex(
            user => user.localIdentifier === this.currentUser?.localIdentifier
        );

        if (index !== -1) {
            const name = this.currentUser.vaultName;
            const wasPrimaryAdmin = this.currentUser.adminLevel === 'primary';

            // Track this user as recently deleted to prevent merge from re-adding
            this.recentlyDeletedUsers.set(this.currentUser.localIdentifier, Date.now());
            console.log('[Collab-Mentions] Tracking unregistered user:', name);

            this.usersConfig.users.splice(index, 1);

            // If the primary admin is leaving, promote the next user by registration number
            if (wasPrimaryAdmin && this.usersConfig.users.length > 0) {
                // Sort remaining users by registration number
                const sortedUsers = [...this.usersConfig.users].sort((a, b) =>
                    (a.registrationNumber || 999) - (b.registrationNumber || 999)
                );

                // Promote the user with lowest registration number to primary admin
                const newPrimaryAdmin = sortedUsers[0];
                const userInConfig = this.usersConfig.users.find(
                    u => u.vaultName === newPrimaryAdmin.vaultName
                );

                if (userInConfig) {
                    userInConfig.isAdmin = true;
                    userInConfig.adminLevel = 'primary';
                    console.log(`Primary admin left. Promoted ${userInConfig.vaultName} to primary admin.`);
                    new Notice(`${userInConfig.vaultName} has been promoted to primary admin`);
                }
            }

            await this.saveUsers();
            this.currentUser = null;
            new Notice(`Unregistered "${name}" from this machine`);
            return true;
        }

        return false;
    }

    /**
     * Get the current user
     */
    getCurrentUser(): VaultUser | null {
        return this.currentUser;
    }

    /**
     * Get all registered users
     */
    getAllUsers(): VaultUser[] {
        return this.usersConfig.users;
    }

    /**
     * Get a user by vault name
     */
    getUserByName(vaultName: string): VaultUser | undefined {
        return this.usersConfig.users.find(
            user => user.vaultName.toLowerCase() === vaultName.toLowerCase()
        );
    }

    /**
     * Check if the current machine is registered
     */
    isRegistered(): boolean {
        return this.currentUser !== null;
    }

    // ===== Admin Methods =====

    /**
     * Check if the current user is an admin
     */
    isCurrentUserAdmin(): boolean {
        return this.currentUser?.isAdmin === true;
    }

    /**
     * Check if the current user is the primary admin
     */
    isCurrentUserPrimaryAdmin(): boolean {
        return this.currentUser?.isAdmin === true && this.currentUser?.adminLevel === 'primary';
    }

    /**
     * Check if a specific user is an admin
     */
    isUserAdmin(vaultName: string): boolean {
        const user = this.getUserByName(vaultName);
        return user?.isAdmin === true;
    }

    /**
     * Check if a specific user is the primary admin
     */
    isUserPrimaryAdmin(vaultName: string): boolean {
        const user = this.getUserByName(vaultName);
        return user?.isAdmin === true && user?.adminLevel === 'primary';
    }

    /**
     * Get all admin users
     */
    getAdmins(): VaultUser[] {
        return this.usersConfig.users.filter(user => user.isAdmin === true);
    }

    /**
     * Get the primary admin
     */
    getPrimaryAdmin(): VaultUser | undefined {
        return this.usersConfig.users.find(user => user.adminLevel === 'primary');
    }

    /**
     * Promote a user to secondary admin (requires current user to be PRIMARY admin)
     */
    async promoteToAdmin(vaultName: string): Promise<boolean> {
        if (!this.isCurrentUserPrimaryAdmin()) {
            new Notice('Only the primary admin can promote other users');
            return false;
        }

        const user = this.usersConfig.users.find(
            u => u.vaultName.toLowerCase() === vaultName.toLowerCase()
        );

        if (!user) {
            new Notice(`User "${vaultName}" not found`);
            return false;
        }

        if (user.isAdmin) {
            new Notice(`${vaultName} is already an admin`);
            return false;
        }

        user.isAdmin = true;
        user.adminLevel = 'secondary';  // Promoted admins are always secondary
        await this.saveUsers();
        new Notice(`${vaultName} is now a secondary admin`);
        return true;
    }

    /**
     * Demote a user from admin (requires current user to be PRIMARY admin)
     * Cannot demote the primary admin
     */
    async demoteFromAdmin(vaultName: string): Promise<boolean> {
        if (!this.isCurrentUserPrimaryAdmin()) {
            new Notice('Only the primary admin can demote other admins');
            return false;
        }

        const user = this.usersConfig.users.find(
            u => u.vaultName.toLowerCase() === vaultName.toLowerCase()
        );

        if (!user) {
            new Notice(`User "${vaultName}" not found`);
            return false;
        }

        if (!user.isAdmin) {
            new Notice(`${vaultName} is not an admin`);
            return false;
        }

        // Cannot demote the primary admin
        if (user.adminLevel === 'primary') {
            new Notice('Cannot demote the primary admin');
            return false;
        }

        user.isAdmin = false;
        user.adminLevel = undefined;
        await this.saveUsers();
        new Notice(`${vaultName} is no longer an admin`);
        return true;
    }

    /**
     * Remove a user from the system (admin only)
     */
    async removeUser(vaultName: string): Promise<boolean> {
        if (!this.isCurrentUserAdmin()) {
            new Notice('Only admins can remove users');
            return false;
        }

        // Cannot remove yourself
        if (this.currentUser?.vaultName.toLowerCase() === vaultName.toLowerCase()) {
            new Notice('Cannot remove yourself. Use unregister instead.');
            return false;
        }

        const index = this.usersConfig.users.findIndex(
            u => u.vaultName.toLowerCase() === vaultName.toLowerCase()
        );

        if (index === -1) {
            new Notice(`User "${vaultName}" not found`);
            return false;
        }

        // Track this user as recently deleted to prevent merge from re-adding
        const userToRemove = this.usersConfig.users[index];
        this.recentlyDeletedUsers.set(userToRemove.localIdentifier, Date.now());
        console.log('[Collab-Mentions] Tracking deleted user:', userToRemove.vaultName, userToRemove.localIdentifier);

        this.usersConfig.users.splice(index, 1);
        await this.saveUsers();
        new Notice(`Removed user "${vaultName}"`);
        return true;
    }
}