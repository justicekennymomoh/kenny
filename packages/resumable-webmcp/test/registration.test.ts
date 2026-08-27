import { describe, expect, it } from "vitest";
import {
  registerWebMcpTools,
  type ModelContextLike,
  type WebMcpTool,
} from "../src/index";

function tool(name: string): WebMcpTool {
  return {
    name,
    description: `Test ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ ok: true }),
  };
}

class MockModelContext implements ModelContextLike {
  readonly tools = new Map<string, WebMcpTool>();
  deferred?: Promise<void>;

  async registerTool(
    candidate: WebMcpTool,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    if (this.tools.has(candidate.name)) {
      throw new DOMException(`Duplicate tool: ${candidate.name}`, "InvalidStateError");
    }
    options?.signal?.throwIfAborted();
    this.tools.set(candidate.name, candidate);
    const unregister = () => {
      if (this.tools.get(candidate.name) === candidate) this.tools.delete(candidate.name);
    };
    options?.signal?.addEventListener("abort", unregister, { once: true });
    if (this.deferred) await this.deferred;
  }
}

describe("registerWebMcpTools", () => {
  it("cleans up a mount so the same stable names can register on remount", async () => {
    const context = new MockModelContext();
    const definitions = [tool("one"), tool("two")];

    const first = await registerWebMcpTools(context, definitions);
    expect([...context.tools]).toHaveLength(2);
    first.dispose();
    expect([...context.tools]).toHaveLength(0);

    const second = await registerWebMcpTools(context, definitions);
    expect(second.registered).toEqual(["one", "two"]);
    second.dispose();
  });

  it("honors owner abort while asynchronous registration is still pending", async () => {
    const context = new MockModelContext();
    let release!: () => void;
    context.deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = new AbortController();

    const firstMount = registerWebMcpTools(context, [tool("one")], {
      signal: owner.signal,
    });
    await Promise.resolve();
    expect(context.tools.has("one")).toBe(true);
    owner.abort();
    release();
    await expect(firstMount).rejects.toMatchObject({ name: "AbortError" });
    expect(context.tools.has("one")).toBe(false);

    context.deferred = undefined;
    const remount = await registerWebMcpTools(context, [tool("one")]);
    expect(remount.registered).toEqual(["one"]);
    remount.dispose();
  });

  it("rolls back earlier registrations when a later registration fails", async () => {
    const context = new MockModelContext();
    const existing = tool("existing");
    context.tools.set(existing.name, existing);

    await expect(
      registerWebMcpTools(context, [tool("new"), tool("existing")]),
    ).rejects.toMatchObject({ name: "InvalidStateError" });

    expect([...context.tools.keys()]).toEqual(["existing"]);
  });

  it("rejects duplicate names before touching browser registration", async () => {
    const context = new MockModelContext();
    await expect(
      registerWebMcpTools(context, [tool("same"), tool("same")]),
    ).rejects.toThrow("WebMCP tool names must be unique");
    expect(context.tools.size).toBe(0);
  });

  it("does not leak registrations or handlers across repeated remounts", async () => {
    const context = new MockModelContext();
    const definitions = ["one", "two", "three", "four", "five", "six"].map(tool);

    for (let mount = 0; mount < 25; mount++) {
      const registration = await registerWebMcpTools(context, definitions);
      expect(registration.registered).toEqual(definitions.map((item) => item.name));
      expect(context.tools.size).toBe(6);
      expect(new Set(context.tools.keys()).size).toBe(6);
      registration.dispose();
      expect(context.tools.size).toBe(0);
    }
  });
});
