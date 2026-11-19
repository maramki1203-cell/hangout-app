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
let peerConnections = {};      // username -> RTCPeerConnection
let iceCandidateQueue = {};    // username -> [candidates]
let micEnabled = true;
let camEnabled = true;
let currentGame = null;
let gameLoop = null;
let activeGameCleanup = null;
let currentLbTab = 'apple';
let leaderboardsData = { apple: [], flappy: [], runner: [] };

// Gallery State
let galleryData = [];
let selectedSectionId = null;

// Gartic Phone State
let currentGarticBooks = null;
let lastGarticRound = -1;
let lastGarticStatus = '';

// ---- Robust WebRTC ICE Servers (STUN + OpenRelay TURN for remote NAT traversal) ----
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Free open relay TURN servers for NAT traversal behind symmetric NAT / firewalls
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
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

      // Show "New Section" button ONLY if logged in as bang!
      const createSecBtn = document.getElementById('create-section-btn');
      if (createSecBtn) {
        if (myUsername === 'bang') {
          createSecBtn.classList.remove('hidden');
        } else {
          createSecBtn.classList.add('hidden');
        }
      }

      loadRooms();
      loadCallHistory();
      loadLeaderboards();
      loadGallery();
    } else {
      loginError.textContent = res.message;
    }
  });
}

document.getElementById('logout-btn').addEventListener('click', () => {
  location.reload();
});

// ============================================================
//  NAVIGATION — 4 main tabs (Calls, Chat, Gallery, Arcade)
// ============================================================
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.section + '-section').classList.add('active');

    // Stop game if switching away from arcade
    if (btn.dataset.section !== 'arcade') {
      stopActiveGame();
    }

    if (btn.dataset.section === 'gallery') {
      loadGallery();
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
//  LEADERBOARDS (Top 5 scores)
// ============================================================
function loadLeaderboards() {
  socket.emit('get-leaderboards', (data) => {
    if (data) {
      leaderboardsData = data;
      renderLeaderboard();
    }
  });
}

socket.on('leaderboard-updated', ({ game, list }) => {
  leaderboardsData[game] = list;
  renderLeaderboard();
});

document.querySelectorAll('.lb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentLbTab = tab.dataset.lb;
    renderLeaderboard();
  });
});

function renderLeaderboard() {
  const container = document.getElementById('leaderboard-content');
  if (!container) return;
  container.innerHTML = '';

  const list = leaderboardsData[currentLbTab] || [];
  if (list.length === 0) {
    container.innerHTML = '<p style="color:#667;font-size:13px;padding:8px 0;">No scores yet! Be the first!</p>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  list.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = `lb-item rank-${index + 1}`;
    div.innerHTML = `
      <span class="lb-rank">${medals[index] || (index + 1) + '.'}</span>
      <span class="lb-name">${escHtml(item.username)}</span>
      <span class="lb-score">${item.score}</span>
    `;
    container.appendChild(div);
  });
}

// ============================================================
//  GALLERY (Sections & Community Photos)
// ============================================================
function loadGallery() {
  socket.emit('get-gallery', (sections) => {
    if (sections) {
      renderGallery(sections);
    }
  });
}

socket.on('gallery-updated', (sections) => {
  renderGallery(sections);
});

function renderGallery(sections) {
  galleryData = sections;
  const listContainer = document.getElementById('gallery-sections-list');
  listContainer.innerHTML = '';

  if (sections.length === 0) {
    listContainer.innerHTML = '<p style="color:#667;font-size:13px;padding:12px;">No sections yet.</p>';
  }

  // Ensure an active section is selected
  if (!selectedSectionId && sections.length > 0) {
    selectedSectionId = sections[0].id;
  }

  sections.forEach(sec => {
    const div = document.createElement('div');
    div.className = 'section-item' + (sec.id === selectedSectionId ? ' selected' : '');
    const canDel = (myUsername === 'bang');
    div.innerHTML = `
      <span class="sec-name">${escHtml(sec.name)}</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="sec-count">${sec.photos.length}</span>
        ${canDel ? `<button class="sec-del-inline-btn" title="Delete section" onclick="event.stopPropagation(); deleteGallerySectionById(${sec.id}, '${escHtml(sec.name)}')">🗑️</button>` : ''}
      </div>
    `;
    div.addEventListener('click', () => {
      selectedSectionId = sec.id;
      renderGallery(galleryData);
    });
    listContainer.appendChild(div);
  });

  // Render main photos grid
  const currentSec = sections.find(s => s.id === selectedSectionId);
  const nameEl = document.getElementById('gallery-current-section-name');
  const metaEl = document.getElementById('gallery-section-meta');
  const uploadBtn = document.getElementById('upload-photo-btn');
  const deleteSecBtn = document.getElementById('delete-section-btn');
  const grid = document.getElementById('gallery-photos-grid');

  if (!currentSec) {
    nameEl.textContent = 'Select a section';
    metaEl.textContent = 'Choose a folder on the left';
    uploadBtn.classList.add('hidden');
    if (deleteSecBtn) deleteSecBtn.classList.add('hidden');
    grid.innerHTML = '<div class="placeholder">Select a section on the left to see pictures!</div>';
    return;
  }

  nameEl.textContent = currentSec.name;
  metaEl.textContent = `Created by ${currentSec.createdBy} · ${currentSec.photos.length} photos`;
  uploadBtn.classList.remove('hidden');
  if (deleteSecBtn) {
    if (myUsername === 'bang') {
      deleteSecBtn.classList.remove('hidden');
    } else {
      deleteSecBtn.classList.add('hidden');
    }
  }

  grid.innerHTML = '';
  if (currentSec.photos.length === 0) {
    grid.innerHTML = '<div class="placeholder" style="grid-column:1/-1;">No photos here yet! Click "📷 Upload Photo" to add one!</div>';
    return;
  }

  currentSec.photos.forEach(photo => {
    const card = document.createElement('div');
    card.className = 'photo-card';

    const canDelete = (myUsername === 'bang' || photo.uploader === myUsername);
    const dateStr = new Date(photo.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });

    card.innerHTML = `
      <div class="photo-img-wrap" onclick="openImageViewer('${photo.url}')">
        <img src="${photo.url}" alt="Gallery photo" />
      </div>
      <div class="photo-card-info">
        <span class="photo-uploader">👤 ${escHtml(photo.uploader)}</span>
        <span>${dateStr}</span>
        ${canDelete ? `<button class="photo-delete-btn" title="Delete photo" onclick="deleteGalleryPhoto(${currentSec.id}, ${photo.id})">🗑️</button>` : ''}
      </div>
    `;
    grid.appendChild(card);
  });
}

// Create new gallery section (Bang only)
const createSecBtn = document.getElementById('create-section-btn');
const modalSec = document.getElementById('modal-section');

createSecBtn.addEventListener('click', () => {
  if (myUsername !== 'bang') return;
  document.getElementById('new-section-name').value = '';
  modalSec.classList.remove('hidden');
});

document.getElementById('modal-section-cancel').addEventListener('click', () => {
  modalSec.classList.add('hidden');
});

document.getElementById('modal-section-create').addEventListener('click', () => {
  const name = document.getElementById('new-section-name').value.trim();
  if (!name) { alert('Please enter a section name.'); return; }

  socket.emit('create-gallery-section', { name }, (res) => {
    if (res.success) {
      modalSec.classList.add('hidden');
      selectedSectionId = res.section.id;
    } else {
      alert(res.message || 'Error creating section.');
    }
  });
});

