import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent(
  { className, sideOffset = 6, ...props },
  ref,
) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn("pp-tooltip-content", className)}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

export type HintProps = {
  /** The trigger element. Must be a single React element (asChild). */
  children: ReactNode;
  /** The tooltip body — string or rich content. */
  content: ReactNode;
  /** data-testid forwarded onto the rendered tooltip content for tests. */
  "data-testid"?: string;
  /** Override the side the tooltip pops out on. */
  side?: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
  /** Override side offset (px). */
  sideOffset?: number;
};

/**
 * Convenience wrapper: <Hint content="…"><button>…</button></Hint>.
 *
 * Relies on the app-level <TooltipProvider> mounted in App.tsx. For
 * isolated component tests that don't render through App, wrap the
 * test render in <TooltipProvider>.
 */
export function Hint({
  children,
  content,
  side,
  sideOffset,
  "data-testid": testId,
}: HintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={sideOffset}
        data-testid={testId}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export type HintIconProps = {
  /** Tooltip body. */
  content: ReactNode;
  /** Accessible label for the trigger button. */
  label: string;
  /** data-testid forwarded onto the trigger. */
  "data-testid"?: string;
  /** data-testid for the tooltip content (defaults to `${testId}-content`). */
  contentTestId?: string;
  /** Override side. */
  side?: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
};

/**
 * A small "ⓘ" trigger button rendered next to a label or KPI. Click is a
 * no-op — the tooltip surfaces via hover/focus only, which is what the
 * underlying Radix primitive provides for free.
 */
export function HintIcon({
  content,
  label,
  side,
  "data-testid": testId,
  contentTestId,
}: HintIconProps) {
  return (
    <Hint
      content={content}
      side={side}
      data-testid={contentTestId ?? (testId ? `${testId}-content` : undefined)}
    >
      <button
        type="button"
        aria-label={label}
        className="pp-hint-icon"
        data-testid={testId}
        onClick={(e) => {
          // The icon often sits inside a <label> — stop the click from
          // toggling the labelled input (e.g. checkbox / select) and from
          // double-firing the tooltip via its own logic.
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        ⓘ
      </button>
    </Hint>
  );
}
