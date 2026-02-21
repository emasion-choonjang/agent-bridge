#!/usr/bin/env node
/**
 * Agent Bridge — Redis Streams relay for OpenClaw agent-to-agent communication
 * 
 * Uses Redis Streams (not pub/sub) for:
 * - Persistent message history
 * - Consumer groups with last-read tracking (no duplicate reads)
 * - Offline message recovery
 * 
 * Usage: AGENT_ID=choa node bridge.js
 */

require('dotenv').config();
const Redis = require('ioredis');
const { spawn } = require('child_process');
const path = require('path');

// --- Config ---
const AGENT_ID = process.env.AGENT_ID || 'choa';
const REDIS_URL = process.env.REDIS_URL || 'redis://:choonjang-team-2026@100.123.82.47:6380';
const STREAM = 'team-chat';
const GROUP = `agent-${AGENT_ID}`;    // Each agent gets its OWN group (broadcast, not distributed)
const CONSUMER = AGENT_ID;            // Consumer within the group
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || findOpenClaw();
const TELEGRAM_GROUP = process.env.TELEGRAM_GROUP || '-1003554423969';
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '5000');
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || '3');
const POLL_INTERVAL_MS = 500;         // Stream poll interval

// Agent mention patterns
const MENTION_MAP = {
  choa: ['초아', '@choonjang_bot', '초아야', '초아한테', '초아가', '초아는', '초아도'],
  sera: ['세라', '@sera_choonjang_bot', '세라야', '세라한테', '세라가', '세라는', '세라도'],
  nicris: ['니크리스', '@nicrees_choonjang_bot', '니크리스한테', '니크리스가'],
  sori: ['소리', '@sori_choonjang_bot', '소리야', '소리한테', '소리가', '소리는', '소리도'],
};

// --- State ---
let lastInjectTime = 0;

function findOpenClaw() {
  try {
    const { execSync } = require('child_process');
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

function injectToOpenClaw(message, redis) {
  const now = Date.now();
  if (now - lastInjectTime < COOLDOWN_MS) {
    console.log(`[bridge] Cooldown active, skipping inject`);
    return;
  }
  lastInjectTime = now;

  const depth = parseInt(message.depth || '0');
  if (depth >= MAX_DEPTH) {
    console.log(`[bridge] Max depth ${MAX_DEPTH} reached, skipping`);
    return;
  }

  const injectText = `[Agent Bridge - ${message.from} said in group]: ${message.text}`;
  console.log(`[bridge] Injecting to OpenClaw: "${injectText.substring(0, 80)}..."`);

  try {
    // Build args: route to the correct agent via --agent flag
    const agentArgs = AGENT_ID !== 'sera' ? ['--agent', AGENT_ID] : [];
    const child = spawn(OPENCLAW_BIN, [
      'agent',
      ...agentArgs,
      '-m', injectText,
      '--channel', 'telegram',
      '--to', TELEGRAM_GROUP,
      '--deliver',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });

    // Capture response and republish to Redis
    let stdout = '';
    child.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      console.log(`[openclaw] ${chunk.trim()}`);
    });
    child.stderr.on('data', d => console.error(`[openclaw:err] ${d.toString().trim()}`));
    child.on('close', code => {
      console.log(`[openclaw] exited with code ${code}`);
      // Republish response to Redis so other agents can see it
      const response = stdout.trim();
      if (response && code === 0) {
        const nextDepth = depth + 1;
        redis.xadd(STREAM, '*',
          'from', AGENT_ID,
          'text', response,
          'timestamp', Date.now().toString(),
          'depth', nextDepth.toString()
        ).then(id => {
          console.log(`[bridge] Republished response to Redis (${id}), depth=${nextDepth}`);
        }).catch(err => {
          console.error(`[bridge] Failed to republish:`, err.message);
        });
      }
    });
  } catch (err) {
    console.error(`[bridge] Failed to inject:`, err.message);
  }
}

// --- Main ---
async function main() {
  console.log(`[bridge] Starting agent bridge for: ${AGENT_ID}`);
  console.log(`[bridge] Redis: ${REDIS_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`[bridge] Stream: ${STREAM} | Group: ${GROUP} | Consumer: ${CONSUMER}`);

  const redis = new Redis(REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 500, 5000),
    maxRetriesPerRequest: null,
  });

  redis.on('connect', () => console.log('[bridge] Redis connected'));
  redis.on('error', err => console.error('[bridge] Redis error:', err.message));

  // Create stream & consumer group (ignore if already exists)
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    console.log(`[bridge] Created consumer group: ${GROUP}`);
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[bridge] Consumer group already exists: ${GROUP}`);
    } else {
      throw err;
    }
  }

  // First: process any pending (unacknowledged) messages from previous runs
  console.log('[bridge] Checking for pending messages...');
  let pending = true;
  while (pending) {
    const results = await redis.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', 10, 'STREAMS', STREAM, '0');
    if (!results || results[0][1].length === 0) {
      pending = false;
      break;
    }
    for (const [id, fields] of results[0][1]) {
      processMessage(id, fieldsToObject(fields), redis);
    }
  }
  console.log('[bridge] Pending messages processed.');

  // Main loop: read new messages with blocking
  console.log('[bridge] Listening for new messages...');
  while (true) {
    try {
      const results = await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', 5,
        'BLOCK', POLL_INTERVAL_MS,
        'STREAMS', STREAM, '>'
      );

      if (results) {
        for (const [id, fields] of results[0][1]) {
          processMessage(id, fieldsToObject(fields), redis);
        }
      }
    } catch (err) {
      if (err.message.includes('NOGROUP')) {
        // Group was deleted, recreate
        try {
          await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
        } catch {}
      } else {
        console.error('[bridge] Read error:', err.message);
        await sleep(1000);
      }
    }
  }
}

function processMessage(id, msg, redis) {
  // Skip own messages
  if (msg.from === AGENT_ID) {
    redis.xack(STREAM, GROUP, id);
    return;
  }

  console.log(`[bridge] [${id}] From ${msg.from}: "${(msg.text || '').substring(0, 60)}..."`);

  // Check if this agent is mentioned
  if (isMentioned(msg.text || '', AGENT_ID)) {
    console.log(`[bridge] ${AGENT_ID} mentioned! Injecting...`);
    injectToOpenClaw(msg, redis);
  }

  // Acknowledge message (mark as read)
  redis.xack(STREAM, GROUP, id);
}

function fieldsToObject(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[bridge] Shutting down...');
  process.exit(0);
});

main().catch(err => {
  console.error('[bridge] Fatal error:', err);
  process.exit(1);
});
