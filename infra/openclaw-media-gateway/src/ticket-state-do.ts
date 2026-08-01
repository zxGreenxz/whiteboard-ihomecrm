import { TicketStateStore, type TicketStateStorage } from "./ticket-state";

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
    };
    this.store = new TicketStateStore(storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST"
      ? await request.json<Record<string, unknown>>()
      : {};

    switch (url.pathname) {
      case "/consume-jti": {
        const consumed = await this.store.consumeJti(
          String(body.jti),
          Number(body.expiresAtEpochSeconds),
        );
        return Response.json({ consumed });
      }
      case "/raise-generation": {
        const generation = await this.store.raiseMinimumGeneration(
          {
            organizationId: String(body.organizationId),
            accountId: body.accountId === null ? null : String(body.accountId),
          },
          Number(body.sessionGeneration),
        );
        return Response.json({ generation });
      }
      case "/minimum-generation": {
        const generation = await this.store.minimumGeneration({
          organizationId: String(body.organizationId),
          accountId: body.accountId === null ? null : String(body.accountId),
        });
        return Response.json({ generation });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }
}