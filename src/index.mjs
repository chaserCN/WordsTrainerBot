import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

await loadDotEnv();

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs.filter((arg) => !arg.startsWith("--date=")
  && !arg.startsWith("--provider=")
  && !arg.startsWith("--job=")));
const dateArg = rawArgs.find((arg) => arg.startsWith("--date="))?.slice("--date=".length);
const providerArg = rawArgs.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length);
const jobArg = rawArgs.find((arg) => arg.startsWith("--job="))?.slice("--job=".length);
const dryRun = args.has("--dry-run");
const reminderText = "Повтори картыыыыыы. Хотя бы 5 минут.";

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

const config = {
  telegramToken: dryRun ? process.env.TELEGRAM_BOT_TOKEN || "" : requiredEnv("TELEGRAM_BOT_TOKEN"),
  telegramChatId: dryRun ? process.env.TELEGRAM_CHAT_ID || "" : requiredEnv("TELEGRAM_CHAT_ID"),
  apiBaseUrl: requiredEnv("WORDS_TRAINER_API_BASE_URL").replace(/\/+$/, ""),
  adminApiKey: requiredEnv("WORDS_TRAINER_ADMIN_API_KEY"),
  timeZone: process.env.REPORT_TIME_ZONE || "Europe/Kyiv",
  morningReportHour: integerEnv("MORNING_REPORT_HOUR", 9),
  morningReportMinute: integerEnv("MORNING_REPORT_MINUTE", 0),
  eveningReminderHour: integerEnv("EVENING_REMINDER_HOUR", 21),
  eveningReminderMinute: integerEnv("EVENING_REMINDER_MINUTE", 0),
  eveningReminderRetryMinute: integerEnv("EVENING_REMINDER_RETRY_MINUTE", 5),
  pollIntervalSeconds: integerEnv("POLL_INTERVAL_SECONDS", 60),
  telegramCommandPollTimeoutSeconds: integerEnv("TELEGRAM_COMMAND_POLL_TIMEOUT_SECONDS", 25),
  stateFile: process.env.STATE_FILE || ".state/daily-report.json",
  llmProvider: provider(providerArg || process.env.LLM_PROVIDER || "gemini"),
  llmEnabled: booleanEnv(
    "LLM_ENABLED",
    Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
  ),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  geminiApiBaseUrl: (process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta")
    .replace(/\/+$/, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.4",
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT
    || defaultOpenAIReasoningEffort(process.env.OPENAI_MODEL || "gpt-5.4"),
  openaiApiBaseUrl: (process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
  anthropicApiBaseUrl: (process.env.ANTHROPIC_API_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
};

if (args.has("--once")) {
  await runJob(jobArg || "morning-report", { dryRun, dateArg, now: new Date() });
} else {
  await runScheduler();
}

async function runScheduler() {
  console.log(
    [
      `Daily report scheduler started for ${config.timeZone}`,
      `morning-report ${pad2(config.morningReportHour)}:${pad2(config.morningReportMinute)}`,
      `evening-reminders ${pad2(config.eveningReminderHour)}:${pad2(config.eveningReminderMinute)}`,
      `retry minute ${pad2(config.eveningReminderHour)}:${pad2(config.eveningReminderRetryMinute)}`,
    ].join("; "),
  );

  runTelegramCommandListener().catch((error) => {
    console.error("Telegram command listener stopped:", error);
  });

  await maybeRunDueJobs();
  setInterval(() => {
    maybeRunDueJobs().catch((error) => {
      console.error("Scheduled jobs failed:", error);
    });
  }, Math.max(10, config.pollIntervalSeconds) * 1000);
}

async function runTelegramCommandListener() {
  let botUsername = null;

  while (true) {
    try {
      if (!botUsername) {
        const bot = await fetchTelegramMe();
        botUsername = bot.username;
        console.log(`Telegram command listener started as @${botUsername}`);
      }
      await pollTelegramCommands(botUsername);
    } catch (error) {
      console.error("Telegram command polling failed:", error.message);
      await sleep(5_000);
    }
  }
}

async function pollTelegramCommands(botUsername) {
  const state = await readState();
  const updates = await fetchTelegramUpdates({
    offset: state.telegramUpdateOffset,
    timeoutSeconds: config.telegramCommandPollTimeoutSeconds,
  });

  for (const update of updates) {
    try {
      await handleTelegramUpdate(update, botUsername);
    } catch (error) {
      console.error(`Telegram update ${update.update_id} failed:`, error.message);
    } finally {
      await saveTelegramUpdateOffset(update.update_id + 1);
    }
  }
}

async function handleTelegramUpdate(update, botUsername) {
  const message = update.message || update.edited_message;
  if (!message?.text || !message.chat) {
    return;
  }

  const command = parseTelegramCommand(message.text, botUsername);
  if (!command) {
    return;
  }

  if (!isConfiguredTelegramChat(message.chat.id)) {
    console.warn(`Ignoring /${command} from unauthorized chat ${message.chat.id}`);
    return;
  }

  if (command === "stats") {
    const dayKey = studyDayKey(new Date(), config.timeZone);
    await sendStatsReport(dayKey, { dryRun: false, chatId: message.chat.id });
    return;
  }

  if (command === "start" || command === "help") {
    await sendTelegramMessage("Команды: /stats - статистика за сегодня.", { chatId: message.chat.id });
  }
}

function parseTelegramCommand(text, botUsername) {
  const match = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/);
  if (!match) {
    return null;
  }

  const command = match[1].toLowerCase();
  const targetUsername = match[2]?.toLowerCase();
  if (targetUsername && targetUsername !== botUsername.toLowerCase()) {
    return null;
  }
  if (!["stats", "start", "help"].includes(command)) {
    return null;
  }
  return command;
}

function isConfiguredTelegramChat(chatId) {
  return String(chatId) === String(config.telegramChatId);
}

async function fetchTelegramMe() {
  const url = new URL(`https://api.telegram.org/bot${config.telegramToken}/getMe`);
  return await fetchTelegramJson(url);
}

async function fetchTelegramUpdates({ offset = null, timeoutSeconds }) {
  const url = new URL(`https://api.telegram.org/bot${config.telegramToken}/getUpdates`);
  if (offset != null) {
    url.searchParams.set("offset", String(offset));
  }
  url.searchParams.set("timeout", String(Math.max(0, timeoutSeconds)));
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "edited_message"]));
  return await fetchTelegramJson(url) || [];
}

