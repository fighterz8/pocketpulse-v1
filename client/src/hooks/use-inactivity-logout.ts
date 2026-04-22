import { useEffect, useRef } from "react";

const INACTIVITY_MS = 30 * 60 * 1000;

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
] as const;

/**
 * Fires `onTimeout` after 30 minutes of no user activity.
 * Any mouse move, click, keypress, touch, or scroll resets the timer.
 * Pass `enabled: false` (e.g. when the user is not authenticated) to skip
 * attaching listeners entirely.
 */
export function useInactivityLogout({
  enabled,
  onTimeout,
}: {
  enabled: boolean;
  onTimeout: () => void;
}) {
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!enabled) return;

    let timerId: ReturnType<typeof setTimeout>;

    function reset() {
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        onTimeoutRef.current();
      }, INACTIVITY_MS);
    }

    reset();

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }

    return () => {
      clearTimeout(timerId);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, reset);
      }
    };
  }, [enabled]);
}
