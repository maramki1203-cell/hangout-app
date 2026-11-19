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
const io = new Server(server);

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
const activeCalls = {};      // callId -> { id, caller, participants[], offers }
const onlineUsers = {};      // username -> socket.id
let nextRoomId = 1;
let nextCallId = 1;

// Serve static files from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

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
    // Notify all members
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

  // ---------- Chat: send message ----------
  socket.on('send-message', ({ roomId, text }) => {
    if (!currentUser) return;
    const room = chatRooms.find(r => r.id === roomId);
    if (!room || !room.members.includes(currentUser)) return;

    const msg = {
      sender: currentUser,
      text,
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
    if (!call) { callback({ success: false }); return; }
    if (!call.peers.includes(currentUser)) {
      call.peers.push(currentUser);
    }
    // Notify existing peers so they can create offers
    call.peers.forEach(p => {
      if (p !== currentUser && onlineUsers[p]) {
        io.to(onlineUsers[p]).emit('peer-joined', { callId, username: currentUser });
      }
    });
    callback({ success: true, peers: call.peers.filter(p => p !== currentUser) });
  });

  // ---------- Calls: leave ----------
  socket.on('leave-call', ({ callId }) => {
    if (!currentUser) return;
    const call = activeCalls[callId];
    if (!call) return;
    call.peers = call.peers.filter(p => p !== currentUser);

    // Notify remaining peers
    call.peers.forEach(p => {
      if (onlineUsers[p]) {
        io.to(onlineUsers[p]).emit('peer-left', { callId, username: currentUser });
      }
    });

    // If no one left, end the call
    if (call.peers.length === 0) {
      callHistory.push({
        id: call.id,
        caller: call.caller,
        participants: call.participants,
        startedAt: call.startedAt,
        endedAt: Date.now(),
      });
      delete activeCalls[callId];
    }
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

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    if (currentUser) {
      delete onlineUsers[currentUser];
      io.emit('online-users', Object.keys(onlineUsers));

      // Leave any active calls
      Object.keys(activeCalls).forEach(callId => {
        const call = activeCalls[callId];
        if (call.peers.includes(currentUser)) {
          call.peers = call.peers.filter(p => p !== currentUser);
          call.peers.forEach(p => {
            if (onlineUsers[p]) {
              io.to(onlineUsers[p]).emit('peer-left', { callId, username: currentUser });
            }
          });
          if (call.peers.length === 0) {
            callHistory.push({
              id: call.id, caller: call.caller,
              participants: call.participants,
              startedAt: call.startedAt, endedAt: Date.now(),
            });
            delete activeCalls[callId];
          }
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
