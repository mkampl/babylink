#!/bin/bash
# Test script for ESP32 integration
# Starts server and simulator, runs for 30 seconds, then stops

echo "🧪 ESP32 Integration Test"
echo "=========================="
echo ""

# Start server in background
echo "🚀 Starting server..."
node server.js > /tmp/babylink-server.log 2>&1 &
SERVER_PID=$!

# Wait for server to start
sleep 3

# Check if server is running
if ! ps -p $SERVER_PID > /dev/null; then
    echo "❌ Server failed to start"
    cat /tmp/babylink-server.log
    exit 1
fi

echo "✅ Server started (PID: $SERVER_PID)"

# Start simulator
echo "🎭 Starting ESP32 simulator..."
node tools/esp32-simulator.js --room test-room --name "Test Baby" &
SIMULATOR_PID=$!

echo "✅ Simulator started (PID: $SIMULATOR_PID)"
echo ""
echo "⏳ Running test for 30 seconds..."
echo "📝 Open http://localhost:3000/test-room?role=parent to view"
echo ""

# Run for 30 seconds
sleep 30

# Stop simulator
echo ""
echo "⏹️  Stopping simulator..."
kill $SIMULATOR_PID 2>/dev/null

# Stop server
echo "⏹️  Stopping server..."
kill $SERVER_PID 2>/dev/null

sleep 2

echo ""
echo "✅ Test completed!"
echo ""
echo "📊 Check logs:"
echo "   Server: /tmp/babylink-server.log"
echo ""

# Check for errors in server log
if grep -q "ERROR" /tmp/babylink-server.log; then
    echo "⚠️  Errors found in server log:"
    grep "ERROR" /tmp/babylink-server.log
    exit 1
else
    echo "✅ No errors found"
fi
