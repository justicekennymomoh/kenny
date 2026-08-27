import { expect, test, type Page } from "@playwright/test";

const effect = (page: Page, name: string) => page.getByTestId(name);
const step = (page: Page, name: string) => page.getByTestId(`step-${name}`);

async function expectReady(page: Page) {
  await expect(page.getByTestId("demo-root")).toHaveAttribute("data-ready", "true");
}

async function seedUnrelatedBrowserState(page: Page) {
  await page.evaluate(async () => {
    localStorage.setItem("unrelated-regression-key", "keep-me");

    const unrelated = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("unrelated-regression-database", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = unrelated.transaction("records", "readwrite");
      tx.objectStore("records").put("keep-me", "sentinel");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    unrelated.close();

    const demoState = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("selective-recovery-demo-state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = demoState.transaction("records", "readwrite");
      tx.objectStore("records").put("keep-me", "unrelated-record");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    demoState.close();

    const journal = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("selective-recovery-demo");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = journal.transaction("journal-events", "readwrite");
      tx.objectStore("journal-events").add({
        at: Date.now(),
        workflowId: "unrelated-workflow",
        type: "STEP_STARTED",
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    journal.close();
  });
}

async function expectUnrelatedBrowserStatePreserved(page: Page) {
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("unrelated-regression-key")))
    .toBe("keep-me");
  const state = await page.evaluate(async () => {
    const read = async (database: string, store: string, key: IDBValidKey) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return value;
    };

    const journal = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("selective-recovery-demo");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const unrelatedEvents = await new Promise<unknown[]>((resolve, reject) => {
      const request = journal
        .transaction("journal-events", "readonly")
        .objectStore("journal-events")
        .index("workflowId")
        .getAll("unrelated-workflow");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    journal.close();

    return {
      unrelatedRecord: await read(
        "unrelated-regression-database",
        "records",
        "sentinel",
      ),
      colocatedUnrelatedRecord: await read(
        "selective-recovery-demo-state",
        "records",
        "unrelated-record",
      ),
      unrelatedJournalEvents: unrelatedEvents.length,
    };
  });
  expect(state).toEqual({
    unrelatedRecord: "keep-me",
    colocatedUnrelatedRecord: "keep-me",
    unrelatedJournalEvents: 1,
  });
}

async function expectEffects(
  page: Page,
  expected: {
    employees: number;
    workspaces: number;
    figma: number;
    laptops: number;
    emails: number;
    orientation: string;
  },
) {
  await expect(effect(page, "employees-count")).toHaveText(String(expected.employees));
  await expect(effect(page, "workspaces-count")).toHaveText(String(expected.workspaces));
  await expect(effect(page, "figma-count")).toHaveText(String(expected.figma));
  await expect(effect(page, "laptops-count")).toHaveText(String(expected.laptops));
  await expect(effect(page, "emails-count")).toHaveText(String(expected.emails));
  await expect(effect(page, "orientation-value")).toHaveText(expected.orientation);
}

test("reconstructs paused and completed onboarding without replaying side effects", async ({
  page,
}) => {
  await page.goto("/");
  await expectReady(page);
  await expect(page.getByTestId("webmcp-status")).toContainText(
    "Unavailable — manual demo mode",
  );

  await seedUnrelatedBrowserState(page);
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expectEffects(page, {
    employees: 0,
    workspaces: 0,
    figma: 0,
    laptops: 0,
    emails: 0,
    orientation: "—",
  });
  await expectUnrelatedBrowserStatePreserved(page);

  await page.getByRole("button", { name: "Run failure scenario" }).click();
  await expect(step(page, "book_orientation")).toHaveAttribute("data-status", "failed");

  for (const completed of [
    "create_employee",
    "create_workspace",
    "assign_figma",
    "order_laptop",
  ]) {
    await expect(step(page, completed)).toHaveAttribute("data-status", "done");
    await expect(step(page, completed)).toHaveAttribute(
      "data-visual-status",
      "preserved",
    );
  }
  await expect(step(page, "book_orientation")).toHaveAttribute(
    "data-visual-status",
    "failed",
  );
  await expect(step(page, "send_welcome_email")).toHaveAttribute(
    "data-visual-status",
    "blocked",
  );
  await expect(page.getByRole("heading", { name: "4 completed actions are still valid." })).toBeVisible();
  await expect(page.getByText("Monday orientation is fully booked.")).toBeVisible();
  await expect(step(page, "book_orientation")).toContainText("ORIENTATION_FULL");
  await expect(step(page, "send_welcome_email")).toHaveAttribute(
    "data-status",
    "not_started",
  );
  await expectEffects(page, {
    employees: 1,
    workspaces: 1,
    figma: 1,
    laptops: 1,
    emails: 0,
    orientation: "—",
  });

  await page.reload();
  await expectReady(page);
  await expect(page.getByTestId("demo-root")).toHaveAttribute(
    "data-workflow-status",
    "paused",
  );
  await expect(step(page, "book_orientation")).toHaveAttribute("data-status", "failed");
  await expect(step(page, "book_orientation")).toContainText("ORIENTATION_FULL");
  await expectEffects(page, {
    employees: 1,
    workspaces: 1,
    figma: 1,
    laptops: 1,
    emails: 0,
    orientation: "—",
  });

  // Reset at the paused failure boundary, then prove demo-owned records clear
  // without touching unrelated localStorage, IndexedDB, or journal workflows.
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByTestId("demo-root")).toHaveAttribute(
    "data-workflow-status",
    "idle",
  );
  await expectEffects(page, {
    employees: 0,
    workspaces: 0,
    figma: 0,
    laptops: 0,
    emails: 0,
    orientation: "—",
  });
  await expectUnrelatedBrowserStatePreserved(page);
  await page.getByRole("button", { name: "Run failure scenario" }).click();
  await expect(step(page, "book_orientation")).toHaveAttribute("data-status", "failed");

  await page.getByRole("button", { name: "Propose Tuesday recovery" }).click();
  await expect(page.getByText("Human decision required")).toBeVisible();
  await page.reload();
  await expectReady(page);
  await expect(page.getByText("Human decision required")).toBeVisible();
  await expectEffects(page, {
    employees: 1,
    workspaces: 1,
    figma: 1,
    laptops: 1,
    emails: 0,
    orientation: "—",
  });
  await page.getByRole("button", { name: "Approve recovery" }).click();
  await expect(
    page.getByText("Recovery approved. Waiting for the agent to resume the workflow."),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume safely" })).toBeVisible();

  // The recovery choice and approval reference use the same persisted state
  // model as the UI. Reload once more before resuming to prove that boundary.
  await page.reload();
  await expectReady(page);
  await expect(page.getByRole("button", { name: "Resume safely" })).toBeVisible();
  await expectEffects(page, {
    employees: 1,
    workspaces: 1,
    figma: 1,
    laptops: 1,
    emails: 0,
    orientation: "—",
  });
  await page.getByRole("button", { name: "Resume safely" }).click();

  await expect(page.getByTestId("demo-root")).toHaveAttribute(
    "data-workflow-status",
    "complete",
  );
  for (const completed of [
    "create_employee",
    "create_workspace",
    "assign_figma",
    "order_laptop",
    "book_orientation",
    "send_welcome_email",
  ]) {
    await expect(step(page, completed)).toHaveAttribute("data-status", "done");
  }
  await expect(page.getByRole("heading", { name: "Recovered" })).toBeVisible();
  await expect(page.getByText("4 valid actions preserved", { exact: true })).toBeVisible();
  const recoveredPanel = page.getByRole("region", { name: "Recovered" });
  await expect(recoveredPanel.getByText("0", { exact: true })).toBeVisible();
  await expect(
    recoveredPanel.getByText("completed actions repeated", { exact: true }),
  ).toBeVisible();
  await expectEffects(page, {
    employees: 1,
    workspaces: 1,
    figma: 1,
    laptops: 1,
    emails: 1,
    orientation: "Tuesday",
  });

  await page.reload();
  await expectReady(page);
  await expect(page.getByTestId("demo-root")).toHaveAttribute(
    "data-workflow-status",
    "complete",
  );
  await expectEffects(page, {
    employees: 1,
    workspaces: 1,
    figma: 1,
    laptops: 1,
    emails: 1,
    orientation: "Tuesday",
  });
});
