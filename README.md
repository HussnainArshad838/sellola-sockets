# Sellola WebSocket Server

Standalone WebSocket server for real-time messaging in the RFQ Quotation system.

## Features

- Real-time chat for quotations
- Real-time chat for RFQs
- Typing indicators
- JWT authentication
- MongoDB integration

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file in SocketServer folder:
```bash
# Copy from Backend/environment.js or create manually
```

3. Add these environment variables to `.env`:
```env
PORT=3001
MONGODB_URI=mongodb+srv://hussnainrajpoot5415:YOUR_PASSWORD@blogsdb.9xfkjee.mongodb.net/sellola?retryWrites=true&w=majority&appName=blogsdb
JWT_SECRET=sellola Atif khan
CORS_ORIGIN=http://localhost:3000
NODE_ENV=development
```

**Important:** Replace `YOUR_PASSWORD` with your actual MongoDB password (same as Backend uses).

## Running

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

## Deployment

### Railway.app (Recommended)

1. Create new project on Railway
2. Connect GitHub repository
3. Set root directory to `SocketServer`
4. Add environment variables
5. Deploy

### Render.com

1. Create new Web Service
2. Connect GitHub repository
3. Set root directory to `SocketServer`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables
7. Deploy

## Environment Variables

- `PORT` - Server port (default: 3001)
- `MONGODB_URI` - MongoDB connection string
- `JWT_SECRET` - JWT secret (same as main backend)
- `CORS_ORIGIN` - Allowed CORS origins (comma-separated)
- `NODE_ENV` - Environment (development/production)

## Socket Events

### Client → Server

- `join-quotation-room` - Join quotation chat room
- `join-rfq-room` - Join RFQ chat room
- `leave-room` - Leave a room
- `send-message` - Send a message
- `typing` - User is typing
- `stop-typing` - User stopped typing

### Server → Client

- `joined-room` - Confirmation of joining room
- `message-received` - New message received
- `new-message` - New message (personal notification)
- `user-typing` - User typing indicator
- `error` - Error occurred

## Authentication

Clients must provide JWT token in:
- `socket.handshake.auth.token` OR
- `Authorization` header as `Bearer <token>`

