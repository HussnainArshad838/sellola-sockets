const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Try to load config from Backend if .env is not available
let MONGODB_URI = process.env.MONGODB_URI;
let JWT_SECRET = process.env.JWT_SECRET;

if (!MONGODB_URI || !JWT_SECRET) {
  try {
    // Try to load from Backend config
    const backendConfig = require('../Backend/config');
    MONGODB_URI = MONGODB_URI || backendConfig.MONGODB_URI;
    JWT_SECRET = JWT_SECRET || backendConfig.JWT_SECRET;
    console.log('📦 Using Backend config for MongoDB and JWT');
  } catch (error) {
    console.warn('⚠️  Could not load Backend config, using .env only');
  }
}

// Don't load socketHandlers yet - wait for DB connection
// const socketHandlers = require('./socketHandlers');

const app = express();
const server = http.createServer(app);

// CORS configuration - parse comma-separated origins
const corsOrigins = process.env.CORS_ORIGIN 
  ? (process.env.CORS_ORIGIN === '*' 
      ? '*' 
      : process.env.CORS_ORIGIN.split(',').map(o => o.trim()))
  : '*';

const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware - configure CORS for HTTP requests
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin
    if (!origin) return callback(null, true);
    
    // Parse CORS_ORIGIN - can be comma-separated string or '*'
    const allowedOrigins = process.env.CORS_ORIGIN === '*' 
      ? ['*'] 
      : (process.env.CORS_ORIGIN || '*').split(',').map(o => o.trim());
    
    // If '*' is in allowed origins, allow all
    if (allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'WebSocket Server',
    timestamp: new Date().toISOString()
  });
});

// Track DB connection state
let dbConnected = false;

// Connect to MongoDB
const connectDB = async () => {
  try {
    const mongoUri = MONGODB_URI || process.env.MONGODB_URI;
    if (!mongoUri) {
      console.error('❌ MONGODB_URI is not set');
      console.error('💡 Please create a .env file in SocketServer folder or ensure Backend/config.js has MONGODB_URI');
      process.exit(1);
    }
    
    // Disable Mongoose buffering globally to prevent timeout errors
    mongoose.set('bufferCommands', false);
    
    // Add connection event listeners
    mongoose.connection.on('connected', () => {
      console.log('📡 MongoDB connection event: connected');
      dbConnected = true;
    });
    
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
      dbConnected = false;
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected');
      dbConnected = false;
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
      dbConnected = true;
    });
    
    // Wait for connection to be fully established
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    
    // Wait for connection to be fully ready with ping verification
    await new Promise((resolve, reject) => {
      const checkConnection = async () => {
        try {
          if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
            // Verify connection with a ping
            await mongoose.connection.db.admin().ping();
            
            // Force verify models are ready
            try {
              // Test that Product model is accessible
              const testCount = await mongoose.connection.db.collection('products').countDocuments({}, { limit: 1 });
              console.log('✅ Models verified and ready');
            } catch (error) {
              console.warn('⚠️  Model verification warning:', error.message);
            }
            
            dbConnected = true;
            console.log('✅ MongoDB connected for WebSocket server');
            console.log('📊 Connection state:', mongoose.connection.readyState);
            console.log('📊 Database name:', mongoose.connection.db?.databaseName);
            resolve();
          } else {
            // Wait for connection event
            mongoose.connection.once('connected', async () => {
              try {
                // Wait a bit for db to be available
                await new Promise(resolve => setTimeout(resolve, 200));
                await mongoose.connection.db.admin().ping();
                
                // Force verify models are ready
                try {
                  // Test that Product model is accessible
                  const testCount = await mongoose.connection.db.collection('products').countDocuments({}, { limit: 1 });
                  console.log('✅ Models verified and ready');
                } catch (error) {
                  console.warn('⚠️  Model verification warning:', error.message);
                }
                
                dbConnected = true;
                console.log('✅ MongoDB connected for WebSocket server');
                console.log('📊 Connection state:', mongoose.connection.readyState);
                console.log('📊 Database name:', mongoose.connection.db?.databaseName);
                resolve();
              } catch (error) {
                reject(error);
              }
            });
          }
        } catch (error) {
          reject(error);
        }
      };
      
      checkConnection();
    });
    
    // Wait a bit more to ensure everything is stable
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Load socket handlers after connection is fully established
    setupSocketHandlers();
    
    // Add connection health monitoring
    setInterval(() => {
      const state = mongoose.connection.readyState;
      if (state !== 1) {
        console.warn(`⚠️  Connection health check: State is ${state} (expected 1)`);
        dbConnected = false;
      } else {
        dbConnected = true;
      }
    }, 30000); // Check every 30 seconds
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.error('💡 Make sure MONGODB_URI is set correctly');
    dbConnected = false;
    process.exit(1);
  }
};

connectDB();

// Socket.io authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return next(new Error('Authentication token required'));
    }

    const secret = JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      return next(new Error('JWT_SECRET not configured'));
    }
    const decoded = jwt.verify(token, secret);
    socket.userId = decoded.userId;
    socket.userRole = decoded.role;
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

// Socket.io connection handler
// Load socketHandlers after DB connection
let socketHandlers = null;

// Wait for DB connection before setting up socket handlers
const setupSocketHandlers = () => {
  if (!socketHandlers && mongoose.connection.readyState === 1) {
    socketHandlers = require('./socketHandlers');
    console.log('✅ Socket handlers loaded');
  }
};

io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.userId}`);
  console.log(`📊 DB connection state: ${mongoose.connection.readyState} (1=connected, 0=disconnected)`);
  console.log(`📊 DB connected flag: ${dbConnected}`);

  // Join user's personal room
  socket.join(`user-${socket.userId}`);

  // Load socket handlers if DB is connected
  if (dbConnected && mongoose.connection.readyState === 1) {
    if (!socketHandlers) {
      setupSocketHandlers();
    }
    if (socketHandlers) {
      socketHandlers(io, socket);
      console.log(`✅ Socket handlers attached for user: ${socket.userId}`);
    } else {
      console.warn(`⚠️  Socket handlers not loaded for user: ${socket.userId}`);
      socket.emit('error', { message: 'Server not ready. Please try again.' });
    }
  } else {
    console.warn(`⚠️  Database not connected, socket handlers not available for user: ${socket.userId}`);
    console.warn(`   DB state: ${mongoose.connection.readyState}, dbConnected: ${dbConnected}`);
    socket.emit('error', { message: 'Server not ready. Please try again.' });
  }

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.userId}`);
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

