import { env } from '../config/env';
import { logger } from '../utils/logger';
import twilio from 'twilio';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElevenLabsClient } = require('elevenlabs');

export interface VoiceCallOptions {
  to: string;
  script?: string; // Optional for agent calls
  from?: string;
  voiceId?: string;
  agentId?: string; // ElevenLabs agent ID for conversational calls
  contactId?: string; // Contact ID for context
  accountId?: string; // Account ID for agent config lookup
  useAgent?: boolean; // Whether to use agent (Media Streams) or simple TTS
}

export interface VoiceCallResult {
  success: boolean;
  callId?: string;
  error?: string;
}

/**
 * Replace template variables in voice script
 */
export const replaceTemplateVariables = (
  content: string,
  variables: Record<string, string>
): string => {
  let result = content;
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    result = result.replace(regex, value || '');
  });
  return result;
};

/**
 * Generate audio from text using ElevenLabs
 */
const generateAudioFromText = async (
  text: string,
  voiceId: string
): Promise<Buffer> => {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not configured');
  }

  const client = new ElevenLabsClient({
    apiKey: env.ELEVENLABS_API_KEY,
  });

  const audio = await client.textToSpeech.convert(voiceId, {
    text,
    model_id: 'eleven_monolingual_v1',
  });

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Make voice call using configured provider
 * If useAgent is true, connects call to ElevenLabs agent via Media Streams
 */
