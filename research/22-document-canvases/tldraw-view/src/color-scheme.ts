// tldraw's light or dark, as the stock tldraw tool takes it (patchwork-base's tldraw5/src/color-scheme.ts):
// from the `color-scheme` that the closest Patchwork theme declares where the view is, else from the
// browser, following both.
import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function resolveColorScheme(element: HTMLElement): ColorScheme {
  const scheme = getComputedStyle(element).colorScheme;
  const dark = /\bdark\b/.test(scheme);
  const light = /\blight\b/.test(scheme);
  if (dark !== light) return dark ? "dark" : "light";
  return prefersDark() ? "dark" : "light";
}

export function useColorScheme(element: HTMLElement): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() => resolveColorScheme(element));
  useEffect(() => {
    const update = () => setScheme(resolveColorScheme(element));
    update();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    // A theme is an attribute on the root and a stylesheet in the head; neither fires an event.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.head, { childList: true, subtree: true });
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, [element]);
  return scheme;
}
