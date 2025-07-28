// server.js

require('dotenv').config();

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Use Railway's PORT environment variable, fallback to 4001 for local development
const PORT = process.env.PORT || 4001;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

const wss = new WebSocket.Server({ 
  port: PORT,
  host: HOST 
}, () => {
  console.log(`✅ WebSocket server running on ${HOST}:${PORT}`);
});

// Store connected clients with their info
const clients = new Map();

// Track active users in conversations
const activeConversationUsers = {}; // { [conversationId]: Set<userId> }

async function saveMessageNotificationsForAll(message) {
  console.log('saveMessageNotificationsForAll called for message:', message);
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', message.conversation_id)
    .is('left_at', null);

  if (error) {
    console.error('Error fetching participants:', error);
    return;
  }

  console.log('Participants for conversation:', participants);

  for (const participant of participants) {
    if (participant.user_id !== message.sender_id) {
      console.log('Saving message notification for:', participant.user_id);
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

  // Also track message activity for the sender
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

async function saveNotification({ user_id, type, title, message, data }) {
  try {
    const frontendApiUrl = process.env.FRONTEND_API_URL;
    if (!frontendApiUrl) {
      throw new Error('FRONTEND_API_URL is not set in environment variables');
    }
    const url = `${frontendApiUrl.replace(/\/$/, '')}/api/notifications`;
    console.log('Saving notification to:', url);
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
    console.log('Saving user activity to:', url);
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

// Helper to get socket for a specific user
function getSocketForUser(userId) {
  for (const [socket, clientInfo] of clients) {
    if (clientInfo.userId === userId && socket.readyState === WebSocket.OPEN) {
      return socket;
    }
  }
  return null;
}

wss.on('connection', (ws, req) => {
  console.log('🔌 New client connected');

  // Extract conversation ID and user ID from URL if available
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const conversationId = url.pathname.split('/conversations/')[1]?.split('?')[0];
  const userId = url.searchParams.get('userId');

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
    connectedAt: Date.now()
  });

  console.log(`👤 User ${userId} joined conversation ${conversationId}`);

  ws.on('message', async (message) => {
    try {
      // Convert Buffer to string
      const messageStr = message.toString();
      console.log('📨 Message received:', messageStr);

      // Parse the JSON message
      const data = JSON.parse(messageStr);

      // Get sender info
      const senderInfo = clients.get(ws);

      // Add sender info to the message if not present
      if (senderInfo && !data.userId) {
        data.userId = senderInfo.userId;
      }

      // Broadcast logic based on message type
      switch (data.type) {
        case 'typing_update':
          // Only send typing updates to clients in the same conversation
          broadcastToConversation(data.conversationId, data, ws);
          break;

        case 'user_presence':
          // Broadcast presence updates to all clients
          broadcastToAll(data, ws);
          break;
        case 'follow':
          // Only process actual follow actions (not unfollow)
          if (data.action === 'follow') {
            console.log('Processing follow notification for:', data.followedId);

            // 1. Save notification for the followed user
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

            // 2. Send real-time notification update to the followed user if online
            const followedSocket = getSocketForUser(data.followedId);
            if (followedSocket) {
              // Send the new notification format
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

              // Also send legacy format for compatibility
              const notification = {
                type: 'follow_notification',
                followerId: data.followerId,
                followedId: data.followedId,
                followerName: data.followerName,
                action: data.action,
                timestamp: data.timestamp || Date.now()
              };

              followedSocket.send(JSON.stringify(notification));
              console.log(`👥 Follow notification sent to user ${data.followedId}`);
            } else {
              console.log(`👤 User ${data.followedId} is not online, notification saved only`);
            }
          }
          break;

        case 'new_message':
          // 1. Save notification for all participants (offline notification)
          await saveMessageNotificationsForAll(data.message);

          // 2. Send real-time notification updates to all connected clients
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

              // Also send the message notification for conversation clients
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

          // 3. Broadcast the message itself to conversation participants
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

  ws.on('close', () => {
    if (conversationId && userId && activeConversationUsers[conversationId]) {
      activeConversationUsers[conversationId].delete(userId);
      if (activeConversationUsers[conversationId].size === 0) {
        delete activeConversationUsers[conversationId];
      }
    }
    const clientInfo = clients.get(ws);
    console.log(`❌ Client disconnected: User ${clientInfo?.userId} from conversation ${clientInfo?.conversationId}`);

    // Send offline status to other clients
    if (clientInfo?.userId) {
      broadcastToAll({
        type: 'user_presence',
        userId: clientInfo.userId,
        isOnline: false
      }, ws);
    }

    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  // Send online status to other clients
  if (userId) {
    broadcastToAll({
      type: 'user_presence',
      userId: userId,
      isOnline: true
    }, ws);
  }
});

// Helper function to broadcast to all clients in a specific conversation
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

// Helper function to broadcast to all connected clients
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

// Cleanup function to remove dead connections
setInterval(() => {
  clients.forEach((clientInfo, client) => {
    if (client.readyState !== WebSocket.OPEN) {
      console.log(`🧹 Cleaning up dead connection for user ${clientInfo.userId}`);
      clients.delete(client);
    }
  });
}, 30000); // Clean up every 30 seconds

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('📢 SIGTERM received, shutting down gracefully...');
  wss.close(() => {
    console.log('✅ WebSocket server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📢 SIGINT received, shutting down gracefully...');
  wss.close(() => {
    console.log('✅ WebSocket server closed');
    process.exit(0);
  });
});

console.log('🚀 WebSocket server is ready to handle connections');