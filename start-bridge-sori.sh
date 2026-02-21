#!/bin/bash
# SoRi Agent Bridge Wrapper
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export HOME=/Users/chunjang-server

# SoRi specific env
export AGENT_ID=sori
export AGENT_NAME=sori
export REDIS_HOST=100.123.82.47
export REDIS_PORT=6380
export REDIS_PASSWORD=choonjang-team-2026
export REDIS_URL=redis://:choonjang-team-2026@100.123.82.47:6380
export OPENCLAW_BIN=/opt/homebrew/bin/openclaw
export TELEGRAM_GROUP=-1003554423969
export COOLDOWN_MS=5000
export MAX_DEPTH=3

cd /Users/chunjang-server/dev/personal/agent-bridge
exec /opt/homebrew/bin/node bridge.js
