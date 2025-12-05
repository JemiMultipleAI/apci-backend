import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { AgentRequest } from '../models/mongodb/AgentRequest';
import { env } from '../config/env';

export interface AgentResponse {
  success: boolean;
  response?: string;
  error?: string;
  responseTimeMs?: number;
}

/**
 * Send a message to an ElevenLabs agent via WebSocket
 * For public agents, connects directly with agent_id
 */
export async function sendMessageToAgent(
  agentId: string,
  message: string,
  agentConfigId?: string,
  contactId?: string,
  accountId?: string,
  maxRetries: number = 3
): Promise<AgentResponse> {
  const startTime = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Exponential backoff: 0s, 1s, 2s, 4s
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 2), 4000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      logger.info('[ELEVENLABS] Sending message to agent', {
        attempt: `${attempt}/${maxRetries}`,
        agentId: agentId.substring(0, 8) + '...',
        messageLength: message.length,
      });

      const response = await sendMessageWithWebSocket(agentId, message, 30000); // 30 second timeout
      const responseTimeMs = Date.now() - startTime;

      // Log successful request
      if (isMongoDBAvailable()) {
        await AgentRequest.create({
          timestamp: new Date(),
          contact_id: contactId,
          account_id: accountId,
          agent_config_id: agentConfigId,
          agent_id: agentId,
          request_message: message,
          response_message: response.response,
          response_time_ms: responseTimeMs,
          success: true,
          rate_limited: false,
        }).catch((err: any) => logger.warn('Failed to log agent request', { error: err.message }));
      }

      return {
        success: true,
        response: response.response,
        responseTimeMs,
      };
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown error';
      logger.warn('[ELEVENLABS] Agent request failed', {
        attempt: `${attempt}/${maxRetries}`,
        agentId: agentId.substring(0, 8) + '...',
        error: errorMessage,
        errorType: error?.constructor?.name || typeof error,
        willRetry: attempt < maxRetries,
      });

      // If it's the last attempt, log the failure
      if (attempt === maxRetries) {
        const responseTimeMs = Date.now() - startTime;
        const isRateLimited = errorMessage.toLowerCase().includes('rate limit') ||
          errorMessage.toLowerCase().includes('429');

        if (isMongoDBAvailable()) {
          await AgentRequest.create({
            timestamp: new Date(),
            contact_id: contactId,
            account_id: accountId,
            agent_config_id: agentConfigId,
            agent_id: agentId,
            request_message: message,
            response_time_ms: responseTimeMs,
            success: false,
            error: errorMessage,
            rate_limited: isRateLimited,
          }).catch((err: any) => logger.warn('Failed to log agent request failure', { error: err.message }));
        }
      }
    }
  }

  const finalResponseTimeMs = Date.now() - startTime;
  const finalErrorMessage = lastError?.message || lastError?.toString() || String(lastError) || 'Failed to get response from agent after retries';

  return {
    success: false,
    error: finalErrorMessage,
    responseTimeMs: finalResponseTimeMs,
  };
}

/**
 * Send message via WebSocket with timeout
 */
