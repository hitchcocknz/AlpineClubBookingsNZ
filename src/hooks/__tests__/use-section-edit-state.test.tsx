// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import { expectToHoldFocus } from "@/lib/__tests__/helpers/focus";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "../use-section-edit-state";

interface Draft {
  minGroupSize: number;
  enabled: boolean;
}

const INITIAL: Draft = { minGroupSize: 5, enabled: false };

function renderSection(
  overrides: Partial<Parameters<typeof useSectionEditState<Draft>>[0]> = {},
) {
  const save = vi.fn(async (draft: Draft) => draft);
  const view = renderHook(() =>
    useSectionEditState<Draft>({
      initial: INITIAL,
      save,
      successMessage: "Saved",
      ...overrides,
    }),
  );
  return { ...view, save };
}

afterEach(() => {
  cleanup();
});

/** Operate a control the way a keyboard user does: it holds focus first. */
function activate(control: HTMLElement) {
  control.focus();
  fireEvent.click(control);
}

interface StagedSectionProps {
  title: string;
  save?: (draft: Draft) => Promise<Draft>;
  /** The Edit control is rendered while read-only (a view-only card may hide it). */
  showEdit?: boolean;
  /** The Edit control is rendered disabled (a view-only admin). */
  editDisabled?: boolean;
}

/**
 * The canonical staged section's shape: Edit renders only while read-only, and
 * Save/Cancel only while editing, so every transition unmounts the button that
 * was just pressed.
 */
