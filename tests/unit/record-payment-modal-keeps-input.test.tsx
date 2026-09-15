// @vitest-environment jsdom
//
// A half-typed payment must survive the parent re-rendering underneath it.
//
// `RecordPaymentModal`'s reset effect was keyed on the `member` OBJECT, and
// every caller builds that prop inline:
//
//     member={recordFor ? { id: recordFor.memberId, name: recordFor.memberName } : null}
//
// so it is a brand-new object on every render of the parent, and the effect
// re-ran on every parent render — wiping the amount, the method and the notes.
//
// The trigger in the real product was `ToastProvider`, which passed
// `value={{ toast }}`: also a fresh object each render, so ANY toast appearing
// or auto-dismissing anywhere in the dashboard re-rendered every `useToast()`
// consumer, this modal's parent included. A staff member typing £45 at the desk
// watched it go blank, on the money path, with nothing on screen to explain it.
//
// Found by an e2e test: the failure screenshot showed the fields it had just
// filled sitting empty. Worth saying why no unit test caught it first — the
// existing ones render the modal alone, and the defect only exists when
// something ELSE re-renders above it. So that is exactly what this file does.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import RecordPaymentModal from "@/components/dashboard/RecordPaymentModal";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

/**
 * A parent shaped like the real ones: it holds the member as a row in state and
 * rebuilds the prop object inline, and it has a counter standing in for the
 * unrelated state change a toast causes.
 */
function Harness({ memberName = "Sam Tester" }: { memberName?: string }) {
  const [tick, setTick] = useState(0);
  const row = { memberId: "mem_1", memberName };
  return (
    <div>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        force parent re-render
      </button>
      <span data-testid="tick">{tick}</span>
      <RecordPaymentModal
        open
        onClose={() => {}}
        // Deliberately inline — the shape every real caller uses, and the shape
        // the bug needed. Hoisting it here would hide the defect.
        member={{ id: row.memberId, name: row.memberName }}
        suggestedAmountPence={null}
        onRecorded={() => {}}
      />
    </div>
  );
}

function fields() {
  return {
    amount: screen.getByLabelText("Amount (£)") as HTMLInputElement,
    method: screen.getByLabelText("Method") as HTMLSelectElement,
    notes: screen.getByLabelText(/Notes/) as HTMLInputElement,
    submit: screen.getByRole("button", { name: "Record payment" }) as HTMLButtonElement,
  };
}

describe("RecordPaymentModal keeps what the user typed", () => {
  it("survives an unrelated parent re-render", () => {
    render(<Harness />);
    const f = fields();

    fireEvent.change(f.amount, { target: { value: "45.00" } });
    fireEvent.change(f.notes, { target: { value: "Cleared at the desk" } });
    expect(f.amount.value).toBe("45.00");

    // The toast. Or the poll. Or anything at all above this dialog.
    act(() => {
      screen.getByText("force parent re-render").click();
    });

    expect(
      fields().amount.value,
      "a parent re-render wiped the amount — this is the data loss, on the money path",
    ).toBe("45.00");
    expect(fields().notes.value).toBe("Cleared at the desk");
  });

  it("keeps the submit button usable after that re-render", () => {
    // The user-visible symptom in the e2e run was not "the text vanished" but
    // "the button will not enable", because the wiped amount failed validation.
    render(<Harness />);
    fireEvent.change(fields().amount, { target: { value: "45.00" } });
    expect(fields().submit.disabled).toBe(false);

    act(() => {
      screen.getByText("force parent re-render").click();
    });

    expect(
      fields().submit.disabled,
      "the form reset left the submit permanently disabled with the dialog still open",
    ).toBe(false);
  });

  it("survives several re-renders, not just the first", () => {
    render(<Harness />);
    fireEvent.change(fields().amount, { target: { value: "12.50" } });
    for (let i = 0; i < 5; i++) {
      act(() => {
        screen.getByText("force parent re-render").click();
      });
    }
    expect(fields().amount.value).toBe("12.50");
    expect(screen.getByTestId("tick").textContent).toBe("5");
  });

  it("still resets when a genuinely different member is opened", () => {
    // The reset must not be thrown away wholesale — opening the modal on member
    // B must never show member A's half-typed amount. This is the assertion that
    // stops "fix the wipe" turning into "never reset at all".
    const { rerender } = render(
      <RecordPaymentModal
        open
        onClose={() => {}}
        member={{ id: "mem_1", name: "Sam Tester" }}
        suggestedAmountPence={null}
        onRecorded={() => {}}
      />,
    );
    fireEvent.change(fields().amount, { target: { value: "45.00" } });

    rerender(
      <RecordPaymentModal
        open
        onClose={() => {}}
        member={{ id: "mem_2", name: "Alex Other" }}
        suggestedAmountPence={null}
        onRecorded={() => {}}
      />,
    );

    expect(
      fields().amount.value,
      "a different member must start from a clean form, not inherit the last one's amount",
    ).toBe("");
    expect(screen.getByText("Alex Other")).toBeTruthy();
  });

  it("applies the suggested amount when it changes", () => {
    // The outstanding list passes the amount owed. A reset keyed only on `open`
    // would ignore it.
    const { rerender } = render(
      <RecordPaymentModal
        open
        onClose={() => {}}
        member={{ id: "mem_1", name: "Sam Tester" }}
        suggestedAmountPence={null}
        onRecorded={() => {}}
      />,
    );
    expect(fields().amount.value).toBe("");

    rerender(
      <RecordPaymentModal
        open
        onClose={() => {}}
        member={{ id: "mem_1", name: "Sam Tester" }}
        suggestedAmountPence={4500}
        onRecorded={() => {}}
      />,
    );
    expect(fields().amount.value).toBe("45.00");
  });
});