async function saveTelegramUpdateOffset(offset) {
  const state = await readState();
  state.telegramUpdateOffset = offset;
  await writeState(state);
}

async function maybeRunDueJobs() {
  const now = new Date();
  for (const jobName of dueJobs(now)) {
    await runJob(jobName, { dryRun: false, now });
  }
}

async function runJob(jobName, { dryRun, dateArg = null, now = new Date() }) {
  const normalizedJob = job(jobName);
  if (normalizedJob === "due") {
    for (const dueJob of dueJobs(now)) {
      await runJob(dueJob, { dryRun, dateArg, now });
    }
    return;
  }

  if (normalizedJob === "morning-report") {
    const dayKey = dateArg || previousStudyDayKey(now, config.timeZone);
    await sendMorningReport(dayKey, { dryRun });
    return;
  }

  if (normalizedJob === "stats") {
    const dayKey = dateArg || studyDayKey(now, config.timeZone);
    await sendStatsReport(dayKey, { dryRun });
    return;
  }

  const dayKey = dateArg || studyDayKey(now, config.timeZone);
  await sendEveningReminders(dayKey, { dryRun });
}

async function fetchDailyActivities(dayKey) {
  const users = await fetchUsers();
  return await Promise.all(users.map(async (user) => {
    const activity = await fetchDailyActivity(dayKey, user.id);
    if (!activity.user) {
      activity.user = user;
    }
    return activity;
  }));
}

