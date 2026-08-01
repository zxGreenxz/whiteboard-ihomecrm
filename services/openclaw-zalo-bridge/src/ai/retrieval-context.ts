import type { PromptPurpose, Sensitivity } from "./dlp.js";
import { selectChunksForPrompt } from "./dlp.js";

export interface VersionedKnowledgeChunk {
  chunkId: string;
  knowledgeVersionId: string;
  sensitivity: Sensitivity;
  text: string;
}

export const MAX_RETRIEVAL_CODE_POINTS = 16_000;
export const MAX_RETRIEVAL_UTF8_BYTES = 32 * 1_024;

export function buildRetrievalContext({
  purpose,
  frozenKnowledgeVersionIds,
  chunks,
}: {
  purpose: PromptPurpose;
  frozenKnowledgeVersionIds: readonly string[];
  chunks: readonly VersionedKnowledgeChunk[];
}): Array<{ chunkId: string; text: string }> {
  const allowedVersions = new Set(frozenKnowledgeVersionIds);
  const frozen = chunks.filter((chunk) => allowedVersions.has(chunk.knowledgeVersionId));
  const context: Array<{ chunkId: string; text: string }> = [];
  let codePoints = 0;
  let utf8Bytes = 0;
  for (const { chunkId, text } of selectChunksForPrompt(frozen, purpose)) {
    const nextCodePoints = Array.from(text).length;
    const nextUtf8Bytes = Buffer.byteLength(text, "utf8");
    if (
      codePoints + nextCodePoints > MAX_RETRIEVAL_CODE_POINTS ||
      utf8Bytes + nextUtf8Bytes > MAX_RETRIEVAL_UTF8_BYTES
    ) break;
    context.push({ chunkId, text });
    codePoints += nextCodePoints;
    utf8Bytes += nextUtf8Bytes;
  }
  return context;
}
