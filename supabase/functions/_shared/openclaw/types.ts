export type PrincipalKind = "CHANNEL" | "MAINTENANCE";

export interface ChannelPrincipal {
  version: 1;
  principalKind: "CHANNEL";
  organizationId: string;
  accountId: string;
  cellId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  sessionGeneration: number;
}

export interface MaintenancePrincipal {
  version: 1;
  principalKind: "MAINTENANCE";
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
}

export type RuntimePrincipal = ChannelPrincipal | MaintenancePrincipal;

export interface RuntimeRequirement {
  operation: string;
  principalKind: PrincipalKind;
}

export interface RuntimeVerification {
  operation: string;
  principal: RuntimePrincipal;
  nonce: string;
  bodySha256: string;
}