// Upload photo to gallery
const galleryUploadBtn = document.getElementById('upload-photo-btn');
const galleryFileInput = document.getElementById('gallery-file-input');

galleryUploadBtn.addEventListener('click', () => {
  if (!selectedSectionId) { alert('Select a section first.'); return; }
  galleryFileInput.click();
});

galleryFileInput.addEventListener('change', () => {
  const file = galleryFileInput.files[0];
  if (file && selectedSectionId) {
    compressImage(file, 1000, 0.8, (dataUrl) => {
      socket.emit('upload-gallery-photo', {
        sectionId: selectedSectionId,
        image: dataUrl,
      }, (res) => {
        if (!res.success) alert(res.message || 'Error uploading photo.');
      });
    });
    galleryFileInput.value = '';
  }
});

window.deleteGalleryPhoto = function(sectionId, photoId) {
  if (confirm('Delete this photo from the gallery?')) {
    socket.emit('delete-gallery-photo', { sectionId, photoId });
  }
};

// Delete gallery section (Bang only)
const deleteSecBtn = document.getElementById('delete-section-btn');
if (deleteSecBtn) {
  deleteSecBtn.addEventListener('click', () => {
    if (myUsername !== 'bang') return;
    const currentSec = galleryData.find(s => s.id === selectedSectionId);
    if (!currentSec) return;
    deleteGallerySectionById(currentSec.id, currentSec.name);
  });
}

window.deleteGallerySectionById = function(secId, secName) {
  if (myUsername !== 'bang') {
    alert('Only bang can delete sections!');
    return;
  }
  if (confirm(`Are you sure you want to delete section "${secName}" and all of its photos?`)) {
    socket.emit('delete-gallery-section', { sectionId: secId }, (res) => {
      if (res && res.success) {
        if (selectedSectionId === secId) selectedSectionId = null;
        loadGallery();
      } else {
        alert((res && res.message) || 'Error deleting section.');
      }
    });
  }
};

// ============================================================
//  CHAT — Rooms & Messages with Photo Upload
// ============================================================
function loadRooms() {
  socket.emit('get-rooms', (rooms) => {
    renderRoomList(rooms);
    // If no room is currently selected and we have rooms, automatically open the first room!
    if (!currentRoomId && rooms && rooms.length > 0) {
      openRoom(rooms[0].id, rooms[0].name, rooms[0].members);
    }
  });
}

function renderRoomList(rooms) {
  const list = document.getElementById('room-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item' + (r.id === currentRoomId ? ' selected' : '');
    let lastMsg = 'No messages yet';
    if (r.lastMessage) {
      if (r.lastMessage.image && !r.lastMessage.text) {
        lastMsg = `${r.lastMessage.sender}: [📷 Photo]`;
      } else {
        lastMsg = `${r.lastMessage.sender}: ${r.lastMessage.text}`;
      }
    }
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

  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('selected'));
  document.querySelectorAll('.room-item').forEach(el => {
    if (el.querySelector('.room-name').textContent === name) el.classList.add('selected');
  });

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

  let imageHtml = '';
  if (msg.image) {
    imageHtml = `
      <div class="msg-img-container" onclick="openImageViewer('${msg.image}')">
        <img class="msg-img-preview" src="${msg.image}" alt="Photo" />
      </div>
    `;
  }

  let textHtml = '';
  if (msg.text) {
    // Preserve line breaks for shared albums
    const formattedText = escHtml(msg.text).replace(/\n/g, '<br/>');
    textHtml = `<div class="msg-bubble">${formattedText}</div>`;
  }

  div.innerHTML = `
    <div class="msg-sender">${escHtml(msg.sender)}</div>
    ${textHtml}
    ${imageHtml}
    <div class="msg-time">${time}</div>
  `;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

// Send message (Korean IME composition safe!)
const msgInput = document.getElementById('message-input');
let isImeComposing = false;

msgInput.addEventListener('compositionstart', () => {
  isImeComposing = true;
});

msgInput.addEventListener('compositionend', () => {
  isImeComposing = false;
});

document.getElementById('send-msg-btn').addEventListener('click', sendMessage);

msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing || isImeComposing || e.keyCode === 229) {
      return;
    }
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text || !currentRoomId) return;

  input.value = '';

  setTimeout(() => {
    if (input.value) {
      input.value = '';
    }
  }, 10);

  socket.emit('send-message', { roomId: currentRoomId, text, image: null });
}

// Real-time messages
socket.on('new-message', ({ roomId, message }) => {
  if (roomId === currentRoomId) {
    appendMessage(message);
  }
  loadRooms();
});

// Image Upload in Chat
const chatFileInput = document.getElementById('chat-file-input');
const chatImageBtn = document.getElementById('chat-image-btn');

chatImageBtn.addEventListener('click', () => {
  if (!currentRoomId) { alert('Select a chat room first.'); return; }
  chatFileInput.click();
});

chatFileInput.addEventListener('change', () => {
  const file = chatFileInput.files[0];
  if (file && currentRoomId) {
    compressImage(file, 900, 0.8, (dataUrl) => {
      socket.emit('send-message', {
        roomId: currentRoomId,
        text: '',
        image: dataUrl,
      });
    });
    chatFileInput.value = '';
  }
});

// Clipboard Paste
document.getElementById('message-input').addEventListener('paste', (e) => {
  if (!currentRoomId) return;
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.type.indexOf('image') !== -1) {
      const file = item.getAsFile();
      compressImage(file, 900, 0.8, (dataUrl) => {
        socket.emit('send-message', {
          roomId: currentRoomId,
          text: '',
          image: dataUrl,
        });
      });
      e.preventDefault();
      break;
    }
  }
});

// Shared Image Compression Helper
function compressImage(file, maxDim, quality, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      const offCanvas = document.createElement('canvas');
      offCanvas.width = w;
      offCanvas.height = h;
      const oCtx = offCanvas.getContext('2d');
      oCtx.drawImage(img, 0, 0, w, h);
      callback(offCanvas.toDataURL('image/jpeg', quality));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Image Viewer Modal
window.openImageViewer = function(src) {
  document.getElementById('image-viewer-img').src = src;
  document.getElementById('image-viewer-modal').classList.remove('hidden');
};
document.getElementById('image-viewer-close').addEventListener('click', () => {
  document.getElementById('image-viewer-modal').classList.add('hidden');
});
document.getElementById('image-viewer-modal').addEventListener('click', (e) => {
  if (e.target.id === 'image-viewer-modal') {
    document.getElementById('image-viewer-modal').classList.add('hidden');
  }
});

// New Chat Modal
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

document.getElementById('chat-call-btn').addEventListener('click', () => {
  if (!currentRoomId) return;
  const membersText = document.getElementById('chat-room-members').textContent;
  const participants = membersText.split(', ').map(s => s.trim()).filter(Boolean);
  startCall(participants);
});

// ============================================================
//  CALLS & WEBRTC
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

let incomingCallTimer = null;
let incomingCallRingtone = null;

function playRingtone() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    function beep() {
      const now = ac.currentTime;
      const o1 = ac.createOscillator();
      const o2 = ac.createOscillator();
      const g = ac.createGain();
      o1.type = 'sine';
      o2.type = 'sine';
      o1.frequency.setValueAtTime(853, now);
      o2.frequency.setValueAtTime(960, now);
      g.gain.setValueAtTime(0.12, now);
      g.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      o1.connect(g);
      o2.connect(g);
      g.connect(ac.destination);
      o1.start(now);
      o2.start(now);
      o1.stop(now + 0.4);
      o2.stop(now + 0.4);
    }
    beep();
    incomingCallRingtone = setInterval(beep, 2500);
  } catch (e) {}
}

