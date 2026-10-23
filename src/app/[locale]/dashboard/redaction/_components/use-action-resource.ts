"use client";

import { useEffect, useState } from "react";
import type { ActionResult } from "@/lib/api-client/v1/actions/types";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "error"; errorCode?: string }
  | { status: "ready"; data: T; reloading: boolean };

/**
 * Runs `load` whenever its identity changes (wrap it in `useCallback`). Responses that arrive
 * after a newer load started are ignored; loaded data stays visible while reloading.
 */
export function useActionResource<T>(load: () => Promise<ActionResult<T>>): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState((previous) =>
      previous.status === "ready" ? { ...previous, reloading: true } : { status: "loading" }
    );
    load().then(
      (result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "ready", data: result.data as T, reloading: false }
            : { status: "error", errorCode: result.errorCode }
        );
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  return state;
}