async function fetchUsers() {
  const url = new URL("/v1/admin/users", config.apiBaseUrl);
  const response = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${config.adminApiKey}`,
    },
  });
  return (response.users || []).filter((user) => user.role === "learner");
}

async function fetchDailyActivity(dayKey, userId) {
  const url = new URL(`/v1/admin/users/${userId}/daily-activity`, config.apiBaseUrl);
  url.searchParams.set("dayKey", dayKey);
  url.searchParams.set("timeZone", config.timeZone);

  return await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${config.adminApiKey}`,
    },
  });
}

async function sendMorningReport(dayKey, { dryRun }) {
  const stateKey = sentStateKey("morning-report", dayKey);
  const state = dryRun ? null : await readState();
  if (!dryRun && isSent(state, stateKey)) {
    console.log(`Morning report already sent for ${dayKey}`);
    return;
  }

  const activities = await fetchDailyActivities(dayKey);
  const message = await formatStatsMessage(activities, {
    heading: "Итоги за вчера:",
    kind: "report",
    periodLabel: "вчера",
  });

  if (dryRun) {
    console.log(message);
    return;
  }

  await sendTelegramMessage(message);
  markSent(state, stateKey);
  await writeState(state);
  console.log(`Morning report sent for ${dayKey}`);
}

async function sendStatsReport(dayKey, { dryRun, chatId = null }) {
  const activities = await fetchDailyActivities(dayKey);
  const message = await formatStatsMessage(activities, {
    heading: "Статистика за сегодня:",
    kind: "stats",
    periodLabel: "сегодня",
  });

  if (dryRun) {
    console.log(message);
    return;
  }

  await sendTelegramMessage(message, { chatId });
  console.log(`Stats report sent for ${dayKey}`);
}

async function sendEveningReminders(dayKey, { dryRun }) {
  const jobStateKey = sentStateKey("evening-reminders", dayKey);
  const state = dryRun ? null : await readState();
  if (!dryRun && isSent(state, jobStateKey)) {
    console.log(`Evening reminders already checked for ${dayKey}`);
    return;
  }

  const activities = await fetchDailyActivities(dayKey);
  const inactiveActivities = activities.filter((activity) => !activity.active);
  const messages = [];

  for (const activity of inactiveActivities) {
    const userId = activity.user?.id || activity.user_id || activity.userId || learnerProfile(activity).displayName;
    const stateKey = sentStateKey("evening-reminder", dayKey, userId);
    if (!dryRun && isSent(state, stateKey)) {
      continue;
    }

    const text = await formatDailyMessage(activity, {
      kind: "reminder",
      periodLabel: "сегодня",
    });
    messages.push({ text, stateKey });

    if (!dryRun) {
      await sendTelegramMessage(text);
      markSent(state, stateKey);
      await writeState(state);
    }
  }

  if (dryRun) {
    console.log(messages.map((message) => message.text).join("\n\n---\n\n") || "No evening reminders to send.");
    return;
  }

  markSent(state, jobStateKey);
  await writeState(state);
  console.log(`Evening reminders sent for ${dayKey}: ${messages.length} message(s)`);
}

async function formatStatsMessage(activities, options) {
  const lines = await Promise.all(activities.map(async (activity) => {
    const text = await formatDailyMessage(activity, options);
    return `- ${text.replace(/\s+/g, " ").trim()}`;
  }));
  return [options.heading, ...lines].join("\n");
}

async function formatDailyMessage(activity, options = {}) {
  if (config.llmEnabled && providerApiKey(config.llmProvider)) {
    try {
      const text = await formatWithLlm(activity, options);
      if (text?.trim()) {
        return text;
      }
      console.warn(`${config.llmProvider} returned empty text, using fallback`);
    } catch (error) {
      console.warn(`${config.llmProvider} formatting failed, using fallback:`, error.message);
    }
  }
  return formatFallbackMessage(activity, options);
}

