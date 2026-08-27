import { expect, test, type Page } from "@playwright/test";

const expectedToolNames = [
  "get_onboarding_state",
  "get_recovery_plan",
  "propose_recovery",
  "resume_onboarding",
  "search_orientation_slots",
  "start_onboarding",
];

async function installWebMcpTestBrowser(page: Page) {
  await page.addInitScript(() => {
    type Tool = {
      name: string;
      title?: string;
      description: string;
      inputSchema?: {
        type?: string;
        properties?: Record<string, { type?: string; enum?: unknown[] }>;
        required?: string[];
        additionalProperties?: boolean;
      };
      annotations?: { readOnlyHint?: boolean };
      execute: (
        input: Record<string, unknown>,
        context?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };

    const registrations = new Map<string, Tool>();
    const context = {
      async registerTool(tool: Tool, options?: { signal?: AbortSignal }) {
        if (registrations.has(tool.name)) {
          throw new DOMException(`Duplicate tool: ${tool.name}`, "InvalidStateError");
        }
        options?.signal?.throwIfAborted();
        registrations.set(tool.name, tool);
        options?.signal?.addEventListener(
          "abort",
          () => {
            if (registrations.get(tool.name) === tool) registrations.delete(tool.name);
          },
          { once: true },
        );
      },
      async getTools() {
        return [...registrations.values()]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((tool) => ({
            name: tool.name,
            title: tool.title ?? "",
            description: tool.description,
            inputSchema: JSON.stringify(tool.inputSchema ?? {}),
            annotations: tool.annotations ?? { readOnlyHint: false },
          }));
      },
      async executeTool(
        discovered: { name: string },
        serializedInput: string,
        options?: { signal?: AbortSignal },
      ) {
        const tool = registrations.get(discovered.name);
        if (!tool) throw new DOMException("Tool is no longer registered", "InvalidStateError");
        const input = JSON.parse(serializedInput) as Record<string, unknown>;
        const schema = tool.inputSchema;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new TypeError("Tool input must be an object");
        }
        if (schema?.additionalProperties === false) {
          const allowed = new Set(Object.keys(schema.properties ?? {}));
          if (Object.keys(input).some((key) => !allowed.has(key))) {
            throw new TypeError("Tool input has additional properties");
          }
        }
        for (const required of schema?.required ?? []) {
          if (!(required in input)) throw new TypeError(`Missing required input: ${required}`);
        }
        for (const [key, definition] of Object.entries(schema?.properties ?? {})) {
          const value = input[key];
          if (value !== undefined && definition.type === "string" && typeof value !== "string") {
            throw new TypeError(`${key} must be a string`);
          }
          if (value !== undefined && definition.enum && !definition.enum.includes(value)) {
            throw new TypeError(`${key} is not an allowed value`);
          }
        }
        options?.signal?.throwIfAborted();
        return options === undefined
          ? tool.execute(input)
          : tool.execute(input, { signal: options.signal });
      },
    };

    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: context,
    });
  });
}

async function executeTool(page: Page, name: string, input: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ toolName, args }) => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: { name: string }, input: string): Promise<unknown>;
      };
      const tools = await modelContext.getTools();
      const selected = tools.find((tool) => tool.name === toolName);
      if (!selected) throw new Error(`Missing WebMCP tool: ${toolName}`);
      return modelContext.executeTool(selected, JSON.stringify(args));
    },
    { toolName: name, args: input },
  );
}

async function executeToolWithSignal(
  page: Page,
  name: string,
  input: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ toolName, args }) => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(
          tool: { name: string },
          input: string,
          options: { signal: AbortSignal },
        ): Promise<unknown>;
      };
      const tools = await modelContext.getTools();
      const selected = tools.find((tool) => tool.name === toolName);
      if (!selected) throw new Error(`Missing WebMCP tool: ${toolName}`);
      return modelContext.executeTool(selected, JSON.stringify(args), {
        signal: new AbortController().signal,
      });
    },
    { toolName: name, args: input },
  );
}

