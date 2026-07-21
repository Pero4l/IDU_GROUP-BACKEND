const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://rentulo.ng,http://localhost:3000')
  .split(',')
  .map((o) => o.trim());

module.exports = {
    init: (httpServer) => {
        io = socketIo(httpServer, {
            cors: {
                origin: function (origin, callback) {
                    if (!origin || allowedOrigins.includes(origin)) {
                        callback(null, true);
                    } else {
                        callback(new Error('Not allowed by CORS'));
                    }
                },
                methods: ['GET', 'POST']
            }
        });

        io.use((socket, next) => {
            const token = socket.handshake.auth?.token || socket.handshake.query?.token;
            if (!token) {
                return next(new Error('Authentication required'));
            }
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                socket.user = decoded;
                next();
            } catch (err) {
                return next(new Error('Invalid or expired token'));
            }
        });

        io.on('connection', (socket) => {
            console.log('New client connected:', socket.id);

            // Join a secure conversation room
            socket.on('join_conversation', (conversation_id) => {
                socket.join(`conversation_${conversation_id}`);
                console.log(`Socket ${socket.id} joined conversation_${conversation_id}`);
            });

            // Handle typing indicator optionally
            socket.on('typing', ({ conversation_id, sender_id }) => {
                socket.to(`conversation_${conversation_id}`).emit('user_typing', { sender_id, conversation_id });
            });

            socket.on('disconnect', () => {
                console.log('Client disconnected:', socket.id);
            });
        });

        return io;
    },
    getIo: () => {
        if (!io) {
            throw new Error('Socket.io not initialized!');
        }
        return io;
    }
};
