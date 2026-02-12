require('dotenv').config();

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { parse } = require('url');

// Initialize Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Server configuration
const PORT = process.env.PORT || 4001;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

// WebSocket server
const wss = new WebSocket.Server({
  port: PORT,
  host: HOST
}, () => {
  console.log(`✅ Unified WebSocket server running on ${HOST}:${PORT}`);
});

// Storage for different types of connections
const clients = new Map(); // General messaging clients
const podcastRooms = new Map(); // Podcast rooms
const activeConversationUsers = {}; // Active conversation tracking

// ============== UPDATED GUEST REQUEST STORAGE ==============
const guestRequests = new Map(); // sessionId -> Map(userId -> request)

// Function to store guest request
function storeGuestRequest(sessionId, request) {
  if (!guestRequests.has(sessionId)) {
    guestRequests.set(sessionId, new Map());
  }
  guestRequests.get(sessionId).set(request.user_id, request);
  console.log(`💾 Stored guest request for session ${sessionId} from user ${request.user_id}`);
}

// Function to get all pending requests for a session
function getPendingRequests(sessionId) {
  if (!guestRequests.has(sessionId)) return [];
  return Array.from(guestRequests.get(sessionId).values());
}

// Function to remove guest request
function removeGuestRequest(sessionId, userId) {
  if (guestRequests.has(sessionId)) {
    const sessionRequests = guestRequests.get(sessionId);
    sessionRequests.delete(userId);
    console.log(`🗑️ Removed guest request for user ${userId} in session ${sessionId}`);
    
    // Clean up empty session
    if (sessionRequests.size === 0) {
      guestRequests.delete(sessionId);
    }
  }
}

// ============== ENHANCED PODCAST ROOM CLASS ==============
class PodcastRoom {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.hosts = new Set(); // Multiple hosts support
    this.listeners = new Set();
    this.guests = new Set(); // Track approved guests
    this.comments = [];
    this.likes = 0;
    this.isActive = true;
    this.createdAt = new Date();
    this.guestRequests = new Map(); // In-memory tracking
  }

  addHost(ws, userId) {
    this.hosts.add(ws);
    ws._clientData.userId = userId;
    console.log(`👑 Host ${userId} added to podcast ${this.sessionId}. Total hosts: ${this.hosts.size}`);
    
    // Send all pending requests to the new host
    this.sendPendingRequestsToHost(ws);
  }

  sendPendingRequestsToHost(hostWs) {
    const pendingRequests = getPendingRequests(this.sessionId);
    if (pendingRequests.length > 0) {
      console.log(`📨 Sending ${pendingRequests.length} pending requests to host ${hostWs._clientData?.userId}`);
      
      pendingRequests.forEach(request => {
        if (hostWs.readyState === WebSocket.OPEN) {
          try {
            hostWs.send(JSON.stringify({
              type: 'guest_request_update',
              request: request,
              timestamp: Date.now(),
              action: 'new'
            }));
            console.log(`✅ Sent pending request ${request.id} to host`);
          } catch (err) {
            console.error('❌ Failed to send pending request to host:', err);
          }
        }
      });
    }
  }

  broadcastToHosts(message, excludeWs = null) {
    let sentCount = 0;
    const messageStr = JSON.stringify(message);
    
    this.hosts.forEach(hostWs => {
      if (hostWs !== excludeWs && hostWs.readyState === WebSocket.OPEN) {
        try {
          hostWs.send(messageStr);
          sentCount++;
        } catch (error) {
          console.error('Error sending to host:', error);
          this.hosts.delete(hostWs);
        }
      }
    });
    
    if (sentCount > 0) {
      console.log(`📤 Broadcasted to ${sentCount} host(s) in room ${this.sessionId}`);
    }
    return sentCount;
  }

  addListener(ws) {
    this.listeners.add(ws);
    console.log(`👤 Listener added to podcast ${this.sessionId}. Total: ${this.listeners.size}`);
  }

  removeListener(ws) {
    this.listeners.delete(ws);
    console.log(`👋 Listener removed from podcast ${this.sessionId}. Total: ${this.listeners.size}`);
  }

  addComment(comment) {
    const commentObj = {
      id: Date.now().toString(),
      user: comment.user,
      message: comment.message,
      timestamp: new Date(),
      userId: comment.userId
    };

    this.comments.push(commentObj);

    // Keep only last 50 comments in memory
    if (this.comments.length > 50) {
      this.comments = this.comments.slice(-50);
    }

    return commentObj;
  }

  incrementLikes() {
    this.likes++;
    return this.likes;
  }

  broadcast(message, excludeWs = null) {
    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    // Send to all listeners
    this.listeners.forEach(listenerWs => {
      if (listenerWs !== excludeWs && listenerWs.readyState === WebSocket.OPEN) {
        try {
          listenerWs.send(messageStr);
          sentCount++;
        } catch (error) {
          console.error('Error sending to listener:', error);
          this.listeners.delete(listenerWs);
        }
      }
    });

    // Also send to hosts if they're listening
    this.hosts.forEach(hostWs => {
      if (hostWs !== excludeWs && hostWs.readyState === WebSocket.OPEN) {
        try {
          hostWs.send(messageStr);
          sentCount++;
        } catch (error) {
          console.error('Error sending to host:', error);
          this.hosts.delete(hostWs);
        }
      }
    });

    console.log(`📻 Broadcasted to ${sentCount} participants in room ${this.sessionId}`);
  }

  getRoomState() {
    return {
      type: 'room_state',
      sessionId: this.sessionId,
      hosts: this.hosts.size,
      listeners: this.listeners.size,
      guests: this.guests.size,
      comments: this.comments.slice(-10), // Last 10 comments
      likes: this.likes,
      isActive: this.isActive,
      pendingRequests: getPendingRequests(this.sessionId).length
    };
  }
}