async function executeSerialized(page: Page, name: string, serializedInput: string) {
  return page.evaluate(
    async ({ toolName, args }) => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: { name: string }, input: string): Promise<unknown>;
      };
      const selected = (await modelContext.getTools()).find(
        (tool) => tool.name === toolName,
      );
      if (!selected) throw new Error(`Missing WebMCP tool: ${toolName}`);
      return modelContext.executeTool(selected, args);
    },
    { toolName: name, args: serializedInput },
  );
}

async function expectRejected(promise: Promise<unknown>, message: string) {
  try {
    await promise;
    throw new Error("Expected WebMCP execution to reject");
  } catch (error) {
    expect(String(error)).toContain(message);
  }
}

test("registered executors accept supplied and absent execution contexts", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();

  await expect(executeToolWithSignal(page, "get_onboarding_state")).resolves.toMatchObject({
    workflowStatus: "not_started",
  });
  await expect(executeTool(page, "get_onboarding_state")).resolves.toMatchObject({
    workflowStatus: "not_started",
  });
});

test("reconstructs exactly six registrations across repeated page mounts", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");

  for (let mount = 0; mount < 5; mount++) {
    await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("webmcp-status")).toContainText("6 tools connected");
    const names = await page.evaluate(async () => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
      };
      return (await modelContext.getTools()).map((tool) => tool.name);
    });
    expect(names).toEqual(expectedToolNames);
    expect(new Set(names).size).toBe(6);
    if (mount < 4) await page.reload();
  }
});

