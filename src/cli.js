#!/usr/bin/env node
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import {
  autocomplete,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  spinner,
} from "@clack/prompts";
import inquirerSelect from "@inquirer/select";
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";

const VALID_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

const COMMAND_NAME = "infer";
const args = process.argv.slice(2);
const options = {
  command: "prompt",
  continue: false,
  provider: undefined,
  model: undefined,
  thinking: undefined,
  source: undefined,
  help: false,
  version: false,
};
const promptParts = [];

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--") {
    promptParts.push(...args.slice(i + 1));
    break;
  }
  if (arg === "-c" || arg === "--continue" || arg === "-r" || arg === "--resume") {
    options.continue = true;
    continue;
  }
  if (arg === "-p" || arg === "--provider") {
    options.provider = requireValue(arg, args[i + 1]);
    i += 1;
    continue;
  }
  if (arg === "-m" || arg === "--model") {
    options.model = requireValue(arg, args[i + 1]);
    i += 1;
    continue;
  }
  if (arg === "--thinking") {
    options.thinking = requireValue(arg, args[i + 1]);
    i += 1;
    continue;
  }
  if (arg === "--source") {
    options.source = requireValue(arg, args[i + 1]);
    i += 1;
    continue;
  }
  if (arg === "config") {
    options.command = "config";
    continue;
  }
  if (arg === "-h" || arg === "--help") {
    options.help = true;
    continue;
  }
  if (arg === "-v" || arg === "--version") {
    options.version = true;
    continue;
  }
  if (arg.startsWith("-")) {
    fail(`Unknown flag: ${arg}`);
  }
  promptParts.push(arg);
}

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.version) {
  printVersion();
  process.exit(0);
}

if (options.thinking && !VALID_THINKING_LEVELS.has(options.thinking)) {
  fail(`Invalid --thinking value: ${options.thinking}`);
}

if (options.source && options.source !== "local" && options.source !== "models.dev") {
  fail(`Invalid --source value: ${options.source}`);
}

if (options.source && options.command !== "config") {
  fail("--source is only valid with the config command.");
}

const agentDir = resolveAgentDir();
const sessionDir = join(agentDir, "sessions");
const sessionFile = join(sessionDir, "last.jsonl");

ensureDir(agentDir);
ensureDir(sessionDir);

const settingsManager = SettingsManager.create(process.cwd(), agentDir);
const authStorage = new AuthStorage(join(agentDir, "auth.json"));
const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));

if (options.command === "config") {
  if (promptParts.length > 0) {
    fail("The config command does not accept a prompt.");
  }
  await runConfigurator({
    agentDir,
    settingsManager,
    authStorage,
    modelRegistry,
    source: options.source,
  });
  process.exit(0);
}

const prompt = await resolvePrompt(promptParts);
if (!prompt) {
  printHelp();
  process.exit(1);
}

if (!options.continue) {
  clearSessions(sessionDir);
}
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  extensionFactories: [createBashApprovalExtension()],
});

await resourceLoader.reload();

const model = resolveModel({
  provider: options.provider,
  modelId: options.model,
  settingsManager,
  modelRegistry,
});

const sessionManager = SessionManager.open(sessionFile, sessionDir);
const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir,
  authStorage,
  modelRegistry,
  resourceLoader,
  settingsManager,
  sessionManager,
  model: model ?? undefined,
  thinkingLevel: options.thinking,
});

let lastAssistantText = "";
let printedToolLine = false;
let suppressBashToolLine = false;

session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    if (event.toolName === "bash" && suppressBashToolLine) {
      return;
    }
    const line = formatToolLine(event.toolName, event.args);
    if (line) {
      printedToolLine = true;
      process.stdout.write(`${line}\n`);
    }
  }

  if (event.type === "message_end") {
    if (isAssistantMessage(event.message)) {
      lastAssistantText = extractText(event.message);
    }
  }
});

