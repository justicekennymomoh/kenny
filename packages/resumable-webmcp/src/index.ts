export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (
    input: Record<string, unknown>,
    context?: WebMcpExecutionContext,
  ) => Promise<unknown>;
}

export interface WebMcpExecutionContext {
  signal?: AbortSignal;
}

export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface RegisterToolsResult {
  available: boolean;
  registered: string[];
  dispose: () => void;
}

export interface RegisterToolsOptions {
  signal?: AbortSignal;
}

export async function registerWebMcpTools(
  modelContext: ModelContextLike | undefined,
  tools: WebMcpTool[],
  options: RegisterToolsOptions = {},
): Promise<RegisterToolsResult> {
  if (!modelContext) {
    return { available: false, registered: [], dispose: () => undefined };
  }

  const controller = new AbortController();
  const dispose = () => controller.abort();
  const abortFromOwner = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromOwner();
  else options.signal?.addEventListener("abort", abortFromOwner, { once: true });

  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    dispose();
    options.signal?.removeEventListener("abort", abortFromOwner);
    throw new Error("WebMCP tool names must be unique");
  }

  const registered: string[] = [];
  try {
    for (const tool of tools) {
      controller.signal.throwIfAborted();
      await modelContext.registerTool(tool, { signal: controller.signal });
      controller.signal.throwIfAborted();
      registered.push(tool.name);
    }
  } catch (error) {
    dispose();
    options.signal?.removeEventListener("abort", abortFromOwner);
    throw error;
  }

  return {
    available: true,
    registered,
    dispose: () => {
      options.signal?.removeEventListener("abort", abortFromOwner);
      dispose();
    },
  };
}
