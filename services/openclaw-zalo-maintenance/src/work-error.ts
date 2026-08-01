export class MaintenanceRetryableWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceRetryableWorkError";
  }
}
