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
