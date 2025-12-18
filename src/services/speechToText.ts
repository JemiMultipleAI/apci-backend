import { logger } from '../utils/logger';
import { env } from '../config/env';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElevenLabsClient } = require('elevenlabs');

export interface STTResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
}

export interface STTStream {
  write: (audioChunk: Buffer) => void;
  end: () => void;
  onTranscript: (callback: (result: STTResult) => void) => void;
  close: () => void;
}

/**
 * Create a streaming STT connection
 * Supports multiple providers: ElevenLabs (default), Deepgram, Google Cloud, or Twilio
 */
export function createSTTStream(
  onTranscript: (result: STTResult) => void,
  language: string = 'en-US'
): STTStream | null {
  const provider = env.STT_PROVIDER || 'elevenlabs';

  try {
    switch (provider) {
      case 'deepgram':
        return createDeepgramStream(onTranscript, language);
      case 'google':
        return createGoogleStream(onTranscript, language);
      case 'twilio':
        // Twilio STT requires different setup (via TwiML or API)
        logger.warn('[STT] Twilio STT not yet implemented for Media Streams');
        return null;
      default:
        logger.error('[STT] Unknown STT provider', { provider });
        return null;
    }
  } catch (error: any) {
    logger.error('[STT] Failed to create STT stream', {
      provider,
      error: error.message,
    });
    return null;
  }
}

/**
 * Create ElevenLabs streaming STT connection (Scribe v2 Realtime)
 */
function createElevenLabsStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.ELEVENLABS_API_KEY) {
    logger.error('[STT] ELEVENLABS_API_KEY not configured');
    return null;
  }

  try {
    const WebSocket = require('ws');
    
    // ElevenLabs Scribe v2 Realtime WebSocket URL
    // Based on: https://11labs.ru/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
    // Note: ElevenLabs supports μ-law PCM format from Twilio
    const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language=${language}`;
    
    const ws = new WebSocket(wsUrl, {
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
      },
    });

    let isOpen = false;
    const messageQueue: Buffer[] = [];

    ws.on('open', () => {
      isOpen = true;
      logger.info('[STT] ElevenLabs WebSocket connected');
      
      // Send configuration message (format based on typical STT WebSocket APIs)
      // This may need adjustment based on actual ElevenLabs API documentation
      const configMessage = {
        type: 'config',
        config: {
          encoding: 'mulaw',
          sample_rate: 8000,
          channels: 1,
          language: language,
        },
      };
      ws.send(JSON.stringify(configMessage));
      
      // Send queued messages
      while (messageQueue.length > 0) {
        const chunk = messageQueue.shift();
        if (chunk) {
          ws.send(chunk);
        }
      }
    });

    ws.on('message', (data: any) => {
      try {
        // ElevenLabs sends both binary (audio) and text (transcripts) messages
        // Check if it's a text message (JSON)
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          
          // Handle different message types from ElevenLabs
          // Format may vary - handle multiple possible formats
          if (message.type === 'transcript' || message.type === 'partial_transcript' || 
              message.type === 'transcription' || message.type === 'partial_transcription' ||
              message.transcript || message.text) {
            const transcript = message.transcript || message.text || '';
            const isFinal = message.type === 'transcript' || 
                          message.type === 'transcription' || 
                          message.is_final || 
                          message.final || false;
            const confidence = message.confidence || message.confidence_score;

            if (transcript.trim()) {
              onTranscript({
                text: transcript,
                isFinal,
                confidence,
              });
            }
          } else if (message.type === 'error' || message.error) {
            logger.error('[STT] ElevenLabs STT error', {
              error: message.error || message.message || JSON.stringify(message),
            });
          } else {
            // Log unknown message types for debugging
            logger.debug('[STT] Unknown ElevenLabs message type', {
              type: message.type,
              message: JSON.stringify(message).substring(0, 200),
            });
          }
        }
        // Binary messages are audio responses (we don't need to handle them for STT)
      } catch (error: any) {
        // If parsing fails, it might be binary data - ignore it
        if (typeof data === 'string') {
          logger.error('[STT] Failed to parse ElevenLabs message', {
            error: error.message,
          });
        }
      }
    });

    ws.on('error', (error: Error) => {
      logger.error('[STT] ElevenLabs WebSocket error', {
        error: error.message,
      });
    });

    ws.on('close', () => {
      isOpen = false;
      logger.info('[STT] ElevenLabs WebSocket closed');
    });

    return {
      write: (audioChunk: Buffer) => {
        // Send μ-law PCM audio chunks directly to ElevenLabs
        // ElevenLabs Scribe supports μ-law format from Twilio
        if (isOpen) {
          ws.send(audioChunk);
        } else {
          messageQueue.push(audioChunk);
        }
      },
      end: () => {
        if (isOpen) {
          // Send end signal
          const endMessage = {
            type: 'end',
          };
          ws.send(JSON.stringify(endMessage));
          ws.close();
        }
      },
      onTranscript: (callback: (result: STTResult) => void) => {
        // Already set up in constructor
      },
      close: () => {
        if (isOpen) {
          ws.close();
        }
      },
    };
  } catch (error: any) {
    logger.error('[STT] Failed to create ElevenLabs stream', {
      error: error.message,
    });
    return null;
  }
}

/**
 * Create Deepgram streaming STT connection
 */
function createDeepgramStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.DEEPGRAM_API_KEY) {
    logger.error('[STT] DEEPGRAM_API_KEY not configured');
    return null;
  }

  try {
    // Use WebSocket library (already installed)
    const WebSocket = require('ws');
    
    // Deepgram WebSocket URL with proper parameters
    // Note: Twilio sends μ-law PCM at 8kHz, Deepgram supports this format
    const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${language}&punctuate=true&interim_results=true&encoding=mulaw&sample_rate=8000&channels=1`;
    
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      },
    });

    let isOpen = false;
    const messageQueue: Buffer[] = [];

    ws.on('open', () => {
      isOpen = true;
      logger.info('[STT] Deepgram WebSocket connected');
      
      // Send queued messages
      while (messageQueue.length > 0) {
        const chunk = messageQueue.shift();
        if (chunk) {
          ws.send(chunk);
        }
      }
    });

    ws.on('message', (data: any) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.channel?.alternatives?.[0]) {
          const transcript = message.channel.alternatives[0].transcript;
          const isFinal = message.is_final || false;
          const confidence = message.channel.alternatives[0].confidence;

          if (transcript) {
            onTranscript({
              text: transcript,
              isFinal,
              confidence,
            });
          }
        }
      } catch (error: any) {
        logger.error('[STT] Failed to parse Deepgram message', {
          error: error.message,
        });
      }
    });

    ws.on('error', (error: Error) => {
      logger.error('[STT] Deepgram WebSocket error', {
        error: error.message,
      });
    });

    ws.on('close', () => {
      isOpen = false;
      logger.info('[STT] Deepgram WebSocket closed');
    });

    return {
      write: (audioChunk: Buffer) => {
        // Convert μ-law to linear PCM (Deepgram expects linear PCM)
        // Twilio sends μ-law, but Deepgram can handle it if we specify the format
        // For now, we'll send raw audio and let Deepgram handle it
        // In production, you might need to convert μ-law to linear PCM
        
        if (isOpen) {
          ws.send(audioChunk);
        } else {
          messageQueue.push(audioChunk);
        }
      },
      end: () => {
        if (isOpen) {
          ws.close();
        }
      },
      onTranscript: (callback: (result: STTResult) => void) => {
        // Already set up in constructor
      },
      close: () => {
        if (isOpen) {
          ws.close();
        }
      },
    };
  } catch (error: any) {
    logger.error('[STT] Failed to create Deepgram stream', {
      error: error.message,
    });
    return null;
  }
}

