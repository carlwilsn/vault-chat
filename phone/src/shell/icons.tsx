// The shell's inline icons, exactly as phone.html drew them (stroke 2, round).
import type { ReactNode } from "react";

type Props = { w?: string; join?: boolean; children: ReactNode };
/** One 24×24 stroke icon; `w` = stroke-width, `join` adds round line-joins. */
function Ico({ w = "2", join = true, children }: Props) {
  return join ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round">
      {children}
    </svg>
  );
}

export const Burger = () => (
  <Ico join={false}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Ico>
);
export const Gear = () => (
  <Ico>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Ico>
);
export const Back = () => (
  <Ico w="2.2">
    <path d="M15 18l-6-6 6-6" />
  </Ico>
);
export const SendArrow = () => (
  <Ico w="2.4">
    <path d="M12 19V6M6 12l6-6 6 6" />
  </Ico>
);
export const Plus = ({ w = "2", join = false }: { w?: string; join?: boolean }) => (
  <Ico w={w} join={join}>
    <path d="M12 5v14M5 12h14" />
  </Ico>
);
