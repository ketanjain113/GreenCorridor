import { useEffect, useMemo, useState } from "react";

export default function LiveEtaCountdown({ etaSeconds }) {
  const normalizedEta = useMemo(() => {
    if (typeof etaSeconds !== "number" || !Number.isFinite(etaSeconds) || etaSeconds < 0) {
      return null;
    }
    return Math.floor(etaSeconds);
  }, [etaSeconds]);

  const [remainingSeconds, setRemainingSeconds] = useState(normalizedEta);

  useEffect(() => {
    if (normalizedEta === null) {
      setRemainingSeconds(null);
      return undefined;
    }

    const targetTime = Date.now() + normalizedEta * 1000;
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
      setRemainingSeconds(seconds);
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 200);

    return () => window.clearInterval(timer);
  }, [normalizedEta]);

  const isCritical = typeof remainingSeconds === "number" && remainingSeconds < 10;
  const displayValue = typeof remainingSeconds === "number" ? remainingSeconds : "--";

  return (
    <div className={`live-eta-pill${isCritical ? " is-critical" : ""}`} aria-live="polite">
      ETA: {displayValue} seconds
    </div>
  );
}
