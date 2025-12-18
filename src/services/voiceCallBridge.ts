import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { sendMessageToAgent } from './elevenlabsAgent';
import { sendAudioToStream, MediaStreamConnection } from './twilioMediaStreams';
import { createSTTStream, STTStream, STTResult } from './speechToText';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElevenLabsClient } = require('elevenlabs');

interface VoiceCallBridge {
  callSid: string;
  agentId: string;
  contactId?: string;
  accountId?: string;
  agentWs?: WebSocket;
  audioBuffer: Buffer[];
  textBuffer: string;
  lastSttTime: number;
  isProcessing: boolean;
  ttsClient?: any;
  voiceId: string;
  sttStream?: STTStream;
  pendingTranscript: string;
  transcriptTimeout?: NodeJS.Timeout;
}

// Store active bridges
const activeBridges = new Map<string, VoiceCallBridge>();

/**
 * Start voice call bridge between Twilio and ElevenLabs agent
 */
export async function startVoiceCallBridge(
  streamConnection: MediaStreamConnection,
  agentId: string,
  contactId?: string,
  accountId?: string
): Promise<void> {
  const callSid = streamConnection.callSid;
  const voiceId = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  logger.info('[VOICE_BRIDGE] Starting bridge', {
    callSid,
    agentId: agentId.substring(0, 8) + '...',
    contactId,
    accountId,
  });

  // Initialize ElevenLabs TTS client
  let ttsClient: any = null;
  if (env.ELEVENLABS_API_KEY) {
    try {
      ttsClient = new ElevenLabsClient({
        apiKey: env.ELEVENLABS_API_KEY,
      });
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE] Failed to initialize TTS client', {
        callSid,
        error: error.message,
      });
    }
  }

  // Create STT stream for real-time transcription
  const sttStream = createSTTStream((result: STTResult) => {
    handleSTTResult(callSid, result);
  });

  const bridge: VoiceCallBridge = {
    callSid,
    agentId,
    contactId,
    accountId,
    audioBuffer: [],
    textBuffer: '',
    lastSttTime: Date.now(),
    isProcessing: false,
    ttsClient,
    voiceId,
    sttStream: sttStream || undefined,
    pendingTranscript: '',
  };

  activeBridges.set(callSid, bridge);

  if (!sttStream) {
    logger.warn('[VOICE_BRIDGE] STT stream not available - audio will not be transcribed', {
      callSid,
    });
  }

  // Send initial greeting message to agent
  try {
    const greeting = await sendMessageToAgent(
      agentId,
      'Hello, I am calling you. Please introduce yourself and ask how you can help.',
      undefined, // agentConfigId
      contactId,
      accountId
    );

    if (greeting.success && greeting.response) {
      // Convert greeting to audio and send to caller
      await sendAgentResponseAsAudio(callSid, greeting.response);
    }
  } catch (error: any) {
    logger.error('[VOICE_BRIDGE] Failed to send greeting', {
      callSid,
      error: error.message,
    });
  }
}

/**
 * Handle inbound audio from Twilio Media Stream
 */
export async function handleInboundAudio(
  callSid: string,
  audioChunk: Buffer,
  timestamp: number
): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    return;
  }

  // Send audio chunk directly to STT stream (real-time processing)
  if (bridge.sttStream) {
    bridge.sttStream.write(audioChunk);
    bridge.lastSttTime = Date.now();
  } else {
    // Fallback: buffer audio if STT not available
    bridge.audioBuffer.push(audioChunk);
    bridge.lastSttTime = Date.now();
  }
}

/**
 * Handle STT transcription result
 */
