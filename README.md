# Kiver Listing Bot

Private automation bot for Get Kiver.

Users send one public Telegram bot link. The bot:
- checks the Telegram public page for name, About, description and profile image
- requires a profile photo
- requires About text between 50 and 255 characters
- applies deterministic rejection filters
- checks for duplicates
- creates the listing through Kiver's existing database contract
- posts the new listing to the configured Kiver Telegram channel

AI screening is intentionally not included in v1.


## Self-destructing chat messages

To keep the private chat clean, every conversation message is deleted automatically, both the user's and the bot's.

- **Link submissions:** the link, the "Checking..." note and the result (listed, rejected or error) are deleted together `KIVER_MSG_TTL_SECONDS` (default 90) after the outcome.
- **Admin panel:** the Admin Panel tap, prompts, menu and results are deleted after `KIVER_ADMIN_MSG_TTL_SECONDS` (default 150). The message containing the admin key is deleted immediately.
- **Never deleted:** the `/start` command, the bot's welcome reply, and channel announcements.

Pending deletions are saved to `KIVER_DATA_DIR`, so they survive a restart as long as that directory is persistent.
