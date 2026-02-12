import { env } from '../config/env';
import sgMail from '@sendgrid/mail';
import { Resend } from 'resend';
import { logger } from '../utils/logger';
import { sendMessageToAgent } from './agentService';
import { upsertConversation, addMessageToConversation } from './conversationService';

export interface EmailOptions {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string; // Reply-To email address for inbound replies
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Replace template variables in email content
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
 * Send email using configured provider
 */
export const sendEmail = async (options: EmailOptions): Promise<EmailResult> => {
  const provider = env.EMAIL_PROVIDER || 'sendgrid';
  const fromEmail = options.from || env.EMAIL_FROM || 'crmatiq@multipleaisolutions.com';

  try {
    if (provider === 'sendgrid') {
      if (!env.SENDGRID_API_KEY) {
        throw new Error('SENDGRID_API_KEY is not configured');
      }

      sgMail.setApiKey(env.SENDGRID_API_KEY);

      const msg: any = {
        to: options.to,
        from: fromEmail,
        subject: options.subject,
        text: options.text || options.html?.replace(/<[^>]*>/g, '') || '',
        html: options.html,
      };

      // Add Reply-To header if provided
      if (options.replyTo) {
        msg.replyTo = options.replyTo;
      }

      const [response] = await sgMail.send(msg);
      
      return {
        success: true,
        messageId: response.headers['x-message-id'] as string,
      };
    } else if (provider === 'resend') {
      if (!env.RESEND_API_KEY) {
        throw new Error('RESEND_API_KEY is not configured');
      }

      const resend = new Resend(env.RESEND_API_KEY);


      const emailData: any = {
        from: fromEmail,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || options.html?.replace(/<[^>]*>/g, '') || '',
      };

      logger.debug('[RESEND] Email data', JSON.stringify(emailData));
      // logger.debug('[RESEND] Options data', JSON.stringify(options));
      // // Add Reply-To header if provided
      // if (options.replyTo) {
      //   emailData.reply_to = options.replyTo;
      // }

      const { data, error } = await resend.emails.send(emailData);
      logger.debug('[RESEND] Email data', JSON.stringify(data));

      if (error) {
        throw new Error(error.message);
      }

      return {
        success: true,
        messageId: data?.id,
      };
    } else {
      throw new Error(`Unsupported email provider: ${provider}`);
    }
  } catch (error: any) {
    console.error('Email sending error:', error);
    return {
      success: false,
      error: error.message || 'Failed to send email',
    };
  }
};

/**
 * Send email from template with variables
 */
export const sendEmailFromTemplate = async (
  to: string,
  subject: string,
  body: string,
  variables: Record<string, string> = {},
  from?: string,
  replyTo?: string
): Promise<EmailResult> => {
  const processedSubject = replaceTemplateVariables(subject, variables);
  const processedBody = replaceTemplateVariables(body, variables);

  return sendEmail({
    to,
    subject: processedSubject,
    html: processedBody,
    from,
    replyTo,
  });
};

/**
 * Send AI-generated personalized email
 * Uses OpenAI to generate personalized content based on campaign instructions
 */
export const sendEmailWithAI = async (
  to: string,
  subject: string,
  instructions: string,
  contactId: string,
  accountId?: string,
  campaignId?: string,
  replyTo?: string,
  customIntroduction?: string
): Promise<EmailResult> => {
  try {
    logger.info('[EMAIL_AI] Generating personalized email', {
      to,
      contactId,
      accountId,
      campaignId,
      instructionsLength: instructions.length,
    });

    // Create prompt for the agent based on campaign instructions
    const agentPrompt = `Generate a personalized email message based on these campaign instructions:

${instructions}

IMPORTANT: Use the customer's actual name from the context provided. Do NOT use placeholders like "[Customer Name]", "[Name]", or any bracketed placeholders. Use the real name that appears in the Customer Context section of the system prompt.

Please create a friendly, professional email that:
- Uses the customer's actual name (from Customer Context) - do not use placeholders
- Personalizes the message based on the customer's context
- Follows the campaign instructions provided above
- Is concise and engaging
- Uses appropriate tone for the campaign purpose

Generate only the email body content (not the subject line).`;

    // Use a placeholder agent ID for campaigns (OpenAI doesn't need a real agent ID)
    const agentId = `openai-campaign-${campaignId?.substring(0, 8) || 'default'}`;

    // Generate personalized content using the agent
    const agentResponse = await sendMessageToAgent(
      agentId,
      agentPrompt,
      undefined, // agentConfigId - not needed for campaigns
      contactId,
      accountId
    );

    if (!agentResponse.success || !agentResponse.response) {
      const error = agentResponse.error || 'Failed to generate email content';
      logger.error('[EMAIL_AI] Failed to generate email content', {
        contactId,
        accountId,
        error,
      });
      return {
        success: false,
        error,
      };
    }

    const emailBody = agentResponse.response.trim();
    const finalEmailBody = customIntroduction ? `${customIntroduction}\n\n${emailBody}` : emailBody;

    // Send the generated email
    const result = await sendEmail({
      to,
      subject,
      html: finalEmailBody,
      replyTo,
    });

    // Store conversation in MongoDB if accountId and contactId are available
    if (result.success && accountId && contactId) {
      try {
        const conversation = await upsertConversation(
          contactId,
          accountId,
          'email',
          campaignId
        );

        await addMessageToConversation(
          conversation._id.toString(),
          'assistant',
          finalEmailBody,
          {
            message_id: result.messageId,
            tokens_used: undefined, // Could extract from agentResponse if available
          }
        );

        logger.debug('[EMAIL_AI] Conversation stored in MongoDB', {
          conversationId: conversation._id,
          contactId,
        });
      } catch (error: any) {
        // Log error but don't fail the email send
        logger.warn('[EMAIL_AI] Failed to store conversation', {
          error: error.message,
          contactId,
          accountId,
        });
      }
    }

    logger.info('[EMAIL_AI] Email sent successfully', {
      to,
      contactId,
      messageId: result.messageId,
    });

    return result;
  } catch (error: any) {
    logger.error('[EMAIL_AI] Error sending AI-generated email', {
      error: error.message,
      to,
      contactId,
    });
    return {
      success: false,
      error: error.message || 'Failed to send AI-generated email',
    };
  }
};