test("discovers and executes the six-tool human-approved recovery flow", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("webmcp-status")).toContainText(
    "6 tools connected",
  );
  await page.getByRole("button", { name: "Reset demo" }).click();

  const discovered = await page.evaluate(async () => {
    const modelContext = document.modelContext as typeof document.modelContext & {
      getTools(): Promise<
        Array<{
          name: string;
          description: string;
          inputSchema: string;
          annotations: { readOnlyHint?: boolean };
        }>
      >;
    };
    return (await modelContext.getTools()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: JSON.parse(tool.inputSchema),
      readOnlyHint: tool.annotations.readOnlyHint ?? false,
    }));
  });
  expect(discovered.map((tool) => tool.name)).toEqual(expectedToolNames);
  expect(new Set(discovered.map((tool) => tool.name)).size).toBe(6);
  expect(
    discovered.filter((tool) => tool.readOnlyHint).map((tool) => tool.name),
  ).toEqual([
    "get_onboarding_state",
    "get_recovery_plan",
    "search_orientation_slots",
  ]);
  for (const tool of discovered) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }

  const invalidSlot = await page.evaluate(async () => {
    const modelContext = document.modelContext as typeof document.modelContext & {
      getTools(): Promise<Array<{ name: string }>>;
      executeTool(tool: { name: string }, input: string): Promise<unknown>;
    };
    const tool = (await modelContext.getTools()).find(
      (candidate) => candidate.name === "propose_recovery",
    )!;
    try {
      await modelContext.executeTool(tool, JSON.stringify({ slot: "Thursday" }));
      return { rejected: false, message: "" };
    } catch (error) {
      return { rejected: true, message: String(error) };
    }
  });
  expect(invalidSlot.rejected).toBe(true);
  expect(invalidSlot.message).toContain("not an allowed value");

  const initial = await executeTool(page, "get_onboarding_state") as {
    workflowStatus: string;
    canResume: boolean;
  };
  expect(initial).toMatchObject({ workflowStatus: "not_started", canResume: false });

  const started = await executeTool(page, "start_onboarding") as {
    outcome: string;
    state: { sideEffects: Record<string, unknown>; pendingFailure: { step: string } };
  };
  expect(started.outcome).toBe("paused_on_failure");
  expect(started.state.pendingFailure.step).toBe("book_orientation");
  expect(started.state.sideEffects).toEqual({
    employees: 1,
    workspaces: 1,
    figmaLicences: 1,
    laptops: 1,
    orientation: null,
    welcomeEmails: 0,
  });

  const recovery = await executeTool(page, "get_recovery_plan") as {
    available: boolean;
    plan: {
      failedStep: string;
      preserve: string[];
      recover: { options: string[] };
      blocked: Array<{ step: string }>;
      resumePoint: string;
    };
  };
  expect(recovery).toMatchObject({
    available: true,
    plan: {
      failedStep: "book_orientation",
      preserve: ["create_employee", "create_workspace", "assign_figma", "order_laptop"],
      recover: { options: ["RETRY", "REPLACE_INPUT"] },
      blocked: [{ step: "send_welcome_email" }],
      resumePoint: "book_orientation",
    },
  });
  await expect(executeTool(page, "search_orientation_slots")).resolves.toEqual({
    available: ["Tuesday", "Wednesday"],
  });

  const proposed = await executeTool(page, "propose_recovery", { slot: "Tuesday" }) as {
    proposed: boolean;
    waitingForHuman: boolean;
  };
  expect(proposed).toMatchObject({ proposed: true, waitingForHuman: true });
  await expect(page.getByText("Human decision required")).toBeVisible();

  const pending = await executeTool(page, "get_onboarding_state") as {
    humanApproval: { pending: boolean; approved: boolean };
    canResume: boolean;
  };
  expect(pending).toMatchObject({
    humanApproval: { pending: true, approved: false },
    canResume: false,
  });
  const rejectedResume = await executeTool(page, "resume_onboarding") as {
    resumed: boolean;
    reason: string;
  };
  expect(rejectedResume).toEqual({
    resumed: false,
    reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
    humanAction: "Approve the current recovery proposal in the webpage.",
  });

  await page.getByRole("button", { name: "Approve recovery" }).click();
  await expect(page.getByRole("button", { name: "Resume safely" })).toHaveCount(0);
  await expect(
    page.getByText("Recovery approved. Waiting for the agent to resume the workflow."),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const state = await executeTool(page, "get_onboarding_state") as { canResume: boolean };
      return state.canResume;
    })
    .toBe(true);

  const approved = await executeTool(page, "get_onboarding_state") as {
    workflowStatus: string;
    steps: Array<{ id: string; attempts: number; status: string }>;
    sideEffects: Record<string, unknown>;
  };
  expect(approved).toMatchObject({
    workflowStatus: "paused_on_failure",
    steps: expect.arrayContaining([
      expect.objectContaining({ id: "book_orientation", attempts: 1, status: "failed" }),
      expect.objectContaining({
        id: "send_welcome_email",
        attempts: 0,
        status: "not_started",
      }),
    ]),
    sideEffects: {
      employees: 1,
      workspaces: 1,
      figmaLicences: 1,
      laptops: 1,
      orientation: null,
      welcomeEmails: 0,
    },
  });

  const resumed = await executeTool(page, "resume_onboarding") as {
    resumed: boolean;
    state: { workflowStatus: string; sideEffects: Record<string, unknown> };
  };
  expect(resumed).toMatchObject({
    resumed: true,
    state: {
      workflowStatus: "complete",
      sideEffects: {
        employees: 1,
        workspaces: 1,
        figmaLicences: 1,
        laptops: 1,
        orientation: "Tuesday",
        welcomeEmails: 1,
      },
    },
  });
  await expect(page.locator(".activity-message")).toHaveText(
    "Recovered. Maya’s onboarding completed without repeating valid work.",
  );

  const repeatedStart = await executeTool(page, "start_onboarding") as {
    started: boolean;
    reason: string;
  };
  expect(repeatedStart).toMatchObject({
    started: false,
    reason: "WORKFLOW_ALREADY_STARTED",
  });
  const repeatedResume = await executeTool(page, "resume_onboarding") as {
    resumed: boolean;
  };
  expect(repeatedResume.resumed).toBe(false);
  const finalState = await executeTool(page, "get_onboarding_state") as {
    sideEffects: Record<string, unknown>;
    steps: Array<{ id: string; attempts: number }>;
  };
  expect(finalState.sideEffects).toEqual({
    employees: 1,
    workspaces: 1,
    figmaLicences: 1,
    laptops: 1,
    orientation: "Tuesday",
    welcomeEmails: 1,
  });
  expect(Object.fromEntries(finalState.steps.map((item) => [item.id, item.attempts]))).toEqual({
    create_employee: 1,
    create_workspace: 1,
    assign_figma: 1,
    order_laptop: 1,
    book_orientation: 2,
    send_welcome_email: 1,
  });
});

