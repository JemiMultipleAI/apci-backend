import { env } from '../config/env';
import { logger } from '../utils/logger';
import twilio from 'twilio';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { queryOne } from '../db/connection';

export interface VoiceCallOptions {
  to: string;
  script?: string; // Optional for agent calls
  from?: string;
  voiceId?: string;
  agentId?: string; // ElevenLabs agent ID for conversational calls
  agentPhoneNumberId?: string; // ElevenLabs phone number ID for native Twilio calls
  contactId?: string; // Contact ID for context
  accountId?: string; // Account ID for agent config lookup
  useAgent?: boolean; // Whether to use agent (Media Streams) or simple TTS
  useElevenLabsNative?: boolean; // Whether to use ElevenLabs native Twilio API
  customIntroduction?: string; // Custom introduction/greeting for agent calls
  instructions?: string; // Campaign instructions for AI context
  campaignName?: string; // Campaign name for context
  campaignDescription?: string; // Campaign description for context
  campaignType?: string; // Campaign type: 'reactivation' | 'marketing' | 'survey'
}

export interface VoiceCallResult {
  success: boolean;
  callId?: string;
  conversationId?: string; // ElevenLabs conversation ID (for native calls)
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
    modelId: 'eleven_monolingual_v1',
  });

  // Convert stream to buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of audio) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Get agent configuration including phone number for a company
 */
