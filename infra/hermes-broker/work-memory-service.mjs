import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { mayUseWorkMemory, workMemoryInput, workMemoryResult } from './work-memory-contract.mjs';

export function createWorkMemoryService(options) {
  const service = createBoundUserOperationService({ ...options,
    mayUse: mayUseWorkMemory, validateInput: workMemoryInput, validateResult: workMemoryResult });
  return Object.freeze({ prepareMemory: service.prepare, finalizeMemory: service.finalize });
}
