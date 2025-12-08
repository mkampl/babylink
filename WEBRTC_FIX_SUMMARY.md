# WebRTC Audio Fix Summary

## Problem
After adding ESP32 hardware support, WebRTC baby monitor was not sending audio from baby to parent.

## Root Cause
The issue was caused by **duplicate room join events** that led to attempting to add the same audio track to a peer connection multiple times.

### Specific Issues Found:
1. **Duplicate `socket.emit('join')` calls**: Both `initialize()` and socket `'connect'` event handler were calling join
2. **No duplicate prevention**: When receiving multiple `participant-joined` events for the same parent, baby would try to create peer connections multiple times
3. **Track reuse error**: `"DOMException: This track is already set on a sender"` when trying to add the same audio track twice

## Solution

### 1. Fixed Duplicate Join (views/webrtc.html)
- Added `hasJoinedRoom` flag to track if room has been joined
- Added `isInitialized` flag to ensure initialization completes before joining
- Created `joinRoom()` function that can only execute once
- Removed duplicate `socket.emit('join')` from `initialize()` function
- Updated `'connect'` event handler to reset flag on reconnection

### 2. Fixed Duplicate Peer Connection Creation (views/webrtc.html)
- Added early check in `createPeerConnectionToParent()` to skip if peer already exists:
```javascript
if (multiStreamManager.peerConnections.has(parent.socketId)) {
  console.log('⚠️ Peer connection already exists, skipping');
  return;
}
```

### 3. Added Audio Enable Button (views/webrtc.html)
- Created `enableAllAudio()` function to handle both WebRTC and ESP32 audio
- Shows green "Click to Enable Audio" button when baby connects
- Resumes all suspended AudioContexts (required by browser autoplay policy)
- Consistent with ESP32 audio enable behavior

### 4. Added Comprehensive Debug Logging
- 🔵 `[BABY]` prefix for baby-side operations
- 🟢 `[STREAM-MGR]` prefix for WebRTC peer management
- 🟣 `[STREAM-MGR] ontrack` prefix for critical audio stream reception
- Logs track details, SDP info, connection states, and audio contexts

## Files Modified
- `views/webrtc.html` - Main WebRTC client code
- `public/js/multi-stream-manager.js` - WebRTC peer connection manager

## Testing Results
✅ No more duplicate join events
✅ No more "track is already set on a sender" errors
✅ Baby successfully sends audio offer with tracks
✅ Parent receives `ontrack` event
✅ WebRTC connection state: `connected`
✅ Audio plays after clicking "Enable Audio" button

## Flow After Fix

### Baby Side:
1. Initialize → get microphone → store in `localStream`
2. Socket connects → join room (once)
3. Receive `room-state` with parents
4. Check if peer exists → if not, create peer
5. Add audio tracks to peer
6. Create and send offer (SDP contains `m=audio`)
7. Receive answer from parent
8. Exchange ICE candidates
9. Connection established

### Parent Side:
1. Initialize → create MultiBabyUI and MultiStreamManager
2. Socket connects → join room (once)
3. Receive offer from baby
4. Create peer connection
5. Set remote description (offer)
6. **🎯 ontrack event fires** → receive audio stream
7. Create audio element
8. Show "Enable Audio" button (browser autoplay policy)
9. User clicks button → AudioContext resumes
10. **Audio plays!** 🎉

## Commands to Deploy
```bash
docker compose build
docker compose up -d
```

## Browser Cache Warning
After deploying, users must **hard refresh** (Ctrl+Shift+R) to get the latest JavaScript code.
