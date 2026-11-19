// ============================================================
//  HANGOUT APP - Server
//  Run with: node server.js
//  Then open http://localhost:3000 in your browser
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Allow up to 10MB payloads for sending images in chat and drawings
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
//  In-memory data stores
// ============================================================
const chatRooms = [];        // { id, name, members[], messages[] }
const callHistory = [];      // { id, caller, participants[], startedAt, endedAt }
const activeCalls = {};      // callId -> { id, caller, participants[], peers[] }
const onlineUsers = {};      // username -> socket.id
let nextRoomId = 1;
let nextCallId = 1;

// Leaderboard store for top 5 scores
const leaderboards = {
  apple: [
    { username: 'bang', score: 38, date: Date.now() - 3600000 },
    { username: '시로', score: 27, date: Date.now() - 7200000 },
  ],
  flappy: [
    { username: 'bang', score: 12, date: Date.now() - 3600000 },
    { username: '미티', score: 8, date: Date.now() - 7200000 },
  ],
  runner: [
    { username: 'bang', score: 450, date: Date.now() - 3600000 },
    { username: '즤', score: 320, date: Date.now() - 7200000 },
  ],
};

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

  // If 1 or 0 peers left, end the call automatically!
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
  } else {
    // Notify remaining peers
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

      // Tell everyone the updated online list
      io.emit('online-users', Object.keys(onlineUsers));
      io.emit('all-users', Object.keys(USERS));
    } else {
      callback({ success: false, message: 'Wrong username or password.' });
    }
  });

  // ---------- Get all registered usernames ----------
  socket.on('get-all-users', (callback) => {
    callback(Object.keys(USERS));
  });

  // ---------- Leaderboards ----------
  socket.on('get-leaderboards', (callback) => {
    callback(leaderboards);
  });

  socket.on('submit-score', ({ game, score }) => {
    if (!currentUser || !leaderboards[game] || typeof score !== 'number') return;
    const list = leaderboards[game];

    // Find if user already has a score in this game
    const existingIndex = list.findIndex(item => item.username === currentUser);
    if (existingIndex !== -1) {
      if (score > list[existingIndex].score) {
        list[existingIndex].score = score;
        list[existingIndex].date = Date.now();
      }
    } else {
      list.push({ username: currentUser, score, date: Date.now() });
    }

    // Sort descending and keep top 5
    list.sort((a, b) => b.score - a.score);
    if (list.length > 5) list.length = 5;

    io.emit('leaderboard-updated', { game, list });
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

    // Send to all online members of this room
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

    // Notify invited participants
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

    // Tell all existing peers in the call that a new peer joined.
    // Existing peers will initiate the WebRTC offer to this newcomer.
    existingPeers.forEach(p => {
      if (p !== currentUser && onlineUsers[p]) {
        io.to(onlineUsers[p]).emit('peer-joined', { callId, username: currentUser });
      }
    });

    // The newcomer returns existing peers, but DOES NOT initiate offers.
    // This strictly prevents offer glare / collision!
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
  //  GARTIC PHONE (Online Drawing & Guessing Telephone Game)
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
        // Send customized assignment per player
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
    if (room.players.length < 2) return; // Need at least 2 players

    // Initialize game
    room.status = 'prompt';
    room.round = 1;
    // Total rounds: each player creates a prompt, then draw/guess alternates for N rounds
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

    // If all online players in the room submitted, advance immediately!
    const allSubmitted = room.players.every(p => room.submissions[p] !== undefined);
    if (allSubmitted) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      advanceGarticRound(room);
    }
  });

  function advanceGarticRound(room) {
    const N = room.players.length;

    // Save submissions into corresponding player books
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

    // Check if game is finished
    if (room.round >= room.totalRounds) {
      room.status = 'album';
      room.round = room.totalRounds;
      if (room.timerInterval) clearInterval(room.timerInterval);
      broadcastGarticState(room.id);
      return;
    }

    // Determine next phase: alternates draw <-> guess
    room.round++;
    const isDrawRound = (room.round % 2 === 0);
    room.status = isDrawRound ? 'draw' : 'guess';

    // Shift books cyclically to next player:
    // Player i receives book of player (i - shift) % N
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

      // Leave any active calls
      Object.keys(activeCalls).forEach(callId => {
        const call = activeCalls[callId];
        if (call.peers.includes(currentUser)) {
          handlePeerLeaveCall(callId, currentUser);
        }
      });

      // Leave any Gartic rooms
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