async function getAgentConfigForCall(accountId: string): Promise<{
  agentId: string;
  agentPhoneNumberId: string | null;
} | null> {
  if (!accountId) return null;
  
  try {
    const config = await queryOne<{
      agent_id: string;
      agent_phone_number_id: string | null;
    }>(
      `SELECT agent_id, agent_phone_number_id 
       FROM ai_agent_configurations 
       WHERE account_id = $1 AND is_active = true
       LIMIT 1`,
      [accountId]
    );
    
    return config ? {
      agentId: config.agent_id,
      agentPhoneNumberId: config.agent_phone_number_id,
    } : null;
  } catch (error: any) {
    logger.warn('[VOICE] Failed to get agent config', {
      accountId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Make outbound call using ElevenLabs native Twilio API
 * This is a simpler approach - ElevenLabs handles STT, LLM, TTS, and Twilio connection
 */
async function makeElevenLabsNativeCall(
  options: VoiceCallOptions
): Promise<VoiceCallResult> {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is required for ElevenLabs native calls');
  }

  if (!options.agentId) {
    throw new Error('ElevenLabs agent_id is required for native calls');
  }

  if (!options.to) {
    throw new Error('to_number is required');
  }

  // Get phone number from agent config if not provided directly
  let agentPhoneNumberId = options.agentPhoneNumberId;
  
  if (!agentPhoneNumberId && options.accountId) {
    const config = await getAgentConfigForCall(options.accountId);
    if (config?.agentPhoneNumberId) {
      agentPhoneNumberId = config.agentPhoneNumberId;
      logger.info('[VOICE] Using phone number from agent config', {
        accountId: options.accountId,
        agentPhoneNumberId,
      });
    } else {
      logger.warn('[VOICE] No phone number found in agent config', {
        accountId: options.accountId,
        agentId: options.agentId,
        note: 'Configure agent_phone_number_id in agent config for this company',
      });
    }
  }

  if (!agentPhoneNumberId) {
    throw new Error(
      'agent_phone_number_id is required. ' +
      'Either provide it directly or configure it in the agent config for this company.'
    );
  }

  logger.info('[VOICE] Using ElevenLabs native Twilio outbound call API', {
    agentId: options.agentId,
    agentPhoneNumberId,
    to: options.to,
    hasInstructions: !!options.instructions,
    hasCustomIntroduction: !!options.customIntroduction,
    hasCampaignName: !!options.campaignName,
    hasCampaignDescription: !!options.campaignDescription,
    hasCampaignType: !!options.campaignType,
    campaignName: options.campaignName,
    campaignType: options.campaignType,
  });

  try {
    const client = new ElevenLabsClient({
      apiKey: env.ELEVENLABS_API_KEY,
    });

    // Build enhanced instructions with campaign context
    let enhancedInstructions = options.instructions || '';

    logger.debug('[VOICE] Building enhanced instructions', {
      originalInstructions: options.instructions ? options.instructions.substring(0, 100) + '...' : 'none',
      originalInstructionsLength: options.instructions?.length || 0,
      campaignName: options.campaignName,
      campaignDescription: options.campaignDescription,
      campaignType: options.campaignType,
    });

    // Add campaign context to instructions so agent knows WHY it's calling
    if (options.campaignName || options.campaignDescription || options.campaignType) {
      const contextParts: string[] = [];
      
      if (options.campaignName) {
        contextParts.push(`Campaign: ${options.campaignName}`);
      }
      if (options.campaignDescription) {
        contextParts.push(`Campaign Description: ${options.campaignDescription}`);
      }
      if (options.campaignType) {
        let callReason = '';
        if (options.campaignType === 'reactivation') {
          callReason = 'You are calling to reactivate this customer who has been inactive.';
        } else if (options.campaignType === 'marketing') {
          callReason = 'You are calling as part of a marketing campaign.';
        } else if (options.campaignType === 'survey') {
          callReason = 'You are calling to conduct a survey.';
        }
        if (callReason) {
          contextParts.push(`Call Reason: ${callReason}`);
        }
      }
      
      if (contextParts.length > 0) {
        const contextHeader = '\n\n--- Campaign Context ---\n';
        const contextFooter = '\n--- End Campaign Context ---\n';
        enhancedInstructions = enhancedInstructions 
          ? `${enhancedInstructions}${contextHeader}${contextParts.join('\n')}${contextFooter}`
          : `${contextHeader}${contextParts.join('\n')}${contextFooter}`;
      }
    }

    logger.debug('[VOICE] Enhanced instructions built', {
      enhancedInstructionsLength: enhancedInstructions.length,
      enhancedInstructionsPreview: enhancedInstructions.substring(0, 300) + (enhancedInstructions.length > 300 ? '...' : ''),
      hasCampaignContext: !!(options.campaignName || options.campaignDescription || options.campaignType),
      isEmpty: enhancedInstructions.trim().length === 0,
    });

    // Build conversation initiation data with optional overrides (using camelCase for SDK)
    const conversationInitiationClientData: any = {};

    // Always set conversationConfigOverride if we have any overrides
    if (options.customIntroduction || (enhancedInstructions && enhancedInstructions.trim().length > 0)) {
      conversationInitiationClientData.conversationConfigOverride = {};
      conversationInitiationClientData.conversationConfigOverride.agent = {};
      
      // Set first message - ask for permission before proceeding
      // Use custom introduction if provided, otherwise use default permission request
      if (options.customIntroduction) {
        conversationInitiationClientData.conversationConfigOverride.agent.firstMessage = options.customIntroduction;
      } else {
        // Default first message: Ask if they have time before proceeding
        conversationInitiationClientData.conversationConfigOverride.agent.firstMessage = 
          "Hi! This is Remy from MultipleAI. Do you have a few minutes to talk? I'd like to check in with you about your experience with us.";
      }
      
      // Use prompt override to include campaign context in agent's instructions
      // IMPORTANT: This replaces the agent's base prompt, so include all necessary context
      if (enhancedInstructions && enhancedInstructions.trim().length > 0) {
        // Add instructions about waiting for permission before proceeding
        const permissionInstructions = `\n\nIMPORTANT CALL FLOW:
1. First, greet the customer and ask if they have a few minutes to talk.
2. WAIT for their response. Only proceed if they confirm they have time.
3. If they say they're busy or don't have time, politely thank them and offer to call back at a better time. End the call gracefully.
4. If they confirm they have time, then proceed with the campaign objectives below.
5. Be respectful of their time and keep the conversation focused and concise.\n\n`;
        
        conversationInitiationClientData.conversationConfigOverride.agent.prompt = {
          prompt: `${permissionInstructions}${enhancedInstructions.trim()}`,
          //llm: 'gpt-4o', // Default LLM - verify this matches your agent's LLM in ElevenLabs dashboard
        };
        
        logger.info('[VOICE] Setting prompt override with campaign context and permission flow', {
          promptLength: enhancedInstructions.length,
          hasInstructions: !!options.instructions,
          hasCampaignContext: !!(options.campaignName || options.campaignDescription || options.campaignType),
          promptPreview: enhancedInstructions.substring(0, 200) + (enhancedInstructions.length > 200 ? '...' : ''),
          hasPermissionFlow: true,
        });
      }
    }

    // Keep dynamicVariables for other systems that might use them (webhooks, etc.)
    if (options.contactId || options.accountId) {
      conversationInitiationClientData.dynamicVariables = {};
      if (options.contactId) {
        conversationInitiationClientData.dynamicVariables.contactId = options.contactId;
      }
      if (options.accountId) {
        conversationInitiationClientData.dynamicVariables.accountId = options.accountId;
      }
    }

    // Log the final structure being sent (for debugging)
    if (Object.keys(conversationInitiationClientData).length > 0) {
      logger.debug('[VOICE] Conversation initiation data structure', {
        hasConfigOverride: !!conversationInitiationClientData.conversationConfigOverride,
        hasAgent: !!conversationInitiationClientData.conversationConfigOverride?.agent,
        hasPrompt: !!conversationInitiationClientData.conversationConfigOverride?.agent?.prompt,
        hasFirstMessage: !!conversationInitiationClientData.conversationConfigOverride?.agent?.firstMessage,
        hasDynamicVars: !!conversationInitiationClientData.dynamicVariables,
        structure: JSON.stringify(conversationInitiationClientData, null, 2),
      });
    }

    // Build the complete request body for logging (using camelCase for SDK)
    const requestBody = {
      agentId: options.agentId,
      agentPhoneNumberId: agentPhoneNumberId,
      toNumber: options.to,
      conversationInitiationClientData: Object.keys(conversationInitiationClientData).length > 0
        ? conversationInitiationClientData
        : undefined,
    };

    // Log the complete POST request body
    logger.info('[VOICE] 📤 Sending POST request to ElevenLabs Twilio outbound call API', {
      endpoint: 'POST /v1/convai/twilio/outbound-call',
      requestBody: JSON.stringify(requestBody, null, 2),
      agentId: options.agentId,
      agentPhoneNumberId: agentPhoneNumberId,
      toNumber: options.to,
      hasConversationInitiationData: !!requestBody.conversationInitiationClientData,
    });

    // Call ElevenLabs native API
    // Using camelCase for SDK - if this doesn't work, we'll switch to direct HTTP request
    const response = await client.conversationalAi.twilio.outboundCall(requestBody);

    if (response.success) {
      logger.info('[VOICE] ✅ ElevenLabs native call initiated successfully', {
        callSid: response.callSid,
        conversationId: response.conversationId,
        message: response.message,
      });

      return {
        success: true,
        callId: response.callSid || undefined,
        conversationId: response.conversationId || undefined,
      };
    } else {
      throw new Error(response.message || 'Failed to initiate call');
    }
  } catch (error: any) {
    logger.error('[VOICE] ❌ ElevenLabs native call failed', {
      error: error.message,
      stack: error.stack,
      agentId: options.agentId,
      agentPhoneNumberId,
    });
    throw error;
  }
}

/**
 * Make voice call using configured provider
 * If useAgent is true, connects call to ElevenLabs agent via Media Streams
 * If useElevenLabsNative is true, uses ElevenLabs native Twilio API
 */
export const makeVoiceCall = async (options: VoiceCallOptions): Promise<VoiceCallResult> => {
  const provider = env.VOICE_PROVIDER || 'twilio';
  const useAgent = options.useAgent || false;
  const useElevenLabsNative = options.useElevenLabsNative || false;

  logger.info('[VOICE] makeVoiceCall called', {
    provider,
    to: options.to,
    useAgent,
    useElevenLabsNative,
    hasAgentId: !!options.agentId,
    hasAgentPhoneNumberId: !!options.agentPhoneNumberId,
    hasScript: !!options.script,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL ? 'SET' : 'NOT SET',
  });

  // AUTO-DETECT: If useAgent is true, try to use native API by default
  // Check if we have agentId and can get phone number from config or options
  if (useAgent && !useElevenLabsNative && options.agentId && options.accountId) {
    // Check if phone number is already provided in options (from campaignQueue)
    let agentPhoneNumberId = options.agentPhoneNumberId;
    let config: { agentId: string; agentPhoneNumberId: string | null } | null = null;
    
    // If not provided, try to get from agent config database
    if (!agentPhoneNumberId) {
      config = await getAgentConfigForCall(options.accountId);
      agentPhoneNumberId = config?.agentPhoneNumberId || undefined;
    }
    
    // If we have phone number (from options or config), use native API
    if (agentPhoneNumberId) {
      logger.info('[VOICE] Auto-detected native API - agent config has phone number', {
        accountId: options.accountId,
        agentId: options.agentId,
        agentPhoneNumberId: agentPhoneNumberId,
        source: options.agentPhoneNumberId ? 'options' : 'database',
        note: 'Using ElevenLabs native API by default for better latency and interruption support',
      });
      // Use native API with phone number
      return makeElevenLabsNativeCall({
        ...options,
        agentPhoneNumberId: agentPhoneNumberId,
        // Ensure we use the agentId from config if it exists, otherwise use provided one
        agentId: config?.agentId || options.agentId,
      });
    }
  }

  // Explicit native API call (if flag is set)
  if (useElevenLabsNative) {
    return makeElevenLabsNativeCall(options);
  }

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
          aiProvider: 'openai',
          useAgentFromOptions: useAgent,
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
          logger.debug('[VOICE] Added account_id to custom parameters', {
            accountId: options.accountId,
            customParamsKeys: Object.keys(customParams),
          });
        } else {
          logger.warn('[VOICE] No accountId provided - agent will NOT have CRM context', {
            hasContactId: !!options.contactId,
            hasAgentId: !!options.agentId,
            note: 'AI responses will be generic without campaigns, deals, or contact context',
          });
        }
        if (options.customIntroduction) {
          customParams.customIntroduction = options.customIntroduction;
        }
        if (options.instructions) {
          customParams.instructions = options.instructions;
        }

        // Validate required parameters
        if (!effectiveAgentId) {
          logger.error('[VOICE] CRITICAL: effectiveAgentId is missing - Media Streams will fail', {
            optionsAgentId: options.agentId,
            useAgent,
            note: 'This will cause the WebSocket to close immediately as no agent_id will be in TwiML',
          });
        }

        // Create TwiML with Media Streams
        // Note: Twilio Media Streams passes custom parameters via the 'parameter' attributes in TwiML
        // These will be included in the 'start' event message's customParameters field
        logger.info('[VOICE] Creating TwiML with Media Streams', {
          mediaStreamUrl: mediaStreamUrl,
          baseUrl: baseUrl,
          originalPublicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
          customParameters: customParams,
          customParametersCount: Object.keys(customParams).length,
          hasAgentId: !!customParams.agent_id,
          hasContactId: !!customParams.contact_id,
          hasAccountId: !!customParams.account_id,
          hasCustomIntroduction: !!customParams.customIntroduction,
          hasScript: !!options.script,
          effectiveAgentId: effectiveAgentId ? effectiveAgentId.substring(0, 20) + '...' : 'MISSING',
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
        logger.debug('[VOICE] Adding parameters to TwiML Stream', {
          parameterCount: Object.keys(customParams).length,
          parameters: Object.keys(customParams),
        });
        
        Object.entries(customParams).forEach(([key, value]) => {
          if (!value) {
            logger.warn('[VOICE] Skipping empty parameter value', { key });
            return;
          }
          stream.parameter({
            name: key,
            value: value,
          });
          logger.debug('[VOICE] Added parameter to TwiML', {
            key,
            valueLength: value.length,
            valuePreview: value.substring(0, 50) + (value.length > 50 ? '...' : ''),
          });
        });
        
        // Validate that agent_id was added
        if (!customParams.agent_id) {
          logger.error('[VOICE] CRITICAL: agent_id parameter was not added to TwiML', {
            customParams,
            effectiveAgentId,
            note: 'This will cause the WebSocket to close immediately',
          });
        }

        // Note: <Connect> blocks execution, so <Say> and <Pause> won't execute
        // The stream starts immediately and goes directly to the AI agent
        // The call stays open as long as the Media Stream WebSocket is connected

        const twimlString = twiml.toString();
        
        // Verify TwiML was generated correctly with track attribute
        const hasTrackAttribute = twimlString.includes('track=');
        const trackValueMatch = twimlString.match(/track="?([^"\s>]+)"?/);
        const trackValue = trackValueMatch ? trackValueMatch[1] : 'NOT FOUND';
        
        // Check for parameter elements
        const parameterMatches = twimlString.match(/<Parameter[^>]*>/g) || [];
        const parameterCount = parameterMatches.length;
        const hasAgentIdParam = twimlString.includes('name="agent_id"') || twimlString.includes("name='agent_id'");
        
        logger.info('[VOICE] Generated TwiML for Media Stream (using <Connect><Stream>)', {
          twiml: twimlString,
          hasTrackAttribute,
          trackValue,
          parameterCount,
          hasAgentIdParam,
          allParameters: parameterMatches,
          mediaStreamUrl,
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
  useAgent?: boolean,
  customIntroduction?: string,
  instructions?: string, // Campaign instructions for AI context
  agentPhoneNumberId?: string, // ElevenLabs phone number ID for native Twilio calls
  campaignName?: string, // Campaign name for context
  campaignDescription?: string, // Campaign description for context
  campaignType?: string // Campaign type: 'reactivation' | 'marketing' | 'survey'
): Promise<VoiceCallResult> => {
  const processedScript = script ? replaceTemplateVariables(script, variables) : undefined;

  return makeVoiceCall({
    to,
    script: processedScript,
    customIntroduction,
    instructions,
    from,
    voiceId,
    agentId,
    agentPhoneNumberId,
    contactId,
    accountId,
    useAgent,
    campaignName,
    campaignDescription,
    campaignType,
  });
};