function stopRingtone() {
  if (incomingCallRingtone) {
    clearInterval(incomingCallRingtone);
    incomingCallRingtone = null;
  }
}

socket.on('incoming-call', ({ callId, caller }) => {
  stopRingtone();
  playRingtone();

  const modal = document.getElementById('incoming-call-modal');
  const callerNameEl = document.getElementById('incoming-caller-name');
  if (callerNameEl) callerNameEl.textContent = caller;
  if (modal) modal.classList.remove('hidden');

  const joinBtn = document.getElementById('incoming-call-join-btn');
  const declineBtn = document.getElementById('incoming-call-decline-btn');

  function cleanupCallModal() {
    stopRingtone();
    if (modal) modal.classList.add('hidden');
    if (incomingCallTimer) {
      clearTimeout(incomingCallTimer);
      incomingCallTimer = null;
    }
  }

  if (joinBtn) {
    joinBtn.onclick = () => {
      cleanupCallModal();
      joinCall(callId);
    };
  }

  if (declineBtn) {
    declineBtn.onclick = () => {
      cleanupCallModal();
    };
  }

  if (incomingCallTimer) clearTimeout(incomingCallTimer);
  incomingCallTimer = setTimeout(() => {
    cleanupCallModal();
  }, 35000);
});

socket.on('call-ended-auto', ({ message }) => {
  alert(message || 'Everyone else has left the call. Call ended.');
  endCall();
});

async function startCall(participants) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    alert('Could not access camera/microphone. Please allow camera & microphone permissions.');
    return;
  }

  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.play().catch(e => console.warn(e));

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
    alert('Could not access camera/microphone. Please check browser permissions.');
    return;
  }

  currentCallId = callId;
  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.play().catch(e => console.warn(e));

  document.getElementById('call-overlay').classList.remove('hidden');
  micEnabled = true;
  camEnabled = true;

  socket.emit('join-call', { callId }, (res) => {
    if (res.success) {
      document.getElementById('call-status').textContent = `In Call`;
      res.peers.forEach(peer => {
        createPeerConnection(peer, false);
      });
    } else {
      alert(res.message || 'Could not join call.');
      endCall();
    }
  });
}

function createPeerConnection(peerUsername, isInitiator) {
  if (peerConnections[peerUsername]) return;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[peerUsername] = pc;
  iceCandidateQueue[peerUsername] = [];

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.ontrack = (event) => {
    let videoBox = document.getElementById('video-' + peerUsername);
    if (!videoBox) {
      videoBox = document.createElement('div');
      videoBox.className = 'video-box';
      videoBox.id = 'video-' + peerUsername;
      videoBox.innerHTML = `
        <video autoplay playsinline></video>
        <span class="video-label">${escHtml(peerUsername)}</span>
      `;
      document.getElementById('videos-grid').appendChild(videoBox);
    }
    const remoteVideo = videoBox.querySelector('video');
    remoteVideo.srcObject = event.streams[0];
    remoteVideo.muted = false;
    remoteVideo.play().catch(e => console.warn('Autoplay prevented:', e));
    document.getElementById('call-status').textContent = `In Call`;
  };

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

  if (isInitiator) {
    pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('webrtc-offer', {
          callId: currentCallId,
          to: peerUsername,
          offer: pc.localDescription,
        });
      })
      .catch(err => console.error('Error creating offer:', err));
  }
}

socket.on('webrtc-offer', async ({ callId, from, offer }) => {
  createPeerConnection(from, false);
  const pc = peerConnections[from];
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    if (iceCandidateQueue[from] && iceCandidateQueue[from].length > 0) {
      for (const cand of iceCandidateQueue[from]) {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn(e));
      }
      iceCandidateQueue[from] = [];
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { callId, to: from, answer: pc.localDescription });
  } catch (err) {
    console.error('Error handling WebRTC offer:', err);
  }
});

socket.on('webrtc-answer', async ({ from, answer }) => {
  const pc = peerConnections[from];
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      if (iceCandidateQueue[from] && iceCandidateQueue[from].length > 0) {
        for (const cand of iceCandidateQueue[from]) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn(e));
        }
        iceCandidateQueue[from] = [];
      }
    } catch (err) {
      console.error('Error setting remote answer:', err);
    }
  }
});

socket.on('webrtc-ice-candidate', async ({ from, candidate }) => {
  const pc = peerConnections[from];
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('Error adding ICE candidate:', err);
    }
  } else {
    if (!iceCandidateQueue[from]) iceCandidateQueue[from] = [];
    iceCandidateQueue[from].push(candidate);
  }
});

socket.on('peer-joined', ({ callId, username }) => {
  if (callId === currentCallId) {
    createPeerConnection(username, true);
  }
});

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
  delete iceCandidateQueue[username];
  const box = document.getElementById('video-' + username);
  if (box) box.remove();

  if (currentCallId && Object.keys(peerConnections).length === 0) {
    alert('Everyone else has left the call. Call ended.');
    endCall();
  }
}

document.getElementById('toggle-mic').addEventListener('click', () => {
  micEnabled = !micEnabled;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  }
  document.getElementById('toggle-mic').classList.toggle('muted', !micEnabled);
  document.getElementById('toggle-mic').textContent = micEnabled ? '🎤' : '🔇';
});

document.getElementById('toggle-cam').addEventListener('click', () => {
  camEnabled = !camEnabled;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  }
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

  Object.keys(peerConnections).forEach(removePeer);
  peerConnections = {};
  iceCandidateQueue = {};

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  document.getElementById('call-overlay').classList.add('hidden');
  document.getElementById('local-video').srcObject = null;
  document.querySelectorAll('#videos-grid .video-box:not(#local-video-box)').forEach(el => el.remove());

  currentCallId = null;
  loadCallHistory();
}

// ============================================================
//  ARCADE GAMES
// ============================================================
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

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
    const o1 = ac.createOscillator();
    const g1 = ac.createGain();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(523.25, now);
    o1.frequency.setValueAtTime(659.25, now + 0.08);
    o1.frequency.setValueAtTime(783.99, now + 0.16);
    g1.gain.setValueAtTime(0.2, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    o1.connect(g1);
    g1.connect(ac.destination);
    o1.start(now);
    o1.stop(now + 0.35);
  } else if (type === 'flap') {
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
  } else if (type === 'point' || type === 'coin') {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(987.77, now);
    o.frequency.setValueAtTime(1318.51, now + 0.08);
    g.gain.setValueAtTime(0.1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    o.connect(g);
    g.connect(ac.destination);
    o.start(now);
    o.stop(now + 0.28);
  } else if (type === 'hit') {
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

document.querySelectorAll('.play-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const game = btn.dataset.game;
    currentGame = game;

    if (game === 'gartic') {
      openGarticPhone();
      return;
    }

    document.getElementById('arcade-menu').classList.add('hidden');
    document.getElementById('gartic-area').classList.add('hidden');
    document.getElementById('game-area').classList.remove('hidden');
    document.getElementById('game-over-overlay').classList.add('hidden');

    if (game === 'apple') startAppleGame();
    else if (game === 'flappy') startFlappyGame();
    else if (game === 'runner') startSubwayRunnerGame();
  });
});

