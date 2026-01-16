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
    payload: string; // Base64 encoded audio - this is what Twilio actually sends!
    timestamp: string;
    chunk?: string; // Legacy/optional field, but Twilio uses 'payload' (as per official example)
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
  streamSid?: string; // Stream SID from Twilio start event
  accountSid: string;
  tracks: string[];
  connectedAt: Date;
  lastMediaTimestamp?: number; // Track last timestamp sent (incremental, in milliseconds) - kept for potential future use
  customParameters?: Record<string, string>;
}

// Store active media stream connections
const activeStreams = new Map<string, MediaStreamConnection>();

// Connection statistics for monitoring
let connectionStats = {
  totalAttempts: 0,
  successful: 0,
  failed: 0,
  active: 0,
};

/**
 * Handle incoming Media Stream WebSocket connection from Twilio
 */
export function handleMediaStreamConnection(ws: WebSocket, req: any): void {
  connectionStats.totalAttempts++;
  connectionStats.active = activeStreams.size;
  
  // Connection timeout to prevent hanging connections
  // Only timeout if still CONNECTING (0), not if OPEN (1)
  const connectionTimeout = setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      logger.warn('[MEDIA_STREAM] Connection timeout - closing', {
        url: req.url,
        readyState: ws.readyState,
      });
      ws.close();
      connectionStats.failed++;
    } else {
      // Connection is open, clear timeout (shouldn't reach here as 'open' event clears it)
      logger.debug('[MEDIA_STREAM] Connection timeout cleared - connection is open', {
        readyState: ws.readyState,
      });
    }
  }, 10000); // 10 second timeout

  let connection: MediaStreamConnection | null = null;
  let inboundTrackBuffer = '';
  let lastInboundTimestamp = 0;
  let inboundChunkCount = 0; // Track number of inbound chunks received
  let lastInboundLogTime = 0; // Track when we last logged inbound audio

  // Get custom parameters from req (attached by setupMediaStreamsWebSocket in verifyClient)
  // Fallback to extracting from URL if not attached
  let customParameters: Record<string, string> = (req as any).customParameters || {};
  
  // Fallback: try to extract from URL if not already attached
  if (Object.keys(customParameters).length === 0 && req.url) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      url.searchParams.forEach((value, key) => {
        customParameters[key] = value;
      });
    } catch (error) {
      // URL parsing failed, customParameters stays empty
      logger.warn('[MEDIA_STREAM] Failed to parse URL for query parameters', {
        url: req.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // CRITICAL: Check if WebSocket is already OPEN when handler is attached
  // If so, handle it synchronously (the 'open' event won't fire)
  if (ws.readyState === WebSocket.OPEN) {
    clearTimeout(connectionTimeout);
    connectionStats.successful++;
    logger.debug('[MEDIA_STREAM] WebSocket already OPEN when handler attached', {
      totalAttempts: connectionStats.totalAttempts,
      successful: connectionStats.successful,
      readyState: ws.readyState,
      note: 'Connection was already open - will not receive "open" event',
    });
  }

  // CRITICAL: Attach message handler FIRST, before any other handlers
  // This ensures we catch Twilio's immediate 'connected' event
  // Twilio sends 'connected' event immediately after WebSocket opens
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
            // Use customParameters from the start event (from TwiML <Parameter> elements)
            // Fallback to URL-extracted parameters if start event doesn't have them
            const startCustomParams = message.start.customParameters || customParameters;
            
            connection = {
              ws,
              callSid: message.start.callSid,
              streamSid: message.streamSid, // Store streamSid from start event
              accountSid: message.start.accountSid,
              tracks: message.start.tracks || [],
              connectedAt: new Date(),
              lastMediaTimestamp: 0, // Initialize timestamp counter (incremental, in milliseconds) - kept for potential future use
              customParameters: startCustomParams,
            };
            activeStreams.set(message.start.callSid, connection);
            
            logger.info('[MEDIA_STREAM] Stream started', {
              callSid: message.start.callSid,
              streamSid: message.streamSid || 'NOT PROVIDED',
              accountSid: message.start.accountSid,
              tracks: message.start.tracks,
              customParameters: startCustomParams,
              fromStartEvent: !!message.start.customParameters,
              fromUrl: Object.keys(customParameters).length > 0 && !message.start.customParameters,
            });

            // Emit event for bridge to handle
            if (Object.keys(startCustomParams).length > 0) {
              const agentId = startCustomParams.agent_id;
              const contactId = startCustomParams.contact_id;
              const accountId = startCustomParams.account_id;
              const customIntroduction = startCustomParams.customIntroduction;
              const instructions = startCustomParams.instructions;
              
              logger.info('[MEDIA_STREAM] Extracted custom parameters', {
                callSid: message.start.callSid,
                agentId: agentId || 'MISSING',
                contactId: contactId || 'MISSING',
                accountId: accountId || 'MISSING',
                hasCustomIntroduction: !!customIntroduction,
                hasInstructions: !!instructions,
              });
              
              if (agentId) {
                // Trigger bridge connection (switchable between standard and optimized)
                const bridgeModule = env.VOICE_BRIDGE_MODE === 'optimized' 
                  ? './voiceCallBridgeOptimized' 
                  : './voiceCallBridge';
                import(bridgeModule).then(({ startVoiceCallBridge }) => {
                  startVoiceCallBridge(
                    connection!,
                    agentId,
                    contactId,
                    accountId,
                    customIntroduction,
                    instructions
                  ).catch((error: any) => {
                    logger.error('[MEDIA_STREAM] Failed to start bridge', {
                      callSid: connection!.callSid,
                      error: error.message,
                    });
                  });
                });
              } else {
                logger.warn('[MEDIA_STREAM] No agent_id in custom parameters - bridge will not start', {
                  callSid: message.start.callSid,
                  customParameters: startCustomParams,
                });
              }
            } else {
              logger.warn('[MEDIA_STREAM] No custom parameters found - bridge will not start', {
                callSid: message.start.callSid,
                url: req.url,
                startEventCustomParams: message.start.customParameters,
              });
            }
          }
          break;

        case 'media':
          if (message.media && connection) {
            // Process inbound audio (from caller) or outbound audio (to caller)
            if (message.media.track === 'inbound') {
              const timestamp = parseInt(message.media.timestamp, 10);
              
              // FIXED: Twilio sends audio data in 'payload' field, not 'chunk'!
              // According to official Twilio example: https://github.com/twilio/media-streams/blob/master/node/connect-basic/server.js
              // Line 107: Buffer.from(msg.media.payload, "base64")
              // This was causing the 3-byte chunks - we were reading from the wrong field!
              // FIXED: Use 'payload' field (per Twilio official example)
              const base64Chunk = message.media.payload || message.media.chunk || '';
              
              if (!base64Chunk) {
                return; // Skip silently if no audio data
              }
              
              const audioChunk = Buffer.from(base64Chunk, 'base64');
              inboundChunkCount++;
              
              // Reduced logging: Only log occasionally or if there's an issue
              const now = Date.now();
              const timeSinceLastLog = now - lastInboundLogTime;
              const shouldLog = inboundChunkCount <= 5 || // First 5 chunks
                                (timeSinceLastLog >= 10000 && audioChunk.length < 100) || // Every 10s if small
                                inboundChunkCount % 200 === 0; // Every 200th chunk
              
              if (shouldLog && audioChunk.length < 100) {
                logger.debug('[MEDIA_STREAM] Inbound audio chunk', {
                  callSid: connection.callSid,
                  chunkNumber: inboundChunkCount,
                  sizeBytes: audioChunk.length,
                  expectedBytes: 160,
                  note: audioChunk.length < 10 ? '⚠️ Very small chunk' : 'Chunk received',
                });
                lastInboundLogTime = now;
              }
              
              // Send to STT
              if (audioChunk.length > 0) {
                inboundTrackBuffer += base64Chunk;
                lastInboundTimestamp = timestamp;

                const bridgeModule = env.VOICE_BRIDGE_MODE === 'optimized' 
                  ? './voiceCallBridgeOptimized' 
                  : './voiceCallBridge';
                import(bridgeModule).then(({ handleInboundAudio }) => {
                  handleInboundAudio(connection!.callSid, audioChunk, timestamp);
                }).catch((error: any) => {
                  logger.error('[MEDIA_STREAM] Failed to handle audio', {
                    callSid: connection!.callSid,
                    error: error.message,
                  });
                });
              }
            } else if (message.media.track === 'outbound') {
              // FIXED: Use 'payload' field for outbound track too (same fix as inbound)
              const outboundBase64 = message.media.payload || message.media.chunk || '';
              if (outboundBase64) {
                inboundChunkCount++;
                if (inboundChunkCount % 200 === 0) {
                  const outboundChunk = Buffer.from(outboundBase64, 'base64');
                  logger.debug('[MEDIA_STREAM] Received outbound track audio (AI voice)', {
                    callSid: connection.callSid,
                    chunkNumber: inboundChunkCount,
                    track: message.media.track,
                    chunkSize: outboundChunk.length,
                    base64Size: outboundBase64.length,
                    timestamp: parseInt(message.media.timestamp, 10),
                    note: 'This confirms bidirectional stream is working - we receive both inbound (caller) and outbound (AI) tracks',
                  });
                }
              }
            }
          }
          break;

        case 'stop':
          if (message.stop && connection) {
            const callSid = message.stop.callSid;
            logger.info('[MEDIA_STREAM] Stream stopped', {
              callSid,
              reason: (message.stop as any).reason || 'unknown',
              timestamp: (message.stop as any).timestamp || 'not provided',
            });
            
            // Log connection stats before cleanup
            const chunkCount = (connection as any).chunkCount || 0;
            logger.info('[MEDIA_STREAM] Stream stop - connection stats', {
              callSid,
              chunksSent: chunkCount,
              streamSid: connection.streamSid,
              connectionDuration: Date.now() - connection.connectedAt.getTime(),
            });
            
            // Cleanup
            activeStreams.delete(callSid);
            
            // Notify bridge to cleanup (switchable between standard and optimized)
            const bridgeModule = env.VOICE_BRIDGE_MODE === 'optimized' 
              ? './voiceCallBridgeOptimized' 
              : './voiceCallBridge';
            import(bridgeModule).then(({ stopVoiceCallBridge }) => {
              stopVoiceCallBridge(callSid);
            }).catch((error: any) => {
              logger.error('[MEDIA_STREAM] Failed to stop bridge', {
                callSid,
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

  // Attach 'open' handler (will fire if connection is still CONNECTING)
  ws.on('open', () => {
    clearTimeout(connectionTimeout);
    connectionStats.successful++;
    logger.debug('[MEDIA_STREAM] WebSocket opened successfully', {
      totalAttempts: connectionStats.totalAttempts,
      successful: connectionStats.successful,
      failed: connectionStats.failed,
      active: connectionStats.active,
    });
  });

  logger.info('[MEDIA_STREAM] WebSocket connection established', {
    url: req.url,
    customParameters: Object.keys(customParameters).length > 0 ? customParameters : 'none',
    readyState: ws.readyState,
  });

  ws.on('error', (error: Error) => {
    clearTimeout(connectionTimeout);
    connectionStats.failed++;
    connectionStats.active = activeStreams.size;
    
    logger.error('[MEDIA_STREAM] WebSocket error', {
      callSid: connection?.callSid,
      error: error.message,
      stack: error.stack,
      stats: {
        totalAttempts: connectionStats.totalAttempts,
        successful: connectionStats.successful,
        failed: connectionStats.failed,
        active: connectionStats.active,
      },
    });
  });

  ws.on('close', (code: number, reason: Buffer) => {
    clearTimeout(connectionTimeout);
    
    if (connection) {
      activeStreams.delete(connection.callSid);
      connectionStats.active = activeStreams.size;
      
      logger.info('[MEDIA_STREAM] WebSocket closed', {
        callSid: connection.callSid,
        code,
        reason: reason.toString(),
        activeConnections: connectionStats.active,
      });
      
      // Cleanup bridge (switchable between standard and optimized)
      const bridgeModule = env.VOICE_BRIDGE_MODE === 'optimized' 
        ? './voiceCallBridgeOptimized' 
        : './voiceCallBridge';
      import(bridgeModule).then(({ stopVoiceCallBridge }) => {
        stopVoiceCallBridge(connection!.callSid);
      }).catch(() => {
        // Ignore cleanup errors
      });
    } else {
      logger.info('[MEDIA_STREAM] WebSocket closed (no connection established)', {
        code,
        reason: reason.toString(),
      });
    }
  });
}

/**
 * Send audio to Twilio Media Stream (outbound to caller)
 */
export function sendAudioToStream(callSid: string, audioChunk: Buffer): boolean {
  const connection = activeStreams.get(callSid);
  if (!connection) {
    // Don't log warning for every failed chunk after stream stops - only first few
    const logKey = `no_connection_${callSid}`;
    if (!(global as any)[logKey]) {
      (global as any)[logKey] = true;
      logger.warn('[MEDIA_STREAM] No connection found for callSid - stream likely stopped', { 
        callSid,
        note: 'This warning will be suppressed for subsequent attempts',
      });
      // Clear the flag after 5 seconds
      setTimeout(() => {
        delete (global as any)[logKey];
      }, 5000);
    }
    return false;
  }
  
  if (connection.ws.readyState !== WebSocket.OPEN) {
    const logKey = `ws_not_open_${callSid}`;
    if (!(global as any)[logKey]) {
      (global as any)[logKey] = true;
      const readyState = connection.ws.readyState;
      const readyStateMeaning = readyState === 0 ? 'CONNECTING' : 
                                readyState === 2 ? 'CLOSING' : 'CLOSED';
      logger.warn('[MEDIA_STREAM] WebSocket not open', { 
        callSid,
        readyState,
        readyStateMeaning,
        note: 'This warning will be suppressed for subsequent attempts',
      });
      setTimeout(() => {
        delete (global as any)[logKey];
      }, 5000);
    }
    return false;
  }

  try {
    // Encode audio as base64
    const base64Audio = audioChunk.toString('base64');
    
    // Track chunk count for logging
    if ((connection as any).chunkCount === undefined) {
      (connection as any).chunkCount = 0;
    }
    (connection as any).chunkCount = ((connection as any).chunkCount || 0) + 1;
    const chunkNumber = (connection as any).chunkCount;

    // Twilio Media Streams format for sending outbound audio
    // Based on ElevenLabs Twilio integration guide: https://elevenlabs.io/docs/developers/guides/cookbooks/text-to-speech/twilio
    // For bidirectional streams (Connect.Stream), we specify 'outbound' track in media message for outbound audio
    const mediaMessage = {
      event: 'media',
      streamSid: connection.streamSid || connection.callSid,
      media: {
        payload: base64Audio, // Base64-encoded μ-law 8kHz audio
        track: 'outbound', // Specify outbound track for outbound audio (to caller)
      },
    };

    // Validate μ-law format (μ-law bytes should be in range 0-255)
    const isValidMuLaw = audioChunk.every(byte => byte >= 0 && byte <= 255);
    const sampleBytes = audioChunk.slice(0, Math.min(10, audioChunk.length));
    const sampleHex = Array.from(sampleBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');

    // Log first message with full details
    if (chunkNumber === 1) {
      logger.info('[MEDIA_STREAM] Sending first audio message to Twilio', {
        callSid,
        streamSid: connection.streamSid || 'using callSid',
        messageStructure: {
          event: mediaMessage.event,
          streamSid: mediaMessage.streamSid,
          hasMedia: !!mediaMessage.media,
          hasPayload: !!mediaMessage.media.payload,
          payloadLength: mediaMessage.media.payload.length,
          payloadPreview: mediaMessage.media.payload.substring(0, 60) + '...',
        },
        audioData: {
          rawChunkSize: audioChunk.length,
          base64Size: base64Audio.length,
          isValidMuLaw: isValidMuLaw,
          sampleBytes: sampleHex,
          expectedFormat: 'μ-law 8kHz, 160 bytes per chunk (20ms)',
        },
        messageJson: JSON.stringify(mediaMessage).substring(0, 200) + '...',
      });
    }

    connection.ws.send(JSON.stringify(mediaMessage));
    
    // Log first 10 chunks, then every 50th chunk for debugging
    const shouldLog = chunkNumber <= 10 || chunkNumber % 50 === 0;
    if (shouldLog) {
      logger.info('[MEDIA_STREAM] Sent audio chunk to Twilio', {
        callSid,
        streamSid: connection.streamSid || 'using callSid',
        chunkNumber: chunkNumber,
        chunkSize: audioChunk.length,
        base64Size: base64Audio.length,
        isValidMuLaw: isValidMuLaw,
        websocketState: connection.ws.readyState === 1 ? 'OPEN' : `STATE_${connection.ws.readyState}`,
        note: 'Twilio expects μ-law 8kHz audio in base64 format - messages are buffered and played in order',
      });
    }
    
    return true;
  } catch (error: any) {
    logger.error('[MEDIA_STREAM] Failed to send audio', {
      callSid,
      error: error.message,
      stack: error.stack,
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

