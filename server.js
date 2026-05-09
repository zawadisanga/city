const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

// Import services
const mpesaService = require('./services/mpesa.service');
const EncryptionService = require('./services/encryption.service');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ========================================
// DATA STORAGE
// ========================================
const users = new Map();
const activeCalls = new Map();
const platformRevenue = { total: 0, currency: 'USD' };
const transactions = [];

const CALL_RATES = {
  voice: parseFloat(process.env.VOICE_RATE) || 0.01,
  video: parseFloat(process.env.VIDEO_RATE) || 0.03
};

// ========================================
// HELPER FUNCTIONS
// ========================================
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function calculateCost(durationSeconds, callType) {
  const minutes = durationSeconds / 60;
  const rate = CALL_RATES[callType];
  let cost = minutes * rate;
  if (cost < 0.01) cost = 0.01;
  if (cost > 5.00) cost = 5.00;
  return parseFloat(cost.toFixed(4));
}

function broadcastOnlineUsers() {
  const onlineUsers = Array.from(users.values())
    .filter(user => user.isOnline === true)
    .map(user => ({
      userId: user.id,
      username: user.username,
      inCall: user.inCall || false
    }));
  io.emit('online-users', onlineUsers);
}

// ========================================
// API ROUTES
// ========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/rates', (req, res) => {
  res.json(CALL_RATES);
});

app.get('/api/balance/:userId', (req, res) => {
  const user = users.get(req.params.userId);
  res.json({ balance: user ? user.balance : 0, currency: 'USD' });
});

app.post('/api/register', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  let existingUser = Array.from(users.values()).find(u => u.username === username);
  if (existingUser) {
    return res.json({ userId: existingUser.id, username: existingUser.username, balance: existingUser.balance });
  }
  
  const userId = uuidv4();
  users.set(userId, {
    id: userId, username, balance: 0.10, isOnline: false, inCall: false,
    currentCallId: null, socketId: null, lastSeen: new Date(), createdAt: new Date()
  });
  
  res.json({ userId, username, balance: 0.10, message: 'Welcome! You have $0.10 free credit.' });
});

// M-Pesa Payment Initiation
app.post('/api/mpesa/deposit', async (req, res) => {
  const { userId, amount, phoneNumber } = req.body;
  
  if (!userId || !amount || amount < 1) {
    return res.status(400).json({ error: 'Invalid request. Minimum $1.00' });
  }
  
  if (!phoneNumber || !phoneNumber.match(/^[0-9]{10,14}$/)) {
    return res.status(400).json({ error: 'Valid phone number required' });
  }
  
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  // Format phone number for M-Pesa (remove leading 0, add 255)
  let formattedPhone = phoneNumber;
  if (formattedPhone.startsWith('0')) formattedPhone = '255' + formattedPhone.substring(1);
  if (!formattedPhone.startsWith('255')) formattedPhone = '255' + formattedPhone;
  if (formattedPhone.length < 12) formattedPhone = formattedPhone.padStart(12, '255');
  
  const paymentData = {
    phoneNumber: formattedPhone,
    amount: amount.toString(),
    description: 'ZAS Wallet Deposit',
    conversationId: EncryptionService.generateConversationId(),
    transactionReference: EncryptionService.generateTransactionReference()
  };
  
  console.log(`💰 Processing deposit: User ${user.username}, Amount TZS ${amount}`);
  
  const result = await mpesaService.initiateC2BPayment(paymentData);
  
  if (result.success) {
    // Convert TZS to USD (approximate: 1 USD = 2500 TZS)
    const usdAmount = amount / 2500;
    user.balance = parseFloat((user.balance + usdAmount).toFixed(4));
    users.set(userId, user);
    
    transactions.unshift({
      id: uuidv4(), userId, type: 'deposit', amount: usdAmount, method: 'mpesa',
      transactionId: result.transactionId, timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true, newBalance: user.balance, transactionId: result.transactionId,
      message: `TZS ${amount} added successfully`
    });
  } else {
    res.status(400).json({ success: false, error: result.error || 'Payment failed' });
  }
});

// Get transaction history
app.get('/api/transactions/:userId', (req, res) => {
  const userTx = transactions.filter(tx => tx.userId === req.params.userId);
  res.json({ transactions: userTx });
});

// Platform revenue (admin)
app.get('/api/platform/revenue', (req, res) => {
  res.json({ totalRevenue: platformRevenue.total, totalTransactions: transactions.length });
});

