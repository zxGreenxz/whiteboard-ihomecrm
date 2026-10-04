import {
  BankEmailActualOutcomeError,
  BankEmailReviewPendingError,
  parseBankEmailReview,
  readBankEmailTransaction,
  reviewBankEmail,
  type BankEmailReceipt,
  type BankEmailReviewExpectation,
} from './bankEmail';
import { financialPending, type FinancialPendingScope } from './financialPending';
import { FinancialWorkflowError, isConfirmedFinancialRejection } from './financialWorkflow';

export type BankEmailReviewInput = BankEmailReviewExpectation & {
  actorId: string;
  organizationId: string;
  invoiceNumber?: string;
};

type ReviewDependencies = {
  store: typeof financialPending;
  read: typeof readBankEmailTransaction;
  send: typeof reviewBankEmail;
};

const active = new Set<string>();

function unresolved(cause?: unknown) {
  return new FinancialWorkflowError(
    'Chưa xác nhận được kết quả đối soát ACB. Tải lại trạng thái nguồn và đối chiếu trước khi thao tác tiếp.',
    'unknown', [], cause,
  );
}

/** A source ID is the durable idempotency boundary. Never release an unknown marker on a cache read. */
export async function executeBankEmailReview(
  input: BankEmailReviewInput,
  dependencies: Partial<ReviewDependencies> = {},
): Promise<BankEmailReceipt> {
  const store = dependencies.store ?? financialPending;
  const read = dependencies.read ?? readBankEmailTransaction;
  const send = dependencies.send ?? reviewBankEmail;
  const scope: FinancialPendingScope = {
    namespace: 'bank-email-review', userId: input.actorId,
    organizationId: input.organizationId, businessKey: input.transactionId,
  };
  const key = JSON.stringify(scope);
  if (active.has(key)) throw unresolved();
  active.add(key);
  try {
    const prior = store.read(scope);
    if (prior) {
      let source;
      try { source = await read(input.transactionId); }
      catch (error) { throw unresolved(error); }
      if (source.status !== 'PENDING') {
        try {
          const confirmed = parseBankEmailReview(source, input);
          if (!store.clearConfirmed(scope, prior.attemptId)) throw unresolved();
          return confirmed;
        } catch (error) {
          if (error instanceof BankEmailActualOutcomeError) {
            // The source is terminal and its V5 receipt has passed boundary checks.
            if (!store.clearConfirmed(scope, prior.attemptId)) throw unresolved();
          }
          throw error;
        }
      }
    }
    const marker = prior ?? store.markPending(scope, { requestKey: crypto.randomUUID() });
    try {
      const received = await send(input);
      const confirmed = parseBankEmailReview(received, input);
      if (!store.clearConfirmed(scope, marker.attemptId)) throw unresolved();
      return confirmed;
    } catch (error) {
      if (error instanceof BankEmailActualOutcomeError || error instanceof BankEmailReviewPendingError) {
        // A valid terminal receipt or an authoritative PENDING response resolves the attempt.
        if (!store.clearConfirmed(scope, marker.attemptId)) throw unresolved();
        throw error;
      }
      if (error instanceof FinancialWorkflowError) throw error;
      if (isConfirmedFinancialRejection(error)) {
        let source;
        try { source = await read(input.transactionId); }
        catch (readError) { throw unresolved(readError); }
        if (source.status !== 'PENDING') {
          try {
            const confirmed = parseBankEmailReview(source, input);
            if (!store.clearConfirmed(scope, marker.attemptId)) throw unresolved();
            return confirmed;
          } catch (outcomeError) {
            if (outcomeError instanceof BankEmailActualOutcomeError) {
              if (!store.clearConfirmed(scope, marker.attemptId)) throw unresolved();
            }
            throw outcomeError;
          }
        }
        // The request was rejected, but another same-source request may still be in flight.
        // Retain the marker; a later click reads the source and retries only if still PENDING.
        throw error;
      }
      throw unresolved(error);
    }
  } finally {
    active.delete(key);
  }
}
