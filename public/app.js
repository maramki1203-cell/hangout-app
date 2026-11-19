// ============================================================
//  HANGOUT APP — Client-Side Logic
// ============================================================

const socket = io();

// ---- State ----
let myUsername = null;
let allUsers = [];
let onlineUsers = [];
let currentRoomId = null;
let currentCallId = null;
let localStream = null;
let peerConnections = {};  // username -> RTCPeerConnection
let micEnabled = true;
let camEnabled = true;
let currentGame = null;
let gameLoop = null;

// ---- ICE servers for WebRTC ----
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// ============================================================
//  LOGIN
// ============================================================
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app');
const loginBtn = document.getElementById('login-btn');
const loginUser = document.getElementById('login-user');
const loginPass = document.getElementById('login-pass');
const loginError = document.getElementById('login-error');

loginBtn.addEventListener('click', doLogin);
loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
loginUser.addEventListener('keydown', e => { if (e.key === 'Enter') loginPass.focus(); });

function doLogin() {
  const username = loginUser.value.trim().toLowerCase();
  const password = loginPass.value;
  if (!username || !password) { loginError.textContent = 'Please fill in both fields.'; return; }

  socket.emit('login', { username, password }, (res) => {
    if (res.success) {
      myUsername = res.username;
      loginScreen.classList.add('hidden');
      appScreen.classList.remove('hidden');
      document.getElementById('user-label').textContent = `Logged in as ${myUsername}`;
      loadRooms();
      loadCallHistory();
    } else {
      loginError.textContent = res.message;
    }
  });
}

document.getElementById('logout-btn').addEventListener('click', () => {
  location.reload();
});

// ============================================================
//  NAVIGATION — 3 main tabs
// ============================================================
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.section + '-section').classList.add('active');

    // Stop game if switching away from arcade
    if (btn.dataset.section !== 'arcade' && gameLoop) {
      cancelAnimationFrame(gameLoop);
      gameLoop = null;
    }
  });
});

// ============================================================
//  ONLINE USERS tracking
// ============================================================
socket.on('online-users', (users) => {
  onlineUsers = users;
  renderOnlineUsers();
});

socket.on('all-users', (users) => {
  allUsers = users;
});

function renderOnlineUsers() {
  const container = document.getElementById('online-users-calls');
  container.innerHTML = '';
  onlineUsers.forEach(u => {
    const div = document.createElement('div');
    div.className = 'online-user-item';
    div.innerHTML = `<span class="online-dot"></span> ${u}${u === myUsername ? ' (you)' : ''}`;
    container.appendChild(div);
  });
}

// ============================================================
//  CHAT — Rooms
// ============================================================
function loadRooms() {
  socket.emit('get-rooms', (rooms) => {
    renderRoomList(rooms);
  });
}

function renderRoomList(rooms) {
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item' + (r.id === currentRoomId ? ' selected' : '');
    const lastMsg = r.lastMessage ? `${r.lastMessage.sender}: ${r.lastMessage.text}` : 'No messages yet';
    div.innerHTML = `<div class="room-name">${escHtml(r.name)}</div><div class="room-last-msg">${escHtml(lastMsg)}</div>`;
    div.addEventListener('click', () => openRoom(r.id, r.name, r.members));
    list.appendChild(div);
  });
}

function openRoom(roomId, name, members) {
  currentRoomId = roomId;
  document.getElementById('chat-placeholder').classList.add('hidden');
  document.getElementById('chat-active').classList.remove('hidden');
  document.getElementById('chat-room-name').textContent = name;
  document.getElementById('chat-room-members').textContent = members.join(', ');

  // Highlight selected room
  document.querySelectorAll('.room-item').forEach((el, i) => el.classList.remove('selected'));
  document.querySelectorAll('.room-item').forEach(el => {
    if (el.querySelector('.room-name').textContent === name) el.classList.add('selected');
  });

  // Load messages
  socket.emit('get-messages', { roomId }, (msgs) => {
    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    msgs.forEach(m => appendMessage(m));
    area.scrollTop = area.scrollHeight;
  });
}

