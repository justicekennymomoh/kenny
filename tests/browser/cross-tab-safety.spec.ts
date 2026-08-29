import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const MUTATION_LOCK = "kenny:onboard_maya_v1:mutation";

async function installWebMcpTestBrowser(page: Page) {
  await page.addInitScript(() => {
    type Tool = {
      name: string;
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    };
    const registrations = new Map<string, Tool>();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        async registerTool(tool: Tool, options?: { signal?: AbortSignal }) {
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
          return [...registrations.values()].map((tool) => ({ name: tool.name }));
        },
        async executeTool(discovered: { name: string }, serializedInput: string) {
          const tool = registrations.get(discovered.name);
          if (!tool) throw new Error(`Missing WebMCP tool: ${discovered.name}`);
          return tool.execute(JSON.parse(serializedInput) as Record<string, unknown>);
        },
      },
    });
  });
}

async function executeTool(
  page: Page,
  name: string,
  input: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ toolName, args }) => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: { name: string }, input: string): Promise<unknown>;
      };
      const tool = (await modelContext.getTools()).find((item) => item.name === toolName);
      if (!tool) throw new Error(`Missing WebMCP tool: ${toolName}`);
      return modelContext.executeTool(tool, JSON.stringify(args));
    },
    { toolName: name, args: input },
  );
}

async function openTwoTabs(context: BrowserContext, first: Page) {
  const second = await context.newPage();
  await Promise.all([
    installWebMcpTestBrowser(first),
    installWebMcpTestBrowser(second),
  ]);
  await Promise.all([first.goto("/"), second.goto("/")]);
  await Promise.all([
    expect(first.getByTestId("demo-root")).toHaveAttribute("data-ready", "true"),
    expect(second.getByTestId("demo-root")).toHaveAttribute("data-ready", "true"),
  ]);
  await first.getByRole("button", { name: "Reset demo" }).click();
  await expect.poll(async () => {
    const state = await executeTool(first, "get_onboarding_state") as {
      workflowStatus: string;
    };
    return state.workflowStatus;
  }).toBe("not_started");
  return [first, second] as const;
}

async function holdMutationLock(page: Page) {
  await page.evaluate((lockName) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = window as typeof window & {
      __kennyLockHeld?: boolean;
      __releaseKennyLock?: () => void;
    };
    target.__kennyLockHeld = false;
    target.__releaseKennyLock = release;
    void navigator.locks.request(lockName, async () => {
      target.__kennyLockHeld = true;
      await gate;
    });
  }, MUTATION_LOCK);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __kennyLockHeld?: boolean }
  ).__kennyLockHeld)).toBe(true);
}

async function releaseMutationLock(page: Page) {
  await page.evaluate(() => (
    window as typeof window & { __releaseKennyLock?: () => void }
  ).__releaseKennyLock?.());
}

async function queueTool(
  page: Page,
  key: string,
  name: string,
  input: Record<string, unknown> = {},
) {
  await page.evaluate(
    async ({ resultKey, toolName, args }) => {
      const modelContext = document.modelContext as typeof document.modelContext & {
        getTools(): Promise<Array<{ name: string }>>;
        executeTool(tool: { name: string }, input: string): Promise<unknown>;
      };
      const tool = (await modelContext.getTools()).find((item) => item.name === toolName)!;
      (window as unknown as Record<string, unknown>)[resultKey] =
        modelContext.executeTool(tool, JSON.stringify(args));
    },
    { resultKey: key, toolName: name, args: input },
  );
}

async function queuedResult<T>(page: Page, key: string): Promise<T> {
  return page.evaluate(
    async (resultKey) => await (
      window as unknown as Record<string, Promise<unknown>>
    )[resultKey],
    key,
  ) as Promise<T>;
}

async function pendingMutationLocks(page: Page) {
  return page.evaluate(async (lockName) => {
    const snapshot = await navigator.locks.query();
    return snapshot.pending?.filter((lock) => lock.name === lockName).length ?? 0;
  }, MUTATION_LOCK);
}

