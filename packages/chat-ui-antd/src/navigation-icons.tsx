export const PlusIcon = ({ size = 16 }: { readonly size?: number }) => (
  <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
    <path
      d="M8 2.5v11M2.5 8h11"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

export const HistoryIcon = ({ size = 16 }: { readonly size?: number }) => (
  <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
    <path
      d="M5.25 4h7.5M5.25 8h7.5M5.25 12h7.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.4"
    />
    <path
      d="M2.5 3.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 4a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 4a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"
      fill="currentColor"
    />
  </svg>
);

export const MoreIcon = ({ size = 16 }: { readonly size?: number }) => (
  <svg aria-hidden="true" height={size} viewBox="0 0 16 16" width={size}>
    <circle cx="3" cy="8" r="1.25" fill="currentColor" />
    <circle cx="8" cy="8" r="1.25" fill="currentColor" />
    <circle cx="13" cy="8" r="1.25" fill="currentColor" />
  </svg>
);
