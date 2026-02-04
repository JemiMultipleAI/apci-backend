import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { logger } from '../utils/logger';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { createError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { startWebVoiceSession, handleWebAudio, stopWebVoiceSession } from './webVoiceBridge';

interface ClientConnection {
  ws: WebSocket;
  userId: string;
  companyId: string | null;
  subscriptions: Set<string>;
}

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientConnection> = new Map();

  /**
   * Initialize WebSocket server
   */
  initialize(server: Server): void {
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws',
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      this.handleConnection(ws, req);
    });

    logger.info('WebSocket server initialized', { path: '/ws' });
  }

  /**
   * Initialize WebSocket server with manual upgrade handling
   * Use this when you need to handle upgrades manually to bypass Express middleware
   */
  initializeWithManualUpgrade(): WebSocketServer {
    this.wss = new WebSocketServer({ 
      noServer: true, // Don't auto-handle upgrades
      path: '/ws',
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      this.handleConnection(ws, req);
    });

    logger.info('WebSocket server initialized with manual upgrade handling', { path: '/ws' });
    return this.wss;
  }

  /**
   * Handle new WebSocket connection
   * Made public so it can be called from manual upgrade handlers
   */
  async handleConnection(ws: WebSocket, req: any): Promise<void> {
    try {
      // Extract token from query string or headers
      const url = new URL(req.url || '', 'http://localhost');
      const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');

      logger.info('[WEBSOCKET] Connection attempt', {
        url: req.url,
        pathname: url.pathname,
        hasToken: !!token,
        tokenFromQuery: !!url.searchParams.get('token'),
        tokenFromHeader: !!req.headers.authorization,
        headers: {
          origin: req.headers.origin,
          'user-agent': req.headers['user-agent']?.substring(0, 50),
        },
      });

      if (!token) {
        logger.warn('[WEBSOCKET] ❌ Connection rejected - no token', {
          url: req.url,
          pathname: url.pathname,
          queryParams: Object.fromEntries(url.searchParams),
          headers: {
            authorization: req.headers.authorization ? 'present' : 'missing',
          },
        });
        ws.close(1008, 'Authentication required');
        return;
      }

      // Verify token
      let user: TokenPayload;
      try {
        user = verifyAccessToken(token);
        logger.debug('[WEBSOCKET] Token verified', {
          userId: user.userId,
          companyId: user.companyId,
          tokenPreview: token.substring(0, 20) + '...',
        });
      } catch (error: any) {
        logger.warn('[WEBSOCKET] ❌ Connection rejected - invalid token', {
          error: error.message,
          errorName: error.name,
          tokenPreview: token.substring(0, 20) + '...',
          tokenLength: token.length,
          jwtSecretSet: !!env.JWT_SECRET,
          jwtSecretLength: env.JWT_SECRET?.length || 0,
        });
        ws.close(1008, 'Invalid token');
        return;
      }

      const clientId = `${user.userId}-${Date.now()}`;
      const connection: ClientConnection = {
        ws,
        userId: user.userId,
        companyId: user.companyId || null,
        subscriptions: new Set(),
      };

      this.clients.set(clientId, connection);

      logger.info('WebSocket client connected', {
        clientId,
        userId: user.userId,
        companyId: user.companyId,
      });

      // Send welcome message
      this.sendToClient(clientId, {
        type: 'connected',
        clientId,
        timestamp: new Date().toISOString(),
      });

      // Handle messages from client
      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(clientId, message);
        } catch (error: any) {
          logger.error('WebSocket message parse error:', { error: error.message, clientId });
          this.sendToClient(clientId, {
            type: 'error',
            message: 'Invalid message format',
          });
        }
      });

      // Handle disconnect
      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info('WebSocket client disconnected', { clientId });
      });

      ws.on('error', (error: Error) => {
        logger.error('WebSocket error:', { error: error.message, clientId });
        this.clients.delete(clientId);
      });
    } catch (error: any) {
      logger.error('WebSocket connection error:', { error: error.message });
      ws.close(1011, 'Internal server error');
    }
  }

  /**
   * Handle message from client
   */
  private handleMessage(clientId: string, message: any): void {
    const connection = this.clients.get(clientId);
    if (!connection) {
      return;
    }

    switch (message.type) {
      case 'subscribe':
        // Subscribe to events
        if (message.channels && Array.isArray(message.channels)) {
          message.channels.forEach((channel: string) => {
            connection.subscriptions.add(channel);
          });
          this.sendToClient(clientId, {
            type: 'subscribed',
            channels: Array.from(connection.subscriptions),
          });
        }
        break;

      case 'unsubscribe':
        // Unsubscribe from events
        if (message.channels && Array.isArray(message.channels)) {
          message.channels.forEach((channel: string) => {
            connection.subscriptions.delete(channel);
          });
          this.sendToClient(clientId, {
            type: 'unsubscribed',
            channels: Array.from(connection.subscriptions),
          });
        }
        break;

      case 'ping':
        // Heartbeat
        this.sendToClient(clientId, { type: 'pong' });
        break;

      case 'voice_chat_start':
        // Start web voice session
        logger.info('[WEBSOCKET] ✅ Received voice_chat_start', {
          clientId,
          sessionId: message.sessionId,
          agentId: message.agentId || 'chatbot-test-agent',
          hasAccountId: !!message.accountId,
          hasContactId: !!message.contactId,
          hasInstructions: !!message.instructions,
          hasCustomIntroduction: !!message.customIntroduction,
        });
        this.handleVoiceChatStart(clientId, message, connection);
        break;

      case 'audio_data':
        // Handle audio data from browser
        this.handleVoiceAudioData(clientId, message);
        break;

      case 'voice_chat_end':
        // End web voice session
        this.handleVoiceChatEnd(clientId, message);
        break;

      default:
        logger.warn('Unknown WebSocket message type:', { type: message.type, clientId });
    }
  }

  /**
   * Handle voice chat start
   */
  private async handleVoiceChatStart(clientId: string, message: any, connection: ClientConnection): Promise<void> {
    try {
      const { sessionId, agentId, accountId, contactId, instructions, customIntroduction } = message;

      if (!sessionId) {
        this.sendToClient(clientId, {
          type: 'error',
          message: 'sessionId is required for voice_chat_start',
        });
        return;
      }

      await startWebVoiceSession(
        connection.ws,
        sessionId,
        connection.userId,
        agentId || 'chatbot-test-agent',
        accountId,
        contactId,
        instructions,
        customIntroduction
      );
    } catch (error: any) {
      logger.error('Error starting voice chat session:', { error: error.message, clientId });
      this.sendToClient(clientId, {
        type: 'error',
        message: 'Failed to start voice chat session',
      });
    }
  }

  /**
   * Handle audio data from browser
   */
  private handleVoiceAudioData(clientId: string, message: any): void {
    try {
      const { sessionId, audio, sampleRate } = message;

      if (!sessionId || !audio) {
        logger.warn('Missing sessionId or audio in audio_data message', { clientId });
        return;
      }

      // Decode base64 audio data
      const audioBuffer = Buffer.from(audio, 'base64');
      handleWebAudio(sessionId, audioBuffer, sampleRate || 16000);
    } catch (error: any) {
      logger.error('Error handling audio data:', { error: error.message, clientId });
    }
  }

  /**
   * Handle voice chat end
   */
  private handleVoiceChatEnd(clientId: string, message: any): void {
    try {
      const { sessionId } = message;

      if (!sessionId) {
        logger.warn('Missing sessionId in voice_chat_end message', { clientId });
        return;
      }

      stopWebVoiceSession(sessionId);
    } catch (error: any) {
      logger.error('Error ending voice chat session:', { error: error.message, clientId });
    }
  }

  /**
   * Send message to specific client
   */
  private sendToClient(clientId: string, message: any): void {
    const connection = this.clients.get(clientId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      connection.ws.send(JSON.stringify(message));
    } catch (error: any) {
      logger.error('WebSocket send error:', { error: error.message, clientId });
    }
  }

  /**
   * Broadcast message to all clients (or filtered by company)
   */
  broadcast(message: any, filter?: { companyId?: string; userId?: string; channels?: string[] }): void {
    this.clients.forEach((connection, clientId) => {
      // Apply filters
      if (filter?.companyId && connection.companyId !== filter.companyId) {
        return;
      }
      if (filter?.userId && connection.userId !== filter.userId) {
        return;
      }
      if (filter?.channels && filter.channels.length > 0) {
        const hasSubscription = filter.channels.some(channel => 
          connection.subscriptions.has(channel)
        );
        if (!hasSubscription) {
          return;
        }
      }

      this.sendToClient(clientId, message);
    });
  }

  /**
   * Send notification to specific user
   */
  notifyUser(userId: string, notification: any): void {
    this.clients.forEach((connection, clientId) => {
      if (connection.userId === userId) {
        this.sendToClient(clientId, {
          type: 'notification',
          ...notification,
        });
      }
    });
  }

  /**
   * Send notification to all users in a company
   */
  notifyCompany(companyId: string, notification: any): void {
    this.broadcast(
      {
        type: 'notification',
        ...notification,
      },
      { companyId }
    );
  }

  /**
   * Publish event to subscribed clients
   */
  publishEvent(channel: string, event: any): void {
    this.broadcast(
      {
        type: 'event',
        channel,
        data: event,
        timestamp: new Date().toISOString(),
      },
      { channels: [channel] }
    );
  }

  /**
   * Get connected clients count
   */
  getConnectedCount(): number {
    return this.clients.size;
  }

  /**
   * Close WebSocket server
   */
  close(): void {
    if (this.wss) {
      this.clients.forEach((connection) => {
        connection.ws.close();
      });
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      logger.info('WebSocket server closed');
    }
  }
}

export const websocketService = new WebSocketService();
