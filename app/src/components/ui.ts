import { useRef, useState } from "react";

// Shared spring - the soft, slightly bouncy motion of a calm home menu.
export const spring = { type: "spring", stiffness: 320, damping: 30 } as const;

// Arm-then-confirm for destructive row/chip actions: the first click on the x
// arms an id (auto-disarming after 4s); a second click within the window
// confirms. Shared by the project rows, the goal chips, and the loop rows so all
// three behave identically.
export function useArmedDelete() {
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
  };
  const arm = (id: string) => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(id);
    armTimer.current = setTimeout(() => setArmed(null), 4000);
  };
  return { armed, arm, disarm };
}
