import { useState, useEffect } from "preact/hooks";

interface Props {
  active: boolean;
  step: number;
  cost: number;
  startTime: number;
}

export function AgentStatusBar({ active, step, cost, startTime }: Props) {
  const [elapsed, setElapsed] = useState("0:00");

  useEffect(() => {
    if (!active || !startTime) { setElapsed("0:00"); return; }
    const tick = () => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      setElapsed(`${m}:${s < 10 ? "0" : ""}${s}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => { clearInterval(interval); };
  }, [active, startTime]);

  return (
    <div class={`agent-status ${active ? "active" : ""}`}>
      <span class="status-dot" />
      <span class="status-item">
        <span class="label">Step</span>{" "}
        <span class="status-value">{step}</span>
      </span>
      <span class="status-item">
        <span class="label">Cost</span>{" "}
        <span class="status-value">{cost.toFixed(2)} cr</span>
      </span>
      <span class="status-item">
        <span class="label">Time</span>{" "}
        <span class="status-value">{elapsed}</span>
      </span>
    </div>
  );
}
