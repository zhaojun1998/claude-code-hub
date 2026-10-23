/**
 * Shared helpers for the redaction UI tests (settings page and usage-log components).
 *
 * Not a test file itself: the *.test.tsx files import the render helpers directly and
 * load the primitive stubs through async `vi.mock` factories, e.g.
 * `vi.mock("@/components/ui/select", async () => (await import("./ui-helpers")).selectStub)`.
 */

import fs from "node:fs";
import path from "node:path";
import { NextIntlClientProvider } from "next-intl";
import {
  act,
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BuiltinRuleView } from "@/lib/redaction/api-types";
import {
  normalizeRedactionSettings,
  type PublicRedactionSettings,
  toPublicSettings,
} from "@/lib/redaction/config";
import type { StoredRedactionRule } from "@/lib/redaction/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const redactionMessages = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "messages/en/settings/redaction.json"), "utf8")
);

/** Every next-intl error (missing key, bad ICU argument) raised while rendering. */
export const intlErrors: string[] = [];

export interface Rendered {
  container: HTMLDivElement;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
}

const mounted: Rendered[] = [];

function wrap(node: ReactNode) {
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ settings: { redaction: redactionMessages } }}
      onError={(error) => {
        intlErrors.push(`${error.code}: ${error.message}`);
      }}
    >
      {node}
    </NextIntlClientProvider>
  );
}

export async function render(node: ReactNode): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(wrap(node));
  });
  let alive = true;
  const rendered: Rendered = {
    container,
    rerender: async (next) => {
      await act(async () => {
        root.render(wrap(next));
      });
    },
    unmount: async () => {
      if (!alive) return;
      alive = false;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  mounted.push(rendered);
  return rendered;
}

/** Unmounts everything rendered by the current test and returns the collected intl errors. */
export async function cleanup(): Promise<string[]> {
  for (const rendered of mounted.splice(0)) await rendered.unmount();
  return intlErrors.splice(0);
}

/** Lets pending promises and zero-delay timers settle inside act. */
export async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("click: element not found");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Radix Tabs activate on mousedown with the primary button. */
export async function mouseDown(element: Element | null | undefined) {
  if (!element) throw new Error("mouseDown: element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
}

/** Sets a React-controlled input, textarea or select through the native setter. */
export async function changeValue(element: Element | null | undefined, value: string) {
  if (!element) throw new Error("changeValue: element not found");
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })
    );
  });
}

function normalize(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** All buttons whose visible text or aria-label equals `name`. */
export function queryButtons(scope: ParentNode, name: string): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button")).filter(
    (button) => normalize(button.textContent) === name || button.getAttribute("aria-label") === name
  );
}

export function getButton(scope: ParentNode, name: string): HTMLButtonElement {
  const [button] = queryButtons(scope, name);
  if (!button) throw new Error(`getButton: no button named "${name}"`);
  return button;
}

/** The native select (from `selectStub`) that offers the given option value. */
export function getSelectWithOption(scope: ParentNode, optionValue: string): HTMLSelectElement {
  const option = scope.querySelector(`option[value="${optionValue}"]`);
  const select = option?.closest("select");
  if (!select) throw new Error(`getSelectWithOption: no select offers "${optionValue}"`);
  return select;
}

export function textOf(element: Element | null | undefined) {
  return normalize(element?.textContent);
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function okResult<T>(data: T) {
  return { ok: true as const, data };
}

export function errorResult(errorCode?: string) {
  return { ok: false as const, error: "request failed", errorCode };
}

/** Realistic browser-side settings built with the same normalizer the server uses. */
export function makeSettings(raw: Record<string, unknown> = {}): PublicRedactionSettings {
  return toPublicSettings(normalizeRedactionSettings(raw));
}

export function makeStoredRule(overrides: Partial<StoredRedactionRule> = {}): StoredRedactionRule {
  return {
    id: 1,
    name: "Internal token",
    category: "secret",
    label: "INTERNAL_TOKEN",
    kind: "regex",
    pattern: "acme_[A-Za-z0-9]{32}",
    flags: null,
    groupIndex: null,
    source: "custom",
    status: "active",
    confidence: null,
    description: null,
    hitCount: 0,
    lastHitAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeBuiltinView(overrides: Partial<BuiltinRuleView> = {}): BuiltinRuleView {
  return {
    id: "builtin:openai_api_key",
    name: "OpenAI API key",
    category: "secret",
    label: "OPENAI_KEY",
    description: null,
    example: null,
    enabled: true,
    defaultEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Primitive stubs (Radix portals and pointer handling are noise for these tests)
// ---------------------------------------------------------------------------

/** Native <select> standing in for the Radix Select; SelectItem becomes an <option>. */
export const selectStub = {
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (next: string) => void;
    children?: ReactNode;
  }) => (
    <select value={value ?? ""} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
};

function Passthrough({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

/** Dialog that only renders its content while `open` is true. */
export const dialogStub = {
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: Passthrough,
  DialogHeader: Passthrough,
  DialogFooter: Passthrough,
  DialogDescription: Passthrough,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
};

const PopoverContext = createContext<{ open: boolean; toggle: () => void }>({
  open: false,
  toggle: () => {},
});

/** Popover whose content is mounted only after the trigger was clicked. */
export const popoverStub = {
  Popover: ({ children }: { children?: ReactNode }) => {
    const [open, setOpen] = useState(false);
    return (
      <PopoverContext.Provider value={{ open, toggle: () => setOpen((current) => !current) }}>
        {children}
      </PopoverContext.Provider>
    );
  },
  PopoverTrigger: ({ children }: { children?: ReactNode }) => {
    const { open, toggle } = useContext(PopoverContext);
    const child = Children.only(children);
    if (!isValidElement(child)) return null;
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      onClick: toggle,
      "data-state": open ? "open" : "closed",
    });
  },
  PopoverContent: ({ children }: { children?: ReactNode }) => {
    const { open } = useContext(PopoverContext);
    return open ? <div data-testid="popover-content">{children}</div> : null;
  },
};
