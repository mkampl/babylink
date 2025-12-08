# WebRTC Audio Debug Instructions

The server is running at: http://localhost:3001

## Testing Steps

### 1. Open Baby Device
1. Open browser: `http://localhost:3001/testroom?role=baby&userName=TestBaby`
2. Allow microphone access
3. Open browser console (F12)

### 2. Open Parent Device
1. Open another browser window/tab: `http://localhost:3001/testroom?role=parent&userName=TestParent`
2. Open browser console (F12)

## What to Look For in Console Logs

### On BABY side, you should see:
```
🔵 [BABY] Creating peer connection to parent <socketId>
🔵 [BABY] LocalStream exists: { id: ..., active: true, tracks: [...] }
🔵 [BABY] ✅ Added audio track to peer connection
🔵 [BABY] Created offer: { type: "offer", sdpLength: ... }
🔵 [BABY] ✅ Sent offer to parent
```

**Then after parent responds:**
```
🟢 [STREAM-MGR] handleSignal called: { hasAnswer: true, ... }
🟢 [STREAM-MGR] Processing answer from <socketId>
🟢 [STREAM-MGR] ✅ Set remote description (answer)
```

### On PARENT side, you should see:
```
🟢 [STREAM-MGR] handleSignal called: { hasOffer: true, from: "baby", ... }
🟢 [STREAM-MGR] No peer exists, creating new peer (PARENT side)
🟢 [STREAM-MGR] No localStream (this is expected for parent receiving offer)
🟢 [STREAM-MGR] Processing offer from <socketId>
🟢 [STREAM-MGR] Created answer: { type: "answer", ... }
🟢 [STREAM-MGR] ✅ Sent answer to <socketId>
```

**CRITICAL: Then parent should receive track:**
```
🟣 [STREAM-MGR] ontrack event from TestBaby: { track: { kind: "audio", enabled: true, readyState: "live" }, ... }
🟣 [STREAM-MGR] ✅ Stream received: { active: true, tracks: [...] }
```

## What Could Be Wrong

If you DON'T see the `🟣 ontrack` event on parent side, it means:
- The baby's audio tracks are not being sent
- OR the WebRTC negotiation failed
- OR the tracks were added after the offer was created

## Key Things to Check

1. **Baby side**: Does `localStream` have tracks BEFORE creating peer connection?
2. **Baby side**: Are tracks added to peer BEFORE creating offer?
3. **Parent side**: Do we receive the `ontrack` event?
4. Check ICE candidate exchange (should see multiple ICE logs)

## Expected Flow

```
BABY                                    PARENT
  |                                        |
  | 1. getUserMedia() -> localStream       |
  | 2. Join room                           | 3. Join room
  | 4. See parent in room-state            |
  | 5. Create peer connection              |
  | 6. Add audio tracks to peer            |
  | 7. Create offer                        |
  |------------ offer ------------------>  | 8. Receive offer
  |                                        | 9. Create peer connection
  |                                        | 10. Set remote description
  |                                        | 11. Create answer
  | 12. Receive answer  <---- answer -----  |
  | 13. Set remote description             |
  | 14. ICE exchange ---- ice --------->   |
  |                       <--- ice ------   |
  |                                        | 15. **ontrack EVENT** ✅
  |                                        | 16. Create audio element
  |                                        | 17. Start playing audio
```

## Run Test and Share Logs

After testing, please share:
1. Complete console output from BABY browser
2. Complete console output from PARENT browser
3. Note if you heard audio on parent side
