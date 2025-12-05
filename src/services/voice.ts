import { env } from '../config/env';
import twilio from 'twilio';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElevenLabsClient } = require('elevenlabs');

export interface VoiceCallOptions {
  to: string;
  script: string;
  from?: string;
  voiceId?: string;
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
 */
export const makeVoiceCall = async (options: VoiceCallOptions): Promise<VoiceCallResult> => {
  const provider = env.VOICE_PROVIDER || 'twilio';
  const fromNumber = options.from || env.TWILIO_PHONE_NUMBER;
  const voiceId = options.voiceId || env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  try {
    if (provider === 'twilio') {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new Error('Twilio credentials are not configured');
      }

      if (!fromNumber) {
        throw new Error('Twilio phone number is not configured');
      }

      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

      // If using ElevenLabs for voice synthesis
      if (env.ELEVENLABS_API_KEY) {
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
  script: string,
  variables: Record<string, string> = {},
  from?: string,
  voiceId?: string
): Promise<VoiceCallResult> => {
  const processedScript = replaceTemplateVariables(script, variables);

  return makeVoiceCall({
    to,
    script: processedScript,
    from,
    voiceId,
  });
};

