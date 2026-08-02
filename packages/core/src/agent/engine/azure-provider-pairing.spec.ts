import { createAzure } from "@ai-sdk/azure";
import { describe, expect, it } from "vitest";

// Pins the three @ai-sdk/azure behaviours the framework's Azure provider work
// depends on. The v3 line is what pairs with `ai@6` and `@ai-sdk/openai@3`;
// v4 changed neither of these defaults, but a future major could, and each of
// these silently produces a URL Azure rejects rather than a type error.

const RESOURCE_NAME = "example-resource";
const API_KEY = "test-key-not-a-credential";

function providerWithCapturedRequest(
  options: Parameters<typeof createAzure>[0] = {},
) {
  const requests: string[] = [];
  const azure = createAzure({
    apiKey: API_KEY,
    resourceName: RESOURCE_NAME,
    ...options,
    fetch: async (input) => {
      requests.push(typeof input === "string" ? input : String(input));
      return new Response(JSON.stringify({ error: "captured" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { azure, requests };
}

async function callModel(model: {
  doGenerate: (options: never) => Promise<unknown>;
}) {
  await model
    .doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never)
    .catch(() => undefined);
}

describe("@ai-sdk/azure v3 pairing", () => {
  it("returns a Responses model from the default constructor", () => {
    const { azure } = providerWithCapturedRequest();

    expect(azure("gpt-5.5").provider).toBe("azure.responses");
    expect(azure.chat("gpt-5.5").provider).toBe("azure.chat");
  });

  it("requests the versioned endpoint path, not a deployment-based URL", async () => {
    const { azure, requests } = providerWithCapturedRequest();

    await callModel(azure("gpt-5.5") as never);

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect(url.origin).toBe(`https://${RESOURCE_NAME}.openai.azure.com`);
    expect(url.pathname).toBe("/openai/v1/responses");
    expect(url.pathname).not.toContain("/deployments/");
  });

  it("defaults api-version to the value the versioned endpoint expects", async () => {
    const { azure, requests } = providerWithCapturedRequest();

    await callModel(azure("gpt-5.5") as never);

    expect(new URL(requests[0]!).searchParams.get("api-version")).toBe("v1");
  });

  it("uses deployment-based URLs only when explicitly opted in", async () => {
    const { azure, requests } = providerWithCapturedRequest({
      useDeploymentBasedUrls: true,
    });

    await callModel(azure("gpt-5.5") as never);

    expect(new URL(requests[0]!).pathname).toBe(
      "/openai/deployments/gpt-5.5/responses",
    );
  });
});
