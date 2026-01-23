# Collab Mentions

**Know exactly where and what to look at when sharing your Obsidian vault for collaboration.**
--- 
**Tested environments**

This plugin has been tested using file-based synchronization with **Google Drive** between Windows and macOS systems.

**Not tested on**

The plugin has not been tested with the following sync methods:

- Obsidian Sync
- OneDrive
- Dropbox
- iCloud

**Sync testing notes**

This plugin was tested using Google Drive for file-based synchronization between Windows and macOS. Cross-platform behavior was verified under this setup.

The plugin has not been tested with Obsidian Sync or other cloud sync providers, including OneDrive, Dropbox, or iCloud. It should work fine on other sync platforms but again has not been tested properly.
--- 
When you share an Obsidian vault with teammates via Google Drive, OneDrive, Dropbox, or any file sync service, you face a fundamental problem: **How do you know what changed? What should you be looking at? Did your teammate see the note you updated?**

Collab Mentions solves this by letting you @mention teammates directly in your notes. Drop a `@Albert` in any note, and Albert gets notified to look at it. You can see when they've read it. No more guessing, no more "hey did you see that file I updated?"

## The Problem

Shared vaults are powerful, but they lack awareness:
- You update a note — does your teammate know to look at it?
- Your teammate makes changes — which files should you review?
- You leave a comment in a note — did they ever see it?
- Important updates get buried in a sea of synced files

**Collab Mentions adds the missing layer: directed attention and read receipts for shared vaults.**

## How It Works

1. **Share a vault** via Google Drive, OneDrive, Dropbox, or any sync service
2. **@mention teammates** in any note when you want their attention
3. **Get notified** when someone mentions you — you know exactly where to look
4. **See read receipts** — know when your teammate has seen your mention

That's the core. Everything else (chat, presence, reminders) is built on top of this foundation.

## Important: Sync Speed

Because this plugin works through file sync services (not direct servers), **updates are not instant**. Expect:
- **3-10 seconds** for changes to sync on fast connections and sync service you decided to use
- **Longer delays** depending on your sync service and internet speed
- **Occasional conflicts** A work in progress

This is the tradeoff for serverless simplicity. If you need instant, real-time collaboration, you'd need a server-based solution. Collab Mentions prioritizes **privacy, simplicity, and zero infrastructure** over speed.

## Why Collab Mentions?

<img width="675" height="993" alt="2026-01-21 21_04_35-" src="https://github.com/user-attachments/assets/25a25b65-dd31-4a95-8c58-381c95b02527" />

<img width="1555" height="1027" alt="2026-01-21 21_05_24-" src="https://github.com/user-attachments/assets/658f6ea9-7455-4df6-a8f1-12c447ea0ae3" />


- **Serverless** — All data lives in your vault, syncs through your existing service
- **Zero Configuration** — No servers, no accounts, no APIs
- **Privacy First** — Your conversations never leave your vault
- **Works Offline** — Full functionality, syncs when reconnected
- **No Login Required** — Your identity is tied to your machine

Perfect for small teams, I would say no more than 7 - 10 (Was only tested with 3) people, couples, families, research groups, or anyone sharing an Obsidian vault who wants to actually know what they should be looking at.

---

## Features at a Glance

| Feature | Description |
|---------|-------------|
| **@Mentions** | Tag teammates in notes — the core feature |
| **Read Receipts** | Know when they've seen your mention |
| **Team Chat** | Side communication without cluttering notes |
| **Presence** | See who's Active, Snoozing, or Offline |
| **Reminders** | Personal and team-wide reminders |
| **Admin System** | Manage who has access |

---

## Core Features

### @Mentions in Notes (The Main Feature)

This is why the plugin exists. When you want a teammate to look at something:

1. Type `@` in any note
2. Select their name from autocomplete
3. Save the note, this will happen automatically through your sync service. Like I said it may take a few seconds and the longest I have seen is a minute but usualy 10 - 15 seconds on average.
4. They get notified and know exactly where to look

**What you get:**
- **Smart Autocomplete** — Type `@` anywhere to see teammate suggestions
- **Popup Notifications** — Recipients see a notification when mentioned
- **Read Receipts** — See when your mentions have been read (and when)
- **Inbox & Sent** — Track mentions you've received and sent
- **Jump to File** — Click any mention to open that note instantly
- **Auto-Cleanup** — Keeps only recent mentions to prevent file bloat

**This solves the core problem:** You'll never wonder "did they see my update?" again.

### Team Chat (Supplementary)

Sometimes you need to have a quick conversation without cluttering your notes with back-and-forth comments. The built-in chat keeps side discussions separate from your actual content.

- **Channels** — General (everyone), Groups (selected members), DMs (1-on-1)
- **Rich Messaging** — Edit, delete, reply, emoji reactions
- **@Mentions in Chat** — `@username`, `@everyone`, `@#channelname`
- **File Links** — Reference vault files with `[[filename]]`
- **Image Sharing** — Paste from clipboard or upload
- **Search** — Find messages across all channels
- **Export** — Save chat history to markdown before deleting