function appendMessage(msg) {
  const area = document.getElementById('messages-area');
  const div = document.createElement('div');
  div.className = 'message' + (msg.sender === myUsername ? ' mine' : '');
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="msg-sender">${escHtml(msg.sender)}</div>
    <div class="msg-bubble">${escHtml(msg.text)}</div>
    <div class="msg-time">${time}</div>
  `;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

// Send message
document.getElementById('send-msg-btn').addEventListener('click', sendMessage);
document.getElementById('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !currentRoomId) return;
  socket.emit('send-message', { roomId: currentRoomId, text });
  input.value = '';
}

// Receive messages in real-time
socket.on('new-message', ({ roomId, message }) => {
  if (roomId === currentRoomId) {
    appendMessage(message);
  }
  // Refresh room list to update ordering
  loadRooms();
});

// New room created
socket.on('room-created', () => {
  loadRooms();
});

// ---- New Chat Modal ----
document.getElementById('new-chat-btn').addEventListener('click', () => {
  socket.emit('get-all-users', (users) => {
    allUsers = users;
    const container = document.getElementById('chat-user-checkboxes');
    container.innerHTML = '';
    users.filter(u => u !== myUsername).forEach(u => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${u}" /> ${u}`;
      container.appendChild(label);
    });
    document.getElementById('new-room-name').value = '';
    document.getElementById('modal-chat').classList.remove('hidden');
  });
});

document.getElementById('modal-chat-cancel').addEventListener('click', () => {
  document.getElementById('modal-chat').classList.add('hidden');
});

document.getElementById('modal-chat-create').addEventListener('click', () => {
  const name = document.getElementById('new-room-name').value.trim();
  if (!name) { alert('Please enter a room name.'); return; }
  const members = [];
  document.querySelectorAll('#chat-user-checkboxes input:checked').forEach(cb => members.push(cb.value));
  if (members.length === 0) { alert('Please select at least one member.'); return; }
  members.push(myUsername);

  socket.emit('create-room', { name, members }, (res) => {
    if (res.success) {
      document.getElementById('modal-chat').classList.add('hidden');
      loadRooms();
    }
  });
});

// ---- Call from chat ----
document.getElementById('chat-call-btn').addEventListener('click', () => {
  if (!currentRoomId) return;
  const membersText = document.getElementById('chat-room-members').textContent;
  const participants = membersText.split(', ').map(s => s.trim()).filter(Boolean);
  startCall(participants);
});

// ============================================================
//  CALLS
// ============================================================
function loadCallHistory() {
  socket.emit('get-call-history', (history) => {
    const container = document.getElementById('call-history-list');
    container.innerHTML = '';
    if (history.length === 0) {
      container.innerHTML = '<p style="color:#556;padding:16px;">No recent calls</p>';
      return;
    }
    history.forEach(c => {
      const div = document.createElement('div');
      div.className = 'call-history-item';
      const date = new Date(c.startedAt).toLocaleString();
      const dur = c.endedAt ? Math.round((c.endedAt - c.startedAt) / 1000) : 0;
      const durText = dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`;
      div.innerHTML = `
        <div class="call-info">
          <div class="caller">📞 ${escHtml(c.caller)} → ${c.participants.filter(p => p !== c.caller).map(escHtml).join(', ')}</div>
          <div class="call-meta">${date} · ${durText}</div>
        </div>
      `;
      container.appendChild(div);
    });
  });
}

// ---- Start Call Modal ----
document.getElementById('start-call-btn').addEventListener('click', () => {
  socket.emit('get-all-users', (users) => {
    allUsers = users;
    const container = document.getElementById('call-user-checkboxes');
    container.innerHTML = '';
    users.filter(u => u !== myUsername).forEach(u => {
      const isOnline = onlineUsers.includes(u);
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${u}" ${isOnline ? '' : 'disabled'} />
        ${u} ${isOnline ? '<span class="online-dot"></span>' : '(offline)'}`;
      container.appendChild(label);
    });
    document.getElementById('modal-call').classList.remove('hidden');
  });
});

document.getElementById('modal-call-cancel').addEventListener('click', () => {
  document.getElementById('modal-call').classList.add('hidden');
});

document.getElementById('modal-call-start').addEventListener('click', () => {
  const participants = [];
  document.querySelectorAll('#call-user-checkboxes input:checked').forEach(cb => participants.push(cb.value));
  if (participants.length === 0) { alert('Select at least one person to call.'); return; }
  document.getElementById('modal-call').classList.add('hidden');
  startCall(participants);
});

// ---- Incoming call notification ----
socket.on('incoming-call', ({ callId, caller, participants }) => {
  const accept = confirm(`📞 Incoming call from ${caller}! Join?`);
  if (accept) {
    joinCall(callId);
  }
});

// ============================================================
//  WebRTC — Video Calling
// ============================================================
async function startCall(participants) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    alert('Could not access camera/microphone. Please allow permissions and try again.');
    return;
  }

  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('call-overlay').classList.remove('hidden');
  micEnabled = true;
  camEnabled = true;

  socket.emit('start-call', { participants }, (res) => {
    if (res.success) {
      currentCallId = res.callId;
      document.getElementById('call-status').textContent = `In Call — waiting for others...`;
    }
  });
}

