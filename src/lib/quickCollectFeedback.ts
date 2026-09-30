import { collectionFailureMessage } from './collectionFeedback';
/** Only constructed from verified client validation, never from a server payload. */
export class QuickCollectInputError extends Error {}
export const quickCollectFailureMessage = (error:unknown) => error instanceof QuickCollectInputError ? error.message : collectionFailureMessage(error);