test("serializes simultaneous starts across two tabs", async ({ context, page }) => {
  const [first, second] = await openTwoTabs(context, page);
  const starts = await Promise.all([
    executeTool(first, "start_onboarding"),
    executeTool(second, "start_onboarding"),
  ]) as Array<{ started: boolean }>;

  expect(starts.filter((result) => result.started)).toHaveLength(1);
  const state = await executeTool(first, "get_onboarding_state") as {
    steps: Array<{ id: string; attempts: number }>;
    sideEffects: Record<string, unknown>;
  };
  expect(state.sideEffects).toEqual({
    employees: 1,
    workspaces: 1,
    figmaLicences: 1,
    laptops: 1,
    orientation: null,
    welcomeEmails: 0,
  });
  expect(Object.fromEntries(state.steps.map((step) => [step.id, step.attempts]))).toEqual({
    create_employee: 1,
    create_workspace: 1,
    assign_figma: 1,
    order_laptop: 1,
    book_orientation: 1,
    send_welcome_email: 0,
  });
});

test("retains document-local serialization when Web Locks is unavailable", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();

  const starts = await Promise.all([
    executeTool(page, "start_onboarding"),
    executeTool(page, "start_onboarding"),
  ]) as Array<{ started: boolean }>;
  expect(starts.filter((result) => result.started)).toHaveLength(1);
  await expect(executeTool(page, "get_onboarding_state")).resolves.toMatchObject({
    sideEffects: {
      employees: 1,
      workspaces: 1,
      figmaLicences: 1,
      laptops: 1,
      orientation: null,
      welcomeEmails: 0,
    },
  });
});

