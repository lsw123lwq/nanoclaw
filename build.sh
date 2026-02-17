#!/bin/bash
# NanoClaw: Build everything and run
set -e

cd "$(dirname "${BASH_SOURCE[0]}")"

PLIST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"

echo "=== 1/3 Installing dependencies ==="
npm install

echo ""
echo "=== 2/3 Building TypeScript ==="
npm run build

echo ""
echo "=== 3/3 Building agent container ==="
./container/build.sh

echo ""
echo "============================================"
echo "  Build complete! Starting NanoClaw..."
echo "============================================"
echo ""

# Stop existing service to avoid WhatsApp connection conflict
if launchctl list | grep -q com.nanoclaw; then
  echo "Stopping existing NanoClaw service..."
  launchctl unload "$PLIST" 2>/dev/null || true
fi

node dist/index.js
