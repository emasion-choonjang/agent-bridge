#!/usr/bin/env node
/**
 * Agent Bridge — Redis pub/sub relay for inter-agent communication.
 *
 * Each OpenClaw instance runs this script.  When a Telegram group message
 * mentions another agent, the bridge publishes it to Redis.  The remote
 * bridge instance picks it up and injects it into its local OpenClaw agent
 * via `openclaw agent -m`.
 *
 * Env vars (or .env):
 *   AGENT_NAME        — this agent's name, e.g. "choa" or "sera"
 *   REDIS_HOST        — team Redis host (default: 100.123.82.47)
 *   REDIS_PORT        — team Redis port (default: 6380)
 *   REDIS_PASSWORD    — team Redis password
 *   OPENCLAW_BIN      — path to openclaw binary
 *   CHANNEL           — Redis pub/sub channel (default: "agent-bridge")
 *   BOT_TOKEN         — Telegram bot token for auto-echo (main agent)
 *   EXTRA_BOT_TOKENS  — extra agent bot tokens, format: "agentId:token,agentId2:token2"
 */

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { execFile } = require("child_process");
const Redis = require("ioredis");
const path = require("path");

// --- load .env if present ---
try {
  const fs = require("fs");
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}

const AGENT = (process.env.AGENT_NAME || "").toLowerCase();
const CHANNEL = process.env.CHANNEL || "agent-bridge";
const GROUP_ID = process.env.GROUP_ID || "-1003554423969";
const REDIS_OPTS = {
  host: process.env.REDIS_HOST || "100.123.82.47",
  port: parseInt(process.env.REDIS_PORT || "6380", 10),
  password: process.env.REDIS_PASSWORD || "",
  retryStrategy: (times) => Math.min(times * 1000, 30000),
};
const OPENCLAW = process.env.OPENCLAW_BIN || "openclaw";

// Multi-agent routing: EXTRA_AGENTS="sori:소리|sori|SoRi"
// Format: "agentId:pattern1|pattern2,agentId2:pattern1|pattern2"
const EXTRA_AGENTS = process.env.EXTRA_AGENTS || "";

if (!AGENT) {
  console.error("AGENT_NAME is required");
  process.exit(1);
}

// --- loop prevention ---
const COOLDOWN_MS = 5000;
let lastInject = 0;
const MAX_DEPTH = 3;

// --- Build list of agents this bridge handles ---
const localAgents = [AGENT];
const extraAgentConfigs = {};
if (EXTRA_AGENTS) {
  for (const entry of EXTRA_AGENTS.split(",")) {
    const [agentId] = entry.split(":");
    if (agentId) {
      localAgents.push(agentId.toLowerCase());
      extraAgentConfigs[agentId.toLowerCase()] = true;
    }
  }
}

// --- Redis connections (need separate for sub + pub) ---
const sub = new Redis(REDIS_OPTS);
const pub = new Redis(REDIS_OPTS);

sub.subscribe(CHANNEL, (err) => {
  if (err) {
    console.error("Subscribe error:", err.message);
    process.exit(1);
  }
  console.log(`[${AGENT}] subscribed to ${CHANNEL}`);
});

