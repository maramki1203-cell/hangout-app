// ============================================================
//  HANGOUT APP - Server
//  Run with: node server.js
//  Then open http://localhost:3000 in your browser
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Allow up to 10MB payloads for sending images in chat and gallery
const io = new Server(server, {
  maxHttpBufferSize: 1e7
});

// ============================================================
//  🔑 HARDCODED USERS — EDIT HERE TO ADD/REMOVE ACCOUNTS
//     Format:  'username': 'password'
//     Note: Korean IDs are 100% supported! (e.g. '방': 'ram1203')
// ============================================================
const USERS = {
  'bang': 'ram1203',
  '시로': 'pw1234',
  '미티': 'pw1234',
  '즤':   'pw1234',
};

// ============================================================
//  PERSISTENT DATA STORAGE (Saves to data.json so chats,
//  leaderboards, and gallery NEVER evaporate on restarts/updates!)
// ============================================================
const DATA_FILE = path.join(__dirname, 'data.json');

let chatRooms = [
  {
    id: 1,
    name: 'General Hangout 💬',
    members: ['bang', '시로', '미티', '즤'],
    messages: [],
    createdAt: Date.now(),
    lastActivity: Date.now()
  }
];
let callHistory = [];
let leaderboards = {
  apple: [],
  flappy: [],
  runner: [],
};
let gallerySections = [
  {
    id: 1,
    name: 'Hangout Memories 📸',
    createdBy: 'bang',
    createdAt: Date.now() - 86400000,
    photos: []
  },
  {
    id: 2,
    name: 'Funny Moments 😂',
    createdBy: 'bang',
    createdAt: Date.now() - 43200000,
    photos: []
  }
];
let nextRoomId = 2;
let nextCallId = 1;
let nextSectionId = 3;
let nextPhotoId = 1;

function loadPersistentData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.chatRooms)) chatRooms = parsed.chatRooms;
      if (Array.isArray(parsed.callHistory)) callHistory = parsed.callHistory;
      if (parsed.leaderboards && typeof parsed.leaderboards === 'object') leaderboards = parsed.leaderboards;
      if (Array.isArray(parsed.gallerySections)) gallerySections = parsed.gallerySections;
      if (parsed.nextRoomId) nextRoomId = parsed.nextRoomId;
      if (parsed.nextCallId) nextCallId = parsed.nextCallId;
      if (parsed.nextSectionId) nextSectionId = parsed.nextSectionId;
      if (parsed.nextPhotoId) nextPhotoId = parsed.nextPhotoId;
      console.log('📦 Loaded persistent data successfully from data.json');
    } else {
      savePersistentData();
    }
  } catch (err) {
    console.error('Error loading data.json:', err);
  }
}

