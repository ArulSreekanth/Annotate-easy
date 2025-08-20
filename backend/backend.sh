#!/bin/bash

# Start ngrok in the background
ngrok http 8085 > /dev/null &
NGROK_PID=$!

# Wait for ngrok to be ready
sleep 5

# Fetch public ngrok URL
NGROK_URL=$(curl --silent http://127.0.0.1:4040/api/tunnels \
  | grep -o "https://[a-zA-Z0-9.-]*.ngrok-free.app" | head -n1)

echo "Ngrok URL: $NGROK_URL"

# Export NGROK_URL so FastAPI can use it
export NGROK_URL=$NGROK_URL

# Run backend
uvicorn app:app --host 0.0.0.0 --port 8085