async function joinCall(callId) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    alert('Could not access camera/microphone.');
    return;
  }

  currentCallId = callId;
  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('call-overlay').classList.remove('hidden');
  micEnabled = true;
  camEnabled = true;

  socket.emit('join-call', { callId }, (res) => {
    if (res.success) {
      document.getElementById('call-status').textContent = `In Call`;
      // Create peer connections with existing peers
      res.peers.forEach(peer => {
        createPeerConnection(peer, true);
      });
    }
  });
}

function createPeerConnection(peerUsername, isInitiator) {
  if (peerConnections[peerUsername]) return;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[peerUsername] = pc;

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Handle incoming remote tracks
  pc.ontrack = (event) => {
    let videoBox = document.getElementById('video-' + peerUsername);
    if (!videoBox) {
      videoBox = document.createElement('div');
      videoBox.className = 'video-box';
      videoBox.id = 'video-' + peerUsername;
      videoBox.innerHTML = `<video autoplay playsinline></video><span class="video-label">${escHtml(peerUsername)}</span>`;
      document.getElementById('videos-grid').appendChild(videoBox);
    }
    videoBox.querySelector('video').srcObject = event.streams[0];
    document.getElementById('call-status').textContent = `In Call`;
  };

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', {
        callId: currentCallId,
        to: peerUsername,
        candidate: event.candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      removePeer(peerUsername);
    }
  };

  // If we're the initiator, create and send an offer
  if (isInitiator) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('webrtc-offer', {
          callId: currentCallId,
          to: peerUsername,
          offer: pc.localDescription,
        });
      });
  }
}

// Handle WebRTC signaling messages
socket.on('webrtc-offer', async ({ callId, from, offer }) => {
  createPeerConnection(from, false);
  const pc = peerConnections[from];
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('webrtc-answer', { callId, to: from, answer: pc.localDescription });
});

socket.on('webrtc-answer', async ({ callId, from, answer }) => {
  const pc = peerConnections[from];
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('webrtc-ice-candidate', async ({ callId, from, candidate }) => {
  const pc = peerConnections[from];
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
});

// A new peer joined the call
socket.on('peer-joined', ({ callId, username }) => {
  if (callId === currentCallId) {
    createPeerConnection(username, true);
  }
});

// A peer left
socket.on('peer-left', ({ callId, username }) => {
  if (callId === currentCallId) {
    removePeer(username);
  }
});

function removePeer(username) {
  if (peerConnections[username]) {
    peerConnections[username].close();
    delete peerConnections[username];
  }
  const box = document.getElementById('video-' + username);
  if (box) box.remove();
}

// ---- Call controls ----
document.getElementById('toggle-mic').addEventListener('click', () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  document.getElementById('toggle-mic').classList.toggle('muted', !micEnabled);
  document.getElementById('toggle-mic').textContent = micEnabled ? '🎤' : '🔇';
});

document.getElementById('toggle-cam').addEventListener('click', () => {
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  document.getElementById('toggle-cam').classList.toggle('muted', !camEnabled);
  document.getElementById('toggle-cam').textContent = camEnabled ? '📷' : '📷❌';
});

document.getElementById('end-call-btn').addEventListener('click', () => {
  endCall();
});

function endCall() {
  if (currentCallId) {
    socket.emit('leave-call', { callId: currentCallId });
  }

  // Close all peer connections
  Object.keys(peerConnections).forEach(removePeer);

  // Stop local media
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  // Clean up UI
  document.getElementById('call-overlay').classList.add('hidden');
  document.getElementById('local-video').srcObject = null;
  // Remove remote video boxes
  document.querySelectorAll('#videos-grid .video-box:not(#local-video-box)').forEach(el => el.remove());

  currentCallId = null;
  loadCallHistory();
}

// ============================================================
//  ARCADE GAMES
// ============================================================
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

let activeGameCleanup = null;

// ---- Web Audio API for arcade sounds (no download needed!) ----
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioCtx = new AudioContext();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playSound(type) {
  const ac = getAudioContext();
  if (!ac) return;
  const now = ac.currentTime;

  if (type === 'apple-match') {
    // Cheerful high double chime
    const o1 = ac.createOscillator();
    const g1 = ac.createGain();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(523.25, now);       // C5
    o1.frequency.setValueAtTime(659.25, now + 0.08); // E5
    o1.frequency.setValueAtTime(783.99, now + 0.16); // G5
    g1.gain.setValueAtTime(0.2, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    o1.connect(g1);
    g1.connect(ac.destination);
    o1.start(now);
    o1.stop(now + 0.35);
  } else if (type === 'flap') {
    // Soft swoosh chirp
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(320, now);
    o.frequency.exponentialRampToValueAtTime(560, now + 0.09);
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    o.connect(g);
    g.connect(ac.destination);
    o.start(now);
    o.stop(now + 0.1);
  } else if (type === 'point') {
    // Coin sound
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(987.77, now); // B5
    o.frequency.setValueAtTime(1318.51, now + 0.08); // E6
    g.gain.setValueAtTime(0.1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    o.connect(g);
    g.connect(ac.destination);
    o.start(now);
    o.stop(now + 0.28);
  } else if (type === 'hit') {
    // Soft low thump
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(160, now);
    o.frequency.exponentialRampToValueAtTime(40, now + 0.2);
    g.gain.setValueAtTime(0.25, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.22);
    o.connect(g);
    g.connect(ac.destination);
    o.start(now);
    o.stop(now + 0.22);
  }
}

function stopActiveGame() {
  if (gameLoop) {
    cancelAnimationFrame(gameLoop);
    gameLoop = null;
  }
  if (activeGameCleanup) {
    activeGameCleanup();
    activeGameCleanup = null;
  }
}

// ---- Arcade navigation buttons ----
document.querySelectorAll('.play-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const game = btn.dataset.game;
    currentGame = game;
    document.getElementById('arcade-menu').classList.add('hidden');
    document.getElementById('game-area').classList.remove('hidden');
    document.getElementById('game-over-overlay').classList.add('hidden');
    if (game === 'apple') startAppleGame();
    else if (game === 'flappy') startFlappyGame();
  });
});