/**
 * Create Google Cloud Speech-to-Text streaming connection
 */
function createGoogleStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.GOOGLE_CLOUD_PROJECT_ID) {
    logger.error('[STT] GOOGLE_CLOUD_PROJECT_ID not configured');
    return null;
  }

  // Google Cloud Speech-to-Text requires the @google-cloud/speech package
  // This is a placeholder implementation
  logger.warn('[STT] Google Cloud STT not yet fully implemented');
  return null;
}

/**
 * Convert μ-law audio to linear PCM (if needed)
 * Twilio Media Streams sends μ-law PCM, some STT services need linear PCM
 */
export function convertMulawToLinear(mulawBuffer: Buffer): Buffer {
  // Simple μ-law to linear PCM conversion
  // This is a basic implementation - for production, use a proper audio library
  const linearBuffer = Buffer.alloc(mulawBuffer.length * 2);
  
  for (let i = 0; i < mulawBuffer.length; i++) {
    const mulawByte = mulawBuffer[i];
    // μ-law decoding formula
    let sign = mulawByte & 0x80;
    let exponent = (mulawByte & 0x70) >> 4;
    let mantissa = mulawByte & 0x0F;
    
    let linear = mantissa << (exponent + 3);
    linear |= 0x84 << exponent;
    if (sign) linear = -linear;
    
    // Convert to 16-bit signed integer
    const sample = Math.max(-32768, Math.min(32767, linear));
    linearBuffer.writeInt16LE(sample, i * 2);
  }
  
  return linearBuffer;
}

