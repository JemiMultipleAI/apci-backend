import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getCampaignsKnowledgeBaseText, getDealsKnowledgeBaseText } from '../utils/knowledgeBaseFormatter';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

interface UpdateDocumentParams {
  documentationId: string;
  companyId: string;
  type: 'campaigns' | 'deals';
  displayName: string; // Friendly name for logging (e.g., "Company Name - Campaigns KB")
}

interface UpdateDocumentResponse {
  id: string;
  name: string;
  type: string;
  metadata?: any;
}

/**
 * Update a knowledge base document in ElevenLabs
 * Fetches the latest campaign/deal data and updates the document with formatted text
 * The formatted text is passed as the 'name' parameter to the API
 */
export async function updateKnowledgeBaseDocument(
  params: UpdateDocumentParams
): Promise<UpdateDocumentResponse> {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not configured');
  }

  const { documentationId, companyId, type, displayName } = params;

  try {
    // Fetch the latest data from database and format it
    const content = type === 'campaigns' 
      ? await getCampaignsKnowledgeBaseText(companyId)
      : await getDealsKnowledgeBaseText(companyId);

    // Update the document with display name and content
    // name: display name for the document
    // content: the actual formatted campaign/deal data
    const response = await fetch(
      `${ELEVENLABS_API_BASE}/convai/knowledge-base/${documentationId}`,
      {
        method: 'PATCH',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          name: displayName, // Display name (e.g., "Company Name - Campaigns KB")
          text: content   // The actual formatted text content
        }),
      }
    );

    logger.info('[ELEVENLABS_KB] content', JSON.stringify(content));
    logger.info('[ELEVENLABS_KB] Response', JSON.stringify(response.body));

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[ELEVENLABS_KB] Update document failed', {
        documentationId,
        type,
        companyId,
        status: response.status,
        error: errorText,
      });
      throw new Error(
        `Failed to update knowledge base document: ${response.status} ${errorText}`
      );
    }

    const data = await response.json() as UpdateDocumentResponse;
    logger.info('[ELEVENLABS_KB] Document updated successfully', {
      documentationId,
      type,
      companyId,
      displayName,
      contentLength: content.length,
    });

    return data;
  } catch (error: any) {
    logger.error('[ELEVENLABS_KB] Error updating document', {
      documentationId,
      type,
      companyId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Update multiple knowledge base documents
 * Returns results for each document update attempt
 */
export async function updateMultipleKnowledgeBaseDocuments(
  documents: Array<{ 
    documentationId: string; 
    companyId: string;
    type: 'campaigns' | 'deals';
    displayName: string;
  }>
): Promise<{
  success: Array<{ documentationId: string; result: UpdateDocumentResponse }>;
  failed: Array<{ documentationId: string; error: string }>;
}> {
  const results = {
    success: [] as Array<{ documentationId: string; result: UpdateDocumentResponse }>,
    failed: [] as Array<{ documentationId: string; error: string }>,
  };

  for (const doc of documents) {
    try {
      const result = await updateKnowledgeBaseDocument(doc);
      results.success.push({ documentationId: doc.documentationId, result });
    } catch (error: any) {
      results.failed.push({
        documentationId: doc.documentationId,
        error: error.message || 'Unknown error',
      });
    }
  }

  return results;
}