document.getElementById('back-to-arcade').addEventListener('click', () => {
  stopActiveGame();
  currentGame = null;
  document.getElementById('game-area').classList.add('hidden');
  document.getElementById('game-over-overlay').classList.add('hidden');
  document.getElementById('arcade-menu').classList.remove('hidden');
});

document.getElementById('exit-game-btn').addEventListener('click', () => {
  stopActiveGame();
  currentGame = null;
  document.getElementById('game-over-overlay').classList.add('hidden');
  document.getElementById('game-area').classList.add('hidden');
  document.getElementById('arcade-menu').classList.remove('hidden');
});

document.getElementById('restart-game-btn').addEventListener('click', () => {
  document.getElementById('game-over-overlay').classList.add('hidden');
  if (currentGame === 'apple') startAppleGame();
  else if (currentGame === 'flappy') startFlappyGame();
});

document.getElementById('restart-game-top-btn').addEventListener('click', () => {
  document.getElementById('game-over-overlay').classList.add('hidden');
  if (currentGame === 'apple') startAppleGame();
  else if (currentGame === 'flappy') startFlappyGame();
});

function showGameOver(score, customTitle = 'Game Over', customMsg = null) {
  document.getElementById('game-over-title').textContent = customTitle;
  document.getElementById('final-score').textContent = score;
  if (customMsg) {
    document.getElementById('game-over-msg').innerHTML = customMsg;
  } else {
    document.getElementById('game-over-msg').innerHTML = `Final Score: <span id="final-score">${score}</span>`;
  }
  document.getElementById('game-over-overlay').classList.remove('hidden');
}