// ============== UTILITY FUNCTIONS ==============

async function saveNotification({ user_id, type, title, message, data }) {
  try {
    const frontendApiUrl = process.env.FRONTEND_API_URL;
    if (!frontendApiUrl) {
      throw new Error('FRONTEND_API_URL is not set in environment variables');
    }
    const url = `${frontendApiUrl.replace(/\/$/, '')}/api/notifications`;
    console.log('💾 Saving notification to:', url);

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-server-call': 'true',
      },
      body: JSON.stringify({
        user_id,
        type,
        title,
        message,
        data,
      }),
    });
    const text = await res.text();
    console.log('Notification save response:', res.status, text);
  } catch (error) {
    console.error('Failed to save notification:', error);
  }
}

async function saveUserActivity({ user_id, type, title, description, category, visibility, data }) {
  try {
    const frontendApiUrl = process.env.FRONTEND_API_URL;
    if (!frontendApiUrl) {
      throw new Error('FRONTEND_API_URL is not set in environment variables');
    }
    const url = `${frontendApiUrl.replace(/\/$/, '')}/api/user-activity`;
    console.log('💾 Saving user activity to:', url);

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-server-call': 'true',
      },
      body: JSON.stringify({
        user_id,
        type,
        title,
        description,
        category,
        visibility,
        data,
      }),
    });
    const text = await res.text();
    console.log('User activity save response:', res.status, text);
  } catch (error) {
    console.error('Failed to save user activity:', error);
  }
}

async function saveMessageNotificationsForAll(message) {
  console.log('📨 Processing message notifications for:', message);

  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', message.conversation_id)
    .is('left_at', null);

  if (error) {
    console.error('Error fetching participants:', error);
    return;
  }

  console.log('👥 Participants for conversation:', participants);

  for (const participant of participants) {
    if (participant.user_id !== message.sender_id) {
      console.log('💾 Saving message notification for:', participant.user_id);
      await saveNotification({
        user_id: participant.user_id,
        type: 'message',
        title: `New message from ${message.sender?.first_name || message.sender?.username || 'Someone'}`,
        message: message.content || 'New message',
        data: {
          conversation_id: message.conversation_id,
          senderId: message.sender_id
        },
      });
    }
  }

  // Track message activity for the sender
  await saveUserActivity({
    user_id: message.sender_id,
    type: 'message_sent',
    title: 'Message Sent',
    description: `You sent a message in conversation`,
    category: 'social',
    visibility: 'private',
    data: {
      conversation_id: message.conversation_id,
      message_preview: message.content?.substring(0, 100) || 'Message sent',
      recipient_count: participants.length - 1
    }
  });
}

