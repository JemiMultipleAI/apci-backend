import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { logger } from '../utils/logger';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { createError } from '../middleware/errorHandler';

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

      if (!token) {
        ws.close(1008, 'Authentication required');
        return;
      }

      // Verify token
      let user: TokenPayload;
      try {
        user = verifyAccessToken(token);
      } catch (error: any) {
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

      default:
        logger.warn('Unknown WebSocket message type:', { type: message.type, clientId });
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
