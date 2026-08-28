import { WORKFLOW_ID } from "./workflow";

export const ONBOARDING_MUTATION_LOCK = `kenny:${WORKFLOW_ID}:mutation`;

let documentMutationQueue: Promise<void> = Promise.resolve();

function serializeInDocument<T>(operation: () => Promise<T>): Promise<T> {
  const result = documentMutationQueue.then(operation, operation);
  documentMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function serializeOnboardingMutation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockManager = navigator.locks;
  if (!lockManager) return serializeInDocument(operation);

  const options: LockOptions = { mode: "exclusive" };
  if (signal) options.signal = signal;
  return lockManager.request<T>(
    ONBOARDING_MUTATION_LOCK,
    options,
    () => operation() as unknown as T,
  );
}
