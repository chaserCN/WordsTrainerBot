# Words Trainer Telegram Bot

Telegram bot for learner activity reports and reminders.

The bot reads activity from the server admin endpoint:

```text
GET /v1/admin/users/:userId/daily-activity
```

It sends a morning report for yesterday and evening reminders for learners who
have not studied today.

## Setup

```bash
cp .env.example .env
npm run dry-run
npm run dry-run-reminders
npm start
```

`npm run dry-run` prints the message locally and does not require Telegram
token/chat id.

Required env:

- `TELEGRAM_BOT_TOKEN` - token from BotFather. Required for real sends.
- `TELEGRAM_CHAT_ID` - channel/group/user chat id, for example `@channelname`.
  Required for real sends.
- `WORDS_TRAINER_API_BASE_URL` - server base URL.
- `WORDS_TRAINER_ADMIN_API_KEY` - server admin API key.

The bot reports all server users with role `learner`.

Schedule:

- `09:00` - one combined morning report for yesterday.
- `21:00` - separate reminders for learners with no activity today.
- `21:05` - the same reminder job can run again as a safety check. State keys
  prevent duplicate reminders if the `21:00` run already worked.

Optional env:

- `REPORT_TIME_ZONE` - defaults to `Europe/Kyiv`.
- `MORNING_REPORT_HOUR` / `MORNING_REPORT_MINUTE` - local morning report time.
  Defaults to `09:00`.
- `EVENING_REMINDER_HOUR` / `EVENING_REMINDER_MINUTE` - local reminder time.
  Defaults to `21:00`.
- `EVENING_REMINDER_RETRY_MINUTE` - local retry minute for the reminder job.
  Defaults to `5`, so the safety check is `21:05`.
- `POLL_INTERVAL_SECONDS` - scheduler check interval. Defaults to `60`.
- `TELEGRAM_COMMAND_POLL_TIMEOUT_SECONDS` - Telegram long-poll timeout for
  commands. Defaults to `25`.
- `STATE_FILE` - file used to prevent duplicate daily sends.
- `LLM_ENABLED` - enables LLM formatting when `true`. Defaults to enabled only
  if a provider API key is set.
- `LLM_PROVIDER` - `gemini`, `openai`, or `anthropic`.
- `GEMINI_API_KEY` - Gemini API key.
- `GEMINI_MODEL` - defaults to `gemini-2.5-flash`.
- `GEMINI_API_BASE_URL` - defaults to the public Gemini v1beta REST API.
- `OPENAI_API_KEY` - OpenAI API key.
- `OPENAI_MODEL` - defaults to `gpt-5.4`.
- `OPENAI_API_BASE_URL` - defaults to `https://api.openai.com/v1`.
- `ANTHROPIC_API_KEY` - Anthropic API key.
- `ANTHROPIC_MODEL` - defaults to `claude-haiku-4-5`.
- `ANTHROPIC_API_BASE_URL` - defaults to `https://api.anthropic.com`.

The LLM is used only to phrase the Telegram message. The numeric facts always
come from the Words Trainer server. If the provider fails, the bot falls back
to a plain deterministic template.
The learner's Russian display name and grammatical gender come from the server
user profile.

## Commands

Telegram commands:

```text
/stats - send today's group activity report
```

```bash
npm run dry-run
npm run dry-run-stats
npm run dry-run-reminders
npm run once
npm run morning
npm run stats
npm run reminders
npm start
node src/index.mjs --once --job=stats
node src/index.mjs --once --job=morning-report --date=2026-06-04
node src/index.mjs --once --job=evening-reminders --date=2026-06-04
node src/index.mjs --once --job=due
node src/index.mjs --once --dry-run --provider=gemini
node src/index.mjs --once --dry-run --provider=openai
node src/index.mjs --once --dry-run --provider=anthropic
```