function getSocketForUser(userId) {
  for (const [socket, clientInfo] of clients) {
    if (clientInfo.userId === userId && socket.readyState === WebSocket.OPEN) {
      return socket;
    }
  }
  return null;
}

function broadcastToConversation(conversationId, data, sender) {
  if (!conversationId) return;

  const messageStr = JSON.stringify(data);
  let sentCount = 0;

  clients.forEach((clientInfo, client) => {
    if (client !== sender &&
      client.readyState === WebSocket.OPEN &&
      clientInfo.conversationId === conversationId) {
      try {
        client.send(messageStr);
        sentCount++;
      } catch (error) {
        console.error('❌ Error sending message to client:', error);
      }
    }
  });

  console.log(`📤 Broadcasted to ${sentCount} clients in conversation ${conversationId}`);
}

function broadcastToAll(data, sender) {
  const messageStr = JSON.stringify(data);
  let sentCount = 0;

  clients.forEach((clientInfo, client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      try {
        client.send(messageStr);
        sentCount++;
      } catch (error) {
        console.error('❌ Error sending message to client:', error);
      }
    }
  });

  console.log(`📤 Broadcasted to ${sentCount} clients`);
}

// Helper function to find user's WebSocket
function findUserWebSocket(sessionId, userId, room) {
  // Check hosts
  for (const hostWs of room.hosts) {
    if (hostWs._clientData?.userId === userId) {
      return hostWs;
    }
  }
  
  // Check listeners
  for (const listenerWs of room.listeners) {
    if (listenerWs._clientData?.userId === userId) {
      return listenerWs;
    }
  }
  
  return null;
}

// ============== UPDATED GUEST REQUEST HANDLER ==============
async function handleGuestRequest(sessionId, ws, data, room) {
  console.log(`🎯 Processing guest request type: ${data.type} for session ${sessionId}`);

  switch (data.type) {
    case 'new_guest_request':
      console.log(`🙋 New guest request from user ${data.request?.user_id || 'unknown'}`, data.request);
      
      // Store request persistently
      storeGuestRequest(sessionId, data.request);
      
      // Immediately broadcast to ALL hosts in the room
      const sentCount = room.broadcastToHosts({
        type: 'guest_request_update',
        request: data.request,
        timestamp: Date.now(),
        action: 'new'
      });

      console.log(`📤 Guest request broadcast to ${sentCount} host(s)`);
      
      // Send confirmation to requester
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'guest_request_received',
          requestId: data.request?.id,
          message: 'Your request has been sent to the host',
          timestamp: Date.now()
        }));
      }
      break;

    case 'guest_request_response':
      console.log(`✅ Guest request ${data.status} for user ${data.userId}`);
      
      // Remove from pending requests
      removeGuestRequest(sessionId, data.userId);
      
      // Broadcast update to all participants
      room.broadcast({
        type: 'guest_request_responded',
        requestId: data.requestId,
        userId: data.userId,
        status: data.status,
        timestamp: Date.now()
      });
      
      // Send specific notification to the user
      const userWs = findUserWebSocket(sessionId, data.userId, room);
      if (userWs && userWs.readyState === WebSocket.OPEN) {
        userWs.send(JSON.stringify({
          type: 'guest_request_status',
          requestId: data.requestId,
          status: data.status,
          message: data.status === 'approved' 
            ? '🎤 You have been approved to speak!' 
            : '❌ Your request to speak was declined.',
          timestamp: Date.now()
        }));
      }
      break;

    case 'request_to_speak':
      // Handle direct request from listener
      const requestData = {
        id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        user_id: data.userId,
        message: data.message || 'I would like to speak',
        profile: data.profile || {},
        requested_at: new Date().toISOString(),
        status: 'pending'
      };
      
      // Store and broadcast
      storeGuestRequest(sessionId, requestData);
      room.broadcastToHosts({
        type: 'new_guest_request',
        request: requestData,
        timestamp: Date.now()
      });
      break;
  }
}

