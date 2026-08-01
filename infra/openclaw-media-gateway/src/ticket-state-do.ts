import {
  TicketStateStore,
  type GenerationDimension,
  type GenerationPrincipal,
  type TicketStateStorage,
} from "./ticket-state";

function transactionStorage(transaction: DurableObjectTransaction): TicketStateStorage {
  return {
    get: <T>(key: string) => transaction.get<T>(key),
    put: <T>(key: string, value: T) => transaction.put<T>(key, value),
    delete: (key: string) => transaction.delete(key),
    list: <T>(options: { prefix: string; end?: string; limit?: number }) =>
      typeof transaction.list === "function" ? transaction.list<T>(options) : Promise.resolve(new Map()),
  };
}

function generationPrincipal(body: Record<string, unknown>): GenerationPrincipal {
  return {
    organizationId: String(body.organizationId),
    principalKind: body.principalKind === "MAINTENANCE" ? "MAINTENANCE" : "CHANNEL",
    accountId: body.accountId === null ? null : String(body.accountId),
    cellId: body.cellId === null ? null : String(body.cellId),
    maintenancePrincipalId: body.maintenancePrincipalId === null
      ? null
      : String(body.maintenancePrincipalId),
  };
}

function ticketAdmission(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ticket admission missing");
  }
  const admission = value as Record<string, unknown>;
  const generations = admission.generations as Record<string, unknown> | undefined;
  const principal = admission.principal as Record<string, unknown> | undefined;
  if (!generations || !principal) throw new Error("ticket admission invalid");
  return {
    principal: generationPrincipal(principal),
    generations: {
      sessionGeneration: Number(generations.sessionGeneration),
      credentialGeneration: Number(generations.credentialGeneration),
      leaseGeneration: Number(generations.leaseGeneration),
      fencingToken: Number(generations.fencingToken),
    },
    nowEpochSeconds: Number(admission.nowEpochSeconds),
  };
}

/**
 * Durable Object wrapper. All logic lives in `TicketStateStore` so it can be
 * unit tested without a Workers runtime; this class only adapts the storage API.
 */
export class TicketStateDurableObject {
  private readonly store: TicketStateStore;

  constructor(private readonly state: DurableObjectState) {
    const storage: TicketStateStorage = {
      get: <T>(key: string) => this.state.storage.get<T>(key),
      put: <T>(key: string, value: T) => this.state.storage.put<T>(key, value),
      delete: (key: string) => this.state.storage.delete(key),
      list: <T>(options: { prefix: string; end?: string; limit?: number }) =>
        typeof this.state.storage.list === "function"
          ? this.state.storage.list<T>(options)
          : Promise.resolve(new Map()),
    };
    this.store = new TicketStateStore(storage);
  }

