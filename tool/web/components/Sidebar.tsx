"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconHome,
  IconTranslate,
  IconLibrary,
  IconQueue,
  IconSettings,
} from "./icons";
import { UsageWidget } from "./UsageWidget";

const WORK = [
  { href: "/", label: "Trang chủ", Icon: IconHome },
  { href: "/translate", label: "Dịch tài liệu", Icon: IconTranslate },
  { href: "/library", label: "Thư viện", Icon: IconLibrary },
  { href: "/queue", label: "Hàng đợi", Icon: IconQueue },
];
const SYS = [{ href: "/settings", label: "Cài đặt", Icon: IconSettings }];

function norm(p: string) {
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

export function Sidebar() {
  const path = norm(usePathname() || "/");
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="mark">CF</div>
        <div>
          <b>Translate Studio</b>
          <small>CFA curriculum · VI</small>
        </div>
      </div>
      <nav className="nav">
        <div className="nav-label">Làm việc</div>
        {WORK.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className={"nav-item" + (isActive(href) ? " active" : "")}
          >
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <nav className="nav">
        <div className="nav-label">Hệ thống</div>
        {SYS.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className={"nav-item" + (isActive(href) ? " active" : "")}
          >
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        <UsageWidget />
      </div>
    </aside>
  );
}

export function MobileTabbar() {
  const path = norm(usePathname() || "/");
  const items = [...WORK, ...SYS];
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
  return (
    <nav className="mobile-tabbar" aria-label="Điều hướng">
      {items.map(({ href, label, Icon }) => (
        <Link key={href} href={href} className={isActive(href) ? "active" : ""}>
          <Icon />
          {label}
        </Link>
      ))}
    </nav>
  );
}