// ============== PODCAST HANDLERS ==============

function handlePodcastMessage(sessionId, ws, data, room) {
  switch (data.type) {
    case 'podcast_comment':
      const comment = room.addComment(data.comment);
      room.broadcast({
        type: 'podcast_comment',
        comment
      });
      storePodcastComment(sessionId, comment);
      break;

    case 'podcast_like':
      const totalLikes = room.incrementLikes();
      room.broadcast({
        type: 'podcast_like',
        totalLikes
      });
      break;

    case 'audio_chunk':
      console.log(`🎵 Received audio chunk for session ${sessionId}`);
      processAudioForStreaming(sessionId, data.audioData, room);
      break;

    case 'host_join':
      console.log(`🎙️ Host ${data.userId} joined session ${sessionId}`);
      break;

    case 'stream_status':
      room.broadcast({
        type: 'stream_status',
        streaming: data.streaming
      });
      break;

    // Guest request handling is now done in the main message handler
    default:
      console.log('Unknown podcast message type:', data.type);
  }
}

async function processAudioForStreaming(sessionId, audioData, room) {
  try {
    // Decode base64 audio
    const audioBuffer = Buffer.from(audioData, 'base64');

    // Here you would use FFmpeg or similar to:
    // 1. Convert WebM to proper format for RTMP
    // 2. Stream to YouTube RTMP endpoint

    // For now, just simulate processing
    console.log(`🎵 Processing ${audioBuffer.length} bytes of audio for session ${sessionId}`);

    // Update streaming status
    room.broadcast({
      type: 'stream_status',
      streaming: true
    });

  } catch (error) {
    console.error('❌ Error processing audio:', error);
  }
}

async function storePodcastComment(sessionId, comment) {
  try {
    console.log(`💾 Storing podcast comment for session ${sessionId}:`, comment);
    // This would integrate with your Supabase setup for podcast comments
  } catch (error) {
    console.error('Failed to store podcast comment:', error);
  }
}

