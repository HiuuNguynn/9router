import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { createProviderConnection, getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { CODEX_CONFIG } from "@/lib/oauth/constants/oauth";
import { parseTOML, stringifyTOML } from "confbox";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const getCodexDir = () => path.join(os.homedir(), ".codex");
const getCodexAuthPath = () => path.join(getCodexDir(), "auth.json");
const getCodexConfigPath = () => path.join(getCodexDir(), "config.toml");

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const [, payload] = jwt.split(".");
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractCodexIdentity({ idToken, accessToken, accountId }) {
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  const openaiAuth = idPayload?.["https://api.openai.com/auth"] || accessPayload?.["https://api.openai.com/auth"] || {};
  return {
    email: idPayload?.email || accessPayload?.email || accessPayload?.preferred_username || null,
    accountId: accountId || openaiAuth.chatgpt_account_id || idPayload?.account_id || accessPayload?.account_id || null,
    planType: openaiAuth.chatgpt_plan_type || idPayload?.plan_type || accessPayload?.plan_type || null,
  };
}

async function readAuthFile() {
  try {
    const raw = await fs.readFile(getCodexAuthPath(), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAuthFile(authData) {
  await fs.mkdir(getCodexDir(), { recursive: true });
  await fs.writeFile(getCodexAuthPath(), `${JSON.stringify(authData, null, 2)}\n`, "utf8");
}

function deleteNestedSection(obj, dottedKey) {
  const keys = dottedKey.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    cursor = cursor?.[keys[i]];
    if (!cursor) return;
  }
  delete cursor[keys[keys.length - 1]];
}

async function disableCodexProxyConfig() {
  const configPath = getCodexConfigPath();
  let parsed;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    parsed = parseTOML(raw) || {};
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  let changed = false;
  if (parsed.model_provider === "9router") {
    delete parsed.model_provider;
    delete parsed.model;
    changed = true;
  }
  if (parsed.model_providers?.["9router"]) {
    deleteNestedSection(parsed, "model_providers.9router");
    changed = true;
  }
  if (parsed.agents?.subagent) {
    deleteNestedSection(parsed, "agents.subagent");
    changed = true;
  }

  if (!changed) return false;
  await fs.writeFile(configPath, stringifyTOML(parsed), "utf8");
  return true;
}

async function backupAuthFile() {
  const authPath = getCodexAuthPath();
  try {
    await fs.access(authPath);
  } catch {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(getCodexDir(), `auth.9router-backup-${stamp}.json`);
  await fs.copyFile(authPath, backupPath);
  return backupPath;
}

async function getCodexProcessStatus() {
  if (os.platform() === "win32") {
    return { running: false, count: 0, processes: [] };
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-af", "codex"], { timeout: 3000 });
    const selfPid = String(process.pid);
    const processes = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(`${selfPid} `))
      .filter((line) => {
        const lower = line.toLowerCase();
        if (lower.includes("next dev") || lower.includes("next-server")) return false;
        if (lower.includes("9router")) return false;
        return lower.includes("/codex") || lower.includes("bin/codex") || lower.includes(" codex");
      })
      .map((line) => {
        const [pid, ...rest] = line.split(/\s+/);
        return {
          pid,
          command: rest.join(" ").slice(0, 180),
        };
      });

    return {
      running: processes.length > 0,
      count: processes.length,
      processes,
    };
  } catch {
    return { running: false, count: 0, processes: [] };
  }
}

function toSafeAccount(connection, currentIdentity) {
  const psd = connection.providerSpecificData || {};
  const identity = extractCodexIdentity({
    idToken: psd.idToken,
    accessToken: connection.accessToken,
    accountId: psd.chatgptAccountId,
  });
  const accountId = identity.accountId || psd.chatgptAccountId || null;
  const email = connection.email || identity.email || null;

  return {
    id: connection.id,
    name: connection.name || connection.displayName || email || "Codex Account",
    email,
    accountId,
    planType: psd.chatgptPlanType || identity.planType || null,
    priority: connection.priority || null,
    isActive: connection.isActive !== false,
    testStatus: connection.testStatus || null,
    lastError: connection.lastError || null,
    activeInCodex: Boolean(
      (currentIdentity.accountId && accountId && currentIdentity.accountId === accountId) ||
      (currentIdentity.accessToken && connection.accessToken && currentIdentity.accessToken === connection.accessToken)
    ),
  };
}

async function refreshCodexConnection(connection) {
  if (!connection.refreshToken) return connection;

  const response = await fetch(CODEX_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CONFIG.clientId,
      refresh_token: connection.refreshToken,
      scope: CODEX_CONFIG.scope,
    }),
  });

  if (!response.ok) {
    return connection;
  }

  const tokens = await response.json();
  const idToken = tokens.id_token || connection.providerSpecificData?.idToken || null;
  const identity = extractCodexIdentity({
    idToken,
    accessToken: tokens.access_token || connection.accessToken,
    accountId: connection.providerSpecificData?.chatgptAccountId,
  });

  const providerSpecificData = {
    ...(connection.providerSpecificData || {}),
  };
  if (idToken) providerSpecificData.idToken = idToken;
  if (identity.accountId) providerSpecificData.chatgptAccountId = identity.accountId;
  if (identity.planType) providerSpecificData.chatgptPlanType = identity.planType;

  const updateData = {
    accessToken: tokens.access_token || connection.accessToken,
    refreshToken: tokens.refresh_token || connection.refreshToken,
    providerSpecificData,
  };
  if (tokens.expires_in) {
    updateData.expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  }
  if (!connection.email && identity.email) {
    updateData.email = identity.email;
  }

  return await updateProviderConnection(connection.id, updateData);
}

