import { useCallback, useEffect, useRef, useState } from "react";

/** Safety net if an `animationend`/`transitionend` event never arrives (e.g. `display: none`
 * ancestor, or an animation-less environment) so the element can't get stuck mounted forever. */
const FALLBACK_TIMEOUT_MS = 1000;

/**
 * Keeps a conditionally-rendered element mounted for one exit transition after `isOpen` goes
 * false, instead of unmounting the instant its entry condition flips. Consumers render only
 * while `shouldRender` is true, and apply an exit class/transition while `isClosing` is true.
 *
 * Uses `transitionend` rather than `animationend`: jsdom (and therefore this app's test suite)
 * does not implement `AnimationEvent`, so a CSS `animation`-driven exit can never be observed
 * from tests. A plain `Event` typed `transitionend` dispatches and bubbles correctly, so exit
 * effects are built with CSS `transition`, not `@keyframes`. `onTransitionEnd` on the animated
 * element must call the returned handler so the delayed unmount actually resolves.
 */
export function useExitAnimation(isOpen: boolean) {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const wasOpen = useRef(isOpen);

  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      setShouldRender(true);
      setIsClosing(false);
      return;
    }

    if (!wasOpen.current) {
      return;
    }
    wasOpen.current = false;

    setIsClosing(true);
    const fallback = setTimeout(() => {
      setIsClosing(false);
      setShouldRender(false);
    }, FALLBACK_TIMEOUT_MS);

    return () => clearTimeout(fallback);
  }, [isOpen]);

  const handleExitTransitionEnd = useCallback(() => {
    setIsClosing(false);
    setShouldRender(false);
  }, []);

  return { shouldRender, isClosing, handleExitTransitionEnd };
}