function formatFallbackMessage(activity, options = {}) {
  const profile = learnerProfile(activity);
  if (!activity.active) {
    if (options.kind === "report" || options.kind === "stats") {
      const periodLabel = options.periodLabel || "сегодня";
      return `${profile.displayName}: ${periodLabel} ${inactivePastVerb(profile.gender)}. Карты скучали без дела.`;
    }
    return `${stretchedName(profile.displayName)}! ${reminderText}`;
  }

  const effort = activityEffort(activity);
  const periodLabel = options.periodLabel || "сегодня";
  return [
    `${profile.displayName}: ${periodLabel} есть занятия.`,
    `Карточки: ${activity.studyReviews.total} ${cardLabel(activity.studyReviews.total)}, практика: ${activity.practiceReviews.total}, колонки: ${activity.matchingAttempts.columns}, аудио-колонки: ${activity.matchingAttempts.audioColumns}.`,
    fallbackClosing(effort),
  ].join("\n");
}

async function formatWithLlm(activity, options = {}) {
  if (config.llmProvider === "openai") {
    return await formatWithOpenAI(activity, options);
  }
  if (config.llmProvider === "anthropic") {
    return await formatWithAnthropic(activity, options);
  }
  return await formatWithGemini(activity, options);
}

async function formatWithGemini(activity, options = {}) {
  const modelPath = config.geminiModel.startsWith("models/")
    ? config.geminiModel
    : `models/${config.geminiModel}`;
  const url = new URL(`${modelPath}:generateContent`, `${config.geminiApiBaseUrl}/`);

  const response = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: geminiPrompt(activity, options) }],
        },
      ],
      generationConfig: geminiGenerationConfig(),
    }),
  });

  const text = response?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join("")
    .trim();
  return text || null;
}

function geminiGenerationConfig() {
  const configValue = {
    temperature: 0.8,
    maxOutputTokens: config.geminiModel.includes("pro") ? 800 : 180,
  };
  if (!config.geminiModel.includes("pro")) {
    configValue.thinkingConfig = {
      thinkingBudget: 0,
    };
  }
  return configValue;
}

function defaultOpenAIReasoningEffort(model) {
  if (/^gpt-5\.[1-9]/.test(model)) {
    return "none";
  }
  return "minimal";
}

async function formatWithOpenAI(activity, options = {}) {
  const url = new URL("responses", `${config.openaiApiBaseUrl}/`);
  const response = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.openaiModel,
      input: llmPrompt(activity, options),
      max_output_tokens: 400,
      reasoning: {
        effort: config.openaiReasoningEffort,
      },
      store: false,
      text: {
        verbosity: "low",
      },
    }),
  });

  if (response.output_text) {
    return response.output_text.trim();
  }
  const text = response.output
    ?.flatMap((item) => item.content || [])
    ?.map((part) => part.text)
    ?.filter(Boolean)
    ?.join("")
    ?.trim();
  return text || null;
}

async function formatWithAnthropic(activity, options = {}) {
  const url = new URL("v1/messages", `${config.anthropicApiBaseUrl}/`);
  const response = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 180,
      temperature: 0.8,
      messages: [
        {
          role: "user",
          content: llmPrompt(activity, options),
        },
      ],
    }),
  });

  const text = response.content
    ?.map((part) => part.text)
    ?.filter(Boolean)
    ?.join("")
    ?.trim();
  return text || null;
}

function geminiPrompt(activity, options = {}) {
  return llmPrompt(activity, options);
}

function llmPrompt(activity, options = {}) {
  const profile = learnerProfile(activity);
  const kind = options.kind || "report";
  const periodLabel = options.periodLabel || "сегодня";
  const facts = activityFacts(activity, periodLabel);
  const effort = activityEffort(activity);
  const contextRules = kind === "reminder"
    ? "Задача: написать короткое вечернее напоминание ребёнку, который сегодня не занимался."
    : kind === "stats"
      ? "Задача: написать одну короткую строку для отчёта родителю за сегодня по команде /stats."
    : "Задача: написать одну короткую строку для утреннего отчёта родителю за вчера.";

  return `${contextRules}

Ограничения:
- Пиши по-русски.
- Обращайся к ребёнку по имени: ${profile.displayName}.
- ${genderInstruction(profile.gender)}
- Используй только факты из блока ниже.
- Не добавляй списки, заголовки, эмодзи и кавычки вокруг сообщения.
- Не объясняй, что ты делаешь.
- Сообщение должно быть коротким.

Стиль:
- Живо и естественно.
- Можно слегка подшутить, если занятий мало или нет.
- Не дави и не стыди.
- Не используй готовые канцелярские формулы.

Дополнительно для этого сообщения:
${messageKindInstruction(kind)}

Уровень активности:
${activityToneInstruction(effort)}

Факты:
${facts}

Уровень активности: ${effort}.

JSON для проверки:
${JSON.stringify({
  learnerName: profile.displayName,
  learnerGender: profile.gender,
  messageKind: kind,
  periodLabel,
  active: activity.active,
  dayKey: activity.dayKey,
  studyReviews: activity.studyReviews,
  practiceReviews: activity.practiceReviews,
  matchingAttempts: activity.matchingAttempts,
  effort,
})}`;
}