function handleSTTResult(callSid: string, result: STTResult): void {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    return;
  }

  if (result.isFinal) {
    // Final transcript - send to agent
    const finalText = result.text.trim();
    if (finalText) {
      logger.info('[VOICE_BRIDGE] Final transcript received', {
        callSid,
        text: finalText,
        confidence: result.confidence,
      });
      
      // Clear pending transcript
      bridge.pendingTranscript = '';
      
      // Send to agent
      sendTextToAgent(callSid, finalText).catch((error: any) => {
        logger.error('[VOICE_BRIDGE] Failed to send transcript to agent', {
          callSid,
          error: error.message,
        });
      });
    }
  } else {
    // Interim result - accumulate for potential early sending
    bridge.pendingTranscript = result.text.trim();
    
    // Clear existing timeout
    if (bridge.transcriptTimeout) {
      clearTimeout(bridge.transcriptTimeout);
    }
    
    // If we have a substantial interim transcript and no activity for a while, send it
    // This helps with faster response times
    if (bridge.pendingTranscript.length > 10) {
      bridge.transcriptTimeout = setTimeout(() => {
        if (bridge.pendingTranscript) {
          logger.info('[VOICE_BRIDGE] Sending interim transcript (timeout)', {
            callSid,
            text: bridge.pendingTranscript,
          });
          sendTextToAgent(callSid, bridge.pendingTranscript).catch(() => {
            // Ignore errors for interim transcripts
          });
          bridge.pendingTranscript = '';
        }
      }, 2000); // Wait 2 seconds of silence before sending interim
    }
  }
}


/**
 * Send text to agent and get response
 */
async function sendTextToAgent(callSid: string, text: string): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    return;
  }

  if (!text.trim()) {
    return;
  }

  logger.info('[VOICE_BRIDGE] Sending text to agent', {
    callSid,
    textLength: text.length,
    textPreview: text.substring(0, 100),
  });

  try {
    const response = await sendMessageToAgent(
      bridge.agentId,
      text,
      undefined, // agentConfigId
      bridge.contactId,
      bridge.accountId
    );

    if (response.success && response.response) {
      await sendAgentResponseAsAudio(callSid, response.response);
    } else {
      logger.error('[VOICE_BRIDGE] Agent returned error', {
        callSid,
        error: response.error,
      });
    }
  } catch (error: any) {
    logger.error('[VOICE_BRIDGE] Failed to send text to agent', {
      callSid,
      error: error.message,
    });
  }
}

/**
 * Convert agent text response to audio and send to caller
 */
async function sendAgentResponseAsAudio(callSid: string, text: string): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge || !bridge.ttsClient) {
    logger.error('[VOICE_BRIDGE] TTS client not available', { callSid });
    return;
  }

  try {
    logger.info('[VOICE_BRIDGE] Converting text to audio', {
      callSid,
      textLength: text.length,
    });

    // Use ElevenLabs streaming TTS
    const audioStream = await bridge.ttsClient.textToSpeech.convert(bridge.voiceId, {
      text,
      model_id: 'eleven_monolingual_v1',
      output_format: 'pcm_16000', // 16kHz PCM for Twilio
    });

    // Stream audio chunks to Twilio
    for await (const audioChunk of audioStream) {
      // Convert to μ-law if needed (Twilio expects μ-law for Media Streams)
      // For now, we'll send PCM and let Twilio handle conversion
      // In production, you might need to convert to μ-law format
      
      const success = sendAudioToStream(callSid, Buffer.from(audioChunk));
      if (!success) {
        logger.warn('[VOICE_BRIDGE] Failed to send audio chunk', { callSid });
        break;
      }
    }

    logger.info('[VOICE_BRIDGE] Audio sent successfully', { callSid });
  } catch (error: any) {
    logger.error('[VOICE_BRIDGE] Failed to convert text to audio', {
      callSid,
      error: error.message,
    });
  }
}

/**
 * Stop voice call bridge
 */
export function stopVoiceCallBridge(callSid: string): void {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    return;
  }

  logger.info('[VOICE_BRIDGE] Stopping bridge', { callSid });

  // Close agent WebSocket if open
  if (bridge.agentWs && bridge.agentWs.readyState === WebSocket.OPEN) {
    bridge.agentWs.close();
  }

  // Close STT stream if open
  if (bridge.sttStream) {
    bridge.sttStream.close();
  }

  // Clear transcript timeout
  if (bridge.transcriptTimeout) {
    clearTimeout(bridge.transcriptTimeout);
  }

  // Remove from active bridges
  activeBridges.delete(callSid);
}

/**
 * Get active bridge
 */
export function getActiveBridge(callSid: string): VoiceCallBridge | undefined {
  return activeBridges.get(callSid);
}

/**
 * Get all active bridges (for monitoring)
 */
export function getAllActiveBridges(): VoiceCallBridge[] {
  return Array.from(activeBridges.values());
}

