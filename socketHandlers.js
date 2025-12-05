const mongoose = require('mongoose');
const QuotationMessage = require('../Backend/models/QuotationMessage');
const Quotation = require('../Backend/models/Quotation');
const RFQ = require('../Backend/models/RFQ');
const Product = require('../Backend/models/Product');
const User = require('../Backend/models/User');

// Helper to check if DB is connected and ready
const isDBConnected = () => {
  const state = mongoose.connection.readyState;
  // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
  return state === 1;
};

// Wait for DB to be ready with retry
const waitForDB = async (maxRetries = 15, delay = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    const state = mongoose.connection.readyState;
    if (state === 1 && mongoose.connection.db) {
      try {
        // Test ping first
        await mongoose.connection.db.admin().ping();
        
        // Test actual query to ensure models are ready
        await mongoose.connection.db.collection('users').countDocuments({}, { limit: 1 });
        
        console.log(`✅ [waitForDB] DB ready and models accessible (attempt ${i + 1})`);
        return true;
      } catch (error) {
        console.warn(`⚠️  [waitForDB] Test failed (attempt ${i + 1}):`, error.message);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
    } else {
      console.log(`⏳ [waitForDB] Waiting for DB (state: ${state}, attempt ${i + 1}/${maxRetries})`);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  console.error(`❌ [waitForDB] Max retries reached. DB not ready.`);
  return false;
};

// Helper function to get product with shop using native MongoDB driver (bypasses Mongoose buffering)
const getProductWithShop = async (productId) => {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database not available');
  }
  
  try {
    // Convert string ID to ObjectId
    const ObjectId = mongoose.Types.ObjectId;
    let productObjectId;
    try {
      productObjectId = productId instanceof ObjectId ? productId : new ObjectId(productId);
    } catch (idError) {
      throw new Error(`Invalid product ID: ${productId}`);
    }
    
    // Get product using native driver (bypasses Mongoose buffering)
    const product = await db.collection('products').findOne({ _id: productObjectId });
    if (!product) {
      return null;
    }
    
    // Get shop using native driver if product has shop reference
    if (product.shop) {
      let shopObjectId;
      try {
        if (product.shop instanceof ObjectId) {
          shopObjectId = product.shop;
        } else if (typeof product.shop === 'string') {
          shopObjectId = new ObjectId(product.shop);
        } else {
          shopObjectId = new ObjectId(product.shop.toString());
        }
        const shop = await db.collection('shops').findOne({ _id: shopObjectId });
        product.shop = shop;
      } catch (shopError) {
        console.warn(`⚠️  [getProductWithShop] Could not fetch shop for product ${productId}:`, shopError.message);
        product.shop = null;
      }
    }
    
    return product;
  } catch (error) {
    console.error(`❌ [getProductWithShop] Error fetching product ${productId}:`, error);
    throw error;
  }
};

// Helper function to save message using native MongoDB driver (bypasses Mongoose buffering)
const saveMessageNative = async (messageData) => {
  // Verify DB connection first
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not connected');
  }
  
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database not available');
  }
  
  try {
    // Test connection with a quick ping
    await db.admin().ping();
    
    const ObjectId = mongoose.Types.ObjectId;
    
    // Prepare message document
    const messageDoc = {
      quotation: messageData.quotation ? (messageData.quotation instanceof ObjectId ? messageData.quotation : new ObjectId(messageData.quotation)) : undefined,
      rfq: messageData.rfq ? (messageData.rfq instanceof ObjectId ? messageData.rfq : new ObjectId(messageData.rfq)) : undefined,
      product: messageData.product ? (messageData.product instanceof ObjectId ? messageData.product : new ObjectId(messageData.product)) : undefined,
      sender: messageData.sender instanceof ObjectId ? messageData.sender : new ObjectId(messageData.sender),
      receiver: messageData.receiver instanceof ObjectId ? messageData.receiver : new ObjectId(messageData.receiver),
      message: messageData.message,
      attachments: messageData.attachments || [],
      readAt: null,
      createdAt: new Date(),
      __v: 0
    };
    
    // Remove undefined fields (MongoDB doesn't store undefined)
    if (messageDoc.quotation === undefined) delete messageDoc.quotation;
    if (messageDoc.rfq === undefined) delete messageDoc.rfq;
    if (messageDoc.product === undefined) delete messageDoc.product;
    
    // Validate: Either quotation, rfq, or product must be provided
    if (!messageDoc.quotation && !messageDoc.rfq && !messageDoc.product) {
      throw new Error('Either quotation, rfq, or product must be provided');
    }
    
    // Insert message using native driver with timeout (bypasses Mongoose buffering)
    const insertPromise = db.collection('quotationmessages').insertOne(messageDoc);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Insert operation timeout after 8 seconds')), 8000)
    );
    
    const result = await Promise.race([insertPromise, timeoutPromise]);
    
    if (!result.insertedId) {
      throw new Error('Failed to save message');
    }
    
    // Fetch the saved message with timeout
    const findPromise = db.collection('quotationmessages').findOne({ _id: result.insertedId });
    const findTimeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Find operation timeout after 5 seconds')), 5000)
    );
    
    const savedMessage = await Promise.race([findPromise, findTimeoutPromise]);
    
    if (!savedMessage) {
      throw new Error('Message saved but could not be retrieved');
    }
    
    // Populate sender info using native driver with timeout
    if (savedMessage.sender) {
      const senderPromise = db.collection('users').findOne(
        { _id: savedMessage.sender },
        { projection: { username: 1, email: 1, profile: 1 } }
      );
      const senderTimeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Sender lookup timeout after 5 seconds')), 5000)
      );
      
      try {
        const sender = await Promise.race([senderPromise, senderTimeoutPromise]);
        if (sender) {
          savedMessage.sender = sender;
        }
      } catch (senderError) {
        console.warn(`⚠️  [saveMessageNative] Could not fetch sender info:`, senderError.message);
        // Continue without sender info
      }
    }
    
    return savedMessage;
  } catch (error) {
    console.error(`❌ [saveMessageNative] Error saving message:`, error);
    throw error;
  }
};

