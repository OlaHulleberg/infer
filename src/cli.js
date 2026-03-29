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
  text,
} from "@clack/prompts";
import inquirerSelect from "@inquirer/select";
import { completeSimple } from "@mariozechner/pi-ai";
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { spawn, execFileSync } from "child_process";

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
  if (arg === "config") {
    options.command = "config";
    continue;
  }
  if (arg === "login") {
    options.command = "login";
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

const agentDir = resolveAgentDir();
const sessionDir = join(agentDir, "sessions");
const sessionFile = join(sessionDir, "last.jsonl");

ensureDir(agentDir);
ensureDir(sessionDir);

const settingsManager = SettingsManager.create(process.cwd(), agentDir);
const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
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
  });
  process.exit(0);
}

if (options.command === "login") {
  await runLogin({ authStorage, providerId: promptParts[0] });
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

const classifierConfig = loadClassifierConfig(agentDir);
const sandboxBin = detectSandbox();

if (classifierConfig && !sandboxBin) {
  process.stderr.write(
    gray(
      "Warning: classifier is active but no sandbox detected. Auto-approved commands run without isolation.\n" +
      "  Linux: install bubblewrap (bwrap)  |  macOS: sandbox-exec should be built-in\n",
    ),
  );
}

const sandboxState = { next: false };

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  extensionFactories: [createBashApprovalExtension({ modelRegistry, classifierConfig, sandboxBin, sandboxState })],
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

if (sandboxBin && classifierConfig) {
  const bt = session.agent.state.tools.find((t) => t.name === "bash");
  if (bt) {
    const orig = bt.execute;
    bt.execute = async (id, args, signal, progress) => {
      if (sandboxState.next) {
        sandboxState.next = false;
        args = { ...args, command: wrapWithSandbox(args.command, sandboxBin) };
      }
      return orig(id, args, signal, progress);
    };
  }
}

let lastAssistantText = "";
let printedToolLine = false;

session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    if (event.toolName === "bash") {
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
      `  config                         Interactive configuration\n` +
      `  login [provider]               Login to an OAuth provider\n\n` +
      `Options:\n` +
      `  -c, --continue, -r, --resume  Continue last session\n` +
      `  -p, --provider <name>         Model provider\n` +
      `  -m, --model <id>              Model id\n` +
      `  --thinking <level>            off|minimal|low|medium|high|xhigh\n` +
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

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

async function runLogin({ authStorage, providerId }) {
  intro("infer login");

  const providers = authStorage.getOAuthProviders();
  if (providers.length === 0) {
    outro("No OAuth providers available.");
    return;
  }

  let resolvedId = providerId;
  if (!resolvedId) {
    const choice = await select({
      message: "Provider",
      options: providers.map((p) => ({ value: p.id, label: p.name ?? p.id })),
    });
    if (isCancel(choice)) {
      outro("Canceled.");
      return;
    }
    resolvedId = choice;
  }

  const spin = spinner();
  spin.start(`Logging in to ${resolvedId}`);

  try {
    await authStorage.login(resolvedId, {
      onAuth: ({ url, instructions }) => {
        spin.stop(instructions ? `${instructions}\n  ${url}` : url);
        openBrowser(url);
      },
      onPrompt: async ({ message }) => {
        const input = await text({ message });
        if (isCancel(input)) throw new Error("Canceled.");
        return input;
      },
      onManualCodeInput: async () => {
        const input = await text({ message: "Paste the authorization code or redirect URL:" });
        if (isCancel(input)) throw new Error("Canceled.");
        return input;
      },
      onProgress: (message) => {
        spin.start(message);
      },
    });
    spin.stop(`Logged in to ${resolvedId}`);
    outro("Done.");
  } catch (err) {
    spin.stop("Login failed.");
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function runConfigurator({ agentDir, settingsManager, authStorage, modelRegistry }) {
  intro("infer config");

  const catalog = buildLocalCatalog(modelRegistry);
  if (catalog.models.length === 0) {
    outro("No local models found. Check your installation.");
    return;
  }

  const providerOptions = buildProviderOptions(catalog.models);
  const providerId = await autocomplete({
    message: "Provider",
    options: providerOptions,
    maxItems: 12,
  });
  if (isCancel(providerId)) {
    outro("Canceled.");
    return;
  }

  const modelOptions = buildModelOptions(catalog.models, providerId);
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

  const configureClassifier = await confirm({
    message: "Configure a classifier model for auto-approving safe bash commands?",
    initialValue: false,
  });
  if (isCancel(configureClassifier)) {
    outro("Configuration complete.");
    return;
  }

  if (configureClassifier) {
    const classifierProviderOptions = buildProviderOptions(catalog.models);
    const classifierProviderId = await autocomplete({
      message: "Classifier provider",
      options: classifierProviderOptions,
      maxItems: 12,
    });
    if (isCancel(classifierProviderId)) {
      outro("Configuration complete.");
      return;
    }

    const classifierModelOptions = buildModelOptions(catalog.models, classifierProviderId);
    if (classifierModelOptions.length === 0) {
      note("No models found for that provider.", "Skipping classifier");
    } else {
      const classifierModelId = await autocomplete({
        message: "Classifier model",
        options: classifierModelOptions,
        maxItems: 12,
      });
      if (isCancel(classifierModelId)) {
        outro("Configuration complete.");
        return;
      }
      saveClassifierConfig(agentDir, { provider: classifierProviderId, model: classifierModelId });
      note(`Classifier: ${classifierProviderId}/${classifierModelId}`, "Classifier saved");
    }
  }

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

function detectSandbox() {
  try {
    if (process.platform === "linux") {
      execFileSync("which", ["bwrap"], { stdio: "ignore" });
      return "bwrap";
    }
    if (process.platform === "darwin") {
      execFileSync("which", ["sandbox-exec"], { stdio: "ignore" });
      return "sandbox-exec";
    }
  } catch {}
  return null;
}

function wrapWithSandbox(command, sandboxBin) {
  const q = "'" + command.replace(/'/g, "'\\''") + "'";
  if (sandboxBin === "bwrap") {
    return `bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc --tmpfs /tmp -- sh -c ${q}`;
  }
  if (sandboxBin === "sandbox-exec") {
    const profile = "(version 1)(deny default)(allow file-read* file-map-executable process-exec process-fork signal sysctl-read mach-lookup)";
    return `sandbox-exec -p '${profile}' sh -c ${q}`;
  }
  return command;
}

function loadClassifierConfig(agentDir) {
  const file = join(agentDir, "classifier.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
      return { provider: parsed.provider, model: parsed.model };
    }
    return null;
  } catch {
    return null;
  }
}

function saveClassifierConfig(agentDir, config) {
  writeFileSync(join(agentDir, "classifier.json"), JSON.stringify(config, null, 2), "utf-8");
}

function gray(text) {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${DIM}${text}${RESET}`;
}

function createBashApprovalExtension({ modelRegistry, classifierConfig, sandboxBin, sandboxState }) {
  let allowAll = false;

  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "bash") {
        return;
      }

      if (allowAll) {
        const command = typeof event.input?.command === "string" ? event.input.command : "";
        process.stdout.write(gray(`! ${command}\n`));
        return;
      }

      if (!process.stdin.isTTY) {
        return { block: true, reason: "Bash command blocked: no TTY for approval." };
      }

      const command = typeof event.input?.command === "string" ? event.input.command : "";

      if (classifierConfig) {
        const classification = await classifyCommand(command, { modelRegistry, classifierConfig });
        if (classification.harmless) {
          process.stdout.write(gray(`✓ ${classification.description}\n`));
          if (sandboxBin) sandboxState.next = true;
          return;
        }
        let decision;
        try {
          decision = await promptBashApproval(command, classification.description);
        } catch (e) {
          throw e;
        }
        if (decision === "accept_all") { allowAll = true; return; }
        if (decision === "accept") return;
        return { block: true, reason: "Bash command rejected by user." };
      }

      let decision;
      try {
        decision = await promptBashApproval(command);
      } catch (e) {
        throw e;
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

async function classifyCommand(command, { modelRegistry, classifierConfig }) {
  try {
    const model = modelRegistry.find(classifierConfig.provider, classifierConfig.model);
    if (!model) return { harmless: false, description: command };

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return { harmless: false, description: command };

    const result = await completeSimple(
      model,
      {
        systemPrompt: `Classify a bash command. Respond ONLY with JSON: {"description":"<concise action, max 6 words>","harmless":<true|false>}

"harmless" is true ONLY if the command is purely read-only and non-destructive:
- Reading files, listing directories, searching content (cat, ls, find, grep, head, tail, wc, etc.)
- Fetching URLs for display only (curl/wget without -o or piping to shell)
- Checking system state (ps, env, which, pwd, uname, echo, etc.)

"harmless" is false if the command:
- Writes, creates, moves, copies, or deletes files
- Makes API calls with side effects
- Downloads and saves files
- Runs scripts (.sh, .py, etc.) without reading them first
- Uses sudo or elevated privileges
- Pipes into another shell or interpreter
- Has any side effects beyond reading`,
        messages: [{ role: "user", content: command, timestamp: Date.now() }],
      },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 500 }
    );

    const text = result.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { harmless: false, description: command };
    const parsed = JSON.parse(match[0]);
    return {
      description: typeof parsed.description === "string" ? parsed.description : command,
      harmless: parsed.harmless === true,
    };
  } catch {
    return { harmless: false, description: command };
  }
}

async function promptBashApproval(command, description) {
  return inquirerSelect({
    message: gray(`! ${description || command || "(empty)"}`),
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