test("a newer proposal invalidates the prior human approval", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();

  await executeTool(page, "start_onboarding");
  await executeTool(page, "propose_recovery", { slot: "Tuesday" });
  await page.getByRole("button", { name: "Approve recovery" }).click();
  await expect
    .poll(async () => {
      const state = await executeTool(page, "get_onboarding_state") as { canResume: boolean };
      return state.canResume;
    })
    .toBe(true);

  await executeTool(page, "propose_recovery", { slot: "Wednesday" });
  const state = await executeTool(page, "get_onboarding_state") as {
    canResume: boolean;
    humanApproval: { pending: boolean; proposal: { slot: string } };
  };
  expect(state).toMatchObject({
    canResume: false,
    humanApproval: { pending: true, proposal: { slot: "Wednesday" } },
  });
  await expect(executeTool(page, "resume_onboarding")).resolves.toMatchObject({
    resumed: false,
    reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
  });

  await page.getByRole("button", { name: "Approve recovery" }).click();
  await expect.poll(async () => {
    const approved = await executeTool(page, "get_onboarding_state") as {
      canResume: boolean;
      humanApproval: { proposal: { slot: string; status: string } };
    };
    return approved.canResume &&
      approved.humanApproval.proposal.slot === "Wednesday" &&
      approved.humanApproval.proposal.status === "approved";
  }).toBe(true);
  await page.reload();
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await expect(executeTool(page, "get_onboarding_state")).resolves.toMatchObject({
    canResume: true,
    humanApproval: { proposal: { slot: "Wednesday", status: "approved" } },
  });
  await expect(executeTool(page, "resume_onboarding")).resolves.toMatchObject({
    resumed: true,
    state: {
      workflowStatus: "complete",
      sideEffects: { orientation: "Wednesday", welcomeEmails: 1 },
    },
  });
});

test("fails closed for unsafe ordering and malformed WebMCP arguments", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();

  await expect(executeTool(page, "get_recovery_plan")).resolves.toEqual({
    available: false,
    plan: null,
  });
  await expect(executeTool(page, "propose_recovery", { slot: "Tuesday" })).resolves.toEqual({
    proposed: false,
    reason: "NO_RECOVERABLE_ORIENTATION_FAILURE",
  });
  await expect(executeTool(page, "resume_onboarding")).resolves.toMatchObject({
    resumed: false,
    reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
  });
  await expect(executeTool(page, "search_orientation_slots")).resolves.toEqual({
    available: ["Tuesday", "Wednesday"],
  });

  await expectRejected(executeTool(page, "start_onboarding", { unexpected: true }), "additional properties");
  await expectRejected(executeTool(page, "get_onboarding_state", { extra: "value" }), "additional properties");
  await expectRejected(executeTool(page, "propose_recovery", {}), "Missing required input");
  await expectRejected(executeTool(page, "propose_recovery", { slot: 7 }), "must be a string");
  await expectRejected(executeTool(page, "propose_recovery", { slot: "Thursday" }), "not an allowed value");
  await expectRejected(
    executeTool(page, "propose_recovery", { slot: "Tuesday", extra: true }),
    "additional properties",
  );
  await expectRejected(executeSerialized(page, "start_onboarding", "{"), "JSON");
  await expectRejected(executeSerialized(page, "start_onboarding", "null"), "must be an object");
  await expectRejected(executeSerialized(page, "start_onboarding", "[]"), "must be an object");

  const untouched = await executeTool(page, "get_onboarding_state") as {
    workflowStatus: string;
    sideEffects: Record<string, unknown>;
  };
  expect(untouched).toMatchObject({
    workflowStatus: "not_started",
    sideEffects: {
      employees: 0,
      workspaces: 0,
      figmaLicences: 0,
      laptops: 0,
      orientation: null,
      welcomeEmails: 0,
    },
  });
});

