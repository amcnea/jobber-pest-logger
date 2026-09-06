import type { FirstRunStep } from "../storage";
import type { Screen } from "../types";

interface Props {
  steps: FirstRunStep[];
  onGo: (screen: Screen) => void;
}

/** Soft setup banner — never blocks logging. Hidden when every step is done. */
export function FirstRunChecklist({ steps, onGo }: Props) {
  const remaining = steps.filter((s) => !s.done).length;
  if (remaining === 0) return null;

  return (
    <div className="banner banner-checklist" role="status">
      <strong>First-run checklist</strong>
      <span className="checklist-sub">
        Soft setup only — you can still log applications anytime ({remaining} step
        {remaining === 1 ? "" : "s"} left).
      </span>
      <ul className="checklist">
        {steps.map((step) => (
          <li key={step.id} className={step.done ? "done" : "todo"}>
            <span className="check-mark" aria-hidden="true">
              {step.done ? "✓" : "○"}
            </span>
            {step.done ? (
              <span>{step.label}</span>
            ) : (
              <button type="button" className="linkish" onClick={() => onGo(step.screen)}>
                {step.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