// ============================================================
//  GAME 1: FRUIT BOX (사과 게임 - Fruit Box Game)
//  Rule: Drag a rectangle over apples whose numbers sum to 10!
//  Board: 17 columns x 10 rows (170 apples). Timer: 120 seconds.
// ============================================================
function startAppleGame() {
  stopActiveGame();
  currentGame = 'apple';

  document.getElementById('game-title').textContent = '🍎 Fruit Box (사과 게임)';
  const timerDisplay = document.getElementById('game-timer-display');
  timerDisplay.classList.remove('hidden');
  document.getElementById('game-score-display').textContent = 'Score: 0';

  // Canvas size for Fruit Box
  const W = 880;
  const H = 520;
  canvas.width = W;
  canvas.height = H;
  canvas.style.cursor = 'crosshair';

  const COLS = 17;
  const ROWS = 10;
  const cellW = 44;
  const cellH = 45;
  const gridX = 25;
  const gridY = 32;

  let score = 0;
  let remainingApples = COLS * ROWS;
  const GAME_DURATION = 120; // 120 seconds
  let startTime = Date.now();
  let timeLeft = GAME_DURATION;
  let gameActive = true;

  // Generate grid with random numbers 1 to 9
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      row.push({
        r,
        c,
        val: Math.floor(Math.random() * 9) + 1,
        cleared: false,
      });
    }
    grid.push(row);
  }

  // Floating score popups animation
  const popups = [];

  // Drag selection state
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };
  let dragCurrent = { x: 0, y: 0 };

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function onMouseDown(e) {
    if (!gameActive) return;
    const pos = getCanvasCoords(e);
    isDragging = true;
    dragStart = pos;
    dragCurrent = pos;
  }

  function onMouseMove(e) {
    if (!isDragging || !gameActive) return;
    dragCurrent = getCanvasCoords(e);
  }

  function onMouseUp(e) {
    if (!isDragging || !gameActive) return;
    isDragging = false;

    // Check selected apples
    const selected = getSelectedApples();
    if (selected.length === 0) return;

    let sum = 0;
    selected.forEach(a => sum += a.val);

    if (sum === 10) {
      // Success! Clear apples
      selected.forEach(a => {
        a.cleared = true;
      });
      const clearedCount = selected.length;
      score += clearedCount;
      remainingApples -= clearedCount;
      document.getElementById('game-score-display').textContent = `Score: ${score}`;
      playSound('apple-match');

      // Add floating score popup
      const midX = (dragStart.x + dragCurrent.x) / 2;
      const midY = (dragStart.y + dragCurrent.y) / 2;
      popups.push({
        x: midX,
        y: midY,
        text: `+${clearedCount}`,
        alpha: 1.0,
      });

      // Win condition: cleared entire board
      if (remainingApples <= 0) {
        gameActive = false;
        showGameOver(score, '🎉 Perfect Clear!', `Amazing! You cleared all apples! Score: ${score}`);
      }
    }
  }

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('touchstart', onMouseDown, { passive: false });
  window.addEventListener('touchmove', onMouseMove, { passive: false });
  window.addEventListener('touchend', onMouseUp);

  activeGameCleanup = () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('touchstart', onMouseDown);
    window.removeEventListener('touchmove', onMouseMove);
    window.removeEventListener('touchend', onMouseUp);
    timerDisplay.classList.add('hidden');
    canvas.style.cursor = 'default';
  };

  // Helper: find all active apples inside current selection box
  function getSelectedApples() {
    const minX = Math.min(dragStart.x, dragCurrent.x);
    const maxX = Math.max(dragStart.x, dragCurrent.x);
    const minY = Math.min(dragStart.y, dragCurrent.y);
    const maxY = Math.max(dragStart.y, dragCurrent.y);

    const selected = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const apple = grid[r][c];
        if (apple.cleared) continue;

        const appleCenterX = gridX + c * cellW + cellW / 2;
        const appleCenterY = gridY + r * cellH + cellH / 2;

        if (appleCenterX >= minX && appleCenterX <= maxX &&
            appleCenterY >= minY && appleCenterY <= maxY) {
          selected.push(apple);
        }
      }
    }
    return selected;
  }

  // Draw an individual apple
  function drawApple(x, y, w, h, val, isSelected) {
    const cx = x + w / 2;
    const cy = y + h / 2 + 3;
    const r = Math.min(w, h) * 0.42;

    ctx.save();

    // Stem
    ctx.strokeStyle = '#6d4c41';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r + 3);
    ctx.quadraticCurveTo(cx + 3, cy - r - 6, cx + 5, cy - r - 8);
    ctx.stroke();

    // Leaf
    ctx.fillStyle = '#4cd137';
    ctx.beginPath();
    ctx.ellipse(cx + 4, cy - r - 4, 4.5, 2.5, Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    // Selection glow
    if (isSelected) {
      ctx.shadowColor = '#ffeaa7';
      ctx.shadowBlur = 10;
    }

    // Apple body (Glossy red with gradient)
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.15, cx, cy, r);
    if (isSelected) {
      grad.addColorStop(0, '#ff7675');
      grad.addColorStop(0.7, '#d63031');
      grad.addColorStop(1, '#b71540');
    } else {
      grad.addColorStop(0, '#ff6b6b');
      grad.addColorStop(0.8, '#ee5253');
      grad.addColorStop(1, '#c0392b');
    }
    ctx.fillStyle = grad;

    ctx.beginPath();
    // Heart-like apple lobes
    ctx.arc(cx - r * 0.35, cy, r * 0.75, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.35, cy, r * 0.75, 0, Math.PI * 2);
    ctx.fill();

    // Top shine highlight
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.4, cy - r * 0.35, r * 0.3, r * 0.15, -Math.PI / 6, 0, Math.PI * 2);
    ctx.fill();

    // Number
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.fillText(val, cx, cy + 1);

    ctx.restore();
  }

  function update() {
    if (!gameActive) return;

    // Timer calculation
    const elapsed = (Date.now() - startTime) / 1000;
    timeLeft = Math.max(0, GAME_DURATION - elapsed);
    timerDisplay.textContent = `⏱️ ${Math.ceil(timeLeft)}s`;

    if (timeLeft <= 0) {
      gameActive = false;
      timerDisplay.textContent = '⏱️ 0s';
      playSound('hit');
      showGameOver(score, "Time's Up!", `You cleared <strong>${score}</strong> apples out of 170!`);
    }

    // Update floating popups
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].y -= 1;
      popups[i].alpha -= 0.025;
      if (popups[i].alpha <= 0) popups.splice(i, 1);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Frame border (green board style like the screenshot)
    ctx.fillStyle = '#20bf6b';
    roundRect(ctx, 0, 0, W, H, 16);
    ctx.fill();

    // Inner board area (light mint grid background)
    const boardPadding = 12;
    const boardW = W - boardPadding * 2;
    const boardH = H - boardPadding * 2;
    ctx.fillStyle = '#eafaf1';
    roundRect(ctx, boardPadding, boardPadding, boardW, boardH, 10);
    ctx.fill();

    // Subtle checkered grid lines
    ctx.strokeStyle = '#d5f5e3';
    ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) {
      const x = gridX + c * cellW;
      ctx.beginPath();
      ctx.moveTo(x, gridY);
      ctx.lineTo(x, gridY + ROWS * cellH);
      ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      const y = gridY + r * cellH;
      ctx.beginPath();
      ctx.moveTo(gridX, y);
      ctx.lineTo(gridX + COLS * cellW, y);
      ctx.stroke();
    }

    // Selected apples set for fast lookup
    const selectedApples = isDragging ? getSelectedApples() : [];
    const selectedSet = new Set(selectedApples);

    // Draw apples
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const apple = grid[r][c];
        if (apple.cleared) continue;
        const ax = gridX + c * cellW;
        const ay = gridY + r * cellH;
        drawApple(ax, ay, cellW, cellH, apple.val, selectedSet.has(apple));
      }
    }

    // Draw selection rectangle & tooltip
    if (isDragging) {
      const minX = Math.min(dragStart.x, dragCurrent.x);
      const maxX = Math.max(dragStart.x, dragCurrent.x);
      const minY = Math.min(dragStart.y, dragCurrent.y);
      const maxY = Math.max(dragStart.y, dragCurrent.y);
      const selW = maxX - minX;
      const selH = maxY - minY;

      let currentSum = 0;
      selectedApples.forEach(a => currentSum += a.val);
      const isTen = currentSum === 10;

      // Box fill & border
      ctx.fillStyle = isTen ? 'rgba(46, 213, 115, 0.25)' : 'rgba(78, 140, 255, 0.2)';
      ctx.fillRect(minX, minY, selW, selH);

      ctx.strokeStyle = isTen ? '#2ed573' : '#4e8cff';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(minX, minY, selW, selH);
      ctx.setLineDash([]);

      // Floating Sum Tooltip
      if (selectedApples.length > 0) {
        const tipText = isTen ? `Sum: 10 ✨` : `Sum: ${currentSum}`;
        ctx.font = 'bold 15px "Segoe UI", sans-serif';
        const textWidth = ctx.measureText(tipText).width;
        const tipX = Math.max(20, Math.min(W - textWidth - 30, maxX - selW / 2 - textWidth / 2 - 10));
        const tipY = Math.max(30, minY - 12);

        ctx.fillStyle = isTen ? '#10ac84' : '#2f3542';
        roundRect(ctx, tipX, tipY - 20, textWidth + 20, 26, 6);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tipText, tipX + (textWidth + 20) / 2, tipY - 7);
      }
    }

    // Right-side vertical timer bar (like the screenshot!)
    const gaugeX = gridX + COLS * cellW + 28;
    const gaugeY = gridY + 20;
    const gaugeW = 16;
    const gaugeH = ROWS * cellH - 40;

    // Timer gauge border
    ctx.strokeStyle = '#2ed573';
    ctx.lineWidth = 2;
    roundRect(ctx, gaugeX, gaugeY, gaugeW, gaugeH, 8);
    ctx.stroke();

    // Timer gauge fill
    const progress = Math.max(0, Math.min(1, timeLeft / GAME_DURATION));
    const fillH = gaugeH * progress;
    const fillY = gaugeY + (gaugeH - fillH);

    let gaugeColor = '#2ed573';
    if (progress < 0.25) gaugeColor = '#ff4757';
    else if (progress < 0.5) gaugeColor = '#ffa502';

    ctx.fillStyle = gaugeColor;
    roundRect(ctx, gaugeX + 2, fillY + 2, gaugeW - 4, fillH - 4, 6);
    ctx.fill();

    // Score display in top right
    ctx.fillStyle = '#2f3542';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${score}`, gaugeX + gaugeW / 2, gaugeY - 14);

    // Draw floating popups
    popups.forEach(p => {
      ctx.save();
      ctx.font = 'bold 24px "Segoe UI", sans-serif';
      ctx.fillStyle = `rgba(46, 213, 115, ${p.alpha})`;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 4;
      ctx.textAlign = 'center';
      ctx.fillText(p.text, p.x, p.y);
      ctx.restore();
    });
  }

  function loop() {
    if (!gameActive) return;
    update();
    draw();
    if (gameActive) {
      gameLoop = requestAnimationFrame(loop);
    }
  }
  loop();
}

// ============================================================
//  GAME 2: FLAPPY BIRD
//  Bird is 4x bigger (~80px), clean game over, stops score,
//  and easy replay & back buttons!
// ============================================================
function startFlappyGame() {
  stopActiveGame();
  currentGame = 'flappy';

  document.getElementById('game-title').textContent = '🐦 Flappy Bird';
  document.getElementById('game-timer-display').classList.add('hidden');
  document.getElementById('game-score-display').textContent = 'Score: 0';

  // Canvas size for Flappy Bird
  const W = 460;
  const H = 600;
  canvas.width = W;
  canvas.height = H;
  canvas.style.cursor = 'pointer';

  let score = 0;
  let gameActive = true;
  let started = false;

  // 4x bigger bird! (Width 74, Height 54)
  const bird = {
    x: 100,
    y: H / 2 - 20,
    vy: 0,
    w: 74,
    h: 54,
    hitRadius: 26, // fair circular collision radius
    wingAngle: 0,
  };

  const gravity = 0.38;
  const flapStrength = -7.5;
  const pipeSpeed = 2.6;
  const pipeGap = 190;   // Generous gap for the larger bird!
  const pipeWidth = 68;
  const pipes = [];
  let pipeTimer = 0;
  const groundH = 48;

  function flap() {
    if (!gameActive) return;
    if (!started) started = true;
    bird.vy = flapStrength;
    playSound('flap');
  }

  function onKeyDown(e) {
    if (e.key === ' ' || e.key === 'ArrowUp') {
      e.preventDefault();
      flap();
    }
  }

  function onPointerDown(e) {
    e.preventDefault();
    flap();
  }

  window.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });

  activeGameCleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('mousedown', onPointerDown);
    canvas.removeEventListener('touchstart', onPointerDown);
    canvas.style.cursor = 'default';
  };

  function spawnPipe() {
    const minTop = 60;
    const maxTop = H - groundH - pipeGap - 60;
    const topH = Math.floor(minTop + Math.random() * (maxTop - minTop));
    pipes.push({
      x: W,
      topH: topH,
      bottomY: topH + pipeGap,
      scored: false,
    });
  }

  function triggerGameOver() {
    if (!gameActive) return;
    gameActive = false;
    if (gameLoop) {
      cancelAnimationFrame(gameLoop);
      gameLoop = null;
    }
    playSound('hit');
    showGameOver(score);
  }

  function update() {
    if (!started || !gameActive) return;

    bird.vy += gravity;
    bird.y += bird.vy;

    // Wing flapping animation
    bird.wingAngle += 0.25;

    // Spawn pipes
    pipeTimer++;
    if (pipeTimer > 105) {
      spawnPipe();
      pipeTimer = 0;
    }

    // Move pipes
    for (let i = pipes.length - 1; i >= 0; i--) {
      pipes[i].x -= pipeSpeed;

      // Scoring
      if (!pipes[i].scored && pipes[i].x + pipeWidth < bird.x) {
        score++;
        pipes[i].scored = true;
        document.getElementById('game-score-display').textContent = `Score: ${score}`;
        playSound('point');
      }

      // Remove off-screen pipes
      if (pipes[i].x + pipeWidth < -10) {
        pipes.splice(i, 1);
      }
    }

    // Floor & ceiling collision
    if (bird.y + bird.hitRadius >= H - groundH || bird.y - bird.hitRadius <= 0) {
      triggerGameOver();
      return;
    }

    // Pipe collision using circle-rect collision detection
    for (const p of pipes) {
      // Check top pipe
      if (circleRectOverlap(bird.x, bird.y, bird.hitRadius, p.x, 0, pipeWidth, p.topH)) {
        triggerGameOver();
        return;
      }
      // Check bottom pipe
      if (circleRectOverlap(bird.x, bird.y, bird.hitRadius, p.x, p.bottomY, pipeWidth, H - groundH - p.bottomY)) {
        triggerGameOver();
        return;
      }
    }
  }

  function circleRectOverlap(cx, cy, r, rx, ry, rw, rh) {
    const closestX = Math.max(rx, Math.min(cx, rx + rw));
    const closestY = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - closestX;
    const dy = cy - closestY;
    return (dx * dx + dy * dy) < (r * r);
  }

  // Draw bird
  function drawBird(x, y, vy) {
    ctx.save();
    ctx.translate(x, y);

    // Rotate bird based on velocity
    const angle = Math.min(Math.max(vy * 3.5, -25), 70) * Math.PI / 180;
    ctx.rotate(angle);

    // Body (Yellow oval with nice gradient)
    const bodyGrad = ctx.createRadialGradient(-5, -6, 8, 0, 0, 36);
    bodyGrad.addColorStop(0, '#ffeaa7');
    bodyGrad.addColorStop(0.7, '#f1c40f');
    bodyGrad.addColorStop(1, '#e67e22');
    ctx.fillStyle = bodyGrad;

    ctx.beginPath();
    ctx.ellipse(0, 0, 35, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#d35400';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Belly (light cream)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(4, 8, 20, 14, -0.2, 0, Math.PI * 2);
    ctx.fill();

    // Wing
    ctx.save();
    const wingFlap = Math.sin(bird.wingAngle) * 8;
    ctx.translate(-14, 0);
    ctx.rotate(wingFlap * Math.PI / 180);
    ctx.fillStyle = '#f39c12';
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 12, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#d35400';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Big expressive cartoon eye
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(16, -10, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2c3e50';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Pupil
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(19, -10, 5, 0, Math.PI * 2);
    ctx.fill();

    // Eye highlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(17.5, -12, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Beak (Orange)
    ctx.fillStyle = '#e67e22';
    ctx.beginPath();
    ctx.moveTo(25, -2);
    ctx.lineTo(44, 4);
    ctx.lineTo(25, 10);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#c0392b';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, H - groundH);
    sky.addColorStop(0, '#4fc3f7');
    sky.addColorStop(0.7, '#81d4fa');
    sky.addColorStop(1, '#b3e5fc');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H - groundH);

    // Background distant clouds
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    ctx.arc(80, 100, 30, 0, Math.PI * 2);
    ctx.arc(115, 95, 40, 0, Math.PI * 2);
    ctx.arc(155, 100, 30, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(320, 160, 24, 0, Math.PI * 2);
    ctx.arc(350, 155, 34, 0, Math.PI * 2);
    ctx.arc(385, 160, 24, 0, Math.PI * 2);
    ctx.fill();

    // Draw Pipes
    pipes.forEach(p => {
      // Top Pipe body
      const topGrad = ctx.createLinearGradient(p.x, 0, p.x + pipeWidth, 0);
      topGrad.addColorStop(0, '#55efc4');
      topGrad.addColorStop(0.3, '#00b894');
      topGrad.addColorStop(0.8, '#00a884');
      topGrad.addColorStop(1, '#006266');

      ctx.fillStyle = topGrad;
      ctx.fillRect(p.x, 0, pipeWidth, p.topH);
      ctx.strokeStyle = '#006266';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(p.x, 0, pipeWidth, p.topH);

      // Top pipe cap lip
      const lipH = 26;
      ctx.fillRect(p.x - 4, p.topH - lipH, pipeWidth + 8, lipH);
      ctx.strokeRect(p.x - 4, p.topH - lipH, pipeWidth + 8, lipH);

      // Bottom Pipe body
      const bottomH = H - groundH - p.bottomY;
      ctx.fillRect(p.x, p.bottomY, pipeWidth, bottomH);
      ctx.strokeRect(p.x, p.bottomY, pipeWidth, bottomH);

      // Bottom pipe cap lip
      ctx.fillRect(p.x - 4, p.bottomY, pipeWidth + 8, lipH);
      ctx.strokeRect(p.x - 4, p.bottomY, pipeWidth + 8, lipH);
    });

    // Draw Bird
    if (!started) {
      // Gentle hovering wave before start
      const hoverY = bird.y + Math.sin(Date.now() / 250) * 8;
      drawBird(bird.x, hoverY, 0);

      // Start prompt
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      roundRect(ctx, W / 2 - 140, H / 2 + 50, 280, 50, 12);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 18px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Press SPACE or Click to Flap!', W / 2, H / 2 + 81);
    } else {
      drawBird(bird.x, bird.y, bird.vy);
    }

    // Ground
    ctx.fillStyle = '#e58e26';
    ctx.fillRect(0, H - groundH, W, groundH);
    ctx.fillStyle = '#78e08f';
    ctx.fillRect(0, H - groundH, W, 12);
    ctx.strokeStyle = '#38ada9';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, H - groundH, W, 12);

    // In-game score at top
    if (started) {
      ctx.font = 'bold 44px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 6;
      ctx.fillText(score, W / 2, 60);
      ctx.shadowBlur = 0;
    }
  }

  function loop() {
    if (!gameActive) return;
    update();
    draw();
    if (gameActive) {
      gameLoop = requestAnimationFrame(loop);
    }
  }
  loop();
}

// Helper: rounded rectangle on canvas
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// ============================================================
//  UTILITY
// ============================================================
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
