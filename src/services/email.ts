import { env } from '../config/env';
import sgMail from '@sendgrid/mail';
import { Resend } from 'resend';
import { logger } from '../utils/logger';

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

