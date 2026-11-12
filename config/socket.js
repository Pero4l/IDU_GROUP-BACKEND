const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

const { allowedOrigins } = require('./allowedOrigins');

module.exports = {
    init: (httpServer) => {
        io = socketIo(httpServer, {
            cors: {
                origin: function (origin, callback) {
                    if (!origin || allowedOrigins.includes(origin)) {
                        callback(null, true);
                    } else {
                        callback(new Error(`Not allowed by CORS: ${origin}`));
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

            // Join a conversation room — only its two participants (or an
            // admin, same rule as GET /chat/message/:id) may listen to it.
            // Previously any logged-in user could join any room and receive
            // other people's messages live.
            // Optional ack: socket.emit('join_conversation', id, (res) => ...)
            //   res = { success: true } | { success: false, message }
            socket.on('join_conversation', async (conversation_id, ack) => {
                const reply = (res) => {
                    if (typeof ack === 'function') ack(res);
                    if (!res.success) socket.emit('join_error', { conversation_id, message: res.message });
                };
                try {
                    const { Conversations } = require('../models');
                    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(conversation_id));
                    const conversation = isUuid ? await Conversations.findByPk(conversation_id) : null;
                    if (!conversation) return reply({ success: false, message: 'Conversation not found' });

                    const userId = String(socket.user.userId || socket.user.id || '');
                    const isParticipant = [conversation.tenant_id, conversation.landlord_id].map(String).includes(userId);
                    const isAdmin = socket.user.role === 'admin';
                    if (!isParticipant && !isAdmin) {
                        return reply({ success: false, message: 'Not authorized to join this conversation' });
                    }
                    socket.join(`conversation_${conversation.id}`);
                    reply({ success: true });
                } catch (error) {
                    console.error('join_conversation error:', error.message);
                    reply({ success: false, message: 'Could not join the conversation' });
                }
            });

            // Typing indicator — only from a room the socket has joined, and
            // the sender is always the authenticated user (a client-supplied
            // sender_id was trusted before, so anyone could fake "typing").
            socket.on('typing', ({ conversation_id } = {}) => {
                const room = `conversation_${conversation_id}`;
                if (!socket.rooms.has(room)) return;
                socket.to(room).emit('user_typing', { sender_id: socket.user.userId || socket.user.id, conversation_id });
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
