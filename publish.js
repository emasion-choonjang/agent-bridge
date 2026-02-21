#!/usr/bin/env node
/**
 * Publish a message to the team-chat Redis Stream.
 * 
 * Usage: node publish.js "메시지 텍스트"
 * Or:    echo "메시지" | node publish.js
 */

require('dotenv').config();
const Redis = require('ioredis');

const AGENT_ID = process.env.AGENT_ID || 'choa';
const REDIS_URL = process.env.REDIS_URL || 'redis://:choonjang-team-2026@100.123.82.47:6380';
const STREAM = 'team-chat';

async function main() {
  const text = process.argv[2] || await readStdin();
  if (!text) {
    console.error('Usage: node publish.js "message text"');
    process.exit(1);
  }

  const redis = new Redis(REDIS_URL);
  
  const id = await redis.xadd(STREAM, '*',
    'from', AGENT_ID,
    'text', text,
    'timestamp', Date.now().toString(),
    'depth', '0'
  );

  console.log(`[publish] Sent (${id}) from ${AGENT_ID}: "${text.substring(0, 60)}..."`);
  redis.disconnect();
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

main().catch(err => {
  console.error('[publish] Error:', err.message);
  process.exit(1);
});
