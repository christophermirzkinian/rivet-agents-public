/** What the shell mounts for a tab or a header sheet. The shell calls only these two. */
export interface View {
  /** Renders into `el` and keeps it current until unmount. */
  mount(el: HTMLElement): void;
  unmount(): void;
  /** Re-fetches what the view shows; pull to refresh calls it. */
  refresh?(): unknown;
}