function savePersistentData() {
  try {
    const payload = {
      chatRooms,
      callHistory,
      leaderboards,
      gallerySections,
      nextRoomId,
      nextCallId,
      nextSectionId,
      nextPhotoId,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving data.json:', err);
  }
}

loadPersistentData();

// In-memory runtime connection state
const activeCalls = {};      // callId -> { id, caller, participants[], peers[] }
const onlineUsers = {};      // username -> socket.id

// ============================================================
//  Gartic Phone Game Rooms
// ============================================================
const garticRooms = {
  'main': {
    id: 'main',
    name: 'Main Hangout Room',
    players: [],       // [ username, ... ]
    host: null,
    status: 'lobby',   // 'lobby' | 'prompt' | 'draw' | 'guess' | 'album'
    round: 0,
    totalRounds: 0,
    timer: 0,
    timerInterval: null,
    books: {},         // username -> [ { type: 'prompt'|'drawing', author, content } ]
    assignments: {},   // username -> { targetAuthor, itemToProcess }
    submissions: {},   // username -> submission content
    albumIndex: 0,
  }
};

// Serve static files from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  Helper: Call leave and auto-end when <= 1 peer
// ============================================================
function handlePeerLeaveCall(callId, username) {
  const call = activeCalls[callId];
  if (!call) return;

  call.peers = call.peers.filter(p => p !== username);

  if (call.peers.length <= 1) {
    if (call.peers.length === 1) {
      const lonePeer = call.peers[0];
      if (onlineUsers[lonePeer]) {
        io.to(onlineUsers[lonePeer]).emit('call-ended-auto', {
          callId,
          reason: 'alone',
          message: 'Everyone else has left the call. Call ended.'
        });
      }
    }
    callHistory.push({
      id: call.id,
      caller: call.caller,
      participants: call.participants,
      startedAt: call.startedAt,
      endedAt: Date.now(),
    });
    delete activeCalls[callId];
    savePersistentData();
  } else {
    call.peers.forEach(p => {
      if (onlineUsers[p]) {
        io.to(onlineUsers[p]).emit('peer-left', { callId, username });
      }
    });
  }
}

// ============================================================
//  Socket.IO — real-time events
// ============================================================
io.on('connection', (socket) => {
  let currentUser = null;

  // ---------- Authentication ----------
  socket.on('login', ({ username, password }, callback) => {
    if (USERS[username] && USERS[username] === password) {
      currentUser = username;
      onlineUsers[username] = socket.id;
      callback({ success: true, username });

      io.emit('online-users', Object.keys(onlineUsers));
      io.emit('all-users', Object.keys(USERS));
    } else {
      callback({ success: false, message: 'Wrong username or password.' });
    }
  });

  socket.on('get-all-users', (callback) => {
    callback(Object.keys(USERS));
  });

  // ---------- Leaderboards ----------
  socket.on('get-leaderboards', (callback) => {
    callback(leaderboards);
  });

  socket.on('submit-score', ({ game, score }, callback) => {
    if (!currentUser || !leaderboards[game] || typeof score !== 'number' || score <= 0) {
      if (callback) callback({ success: false, rank: null, score: score || 0 });
      return;
    }
    const list = leaderboards[game];

    // Find if user already has a score in this game
    const existingIndex = list.findIndex(item => item.username === currentUser);
    let isBetter = false;
    if (existingIndex !== -1) {
      if (score > list[existingIndex].score) {
        list[existingIndex].score = score;
        list[existingIndex].date = Date.now();
        isBetter = true;
      }
    } else {
      list.push({ username: currentUser, score, date: Date.now() });
      isBetter = true;
    }

    // Sort descending and keep top 5
    list.sort((a, b) => b.score - a.score);
    if (list.length > 5) list.length = 5;

    savePersistentData();
    io.emit('leaderboard-updated', { game, list });

    // Calculate actual rank in top 5
    const myRankIdx = list.findIndex(item => item.username === currentUser && item.score === score);
    const myRank = (myRankIdx !== -1) ? myRankIdx + 1 : null;

    if (callback) {
      callback({
        success: true,
        rank: myRank,
        isNewRecord: isBetter,
        topScore: list[0] ? list[0].score : score,
        score
      });
    }
  });

  // ---------- Gallery (Sections & Photos) ----------
  socket.on('get-gallery', (callback) => {
    callback(gallerySections);
  });

  // Only "bang" can create new sections!
  socket.on('create-gallery-section', ({ name }, callback) => {
    if (currentUser !== 'bang') {
      return callback({ success: false, message: 'Only bang can create new sections!' });
    }
    const cleanName = (name || '').trim();
    if (!cleanName) {
      return callback({ success: false, message: 'Section name cannot be empty.' });
    }
    const newSection = {
      id: nextSectionId++,
      name: cleanName,
      createdBy: currentUser,
      createdAt: Date.now(),
      photos: []
    };
    gallerySections.push(newSection);
    savePersistentData();
    io.emit('gallery-updated', gallerySections);
    callback({ success: true, section: newSection });
  });

  // Only "bang" can delete sections!
  socket.on('delete-gallery-section', ({ sectionId }, callback) => {
    if (currentUser !== 'bang') {
      if (callback) callback({ success: false, message: 'Only bang can delete sections!' });
      return;
    }
    gallerySections = gallerySections.filter(s => s.id !== sectionId);
    savePersistentData();
    io.emit('gallery-updated', gallerySections);
    if (callback) callback({ success: true });
  });

  // Only "bang" can rename sections!
  socket.on('rename-gallery-section', ({ sectionId, newName }, callback) => {
    if (currentUser !== 'bang') {
      if (callback) callback({ success: false, message: 'Only bang can rename sections!' });
      return;
    }
    const cleanName = (newName || '').trim();
    if (!cleanName) {
      if (callback) callback({ success: false, message: 'Section name cannot be empty.' });
      return;
    }
    const sec = gallerySections.find(s => s.id === sectionId);
    if (!sec) {
      if (callback) callback({ success: false, message: 'Section not found.' });
      return;
    }
    sec.name = cleanName;
    savePersistentData();
    io.emit('gallery-updated', gallerySections);
    if (callback) callback({ success: true, section: sec });
  });

  // Anyone logged in can upload photos into existing sections!
  socket.on('upload-gallery-photo', ({ sectionId, image, caption }, callback) => {
    if (!currentUser || !image) {
      return callback({ success: false, message: 'Missing user or image.' });
    }
    const sec = gallerySections.find(s => s.id === sectionId);
    if (!sec) {
      return callback({ success: false, message: 'Section not found.' });
    }
    const photo = {
      id: nextPhotoId++,
      url: image,
      caption: caption || '',
      uploader: currentUser,
      timestamp: Date.now()
    };
    sec.photos.unshift(photo);
    savePersistentData();
    io.emit('gallery-updated', gallerySections);
    callback({ success: true, photo });
  });

  // Delete photo (uploader or "bang" can delete)
  socket.on('delete-gallery-photo', ({ sectionId, photoId }, callback) => {
    if (!currentUser) return;
    const sec = gallerySections.find(s => s.id === sectionId);
    if (!sec) return callback({ success: false });

    const photo = sec.photos.find(p => p.id === photoId);
    if (!photo) return callback({ success: false });

    if (currentUser === 'bang' || photo.uploader === currentUser) {
      sec.photos = sec.photos.filter(p => p.id !== photoId);
      savePersistentData();
      io.emit('gallery-updated', gallerySections);
      callback({ success: true });
    } else {
      callback({ success: false, message: 'Permission denied.' });
    }
  });

  // ---------- Chat: get rooms ----------
  socket.on('get-rooms', (callback) => {
    if (!currentUser) return;
    const myRooms = chatRooms
      .filter(r => r.members.includes(currentUser))
      .map(r => ({
        id: r.id,
        name: r.name,
        members: r.members,
        lastMessage: r.messages.length > 0 ? r.messages[r.messages.length - 1] : null,
        lastActivity: r.lastActivity || r.createdAt,
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    callback(myRooms);
  });

  // ---------- Chat: create room ----------
  socket.on('create-room', ({ name, members }, callback) => {
    if (!currentUser) return;
    if (!members.includes(currentUser)) members.push(currentUser);
    const room = {
      id: nextRoomId++,
      name,
      members,
      messages: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    chatRooms.push(room);
    savePersistentData();

    members.forEach(m => {
      if (onlineUsers[m]) {
        io.to(onlineUsers[m]).emit('room-created', {
          id: room.id, name: room.name, members: room.members,
          lastMessage: null, lastActivity: room.lastActivity,
        });
      }
    });
    callback({ success: true, roomId: room.id });
  });

  // ---------- Chat: rename room ----------
  socket.on('rename-room', ({ roomId, newName }, callback) => {
    if (!currentUser) return;
    const cleanName = (newName || '').trim();
    if (!cleanName) {
      if (callback) callback({ success: false, message: 'Room name cannot be empty.' });
      return;
    }
    const room = chatRooms.find(r => r.id === roomId);
    if (!room || (!room.members.includes(currentUser) && currentUser !== 'bang')) {
      if (callback) callback({ success: false, message: 'Unauthorized or room not found.' });
      return;
    }
    room.name = cleanName;
    savePersistentData();

    room.members.forEach(m => {
      if (onlineUsers[m]) {
        io.to(onlineUsers[m]).emit('room-renamed', { roomId: room.id, newName: room.name });
      }
    });
    if (callback) callback({ success: true, room: { id: room.id, name: room.name } });
  });

  // ---------- Chat: delete room ----------
  socket.on('delete-room', ({ roomId }, callback) => {
    if (!currentUser) return;
    const roomIndex = chatRooms.findIndex(r => r.id === roomId);
    if (roomIndex === -1) {
      if (callback) callback({ success: false, message: 'Room not found.' });
      return;
    }
    const room = chatRooms[roomIndex];
    if (!room.members.includes(currentUser) && currentUser !== 'bang') {
      if (callback) callback({ success: false, message: 'Unauthorized to delete this room.' });
      return;
    }
    const members = [...room.members];
    chatRooms.splice(roomIndex, 1);
    savePersistentData();

    members.forEach(m => {
      if (onlineUsers[m]) {
        io.to(onlineUsers[m]).emit('room-deleted', { roomId });
      }
    });
    if (callback) callback({ success: true });
  });

  // ---------- Chat: get messages ----------
  socket.on('get-messages', ({ roomId }, callback) => {
    if (!currentUser) return;
    const room = chatRooms.find(r => r.id === roomId);
    if (room && room.members.includes(currentUser)) {
      callback(room.messages);
    } else {
      callback([]);
    }
  });

  // ---------- Chat: send message (with Image support!) ----------
  socket.on('send-message', ({ roomId, text, image }) => {
    if (!currentUser) return;
    const room = chatRooms.find(r => r.id === roomId);
    if (!room || !room.members.includes(currentUser)) return;
    if (!text && !image) return;

    const msg = {
      sender: currentUser,
      text: text || '',
      image: image || null,
      timestamp: Date.now(),
    };
    room.messages.push(msg);
    room.lastActivity = Date.now();
    savePersistentData();

    room.members.forEach(m => {
      if (onlineUsers[m]) {
        io.to(onlineUsers[m]).emit('new-message', { roomId, message: msg });
      }
    });
  });

  // ---------- Calls: get history ----------
  socket.on('get-call-history', (callback) => {
    if (!currentUser) return;
    const my = callHistory
      .filter(c => c.participants.includes(currentUser) || c.caller === currentUser)
      .sort((a, b) => b.startedAt - a.startedAt);
    callback(my);
  });

  // ---------- Calls: start a call ----------
  socket.on('start-call', ({ participants }, callback) => {
    if (!currentUser) return;
    if (!participants.includes(currentUser)) participants.push(currentUser);

    const callId = 'call-' + (nextCallId++);
    activeCalls[callId] = {
      id: callId,
      caller: currentUser,
      participants,
      peers: [currentUser],
      startedAt: Date.now(),
    };

    // Notify invited participants with custom alert
    participants.forEach(p => {
      if (p !== currentUser && onlineUsers[p]) {
        io.to(onlineUsers[p]).emit('incoming-call', {
          callId,
          caller: currentUser,
          participants,
        });
      }
    });

    callback({ success: true, callId });
  });

  // ---------- Calls: join ----------
  socket.on('join-call', ({ callId }, callback) => {
    if (!currentUser) return;
    const call = activeCalls[callId];
    if (!call) { callback({ success: false, message: 'Call no longer active.' }); return; }

    const existingPeers = [...call.peers];
    if (!call.peers.includes(currentUser)) {
      call.peers.push(currentUser);
    }

    existingPeers.forEach(p => {
      if (p !== currentUser && onlineUsers[p]) {
        io.to(onlineUsers[p]).emit('peer-joined', { callId, username: currentUser });
      }
    });

    callback({ success: true, peers: existingPeers });
  });

  // ---------- Calls: leave ----------
  socket.on('leave-call', ({ callId }) => {
    if (!currentUser) return;
    handlePeerLeaveCall(callId, currentUser);
  });

  // ---------- WebRTC Signaling ----------
  socket.on('webrtc-offer', ({ callId, to, offer }) => {
    if (onlineUsers[to]) {
      io.to(onlineUsers[to]).emit('webrtc-offer', { callId, from: currentUser, offer });
    }
  });

  socket.on('webrtc-answer', ({ callId, to, answer }) => {
    if (onlineUsers[to]) {
      io.to(onlineUsers[to]).emit('webrtc-answer', { callId, from: currentUser, answer });
    }
  });

  socket.on('webrtc-ice-candidate', ({ callId, to, candidate }) => {
    if (onlineUsers[to]) {
      io.to(onlineUsers[to]).emit('webrtc-ice-candidate', { callId, from: currentUser, candidate });
    }
  });

  // ============================================================
  //  GARTIC PHONE
  // ============================================================
  function getGarticPublicState(room) {
    return {
      id: room.id,
      name: room.name,
      players: room.players,
      host: room.host,
      status: room.status,
      round: room.round,
      totalRounds: room.totalRounds,
      timer: room.timer,
      album: room.status === 'album' ? room.books : null,
      submissionsCount: Object.keys(room.submissions).length,
    };
  }

  function broadcastGarticState(roomId) {
    const room = garticRooms[roomId];
    if (!room) return;
    const pub = getGarticPublicState(room);
    room.players.forEach(p => {
      if (onlineUsers[p]) {
        const assignment = room.assignments[p] || null;
        io.to(onlineUsers[p]).emit('gartic-state', { ...pub, myAssignment: assignment });
      }
    });
  }

  socket.on('gartic-join', ({ roomId = 'main' }, callback) => {
    if (!currentUser) return;
    let room = garticRooms[roomId];
    if (!room) {
      room = garticRooms[roomId] = {
        id: roomId, name: 'Game Room', players: [], host: currentUser,
        status: 'lobby', round: 0, totalRounds: 0, timer: 0,
        timerInterval: null, books: {}, assignments: {}, submissions: {}, albumIndex: 0
      };
    }
    if (!room.players.includes(currentUser)) {
      room.players.push(currentUser);
      if (!room.host) room.host = currentUser;
    }
    callback({ success: true, room: getGarticPublicState(room) });
    broadcastGarticState(roomId);
  });

  socket.on('gartic-leave', ({ roomId = 'main' }) => {
    if (!currentUser) return;
    const room = garticRooms[roomId];
    if (!room) return;
    room.players = room.players.filter(p => p !== currentUser);
    if (room.host === currentUser) {
      room.host = room.players.length > 0 ? room.players[0] : null;
    }
    if (room.players.length === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      room.status = 'lobby';
    }
    broadcastGarticState(roomId);
  });

  socket.on('gartic-start', ({ roomId = 'main' }) => {
    if (!currentUser) return;
    const room = garticRooms[roomId];
    if (!room || room.host !== currentUser) return;
    if (room.players.length < 2) return;

    room.status = 'prompt';
    room.round = 1;
    room.totalRounds = Math.min(room.players.length * 2, 6);
    room.books = {};
    room.assignments = {};
    room.submissions = {};

    room.players.forEach(p => {
      room.books[p] = [];
      room.assignments[p] = { targetAuthor: p, itemToProcess: null };
    });

    startGarticTimer(room, 50, () => advanceGarticRound(room));
    broadcastGarticState(roomId);
  });

  function startGarticTimer(room, seconds, onExpire) {
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.timer = seconds;
    room.timerInterval = setInterval(() => {
      room.timer--;
      if (room.timer <= 0) {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
        onExpire();
      } else {
        broadcastGarticState(room.id);
      }
    }, 1000);
  }

  socket.on('gartic-submit', ({ roomId = 'main', content }) => {
    if (!currentUser) return;
    const room = garticRooms[roomId];
    if (!room || room.status === 'lobby' || room.status === 'album') return;

    room.submissions[currentUser] = content;
    broadcastGarticState(roomId);

    const allSubmitted = room.players.every(p => room.submissions[p] !== undefined);
    if (allSubmitted) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      advanceGarticRound(room);
    }
  });

  function advanceGarticRound(room) {
    const N = room.players.length;

    room.players.forEach(p => {
      const assignment = room.assignments[p];
      if (assignment) {
        const bookAuthor = assignment.targetAuthor;
        const sub = room.submissions[p] || (room.status === 'draw' ? '' : 'A funny mystery');
        const type = room.status === 'prompt' ? 'prompt' : (room.status === 'draw' ? 'drawing' : 'guess');
        room.books[bookAuthor].push({
          type,
          author: p,
          content: sub,
        });
      }
    });

    room.submissions = {};

    if (room.round >= room.totalRounds) {
      room.status = 'album';
      room.round = room.totalRounds;
      if (room.timerInterval) clearInterval(room.timerInterval);
      broadcastGarticState(room.id);
      return;
    }

    room.round++;
    const isDrawRound = (room.round % 2 === 0);
    room.status = isDrawRound ? 'draw' : 'guess';

    const shift = (room.round - 1) % N;
    room.players.forEach((p, idx) => {
      const targetIdx = (idx - shift + N) % N;
      const targetAuthor = room.players[targetIdx];
      const book = room.books[targetAuthor];
      const lastEntry = book[book.length - 1];
      room.assignments[p] = {
        targetAuthor,
        itemToProcess: lastEntry,
      };
    });

    const timeForRound = isDrawRound ? 70 : 40;
    startGarticTimer(room, timeForRound, () => advanceGarticRound(room));
    broadcastGarticState(room.id);
  }

  socket.on('gartic-reset-lobby', ({ roomId = 'main' }) => {
    if (!currentUser) return;
    const room = garticRooms[roomId];
    if (!room) return;
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.status = 'lobby';
    room.round = 0;
    room.books = {};
    room.assignments = {};
    room.submissions = {};
    broadcastGarticState(roomId);
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    if (currentUser) {
      delete onlineUsers[currentUser];
      io.emit('online-users', Object.keys(onlineUsers));

      Object.keys(activeCalls).forEach(callId => {
        const call = activeCalls[callId];
        if (call.peers.includes(currentUser)) {
          handlePeerLeaveCall(callId, currentUser);
        }
      });

      Object.keys(garticRooms).forEach(roomId => {
        const room = garticRooms[roomId];
        if (room.players.includes(currentUser)) {
          room.players = room.players.filter(p => p !== currentUser);
          if (room.host === currentUser) {
            room.host = room.players.length > 0 ? room.players[0] : null;
          }
          if (room.players.length === 0) {
            if (room.timerInterval) clearInterval(room.timerInterval);
            room.status = 'lobby';
          }
          broadcastGarticState(roomId);
        }
      });
    }
  });
});

// ============================================================
//  Start server
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  Hangout App is running!`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