document.getElementById('back-to-arcade').addEventListener('click', () => {
  stopActiveGame();
  currentGame = null;
  document.getElementById('game-area').classList.add('hidden');
  document.getElementById('game-over-overlay').classList.add('hidden');
  document.getElementById('arcade-menu').classList.remove('hidden');
  loadLeaderboards();
});

// "Back to Arcade" button in Game Over Popup
document.getElementById('exit-game-btn').addEventListener('click', () => {
  stopActiveGame();
  currentGame = null;
  document.getElementById('game-over-overlay').classList.add('hidden');
  document.getElementById('game-area').classList.add('hidden');
  document.getElementById('arcade-menu').classList.remove('hidden');
  loadLeaderboards(); // ensures top 5 is fresh!
});

// "One More Round" button in Game Over Popup
document.getElementById('restart-game-btn').addEventListener('click', () => {
  document.getElementById('game-over-overlay').classList.add('hidden');
  if (currentGame === 'apple') startAppleGame();
  else if (currentGame === 'flappy') startFlappyGame();
  else if (currentGame === 'runner') startSubwayRunnerGame();
});

document.getElementById('restart-game-top-btn').addEventListener('click', () => {
  document.getElementById('game-over-overlay').classList.add('hidden');
  if (currentGame === 'apple') startAppleGame();
  else if (currentGame === 'flappy') startFlappyGame();
  else if (currentGame === 'runner') startSubwayRunnerGame();
});

// Game Over Popup with Ranking Update
function showGameOver(score, customTitle = 'Game Over', customMsg = null) {
  document.getElementById('game-over-title').textContent = customTitle;
  document.getElementById('final-score').textContent = score;
  if (customMsg) {
    document.getElementById('game-over-msg').innerHTML = customMsg;
  } else {
    document.getElementById('game-over-msg').innerHTML = `Final Score: <span id="final-score">${score}</span>`;
  }

  const rankBox = document.getElementById('game-over-rank');
  rankBox.classList.add('hidden');

  // Submit to leaderboard immediately so BOTH buttons ("One More Round" & "Back to Arcade") save the ranking!
  // Only submit if score > 0 (score <= 0 is not eligible for leaderboard)
  if (currentGame && typeof score === 'number' && score > 0) {
    socket.emit('submit-score', { game: currentGame, score }, (res) => {
      if (res && res.success) {
        if (res.rank && res.rank <= 5) {
          rankBox.innerHTML = `🏆 <strong>New High Score!</strong> You're Rank #${res.rank}!`;
          rankBox.classList.remove('hidden');
        } else if (res.topScore) {
          rankBox.innerHTML = `Your Score: <strong>${score}</strong> · Top 1: <strong>${res.topScore}</strong>`;
          rankBox.classList.remove('hidden');
        }
        // Switch leaderboard tab to this game and reload scores
        currentLbTab = currentGame;
        document.querySelectorAll('.lb-tab').forEach(t => {
          t.classList.toggle('active', t.getAttribute('data-game') === currentGame);
        });
        loadLeaderboards();
      }
    });
  } else {
    rankBox.innerHTML = `<span style="color:#8899aa;font-size:13px;">Score: 0 — Not ranked. Keep playing to get on the leaderboard!</span>`;
    rankBox.classList.remove('hidden');
  }

  document.getElementById('game-over-overlay').classList.remove('hidden');
}

