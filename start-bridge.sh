#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/chunjang-server"
cd /Users/chunjang-server/dev/personal/agent-bridge
exec /opt/homebrew/bin/node bridge.js