  private async transaction<T>(
    operation: (store: TicketStateStore) => Promise<T>,
  ): Promise<T> {
    return await this.state.storage.transaction(async (transaction) =>
      await operation(new TicketStateStore(transactionStorage(transaction)))
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST"
      ? await request.json<Record<string, unknown>>()
      : {};

    switch (url.pathname) {
      case "/health":
        return Response.json({ status: "ok" });
      case "/acquire-object-mutation": {
        const lease = await this.transaction(async (store) =>
          await store.acquireObjectMutation(
            body.kind === "DELETE" ? "DELETE" : "UPLOAD",
            String(body.executorId),
            Number(body.nowEpochMilliseconds),
            120_000,
          )
        );
        return Response.json(lease);
      }
      case "/mark-object-final-deleted": {
        try {
          await this.transaction(async (store) =>
            await store.markObjectFinalDeleted(
              String(body.executorId),
              Number(body.nowEpochMilliseconds),
            )
          );
          return Response.json({});
        } catch {
          return Response.json({ error: "OBJECT_MUTATION_LEASE_MISMATCH" }, { status: 409 });
        }
      }
      case "/release-object-mutation": {
        await this.transaction(async (store) =>
          await store.releaseObjectMutation(String(body.executorId))
        );
        return Response.json({});
      }
      case "/consume-jti": {
        const consumed = await this.transaction(async (store) =>
          await store.consumeJti(
            String(body.jti),
            Number(body.expiresAtEpochSeconds),
          )
        );
        return Response.json({ consumed });
      }
      case "/consume-revocation-nonce": {
        const consumed = await this.transaction(async (store) =>
          await store.consumeRevocationNonce(
            String(body.nonce),
            Number(body.seenAtEpochSeconds),
          )
        );
        return Response.json({ consumed });
      }
      case "/apply-revocation": {
        try {
          const result = await this.transaction(async (store) =>
            await store.applyRevocation(
            {
              ...generationPrincipal(body),
              dimension: String(body.dimension) as GenerationDimension,
            },
            String(body.nonce),
            Number(body.seenAtEpochSeconds),
            Number(body.minimumValidGeneration),
            body.revocationHash === undefined ? undefined : String(body.revocationHash),
            body.acknowledgement && typeof body.acknowledgement === "object"
              ? body.acknowledgement as Record<string, unknown>
              : undefined,
            )
          );
          return Response.json(result);
        } catch {
          return Response.json({ error: "REVOCATION_NONCE_CONFLICT" }, { status: 409 });
        }
      }
      case "/raise-generation": {
        const generation = await this.transaction(async (store) =>
          await store.raiseMinimumGeneration(
            {
              ...generationPrincipal(body),
              dimension: String(body.dimension) as GenerationDimension,
            },
            Number(body.minimumValidGeneration),
          )
        );
        return Response.json({ generation });
      }
      case "/minimum-generation": {
        const generation = await this.store.minimumGeneration({
          ...generationPrincipal(body),
          dimension: String(body.dimension) as GenerationDimension,
        });
        return Response.json({ generation });
      }
      case "/generation-floors": {
        const floors = await this.store.generationFloors(generationPrincipal(body));
        return Response.json({ floors });
      }
      case "/admit-ticket": {
        try {
          await this.transaction(async (store) =>
            await store.admitTicket(
              ticketAdmission(body.admission),
              { jti: String(body.jti), expiresAtEpochSeconds: Number(body.expiresAtEpochSeconds) },
              body.consumeJti === true,
            )
          );
          return Response.json({ admitted: true });
        } catch (error) {
          const code = error instanceof Error && error.message === "ticket generation revoked"
            ? "TICKET_GENERATION_REVOKED"
            : "TICKET_REPLAY";
          return Response.json({ error: code }, { status: 409 });
        }
      }
      case "/work-state": {
        const work = await this.store.workState(String(body.workClaimId)) ?? null;
        return Response.json({ work });
      }
      case "/begin-workflow": {
        try {
          if (body.createIfMissing === false) {
            const work = await this.store.storedWorkflowReceipt(
              String(body.workClaimId),
              String(body.claimHash),
              body.kind === "VERIFY" ? "VERIFY" : body.kind === "UPLOAD" ? "UPLOAD" : "DELETE",
              String(body.replayHash),
              Number(body.nowEpochSeconds),
            );
            return Response.json({ work });
          }
          const bindings = Array.isArray(body.bindings)
            ? body.bindings.map((binding) => {
              if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
                throw new Error("invalid binding");
              }
              const record = binding as Record<string, unknown>;
              return {
                jti: String(record.jti),
                expiresAtEpochSeconds: Number(record.expiresAtEpochSeconds),
              };
            })
            : [];
          const work = await this.transaction(async (store) =>
            await store.beginWorkflow(
              String(body.workClaimId),
              String(body.claimHash),
              body.kind === "VERIFY" ? "VERIFY" : body.kind === "UPLOAD" ? "UPLOAD" : "DELETE",
              bindings,
              ticketAdmission(body.admission),
              body.allowStaleRecovery === true,
              body.replayHash === undefined ? String(body.claimHash) : String(body.replayHash),
              body.recoveryReplacement === "AUTHORIZED_OR_EXPIRED"
                ? "AUTHORIZED_OR_EXPIRED"
                : "NONE",
              Array.isArray(body.replacementJtis)
                ? body.replacementJtis.map((jti) => String(jti))
                : [],
              body.initialPhase === "DELETE_IN_PROGRESS"
                ? "DELETE_IN_PROGRESS"
                : "AUTHORIZED",
            )
          );
          return Response.json({ work });
        } catch (error) {
          const code = error instanceof Error && error.message === "ticket generation revoked"
            ? "TICKET_GENERATION_REVOKED"
            : error instanceof Error && error.message === "workflow expired"
            ? "WORKFLOW_EXPIRED"
            : "WORKFLOW_CLAIM_MISMATCH";
          return Response.json({ error: code }, { status: 409 });
        }
      }
      case "/mark-work-in-progress": {
        try {
          const work = await this.transaction(async (store) =>
            await store.markWorkInProgress(
              String(body.workClaimId),
              String(body.claimHash),
              body.progress && typeof body.progress === "object" && !Array.isArray(body.progress)
                ? body.progress as Record<string, unknown>
                : {},
            )
          );
          return Response.json({ work });
        } catch {
          return Response.json({ error: "WORK_CLAIM_MISMATCH" }, { status: 409 });
        }
      }
      case "/acquire-work-execution": {
        try {
          const execution = await this.transaction(async (store) =>
            await store.acquireWorkExecution(
              String(body.workClaimId),
              String(body.claimHash),
              body.progress && typeof body.progress === "object" && !Array.isArray(body.progress)
                ? body.progress as Record<string, unknown>
                : {},
              String(body.executorId),
              Number(body.nowEpochMilliseconds),
              30_000,
            )
          );
          return Response.json(execution);
        } catch {
          return Response.json({ error: "WORK_CLAIM_MISMATCH" }, { status: 409 });
        }
      }
      case "/release-work-execution": {
        try {
          await this.transaction(async (store) =>
            await store.releaseWorkExecution(
              String(body.workClaimId),
              String(body.claimHash),
              String(body.executorId),
            )
          );
          return Response.json({});
        } catch {
          return Response.json({ error: "WORK_CLAIM_MISMATCH" }, { status: 409 });
        }
      }
      case "/store-work-receipt": {
        try {
          const receipt = await this.transaction(async (store) =>
            await store.storeWorkReceipt(
              String(body.workClaimId),
              String(body.claimHash),
              body.receipt as never,
              body.executorId === undefined ? undefined : String(body.executorId),
            )
          );
          return Response.json({ receipt });
        } catch {
          return Response.json({ error: "WORK_CLAIM_MISMATCH" }, { status: 409 });
        }
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }
}