function activityFacts(activity, periodLabel = "сегодня") {
  if (!activity.active) {
    return `${capitalize(periodLabel)} занятий не было.`;
  }

  const facts = [];
  if (activity.studyReviews.total > 0) {
    facts.push(`${activity.studyReviews.total} ${cardLabel(activity.studyReviews.total)} в учебных режимах`);
  }
  if (activity.practiceReviews.total > 0) {
    facts.push(`${activity.practiceReviews.total} ${cardLabel(activity.practiceReviews.total)} в практике`);
  }
  if (activity.matchingAttempts.columns > 0) {
    facts.push(`${activity.matchingAttempts.columns} раз режим Колонки`);
  }
  if (activity.matchingAttempts.audioColumns > 0) {
    facts.push(`${activity.matchingAttempts.audioColumns} раз режим Колонки аудио`);
  }
  return facts.join("; ") || `${capitalize(periodLabel)} есть занятия.`;
}

function activityEffort(activity) {
  if (!activity.active) {
    return "none";
  }
  const studyCount = activity.studyReviews.total + activity.practiceReviews.total;
  const matchingCount = activity.matchingAttempts.total;

  if (studyCount >= 30 || (studyCount >= 20 && matchingCount >= 1) || matchingCount >= 4) {
    return "strong";
  }
  if (studyCount >= 10 || matchingCount >= 2 || (studyCount >= 5 && matchingCount >= 1)) {
    return "medium";
  }
  return "small";
}

function fallbackClosing(effort) {
  if (effort === "strong") {
    return "Сильная работа: повторили, повторили, закрепили.";
  }
  if (effort === "medium") {
    return "Хорошо закрепили: повторили и двигаемся дальше.";
  }
  return "Это был трейлер занятия, не полная серия. Можно добить ещё пару карточек позже.";
}

function learnerProfile(activity) {
  const user = activity.user || {};
  const displayName = user.display_name_localized || user.displayNameLocalized || user.display_name || "Learner";
  const gender = user.grammatical_gender || user.grammaticalGender || "neutral";
  return { displayName, gender };
}

function genderInstruction(gender) {
  if (gender === "female") {
    return "Пиши в женском роде: прошла, повторила, сделала, играла.";
  }
  if (gender === "male") {
    return "Пиши в мужском роде: прошёл, повторил, сделал, играл.";
  }
  return "Если нужен глагол в прошедшем времени, избегай рода или пиши нейтрально.";
}

function messageKindInstruction(kind) {
  if (kind === "reminder") {
    return [
      "- Это вечернее напоминание за сегодня.",
      "- Используй протяжный зов, как будто зовёшь из соседней комнаты.",
      "- Мягко мотивируй быстро просмотреть карточки вечером.",
      "- Не говори про завтра.",
      "- Не завершай мыслью, что можно отдыхать или ничего не делать.",
    ].join("\n");
  }
  if (kind === "stats") {
    return [
      "- Это отчёт по запросу за сегодня.",
      "- Если занятий не было, напиши об этом спокойно, но можно с лёгким стёбом.",
    ].join("\n");
  }
  return [
    "- Это утренний отчёт за вчера.",
    "- Если занятий не было, напиши об этом спокойно, но можно с лёгким стёбом.",
  ].join("\n");
}

