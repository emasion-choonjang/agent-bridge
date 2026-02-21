# Agent Bridge 🌉

Redis pub/sub relay for OpenClaw agent-to-agent communication.

Solves: Telegram Bot API doesn't allow bots to receive messages from other bots.

## Setup

### 1. Redis (Mac Mini)
```bash
# On Mac Mini (choonjang-server, 100.123.82.47)
cd ~/dev/personal/agent-bridge
docker compose up -d
```

### 2. Bridge (each machine)
```bash
cp .env.example .env
# Edit AGENT_ID (choa/sera) and paths
npm install
node bridge.js
```

### 3. Test
```bash
# From any machine with redis-cli:
redis-cli -h 100.123.82.47 -p 6380 -a choonjang-team-2026 \
  PUBLISH team-chat '{"from":"test","text":"세라야 테스트!","timestamp":0,"depth":0}'
```

## Architecture
- Each agent has a bridge.js process running
- Outgoing messages → Redis PUBLISH
- Incoming messages → mention check → `openclaw agent -m` inject
- Loop prevention: self-skip, cooldown (5s), max depth (3)