test("serializes concurrent starts and repeated proposals without side effects or approval", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();

  const starts = await Promise.all([
    executeTool(page, "start_onboarding"),
    executeTool(page, "start_onboarding"),
  ]) as Array<{ started: boolean }>;
  expect(starts.filter((result) => result.started)).toHaveLength(1);

  const beforeProposal = await executeTool(page, "get_onboarding_state") as {
    steps: Array<{ id: string; attempts: number }>;
    sideEffects: Record<string, unknown>;
  };
  expect(beforeProposal.sideEffects).toEqual({
    employees: 1,
    workspaces: 1,
    figmaLicences: 1,
    laptops: 1,
    orientation: null,
    welcomeEmails: 0,
  });
  expect(Object.fromEntries(beforeProposal.steps.map((item) => [item.id, item.attempts]))).toEqual({
    create_employee: 1,
    create_workspace: 1,
    assign_figma: 1,
    order_laptop: 1,
    book_orientation: 1,
    send_welcome_email: 0,
  });
  await expect(executeTool(page, "resume_onboarding")).resolves.toMatchObject({
    resumed: false,
    reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
  });

  const proposals = await Promise.all([
    executeTool(page, "propose_recovery", { slot: "Tuesday" }),
    executeTool(page, "propose_recovery", { slot: "Tuesday" }),
    executeTool(page, "propose_recovery", { slot: "Tuesday" }),
  ]) as Array<{ proposal: { id: string } }>;
  expect(new Set(proposals.map((result) => result.proposal.id)).size).toBe(3);
  const pending = await executeTool(page, "get_onboarding_state") as {
    canResume: boolean;
    humanApproval: { pending: boolean; approved: boolean };
    sideEffects: { welcomeEmails: number };
  };
  expect(pending).toMatchObject({
    canResume: false,
    humanApproval: { pending: true, approved: false },
    sideEffects: { welcomeEmails: 0 },
  });
  await expect(executeTool(page, "resume_onboarding")).resolves.toMatchObject({
    resumed: false,
    reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
  });
});

test("keeps proposal and approval bound across a resume/proposal race", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await executeTool(page, "start_onboarding");
  await executeTool(page, "propose_recovery", { slot: "Tuesday" });
  await page.getByRole("button", { name: "Approve recovery" }).click();
  await expect.poll(async () => {
    const state = await executeTool(page, "get_onboarding_state") as { canResume: boolean };
    return state.canResume;
  }).toBe(true);

  const results = await page.evaluate(async () => {
    const modelContext = document.modelContext as typeof document.modelContext & {
      getTools(): Promise<Array<{ name: string }>>;
      executeTool(tool: { name: string }, input: string): Promise<unknown>;
    };
    const tools = await modelContext.getTools();
    const resume = tools.find((tool) => tool.name === "resume_onboarding")!;
    const propose = tools.find((tool) => tool.name === "propose_recovery")!;
    return Promise.all([
      modelContext.executeTool(resume, "{}"),
      modelContext.executeTool(propose, JSON.stringify({ slot: "Wednesday" })),
    ]);
  }) as Array<Record<string, unknown>>;

  const state = await executeTool(page, "get_onboarding_state") as {
    workflowStatus: string;
    sideEffects: { orientation: string | null; welcomeEmails: number };
    humanApproval: { proposal: { slot: string; status: string } | null };
  };
  const resumed = results[0] as { resumed: boolean };
  const proposed = results[1] as { proposed: boolean };
  if (resumed.resumed) {
    expect(proposed.proposed).toBe(false);
    expect(state).toMatchObject({
      workflowStatus: "complete",
      sideEffects: { orientation: "Tuesday", welcomeEmails: 1 },
    });
  } else {
    expect(proposed.proposed).toBe(true);
    expect(state).toMatchObject({
      workflowStatus: "paused_on_failure",
      sideEffects: { orientation: null, welcomeEmails: 0 },
      humanApproval: { proposal: { slot: "Wednesday", status: "pending" } },
    });
  }
});