export const makeVoiceCall = async (options: VoiceCallOptions): Promise<VoiceCallResult> => {
  const provider = env.VOICE_PROVIDER || 'twilio';
  const fromNumber = options.from || env.TWILIO_PHONE_NUMBER;
  const voiceId = options.voiceId || env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const useAgent = options.useAgent || false;

  logger.info('[VOICE] makeVoiceCall called', {
    provider,
    to: options.to,
    useAgent,
    hasAgentId: !!options.agentId,
    hasScript: !!options.script,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL ? 'SET' : 'NOT SET',
  });

  try {
    if (provider === 'twilio') {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new Error('Twilio credentials are not configured');
      }

      if (!fromNumber) {
        throw new Error('Twilio phone number is not configured');
      }

      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

      // If using agent (Media Streams for real-time conversation)
      // Simplified: Trust the useAgent flag from campaignQueue - it already checked OpenAI configuration
      // No need to re-check here - if campaignQueue set useAgent=true, use agent mode
      const shouldUseAgent = useAgent === true;

      if (shouldUseAgent) {
        // SAFEGUARD: Ignore any script/template for agent calls - go straight to agent
        // Agent mode uses Media Streams for real-time conversation, no template playback
        if (options.script) {
          logger.warn('[VOICE] Script provided for agent call - ignoring script, going straight to agent', {
            scriptPreview: options.script.substring(0, 50) + (options.script.length > 50 ? '...' : ''),
            scriptLength: options.script.length,
            note: 'Agent mode does not use template scripts - the AI agent handles the conversation directly via Media Streams',
          });
        }
        
        // Use placeholder agentId if not provided (OpenAI doesn't need a real agentId from database)
        const effectiveAgentId = options.agentId || 'openai-default';
        
        logger.info('[VOICE] Using agent mode with Media Streams', {
          agentId: effectiveAgentId.substring(0, 15) + '...',
          contactId: options.contactId,
          accountId: options.accountId,
          sttProvider: env.STT_PROVIDER || 'openai',
          aiProvider: env.AI_AGENT_PROVIDER || 'elevenlabs',
          useAgentFromOptions: useAgent,
          note: 'Agent mode enabled - campaignQueue already validated OpenAI configuration',
        });

        if (!env.PUBLIC_WEBHOOK_URL) {
          const error = 'PUBLIC_WEBHOOK_URL is required for agent calls (Media Streams)';
          logger.error('[VOICE] ' + error);
          throw new Error(error);
        }

        // Build Media Streams URL
        // Twilio Media Streams requires wss:// (WebSocket Secure) protocol in TwiML
        // Normalize URL: handle http://, https://, and ensure proper format
        let baseUrl = (env.PUBLIC_WEBHOOK_URL || '').trim();
        
        // Remove trailing slashes
        baseUrl = baseUrl.replace(/\/+$/, '');
        
        // Convert to wss:// protocol (handle http://, https://, or already wss://)
        if (baseUrl.startsWith('http://')) {
          baseUrl = baseUrl.replace(/^http:\/\//, 'wss://');
        } else if (baseUrl.startsWith('https://')) {
          baseUrl = baseUrl.replace(/^https:\/\//, 'wss://');
        } else if (!baseUrl.startsWith('wss://')) {
          // If no protocol specified, assume https and convert to wss
          baseUrl = `wss://${baseUrl}`;
        }
        
        // Construct full URL, ensuring no double slashes in path
        const path = '/api/webhooks/twilio/media-streams';
        const mediaStreamUrl = `${baseUrl}${path}`;
        
        // Validate URL format
        try {
          const url = new URL(mediaStreamUrl);
          if (url.protocol !== 'wss:') {
            throw new Error(`Media Streams URL must use wss:// protocol, got: ${url.protocol}`);
          }
        } catch (error: any) {
          logger.error('[VOICE] Invalid Media Streams URL format', {
            originalUrl: env.PUBLIC_WEBHOOK_URL,
            constructedUrl: mediaStreamUrl,
            error: error.message,
          });
          throw new Error(`Invalid Media Streams URL format: ${error.message}`);
        }
        
        // Build custom parameters to pass to Media Streams
        const customParams: Record<string, string> = {
          agent_id: effectiveAgentId, // Use placeholder or actual agentId (defined above)
        };
        if (options.contactId) {
          customParams.contact_id = options.contactId;
        }
        if (options.accountId) {
          customParams.account_id = options.accountId;
        }

        // Create TwiML with Media Streams
        // Note: Twilio Media Streams passes custom parameters via the 'parameter' attributes in TwiML
        // These will be included in the 'start' event message's customParameters field
        logger.info('[VOICE] Creating TwiML with Media Streams', {
          mediaStreamUrl: mediaStreamUrl,
          baseUrl: baseUrl,
          originalPublicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
          customParameters: customParams,
          hasScript: !!options.script,
        });
        
        // REVERTED: Back to <Connect><Stream> - <Start><Stream> broke initial conversation
        // Based on Twilio Media Streams documentation: https://www.twilio.com/docs/voice/media-streams
        // Based on Twilio Media Streams documentation: https://www.twilio.com/docs/voice/twiml/stream#track
        // For <Connect><Stream> (bidirectional streams), we can only receive the inbound_track
        // CRITICAL: Explicitly specify track="inbound_track" to ensure we receive caller audio
        // Without this, Twilio might not send inbound audio properly (causing 2-3 byte chunks)
        const twiml = new twilio.twiml.VoiceResponse();
        const stream = twiml.connect().stream({
          url: mediaStreamUrl,
          track: 'inbound_track', // Explicitly request inbound track for caller audio
        });
        
        // Add custom parameters as parameter attributes
        // Twilio will include these in the start event's customParameters field
        Object.entries(customParams).forEach(([key, value]) => {
          stream.parameter({
            name: key,
            value: value,
          });
        });

        // Note: <Connect> blocks execution, so <Say> and <Pause> won't execute
        // The stream starts immediately and goes directly to the AI agent
        // The call stays open as long as the Media Stream WebSocket is connected

        const twimlString = twiml.toString();
        
        // Verify TwiML was generated correctly with track attribute
        const hasTrackAttribute = twimlString.includes('track=');
        const trackValueMatch = twimlString.match(/track="?([^"\s>]+)"?/);
        const trackValue = trackValueMatch ? trackValueMatch[1] : 'NOT FOUND';
        
        logger.info('[VOICE] Generated TwiML for Media Stream (using <Connect><Stream>)', {
          twiml: twimlString,
          hasTrackAttribute,
          trackValue,
          hasInboundTrack: trackValue === 'inbound_track',
          note: hasTrackAttribute && trackValue === 'inbound_track'
            ? '✅ TwiML correctly includes track="inbound_track" - should receive caller audio'
            : '⚠️ TwiML missing or incorrect track attribute - caller audio may not be received properly',
        });
        
        logger.debug('[VOICE] Generated TwiML', {
          twiml: twimlString,
        });

        logger.info('[VOICE] Creating Twilio call with recording enabled', {
          to: options.to,
          from: fromNumber,
          record: true,
          recordingChannels: 'dual',
          note: 'Recording enabled for diagnostics - check Twilio Console → Monitor → Recordings after call to verify if inbound audio was captured',
        });

        const call = await client.calls.create({
          twiml: twimlString,
          to: options.to,
          from: fromNumber,
          record: true, // Enable recording for diagnostics - check if Twilio captures inbound audio
          recordingChannels: 'dual', // 'dual' records both inbound (caller) and outbound (AI) separately
          // Note: 'dual' recording allows us to hear if inbound audio is actually being captured
          // After the call, check Twilio Console → Monitor → Recordings to listen to the recording
          // If inbound channel has audio, Twilio is capturing it but Media Stream isn't receiving it
          // If inbound channel is silent, Twilio isn't receiving audio from caller device
        });

        logger.info('[VOICE] Twilio call created successfully', {
          callSid: call.sid,
          status: call.status,
          to: call.to,
          from: call.from,
        });

        return {
          success: true,
          callId: call.sid,
        };
      }

      // Fallback: Simple TTS call (non-agent)
      logger.info('[VOICE] Using simple TTS mode (non-agent)', {
        hasScript: !!options.script,
      });
      
      if (!options.script) {
        throw new Error('Script is required for non-agent calls');
      }

      // If using ElevenLabs for voice synthesis (non-streaming)
      if (env.ELEVENLABS_API_KEY && !useAgent) {
        try {
          // Generate audio from text
          const audioBuffer = await generateAudioFromText(options.script, voiceId);
          
          // For Twilio, we need to host the audio file or use TwiML
          // For now, we'll use TwiML with text-to-speech as fallback
          // In production, you'd upload the audio to a CDN and use the URL
          
          // Using TwiML with Say verb as fallback
          const twiml = new twilio.twiml.VoiceResponse();
          twiml.say({
            voice: 'alice',
            language: 'en-US',
          }, options.script);

          const call = await client.calls.create({
            twiml: twiml.toString(),
            to: options.to,
            from: fromNumber,
          });

          return {
            success: true,
            callId: call.sid,
          };
        } catch (elevenLabsError: any) {
          console.warn('ElevenLabs error, falling back to Twilio TTS:', elevenLabsError);
          // Fallback to Twilio TTS
        }
      }

      // Use Twilio's built-in text-to-speech
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say({
        voice: 'alice',
        language: 'en-US',
      }, options.script);

      const call = await client.calls.create({
        twiml: twiml.toString(),
        to: options.to,
        from: fromNumber,
      });

      return {
        success: true,
        callId: call.sid,
      };
    } else if (provider === 'elevenlabs') {
      // Direct ElevenLabs integration would require additional infrastructure
      // For now, we'll use Twilio with ElevenLabs audio generation
      throw new Error('ElevenLabs-only provider requires additional setup. Use twilio provider with ELEVENLABS_API_KEY.');
    } else {
      throw new Error(`Unsupported voice provider: ${provider}`);
    }
  } catch (error: any) {
    console.error('Voice call error:', error);
    return {
      success: false,
      error: error.message || 'Failed to make voice call',
    };
  }
};

/**
 * Make voice call from template with variables
 */
export const makeVoiceCallFromTemplate = async (
  to: string,
  script: string | undefined,
  variables: Record<string, string> = {},
  from?: string,
  voiceId?: string,
  agentId?: string,
  contactId?: string,
  accountId?: string,
  useAgent?: boolean
): Promise<VoiceCallResult> => {
  const processedScript = script ? replaceTemplateVariables(script, variables) : undefined;

  return makeVoiceCall({
    to,
    script: processedScript,
    from,
    voiceId,
    agentId,
    contactId,
    accountId,
    useAgent,
  });
};