async function activateAccount(connectionId) {
  let connection = await getProviderConnectionById(connectionId);
  if (!connection || connection.provider !== "codex") {
    return NextResponse.json({ error: "Codex account not found" }, { status: 404 });
  }

  connection = await refreshCodexConnection(connection);
  if (!connection?.accessToken) {
    return NextResponse.json({ error: "Selected account has no usable Codex access token" }, { status: 400 });
  }

  const currentAuth = await readAuthFile();
  const backupPath = await backupAuthFile();
  const psd = connection.providerSpecificData || {};
  const identity = extractCodexIdentity({
    idToken: psd.idToken,
    accessToken: connection.accessToken,
    accountId: psd.chatgptAccountId,
  });

  const nextAuth = {
    ...(currentAuth || {}),
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      ...(currentAuth?.tokens || {}),
      id_token: psd.idToken || null,
      access_token: connection.accessToken || currentAuth?.tokens?.access_token || null,
      refresh_token: connection.refreshToken || currentAuth?.tokens?.refresh_token || null,
      account_id: identity.accountId || null,
    },
    last_refresh: new Date().toISOString(),
  };

  await writeAuthFile(nextAuth);
  const disabledProxyConfig = await disableCodexProxyConfig();
  const codexProcesses = await getCodexProcessStatus();

  return NextResponse.json({
    success: true,
    account: toSafeAccount(connection, {
      accountId: nextAuth.tokens.account_id,
      accessToken: nextAuth.tokens.access_token,
    }),
    authPath: getCodexAuthPath(),
    backupPath,
    disabledProxyConfig,
    codexProcesses,
    restartRequired: codexProcesses.running,
  });
}

async function importAccount(authData) {
  const tokens = authData?.tokens || {};
  const accessToken = tokens.access_token || authData?.accessToken || null;
  const refreshToken = tokens.refresh_token || authData?.refreshToken || null;
  const idToken = tokens.id_token || authData?.idToken || null;
  const identity = extractCodexIdentity({
    idToken,
    accessToken,
    accountId: tokens.account_id || authData?.accountId,
  });

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: "Backup JSON does not contain Codex tokens" }, { status: 400 });
  }

  const providerSpecificData = {};
  if (idToken) providerSpecificData.idToken = idToken;
  if (identity.accountId) providerSpecificData.chatgptAccountId = identity.accountId;
  if (identity.planType) providerSpecificData.chatgptPlanType = identity.planType;

  const connection = await createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: identity.email || identity.accountId || "Codex Account",
    email: identity.email,
    accessToken,
    refreshToken,
    providerSpecificData,
    testStatus: "active",
  });

  return NextResponse.json({
    success: true,
    account: toSafeAccount(connection, { accountId: null, accessToken: null }),
  }, { status: 201 });
}

export async function GET() {
  try {
    const [connections, currentAuth] = await Promise.all([
      getProviderConnections({ provider: "codex" }),
      readAuthFile(),
    ]);
    const currentIdentity = {
      accountId: currentAuth?.tokens?.account_id || null,
      accessToken: currentAuth?.tokens?.access_token || null,
    };

    const codexProcesses = await getCodexProcessStatus();

    return NextResponse.json({
      authPath: getCodexAuthPath(),
      accounts: connections.map((connection) => toSafeAccount(connection, currentIdentity)),
      codexProcesses,
    });
  } catch (error) {
    console.log("Error loading Codex accounts:", error);
    return NextResponse.json({ error: "Failed to load Codex accounts" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (body.action === "activate") return await activateAccount(body.connectionId);
    if (body.action === "import") return await importAccount(body.auth);
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log("Error updating Codex accounts:", error);
    return NextResponse.json({ error: error.message || "Failed to update Codex accounts" }, { status: 500 });
  }
}