test("binds approval and proposal IDs correctly during an approval race", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await executeTool(page, "start_onboarding");
  await executeTool(page, "propose_recovery", { slot: "Tuesday" });

  await Promise.all([
    page.getByRole("button", { name: "Approve recovery" }).click(),
    executeTool(page, "propose_recovery", { slot: "Wednesday" }),
  ]);

  const binding = await page.evaluate(async () => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = <T>(db: IDBDatabase, store: string, key: IDBValidKey) =>
      new Promise<T | undefined>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error);
      });
    const all = <T>(db: IDBDatabase, store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });

    const stateDb = await open("selective-recovery-demo-state");
    const proposal = await read<{
      id: string;
      slot: string;
      status: string;
      approvalId?: string;
    }>(stateDb, "records", "recovery-proposal-v1");
    stateDb.close();
    const journalDb = await open("selective-recovery-demo");
    const events = await all<{
      type: string;
      data?: { approvalId?: string; proposalId?: string };
    }>(journalDb, "journal-events");
    journalDb.close();
    const matchingApproval = events.find(
      (event) => event.type === "APPROVAL_GRANTED" &&
        event.data?.approvalId === proposal?.approvalId,
    );
    return {
      proposal,
      matchingProposalId: matchingApproval?.data?.proposalId ?? null,
    };
  });

  expect(binding.proposal?.slot).toBe("Wednesday");
  if (binding.proposal?.status === "approved") {
    expect(binding.proposal.approvalId).toBeTruthy();
    expect(binding.matchingProposalId).toBe(binding.proposal.id);
    await expect(executeTool(page, "get_onboarding_state")).resolves.toMatchObject({
      canResume: true,
    });
  } else {
    expect(binding.proposal).toMatchObject({ status: "pending" });
    expect(binding.proposal?.approvalId).toBeUndefined();
    expect(binding.matchingProposalId).toBeNull();
    await expect(executeTool(page, "get_onboarding_state")).resolves.toMatchObject({
      canResume: false,
      sideEffects: { welcomeEmails: 0 },
    });
  }
});

test("cancellation never reports an uncompleted workflow as successful", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();

  await expectRejected(
    page.evaluate(async () => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: { name: string }, input: string, options: { signal: AbortSignal }): Promise<unknown>;
      };
      const tool = (await modelContext.getTools()).find((item) => item.name === "start_onboarding")!;
      const controller = new AbortController();
      controller.abort("cancelled-before-start");
      return modelContext.executeTool(tool, "{}", { signal: controller.signal });
    }),
    "cancelled-before-start",
  );
  await expect(executeTool(page, "get_onboarding_state")).resolves.toMatchObject({
    workflowStatus: "not_started",
    sideEffects: { welcomeEmails: 0 },
  });

  await expectRejected(
    page.evaluate(async () => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: { name: string }, input: string, options: { signal: AbortSignal }): Promise<unknown>;
      };
      const tool = (await modelContext.getTools()).find((item) => item.name === "start_onboarding")!;
      const controller = new AbortController();
      setTimeout(() => controller.abort("cancelled-in-flight"), 50);
      return modelContext.executeTool(tool, "{}", { signal: controller.signal });
    }),
    "cancelled-in-flight",
  );
  const cancelled = await executeTool(page, "get_onboarding_state") as {
    workflowStatus: string;
    sideEffects: { welcomeEmails: number };
  };
  expect(cancelled.workflowStatus).not.toBe("complete");
  expect(cancelled.sideEffects.welcomeEmails).toBe(0);
});