// ============================================================
//  GAME 1: FRUIT BOX (사과 게임)
// ============================================================
function startAppleGame() {
  stopActiveGame();
  currentGame = 'apple';

  document.getElementById('game-title').textContent = '🍎 Fruit Box (사과 게임)';
  const timerDisplay = document.getElementById('game-timer-display');
  timerDisplay.classList.remove('hidden');
  document.getElementById('game-score-display').textContent = 'Score: 0';

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
  const GAME_DURATION = 120;
  let startTime = Date.now();
  let timeLeft = GAME_DURATION;
  let gameActive = true;

  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      row.push({
        r, c,
        val: Math.floor(Math.random() * 9) + 1,
        cleared: false,
      });
    }
    grid.push(row);
  }

  const popups = [];
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

  function onMouseUp() {
    if (!isDragging || !gameActive) return;
    isDragging = false;

    const selected = getSelectedApples();
    if (selected.length === 0) return;

    let sum = 0;
    selected.forEach(a => sum += a.val);

    if (sum === 10) {
      selected.forEach(a => a.cleared = true);
      const clearedCount = selected.length;
      score += clearedCount;
      remainingApples -= clearedCount;
      document.getElementById('game-score-display').textContent = `Score: ${score}`;
      playSound('apple-match');

      const midX = (dragStart.x + dragCurrent.x) / 2;
      const midY = (dragStart.y + dragCurrent.y) / 2;
      popups.push({ x: midX, y: midY, text: `+${clearedCount}`, alpha: 1.0 });

      if (remainingApples <= 0) {
        gameActive = false;
        showGameOver(score, '🎉 Perfect Clear!', `Cleared all apples! Score: ${score}`);
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

  function drawApple(x, y, w, h, val, isSelected) {
    const cx = x + w / 2;
    const cy = y + h / 2 + 3;
    const r = Math.min(w, h) * 0.42;

    ctx.save();
    ctx.strokeStyle = '#6d4c41';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r + 3);
    ctx.quadraticCurveTo(cx + 3, cy - r - 6, cx + 5, cy - r - 8);
    ctx.stroke();

    ctx.fillStyle = '#4cd137';
    ctx.beginPath();
    ctx.ellipse(cx + 4, cy - r - 4, 4.5, 2.5, Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();

    if (isSelected) {
      ctx.shadowColor = '#ffeaa7';
      ctx.shadowBlur = 10;
    }

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
    ctx.arc(cx - r * 0.35, cy, r * 0.75, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.35, cy, r * 0.75, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.4, cy - r * 0.35, r * 0.3, r * 0.15, -Math.PI / 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(val, cx, cy + 1);

    ctx.restore();
  }

  function update() {
    if (!gameActive) return;

    const elapsed = (Date.now() - startTime) / 1000;
    timeLeft = Math.max(0, GAME_DURATION - elapsed);
    timerDisplay.textContent = `⏱️ ${Math.ceil(timeLeft)}s`;

    if (timeLeft <= 0) {
      gameActive = false;
      timerDisplay.textContent = '⏱️ 0s';
      playSound('hit');
      showGameOver(score, "Time's Up!", `You cleared <strong>${score}</strong> apples out of 170!`);
    }

    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].y -= 1;
      popups[i].alpha -= 0.025;
      if (popups[i].alpha <= 0) popups.splice(i, 1);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#20bf6b';
    roundRect(ctx, 0, 0, W, H, 16);
    ctx.fill();

    const boardPadding = 12;
    ctx.fillStyle = '#eafaf1';
    roundRect(ctx, boardPadding, boardPadding, W - boardPadding * 2, H - boardPadding * 2, 10);
    ctx.fill();

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

    const selectedApples = isDragging ? getSelectedApples() : [];
    const selectedSet = new Set(selectedApples);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const apple = grid[r][c];
        if (apple.cleared) continue;
        const ax = gridX + c * cellW;
        const ay = gridY + r * cellH;
        drawApple(ax, ay, cellW, cellH, apple.val, selectedSet.has(apple));
      }
    }

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

      ctx.fillStyle = isTen ? 'rgba(46, 213, 115, 0.25)' : 'rgba(78, 140, 255, 0.2)';
      ctx.fillRect(minX, minY, selW, selH);

      ctx.strokeStyle = isTen ? '#2ed573' : '#4e8cff';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(minX, minY, selW, selH);
      ctx.setLineDash([]);

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

    const gaugeX = gridX + COLS * cellW + 28;
    const gaugeY = gridY + 20;
    const gaugeW = 16;
    const gaugeH = ROWS * cellH - 40;

    ctx.strokeStyle = '#2ed573';
    ctx.lineWidth = 2;
    roundRect(ctx, gaugeX, gaugeY, gaugeW, gaugeH, 8);
    ctx.stroke();

    const progress = Math.max(0, Math.min(1, timeLeft / GAME_DURATION));
    const fillH = gaugeH * progress;
    const fillY = gaugeY + (gaugeH - fillH);

    let gaugeColor = '#2ed573';
    if (progress < 0.25) gaugeColor = '#ff4757';
    else if (progress < 0.5) gaugeColor = '#ffa502';

    ctx.fillStyle = gaugeColor;
    roundRect(ctx, gaugeX + 2, fillY + 2, gaugeW - 4, fillH - 4, 6);
    ctx.fill();

    ctx.fillStyle = '#2f3542';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${score}`, gaugeX + gaugeW / 2, gaugeY - 14);

    popups.forEach(p => {
      ctx.save();
      ctx.font = 'bold 24px "Segoe UI", sans-serif';
      ctx.fillStyle = `rgba(46, 213, 115, ${p.alpha})`;
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
// ============================================================
function startFlappyGame() {
  stopActiveGame();
  currentGame = 'flappy';

  document.getElementById('game-title').textContent = '🐦 Flappy Bird';
  document.getElementById('game-timer-display').classList.add('hidden');
  document.getElementById('game-score-display').textContent = 'Score: 0';

  const W = 460;
  const H = 600;
  canvas.width = W;
  canvas.height = H;
  canvas.style.cursor = 'pointer';

  let score = 0;
  let gameActive = true;
  let started = false;

  const bird = {
    x: 100,
    y: H / 2 - 20,
    vy: 0,
    w: 74,
    h: 54,
    hitRadius: 26,
    wingAngle: 0,
  };

  const gravity = 0.38;
  const flapStrength = -7.5;
  const pipeSpeed = 2.6;
  const pipeGap = 190;
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
    bird.wingAngle += 0.25;

    pipeTimer++;
    if (pipeTimer > 105) {
      spawnPipe();
      pipeTimer = 0;
    }

    for (let i = pipes.length - 1; i >= 0; i--) {
      pipes[i].x -= pipeSpeed;
      if (!pipes[i].scored && pipes[i].x + pipeWidth < bird.x) {
        score++;
        pipes[i].scored = true;
        document.getElementById('game-score-display').textContent = `Score: ${score}`;
        playSound('point');
      }
      if (pipes[i].x + pipeWidth < -10) {
        pipes.splice(i, 1);
      }
    }

    if (bird.y + bird.hitRadius >= H - groundH || bird.y - bird.hitRadius <= 0) {
      triggerGameOver();
      return;
    }

    for (const p of pipes) {
      if (circleRectOverlap(bird.x, bird.y, bird.hitRadius, p.x, 0, pipeWidth, p.topH)) {
        triggerGameOver();
        return;
      }
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

  function drawBird(x, y, vy) {
    ctx.save();
    ctx.translate(x, y);
    const angle = Math.min(Math.max(vy * 3.5, -25), 70) * Math.PI / 180;
    ctx.rotate(angle);

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

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(4, 8, 20, 14, -0.2, 0, Math.PI * 2);
    ctx.fill();

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

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(16, -10, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2c3e50';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(19, -10, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(17.5, -12, 2.5, 0, Math.PI * 2);
    ctx.fill();

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

    const sky = ctx.createLinearGradient(0, 0, 0, H - groundH);
    sky.addColorStop(0, '#4fc3f7');
    sky.addColorStop(0.7, '#81d4fa');
    sky.addColorStop(1, '#b3e5fc');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H - groundH);

    pipes.forEach(p => {
      const topGrad = ctx.createLinearGradient(p.x, 0, p.x + pipeWidth, 0);
      topGrad.addColorStop(0, '#55efc4');
      topGrad.addColorStop(0.3, '#00b894');
      topGrad.addColorStop(1, '#006266');

      ctx.fillStyle = topGrad;
      ctx.fillRect(p.x, 0, pipeWidth, p.topH);
      ctx.strokeStyle = '#006266';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(p.x, 0, pipeWidth, p.topH);

      const lipH = 26;
      ctx.fillRect(p.x - 4, p.topH - lipH, pipeWidth + 8, lipH);
      ctx.strokeRect(p.x - 4, p.topH - lipH, pipeWidth + 8, lipH);

      const bottomH = H - groundH - p.bottomY;
      ctx.fillRect(p.x, p.bottomY, pipeWidth, bottomH);
      ctx.strokeRect(p.x, p.bottomY, pipeWidth, bottomH);
      ctx.fillRect(p.x - 4, p.bottomY, pipeWidth + 8, lipH);
      ctx.strokeRect(p.x - 4, p.bottomY, pipeWidth + 8, lipH);
    });

    if (!started) {
      const hoverY = bird.y + Math.sin(Date.now() / 250) * 8;
      drawBird(bird.x, hoverY, 0);

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

    ctx.fillStyle = '#e58e26';
    ctx.fillRect(0, H - groundH, W, groundH);
    ctx.fillStyle = '#78e08f';
    ctx.fillRect(0, H - groundH, W, 12);
    ctx.strokeStyle = '#38ada9';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, H - groundH, W, 12);

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

// ============================================================
//  GAME 3: SUBWAY RUNNER (3-Lane Track Runner)
// ============================================================
function startSubwayRunnerGame() {
  stopActiveGame();
  currentGame = 'runner';

  document.getElementById('game-title').textContent = '🛹 Subway Runner';
  document.getElementById('game-timer-display').classList.add('hidden');
  document.getElementById('game-score-display').textContent = 'Score: 0';

  const W = 480;
  const H = 600;
  canvas.width = W;
  canvas.height = H;
  canvas.style.cursor = 'default';

  let score = 0;
  let coinsCount = 0;
  let distance = 0;
  let gameSpeed = 5.5;
  let gameActive = true;
  let started = false;

  const lanesX = [120, 240, 360];
  const horizonY = 170;
  const horizonW = 90;

  const player = {
    lane: 1,
    targetX: 240,
    currentX: 240,
    yOffset: 0,
    vy: 0,
    isJumping: false,
    isSliding: false,
    slideTimer: 0,
  };

  const obstacles = [];
  const coins = [];
  let spawnTimer = 0;

  function moveLeft() {
    if (!started) started = true;
    if (player.lane > 0) {
      player.lane--;
      player.targetX = lanesX[player.lane];
    }
  }

  function moveRight() {
    if (!started) started = true;
    if (player.lane < 2) {
      player.lane++;
      player.targetX = lanesX[player.lane];
    }
  }

  function jump() {
    if (!started) started = true;
    if (!player.isJumping) {
      player.isJumping = true;
      player.isSliding = false;
      player.vy = -14;
      playSound('flap');
    }
  }

  function slide() {
    if (!started) started = true;
    if (player.isJumping) {
      player.vy = 16;
    } else {
      player.isSliding = true;
      player.slideTimer = 35;
    }
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); moveLeft(); }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); moveRight(); }
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') { e.preventDefault(); jump(); }
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { e.preventDefault(); slide(); }
  }

  let touchStartX = 0;
  let touchStartY = 0;

  function onTouchStart(e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }

  function onTouchEnd(e) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx < -30) moveLeft();
      else if (dx > 30) moveRight();
    } else {
      if (dy < -30) jump();
      else if (dy > 30) slide();
    }
  }

  window.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchend', onTouchEnd, { passive: true });

  activeGameCleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchend', onTouchEnd);
  };

  function spawnWorldObjects() {
    const types = ['train', 'barrier-low', 'barrier-high'];
    const chosenType = types[Math.floor(Math.random() * types.length)];
    const chosenLane = Math.floor(Math.random() * 3);

    obstacles.push({
      lane: chosenLane,
      z: 1000,
      type: chosenType,
    });

    const coinLane = (chosenLane + 1) % 3;
    for (let i = 0; i < 4; i++) {
      coins.push({
        lane: coinLane,
        z: 950 + i * 40,
        collected: false,
      });
    }
  }

  function update() {
    if (!started || !gameActive) return;

    distance += gameSpeed;
    gameSpeed = Math.min(13, 5.5 + distance * 0.001);
    score = Math.floor(distance / 5) + coinsCount * 10;
    document.getElementById('game-score-display').textContent = `Score: ${score}`;

    player.currentX += (player.targetX - player.currentX) * 0.28;

    if (player.isJumping) {
      player.yOffset += player.vy;
      player.vy += 0.8;
      if (player.yOffset >= 0) {
        player.yOffset = 0;
        player.vy = 0;
        player.isJumping = false;
      }
    }

    if (player.isSliding) {
      player.slideTimer--;
      if (player.slideTimer <= 0) {
        player.isSliding = false;
      }
    }

    spawnTimer++;
    if (spawnTimer > Math.max(38, 90 - Math.floor(distance * 0.01))) {
      spawnWorldObjects();
      spawnTimer = 0;
    }

    for (let i = obstacles.length - 1; i >= 0; i--) {
      const obs = obstacles[i];
      obs.z -= gameSpeed * 1.8;

      if (obs.z <= 110 && obs.z >= 50 && obs.lane === player.lane) {
        let safe = false;
        if (obs.type === 'barrier-low' && player.yOffset < -30) {
          safe = true;
        } else if (obs.type === 'barrier-high' && player.isSliding) {
          safe = true;
        }

        if (!safe) {
          gameActive = false;
          playSound('hit');
          showGameOver(score, '💥 Crashed!', `You ran <strong>${Math.floor(distance/5)}m</strong> and collected <strong>${coinsCount}</strong> coins!`);
          return;
        }
      }

      if (obs.z < 0) {
        obstacles.splice(i, 1);
      }
    }

    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.z -= gameSpeed * 1.8;

      if (!c.collected && c.z <= 110 && c.z >= 50 && c.lane === player.lane && player.yOffset > -40) {
        c.collected = true;
        coinsCount++;
        playSound('coin');
      }

      if (c.z < 0) {
        coins.splice(i, 1);
      }
    }
  }

  function project(lane, z) {
    const depth = Math.max(0.01, z / 1000);
    const pScale = 1 - depth * 0.85;
    const groundBottomY = 530;
    const y = horizonY + (groundBottomY - horizonY) * (1 - depth);
    const laneXBottom = lanesX[lane];
    const laneXHorizon = W / 2 + (lane - 1) * (horizonW / 2);
    const x = laneXHorizon + (laneXBottom - laneXHorizon) * (1 - depth);
    return { x, y, scale: pScale };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, '#0c1021');
    sky.addColorStop(1, '#1e2952');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizonY);

    ctx.fillStyle = '#0f1630';
    for (let i = 0; i < 9; i++) {
      const bh = 40 + (i * 19) % 55;
      ctx.fillRect(i * 55, horizonY - bh, 48, bh);
    }

    const ground = ctx.createLinearGradient(0, horizonY, 0, H);
    ground.addColorStop(0, '#192038');
    ground.addColorStop(1, '#0e1220');
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizonY, W, H - horizonY);

    ctx.strokeStyle = '#34495e';
    ctx.lineWidth = 3;
    const railXOffsets = [-60, -20, 20, 60];
    railXOffsets.forEach(ox => {
      ctx.beginPath();
      ctx.moveTo(W / 2 + ox * 0.15, horizonY);
      ctx.lineTo(W / 2 + ox * 3.6, H);
      ctx.stroke();
    });

    const tieSpacing = 40;
    const tieOffset = (distance * 2) % tieSpacing;
    ctx.strokeStyle = '#222f4b';
    ctx.lineWidth = 4;
    for (let z = 1000 - tieOffset; z > 0; z -= tieSpacing) {
      const pL = project(0, z);
      const pR = project(2, z);
      ctx.beginPath();
      ctx.moveTo(pL.x - 30 * pL.scale, pL.y);
      ctx.lineTo(pR.x + 30 * pR.scale, pR.y);
      ctx.stroke();
    }

    coins.forEach(c => {
      if (c.collected) return;
      const p = project(c.lane, c.z);
      const coinR = 12 * p.scale;
      ctx.save();
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath();
      ctx.arc(p.x, p.y - 20 * p.scale, coinR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f39c12';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(8, 12 * p.scale)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('$', p.x, p.y - 16 * p.scale);
      ctx.restore();
    });

    obstacles.sort((a, b) => b.z - a.z);
    obstacles.forEach(obs => {
      const p = project(obs.lane, obs.z);
      const ow = 75 * p.scale;

      if (obs.type === 'train') {
        const th = 110 * p.scale;
        ctx.fillStyle = '#c0392b';
        ctx.fillRect(p.x - ow / 2, p.y - th, ow, th);
        ctx.fillStyle = '#e74c3c';
        ctx.fillRect(p.x - ow / 2 + 4, p.y - th + 4, ow - 8, th * 0.35);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(p.x - ow / 2 + 10, p.y - 20 * p.scale, 14 * p.scale, 8 * p.scale);
        ctx.fillRect(p.x + ow / 2 - 24, p.y - 20 * p.scale, 14 * p.scale, 8 * p.scale);
      } else if (obs.type === 'barrier-low') {
        const bh = 32 * p.scale;
        ctx.fillStyle = '#e67e22';
        ctx.fillRect(p.x - ow / 2, p.y - bh, ow, bh);
        ctx.fillStyle = '#fff';
        ctx.fillRect(p.x - ow / 2 + 10, p.y - bh + 6, ow - 20, 6 * p.scale);
      } else if (obs.type === 'barrier-high') {
        const bh = 70 * p.scale;
        ctx.strokeStyle = '#95a5a6';
        ctx.lineWidth = 4 * p.scale;
        ctx.strokeRect(p.x - ow / 2, p.y - bh, ow, bh);
        ctx.fillStyle = '#e74c3c';
        ctx.fillRect(p.x - ow / 2, p.y - bh, ow, 18 * p.scale);
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(7, 10 * p.scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('SLIDE', p.x, p.y - bh + 12 * p.scale);
      }
    });

    const playerBaseY = 530;
    const px = player.currentX;
    const py = playerBaseY + player.yOffset;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(px, playerBaseY, 26, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#2ecc71';
    ctx.fillRect(px - 28, py - 4, 56, 8);
    ctx.fillStyle = '#e74c3c';
    ctx.beginPath();
    ctx.arc(px - 18, py + 5, 4, 0, Math.PI * 2);
    ctx.arc(px + 18, py + 5, 4, 0, Math.PI * 2);
    ctx.fill();

    if (player.isSliding) {
      ctx.fillStyle = '#3498db';
      ctx.fillRect(px - 20, py - 26, 40, 22);
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath();
      ctx.arc(px + 4, py - 28, 10, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(px - 14, py - 28, 28, 24);

      ctx.fillStyle = '#3498db';
      ctx.fillRect(px - 18, py - 58, 36, 32);

      ctx.fillStyle = '#f5cd79';
      ctx.beginPath();
      ctx.arc(px, py - 68, 13, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#e74c3c';
      ctx.beginPath();
      ctx.arc(px, py - 72, 13, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(px, py - 74, 18, 4);
    }

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`🛹 ${Math.floor(distance / 5)}m`, 20, 40);
    ctx.fillStyle = '#ffd32a';
    ctx.fillText(`🪙 ${coinsCount}`, 20, 70);

    if (!started) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      roundRect(ctx, W / 2 - 160, H / 2 - 30, 320, 70, 14);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Arrows / WASD to Move & Jump!', W / 2, H / 2 + 2);
      ctx.font = '13px "Segoe UI", sans-serif';
      ctx.fillStyle = '#8899aa';
      ctx.fillText('Down Arrow to Slide under barriers', W / 2, H / 2 + 24);
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

// ============================================================
//  GAME 4: GARTIC PHONE (Online Multiplayer Drawing & Guessing)
// ============================================================
let garticDrawingColor = '#000000';
let garticBrushSize = 4;
let isDrawingGartic = false;
let garticLastX = 0;
let garticLastY = 0;

function openGarticPhone() {
  stopActiveGame();
  currentGame = 'gartic';

  document.getElementById('arcade-menu').classList.add('hidden');
  document.getElementById('game-area').classList.add('hidden');
  document.getElementById('gartic-area').classList.remove('hidden');

  socket.emit('gartic-join', { roomId: 'main' }, (res) => {
    if (res && res.success) {
      renderGarticView(res.room);
    }
  });
}

document.getElementById('gartic-back-btn').addEventListener('click', () => {
  socket.emit('gartic-leave', { roomId: 'main' });
  document.getElementById('gartic-area').classList.add('hidden');
  document.getElementById('arcade-menu').classList.remove('hidden');
});

const garticCanvas = document.getElementById('gartic-draw-canvas');
const gCtx = garticCanvas.getContext('2d');

function initGarticCanvas() {
  gCtx.fillStyle = '#ffffff';
  gCtx.fillRect(0, 0, garticCanvas.width, garticCanvas.height);
}
initGarticCanvas();

function getGarticCanvasPos(e) {
  const rect = garticCanvas.getBoundingClientRect();
  const scaleX = garticCanvas.width / rect.width;
  const scaleY = garticCanvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

garticCanvas.addEventListener('mousedown', (e) => {
  isDrawingGartic = true;
  const pos = getGarticCanvasPos(e);
  garticLastX = pos.x;
  garticLastY = pos.y;
});

garticCanvas.addEventListener('mousemove', (e) => {
  if (!isDrawingGartic) return;
  const pos = getGarticCanvasPos(e);
  gCtx.strokeStyle = garticDrawingColor;
  gCtx.lineWidth = garticBrushSize;
  gCtx.lineCap = 'round';
  gCtx.lineJoin = 'round';
  gCtx.beginPath();
  gCtx.moveTo(garticLastX, garticLastY);
  gCtx.lineTo(pos.x, pos.y);
  gCtx.stroke();
  garticLastX = pos.x;
  garticLastY = pos.y;
});

window.addEventListener('mouseup', () => {
  isDrawingGartic = false;
});

garticCanvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  isDrawingGartic = true;
  const pos = getGarticCanvasPos(e);
  garticLastX = pos.x;
  garticLastY = pos.y;
}, { passive: false });

garticCanvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!isDrawingGartic) return;
  const pos = getGarticCanvasPos(e);
  gCtx.strokeStyle = garticDrawingColor;
  gCtx.lineWidth = garticBrushSize;
  gCtx.lineCap = 'round';
  gCtx.lineJoin = 'round';
  gCtx.beginPath();
  gCtx.moveTo(garticLastX, garticLastY);
  gCtx.lineTo(pos.x, pos.y);
  gCtx.stroke();
  garticLastX = pos.x;
  garticLastY = pos.y;
}, { passive: false });

garticCanvas.addEventListener('touchend', () => {
  isDrawingGartic = false;
});

document.querySelectorAll('#draw-palette .color-dot').forEach(dot => {
  dot.addEventListener('click', () => {
    document.querySelectorAll('#draw-palette .color-dot').forEach(d => d.classList.remove('active'));
    dot.classList.add('active');
    garticDrawingColor = dot.dataset.color;
  });
});

document.querySelectorAll('.brush-sizes .size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.brush-sizes .size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    garticBrushSize = parseInt(btn.dataset.size, 10);
  });
});

document.getElementById('draw-clear-btn').addEventListener('click', initGarticCanvas);

document.getElementById('gartic-start-btn').addEventListener('click', () => {
  socket.emit('gartic-start', { roomId: 'main' });
});

// Prompt input (Enter key supported)
const promptInput = document.getElementById('gartic-prompt-input');
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    document.getElementById('gartic-prompt-submit').click();
  }
});

document.getElementById('gartic-prompt-submit').addEventListener('click', () => {
  const text = promptInput.value.trim();
  if (!text) { alert('Write a funny sentence first!'); return; }
  socket.emit('gartic-submit', { roomId: 'main', content: text });
  document.getElementById('gartic-prompt-status').textContent = '✅ Submitted! Waiting for other friends...';
  document.getElementById('gartic-prompt-submit').disabled = true;
});

// Submit Drawing
document.getElementById('gartic-draw-submit').addEventListener('click', () => {
  const dataUrl = garticCanvas.toDataURL('image/png');
  socket.emit('gartic-submit', { roomId: 'main', content: dataUrl });
  document.getElementById('gartic-draw-status').textContent = '✅ Drawing submitted! Waiting for friends...';
  document.getElementById('gartic-draw-submit').disabled = true;
});

// Guess input (Enter key supported)
const guessInput = document.getElementById('gartic-guess-input');
guessInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    document.getElementById('gartic-guess-submit').click();
  }
});

document.getElementById('gartic-guess-submit').addEventListener('click', () => {
  const text = guessInput.value.trim();
  if (!text) { alert('Type your guess first!'); return; }
  socket.emit('gartic-submit', { roomId: 'main', content: text });
  document.getElementById('gartic-guess-status').textContent = '✅ Guess submitted! Waiting for friends...';
  document.getElementById('gartic-guess-submit').disabled = true;
});

// Play Again
document.getElementById('gartic-album-play-again').addEventListener('click', () => {
  socket.emit('gartic-reset-lobby', { roomId: 'main' });
});

// Share Album to Chat
document.getElementById('gartic-album-share-chat').addEventListener('click', () => {
  if (!currentGarticBooks) return;

  socket.emit('get-rooms', (rooms) => {
    if (!rooms || rooms.length === 0) {
      alert('You have no chat rooms to share to! Create a chat room first.');
      return;
    }

    let roomNames = rooms.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
    let pick = prompt(`Select a chat room to share this album to:\n${roomNames}\n(Enter room number 1-${rooms.length}):`, '1');
    if (!pick) return;

    let idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= rooms.length) {
      alert('Invalid room selection.');
      return;
    }

    const targetRoom = rooms[idx];

    // Share summary text and all drawings
    Object.keys(currentGarticBooks).forEach((author) => {
      const chain = currentGarticBooks[author];
      let summaryText = `🎨 [Gartic Phone Album] ${author}'s Story:\n`;
      chain.forEach((step, stepIdx) => {
        if (step.type === 'prompt') {
          summaryText += `1. 💬 ${step.author} wrote: "${step.content}"\n`;
        } else if (step.type === 'guess') {
          summaryText += `${stepIdx + 1}. 💬 ${step.author} guessed: "${step.content}"\n`;
        } else if (step.type === 'drawing') {
          summaryText += `${stepIdx + 1}. 🎨 ${step.author} drew a picture\n`;
        }
      });

      socket.emit('send-message', { roomId: targetRoom.id, text: summaryText, image: null });

      // Send each drawing so everyone in chat can see it!
      chain.forEach(step => {
        if (step.type === 'drawing' && step.content) {
          socket.emit('send-message', {
            roomId: targetRoom.id,
            text: `🎨 ${step.author}'s Drawing:`,
            image: step.content
          });
        }
      });
    });

    alert(`✅ Gartic Phone Album successfully shared to "${targetRoom.name}"!`);
  });
});