try {
  await session.prompt(prompt);
  if (printedToolLine) {
    process.stdout.write("\n");
  }
  if (lastAssistantText) {
    process.stdout.write(`${lastAssistantText.trimEnd()}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
} finally {
  session.dispose();
}

function resolveAgentDir() {
  const envDir = process.env.INFER_AGENT_DIR;
  if (envDir) {
    return expandHome(envDir);
  }
  return join(homedir(), ".infer", "agent");
}

function expandHome(targetPath) {
  if (targetPath === "~") {
    return homedir();
  }
  if (targetPath.startsWith("~/")) {
    return join(homedir(), targetPath.slice(2));
  }
  return resolve(targetPath);
}

function ensureDir(pathname) {
  if (!existsSync(pathname)) {
    mkdirSync(pathname, { recursive: true });
  }
}

function clearSessions(sessionDirPath) {
  if (!existsSync(sessionDirPath)) {
    return;
  }
  for (const entry of readdirSync(sessionDirPath)) {
    if (entry.endsWith(".jsonl")) {
      unlinkSync(join(sessionDirPath, entry));
    }
  }
}

function resolveModel({ provider, modelId, settingsManager, modelRegistry }) {
  if (!provider && !modelId) {
    return undefined;
  }

  const resolvedProvider = provider ?? settingsManager.getDefaultProvider();
  if (!resolvedProvider) {
    fail("Missing provider. Use --provider or set defaultProvider in settings.");
  }

  const resolvedModelId = modelId ?? settingsManager.getDefaultModel();
  if (!resolvedModelId) {
    fail("Missing model. Use --model or set defaultModel in settings.");
  }

  const model = modelRegistry.find(resolvedProvider, resolvedModelId);
  if (!model) {
    fail(`Model not found: ${resolvedProvider}/${resolvedModelId}`);
  }

  return model;
}

function formatToolLine(toolName, args) {
  if (toolName === "read" && args?.path) {
    return gray(`Read ${args.path}`);
  }
  if (toolName === "edit" && args?.path) {
    return gray(`Edit ${args.path}`);
  }
  if (toolName === "write" && args?.path) {
    return gray(`Write ${args.path}`);
  }
  if (toolName === "bash" && args?.command) {
    return gray(`! ${args.command}`);
  }
  return null;
}

function isAssistantMessage(message) {
  return typeof message === "object" && message !== null && message.role === "assistant";
}

function extractText(message) {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function resolvePrompt(parts) {
  if (parts.length > 0) {
    return parts.join(" ").trim();
  }

  if (process.stdin.isTTY) {
    return "";
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function printVersion() {
  const pkg = readPackageJson();
  process.stdout.write(`${COMMAND_NAME} ${pkg.version}\n`);
}

function printHelp() {
  process.stdout.write(
    `Usage: ${COMMAND_NAME} [options] <prompt>\n\n` +
      `Commands:\n` +
      `  config                         Interactive configuration\n\n` +
      `Options:\n` +
      `  -c, --continue, -r, --resume  Continue last session\n` +
      `  -p, --provider <name>         Model provider\n` +
      `  -m, --model <id>              Model id\n` +
      `  --thinking <level>            off|minimal|low|medium|high|xhigh\n` +
      `  --source <local|models.dev>   Model source for config\n` +
      `  -h, --help                    Show help\n` +
      `  -v, --version                 Show version\n`,
  );
}

function readPackageJson() {
  const pkgUrl = new URL("../package.json", import.meta.url);
  return JSON.parse(readFileSync(pkgUrl, "utf-8"));
}

function requireValue(flag, value) {
  if (!value || value.startsWith("-")) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

async function runConfigurator({ agentDir, settingsManager, authStorage, modelRegistry, source }) {
  intro("infer config");

  const localCatalog = buildLocalCatalog(modelRegistry);
  if (localCatalog.models.length === 0) {
    outro("No local models found. Check your installation.");
    return;
  }

  const selectedSource =
    source ??
    (await select({
      message: "Model source",
      options: [
        { value: "local", label: "Local Pi registry", hint: "Fast, tool-calling models only" },
        { value: "models.dev", label: "models.dev", hint: "Filtered to models supported here" },
      ],
      initialValue: "local",
    }));

  if (isCancel(selectedSource)) {
    outro("Canceled.");
    return;
  }

  let catalog = localCatalog;
  if (selectedSource === "models.dev") {
    const spin = spinner();
    spin.start("Fetching models.dev");
    try {
      catalog = await buildModelsDevCatalog(modelRegistry, localCatalog.index);
      spin.stop("Loaded models.dev");
    } catch (error) {
      spin.stop("Failed to load models.dev");
      const message = error instanceof Error ? error.message : String(error);
      note(message, "Using local registry instead");
      catalog = localCatalog;
    }
  }

  const reasoningOnly = await confirm({
    message: "Require reasoning support?",
    initialValue: false,
  });
  if (isCancel(reasoningOnly)) {
    outro("Canceled.");
    return;
  }

  const minContext = await select({
    message: "Minimum context window",
    options: [
      { value: 0, label: "No minimum" },
      { value: 32000, label: "32k" },
      { value: 128000, label: "128k" },
      { value: 256000, label: "256k" },
      { value: 1000000, label: "1M" },
    ],
    initialValue: 0,
  });
  if (isCancel(minContext)) {
    outro("Canceled.");
    return;
  }

  const filtered = filterCatalog(catalog.models, {
    reasoningOnly,
    minContext,
  });

  if (filtered.length === 0) {
    note("No models matched those filters.", "No matches");
    outro("Canceled.");
    return;
  }

  const providerOptions = buildProviderOptions(filtered);
  const providerId = await autocomplete({
    message: "Provider",
    options: providerOptions,
    maxItems: 12,
  });
  if (isCancel(providerId)) {
    outro("Canceled.");
    return;
  }

  const modelOptions = buildModelOptions(filtered, providerId);
  if (modelOptions.length === 0) {
    note("No models found for that provider.", "No matches");
    outro("Canceled.");
    return;
  }

  const modelId = await autocomplete({
    message: "Model",
    options: modelOptions,
    maxItems: 12,
  });
  if (isCancel(modelId)) {
    outro("Canceled.");
    return;
  }

  const currentThinking = settingsManager.getDefaultThinkingLevel() ?? "off";
  const thinkingLevel = await select({
    message: "Default thinking level",
    options: [
      { value: "off", label: "off" },
      { value: "minimal", label: "minimal" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
    ],
    initialValue: currentThinking,
  });
  if (isCancel(thinkingLevel)) {
    outro("Canceled.");
    return;
  }

  const saveDefaults = await confirm({
    message: `Save ${providerId}/${modelId} as defaults?`,
    initialValue: true,
  });
  if (isCancel(saveDefaults) || !saveDefaults) {
    outro("No changes saved.");
    return;
  }

  settingsManager.setDefaultModelAndProvider(providerId, modelId);
  settingsManager.setDefaultThinkingLevel(thinkingLevel);

  const storeKey = await confirm({
    message: "Store an API key now?",
    initialValue: false,
  });
  if (isCancel(storeKey)) {
    outro("Saved defaults without API key.");
    return;
  }

  if (storeKey) {
    const apiKey = await password({
      message: "API key (stored in auth.json)",
      mask: "*",
    });
    if (isCancel(apiKey)) {
      outro("Saved defaults without API key.");
      return;
    }
    if (apiKey) {
      authStorage.set(providerId, { type: "api_key", key: apiKey });
    }
  }

  note(
    `Defaults saved to ${join(agentDir, "settings.json")}.\nAuth stored in ${join(
      agentDir,
      "auth.json",
    )}.`,
    "Done",
  );
  outro("Configuration complete.");
}

function buildLocalCatalog(modelRegistry) {
  const models = modelRegistry.getAll().map((model) => ({
    providerId: model.provider,
    providerName: model.provider,
    modelId: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning),
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
    maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 0,
  }));
  return {
    source: "local",
    models,
    index: indexModels(models),
  };
}

async function buildModelsDevCatalog(modelRegistry, localIndex) {
  const response = await fetch("https://models.dev/api.json");
  if (!response.ok) {
    throw new Error(`models.dev request failed: ${response.status}`);
  }
  const data = await response.json();
  const providerAliases = {
    azure: "azure-openai-responses",
    "kimi-for-coding": "kimi-coding",
    vercel: "vercel-ai-gateway",
  };

  const models = [];
  const providers = Object.values(data);
  for (const provider of providers) {
    if (!provider || !provider.id || !provider.models) {
      continue;
    }
    const rawProviderId = String(provider.id);
    const providerId = providerAliases[rawProviderId] ?? rawProviderId;
    const providerModels = provider.models;
    if (!localIndex.has(providerId)) {
      continue;
    }
    for (const model of Object.values(providerModels)) {
      if (!model || !model.id) {
        continue;
      }
      if (model.tool_call === false) {
        continue;
      }
      const modelId = String(model.id);
      const localProviderModels = localIndex.get(providerId);
      if (!localProviderModels || !localProviderModels.has(modelId)) {
        continue;
      }
      const localModel = localProviderModels.get(modelId);
      models.push({
        providerId,
        providerName: provider.name ?? providerId,
        modelId,
        name: model.name ?? (localModel?.name ?? modelId),
        reasoning: model.reasoning ?? Boolean(localModel?.reasoning),
        contextWindow: resolveNumber(model.limit?.context, localModel?.contextWindow),
        maxTokens: resolveNumber(model.limit?.output, localModel?.maxTokens),
      });
    }
  }

  if (models.length === 0) {
    return buildLocalCatalog(modelRegistry);
  }

  return {
    source: "models.dev",
    models,
    index: indexModels(models),
  };
}

function indexModels(models) {
  const map = new Map();
  for (const model of models) {
    if (!map.has(model.providerId)) {
      map.set(model.providerId, new Map());
    }
    map.get(model.providerId).set(model.modelId, model);
  }
  return map;
}

function filterCatalog(models, { reasoningOnly, minContext }) {
  return models.filter((model) => {
    if (reasoningOnly && !model.reasoning) {
      return false;
    }
    if (minContext > 0) {
      return model.contextWindow >= minContext;
    }
    return true;
  });
}

function buildProviderOptions(models) {
  const counts = new Map();
  const names = new Map();
  for (const model of models) {
    counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
    if (!names.has(model.providerId)) {
      names.set(model.providerId, model.providerName || model.providerId);
    }
  }
  return Array.from(counts.entries())
    .map(([providerId, count]) => ({
      value: providerId,
      label: `${names.get(providerId)} (${providerId})`,
      hint: `${count} models`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function buildModelOptions(models, providerId) {
  const filtered = models.filter((model) => model.providerId === providerId);
  return filtered
    .map((model) => ({
      value: model.modelId,
      label: model.name,
      hint: `id: ${model.modelId} | ctx ${formatContext(model.contextWindow)} | reasoning ${
        model.reasoning ? "yes" : "no"
      }`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatContext(value) {
  if (!value || value <= 0) {
    return "n/a";
  }
  if (value >= 1000000) {
    return `${Math.round(value / 100000) / 10}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return String(value);
}

function resolveNumber(value, fallback) {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  if (typeof fallback === "number" && !Number.isNaN(fallback)) {
    return fallback;
  }
  return 0;
}

function gray(text) {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${DIM}${text}${RESET}`;
}

function createBashApprovalExtension() {
  let allowAll = false;

  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "bash") {
        return;
      }

      if (allowAll) {
        return;
      }

      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (!process.stdin.isTTY) {
        return { block: true, reason: "Bash command blocked: no TTY for approval." };
      }

      suppressBashToolLine = true;
      let decision;
      try {
        decision = await promptBashApproval(command);
      } finally {
        suppressBashToolLine = false;
      }

      if (decision === "accept_all") {
        allowAll = true;
        return;
      }

      if (decision === "accept") {
        return;
      }

      return { block: true, reason: "Bash command rejected by user." };
    });
  };
}

async function promptBashApproval(command) {
  return inquirerSelect({
    message: gray(`! ${command || "(empty)"}`),
    choices: [
      { value: "accept", name: "Accept" },
      { value: "reject", name: "Reject" },
      { value: "accept_all", name: "Dangerous Accept All" },
    ],
    pageSize: 3,
    loop: false,
    theme: {
      prefix: "",
      icon: {
        cursor: ">",
      },
      indexMode: "hidden",
      style: {
        keysHelpTip: () => undefined,
        disabled: (text) => text,
        description: (text) => text,
      },
    },
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
