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


## Maker health and growth

The person who lists a bot from the chat gets:

- an alert if the bot's public Telegram page disappears (deleted, banned or renamed) and another when it returns
- a weekly report with Kiver upvotes and Telegram monthly users, with changes since the last report
- `/mybots` to see their bots and `/alerts on|off` to control the messages

Admin chats are never tracked: bots an admin lists create no alerts or data. An admin chat is remembered once it has entered the admin key.

Data is stored in Postgres (`KIVER_MAKER_DB_URL`, tables `mh_*`, created automatically). If the variable is missing the feature stays off and everything else works as before. Tuning: `KIVER_HEALTH_INTERVAL_MIN` (default 20), `KIVER_DIGEST_DAYS` (default 7).
