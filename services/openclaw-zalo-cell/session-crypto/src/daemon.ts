import {
  normalizeLogicalSessionPath,
  type EnvelopeMetadata,
  type SessionCryptoStore,
} from "./crypto.js";

export type SessionCryptoCommand =
  | { operation: "persist"; path: string }
  | { operation: "restore"; path: string }
  | { generation: string; operation: "rotate"; path: string };

export interface SessionCryptoCommandResult {
  generation: string;
  operation: SessionCryptoCommand["operation"];
  path: string;
}

function commandResult(
  operation: SessionCryptoCommand["operation"],
  logicalPath: string,
  metadata: EnvelopeMetadata,
): SessionCryptoCommandResult {
  return { generation: metadata.generation, operation, path: logicalPath };
}

/**
 * A narrow local-command boundary for a future Unix-socket or stdio adapter.
 * Commands contain paths and key generations only; secret bytes never enter results or logs.
 */
export class SessionCryptoDaemon {
  constructor(private readonly store: SessionCryptoStore) {}

  async execute(command: SessionCryptoCommand): Promise<SessionCryptoCommandResult> {
    const logicalPath = normalizeLogicalSessionPath(command.path);
    switch (command.operation) {
      case "persist":
        return commandResult(
          command.operation,
          logicalPath,
          await this.store.persistFromPlaintext(logicalPath),
        );
      case "restore":
        return commandResult(
          command.operation,
          logicalPath,
          await this.store.restoreToPlaintext(logicalPath),
        );
      case "rotate":
        return commandResult(
          command.operation,
          logicalPath,
          await this.store.rotateSession(logicalPath, command.generation),
        );
    }
  }
}