// Save Gartic Phone Album to Gallery
const garticSaveGalleryBtn = document.getElementById('gartic-album-save-gallery');
if (garticSaveGalleryBtn) {
  garticSaveGalleryBtn.addEventListener('click', () => {
    if (!currentGarticBooks) {
      alert('No album data found to save.');
      return;
    }

    socket.emit('get-gallery', (sections) => {
      if (!sections || sections.length === 0) {
        alert('No gallery sections exist yet! Ask bang to create a section first.');
        return;
      }

      let secOptions = sections.map((s, idx) => `${idx + 1}. ${s.name}`).join('\n');
      let pick = prompt(`Select a Gallery section to save the drawings to:\n${secOptions}\n(Enter section number 1-${sections.length}):`, '1');
      if (!pick) return;

      let idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sections.length) {
        alert('Invalid section selection.');
        return;
      }

      const targetSec = sections[idx];
      let uploadCount = 0;

      Object.keys(currentGarticBooks).forEach(author => {
        const chain = currentGarticBooks[author];
        chain.forEach((step) => {
          if (step.type === 'drawing' && step.content) {
            uploadCount++;
            socket.emit('upload-gallery-photo', {
              sectionId: targetSec.id,
              image: step.content,
              caption: `🎨 ${step.author}'s drawing from ${author}'s story`
            });
          }
        });
      });

      if (uploadCount > 0) {
        alert(`🖼️ Saved ${uploadCount} drawings to Gallery section "${targetSec.name}"!`);
      } else {
        alert('No drawings found in this album to save.');
      }
    });
  });
}

