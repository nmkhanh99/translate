// Minimal inline SVG icon set (stroke = currentColor), ported from the old UI.
import * as React from "react";

type P = React.SVGProps<SVGSVGElement>;
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const IconHome = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 10.5 12 4l9 6.5" />
    <path d="M5 9.5V20h14V9.5" />
  </svg>
);
export const IconTranslate = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 5h7" />
    <path d="M7 5v2c0 3-1.5 5-4 6" />
    <path d="M5 9c0 2 2 3.5 5 4.5" />
    <path d="M12 20l4-9 4 9" />
    <path d="M13.5 17h5" />
  </svg>
);
export const IconLibrary = (p: P) => (
  <svg {...base} strokeLinecap={undefined} {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14z" />
  </svg>
);
export const IconQueue = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="6" cy="7" r="2" />
    <path d="M10 7h10" />
    <circle cx="6" cy="17" r="2" />
    <path d="M10 17h10" />
    <path d="M6 9v6" />
  </svg>
);
export const IconSettings = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.5M12 19v2.5M4 12H1.5M22.5 12H20M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
  </svg>
);
export const IconUpload = (p: P) => (
  <svg {...base} strokeWidth={1.8} {...p}>
    <path d="M12 16V4" />
    <path d="M8 8l4-4 4 4" />
    <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
export const IconChat = (p: P) => (
  <svg {...base} {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
  </svg>
);
export const IconSend = (p: P) => (
  <svg {...base} strokeWidth={1.8} {...p}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base} strokeWidth={1.9} {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
