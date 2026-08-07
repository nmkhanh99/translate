import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withAbortTimeout } from "./status-request";

describe("status request timeout", () => {
  it("aborts a request that never settles on its own", async () => {
    let signal: AbortSignal | null = null;
    const request = withAbortTimeout(
      (nextSignal) => {
        signal = nextSignal;
        return new Promise<never>((_resolve, reject) => {
          nextSignal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      15
    );

    await assert.rejects(request, /aborted/);
    assert.equal(signal?.aborted, true);
  });

  it("clears the timer after a fast response", async () => {
    let signal: AbortSignal | null = null;
    const value = await withAbortTimeout(async (nextSignal) => {
      signal = nextSignal;
      return "ok";
    }, 15);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(value, "ok");
    assert.equal(signal?.aborted, false);
  });
});
