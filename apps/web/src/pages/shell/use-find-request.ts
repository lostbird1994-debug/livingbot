import { useEffect, useRef, useState } from "react";

/**
 * `request` is a shared counter other surfaces bump to ask for the find dialog. Only a change that
 * arrives while this component stays mounted counts as an ask: a fresh mount inherits the latest
 * value, which is already-handled history, so switching tabs must not reopen the dialog.
 */
export function useFindRequest(request: number) {
  const [open, setOpen] = useState(false);
  const handled = useRef(request);
  useEffect(() => {
    if (request === handled.current) return;
    handled.current = request;
    setOpen(true);
  }, [request]);
  return [open, setOpen] as const;
}
