#!/usr/bin/env node
/**
 * Agent Bridge — Redis pub/sub relay for OpenClaw agent-to-agent communication
 * 
 * Each agent runs this script. It:
 * 1. Subscribes to the team-chat Redis channel
 * 2. Watches for mentions of this agent
 * 3. Injects mentioned messages into local OpenClaw via `openclaw agent -m`
 * 4. Publishes outgoing messages from local OpenClaw to Redis
 * 
 * Usage: AGENT_ID=choa REDIS_URL=redis://:pass@100.123.82.47:6380 node bridge.js
 */

require('dotenv').config();
const Redis = require('ioredis');
const { execSync, spawn } = require('child_process');
const path = require('path');

// --- Config ---
const AGENT_ID = process.env.AGENT_ID || 'choa';
const REDIS_URL = process.env.REDIS_URL || 'redis://:choonjang-team-2026@100.123.82.47:6380';
const CHANNEL = 'team-chat';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || findOpenClaw();
const TELEGRAM_GROUP = process.env.TELEGRAM_GROUP || '-1003554423969';
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '5000');
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || '3');

// Agent mention patterns
const MENTION_MAP = {
  choa: ['초아', '@choonjang_bot', '초아야', '초아한테', '초아가', '초아는', '초아도'],
  sera: ['세라', '@sera_choonjang_bot', '세라야', '세라한테', '세라가', '세라는', '세라도'],
  nicris: ['니크리스', '@nicrees_choonjang_bot', '니크리스한테', '니크리스가'],
};

// --- State ---
let lastInjectTime = 0;

function findOpenClaw() {
  try {
    return execSync('which openclaw 2>/dev/null || find ~/.nvm -name openclaw -type f 2>/dev/null | head -1', 
      { encoding: 'utf-8' }).trim();
  } catch {
    return path.join(process.env.HOME, '.nvm/versions/node/v22.19.0/bin/openclaw');
  }
}

function isMentioned(text, agentId) {
  const patterns = MENTION_MAP[agentId] || [];
  const lower = text.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function injectToOpenClaw(message) {
  const now = Date.now();
  if (now - lastInjectTime < COOLDOWN_MS) {
    console.log(`[bridge] Cooldown active, skipping inject`);
    return;
  }
  lastInjectTime = now;

  const depth = message.depth || 0;
  if (depth >= MAX_DEPTH) {
    console.log(`[bridge] Max depth ${MAX_DEPTH} reached, skipping`);
    return;
  }

  // Format as a group chat message context
  const injectText = `[Agent Bridge - ${message.from} said in group]: ${message.text}`;
  
  console.log(`[bridge] Injecting to local OpenClaw: "${injectText.substring(0, 80)}..."`);
  
  try {
    const child = spawn(OPENCLAW_BIN, [
      'agent',
      '-m', injectText,
      '--channel', 'telegram',
      '--to', TELEGRAM_GROUP,
      '--deliver',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });

    child.stdout.on('data', d => console.log(`[openclaw] ${d.toString().trim()}`));
    child.stderr.on('data', d => console.error(`[openclaw:err] ${d.toString().trim()}`));
    child.on('close', code => console.log(`[openclaw] exited with code ${code}`));
  } catch (err) {
    console.error(`[bridge] Failed to inject:`, err.message);
  }
}

// --- Main ---
async function main() {
  console.log(`[bridge] Starting agent bridge for: ${AGENT_ID}`);
  console.log(`[bridge] Redis: ${REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bridge] OpenClaw: ${OPENCLAW_BIN}`);

  // Subscriber connection (dedicated for SUBSCRIBE)
  const sub = new Redis(REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    maxRetriesPerRequest: null,
  });

  // Publisher connection (for PUBLISH)
  const pub = new Redis(REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    maxRetriesPerRequest: null,
  });

  sub.on('connect', () => console.log('[bridge] Redis subscriber connected'));
  pub.on('connect', () => console.log('[bridge] Redis publisher connected'));
  sub.on('error', err => console.error('[bridge] Redis sub error:', err.message));
  pub.on('error', err => console.error('[bridge] Redis pub error:', err.message));

  // Subscribe to team chat
  await sub.subscribe(CHANNEL);
  console.log(`[bridge] Subscribed to channel: ${CHANNEL}`);

  sub.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;

    const msg = parseMessage(raw);
    if (!msg) {
      console.log('[bridge] Invalid message format, skipping');
      return;
    }

    // Skip own messages
    if (msg.from === AGENT_ID) {
      return;
    }

    console.log(`[bridge] Received from ${msg.from}: "${msg.text.substring(0, 60)}..."`);

    // Check if this agent is mentioned
    if (isMentioned(msg.text, AGENT_ID)) {
      console.log(`[bridge] ${AGENT_ID} mentioned! Injecting...`);
      injectToOpenClaw(msg);
    } else {
      // Log but don't inject (awareness only)
      console.log(`[bridge] No mention of ${AGENT_ID}, skipping inject`);
    }
  });

  // Expose publish function for external use
  global.publishToTeam = (text, depth = 0) => {
    const msg = JSON.stringify({
      from: AGENT_ID,
      text,
      timestamp: Date.now(),
      depth,
    });
    pub.publish(CHANNEL, msg);
    console.log(`[bridge] Published: "${text.substring(0, 60)}..."`);
  };

  console.log('[bridge] Ready! Listening for team messages...');

  // Keep alive
  process.on('SIGINT', () => {
    console.log('[bridge] Shutting down...');
    sub.disconnect();
    pub.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[bridge] Fatal error:', err);
  process.exit(1);
});
