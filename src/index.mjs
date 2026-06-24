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
const reminderText = "Посмотри карточки вечером хотя бы 5 минут.";
const serverFetchRetries = 2;
const serverFetchRetryDelayMs = 1_000;
const llmThinkingEnabled = booleanEnv("LLM_THINKING_ENABLED", true);
const alreadyDoneLogged = new Set();

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
  stateFile: process.env.STATE_FILE || "/data/daily-report.json",
  llmProvider: provider(providerArg || process.env.LLM_PROVIDER || "gemini"),
  llmEnabled: booleanEnv(
    "LLM_ENABLED",
    Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
  ),
  llmThinkingEnabled,
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  geminiThinkingBudget: integerEnv("GEMINI_THINKING_BUDGET", 512),
  geminiApiBaseUrl: (process.env.GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta")
    .replace(/\/+$/, ""),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.4",
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT
    || defaultOpenAIReasoningEffort(process.env.OPENAI_MODEL || "gpt-5.4", llmThinkingEnabled),
  openaiApiBaseUrl: (process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
  anthropicApiBaseUrl: (process.env.ANTHROPIC_API_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
};

try {
  if (args.has("--once")) {
    await runJob(jobArg || "morning-report", { dryRun, dateArg, now: new Date() });
  } else {
    await runScheduler();
  }
} catch (error) {
  logError("Bot command failed", error, {
    mode: args.has("--once") ? "once" : "scheduler",
    job: jobArg || (args.has("--once") ? "morning-report" : null),
    dryRun,
    dateArg,
  });
  process.exit(1);
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
    logError("Telegram command listener stopped", error);
  });

  await maybeRunDueJobs();
  setInterval(() => {
    maybeRunDueJobs().catch((error) => {
      logError("Scheduled jobs failed", error);
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
      logError("Telegram command polling failed", error);
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
    const context = telegramUpdateLogContext(update, botUsername);
    try {
      await handleTelegramUpdate(update, botUsername);
    } catch (error) {
      logError("Telegram update failed", error, context);
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

function telegramUpdateLogContext(update, botUsername) {
  const message = update.message || update.edited_message;
  const command = message?.text ? parseTelegramCommand(message.text, botUsername) : null;
  return {
    updateId: update.update_id,
    command: command ? `/${command}` : null,
    chatId: message?.chat?.id ?? null,
    chatType: message?.chat?.type ?? null,
    fromId: message?.from?.id ?? null,
  };
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
  const response = await fetchServerJson(url, {
    headers: {
      Authorization: `Bearer ${config.adminApiKey}`,
    },
  }, {
    label: "server admin users",
  });
  return (response.users || []).filter((user) => user.role === "learner");
}

async function fetchDailyActivity(dayKey, userId) {
  const url = new URL(`/v1/admin/users/${userId}/daily-activity`, config.apiBaseUrl);
  url.searchParams.set("dayKey", dayKey);
  url.searchParams.set("timeZone", config.timeZone);

  return await fetchServerJson(url, {
    headers: {
      Authorization: `Bearer ${config.adminApiKey}`,
    },
  }, {
    label: "server daily activity",
    fields: { dayKey, userId },
  });
}

async function sendMorningReport(dayKey, { dryRun }) {
  const stateKey = sentStateKey("morning-report", dayKey);
  const state = dryRun ? null : await readState();
  if (!dryRun && isSent(state, stateKey)) {
    logAlreadyDone(stateKey, `Morning report already sent for ${dayKey}`);
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
    logAlreadyDone(jobStateKey, `Evening reminders already checked for ${dayKey}`);
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
      const normalized = normalizeLlmText(text, activity, options);
      if (normalized) {
        return normalized;
      }
      logWarn("LLM returned unusable text; using fallback", {
        provider: config.llmProvider,
        model: providerModel(config.llmProvider),
        kind: options.kind || "report",
        dayKey: activity.dayKey,
        userId: activity.userId || activity.user_id || activity.user?.id || null,
      });
    } catch (error) {
      logError("LLM formatting failed; using fallback", error, {
        provider: config.llmProvider,
        model: providerModel(config.llmProvider),
        kind: options.kind || "report",
        dayKey: activity.dayKey,
        userId: activity.userId || activity.user_id || activity.user?.id || null,
      });
    }
  }
  return formatFallbackMessage(activity, options);
}

function formatFallbackMessage(activity, options = {}) {
  const profile = learnerProfile(activity);
  if (!activity.active) {
    if (options.kind === "report" || options.kind === "stats") {
      return fallbackReportLine(profile, "none", activity, options.periodLabel);
    }
    return `${stretchedName(profile.displayName)}! ${reminderText}`;
  }

  const effort = activityEffort(activity);
  if (options.kind === "report" || options.kind === "stats") {
    return fallbackReportLine(profile, effort, activity, options.periodLabel);
  }

  // Без чисел и оценки объёма: отмечаем только сам факт занятия.
  const played = gendered(profile.gender, "поиграл", "поиграла", "поиграли");
  const studied = gendered(profile.gender, "позанимался", "позанималась", "позанимались");
  if (matchingGameCount(activity) > 0 && cardReviewCount(activity) === 0) {
    return `${profile.displayName}: ${played} в Колонки.`;
  }
  return `${profile.displayName}: ${studied} с карточками.`;
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
    temperature: 0.45,
    maxOutputTokens: geminiMaxOutputTokens(),
  };
  if (!config.geminiModel.includes("pro")) {
    configValue.thinkingConfig = {
      thinkingBudget: config.llmThinkingEnabled ? Math.max(0, config.geminiThinkingBudget) : 0,
    };
  }
  return configValue;
}

function geminiMaxOutputTokens() {
  if (config.geminiModel.includes("pro")) {
    return config.llmThinkingEnabled ? 1_200 : 800;
  }
  if (config.llmThinkingEnabled) {
    return Math.max(700, config.geminiThinkingBudget + 220);
  }
  return 220;
}

function defaultOpenAIReasoningEffort(model, thinkingEnabled) {
  if (/^gpt-5\.[1-9]/.test(model)) {
    // gpt-5.x reasoning models reject "minimal"; "low" is the smallest valid effort.
    return thinkingEnabled ? "low" : "none";
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
      temperature: 0.45,
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
  const kind = options.kind || "report";
  if (kind === "stats" || kind === "report") {
    return reportPrompt(activity, options);
  }
  return reminderPrompt(activity, options);
}

function reminderPrompt(activity, options = {}) {
  const profile = learnerProfile(activity);
  const kind = options.kind || "report";
  const periodLabel = options.periodLabel || "сегодня";
  const facts = activityFacts(activity, periodLabel);
  const effort = activityEffort(activity);
  const styleVariant = messageStyleVariant(kind, effort);
  const actionVariant = messageActionVariant(kind, effort);
  const task = messageTaskInstruction(kind, profile.displayName);

  return `Задача:
${task}

Персона:
Ты Лера. Ты взрослый человек в семейном чате: умная, темпераментная, тёплая, иногда резкая, но вменяемая.
Ты не бот-мотиватор, не учитель, не психолог и не клоун. Ты говоришь как живой человек, который на стороне ребёнка.
Твоя эмоция должна быть реакцией на ситуацию, а не украшением текста.

Адресат и факты:
- Имя: ${profile.displayName}.
- ${genderInstruction(profile.gender)}
- Тип сообщения: ${kind}.
- Период: ${periodLabel}.
- Факты: ${facts}
- Используй только эти факты. Не придумывай причины, чувства, планы, обещания и последствия.

Как писать:
- Русский, одно-два коротких предложения.
- Обратись по имени.
- Разговорная семейная речь: ясно, живо, без канцелярита и без сюсюканья.
- Можно использовать короткий эмоциональный жест: вытянутое имя, междометие, паузу, тире, резкий поворот фразы. Только если это звучит естественно.
- Не начинай автоматически с факта. Можно сначала позвать по имени, отреагировать коротко, а факт встроить дальше.
- Не пытайся быть оригинальной. Если выбираешь между простой человеческой фразой и красивым образом, выбирай простую фразу.
- Не копируй формулировки инструкций дословно.

Намерение:
${messageIntentInstruction(kind, effort)}
${actionVariant ? `- Смысл маленького действия для этого сообщения: ${actionVariant}` : ""}

Интонация этого сообщения:
- ${styleVariant}

Жёсткие границы:
- Не стыдить, не угрожать, не давить, не требовать отчёт, не писать "жду".
- Не звучать как контролёр: без "надо", "должна", "опять", "ну ты даёшь", "ай-ай-ай", "как так".
- Не оценивать весь день ребёнка и его личность.
- Не делать сообщение про Леру: без "я отстану", "мне спокойнее", "я рядом".
- Не говорить про мозг, голову, память, нервы, психику или тело ребёнка.
- Абстрактные вещи ничего не делают: день, вечер, время, учёба, занятия и карточки не притворяются, не скучают, не проходят мимо, не зовут и не ждут.
- Никакой псевдопоэзии, образных метафор, интернетного юмора и "нейросетевой милоты".
- После "давай" используй нормальную живую грамматику: "давай глянем", "давай открой", "давай коротко пройти". Не пиши "давай откроешь" и не ставь прошедшее время.

Проверочные данные:
${JSON.stringify({
  learnerName: profile.displayName,
  learnerGender: profile.gender,
  messageKind: kind,
  periodLabel,
  active: activity.active,
  dayKey: activity.dayKey,
  facts,
  effort,
})}`;
}

function reportPrompt(activity, options = {}) {
  const profile = learnerProfile(activity);
  const kind = options.kind || "report";
  const periodLabel = options.periodLabel || "сегодня";
  const effort = activityEffort(activity);
  const facts = activityFacts(activity, periodLabel);
  const styleVariant = messageStyleVariant(kind, effort);
  const fallbackExample = fallbackReportLine(profile, effort, activity, periodLabel);

  return `Задача:
Напиши очень короткую строку для родителя в групповом отчёте по занятиям ребёнка.

Контекст:
- Это не сообщение ребёнку.
- Не обращайся к ребёнку напрямую.
- Строка будет стоять после маркера списка, рядом с такими же строками по другим детям.
- Заголовок отчёта уже содержит период, поэтому период можно не повторять.

Факты:
- Имя ребёнка: ${profile.displayName}.
- ${genderInstruction(profile.gender)}
- Тип отчёта: ${kind}.
- Период: ${periodLabel}.
- Занятие было: ${activity.active ? "да" : "нет"}.
- Факты: ${facts}
- Используй только эти факты. Не придумывай причины, чувства, планы, обещания и последствия.

Как писать:
- Русский, одна короткая строка.
- Начни с имени ребёнка и двоеточия.
- Пиши для родителя: спокойно, ясно, живым семейным языком.
- Не возвращай готовый шаблон из инструкций. Сформулируй строку заново под конкретные факты.
- Можно упомянуть вид занятия, если это делает строку понятнее: карточки, картинки или игру.
- Если упоминаешь игру, называй её "Колонки". Игру со словами по картинке называй "картинки".
- Не пиши числа: ни сколько карточек, ни сколько повторов, ни сколько игр, ни сколько времени.
- Не оценивай объём: никаких "много", "мало", "плотно", "сильно", "хороший объём", "целый блок", "чуть-чуть".
- Пример уровня конкретики, не копировать дословно: ${fallbackExample}

Интонация этой строки:
- ${styleVariant}

Жёсткие границы:
- Не пиши ребёнку на "ты".
- Не хвали за отсутствие занятий.
- Не стыди и не подкалывай за отсутствие занятий.
- Не используй "ноль", "умница", "молодец", "справился/справилась с паузой", "ок, просто отмечаю", "сильная работа, хороший объём карточек", "карточек не было".
- Не оживляй карточки, день, занятия, время или паузу.
- Не придумывай причины, чувства, планы, обещания и последствия.
- Никаких чисел и оценок объёма: не пиши, сколько карточек, повторов, игр или времени, и не суди, много это или мало.
- Не перечисляй подробности занятия.

Проверочные данные:
${JSON.stringify({
  learnerName: profile.displayName,
  learnerGender: profile.gender,
  messageKind: kind,
  periodLabel,
  active: activity.active,
  dayKey: activity.dayKey,
  facts,
  effort,
})}`;
}

function activityFacts(activity, periodLabel = "сегодня") {
  if (!activity.active) {
    return `${capitalize(periodLabel)} без занятий с карточками.`;
  }

  // Объём занятий не сравним между людьми: у одного 25 карточек, у другого 750,
  // поэтому числа и время сюда не попадают. Отмечаем только сам факт занятия и
  // какие виды активности были.
  const pictureCount = pictureChoiceCount(activity);
  const writingCount = writingExerciseCount(activity);
  // Картинки тоже попадают в cardReviews (это practice-повторы), поэтому
  // «карточки» = повторы за вычетом отдельных упражнений, иначе один заход
  // прозвучит и как карточки, и как конкретный режим.
  const plainCardReviews = cardReviewCount(activity) - pictureCount - writingCount;
  const facts = [];
  if (plainCardReviews > 0) {
    facts.push("занимался с карточками");
  }
  if (matchingGameCount(activity) > 0) {
    facts.push("играл в Колонки");
  }
  if (pictureCount > 0) {
    facts.push("решал картинки");
  }
  if (writingCount > 0) {
    facts.push("писал слова");
  }
  return facts.join("; ") || "занимался с карточками";
}

function activityEffort(activity) {
  // Объём занятий несравним между людьми (у ребёнка 25 карточек, у взрослого
  // 750), поэтому больше не делим на strong/medium/small. Важен только факт:
  // человек сел и позанимался — это хвалим независимо от объёма.
  return activity.active ? "done" : "none";
}

function fallbackReportLine(profile, effort, activity, periodLabel = "сегодня") {
  if (effort === "none") {
    return randomChoice([
      `${profile.displayName}: занятий с карточками не было.`,
      `${profile.displayName}: без карточек ${periodLabel}.`,
      `${profile.displayName}: по карточкам пауза, занятий не было.`,
    ]);
  }

  // Хвалим за сам факт занятия, без чисел и оценки объёма: у разных людей
  // объём несравним, поэтому говорим только о том, что занятие было.
  const pictureCount = pictureChoiceCount(activity);
  const writingCount = writingExerciseCount(activity);
  const plainCardReviews = cardReviewCount(activity) - pictureCount - writingCount;
  const playedCount = matchingGameCount(activity);
  const studiedVerb = gendered(profile.gender, "позанимался", "позанималась", "позанимались");
  const wroteVerb = gendered(profile.gender, "писал", "писала", "писали");
  const solvedVerb = gendered(profile.gender, "решал", "решала", "решали");
  const playedVerb = gendered(profile.gender, "поиграл", "поиграла", "поиграли");
  const parts = [];

  if (plainCardReviews > 0) {
    parts.push(`${studiedVerb} с карточками`);
  }
  if (writingCount > 0) {
    parts.push(`${wroteVerb} слова`);
  }
  if (pictureCount > 0) {
    parts.push(`${solvedVerb} картинки`);
  }
  if (playedCount > 0) {
    parts.push(`${playedVerb} в Колонки`);
  }

  return `${profile.displayName}: ${parts.join(" и ") || `${studiedVerb} с карточками`}.`;
}

function normalizeLlmText(text, activity, options = {}) {
  if (typeof text !== "string") {
    return null;
  }
  const line = text
    .trim()
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .trim();
  if (!line) {
    return null;
  }

  const kind = options.kind || "report";
  if (kind !== "report" && kind !== "stats") {
    return line;
  }

  const profile = learnerProfile(activity);
  if (!line.startsWith(`${profile.displayName}:`)) {
    return null;
  }
  if (looksIncompleteSentence(line)) {
    return null;
  }
  if (isGenericReportTemplate(line, profile.displayName)) {
    return null;
  }
  return line;
}

function looksIncompleteSentence(line) {
  if (/[,:;-]$/.test(line)) {
    return true;
  }
  const words = line.toLowerCase().split(/\s+/);
  const lastWord = words.at(-1)?.replace(/[.!?]+$/g, "");
  return [
    "а",
    "без",
    "в",
    "для",
    "и",
    "к",
    "на",
    "но",
    "о",
    "по",
    "с",
    "у",
    "что",
    "это",
  ].includes(lastWord);
}

function isGenericReportTemplate(line, displayName) {
  const prefix = `${displayName}:`;
  const tail = line
    .slice(prefix.length)
    .trim()
    .replace(/[.!]+$/g, "")
    .toLowerCase();
  return [
    "сильная работа, хороший объём карточек",
    "нормальный темп, занятие засчитано",
    "маленькое начало, можно продолжить позже",
    "карточек не было",
  ].includes(tail);
}

function gendered(gender, male, female, neutral) {
  if (gender === "male") {
    return male;
  }
  if (gender === "female") {
    return female;
  }
  return neutral;
}

function randomChoice(values) {
  return values[Math.floor(Math.random() * values.length)];
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

function messageTaskInstruction(kind, displayName) {
  if (kind === "reminder") {
    return `Напиши вечернее сообщение ребёнку ${displayName}, если сегодня занятий с карточками не было.`;
  }
  if (kind === "stats") {
    return `Напиши одну строку для родителя по сегодняшней статистике ребёнка ${displayName}.`;
  }
  return `Напиши одну строку для родителя по вчерашней статистике ребёнка ${displayName}.`;
}

function messageIntentInstruction(kind, effort) {
  if (kind === "reminder") {
    return [
      "- Это вечернее напоминание за сегодня, не разговор про завтра.",
      "- Если занятий не было, скажи это прямо и предложи одно маленькое действие вечером примерно на 5 минут.",
      "- Не заканчивай мыслью, что можно ничего не делать или отдыхать.",
    ].join("\n");
  }

  if (effort === "none") {
    return "- Занятий не было: сообщи это спокойно и прямо, без упрёка.";
  }
  return [
    "- Занятие было: тепло отметь сам факт, что ребёнок сел и позанимался.",
    "- Хвали за факт занятия, а не за объём. Объём разных людей несравним, поэтому не оценивай, много это или мало, и не сравнивай дни между собой.",
  ].join("\n");
}

function messageStyleVariant(kind, effort) {
  const variants = [];
  if (kind === "reminder" && effort === "none") {
    variants.push(
      "мягкий короткий толчок; без драматизма",
      "энергичный мини-пинок; бодро, без контроля",
      "спокойная Лера; тепло, прямо и без лишних украшений",
      "ироничная Лера; ирония только про маленький размер задачи",
      "нежная Лера; очень коротко, но с ощущением поддержки",
    );
  } else {
    variants.push(
      "тепло одобрить сам факт, что ребёнок позанимался",
      "спокойно и по-доброму отметить, что занятие было",
      "коротко порадоваться, что ребёнок сел за карточки",
    );
  }
  return variants[Math.floor(Math.random() * variants.length)];
}

function messageActionVariant(kind, effort) {
  if (kind !== "reminder" || effort !== "none") {
    return "";
  }
  const variants = [
    "глянуть карточки около 5 минут",
    "пролистать несколько карточек вечером",
    "сделать короткий заход на 5 минут",
    "открыть карточки и посмотреть пару штук",
    "быстро повторить несколько карточек",
    "выделить карточкам один маленький вечерний подход",
  ];
  return variants[Math.floor(Math.random() * variants.length)];
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

async function fetchServerJson(url, options, request = {}) {
  return await fetchJson(url, options, {
    ...request,
    retries: serverFetchRetries,
    retryDelayMs: serverFetchRetryDelayMs,
  });
}

async function fetchJson(url, options = {}, request = {}) {
  const method = options.method || "GET";
  const retries = request.retries || 0;
  const retryDelayMs = request.retryDelayMs || 0;
  const label = request.label || `${method} ${url.pathname}`;
  const fields = request.fields || {};
  const attempts = retries + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      if (!response.ok) {
        const error = httpError(response, text);
        annotateRequestError(error, { url, method, label, attempt, attempts, fields });
        if (attempt < attempts && isRetryableHttpStatus(response.status)) {
          logWarn("HTTP request failed; retrying", { error: serializeError(error) });
          await sleep(retryDelayMs);
          continue;
        }
        throw error;
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch (error) {
        annotateRequestError(error, { url, method, label, attempt, attempts, fields });
        throw error;
      }
    } catch (error) {
      annotateRequestError(error, { url, method, label, attempt, attempts, fields });
      if (attempt < attempts && isRetryableFetchError(error)) {
        logWarn("HTTP request failed; retrying", { error: serializeError(error) });
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
  }
}

async function fetchTelegramJson(url, options) {
  const payload = await fetchJson(url, options, {
    label: `telegram ${url.pathname.split("/").at(-1)}`,
  });
  if (!payload?.ok) {
    const error = new Error(`Telegram API failed: ${payload?.description || "unknown error"}`);
    error.telegramErrorCode = payload?.error_code || null;
    throw error;
  }
  return payload.result;
}

function httpError(response, body) {
  const error = new Error(`${response.status} ${response.statusText}`);
  error.httpStatus = response.status;
  error.httpStatusText = response.statusText;
  error.responseBody = body?.slice(0, 500) || "";
  return error;
}

function annotateRequestError(error, { url, method, label, attempt, attempts, fields }) {
  if (!error.request) {
    error.request = {};
  }
  Object.assign(error.request, {
    label,
    method,
    path: `${url.pathname}${url.search}`,
    origin: url.origin,
    attempt,
    attempts,
    ...fields,
  });
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableFetchError(error) {
  if (error.httpStatus) {
    return false;
  }
  const code = error.cause?.code || error.code;
  return error.name === "AbortError"
    || error.message === "fetch failed"
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "UND_ERR_HEADERS_TIMEOUT"
    || code === "UND_ERR_SOCKET"
    || code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "ETIMEDOUT"
    || code === "EAI_AGAIN";
}

function logAlreadyDone(key, message) {
  if (alreadyDoneLogged.has(key)) {
    return;
  }
  alreadyDoneLogged.add(key);
  console.log(message);
}

function logError(message, error, fields = {}) {
  console.error(JSON.stringify({
    level: "error",
    message,
    ...compactObject(fields),
    error: serializeError(error),
  }));
}

function logWarn(message, fields = {}) {
  console.warn(JSON.stringify({
    level: "warn",
    message,
    ...compactObject(fields),
  }));
}

function serializeError(error) {
  return compactObject({
    name: error?.name,
    message: error?.message,
    code: error?.code,
    httpStatus: error?.httpStatus,
    httpStatusText: error?.httpStatusText,
    telegramErrorCode: error?.telegramErrorCode,
    causeName: error?.cause?.name,
    causeMessage: error?.cause?.message,
    causeCode: error?.cause?.code,
    responseBody: error?.responseBody,
    request: error?.request ? compactObject(error.request) : null,
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue != null && fieldValue !== ""));
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

function providerModel(providerName) {
  if (providerName === "openai") {
    return config.openaiModel;
  }
  if (providerName === "anthropic") {
    return config.anthropicModel;
  }
  return config.geminiModel;
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

function cardReviewCount(activity) {
  return numberField(
    activity.cardReviews?.total,
    numberField(activity.studyReviews?.total) + numberField(activity.practiceReviews?.total),
  );
}

function matchingGameCount(activity) {
  return numberField(
    activity.matchingAttempts?.total,
    numberField(activity.matchingAttempts?.columns) + numberField(activity.matchingAttempts?.audioColumns),
  );
}

function pictureChoiceCount(activity) {
  return numberField(activity.pictureChoices?.total);
}

function writingExerciseCount(activity) {
  return numberField(activity.writingExercises?.total);
}

function numberField(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
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