test("keeps concurrent proposals coherent and rejects a stale-tab approval", async ({
  context,
  page,
}) => {
  const [first, second] = await openTwoTabs(context, page);
  await executeTool(first, "start_onboarding");

  const [tuesday, wednesday] = await Promise.all([
    executeTool(first, "propose_recovery", { slot: "Tuesday" }),
    executeTool(second, "propose_recovery", { slot: "Wednesday" }),
  ]) as Array<{ proposal: { id: string; slot: string; status: string } }>;
  const concurrentState = await executeTool(first, "get_onboarding_state") as {
    canResume: boolean;
    humanApproval: { proposal: { id: string; slot: string; status: string } };
  };
  const persisted = concurrentState.humanApproval.proposal;
  expect([tuesday.proposal.id, wednesday.proposal.id]).toContain(persisted.id);
  expect(
    [tuesday.proposal, wednesday.proposal].find((item) => item.id === persisted.id),
  ).toMatchObject({ slot: persisted.slot, status: "pending" });
  expect(concurrentState.canResume).toBe(false);

  await first.reload();
  await expect(first.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await executeTool(first, "propose_recovery", { slot: "Tuesday" });
  await expect(first.getByLabel("Change orientation from Monday to Tuesday")).toBeVisible();
  await executeTool(second, "propose_recovery", { slot: "Wednesday" });
  await first.getByRole("button", { name: "Approve recovery" }).click();
  await expect(first.locator(".activity-message")).toContainText(
    "Approval blocked: the visible proposal is stale",
  );

  await expect(executeTool(second, "get_onboarding_state")).resolves.toMatchObject({
    canResume: false,
    humanApproval: {
      pending: true,
      approved: false,
      validForCurrentState: false,
      proposal: { slot: "Wednesday", status: "pending" },
    },
    sideEffects: { orientation: null, welcomeEmails: 0 },
  });
});

test("fails a queued resume closed when another tab replaces its proposal first", async ({
  context,
  page,
}) => {
  const [first, second] = await openTwoTabs(context, page);
  await executeTool(first, "start_onboarding");
  await executeTool(first, "propose_recovery", { slot: "Tuesday" });
  await first.getByRole("button", { name: "Approve recovery" }).click();
  await expect.poll(async () => (
    await executeTool(first, "get_onboarding_state") as { canResume: boolean }
  ).canResume).toBe(true);

  await holdMutationLock(second);
  await queueTool(second, "__proposalRace", "propose_recovery", { slot: "Wednesday" });
  const resume = executeTool(first, "resume_onboarding") as Promise<{
    resumed: boolean;
    reason?: string;
  }>;
  await expect.poll(() => pendingMutationLocks(second)).toBe(2);
  await releaseMutationLock(second);

  await expect(queuedResult<{ proposed: boolean }>(second, "__proposalRace")).resolves.toMatchObject({
    proposed: true,
  });
  await expect(resume).resolves.toEqual({
    resumed: false,
    reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
    humanAction: "Approve the current recovery proposal in the webpage.",
  });
  await expect(executeTool(first, "get_onboarding_state")).resolves.toMatchObject({
    workflowStatus: "paused_on_failure",
    canResume: false,
    humanApproval: { proposal: { slot: "Wednesday", status: "pending" } },
    sideEffects: { orientation: null, welcomeEmails: 0 },
  });
});

test("reset racing a mutation leaves one coherent clean workflow", async ({ context, page }) => {
  const [first, second] = await openTwoTabs(context, page);
  await holdMutationLock(first);
  await queueTool(first, "__startRace", "start_onboarding");
  await second.getByRole("button", { name: "Reset demo" }).click();
  await expect.poll(() => pendingMutationLocks(first)).toBe(2);
  await releaseMutationLock(first);

  await expect(queuedResult<{ started: boolean }>(first, "__startRace")).resolves.toMatchObject({
    started: true,
  });
  await expect.poll(async () => {
    const state = await executeTool(second, "get_onboarding_state") as {
      workflowStatus: string;
      steps: Array<{ attempts: number }>;
      sideEffects: Record<string, unknown>;
      humanApproval: { proposal: unknown };
    };
    return state.workflowStatus === "not_started" &&
      state.steps.every((step) => step.attempts === 0)
      ? state
      : null;
  }).toMatchObject({
    workflowStatus: "not_started",
    sideEffects: {
      employees: 0,
      workspaces: 0,
      figmaLicences: 0,
      laptops: 0,
      orientation: null,
      welcomeEmails: 0,
    },
    humanApproval: { proposal: null },
  });
});

test("renders the live recovery contract and capability boundary", async ({ page }) => {
  await installWebMcpTestBrowser(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reset demo" }).click();
  await executeTool(page, "start_onboarding");

  const inspector = page.getByTestId("recovery-contract-inspector");
  await inspector.locator("summary").click();
  await expect(inspector.getByRole("row")).toHaveCount(7);
  for (const expected of [
    ["create_employee", "Create employee account", "REVERSIBLE", "PRESERVE"],
    ["create_workspace", "Create workspace account", "REVERSIBLE", "PRESERVE"],
    ["assign_figma", "Assign design software licence", "REVERSIBLE", "PRESERVE"],
    ["order_laptop", "Order laptop", "COMPENSATABLE", "PRESERVE"],
    ["book_orientation", "Book orientation", "COMPENSATABLE", "RECOVER"],
    ["send_welcome_email", "Send welcome email", "IRREVERSIBLE", "BLOCKED"],
  ] as const) {
    const row = page.getByTestId(`contract-step-${expected[0]}`);
    await expect(row).toHaveAttribute("data-disposition", expected[3]);
    await expect(row.getByText(expected[1], { exact: true })).toBeVisible();
    await expect(row.getByText(expected[2], { exact: true })).toBeVisible();
    await expect(row.getByText(expected[3], { exact: true })).toBeVisible();
  }
  await expect(inspector.getByText("No WebMCP approval tool exists.")).toBeVisible();
  await expect(inspector.getByText("6 registered WebMCP tools")).toBeVisible();
  for (const capability of [
    "Inspect state",
    "Inspect recovery plan",
    "Search alternatives",
    "Propose recovery",
    "Resume after authorization",
  ]) {
    await expect(inspector.getByText(capability)).toBeVisible();
  }
});
