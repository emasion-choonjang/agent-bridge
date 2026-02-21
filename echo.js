#!/usr/bin/env node
/**
 * Echo publish — agents call this after sending a group chat message.
 * Usage: node echo.js "agent_name" "message text"
 * Reads Redis config from .env in the same directory.
 */
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const path = require("path");
const fs = require("fs");

// load .env
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}

const Redis = require("ioredis");

const agent = process.argv[2];
const text = process.argv[3];

if (!agent || !text) {
  console.error("Usage: node echo.js <agent_name> <message>");
  process.exit(1);
}

const redis = new Redis({
  host: process.env.REDIS_HOST || "100.123.82.47",
  port: parseInt(process.env.REDIS_PORT || "6380", 10),
  password: process.env.REDIS_PASSWORD || "",
});

const payload = JSON.stringify({
  type: "echo",
  from: agent,
  text: text,
  ts: Date.now(),
});

redis
  .publish(process.env.CHANNEL || "agent-bridge", payload)
  .then(() => {
    redis.disconnect();
  })
  .catch((err) => {
    console.error("Echo publish error:", err.message);
    redis.disconnect();
    process.exit(1);
  });
