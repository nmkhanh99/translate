"use client";
// Document cover = the first page of the source PDF, rendered to PNG by the
// daemon (/api/page). Falls back to the empty .thumb placeholder if the tag is
// missing or the render fails (e.g. the source file isn't there yet).
import * as React from "react";
import { pageImg } from "../lib/api";

export function Cover({
  tag,
  alt,
  className = "",
  wide = false,
  dpi = 90,
  style,
}: {
  tag: string;
  alt?: string;
  className?: string;
  wide?: boolean;
  dpi?: number;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = React.useState(false);
  // Reset the error state when pointed at a different document.
  React.useEffect(() => setFailed(false), [tag]);

  const cls = "thumb" + (wide ? " wide" : "") + (className ? " " + className : "");
  if (!tag || failed) {
    return <div className={cls} style={style} aria-hidden="true" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={cls}
      src={pageImg(tag, "source", 0, dpi)}
      alt={alt || "Ảnh bìa tài liệu"}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ width: "100%", objectFit: "cover", display: "block", ...style }}
    />
  );
}
