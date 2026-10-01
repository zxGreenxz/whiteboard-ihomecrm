interface NetworkRequest { url(): string; method(): string }
interface NavigationCancellation {
  boundary: string;
  path: string;
  method: string;
  failure: string;
  responseStatus: number | undefined;
}
export function createNavigationReadGuard(options: { appOrigin: string; testOrigin: string }): {
  started(request: NetworkRequest): Set<NetworkRequest>;
  finished(request: NetworkRequest): boolean;
  snapshot(action: string): void;
  cancelled(request: NetworkRequest, failure: string, responseStatus: number | undefined): NavigationCancellation | null;
};
export function requestCommissionProbe(ctx: { url: string; cred: { testPublishableKey: string } }, jwt: string, path: string, body: unknown): Promise<{ status: number; json: unknown; ms: number }>;
export function safeHttpFailure(body: unknown): { message: string; code?: string };