sub.on("message", (_ch, raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // ignore own messages (for non-echo)
  if (msg.from === AGENT && msg.type !== "echo") return;

  // --- Echo message handling ---
  if (msg.type === "echo") {
    // Map agent names to their known aliases (for self-detection)
    const agentAliases = {
      choa: ["choa", "초아"],
      sera: ["sera", "세라"],
      sori: ["sori", "소리"],
      nichris: ["nichris", "니크리스"],
    };

    // Find which local agent sent this echo (if any)
    const senderLower = msg.from.toLowerCase();
    const senderAgent = localAgents.find((a) => {
      if (a === senderLower) return true;
      const aliases = agentAliases[a] || [];
      return aliases.includes(senderLower);
    });

    const echoText = `[echo from:${msg.from}] ${msg.text}`;

    // Inject echo to local agents EXCEPT the sender
    for (const targetAgent of localAgents) {
      // Skip if this agent is the sender (don't echo back to yourself)
      if (targetAgent === senderAgent) continue;

      const args = ["agent", "--channel", "telegram", "--to", GROUP_ID, "-m", echoText];
      if (extraAgentConfigs[targetAgent]) {
        args.splice(1, 0, "--agent", targetAgent);
      }
      execFile(OPENCLAW, args, { timeout: 60000, env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" } }, (err, stdout) => {
        if (err) console.error(`[${targetAgent}] Echo inject error:`, err.message);
        else console.log(`[${targetAgent}] Echo from ${msg.from}: ${msg.text.slice(0, 50)}...`);
      });
    }
    return;
  }

  // depth guard
  if ((msg.depth || 0) >= MAX_DEPTH) return;

  // cooldown
  const now = Date.now();
  if (now - lastInject < COOLDOWN_MS) return;
  lastInject = now;

  // check if this message mentions any local agent
  const text = msg.text || "";
  const mentionPatterns = {
    choa: /초아|choa|ChoA/i,
    sera: /세라|sera|SeRA/i,
    sori: /소리|sori|SoRi/i,
    nichris: /니크리스|nichris|NiChris/i,
  };

  // Find which local agents are mentioned
  const mentionedAgents = localAgents.filter((a) => {
    const p = mentionPatterns[a];
    return p && p.test(text);
  });

  if (mentionedAgents.length === 0) return;

  const depth = (msg.depth || 0) + 1;

  for (const targetAgent of mentionedAgents) {
    console.log(`[${targetAgent}] injecting message from ${msg.from}: ${text.slice(0, 80)}...`);

    const injectText = `[agent-bridge from:${msg.from} depth:${depth}] ${text}`;
    
    // For extra agents, use --agent flag to route to specific agent
    const args = ["agent", "--channel", "telegram", "--to", GROUP_ID, "-m", injectText, "--deliver"];
    if (extraAgentConfigs[targetAgent]) {
      args.splice(1, 0, "--agent", targetAgent);
    }

    execFile(OPENCLAW, args, { timeout: 60000, env: { ...process.env, PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" } }, (err, stdout, stderr) => {
      if (err) console.error(`[${targetAgent}] Inject error:`, err.message);
      else console.log(`[${targetAgent}] Injected OK:`, stdout.slice(0, 100));
    });
  }
});

// --- publish helper (call from outside or extend) ---
function publish(text, depth = 0) {
  const payload = JSON.stringify({ from: AGENT, text, depth, ts: Date.now() });
  pub.publish(CHANNEL, payload);
}

// --- stdin listener for manual publish (pipe messages in) ---
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.trim();
  if (text) publish(text);
});

// --- Telegram auto-echo: watch own bot messages in group ---
const https = require("https");

function telegramGet(token, method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const url = `https://api.telegram.org/bot${token}/${method}${qs ? "?" + qs : ""}`;
    https.get(url, { family: 4 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function startAutoEcho(agentName, token) {
  let offset = 0;
  // Get bot info to know bot's user id
  const me = await telegramGet(token, "getMe");
  if (!me.ok) {
    console.error(`[auto-echo:${agentName}] getMe failed:`, me);
    return;
  }
  const botId = me.result.id;
  console.log(`[auto-echo:${agentName}] watching bot ${me.result.username} (${botId}) for group messages`);

  const groupId = parseInt(GROUP_ID, 10);

  async function poll() {
    try {
      const updates = await telegramGet(token, "getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: JSON.stringify(["message"]),
      });
      if (updates.ok && updates.result.length > 0) {
        for (const upd of updates.result) {
          offset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg || !msg.text) continue;
          // Only echo messages FROM this bot IN the target group
          if (msg.from && msg.from.id === botId && msg.chat && msg.chat.id === groupId) {
            const payload = JSON.stringify({
              type: "echo",
              from: agentName,
              text: msg.text,
              ts: Date.now(),
            });
            pub.publish(CHANNEL, payload);
            console.log(`[auto-echo:${agentName}] published: ${msg.text.slice(0, 60)}...`);
          }
        }
      }
    } catch (err) {
      console.error(`[auto-echo:${agentName}] poll error:`, err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
    setTimeout(poll, 500);
  }
  poll();
}

// Start auto-echo for main agent
if (process.env.BOT_TOKEN) {
  startAutoEcho(AGENT, process.env.BOT_TOKEN).catch((e) =>
    console.error(`[auto-echo:${AGENT}] start failed:`, e.message)
  );
}

// Start auto-echo for extra agents
if (process.env.EXTRA_BOT_TOKENS) {
  for (const entry of process.env.EXTRA_BOT_TOKENS.split(",")) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx > 0) {
      const agentId = entry.slice(0, colonIdx).toLowerCase();
      const token = entry.slice(colonIdx + 1);
      startAutoEcho(agentId, token).catch((e) =>
        console.error(`[auto-echo:${agentId}] start failed:`, e.message)
      );
    }
  }
}

// --- graceful shutdown ---
process.on("SIGINT", () => {
  console.log("Shutting down...");
  sub.disconnect();
  pub.disconnect();
  process.exit(0);
});

process.on("SIGTERM", () => {
  sub.disconnect();
  pub.disconnect();
  process.exit(0);
});

console.log(`[${AGENT}] bridge running — Redis ${REDIS_OPTS.host}:${REDIS_OPTS.port}`);

module.exports = { publish };
