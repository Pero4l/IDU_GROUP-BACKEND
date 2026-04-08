const socketIo = require('socket.io');

let io;

module.exports = {
    init: (httpServer) => {
        io = socketIo(httpServer, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
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