### Presence & Status
- **Real-Time Status Detection a work in progress**
  - **Active** (green) — File activity within last 5 minutes
  - **Snooze** (orange) — Vault open but idle for 5+ minutes
  - **Offline** (gray) — Vault closed
- **Manual Status Override for when automatic does not seem to be working correctly** — Set yourself as Active, Snooze, or Appear Offline
- **Activity Tracking** — Status based on actual file interactions

### Reminders
- **Personal Reminders** — Private reminders only you can see
- **Global Reminders** — Team-wide reminders visible to everyone
- **Priority Levels** — Low, Normal, or High priority
- **Recurring Options** — Daily, weekly, or monthly schedules
- **File Links** — Attach reminders to specific vault files
- **Smart Notifications** — Snooze, complete, or dismiss when due

### Admin System
- **Role Hierarchy**
  - **Primary Admin** — Full control, can promote/demote users (The first user to register is Primary)
  - **Secondary Admin** — Can remove users, cannot manage admins
  - **Member** — Standard user
- **Automatic Succession** — If primary admin leaves, next user is auto-promoted
- **Registration Numbers** — Users numbered by join order (#1, #2, etc.)
- **User Management** — Admins can remove users from the vault

---

## The Mention Panel

Access everything from the sidebar panel (click the `@` icon in the ribbon):

| Tab | Purpose |
|-----|---------|
| **Inbox** | Mentions others have sent to you |
| **Sent** | Mentions you've sent (with read receipts) |
| **Team** | Contact list with live status indicators |
| **Chat** | Multi-channel team messaging |
| **Reminders** | Personal and global reminders |

---

## How It Works

### The Serverless Approach

1. **Shared Vault** — Your team shares a vault folder via any file sync service
2. **Local Data Files** — Plugin stores data in `.collab-mentions/` folder
3. **File Sync** — Your sync service handles replication across machines
4. **Conflict Resolution** — Smart merge logic handles simultaneous edits

### Identity System

Your identity is your machine:
```
username@hostname (e.g., Albert@DESKTOP-ABC123)
```

This means:
- No accounts or passwords
- No server authentication
- Identity travels with your machine
- Each machine = one user

### Real-Time Updates

- **File Watcher** — Checks for changes every 3 seconds
- **Heartbeat** — Updates your presence every 10 seconds
- **Smart Notifications** — Only alerts for genuinely new content

---

## Installation

### Manual Installation

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`)
2. Create folder: `.obsidian/plugins/collab-mentions/`
3. Copy files into that folder
4. Enable in Obsidian Settings → Community Plugins

### Building from Source

```bash
git clone <repository-url>
cd collab-mentions
npm install
npm run build
# Copy main.js, manifest.json, styles.css to your vault
```

---

## Quick Start Guide

### 1. Register Yourself

1. Enable the plugin
2. Click the `@` icon in the ribbon
3. Enter your display name (e.g., "Albert")
4. Done! (First user becomes Primary Admin)

### 2. Mention a Teammate

1. Open any note
2. Type `@` and start typing a name
3. Select from autocomplete
4. Save the note — they'll be notified!

### 3. Start Chatting

1. Open the Mention Panel → Chat tab
2. Click **+ New** to create a group or DM
3. Select members and start messaging

### 4. Set a Reminder

1. Open the Mention Panel → Reminders tab
2. Click **+ New Reminder**
3. Set message, date/time, and priority
4. Toggle "Global" to notify the whole team

---

## Chat Features in Detail

### Channel Types

| Type | Icon | Description |
|------|------|-------------|
| General | `#` | Default channel, everyone has access |
| Group | `#` | Custom channel with selected members |
| DM | `@` | Direct message between users |

### Message Actions

| Action | How |
|--------|-----|
| Send | Type message, press Enter |
| New line | Shift + Enter |
| Reply | Click reply icon on message |
| Edit | Click edit icon (your messages only) |
| Delete | Click delete icon |
| React | Click emoji button |
| @Mention | Type `@username` |
| @Channel | Type `@#channelname` |
| @Everyone | Type `@everyone` |
| Link file | Type `[[filename]]` |
| Share image | Paste or click image button |

### Channel Management

| Action | How |
|--------|-----|
| Create channel | Click **+ New** |
| Add member | Click **+ Add** in channel header |
| Leave channel | Click **Leave** button |
| Mute channel | Click mute icon |
| Delete channel | Click **Delete** (creator only) |
| Export & Delete | Choose to export chat before deleting |

---

## Presence System

### Status Indicators

| Status | Color | Meaning |
|--------|-------|---------|
| Active | Green | Recent file activity (< 5 min) |
| Snooze | Orange | Vault open, idle (> 5 min) |
| Offline | Gray | Vault closed (> 30 sec) |

### Manual Override

In the Team tab, set your status:
- **Automatic** — Let the system detect
- **Active** — Always show as active
- **Snooze** — Always show as snoozing
- **Appear Offline** — Hide your presence

---

## Notifications

### What Triggers Notifications

| Event | Notification |
|-------|--------------|
| Someone @mentions you in a note | Centered popup |
| Someone @mentions you in chat | Centered popup |
| You're added to a channel | Centered popup |
| Reminder is due | Modal with snooze/complete |
| Unread messages on startup | Summary popup |
| Return from snooze | "Welcome back" with counts |

### Notification Settings

- **Enable notifications** — Master toggle
- **Notification sound** — Audio alerts

---

## Data Storage

The plugin creates a `.collab-mentions/` folder:

```
.collab-mentions/
├── users.json        # Registered users & admin status
├── mentions.json     # @mentions with read state
├── presence.json     # Online status & manual overrides
├── chat.json         # Channels, messages, read state
├── reminders.json    # Personal & global reminders
└── images/           # Shared chat images

collab-mentions/      # (created when exporting chats)
└── ChannelName_2024-01-15_10-30-00.md
```

These files sync with your vault, enabling collaboration.

---

## Settings

### Monitoring

| Setting | Default | Description |
|---------|---------|-------------|
| Enable file watcher | ON | Check for changes every 3 seconds |

### Notifications

| Setting | Default | Description |
|---------|---------|-------------|
| Enable notifications | ON | Show popup alerts |
| Notification sound | ON | Play audio for alerts |

### Cleanup

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-cleanup | ON | Limit mentions per user |
| Max mentions | 30 | How many to keep |
| Cleanup interval | 24h | How often to run |

### Appearance

| Setting | Default | Description |
|---------|---------|-------------|
| Highlight mentions | ON | Style @mentions in editor |
| Highlight color | #7c3aed | Color for highlights |

---

## Commands

| Command | Description |
|---------|-------------|
| Open mentions panel | Show the sidebar |
| Register / Manage user | Set up or manage identity |
| Check for new mentions | Manual refresh |
| Mark all mentions as read | Clear unread count |

---

## Sync Conflict Handling

The plugin includes robust conflict resolution for file sync services:

- **Message Protection** — Recently sent messages are preserved during sync conflicts
- **Channel Protection** — Recently created/deleted channels are protected
- **Member Protection** — Recently added/removed members are preserved
- **Checksum Validation** — Detects incomplete file syncs
- **Retry Logic** — Automatic retries with exponential backoff

---

## Troubleshooting

### Mentions not appearing
- Check vault sync status
- Verify both users are registered
- Confirm `.collab-mentions/` folder exists

### No notifications
- Enable notifications in settings
- Enable file watcher in settings
- Allow up to 3 seconds for detection

### Status not updating
- Presence updates every 10 seconds
- Click a file to trigger activity
- Check manual status isn't overriding

### Can't see admin options
- Only Primary Admin can promote/demote
- Check your status in Team tab

### Chat issues
- Unread counts are per-user
- Muted channels hide badges
- Try leaving and re-entering channel

### Reminders not firing
- Check notifications are enabled
- Global reminders notify everyone
- Personal reminders only notify creator

---

## Performance

- **File watcher**: 3-second intervals (minimal CPU)
- **Heartbeat**: 10-second intervals
- **Message limit**: 200 per channel (auto-trimmed)
- **Cleanup**: Runs daily, keeps files small
- **Recommended max mentions**: 30-50 per user

---

## Privacy & Security

- **No external servers** — All data stays in your vault
- **No accounts** — Machine-based identity
- **No telemetry** — Nothing sent anywhere
- **Your sync service** — You control the infrastructure
- **Visible identity** — Teammates see your `username@hostname`

---

## Roadmap

### Completed
- [x] @mentions with autocomplete
- [x] Real-time file watching
- [x] Presence tracking (Active/Snooze/Offline)
- [x] Manual status override
- [x] Multi-channel chat (General, Groups, DMs)
- [x] Per-user unread tracking
- [x] Emoji reactions
- [x] Message edit/delete/reply
- [x] Image sharing
- [x] File linking in chat
- [x] @everyone mentions
- [x] @#channel mentions
- [x] Typing indicators
- [x] Message search
- [x] Export chat history
- [x] Personal and global reminders
- [x] Recurring reminders
- [x] Admin system
- [x] Centered modal notifications
- [x] Mute channels
- [x] Inbox filtering

### Planned
- [ ] Desktop notifications (outside Obsidian)
- [ ] Message threads
- [ ] Pin important messages
- [ ] Channel categories/folders
- [ ] Custom emoji reactions

---

## License

MIT License - Bulwark Black LLC

## Support

For issues or feature requests, please open an issue on GitHub.

---

**Finally know what to look at in your shared vault. No servers, no accounts, no hassle.**