module.exports = (io, socket) => {
  // Join quotation room
  socket.on('join-quotation-room', async (data) => {
    try {
      // Wait for DB to be ready
      const dbReady = await waitForDB();
      if (!dbReady) {
        socket.emit('error', { message: 'Database not connected. Please try again.' });
        return;
      }

      const { quotationId } = data;
      
      if (!quotationId) {
        socket.emit('error', { message: 'Quotation ID is required' });
        return;
      }

      // Verify user has access to this quotation
      const quotation = await Quotation.findById(quotationId).populate('rfq');
      if (!quotation) {
        socket.emit('error', { message: 'Quotation not found' });
        return;
      }

      const rfq = await RFQ.findById(quotation.rfq);
      if (quotation.quotedBy.toString() !== socket.userId && 
          rfq.requestedBy.toString() !== socket.userId) {
        socket.emit('error', { message: 'Access denied' });
        return;
      }

      const room = `quotation-${quotationId}`;
      socket.join(room);
      console.log(`User ${socket.userId} joined room: ${room}`);
      
      socket.emit('joined-room', { room, quotationId });
    } catch (error) {
      console.error('❌ [join-quotation-room] Error:', error);
      console.error('   Error details:', { message: error.message, stack: error.stack, quotationId: data?.quotationId });
      socket.emit('error', { 
        message: `Failed to join quotation room: ${error.message || 'Unknown error'}`,
        details: error.message
      });
    }
  });

  // Join RFQ room
  socket.on('join-rfq-room', async (data) => {
    try {
      // Wait for DB to be ready
      const dbReady = await waitForDB();
      if (!dbReady) {
        socket.emit('error', { message: 'Database not connected. Please try again.' });
        return;
      }

      const { rfqId } = data;
      
      if (!rfqId) {
        socket.emit('error', { message: 'RFQ ID is required' });
        return;
      }

      // Verify user has access to this RFQ
      const rfq = await RFQ.findById(rfqId);
      if (!rfq) {
        socket.emit('error', { message: 'RFQ not found' });
        return;
      }

      if (rfq.requestedBy.toString() !== socket.userId) {
        socket.emit('error', { message: 'Access denied' });
        return;
      }

      const room = `rfq-${rfqId}`;
      socket.join(room);
      console.log(`User ${socket.userId} joined room: ${room}`);
      
      socket.emit('joined-room', { room, rfqId });
    } catch (error) {
      console.error('❌ [join-rfq-room] Error:', error);
      console.error('   Error details:', { message: error.message, stack: error.stack, rfqId: data?.rfqId });
      socket.emit('error', { 
        message: `Failed to join RFQ room: ${error.message || 'Unknown error'}`,
        details: error.message
      });
    }
  });

  // Leave room
  socket.on('leave-room', (data) => {
    const { room } = data;
    if (room) {
      socket.leave(room);
      console.log(`User ${socket.userId} left room: ${room}`);
    }
  });

  // Join product room
  socket.on('join-product-room', async (data) => {
    const startTime = Date.now();
    console.log(`🔵 [join-product-room] Request from user ${socket.userId}`, { productId: data?.productId, receiverId: data?.receiverId });
    
    try {
      // Wait for DB to be ready
      console.log(`⏳ [join-product-room] Checking DB connection...`);
      const dbReady = await waitForDB(15, 1000); // 15 retries, 1 second each
      if (!dbReady) {
        console.error(`❌ [join-product-room] DB not ready after retries for user ${socket.userId}`);
        socket.emit('error', { message: 'Database not connected. Please try again.' });
        return;
      }

      // Double-check connection state before query
      if (mongoose.connection.readyState !== 1) {
        console.error(`❌ [join-product-room] Connection lost after waitForDB for user ${socket.userId}`);
        socket.emit('error', { message: 'Database connection lost. Please try again.' });
        return;
      }

      const { productId, receiverId } = data;
      
      if (!productId || !receiverId) {
        console.error(`❌ [join-product-room] Missing required fields for user ${socket.userId}`, { productId, receiverId });
        socket.emit('error', { message: 'Product ID and receiver ID are required' });
        return;
      }

      console.log(`🔍 [join-product-room] Fetching product ${productId} for user ${socket.userId}`);
      console.log(`📊 [join-product-room] Connection state before query: ${mongoose.connection.readyState}`);
      
      // Verify product exists - use native MongoDB driver to bypass Mongoose buffering
      const product = await Promise.race([
        getProductWithShop(productId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Product query timeout after 5 seconds')), 5000)
        )
      ]);
      if (!product) {
        console.error(`❌ [join-product-room] Product ${productId} not found for user ${socket.userId}`);
        socket.emit('error', { message: `Product not found: ${productId}` });
        return;
      }

      console.log(`✅ [join-product-room] Product found: ${product.name}, Shop: ${product.shop?._id || 'N/A'}`);

      // Verify user has access (either sender or receiver)
      const shopOwnerId = product.shop?.owner?.toString() || product.shop?.owner?._id?.toString();
      console.log(`🔍 [join-product-room] Access check - userId: ${socket.userId}, receiverId: ${receiverId}, shopOwnerId: ${shopOwnerId}`);
      
      if (!shopOwnerId) {
        console.error(`❌ [join-product-room] Shop owner not found for product ${productId}`);
        socket.emit('error', { message: 'Product shop information not available' });
        return;
      }

      const hasAccess = socket.userId === receiverId || shopOwnerId === socket.userId || shopOwnerId === receiverId;
      
      if (!hasAccess) {
        console.error(`❌ [join-product-room] Access denied for user ${socket.userId} to product ${productId}`);
        socket.emit('error', { message: 'Access denied. You do not have permission to join this room.' });
        return;
      }

      // Create consistent room name by sorting user IDs
      // This ensures both users join the same room regardless of who initiates
      const userIds = [socket.userId, receiverId].sort();
      const room = `product-${productId}-${userIds[0]}-${userIds[1]}`;
      socket.join(room);
      
      const duration = Date.now() - startTime;
      console.log(`✅ [join-product-room] User ${socket.userId} joined product room: ${room} (took ${duration}ms)`);
      
      socket.emit('joined-room', { room, productId });
    } catch (error) {
      const duration = Date.now() - startTime;
      const connectionState = mongoose.connection.readyState;
      console.error(`❌ [join-product-room] Error for user ${socket.userId} (took ${duration}ms, state: ${connectionState}):`, error);
      console.error(`   Error details:`, {
        message: error.message,
        stack: error.stack,
        productId: data?.productId,
        receiverId: data?.receiverId,
        connectionState
      });
      
      let errorMessage = 'Failed to join room';
      if (error.message.includes('buffering timed out')) {
        errorMessage = 'Database connection not ready. Please try again in a moment.';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Query timeout. Please try again.';
      } else {
        errorMessage = `Failed to join room: ${error.message}`;
      }
      
      socket.emit('error', { 
        message: errorMessage,
        details: error.message
      });
    }
  });

  // Send message
  socket.on('send-message', async (data) => {
    try {
      // Wait for DB to be ready
      const dbReady = await waitForDB();
      if (!dbReady) {
        socket.emit('error', { message: 'Database not connected. Please try again.' });
        return;
      }

      const { quotationId, rfqId, productId, receiver, message, attachments } = data;

      if (!message || !receiver) {
        socket.emit('error', { message: 'Message and receiver are required' });
        return;
      }

      if (!quotationId && !rfqId && !productId) {
        socket.emit('error', { message: 'Either quotationId, rfqId, or productId is required' });
        return;
      }

      // Verify access and save message
      let room;
      if (quotationId) {
        const quotation = await Quotation.findById(quotationId).populate('rfq');
        if (!quotation) {
          socket.emit('error', { message: 'Quotation not found' });
          return;
        }
        const rfq = await RFQ.findById(quotation.rfq);
        if (quotation.quotedBy.toString() !== socket.userId && 
            rfq.requestedBy.toString() !== socket.userId) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }
        if (receiver !== quotation.quotedBy.toString() && receiver !== rfq.requestedBy.toString()) {
          socket.emit('error', { message: 'Invalid receiver' });
          return;
        }
        room = `quotation-${quotationId}`;
      } else if (rfqId) {
        const rfq = await RFQ.findById(rfqId);
        if (!rfq) {
          socket.emit('error', { message: 'RFQ not found' });
          return;
        }
        if (rfq.requestedBy.toString() !== socket.userId) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }
        room = `rfq-${rfqId}`;
      } else if (productId) {
        // Use native MongoDB driver to bypass Mongoose buffering
        const product = await getProductWithShop(productId);
        if (!product) {
          socket.emit('error', { message: 'Product not found' });
          return;
        }
        // Verify receiver is shop owner or sender is B2B buyer
        const shopOwnerId = product.shop?.owner?.toString() || product.shop?.owner?._id?.toString() || (product.shop?.owner instanceof mongoose.Types.ObjectId ? product.shop.owner.toString() : null);
        if (shopOwnerId !== receiver && socket.userId !== receiver) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }
        // Create consistent room name by sorting user IDs
        // This ensures both users join the same room regardless of who initiates
        const userIds = [socket.userId, receiver].sort();
        room = `product-${productId}-${userIds[0]}-${userIds[1]}`;
      }

      // Save message to database using native MongoDB driver (bypasses Mongoose buffering)
      const messageDoc = await saveMessageNative({
        quotation: quotationId || null,
        rfq: rfqId || null,
        product: productId || null,
        sender: socket.userId,
        receiver,
        message,
        attachments: attachments || []
      });

      // Format message for broadcast (convert ObjectId to string for JSON serialization)
      const formattedMessage = {
        _id: messageDoc._id.toString(),
        quotation: messageDoc.quotation ? messageDoc.quotation.toString() : null,
        rfq: messageDoc.rfq ? messageDoc.rfq.toString() : null,
        product: messageDoc.product ? messageDoc.product.toString() : null,
        sender: messageDoc.sender ? {
          _id: messageDoc.sender._id.toString(),
          username: messageDoc.sender.username,
          email: messageDoc.sender.email,
          profile: messageDoc.sender.profile
        } : null,
        receiver: messageDoc.receiver.toString(),
        message: messageDoc.message,
        attachments: messageDoc.attachments || [],
        readAt: messageDoc.readAt || null,
        createdAt: messageDoc.createdAt
      };

      // Log room and receiver info for debugging
      const roomSockets = await io.in(room).fetchSockets();
      const receiverSockets = await io.in(`user-${receiver}`).fetchSockets();
      console.log(`📊 [send-message] Room: ${room}, Sockets in room: ${roomSockets.length}`);
      console.log(`📊 [send-message] Receiver: ${receiver}, Sockets in personal room: ${receiverSockets.length}`);

      // Broadcast to room
      io.to(room).emit('message-received', {
        message: formattedMessage,
        quotationId: quotationId || null,
        rfqId: rfqId || null,
        productId: productId || null
      });
      console.log(`📤 [send-message] Broadcasted to room: ${room}`);

      // Also send to receiver's personal room (if they're online)
      io.to(`user-${receiver}`).emit('new-message', {
        message: formattedMessage,
        quotationId: quotationId || null,
        rfqId: rfqId || null,
        productId: productId || null
      });
      console.log(`📤 [send-message] Sent to receiver's personal room: user-${receiver}`);

      console.log(`✅ [send-message] Message sent by ${socket.userId} to ${receiver} in room ${room}`);
    } catch (error) {
      console.error('❌ [send-message] Error:', error);
      console.error('   Error details:', { 
        message: error.message, 
        stack: error.stack,
        userId: socket.userId,
        receiver: data?.receiver,
        productId: data?.productId,
        quotationId: data?.quotationId,
        rfqId: data?.rfqId
      });
      socket.emit('error', { 
        message: `Failed to send message: ${error.message || 'Unknown error'}`,
        details: error.message
      });
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    const { quotationId, rfqId, productId, receiverId } = data;
    let room;
    
    if (productId && receiverId) {
      room = `product-${productId}-${receiverId}`;
    } else if (quotationId) {
      room = `quotation-${quotationId}`;
    } else if (rfqId) {
      room = `rfq-${rfqId}`;
    } else {
      return;
    }

    socket.to(room).emit('user-typing', {
      userId: socket.userId,
      typing: true
    });
  });

  // Stop typing indicator
  socket.on('stop-typing', (data) => {
    const { quotationId, rfqId, productId, receiverId } = data;
    let room;
    
    if (productId && receiverId) {
      room = `product-${productId}-${receiverId}`;
    } else if (quotationId) {
      room = `quotation-${quotationId}`;
    } else if (rfqId) {
      room = `rfq-${rfqId}`;
    } else {
      return;
    }

    socket.to(room).emit('user-typing', {
      userId: socket.userId,
      typing: false
    });
  });
};

