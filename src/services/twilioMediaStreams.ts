import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface MediaStreamMessage {
  event: 'connected' | 'start' | 'media' | 'stop';
  streamSid?: string;
  accountSid?: string;
  callSid?: string;
  tracks?: string[];
  media?: {
    track: 'inbound' | 'outbound';
    chunk: string; // Base64 encoded audio
    timestamp: string;
    payload?: string;
  };
  start?: {
    accountSid: string;
    callSid: string;
    tracks: string[];
    customParameters?: Record<string, string>;
  };
  stop?: {
    accountSid: string;
    callSid: string;
  };
}

export interface MediaStreamConnection {
  ws: WebSocket;
  callSid: string;
  accountSid: string;
  tracks: string[];
  connectedAt: Date;
  customParameters?: Record<string, string>;
}

// Store active media stream connections
const activeStreams = new Map<string, MediaStreamConnection>();

/**
 * Handle incoming Media Stream WebSocket connection from Twilio
 */
export function handleMediaStreamConnection(ws: WebSocket, req: any): void {
  let connection: MediaStreamConnection | null = null;
  let inboundTrackBuffer = '';
  let lastInboundTimestamp = 0;

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const message: MediaStreamMessage = JSON.parse(data.toString());

      switch (message.event) {
        case 'connected':
          logger.info('[MEDIA_STREAM] Connected', {
            accountSid: message.accountSid,
          });
          break;

        case 'start':
          if (message.start) {
            connection = {
              ws,
              callSid: message.start.callSid,
              accountSid: message.start.accountSid,
              tracks: message.start.tracks || [],
              connectedAt: new Date(),
              customParameters: message.start.customParameters,
            };
            activeStreams.set(message.start.callSid, connection);
            
            logger.info('[MEDIA_STREAM] Stream started', {
              callSid: message.start.callSid,
              accountSid: message.start.accountSid,
              tracks: message.start.tracks,
              customParameters: message.start.customParameters,
            });

            // Emit event for bridge to handle
            if (connection.customParameters) {
              const agentId = connection.customParameters.agent_id;
              const contactId = connection.customParameters.contact_id;
              const accountId = connection.customParameters.account_id;
              
              if (agentId) {
                // Trigger bridge connection
                import('./voiceCallBridge').then(({ startVoiceCallBridge }) => {
                  startVoiceCallBridge(
                    connection!,
                    agentId,
                    contactId,
                    accountId
                  ).catch((error: any) => {
                    logger.error('[MEDIA_STREAM] Failed to start bridge', {
                      callSid: connection!.callSid,
                      error: error.message,
                    });
                  });
                });
              }
            }
          }
          break;

        case 'media':
          if (message.media && connection) {
            // Only process inbound audio (from caller)
            if (message.media.track === 'inbound') {
              const timestamp = parseInt(message.media.timestamp, 10);
              
              // Decode base64 audio chunk (μ-law PCM, 8kHz, mono)
              const audioChunk = Buffer.from(message.media.chunk, 'base64');
              
              // Store for STT processing
              // We'll buffer and send to STT when we have enough audio or detect pause
              inboundTrackBuffer += message.media.chunk;
              lastInboundTimestamp = timestamp;

              // Emit audio chunk to bridge
              import('./voiceCallBridge').then(({ handleInboundAudio }) => {
                handleInboundAudio(connection!.callSid, audioChunk, timestamp);
              }).catch((error: any) => {
                logger.error('[MEDIA_STREAM] Failed to handle audio', {
                  callSid: connection!.callSid,
                  error: error.message,
                });
              });
            }
          }
          break;

        case 'stop':
          if (message.stop && connection) {
            logger.info('[MEDIA_STREAM] Stream stopped', {
              callSid: message.stop.callSid,
            });
            
            // Cleanup
            activeStreams.delete(message.stop.callSid);
            
            // Notify bridge to cleanup
            import('./voiceCallBridge').then(({ stopVoiceCallBridge }) => {
              stopVoiceCallBridge(message.stop!.callSid);
            }).catch((error: any) => {
              logger.error('[MEDIA_STREAM] Failed to stop bridge', {
                callSid: message.stop!.callSid,
                error: error.message,
              });
            });
          }
          break;
      }
    } catch (error: any) {
      logger.error('[MEDIA_STREAM] Error processing message', {
        error: error.message,
        stack: error.stack,
      });
    }
  });

  ws.on('error', (error: Error) => {
    logger.error('[MEDIA_STREAM] WebSocket error', {
      error: error.message,
      callSid: connection?.callSid,
    });
  });

  ws.on('close', () => {
    if (connection) {
      logger.info('[MEDIA_STREAM] WebSocket closed', {
        callSid: connection.callSid,
      });
      activeStreams.delete(connection.callSid);
      
      // Cleanup bridge
      import('./voiceCallBridge').then(({ stopVoiceCallBridge }) => {
        stopVoiceCallBridge(connection!.callSid);
      }).catch(() => {
        // Ignore cleanup errors
      });
    }
  });
}

/**
 * Send audio to Twilio Media Stream (outbound to caller)
 */
export function sendAudioToStream(callSid: string, audioChunk: Buffer): boolean {
  const connection = activeStreams.get(callSid);
  if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    // Encode audio as base64
    const base64Audio = audioChunk.toString('base64');
    const timestamp = Date.now().toString();

    const mediaMessage = {
      event: 'media',
      streamSid: connection.callSid,
      media: {
        track: 'outbound' as const,
        chunk: base64Audio,
        timestamp,
      },
    };

    connection.ws.send(JSON.stringify(mediaMessage));
    return true;
  } catch (error: any) {
    logger.error('[MEDIA_STREAM] Failed to send audio', {
      callSid,
      error: error.message,
    });
    return false;
  }
}

/**
 * Get active stream connection
 */
export function getActiveStream(callSid: string): MediaStreamConnection | undefined {
  return activeStreams.get(callSid);
}

/**
 * Get all active streams (for monitoring)
 */
export function getAllActiveStreams(): MediaStreamConnection[] {
  return Array.from(activeStreams.values());
}

