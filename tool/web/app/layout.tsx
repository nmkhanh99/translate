import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "../components/Providers";
import { AppShell } from "../components/AppShell";

export const metadata: Metadata = {
  title: "CFA Translate Studio",
  description: "Dịch trọn PDF CFA sang Tiếng Việt, giữ nguyên bố cục.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