function sendMessageWithWebSocket(
  agentId: string,
  message: string,
  timeoutMs: number
): Promise<{ response: string }> {
  return new Promise((resolve, reject) => {
    // Store user message to avoid shadowing in message handler
    const userMessage = message;
    
    // WebSocket URL for public agents (original implementation)
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;

    // Add optional headers if API key is available (may be needed for some agents)
    const headers: Record<string, string> = {};
    if (env.ELEVENLABS_API_KEY) {
      headers['xi-api-key'] = env.ELEVENLABS_API_KEY;
    }

    const ws = new WebSocket(wsUrl, {
      headers,
    });
    let responseReceived = false;
    let timeout: NodeJS.Timeout;
    let agentResponse = '';
    let userMessageSent = false; // Track if we've sent the user message
    let greetingReceived = false; // Track if we've received the greeting
    let sessionStarted = false; // Track if session is confirmed started
    let connectionState: 'connecting' | 'open' | 'ready' | 'completed' | 'error' | 'closed' = 'connecting'; // Track connection state

    // Set timeout
    timeout = setTimeout(() => {
      if (!responseReceived) {
        connectionState = 'error';
        ws.close();
        reject(new Error('Agent response timeout after 30 seconds'));
      }
    }, timeoutMs);

    // Handle connection open
    ws.on('open', () => {
      connectionState = 'open';
      logger.info('[ELEVENLABS] WebSocket connected to agent', {
        agentId: agentId.substring(0, 8) + '...',
      });

      // Send initial message to start the session
      try {
        const sessionStartMessage = {
          type: 'session_start',
          agent_id: agentId,
          override: {
            skip_greeting: false, // Let greeting happen
          }
        };
        ws.send(JSON.stringify(sessionStartMessage));
        logger.debug('[ELEVENLABS] Sent session_start message', {
          agentId: agentId.substring(0, 8) + '...',
        });
      } catch (error: any) {
        clearTimeout(timeout);
        connectionState = 'error';
        const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown error';
        logger.error('[ELEVENLABS] Failed to send session_start', {
          agentId: agentId.substring(0, 8) + '...',
          error: errorMessage,
        });
        reject(new Error(`Failed to send initial message: ${errorMessage}`));
      }
    });

    // Handle incoming messages
    ws.on('message', (data: WebSocket.Data) => {
      try {
        const rawMessage = data.toString();
        const message = JSON.parse(rawMessage);

        // Only log full message details for errors/warnings or unhandled types
        if (message.type === 'error' || message.type === 'warning' || 
            !['agent_response', 'message', 'response', 'agent_response_correction', 
              'ping', 'pong', 'status', 'conversation_initiation_metadata', 
              'metadata', 'audio', 'audio_chunk', 'session_started', 'session_ready', 'ready'].includes(message.type)) {
          logger.debug('[ELEVENLABS] Received message', {
            agentId: agentId.substring(0, 8) + '...',
            messageType: message.type,
            fullMessage: JSON.stringify(message),
          });
        }

        // Handle session confirmation
        if (message.type === 'session_started' || message.type === 'session_ready' || message.type === 'ready') {
          sessionStarted = true;
          connectionState = 'ready';
          logger.debug('[ELEVENLABS] Session confirmed started', {
            agentId: agentId.substring(0, 8) + '...',
            messageType: message.type,
          });
          // Don't return - continue to check for greeting
        }

        // Also treat greeting as session confirmation (if no explicit session_started received)
        if ((message.type === 'agent_response' || message.type === 'message' || message.type === 'response') && !sessionStarted) {
          sessionStarted = true;
          connectionState = 'ready';
          logger.debug('[ELEVENLABS] Session confirmed via greeting', {
            agentId: agentId.substring(0, 8) + '...',
          });
        }

        // Handle errors and warnings - log them all
        if (message.type === 'error' || message.type === 'warning' || message.error || message.warning) {
          const errorMsg = message.error || message.warning || message.message || 'Agent returned an error/warning';
          logger.error('[ELEVENLABS] Agent returned error/warning message', {
            agentId: agentId.substring(0, 8) + '...',
            messageType: message.type,
            error: errorMsg,
            fullMessage: JSON.stringify(message),
          });
          
          // Only reject if it's a critical error (not a warning)
          if (message.type === 'error' && !responseReceived) {
            clearTimeout(timeout);
            connectionState = 'error';
            ws.close();
            reject(new Error(`Agent error: ${errorMsg}. Full message: ${JSON.stringify(message)}`));
            return;
          }
        }

        // Handle greeting/correction - these come first, then we send our user message
        if (!userMessageSent) {
          if (message.type === 'agent_response' || message.type === 'message' || message.type === 'response') {
            // This is the greeting - mark it as received
            greetingReceived = true;
            logger.debug('[ELEVENLABS] Received greeting, sending user message', {
              agentId: agentId.substring(0, 8) + '...',
            });
            
            // Wait a bit for session to fully establish before sending user message
            // This ensures the session state is properly maintained
            setTimeout(() => {
              if (!userMessageSent) {
                try {
                  const userMessagePayload = {
                    type: 'user_message',
                    text: userMessage
                  };
                  ws.send(JSON.stringify(userMessagePayload));
                  logger.debug('[ELEVENLABS] Sent user message', {
                    agentId: agentId.substring(0, 8) + '...',
                    messageLength: userMessage.length,
                  });
                  userMessageSent = true;
                } catch (error: any) {
                  clearTimeout(timeout);
                  connectionState = 'error';
                  const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown error';
                  logger.error('[ELEVENLABS] Failed to send user message', {
                    agentId: agentId.substring(0, 8) + '...',
                    error: errorMessage,
                  });
                  reject(new Error(`Failed to send message: ${errorMessage}`));
                }
              }
            }, 500); // 500ms delay to ensure session is ready
            return; // Don't resolve on greeting
          } else if (message.type === 'agent_response_correction') {
            // This is a correction to the greeting - if we haven't sent user message yet,
            // send it now (correction means greeting is complete)
            if (!greetingReceived) {
              greetingReceived = true;
              logger.debug('[ELEVENLABS] Received greeting correction, sending user message', {
                agentId: agentId.substring(0, 8) + '...',
              });
              
              // Wait a bit for session to fully establish before sending user message
              setTimeout(() => {
                if (!userMessageSent) {
                  try {
                    const userMessagePayload = {
                      type: 'user_message',
                      text: userMessage
                    };
                    ws.send(JSON.stringify(userMessagePayload));
                    logger.debug('[ELEVENLABS] Sent user message', {
                      agentId: agentId.substring(0, 8) + '...',
                      messageLength: userMessage.length,
                    });
                    userMessageSent = true;
                  } catch (error: any) {
                    clearTimeout(timeout);
                    connectionState = 'error';
                    const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown error';
                    logger.error('[ELEVENLABS] Failed to send user message after correction', {
                      agentId: agentId.substring(0, 8) + '...',
                      error: errorMessage,
                    });
                    reject(new Error(`Failed to send message: ${errorMessage}`));
                  }
                }
              }, 500); // 500ms delay to ensure session is ready
            }
            return; // Don't resolve on correction
          }
        }

        // Handle response to our user message (only after we've sent it)
        if ((message.type === 'agent_response' || message.type === 'message' || message.type === 'response') && userMessageSent) {
          // Extract response text from various possible fields
          agentResponse = message.agent_response_event?.agent_response ||
            message.message ||
            message.content ||
            message.text ||
            message.response ||
            message.data || '';

          // Only resolve if we actually got a response
          if (agentResponse.trim()) {
            logger.info('[ELEVENLABS] Received agent response', {
              agentId: agentId.substring(0, 8) + '...',
              responseLength: agentResponse.length,
              responsePreview: agentResponse.substring(0, 100),
            });
            responseReceived = true;
            connectionState = 'completed';
            clearTimeout(timeout);
            ws.close();
            resolve({ response: agentResponse });
            return;
          } else {
            logger.warn('[ELEVENLABS] Received empty agent response', {
              agentId: agentId.substring(0, 8) + '...',
              messageType: message.type,
            });
          }
        } else if (message.type === 'agent_response_correction' && userMessageSent) {
          // Correction to the response - use the corrected version
          const correctedResponse = message.agent_response_correction_event?.corrected_agent_response || '';
          if (correctedResponse.trim()) {
            logger.info('[ELEVENLABS] Received corrected agent response', {
              agentId: agentId.substring(0, 8) + '...',
              responseLength: correctedResponse.length,
              responsePreview: correctedResponse.substring(0, 100),
            });
            agentResponse = correctedResponse;
            responseReceived = true;
            connectionState = 'completed';
            clearTimeout(timeout);
            ws.close();
            resolve({ response: agentResponse });
            return;
          }
        } else if (message.type === 'ping' || message.type === 'pong' || message.type === 'status' ||
          message.type === 'conversation_initiation_metadata' || message.type === 'metadata' ||
          message.type === 'audio' || message.type === 'audio_chunk') {
          // These are keepalive/status/metadata messages, don't treat as response
          logger.debug('[ELEVENLABS] Received status/keepalive/metadata message', {
            agentId: agentId.substring(0, 8) + '...',
            type: message.type,
            connectionState,
          });
          return;
        } else {
          // Other message types - log with full details for debugging
          logger.debug('[ELEVENLABS] Unhandled message type', {
            agentId: agentId.substring(0, 8) + '...',
            type: message.type,
            fullMessage: JSON.stringify(message),
          });
        }
      } catch (error: any) {
        // If message is not JSON, treat as plain text response
        const textResponse = data.toString();
        logger.warn('[ELEVENLABS] Failed to parse message as JSON', {
          agentId: agentId.substring(0, 8) + '...',
          error: error?.message || error?.toString(),
          textLength: textResponse.length,
        });

        // Only treat as response if it's not a keepalive message
        if (textResponse.trim() && !textResponse.trim().match(/^(ping|pong|status)$/i)) {
          logger.info('[ELEVENLABS] Received plain text response', {
            agentId: agentId.substring(0, 8) + '...',
            responseLength: textResponse.length,
            responsePreview: textResponse.substring(0, 100),
          });
          agentResponse = textResponse;
          responseReceived = true;
          connectionState = 'completed';
          clearTimeout(timeout);
          ws.close();
          resolve({ response: agentResponse });
        } else {
          logger.debug('[ELEVENLABS] Ignoring keepalive text message', {
            agentId: agentId.substring(0, 8) + '...',
            text: textResponse,
          });
        }
      }
    });

    // Handle errors
    ws.on('error', (error: Error) => {
      connectionState = 'error';
      const errorMessage = error?.message || error?.toString() || String(error) || 'Unknown WebSocket error';
      logger.error('[ELEVENLABS] WebSocket error', {
        agentId: agentId.substring(0, 8) + '...',
        error: errorMessage,
        errorStack: error?.stack,
      });
      clearTimeout(timeout);
      if (!responseReceived) {
        reject(new Error(`WebSocket error: ${errorMessage}`));
      }
    });

    // Handle connection close
    ws.on('close', (code: number, reason: Buffer) => {
      connectionState = 'closed';
      const reasonStr = reason.toString() || 'Connection closed';
      
      if (!responseReceived) {
        logger.warn('[ELEVENLABS] WebSocket closed before response', {
          agentId: agentId.substring(0, 8) + '...',
          code,
          reason: reasonStr,
        });
      } else {
        logger.debug('[ELEVENLABS] WebSocket closed after response', {
          agentId: agentId.substring(0, 8) + '...',
          code,
        });
      }

      // Code 1005 means "No Status Received" - connection closed abnormally without close frame
      if (code === 1005 && !responseReceived) {
        logger.warn('[ELEVENLABS] WebSocket closed abnormally without response (code 1005)', {
          agentId: agentId.substring(0, 8) + '...',
          code,
          reason: reasonStr,
        });
        clearTimeout(timeout);
        reject(new Error('WebSocket connection closed abnormally without receiving a response (code: 1005 - No Status Received). The connection may have timed out or been closed by the server.'));
        return;
      }

      // Code 1005 means "No Status Received" - connection closed abnormally without close frame
      if (code === 1005 && !responseReceived) {
        logger.warn('[ELEVENLABS] WebSocket closed abnormally without response (code 1005)', {
          agentId: agentId.substring(0, 8) + '...',
          code,
          reason: reasonStr,
        });
        clearTimeout(timeout);
        reject(new Error('WebSocket connection closed abnormally without receiving a response (code: 1005 - No Status Received). The connection may have timed out or been closed by the server.'));
        return;
      }

      if (!responseReceived) {
        clearTimeout(timeout);
        // Provide more context in the error message
        const errorMsg = code === 1006
          ? 'WebSocket connection closed abnormally (no response received)'
          : code === 1000
            ? `WebSocket closed normally without response: ${reasonStr}`
            : `WebSocket closed without response: ${reasonStr} (code: ${code})`;
        reject(new Error(errorMsg));
      }
    });
  });
}

/**
 * Check if MongoDB is available
 */
function isMongoDBAvailable(): boolean {
  try {
    const mongoose = require('mongoose');
    return mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
}

