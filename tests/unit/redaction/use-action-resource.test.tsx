/**
 * @vitest-environment happy-dom
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type ResourceState,
  useActionResource,
} from "@/app/[locale]/dashboard/redaction/_components/use-action-resource";
import type { ActionResult } from "@/lib/api-client/v1/actions/types";
import { cleanup, deferred, errorResult, flush, okResult, render } from "./ui-helpers";

type Loader = () => Promise<ActionResult<string[]>>;

function Probe({ load }: { load: Loader }) {
  const state = useActionResource(load);
  return <output>{JSON.stringify(state)}</output>;
}

function stateOf(container: HTMLElement): ResourceState<string[]> {
  return JSON.parse(container.querySelector("output")?.textContent ?? "null");
}

function pendingLoader() {
  const pending = deferred<ActionResult<string[]>>();
  const load = vi.fn<Loader>(() => pending.promise);
  return { pending, load };
}

afterEach(async () => {
  expect(await cleanup()).toEqual([]);
});

describe("useActionResource", () => {
  test("starts loading and becomes ready with the loaded data", async () => {
    const { pending, load } = pendingLoader();
    const { container } = await render(<Probe load={load} />);

    expect(stateOf(container)).toEqual({ status: "loading" });
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve(okResult(["a", "b"]));
    await flush();

    expect(stateOf(container)).toEqual({ status: "ready", data: ["a", "b"], reloading: false });
  });

  test("reports the error code of a failed result", async () => {
    const load = vi.fn<Loader>().mockResolvedValue(errorResult("RECORDS_UNAVAILABLE"));
    const { container } = await render(<Probe load={load} />);
    await flush();

    expect(stateOf(container)).toEqual({ status: "error", errorCode: "RECORDS_UNAVAILABLE" });
  });

  test("reports an error without a code when the request rejects", async () => {
    const load = vi.fn<Loader>().mockRejectedValue(new Error("offline"));
    const { container } = await render(<Probe load={load} />);
    await flush();

    expect(stateOf(container)).toEqual({ status: "error" });
  });

  test("does not reload while the loader identity stays the same", async () => {
    const load = vi.fn<Loader>().mockResolvedValue(okResult(["a"]));
    const { container, rerender } = await render(<Probe load={load} />);
    await flush();
    await rerender(<Probe load={load} />);
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(stateOf(container)).toEqual({ status: "ready", data: ["a"], reloading: false });
  });

  test("keeps the loaded data visible while a new load runs", async () => {
    const first = vi.fn<Loader>().mockResolvedValue(okResult(["old"]));
    const { container, rerender } = await render(<Probe load={first} />);
    await flush();

    const { pending, load: second } = pendingLoader();
    await rerender(<Probe load={second} />);

    expect(second).toHaveBeenCalledTimes(1);
    expect(stateOf(container)).toEqual({ status: "ready", data: ["old"], reloading: true });

    pending.resolve(okResult(["new"]));
    await flush();

    expect(stateOf(container)).toEqual({ status: "ready", data: ["new"], reloading: false });
  });

  test("shows loading again when reloading after an error", async () => {
    const first = vi.fn<Loader>().mockResolvedValue(errorResult());
    const { container, rerender } = await render(<Probe load={first} />);
    await flush();
    expect(stateOf(container)).toEqual({ status: "error" });

    const { load: second } = pendingLoader();
    await rerender(<Probe load={second} />);

    expect(stateOf(container)).toEqual({ status: "loading" });
  });

  test("ignores responses of a load that was superseded", async () => {
    const { pending: stale, load: first } = pendingLoader();
    const { pending: current, load: second } = pendingLoader();
    const { container, rerender } = await render(<Probe load={first} />);
    await rerender(<Probe load={second} />);

    current.resolve(okResult(["current"]));
    await flush();
    stale.resolve(okResult(["stale"]));
    await flush();

    expect(stateOf(container)).toEqual({ status: "ready", data: ["current"], reloading: false });
  });

  test("ignores a superseded load that fails late", async () => {
    const { pending: stale, load: first } = pendingLoader();
    const { pending: current, load: second } = pendingLoader();
    const { container, rerender } = await render(<Probe load={first} />);
    await rerender(<Probe load={second} />);

    current.resolve(okResult(["current"]));
    await flush();
    stale.reject(new Error("aborted"));
    await flush();

    expect(stateOf(container)).toEqual({ status: "ready", data: ["current"], reloading: false });
  });

  test("ignores a superseded load that returns an error result", async () => {
    const { pending: stale, load: first } = pendingLoader();
    const { pending: current, load: second } = pendingLoader();
    const { container, rerender } = await render(<Probe load={first} />);
    await rerender(<Probe load={second} />);

    stale.resolve(errorResult("STALE"));
    await flush();
    expect(stateOf(container)).toEqual({ status: "loading" });

    current.resolve(okResult(["current"]));
    await flush();
    expect(stateOf(container)).toEqual({ status: "ready", data: ["current"], reloading: false });
  });

  test("does not update after unmount", async () => {
    const { pending, load } = pendingLoader();
    const errors = vi.spyOn(console, "error");
    const { unmount } = await render(<Probe load={load} />);

    await unmount();
    pending.resolve(okResult(["late"]));
    await flush();

    expect(errors).not.toHaveBeenCalled();
  });
});
