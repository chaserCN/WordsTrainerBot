import { readFile } from "node:fs/promises";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const wait = args.has("--wait");
const consume = args.has("--consume");

await loadDotEnv(path.resolve(".env"));

const token = requiredEnv("TELEGRAM_BOT_TOKEN");
const apiBase = `https://api.telegram.org/bot${token}/`;

if (args.has("--help")) {
  console.log([
    "Usage:",
    "  npm run updates",
    "  npm run updates -- --wait",
    "  npm run updates -- --consume",
    "",
    "--wait     poll for up to 60 seconds until an update arrives",
    "--consume  acknowledge printed updates so they disappear from future getUpdates calls",
  ].join("\n"));
  process.exit(0);
}

const me = await telegram("getMe");
console.log(`Bot: @${me.username} (${me.first_name}, id ${me.id})`);

const webhook = await telegram("getWebhookInfo");
console.log(`Webhook: ${webhook.url ? "enabled" : "disabled"}, pending updates: ${webhook.pending_update_count}`);

let updates = await getUpdates();
if (wait && updates.length === 0) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && updates.length === 0) {
    await sleep(2_000);
    updates = await getUpdates();
  }
}

printUpdates(updates);

if (consume && updates.length > 0) {
  const maxUpdateId = Math.max(...updates.map((update) => update.update_id));
  await getUpdates({ offset: maxUpdateId + 1 });
  console.log(`Consumed updates through update_id ${maxUpdateId}.`);
}

async function getUpdates(options = {}) {
  const url = new URL("getUpdates", apiBase);
  url.searchParams.set("timeout", "0");
  url.searchParams.set("allowed_updates", JSON.stringify([
    "message",
    "edited_message",
    "channel_post",
    "my_chat_member",
    "chat_member",
  ]));
  if (options.offset != null) {
    url.searchParams.set("offset", String(options.offset));
  }
  return await telegramUrl(url);
}

function printUpdates(updates) {
  console.log(`Updates: ${updates.length}`);
  if (updates.length === 0) {
    console.log("No updates. Send /start@LoritoFlashcardsBot in the group after adding the bot.");
    return;
  }

  const chats = new Map();
  for (const update of updates) {
    const event = eventFromUpdate(update);
    if (!event) {
      console.log(`${update.update_id}: unsupported update`);
      continue;
    }

    if (event.chat) {
      chats.set(String(event.chat.id), event.chat);
    }

    const chatLabel = event.chat ? formatChat(event.chat) : "no chat";
    const fromLabel = event.from ? formatUser(event.from) : "no sender";
    const text = event.text ? ` text=${JSON.stringify(event.text)}` : "";
    console.log(`${update.update_id}: ${event.kind} ${chatLabel}; from ${fromLabel}${text}`);
  }

  console.log("Chats:");
  for (const chat of chats.values()) {
    console.log(`  ${formatChat(chat)}`);
  }
}

function eventFromUpdate(update) {
  for (const kind of ["message", "edited_message", "channel_post", "my_chat_member", "chat_member"]) {
    const event = update[kind];
    if (event) {
      return {
        kind,
        chat: event.chat ? keepChat(event.chat) : null,
        from: event.from ? keepUser(event.from) : null,
        text: event.text || null,
      };
    }
  }
  return null;
}

function keepChat(chat) {
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title || null,
    username: chat.username || null,
    first_name: chat.first_name || null,
  };
}

function keepUser(user) {
  return {
    id: user.id,
    username: user.username || null,
    first_name: user.first_name || null,
  };
}

function formatChat(chat) {
  const name = chat.title || chat.username || chat.first_name || "unnamed";
  return `${name} (${chat.type}, id ${chat.id})`;
}

function formatUser(user) {
  const name = user.username ? `@${user.username}` : user.first_name || "unnamed";
  return `${name}, id ${user.id}`;
}

async function telegram(method) {
  return await telegramUrl(new URL(method, apiBase));
}

async function telegramUrl(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Telegram API failed: ${payload.description || response.statusText}`);
  }
  return payload.result;
}

async function loadDotEnv(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] ??= value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
