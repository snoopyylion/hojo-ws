// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 4001 }, () => {
  console.log('✅ WebSocket server running on ws://localhost:4001');
});

// Store connected clients with their info
const clients = new Map();

wss.on('connection', (ws, req) => {
  console.log('🔌 New client connected');
  
  // Extract conversation ID and user ID from URL if available
  const url = new URL(req.url, 'http://localhost:4001');
  const conversationId = url.pathname.split('/conversations/')[1]?.split('?')[0];
  const userId = url.searchParams.get('userId');
  
  // Store client info
  clients.set(ws, {
    conversationId,
    userId,
    connectedAt: Date.now()
  });
  
  console.log(`👤 User ${userId} joined conversation ${conversationId}`);

  ws.on('message', (message) => {
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
          
        case 'new_message':
          // Broadcast new messages to all clients in the conversation
          broadcastToConversation(data.message?.conversation_id, data, ws);
          break;
          
        case 'user_presence':
          // Broadcast presence updates to all clients
          broadcastToAll(data, ws);
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

console.log('🚀 WebSocket server is ready to handle connections');