socket.on('gartic-state', (state) => {
  if (currentGame === 'gartic') {
    renderGarticView(state);
  }
});

function renderGarticView(state) {
  const lobbyView = document.getElementById('gartic-lobby');
  const promptView = document.getElementById('gartic-prompt-phase');
  const drawView = document.getElementById('gartic-draw-phase');
  const guessView = document.getElementById('gartic-guess-phase');
  const albumView = document.getElementById('gartic-album-phase');
  const timerBadge = document.getElementById('gartic-timer');

  timerBadge.textContent = `⏱️ ${state.timer}s`;

  // Detect round/phase changes to reset inputs and drawing canvas
  const isNewPhase = (state.status !== lastGarticStatus || state.round !== lastGarticRound);
  lastGarticStatus = state.status;
  lastGarticRound = state.round;

  [lobbyView, promptView, drawView, guessView, albumView].forEach(v => v.classList.add('hidden'));

  if (state.status === 'lobby') {
    lobbyView.classList.remove('hidden');
    document.getElementById('gartic-player-count').textContent = state.players.length;
    const pList = document.getElementById('gartic-player-list');
    pList.innerHTML = '';
    state.players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p}${p === state.host ? ' (Host 👑)' : ''}${p === myUsername ? ' (You)' : ''}`;
      pList.appendChild(li);
    });

    const isHost = state.host === myUsername;
    const startBtn = document.getElementById('gartic-start-btn');
    const hintText = document.getElementById('gartic-lobby-hint');
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = state.players.length < 2;
      hintText.textContent = state.players.length < 2 ? 'Need at least 2 players to start.' : 'Click to start!';
    } else {
      startBtn.classList.add('hidden');
      hintText.textContent = `Waiting for ${state.host} to start the game...`;
    }
  } else if (state.status === 'prompt') {
    promptView.classList.remove('hidden');
    if (isNewPhase) {
      promptInput.value = '';
      document.getElementById('gartic-prompt-submit').disabled = false;
      document.getElementById('gartic-prompt-status').textContent = '';
    }
  } else if (state.status === 'draw') {
    drawView.classList.remove('hidden');
    const taskText = state.myAssignment && state.myAssignment.itemToProcess ? state.myAssignment.itemToProcess.content : 'Something funny';
    document.getElementById('gartic-draw-task').textContent = `"${taskText}"`;

    // Reset to a brand new blank white paper for every drawing phase!
    if (isNewPhase) {
      initGarticCanvas();
      document.getElementById('gartic-draw-submit').disabled = false;
      document.getElementById('gartic-draw-status').textContent = '';
    }
  } else if (state.status === 'guess') {
    guessView.classList.remove('hidden');
    const drawingSrc = state.myAssignment && state.myAssignment.itemToProcess ? state.myAssignment.itemToProcess.content : '';
    document.getElementById('gartic-guess-img').src = drawingSrc;
    if (isNewPhase) {
      guessInput.value = '';
      document.getElementById('gartic-guess-submit').disabled = false;
      document.getElementById('gartic-guess-status').textContent = '';
    }
  } else if (state.status === 'album') {
    albumView.classList.remove('hidden');
    currentGarticBooks = state.album;
    renderGarticAlbum(state.album);
  }
}

// Render all stacked drawings and prompts from the game in order
function renderGarticAlbum(books) {
  const container = document.getElementById('gartic-album-container');
  container.innerHTML = '';
  if (!books) return;

  Object.keys(books).forEach(author => {
    const chain = books[author];
    const card = document.createElement('div');
    card.className = 'album-chain-card';

    let stepsHtml = '';
    chain.forEach((step, idx) => {
      if (step.type === 'drawing') {
        stepsHtml += `
          <div class="album-step">
            <div class="album-author">🎨 ${escHtml(step.author)} drew:</div>
            <img class="album-img" src="${step.content}" alt="Drawing" />
          </div>
        `;
      } else {
        const label = idx === 0 ? 'Original Prompt' : `Guess #${Math.floor(idx / 2) + 1}`;
        stepsHtml += `
          <div class="album-step">
            <div class="album-author">💬 ${escHtml(step.author)} (${label}):</div>
            <div class="album-text">"${escHtml(step.content)}"</div>
          </div>
        `;
      }
    });

    card.innerHTML = `
      <div class="album-chain-header">📖 ${escHtml(author)}'s Book Chain</div>
      ${stepsHtml}
    `;
    container.appendChild(card);
  });
}

// Utility
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

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
