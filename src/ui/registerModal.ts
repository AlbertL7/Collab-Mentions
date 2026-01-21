import { App, Modal, Setting, Notice } from 'obsidian';
import { UserManager } from '../userManager';

export class RegisterModal extends Modal {
    private userManager: UserManager;
    private onRegister: () => void;

    constructor(app: App, userManager: UserManager, onRegister: () => void) {
        super(app);
        this.userManager = userManager;
        this.onRegister = onRegister;
    }

    onOpen(): void {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: '👤 Register for Collab Mentions' });

        const localId = this.userManager.getLocalIdentifier();
        const os = this.userManager.getOS();

        contentEl.createEl('p', {
            text: 'Register your identity to use @mentions in this shared vault.',
            cls: 'setting-item-description'
        });

        contentEl.createEl('div', {
            text: `Your machine: ${localId} (${os})`,
            cls: 'collab-machine-info'
        });

        let vaultName = '';

        new Setting(contentEl)
            .setName('Your display name')
            .setDesc('This is how others will @mention you (e.g., @Albert)')
            .addText(text => text
                .setPlaceholder('Enter your name')
                .onChange(value => {
                    vaultName = value.trim();
                })
            );

        // Show existing users
        const existingUsers = this.userManager.getAllUsers();
        if (existingUsers.length > 0) {
            contentEl.createEl('h4', { text: 'Existing team members:' });
            const userList = contentEl.createEl('ul', { cls: 'collab-user-list' });
            for (const user of existingUsers) {
                const li = userList.createEl('li');
                li.createEl('span', {
                    text: `@${user.vaultName}`,
                    cls: 'collab-username'
                });
                li.createEl('span', {
                    text: ` (${user.os})`,
                    cls: 'collab-user-os'
                });
            }
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Register')
                .setCta()
                .onClick(async () => {
                    if (!vaultName) {
                        new Notice('Please enter a display name');
                        return;
                    }

                    if (vaultName.includes(' ')) {
                        new Notice('Display name cannot contain spaces');
                        return;
                    }

                    if (!/^[a-zA-Z0-9_]+$/.test(vaultName)) {
                        new Notice('Display name can only contain letters, numbers, and underscores');
                        return;
                    }

                    const success = await this.userManager.registerUser(vaultName);
                    if (success) {
                        this.onRegister();
                        this.close();
                    }
                })
            )
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                })
            );
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class UserManagementModal extends Modal {
    private userManager: UserManager;
    private onUpdate: () => void;

    constructor(app: App, userManager: UserManager, onUpdate: () => void) {
        super(app);
        this.userManager = userManager;
        this.onUpdate = onUpdate;
    }

    onOpen(): void {
        this.render();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: '👥 Team Members' });

        const currentUser = this.userManager.getCurrentUser();
        const allUsers = this.userManager.getAllUsers();
        const isAdmin = this.userManager.isCurrentUserAdmin();

        if (currentUser) {
            const userInfo = contentEl.createEl('p', { cls: 'collab-current-user' });
            userInfo.createEl('span', { text: `You are registered as: @${currentUser.vaultName}` });
            if (isAdmin) {
                userInfo.createEl('span', { text: ' (Admin)', cls: 'collab-admin-badge' });
            }
        }

        contentEl.createEl('h4', { text: 'Registered team members:' });

        if (allUsers.length === 0) {
            contentEl.createEl('p', {
                text: 'No users registered yet.',
                cls: 'setting-item-description'
            });
        } else {
            const tableWrapper = contentEl.createEl('div', { cls: 'collab-users-table-wrapper' });
            const table = tableWrapper.createEl('table', { cls: 'collab-users-table' });

            const headerRow = table.createEl('tr');
            headerRow.createEl('th', { text: 'Name' });
            headerRow.createEl('th', { text: 'Role' });
            headerRow.createEl('th', { text: 'Machine' });
            headerRow.createEl('th', { text: 'OS' });
            headerRow.createEl('th', { text: 'Registered' });
            if (isAdmin) {
                headerRow.createEl('th', { text: 'Actions' });
            }

            for (const user of allUsers) {
                const row = table.createEl('tr');

                // Name cell
                const nameCell = row.createEl('td');
                nameCell.createEl('span', {
                    text: `@${user.vaultName}`,
                    cls: 'collab-username'
                });

                if (currentUser && user.localIdentifier === currentUser.localIdentifier) {
                    nameCell.createEl('span', {
                        text: ' (you)',
                        cls: 'collab-you-tag'
                    });
                }

                // Role cell - show registration # and admin level
                const roleCell = row.createEl('td');
                if (user.isAdmin) {
                    const adminText = user.adminLevel === 'primary' ? 'Primary Admin' : 'Secondary Admin';
                    roleCell.createEl('span', {
                        text: adminText,
                        cls: user.adminLevel === 'primary' ? 'collab-admin-badge collab-primary-admin' : 'collab-admin-badge'
                    });
                } else {
                    roleCell.createEl('span', { text: 'Member', cls: 'collab-member-badge' });
                }
                // Show registration number
                if (user.registrationNumber) {
                    roleCell.createEl('span', {
                        text: ` #${user.registrationNumber}`,
                        cls: 'collab-registration-number'
                    });
                }

                row.createEl('td', { text: user.localIdentifier.split('@')[1] || user.localIdentifier });
                row.createEl('td', { text: user.os });
                row.createEl('td', { text: new Date(user.registered).toLocaleDateString() });

                // Actions cell (primary admin only for promote/demote)
                const isPrimaryAdmin = this.userManager.isCurrentUserPrimaryAdmin();
                if (isAdmin) {
                    const actionsCell = row.createEl('td', { cls: 'collab-actions-cell' });
                    const isCurrentUserRow = currentUser && user.localIdentifier === currentUser.localIdentifier;
                    const isTargetPrimaryAdmin = user.adminLevel === 'primary';

                    // Promote/Demote button - only primary admin can do this, and cannot demote primary admin
                    if (isPrimaryAdmin && !isTargetPrimaryAdmin && !isCurrentUserRow) {
                        const adminBtn = actionsCell.createEl('button', {
                            text: user.isAdmin ? 'Demote' : 'Promote',
                            cls: 'collab-action-btn'
                        });
                        adminBtn.addEventListener('click', async () => {
                            if (user.isAdmin) {
                                await this.userManager.demoteFromAdmin(user.vaultName);
                            } else {
                                await this.userManager.promoteToAdmin(user.vaultName);
                            }
                            this.render();
                            this.onUpdate();
                        });
                    }

                    // Remove button (can't remove yourself or the primary admin)
                    if (!isCurrentUserRow && !isTargetPrimaryAdmin) {
                        const removeBtn = actionsCell.createEl('button', {
                            text: 'Remove',
                            cls: 'collab-action-btn collab-action-btn-danger'
                        });
                        removeBtn.addEventListener('click', async () => {
                            const confirmed = confirm(
                                `Are you sure you want to remove "${user.vaultName}" from the team?`
                            );
                            if (confirmed) {
                                await this.userManager.removeUser(user.vaultName);
                                this.render();
                                this.onUpdate();
                            }
                        });
                    }
                }
            }
        }

        const footerEl = contentEl.createEl('div', { cls: 'collab-modal-footer' });

        if (currentUser) {
            new Setting(footerEl)
                .addButton(btn => btn
                    .setButtonText('Unregister Me')
                    .setWarning()
                    .onClick(async () => {
                        const confirmed = confirm(
                            `Are you sure you want to unregister "${currentUser.vaultName}" from this machine?`
                        );

                        if (confirmed) {
                            await this.userManager.unregisterCurrentUser();
                            this.onUpdate();
                            this.close();
                        }
                    })
                )
                .addButton(btn => btn
                    .setButtonText('Close')
                    .onClick(() => this.close())
                );
        } else {
            new Setting(footerEl)
                .addButton(btn => btn
                    .setButtonText('Register')
                    .setCta()
                    .onClick(() => {
                        this.close();
                        new RegisterModal(this.app, this.userManager, this.onUpdate).open();
                    })
                )
                .addButton(btn => btn
                    .setButtonText('Close')
                    .onClick(() => this.close())
                );
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}