// ============== UPDATED CONNECTION HANDLER ==============
wss.on('connection', (ws, req) => {
  console.log('🔌 New client connecting...');

  // Parse URL
  const { pathname, query } = parse(req.url || '', true);
  const userId = query.userId;
  const role = query.role || 'listener';

  // Check connection type
  const isPodcastConnection = pathname?.startsWith('/podcast/');
  const sessionId = isPodcastConnection ? pathname.split('/podcast/')[1]?.split('?')[0] : null;

  // Check if this is a conversation connection
  const conversationId = pathname?.includes('/conversations/')
    ? pathname.split('/conversations/')[1]?.split('?')[0]
    : null;

  let connectionType = 'general';
  let room = null;

  if (isPodcastConnection && sessionId) {
    connectionType = 'podcast';
    console.log(`🎙️ ${role.toUpperCase()} connecting to podcast session: ${sessionId}, User: ${userId}`);

    // Get or create podcast room
    if (!podcastRooms.has(sessionId)) {
      podcastRooms.set(sessionId, new PodcastRoom(sessionId));
      console.log(`🏠 Created new podcast room for session ${sessionId}`);
    }
    room = podcastRooms.get(sessionId);

    // Store client data on WebSocket object
    ws._clientData = {
      role: role,
      userId: userId,
      sessionId: sessionId,
      connectionType: 'podcast',
      connectedAt: Date.now()
    };

    console.log(`📝 Client data stored:`, {
      role: ws._clientData.role,
      userId: ws._clientData.userId,
      sessionId: ws._clientData.sessionId
    });

    // Add to appropriate sets based on role
    if (role === 'host') {
      room.addHost(ws, userId);
      console.log(`👑 Host ${userId} registered for session ${sessionId}`);
      
      // Send immediate welcome message with room state
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'host_welcome',
          sessionId: sessionId,
          roomState: room.getRoomState(),
          timestamp: Date.now(),
          message: `You are now hosting session: ${sessionId}`
        }));
      }
    } else {
      room.addListener(ws);
      console.log(`👤 Listener ${userId} added to session ${sessionId}`);
    }

    // Send room state to new client
    try {
      ws.send(JSON.stringify(room.getRoomState()));
    } catch (err) {
      console.error('❌ Failed to send room state to client:', err);
    }

    // Broadcast updated participant count
    room.broadcast({
      type: 'participant_count',
      hosts: room.hosts.size,
      listeners: room.listeners.size,
      guests: room.guests.size,
      total: room.hosts.size + room.listeners.size + room.guests.size
    });

  } else {
    // General messaging connection
    connectionType = 'general';
    console.log(`💬 General client connected - User: ${userId}, Conversation: ${conversationId}`);

    // Track active users in conversation
    if (conversationId && userId) {
      if (!activeConversationUsers[conversationId]) {
        activeConversationUsers[conversationId] = new Set();
      }
      activeConversationUsers[conversationId].add(userId);
    }

    // Store client info
    clients.set(ws, {
      conversationId,
      userId,
      connectedAt: Date.now(),
      connectionType: 'general'
    });

    // Send online status to other clients
    if (userId) {
      broadcastToAll({
        type: 'user_presence',
        userId: userId,
        isOnline: true
      }, ws);
    }
  }

  // ============== ENHANCED MESSAGE HANDLER ==============
  ws.on('message', async (message) => {
    try {
      const messageStr = message.toString();
      const data = JSON.parse(messageStr);

      console.log(`📨 [${connectionType}] Message type: ${data.type}`);

      if (connectionType === 'podcast' && room) {
        // Handle podcast-specific messages including guest requests
        if (data.type === 'new_guest_request' || 
            data.type === 'guest_request_response' ||
            data.type === 'request_to_speak') {
          await handleGuestRequest(sessionId, ws, data, room);
        } else {
          // Handle other podcast messages
          handlePodcastMessage(sessionId, ws, data, room);
        }
        return;
      }

      // Handle general messaging
      const senderInfo = clients.get(ws);
      if (senderInfo && !data.userId) {
        data.userId = senderInfo.userId;
      }

      switch (data.type) {
        case 'typing_update':
          broadcastToConversation(data.conversationId, data, ws);
          break;

        case 'user_presence':
          broadcastToAll(data, ws);
          break;

        case 'follow':
          if (data.action === 'follow') {
            console.log('👥 Processing follow notification for:', data.followedId);

            // Save notification for the followed user
            await saveNotification({
              user_id: data.followedId,
              type: 'follow',
              title: 'New Follower',
              message: `${data.followerName || 'Someone'} started following you!`,
              data: {
                followerId: data.followerId,
                action: data.action,
                timestamp: data.timestamp
              },
            });

            // Send real-time notification to followed user if online
            const followedSocket = getSocketForUser(data.followedId);
            if (followedSocket) {
              try {
                followedSocket.send(JSON.stringify({
                  type: 'new_notification',
                  notification: {
                    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    user_id: data.followedId,
                    type: 'follow',
                    title: 'New Follower',
                    message: `${data.followerName || 'Someone'} started following you!`,
                    data: {
                      actor_id: data.followerId,
                      actor_name: data.followerName,
                      target_type: 'user',
                      target_id: data.followedId,
                      action_url: `/user/${data.followerId}`,
                      action_text: 'View Profile'
                    },
                    read: false,
                    created_at: new Date().toISOString(),
                    category: 'social',
                    priority: 'medium'
                  }
                }));

                // Legacy format for compatibility
                followedSocket.send(JSON.stringify({
                  type: 'follow_notification',
                  followerId: data.followerId,
                  followedId: data.followedId,
                  followerName: data.followerName,
                  action: data.action,
                  timestamp: data.timestamp || Date.now()
                }));
              } catch (err) {
                console.error('❌ Failed to send follow notification to followed user:', err);
              }
            }
          }
          break;

        case 'new_message':
          // Save notifications for all participants
          await saveMessageNotificationsForAll(data.message);

          // Send real-time notifications to connected clients
          clients.forEach((clientInfo, client) => {
            if (
              clientInfo.userId !== data.message.sender_id &&
              client.readyState === WebSocket.OPEN
            ) {
              try {
                // Send notification update
                client.send(JSON.stringify({
                  type: 'new_notification',
                  notification: {
                    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    user_id: clientInfo.userId,
                    type: 'message',
                    title: `New message from ${data.message.sender?.first_name || data.message.sender?.username || 'Someone'}`,
                    message: data.message.content?.substring(0, 100) || 'New message',
                    data: {
                      conversation_id: data.message.conversation_id,
                      sender_id: data.message.sender_id,
                      sender_name: data.message.sender?.first_name || data.message.sender?.username || 'Someone',
                      message_preview: data.message.content
                    },
                    read: false,
                    created_at: new Date().toISOString(),
                    category: 'messaging',
                    priority: 'high'
                  }
                }));
              } catch (err) {
                console.error('❌ Failed to send new_notification to client:', err);
              }

              try {
                // Send message to conversation participants
                if (clientInfo.conversationId === data.message.conversation_id) {
                  client.send(JSON.stringify({
                    type: 'new_message',
                    senderName: data.message.sender?.username || 'Someone',
                    content: data.message.content,
                    conversationId: data.message.conversation_id,
                    messageId: data.message.id
                  }));
                }
              } catch (err) {
                console.error('❌ Failed to forward new_message to conversation participant:', err);
              }
            }
          });

          // Broadcast to conversation participants
          broadcastToConversation(data.message?.conversation_id, data, ws);
          break;

        default:
          // Broadcast other message types to all clients
          broadcastToAll(data, ws);
      }

    } catch (error) {
      console.error('❌ Error processing message:', error);
      console.error('Raw message:', message);
    }
  });

  // ============== ENHANCED DISCONNECT HANDLER ==============
  ws.on('close', () => {
    if (connectionType === 'podcast' && room) {
      const clientData = ws._clientData || {};
      console.log(`🎙️ ${clientData.role?.toUpperCase()} disconnected from session: ${sessionId}, User: ${clientData.userId}`);

      // Remove from appropriate set based on role
      if (clientData.role === 'host') {
        room.hosts.delete(ws);
        console.log(`👑 Host ${clientData.userId} removed from session ${sessionId}`);
      } else {
        room.listeners.delete(ws);
        console.log(`👤 Listener ${clientData.userId} removed from session ${sessionId}`);
      }

      // Broadcast updated participant count
      room.broadcast({
        type: 'participant_count',
        hosts: room.hosts.size,
        listeners: room.listeners.size,
        guests: room.guests.size,
        total: room.hosts.size + room.listeners.size + room.guests.size
      });

      // Clean up empty inactive rooms
      if (room.hosts.size === 0 && room.listeners.size === 0 && !room.isActive) {
        podcastRooms.delete(sessionId);
        console.log(`🧹 Podcast room ${sessionId} cleaned up`);
        
        // Clean up stored guest requests for this session
        guestRequests.delete(sessionId);
      }
    } else {
      // Handle general client disconnect
      if (conversationId && userId && activeConversationUsers[conversationId]) {
        activeConversationUsers[conversationId].delete(userId);
        if (activeConversationUsers[conversationId].size === 0) {
          delete activeConversationUsers[conversationId];
        }
      }

      const clientInfo = clients.get(ws);
      console.log(`💬 General client disconnected: User ${clientInfo?.userId}`);

      // Send offline status to other clients
      if (clientInfo?.userId) {
        broadcastToAll({
          type: 'user_presence',
          userId: clientInfo.userId,
          isOnline: false
        }, ws);
      }

      clients.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// ============== ADD PERIODIC CLEANUP ==============
setInterval(() => {
  console.log('🧹 Running periodic cleanup...');
  
  // Clean up old guest requests (older than 1 hour)
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  guestRequests.forEach((sessionRequests, sessionId) => {
    if (sessionRequests) {
      sessionRequests.forEach((request, userId) => {
        const requestTime = new Date(request.requested_at).getTime();
        if (requestTime < oneHourAgo) {
          console.log(`🧹 Removing old guest request from user ${userId} in session ${sessionId}`);
          sessionRequests.delete(userId);
        }
      });
      
      // Clean up empty session
      if (sessionRequests.size === 0) {
        guestRequests.delete(sessionId);
      }
    }
  });
  
  console.log(`📊 Status - Active sessions: ${podcastRooms.size}, Pending guest requests: ${Array.from(guestRequests.values()).reduce((sum, reqs) => sum + reqs.size, 0)}`);
}, 300000); // Every 5 minutes

// ============== PODCAST MANAGEMENT FUNCTIONS ==============

function endPodcastSession(sessionId) {
  const room = podcastRooms.get(sessionId);
  if (!room) return;

  room.isActive = false;

  // Notify all participants that session ended
  room.broadcast({
    type: 'session_ended',
    message: 'The live stream has ended'
  });

  // Close all connections
  [...room.hosts, ...room.listeners].forEach(ws => {
    try {
      ws.close(1000, 'Session ended');
    } catch (err) {
      console.error('❌ Error closing socket during session end:', err);
    }
  });

  // Clean up room
  podcastRooms.delete(sessionId);
  // Clean up guest requests for this session
  guestRequests.delete(sessionId);
  console.log(`🏁 Podcast session ${sessionId} ended and cleaned up`);
}

// ============== CLEANUP & MONITORING ==============

// Cleanup function to remove dead connections
setInterval(() => {
  // Clean up general clients
  clients.forEach((clientInfo, client) => {
    if (client.readyState !== WebSocket.OPEN) {
      console.log(`🧹 Cleaning up dead general connection for user ${clientInfo.userId}`);
      clients.delete(client);
    }
  });

  // Clean up podcast rooms
  podcastRooms.forEach((room, sessionId) => {
    // Clean up dead hosts
    room.hosts.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`🧹 Cleaning up dead podcast host in room ${sessionId}`);
        room.hosts.delete(ws);
      }
    });

    // Clean up dead listeners
    room.listeners.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`🧹 Cleaning up dead podcast listener in room ${sessionId}`);
        room.removeListener(ws);
      }
    });

    // Remove empty inactive rooms
    if (room.hosts.size === 0 && room.listeners.size === 0 && !room.isActive) {
      podcastRooms.delete(sessionId);
      guestRequests.delete(sessionId);
      console.log(`🧹 Empty podcast room ${sessionId} cleaned up`);
    }
  });
}, 30000); // Clean up every 30 seconds

// Status monitoring
setInterval(() => {
  console.log(`📊 Server Status - General clients: ${clients.size}, Podcast rooms: ${podcastRooms.size}`);
}, 60000); // Log status every minute

// ============== GRACEFUL SHUTDOWN ==============

function gracefulShutdown() {
  console.log('📢 Shutting down gracefully...');

  // Close all podcast sessions
  podcastRooms.forEach((room, sessionId) => {
    endPodcastSession(sessionId);
  });

  // Close WebSocket server
  wss.close(() => {
    console.log('✅ WebSocket server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

console.log('🚀 Unified WebSocket server is ready to handle connections');
console.log('💬 General messaging: ws://HOST:PORT/');
console.log('🎙️ Podcast connections: ws://HOST:PORT/podcast/{sessionId}');

// Export for testing
module.exports = { endPodcastSession };