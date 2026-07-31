export class OpenClawHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    { expose = true, cause }: { expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "OpenClawHttpError";
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

export function deny(
  code: string,
  message: string,
  status = 403,
): never {
  throw new OpenClawHttpError(status, code, message);
}
