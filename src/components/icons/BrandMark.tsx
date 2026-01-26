import React from "react";

type Props = React.SVGProps<SVGSVGElement>;

export function BrandMark(props: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M6.25 7.5A3.25 3.25 0 0 1 9.5 4.25h5A3.25 3.25 0 0 1 17.75 7.5v9A3.25 3.25 0 0 1 14.5 19.75h-5A3.25 3.25 0 0 1 6.25 16.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M9 9.25h6M9 12h6M9 14.75h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M18.4 9.1c1.4.6 2.35 2 2.35 3.6s-.95 3-2.35 3.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.8"
      />
    </svg>
  );
}