// ========================================
// SOCKET.IO - CALLING
// ========================================
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  let currentUserId = null;
  
  socket.on('user-join', (data) => {
    const { userId, username } = data;
    currentUserId = userId;
    
    let user = users.get(userId);
    if (!user) {
      user = { id: userId, username, balance: 0.10, isOnline: false, inCall: false, currentCallId: null, socketId: null, lastSeen: new Date(), createdAt: new Date() };
      users.set(userId, user);
    }
    
    user.isOnline = true;
    user.socketId = socket.id;
    users.set(userId, user);
    
    socket.emit('user-data', { id: user.id, username: user.username, balance: user.balance });
    broadcastOnlineUsers();
    console.log(`✅ User ${username} online`);
  });
  
  socket.on('call-start', (data) => {
    const { callerId, callerName, calleeId, callType } = data;
    const caller = users.get(callerId);
    const callee = users.get(calleeId);
    
    if (!caller || caller.balance < 0.05) {
      socket.emit('call-error', { error: 'insufficient_balance', message: `Insufficient balance: $${caller?.balance?.toFixed(2) || 0}` });
      return;
    }
    if (!callee || !callee.isOnline) {
      socket.emit('call-error', { error: 'offline', message: 'User is offline' });
      return;
    }
    if (callee.inCall) {
      socket.emit('call-error', { error: 'busy', message: 'User is on another call' });
      return;
    }
    
    const callId = uuidv4();
    activeCalls.set(callId, { id: callId, callerId, callerName, calleeId, callType, status: 'ringing', startTime: new Date(), callerSocket: socket.id, calleeSocket: callee.socketId });
    
    caller.inCall = true;
    caller.currentCallId = callId;
    users.set(callerId, caller);
    
    io.to(callee.socketId).emit('incoming-call', { callId, callerId, callerName, callType, rate: CALL_RATES[callType] });
    socket.emit('call-started', { callId });
    broadcastOnlineUsers();
  });
  
  socket.on('call-accept', (data) => {
    const { callId, calleeId } = data;
    const call = activeCalls.get(callId);
    if (!call) return;
    
    const callee = users.get(calleeId);
    if (callee) { callee.inCall = true; callee.currentCallId = callId; users.set(calleeId, callee); }
    
    call.status = 'connected';
    call.connectedAt = new Date();
    activeCalls.set(callId, call);
    
    io.to(call.callerSocket).emit('call-accepted', { callId });
    socket.emit('call-connected', { callId });
    broadcastOnlineUsers();
  });
  
  socket.on('call-reject', (data) => {
    const { callId } = data;
    const call = activeCalls.get(callId);
    if (call) { io.to(call.callerSocket).emit('call-rejected', { callId }); cleanupCall(callId); }
  });
  
  // WebRTC Signaling
  socket.on('offer', (data) => {
    const { targetUserId, callId, sdp } = data;
    const target = users.get(targetUserId);
    if (target && target.socketId) io.to(target.socketId).emit('offer', { fromUserId: currentUserId, callId, sdp });
  });
  
  socket.on('answer', (data) => {
    const { targetUserId, callId, sdp } = data;
    const target = users.get(targetUserId);
    if (target && target.socketId) io.to(target.socketId).emit('answer', { fromUserId: currentUserId, callId, sdp });
  });
  
  socket.on('ice-candidate', (data) => {
    const { targetUserId, callId, candidate } = data;
    const target = users.get(targetUserId);
    if (target && target.socketId) io.to(target.socketId).emit('ice-candidate', { fromUserId: currentUserId, callId, candidate });
  });
  
  socket.on('call-end', (data) => {
    const { callId, userId } = data;
    const call = activeCalls.get(callId);
    
    if (call && call.status === 'connected') {
      const durationSeconds = Math.floor((new Date() - call.connectedAt) / 1000);
      const cost = calculateCost(durationSeconds, call.callType);
      
      const caller = users.get(call.callerId);
      if (caller) {
        caller.balance = parseFloat((caller.balance - cost).toFixed(4));
        caller.inCall = false;
        caller.currentCallId = null;
        users.set(call.callerId, caller);
        
        platformRevenue.total = parseFloat((platformRevenue.total + cost).toFixed(4));
        
        io.to(call.callerSocket).emit('balance-update', { balance: caller.balance });
      }
      
      const callee = users.get(call.calleeId);
      if (callee) { callee.inCall = false; callee.currentCallId = null; users.set(call.calleeId, callee); }
      
      const endData = { callId, duration: durationSeconds, durationFormatted: formatDuration(durationSeconds), cost, message: `Call ended. Duration: ${formatDuration(durationSeconds)}, Cost: $${cost.toFixed(4)}` };
      io.to(call.callerSocket).emit('call-ended', endData);
      io.to(call.calleeSocket).emit('call-ended', endData);
    }
    cleanupCall(callId);
    broadcastOnlineUsers();
  });
  
  socket.on('get-online-users', () => broadcastOnlineUsers());
  
  socket.on('disconnect', () => {
    if (currentUserId) {
      const user = users.get(currentUserId);
      if (user) {
        user.isOnline = false;
        user.socketId = null;
        if (user.inCall && user.currentCallId) cleanupCall(user.currentCallId);
        user.inCall = false;
        user.currentCallId = null;
        users.set(currentUserId, user);
        broadcastOnlineUsers();
        console.log(`❌ User ${user.username} offline`);
      }
    }
  });
  
  function cleanupCall(callId) {
    const call = activeCalls.get(callId);
    if (call) {
      const caller = users.get(call.callerId);
      if (caller) { caller.inCall = false; caller.currentCallId = null; users.set(call.callerId, caller); }
      const callee = users.get(call.calleeId);
      if (callee) { callee.inCall = false; callee.currentCallId = null; users.set(call.calleeId, callee); }
      activeCalls.delete(callId);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🚀 ZAS UNIFIED APP - CALLING + M-PESA                       ║
║                                                               ║
║   📞 Voice Rate: $${CALL_RATES.voice}/minute                          ║
║   🎥 Video Rate: $${CALL_RATES.video}/minute                          ║
║   💰 M-Pesa: Sandbox Mode                                    ║
║                                                               ║
║   🌐 Server: http://194.146.24.110:${PORT}                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});