function activityToneInstruction(effort) {
  if (effort === "none") {
    return "- Занятий не было: можно мягко подшутить.";
  }
  if (effort === "small") {
    return "- Занятий мало: не хвали, лучше слегка поддень без грубости.";
  }
  if (effort === "medium") {
    return "- Занятий нормально: можно коротко одобрить.";
  }
  return "- Занятий много: можно похвалить ярче.";
}

function inactivePastVerb(gender) {
  if (gender === "female") {
    return "карточки не трогала";
  }
  if (gender === "male") {
    return "карточки не трогал";
  }
  return "карточки не трогали";
}

function stretchedName(name) {
  const cleanName = name.trim();
  if (!cleanName) {
    return "Ээээй";
  }
  const last = cleanName.slice(-1);
  return `${cleanName}${last.repeat(2)}`;
}

async function sendTelegramMessage(text, { chatId = null } = {}) {
  const url = new URL(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`);
  await fetchTelegramJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId ?? config.telegramChatId,
      text,
      disable_web_page_preview: true,
    }),
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchTelegramJson(url, options) {
  const payload = await fetchJson(url, options);
  if (!payload?.ok) {
    throw new Error(`Telegram API failed: ${payload?.description || "unknown error"}`);
  }
  return payload.result;
}

async function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  try {
    const content = await readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator < 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = unquote(trimmed.slice(separator + 1).trim());
      if (key && process.env[key] == null) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function booleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function provider(value) {
  const normalized = value.trim().toLowerCase();
  if (["gemini", "openai", "anthropic"].includes(normalized)) {
    return normalized;
  }
  throw new Error("LLM_PROVIDER must be gemini, openai, or anthropic");
}

function job(value) {
  const normalized = value.trim().toLowerCase();
  if (["due", "morning-report", "evening-reminders", "stats"].includes(normalized)) {
    return normalized;
  }
  throw new Error("--job must be due, morning-report, evening-reminders, or stats");
}

function providerApiKey(providerName) {
  if (providerName === "openai") {
    return config.openaiApiKey;
  }
  if (providerName === "anthropic") {
    return config.anthropicApiKey;
  }
  return config.geminiApiKey;
}

function dueJobs(date) {
  const local = localHourMinute(date, config.timeZone);
  const jobs = [];
  if (isTimeReached(local, config.morningReportHour, config.morningReportMinute)) {
    jobs.push("morning-report");
  }
  if (isTimeReached(local, config.eveningReminderHour, config.eveningReminderMinute)
    || isTimeReached(local, config.eveningReminderHour, config.eveningReminderRetryMinute)) {
    jobs.push("evening-reminders");
  }
  return jobs;
}

function localHourMinute(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    hour: Number(byType.get("hour")),
    minute: Number(byType.get("minute")),
  };
}

function isTimeReached(local, hour, minute) {
  return local.hour > hour || (local.hour === hour && local.minute >= minute);
}

function studyDayKey(date, timeZone) {
  const shifted = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function previousStudyDayKey(date, timeZone) {
  return studyDayKey(new Date(date.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

async function readState() {
  try {
    return JSON.parse(await readFile(config.stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function sentStateKey(kind, dayKey, userId = null) {
  return [kind, dayKey, userId].filter(Boolean).join(":");
}

function isSent(state, key) {
  return Boolean(state.sent?.[key]);
}

function markSent(state, key) {
  if (!state.sent) {
    state.sent = {};
  }
  state.sent[key] = new Date().toISOString();
}

async function writeState(state) {
  await mkdir(path.dirname(config.stateFile), { recursive: true });
  await writeFile(config.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function cardLabel(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "карточка";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "карточки";
  }
  return "карточек";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage:
  npm start
  npm run once
  npm run dry-run
  npm run dry-run-reminders
  node src/index.mjs --once --job=stats
  node src/index.mjs --once --job=morning-report --date=2026-06-04
  node src/index.mjs --once --job=evening-reminders --date=2026-06-04
  node src/index.mjs --once --job=due
  node src/index.mjs --once --dry-run --job=morning-report --provider=openai
`);
}
