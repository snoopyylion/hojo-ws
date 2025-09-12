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

// ============== PODCAST ROOM MANAGEMENT ==============

class PodcastRoom {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.host = '';
    this.listeners = new Set();
    this.comments = [];
    this.likes = 0;
    this.isActive = true;
    this.createdAt = new Date();
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

    this.listeners.forEach(ws => {
      if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(messageStr);
          sentCount++;
        } catch (error) {
          console.error('Error sending to podcast listener:', error);
          this.listeners.delete(ws); // Clean up dead connections
        }
      }
    });

    console.log(`📻 Broadcasted to ${sentCount} podcast listeners in room ${this.sessionId}`);
  }

  getRoomState() {
    return {
      type: 'room_state',
      sessionId: this.sessionId,
      listeners: this.listeners.size,
      comments: this.comments.slice(-10), // Last 10 comments
      likes: this.likes,
      isActive: this.isActive
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
    
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
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
    
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
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
      room.host = data.userId;
      console.log(`🎙️ Host ${data.userId} joined session ${sessionId}`);
      break;
    
    case 'stream_status':
      room.broadcast({
        type: 'stream_status',
        streaming: data.streaming
      });
      break;

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

// ============== CONNECTION HANDLER ==============

wss.on('connection', (ws, req) => {
  console.log('🔌 New client connected');

  // Parse URL to determine connection type and extract parameters
  const { pathname, query } = parse(req.url || '', true);
  const userId = query.userId;
  
  // Check if this is a podcast connection
  const isPodcastConnection = pathname?.startsWith('/podcast/');
  const sessionId = isPodcastConnection ? pathname.split('/podcast/')[1] : null;
  
  // Check if this is a conversation connection
  const conversationId = pathname?.includes('/conversations/') 
    ? pathname.split('/conversations/')[1]?.split('?')[0] 
    : null;

  let connectionType = 'general';
  let room = null;

  if (isPodcastConnection && sessionId) {
    connectionType = 'podcast';
    console.log(`🎙️ Podcast client connected to session: ${sessionId}`);

    // Get or create podcast room
    if (!podcastRooms.has(sessionId)) {
      podcastRooms.set(sessionId, new PodcastRoom(sessionId));
    }
    room = podcastRooms.get(sessionId);
    room.addListener(ws);

    // Send current room state to new client
    ws.send(JSON.stringify(room.getRoomState()));

    // Broadcast listener count update
    room.broadcast({
      type: 'listener_count',
      count: room.listeners.size
    });

  } else {
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

  // ============== MESSAGE HANDLER ==============

  ws.on('message', async (message) => {
    try {
      const messageStr = message.toString();
      const data = JSON.parse(messageStr);

      console.log(`📨 Message received [${connectionType}]:`, data.type);

      if (connectionType === 'podcast' && room) {
        // Handle podcast-specific messages
        handlePodcastMessage(sessionId, ws, data, room);
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

  // ============== DISCONNECT HANDLER ==============

  ws.on('close', () => {
    if (connectionType === 'podcast' && room) {
      console.log(`🎙️ Podcast client disconnected from session: ${sessionId}`);
      room.removeListener(ws);

      // Broadcast updated listener count
      room.broadcast({
        type: 'listener_count',
        count: room.listeners.size
      });

      // Clean up empty inactive rooms
      if (room.listeners.size === 0 && !room.isActive) {
        podcastRooms.delete(sessionId);
        console.log(`🧹 Podcast room ${sessionId} cleaned up`);
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

// ============== PODCAST MANAGEMENT FUNCTIONS ==============

function endPodcastSession(sessionId) {
  const room = podcastRooms.get(sessionId);
  if (!room) return;

  room.isActive = false;
  
  // Notify all listeners that session ended
  room.broadcast({
    type: 'session_ended',
    message: 'The live stream has ended'
  });

  // Close all connections
  room.listeners.forEach(ws => {
    ws.close(1000, 'Session ended');
  });

  // Clean up room
  podcastRooms.delete(sessionId);
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
    room.listeners.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`🧹 Cleaning up dead podcast listener in room ${sessionId}`);
        room.removeListener(ws);
      }
    });
    
    // Remove empty inactive rooms
    if (room.listeners.size === 0 && !room.isActive) {
      podcastRooms.delete(sessionId);
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