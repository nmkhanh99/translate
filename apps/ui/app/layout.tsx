import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "../components/Providers";
import { AppShell } from "../components/AppShell";
import { StatusProvider } from "../lib/useStatus";

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
        <StatusProvider>
          <Providers>
            <AppShell>{children}</AppShell>
          </Providers>
        </StatusProvider>
      </body>
    </html>
  );
}