function StagedSection({
  title,
  save = async (draft) => draft,
  showEdit = true,
  editDisabled = false,
}: StagedSectionProps) {
  const section = useSectionEditState<Draft>({
    initial: INITIAL,
    save,
    successMessage: "Saved",
    allowPristineSave: true,
  });
  return (
    <div role="region" aria-label={title}>
      <div>
        <h2>{title}</h2>
        {!section.editing && showEdit ? (
          <button
            type="button"
            disabled={editDisabled}
            onClick={section.startEditing}
          >
            Edit
          </button>
        ) : null}
      </div>
      {section.error ? <p role="alert">{section.error}</p> : null}
      {section.editing ? (
        <div>
          <button type="button" onClick={() => void section.save()}>
            Save
          </button>
          <button type="button" onClick={section.cancelEditing}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A section with no wrapper of its own: its Edit sits beside a sibling's. */
function BareSection({ name }: { name: string }) {
  const section = useSectionEditState<Draft>({
    initial: INITIAL,
    save: async (draft) => draft,
    successMessage: "Saved",
  });
  return section.editing ? (
    <span>
      <button type="button" onClick={section.cancelEditing}>
        Cancel {name}
      </button>
    </span>
  ) : (
    <button type="button" onClick={section.startEditing}>
      Edit
    </button>
  );
}

describe("useSectionEditState", () => {
  it("seeds draft and snapshot from `initial` and starts read-only", () => {
    const { result } = renderSection();

    expect(result.current.draft).toEqual(INITIAL);
    expect(result.current.saved).toEqual(INITIAL);
    expect(result.current.editing).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("stages draft edits without touching the snapshot", () => {
    const { result } = renderSection();

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 9 }));

    expect(result.current.draft).toEqual({ minGroupSize: 9, enabled: false });
    expect(result.current.saved).toEqual(INITIAL);
    expect(result.current.dirty).toBe(true);
  });

  it("restores EVERY field from the snapshot on cancel", () => {
    const { result } = renderSection();

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 9, enabled: true }));
    act(() => result.current.cancelEditing());

    expect(result.current.draft).toEqual(INITIAL);
    expect(result.current.editing).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("re-seeds draft AND snapshot from the server response, not the draft", async () => {
    // The server clamps the submitted value; both draft and snapshot must end
    // up showing what the server actually stored.
    const save = vi.fn(async () => ({ minGroupSize: 20, enabled: true }));
    const { result } = renderSection({ save });

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 999, enabled: true }));
    await act(async () => {
      await result.current.save();
    });

    expect(save).toHaveBeenCalledWith(
      { minGroupSize: 999, enabled: true },
      INITIAL,
    );
    expect(result.current.draft).toEqual({ minGroupSize: 20, enabled: true });
    expect(result.current.saved).toEqual({ minGroupSize: 20, enabled: true });
    expect(result.current.dirty).toBe(false);
    expect(result.current.editing).toBe(false);
    expect(result.current.success).toBe("Saved");
  });

  it("computes the success message from the saved value when it is conditional", async () => {
    const { result } = renderSection({
      successMessage: (saved) => (saved.enabled ? "On." : "Off."),
    });

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ enabled: true }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.success).toBe("On.");
  });

  it("maps ForbiddenSaveError to the shared 403 copy and stays in edit mode", async () => {
    const save = vi.fn(async () => {
      throw new ForbiddenSaveError();
    });
    const { result } = renderSection({ save });

    act(() => result.current.startEditing());
    act(() => result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.error).toBe(ADMIN_FORBIDDEN_SAVE_REASON);
    expect(result.current.success).toBe("");
    expect(result.current.editing).toBe(true);
    // The rejected draft is retained so the admin does not lose their edit.
    expect(result.current.draft).toEqual({ minGroupSize: 9, enabled: false });
    expect(result.current.saved).toEqual(INITIAL);
    expect(result.current.saving).toBe(false);
  });

  it("surfaces a save error message and falls back for a non-Error throw", async () => {
    const failing = renderSection({
      save: vi.fn(async () => {
        throw new Error("Boom");
      }),
    });
    failing.result.current.startEditing();
    act(() => failing.result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await failing.result.current.save();
    });
    expect(failing.result.current.error).toBe("Boom");

    const odd = renderSection({
      save: vi.fn(async () => {
        throw "nope";
      }),
      saveErrorFallback: "Could not save",
    });
    act(() => odd.result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await odd.result.current.save();
    });
    expect(odd.result.current.error).toBe("Could not save");
  });

  it("clears both messages when a save starts", async () => {
    const { result } = renderSection();

    act(() => result.current.setError("stale error"));
    act(() => result.current.setSuccess("stale success"));
    act(() => result.current.setDraft({ minGroupSize: 9 }));
    await act(async () => {
      await result.current.save();
    });

    expect(result.current.error).toBe("");
    expect(result.current.success).toBe("Saved");
  });

  it("skips a pristine save by default and allows one when opted in", async () => {
    const guarded = renderSection();
    await act(async () => {
      await guarded.result.current.save();
    });
    expect(guarded.save).not.toHaveBeenCalled();

    // `allowPristineSave` has no adopter (#2143 removed the last one) but is
    // retained as an escape hatch for a future card whose endpoint is an action
    // rather than a state update. Pinning it here keeps the opt-in honest, so
    // whoever reaches for it gets the behaviour the option advertises.
    const pristine = renderSection({ allowPristineSave: true });
    await act(async () => {
      await pristine.result.current.save();
    });
    expect(pristine.save).toHaveBeenCalledTimes(1);
  });

  it("blocks a save while the draft is invalid", async () => {
    const { result, save } = renderSection({
      isValid: (draft) => draft.minGroupSize >= 2,
    });

    act(() => result.current.setDraft({ minGroupSize: 1 }));
    expect(result.current.valid).toBe(false);
    await act(async () => {
      await result.current.save();
    });
    expect(save).not.toHaveBeenCalled();

    act(() => result.current.setDraft({ minGroupSize: 4 }));
    expect(result.current.valid).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("honours a custom dirty comparator for non-scalar drafts", () => {
    interface ListDraft {
      rules: number[];
    }
    const { result } = renderHook(() =>
      useSectionEditState<ListDraft>({
        initial: { rules: [1, 2] },
        save: async (draft) => draft,
        successMessage: "Saved",
        isDirty: (draft, saved) =>
          JSON.stringify(draft.rules) !== JSON.stringify(saved.rules),
      }),
    );

    // A fresh array with equal contents is a new reference: the default
    // shallow check would call this dirty, the deep comparator does not.
    act(() => result.current.setDraft({ rules: [1, 2] }));
    expect(result.current.dirty).toBe(false);

    act(() => result.current.setDraft({ rules: [1, 3] }));
    expect(result.current.dirty).toBe(true);
  });

  describe("with a load step", () => {
    it("loads once on mount, then exposes the loaded value", async () => {
      const load = vi.fn(async () => ({ minGroupSize: 8, enabled: true }));
      const { result } = renderHook(() =>
        useSectionEditState<Draft>({
          load,
          save: async (draft) => draft,
          successMessage: "Saved",
        }),
      );

      // Nothing to render until the fetch resolves.
      expect(result.current.loading).toBe(true);
      expect(result.current.draft).toBeNull();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(load).toHaveBeenCalledTimes(1);
      expect(result.current.draft).toEqual({ minGroupSize: 8, enabled: true });
      expect(result.current.saved).toEqual({ minGroupSize: 8, enabled: true });
    });

    it("loads exactly once across re-renders with a fresh inline `load`", async () => {
      // Every adopter passes a NON-memoised inline arrow for `load`, so its
      // identity changes on every render. The hook holds callbacks in a
      // latest-ref precisely so the mount effect can depend on the stable
      // `runLoad` instead. Widening those deps back to `options.load` would
      // refetch on every render — a fetch loop on `/admin/booking-policies` and
      // `/admin/security` — which this rerender is here to catch.
      const load = vi.fn(async (_signal: AbortSignal) => ({
        minGroupSize: 8,
        enabled: true,
      }));
      const { result, rerender } = renderHook(() =>
        useSectionEditState<Draft>({
          // A brand-new arrow identity on every render, as the cards do.
          load: (signal) => load(signal),
          save: async (draft) => draft,
          successMessage: "Saved",
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(load).toHaveBeenCalledTimes(1);

      rerender();
      rerender();
      // A state change re-renders too, and must not re-trigger the load.
      act(() => result.current.startEditing());

      await waitFor(() => expect(result.current.editing).toBe(true));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("keeps the seeded draft visible when the load fails", async () => {
      const { result } = renderSection({
        load: vi.fn(async () => {
          throw new Error("Failed to fetch");
        }),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe("Failed to fetch");
      expect(result.current.draft).toEqual(INITIAL);
    });

    it("swallows an AbortError from an in-flight load", async () => {
      const { result } = renderSection({
        load: vi.fn(async () => {
          throw new DOMException("Aborted", "AbortError");
        }),
      });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe("");
    });

    it("reload clears both messages and re-fetches", async () => {
      const load = vi
        .fn<() => Promise<Draft>>()
        .mockResolvedValueOnce({ minGroupSize: 8, enabled: true })
        .mockResolvedValueOnce({ minGroupSize: 3, enabled: false });
      const { result } = renderHook(() =>
        useSectionEditState<Draft>({
          load,
          save: async (draft) => draft,
          successMessage: "Saved",
        }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => result.current.setSuccess("stale"));
      act(() => result.current.startEditing());

      await act(async () => {
        await result.current.reload();
      });

      expect(load).toHaveBeenCalledTimes(2);
      expect(result.current.draft).toEqual({ minGroupSize: 3, enabled: false });
      expect(result.current.success).toBe("");
      // Reloading drops back to read-only, discarding any in-flight edit.
      expect(result.current.editing).toBe(false);
    });
  });

  describe("returning focus when the editor closes (#4087)", () => {
    it("hands focus back to the re-rendered Edit button after Cancel", async () => {
      render(<StagedSection title="Group discount" />);

      activate(screen.getByRole("button", { name: "Edit" }));
      activate(screen.getByRole("button", { name: "Cancel" }));

      // Cancel unmounted the button that held focus; without the return a
      // keyboard user is left on <body>.
      await expectToHoldFocus(screen.getByRole("button", { name: "Edit" }));
    });

    it("hands focus back to the Edit button after a successful Save", async () => {
      render(<StagedSection title="Group discount" />);

      activate(screen.getByRole("button", { name: "Edit" }));
      activate(screen.getByRole("button", { name: "Save" }));

      await expectToHoldFocus(
        await screen.findByRole("button", { name: "Edit" }),
      );
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });

    it("moves nothing on a failed Save, and still returns on the Cancel after it", async () => {
      const save = vi.fn(async () => {
        throw new Error("Rejected");
      });
      render(<StagedSection title="Group discount" save={save} />);

      activate(screen.getByRole("button", { name: "Edit" }));
      const saveButton = screen.getByRole("button", { name: "Save" });
      activate(saveButton);

      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Rejected"));
      // Edit mode stays open, so the control the admin pressed is still there
      // and keeps focus; the card's own failure position is not overridden.
      await expectToHoldFocus(saveButton);
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

      activate(screen.getByRole("button", { name: "Cancel" }));
      await expectToHoldFocus(screen.getByRole("button", { name: "Edit" }));
    });

    it("falls back to the section region when Edit comes back disabled (view-only)", async () => {
      const view = render(<StagedSection title="Group discount" />);

      activate(screen.getByRole("button", { name: "Edit" }));
      // Permissions narrowed while the editor was open.
      view.rerender(<StagedSection title="Group discount" editDisabled />);
      activate(screen.getByRole("button", { name: "Cancel" }));

      await expectToHoldFocus(
        screen.getByRole("region", { name: "Group discount" }),
      );
    });

    it("falls back to the section region when the section no longer renders Edit", async () => {
      const view = render(<StagedSection title="Group discount" />);

      activate(screen.getByRole("button", { name: "Edit" }));
      view.rerender(<StagedSection title="Group discount" showEdit={false} />);
      activate(screen.getByRole("button", { name: "Cancel" }));

      await expectToHoldFocus(
        screen.getByRole("region", { name: "Group discount" }),
      );
    });

    it("finds THIS section's Edit among namesakes in a shared parent", async () => {
      render(
        <div>
          <BareSection name="first" />
          <BareSection name="second" />
        </div>,
      );

      activate(screen.getAllByRole("button", { name: "Edit" })[1]);
      activate(screen.getByRole("button", { name: "Cancel second" }));

      // Both Edit buttons are named "Edit" and share a parent; the return
      // must land on the second section's, not the first match.
      await expectToHoldFocus(screen.getAllByRole("button", { name: "Edit" })[1]);
    });

    it("leaves focus alone when the admin has already moved it", async () => {
      render(
        <>
          <StagedSection title="Group discount" />
          <input aria-label="Elsewhere" />
        </>,
      );

      activate(screen.getByRole("button", { name: "Edit" }));
      const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
      elsewhere.focus();
      // A pointer press on Cancel that never moved focus.
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await expectToHoldFocus(elsewhere);
    });

    it("moves nothing when Edit was opened with nothing focused", async () => {
      render(<StagedSection title="Group discount" />);

      // A mouse click in a browser that does not focus buttons.
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await expectToHoldFocus(document.body);
    });
  });
});
